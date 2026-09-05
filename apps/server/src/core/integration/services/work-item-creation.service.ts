import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PlaneApiError, PlaneClientService } from './plane-client.service';
import { RelationshipService } from './relationship.service';
import { DelegatedTokenService } from './delegated-token.service';
import { DELEGATED_SCOPES } from '../domain/delegated-token.util';
import { parseUrn, buildUrn } from '../domain/urn.util';
import { RelationType } from '../domain/relationship-types';
import { IntegrationRelationship } from '@docmost/db/types/entity.types';
import { PlaneWorkItem } from './plane-client.service';

export interface CreateFromHubInput {
  workspaceId: string;
  actorId: string;
  /** Hub source object the work implements (page or requirement block). */
  sourceUrn: string;
  planeProjectId: string;
  title: string;
  descriptionHtml?: string;
  priority?: string;
  /** Relation stated from the Hub side; defaults to specified_by. */
  relationType?: RelationType;
  /**
   * Idempotency key for the ConqrPlan write.
   *
   * ConqrPlan enforces uniqueness on (external_id, external_source) per
   * project and answers a repeat with 409 plus the id of the item that already
   * exists. Supplying a key that is derived from the intent - "work for this
   * requirement in this project" - is what makes a retry converge instead of
   * creating a second work item. Omit it for genuinely ad-hoc creation, where
   * two items for one source may be exactly what the user wants.
   */
  idempotencyKey?: string;
}

export interface CreateFromHubResult {
  /**
   * `created`      the item is new and linked
   * `already_exists` the idempotency key matched an existing item; the link was
   *                  ensured, so a retry converges rather than duplicating
   * `created_link_failed` the item exists in ConqrPlan but the Hub link did
   *                  not land; recoverable by retrying with the same key
   */
  status: 'created' | 'already_exists' | 'created_link_failed';
  workItem: PlaneWorkItem;
  workItemUrn: string;
  relationship?: IntegrationRelationship;
  correlationId: string;
  warning?: string;
  /** The key the write was made under, echoed so a retry can reuse it. */
  idempotencyKey?: string;
}

/**
 * Create-work-item-from-Hub-selection workflow (blueprint §5.1A).
 *
 * Creates the work item in Plane (the owner of work), then records a typed,
 * provenance-tagged relationship back to the Hub source. If the item is created
 * but linking fails, we report `created_link_failed` — never a false success
 * (blueprint §5.1B partial-failure honesty, §10 workflow state is explicit).
 */
@Injectable()
export class WorkItemCreationService {
  private readonly logger = new Logger(WorkItemCreationService.name);

  /**
   * Batch ceiling for work-item creation. Exported so the MCP bulk tool
   * enforces the same limit before making any call, rather than restating a
   * number that could drift from the server's.
   */
  static readonly MAX_BATCH = 100;

  /** Namespace for ConqrHub-issued idempotency keys in ConqrPlan. */
  private static readonly EXTERNAL_SOURCE = 'conqrhub';

  constructor(
    private readonly plane: PlaneClientService,
    private readonly relationships: RelationshipService,
    private readonly delegatedTokens: DelegatedTokenService,
  ) {}

  async createFromHub(
    input: CreateFromHubInput,
  ): Promise<CreateFromHubResult> {
    if (!this.plane.isEnabled()) {
      throw new BadRequestException('Plane integration is not configured');
    }
    // Validate the Hub source URN up front so we never create an orphan item.
    let source;
    try {
      source = parseUrn(input.sourceUrn);
    } catch {
      throw new BadRequestException(`Invalid sourceUrn: ${input.sourceUrn}`);
    }
    if (source.product !== 'hub') {
      throw new BadRequestException('sourceUrn must be a ConqrHub object');
    }
    if (!input.title?.trim()) {
      throw new BadRequestException('title is required');
    }
    if (!input.planeProjectId?.trim()) {
      throw new BadRequestException('planeProjectId is required');
    }

    // Mint a short-lived, least-privilege on-behalf-of token so the write is
    // authorised as the acting human, not as the API key's owner (§9.1). The
    // token's jti is the correlation id for the whole exchange, so ConqrHub's
    // audit row, ConqrPlan's audit row and the resulting event all agree.
    const delegation = this.delegatedTokens.mintForPlane({
      hubUserId: input.actorId,
      hubWorkspaceId: input.workspaceId,
      scope: [DELEGATED_SCOPES.workItemCreate],
    });
    const correlationId = delegation.jti;

    // 1) Create the work item in Plane (owner of work).
    //
    // There is no distributed transaction here and there cannot be: ConqrPlan
    // owns the work item, ConqrHub owns the relationship, and neither can roll
    // the other back. Convergence is what replaces it - the same idempotency
    // key always names the same work item, so a retry after any failure below
    // re-finds that item instead of creating a second one.
    let workItem: PlaneWorkItem;
    let alreadyExisted = false;
    try {
      workItem = await this.plane.createWorkItem(
        input.planeProjectId,
        {
          name: input.title,
          description_html: input.descriptionHtml,
          priority: input.priority,
          ...(input.idempotencyKey
            ? {
                external_id: input.idempotencyKey,
                external_source: WorkItemCreationService.EXTERNAL_SOURCE,
              }
            : {}),
        },
        { delegation: delegation.token, correlationId },
      );
    } catch (err) {
      const existingId =
        err instanceof PlaneApiError && err.status === 409
          ? (err.details as any)?.id
          : undefined;
      if (!existingId) throw err;

      // The work already exists under this key. This is the retry path, and
      // also the repair path for a previous created_link_failed: fetch the
      // item and fall through so the relationship is ensured.
      this.logger.log(
        `Idempotency key '${input.idempotencyKey}' already resolved to work item ${existingId}; ensuring the link`,
      );
      workItem = await this.plane.getWorkItem(input.planeProjectId, existingId, {
        delegation: delegation.token,
        correlationId,
      });
      alreadyExisted = true;
    }

    const workItemUrn = buildUrn('plane', 'work-item', workItem.id);
    const relationType = input.relationType ?? RelationType.SpecifiedBy;

    // 2) Link Hub source → new work item with provenance.
    try {
      const relationship = await this.relationships.create({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        sourceUrn: source.urn,
        targetUrn: workItemUrn,
        relationType,
        provenance: 'hub.selection.create-work-item',
        sourceVersion: workItem.updated_at
          ? { plane_updated_at: workItem.updated_at }
          : undefined,
        metadata: { target_project_id: input.planeProjectId },
        correlationId,
      });
      return {
        // insertIfAbsent means re-linking an existing edge returns that edge
        // rather than a duplicate, so this path is safe to repeat.
        status: alreadyExisted ? 'already_exists' : 'created',
        workItem,
        workItemUrn,
        relationship,
        correlationId,
        idempotencyKey: input.idempotencyKey,
      };
    } catch (err) {
      // The item exists in Plane; be honest that only the link failed.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Work item ${workItem.id} created but linking failed: ${message}`,
      );
      return {
        status: 'created_link_failed',
        workItem,
        workItemUrn,
        correlationId,
        idempotencyKey: input.idempotencyKey,
        warning: input.idempotencyKey
          ? 'The work item exists in ConqrPlan but could not be linked. Retry with the same idempotency key: it will re-find the item and only create the link.'
          : 'Work item was created in Plane but could not be linked. Retry the link.',
      };
    }
  }

  /**
   * Bulk-create work items from a Hub table/checklist (blueprint §5.1B).
   * Atomic INTENT, practical partial completion: each row reports its own
   * outcome and index; a failure at row N never fakes success for the batch and
   * never silently drops rows. Required-field validation happens per row before
   * any Plane call for that row.
   */
  async createManyFromHub(input: {
    workspaceId: string;
    actorId: string;
    planeProjectId: string;
    rows: Array<{
      sourceUrn: string;
      title: string;
      descriptionHtml?: string;
      priority?: string;
    }>;
  }): Promise<{
    total: number;
    created: number;
    failed: number;
    results: Array<{
      index: number;
      status: 'created' | 'already_exists' | 'created_link_failed' | 'failed';
      workItemUrn?: string;
      error?: string;
    }>;
  }> {
    if (!this.plane.isEnabled()) {
      throw new BadRequestException('Plane integration is not configured');
    }
    if (!Array.isArray(input.rows) || input.rows.length === 0) {
      throw new BadRequestException('rows is required');
    }
    if (input.rows.length > WorkItemCreationService.MAX_BATCH) {
      throw new BadRequestException(
        `Batch too large (max ${WorkItemCreationService.MAX_BATCH})`,
      );
    }

    const results: Array<{
      index: number;
      status: 'created' | 'already_exists' | 'created_link_failed' | 'failed';
      workItemUrn?: string;
      error?: string;
    }> = [];

    // Sequential to respect Plane's rate limit and keep per-row attribution.
    for (let i = 0; i < input.rows.length; i++) {
      const row = input.rows[i];
      try {
        const res = await this.createFromHub({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          sourceUrn: row.sourceUrn,
          planeProjectId: input.planeProjectId,
          title: row.title,
          descriptionHtml: row.descriptionHtml,
          priority: row.priority,
        });
        results.push({
          index: i,
          status: res.status,
          workItemUrn: res.workItemUrn,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ index: i, status: 'failed', error: message });
      }
    }

    const created = results.filter((r) => r.status !== 'failed').length;
    return {
      total: input.rows.length,
      created,
      failed: results.length - created,
      results,
    };
  }
}
