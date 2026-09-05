import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { RequirementRepo } from '@docmost/db/repos/integration/requirement.repo';

/**
 * The only thing this service needs from a page: which space it lives in, so
 * the mapped ConqrPlan project can be found. Declared narrowly and injected by
 * token rather than importing PageRepo's module graph, which drags an ESM
 * editor dependency into every consumer.
 */
export interface PageLocator {
  findById(
    pageId: string,
    opts?: { includeSpace?: boolean },
  ): Promise<{ id: string; workspaceId: string; spaceId: string | null } | undefined | null>;
}

/** DI token for {@link PageLocator}. */
export const PAGE_LOCATOR = 'PAGE_LOCATOR';
import { RelationshipService } from './relationship.service';
import { SmartObjectResolverService } from './smart-object-resolver.service';
import { WorkItemCreationService } from './work-item-creation.service';
import { ProjectSpaceMappingService } from './project-space-mapping.service';
import { buildUrn } from '../domain/urn.util';
import { RelationType } from '../domain/relationship-types';
import { PresentationModel, ResolutionState } from '../domain/presentation.types';
import { DeliveryReadService, ResolvedDelivery } from './delivery-read.service';
import {
  CoverageState,
  RequirementCoverageSummary,
  coverageFor,
  countsAsCovered,
  unresolvedFrom,
} from '../domain/requirement-coverage';
import { APPROVED_OR_BEYOND } from '../domain/requirement-lifecycle';
import { projectByUrnFromEdges } from './traceability.service';

/**
 * Vertical Slice 01: requirement → linked ConqrPlan execution.
 *
 * The one flow this slice exists to make real: a delivery-accountable lead
 * opens a ConqrHub page, sees which requirements have no work behind them,
 * creates that work in ConqrPlan under their own identity, and watches its
 * delivery status without leaving the requirement's context.
 *
 * Ownership is not blurred to achieve it:
 *
 *   ConqrHub  owns the page, its requirements, their lifecycle, coverage, and
 *             every cross-product relationship (the Context Graph).
 *   ConqrPlan owns the work item, its assignment, estimate and delivery state,
 *             and remains the authority on who may touch it.
 *
 * There is no shared database, no cross-product write, and no distributed
 * transaction. Two systems each commit their own half, and convergence -
 * a deterministic idempotency key - replaces the rollback that cannot exist.
 */

/** How a requirement relates to the work behind it. */
export interface RequirementCoverage {
  requirementId: string;
  blockId: string;
  urn: string;
  title: string | null;
  state: string;
  /**
   * Coverage from *this viewer's* perspective. `all_restricted` renders as
   * "Uncovered for you": links exist and none of them can be verified by this
   * person, which is neither covered nor genuinely uncovered.
   */
  coverage: CoverageState;
  /** Kept for existing callers. True only for verified coverage. */
  covered: boolean;
  /** How many links exist. Zero for a viewer who may verify none of them. */
  linkedCount: number;
  /**
   * Work linked to this requirement, already shaped for the viewer. Items the
   * viewer may not see appear as a restricted placeholder, never as metadata.
   */
  relatedWork: PresentationModel[];
  /** Freshness of each card, so the panel can label stale data honestly. */
  delivery: Array<{
    urn: string;
    origin: ResolvedDelivery['origin'];
    stale: boolean;
    lastSyncedAt: string | null;
  }>;
}

export interface PageRequirementsResult {
  items: RequirementCoverage[];
  summary: RequirementCoverageSummary;
}

export interface CreateLinkedWorkPreview {
  requirementUrn: string;
  requirementTitle: string | null;
  planeProjectId: string;
  proposed: { title: string; descriptionHtml?: string; priority?: string };
  relationType: RelationType;
  /** Stable, so confirming twice cannot create two items. */
  idempotencyKey: string;
  /** Set when work already exists for this requirement. */
  existingWork?: PresentationModel[];
}

export interface CreateLinkedWorkReceipt {
  status: 'created' | 'already_exists' | 'created_link_failed';
  requirementUrn: string;
  workItemUrn: string;
  workItemId: string;
  relationship: {
    /** Stored direction: requirement implemented_by work item. */
    relationType: RelationType;
    /** Derived direction: work item implements requirement. */
    inverseRelationType: RelationType;
    id?: string;
  } | null;
  actor: { hubUserId: string };
  correlationId: string;
  idempotencyKey: string;
  /** Present when ConqrPlan committed but ConqrHub's link did not. */
  warning?: string;
}

/**
 * The canonical direction for this slice.
 *
 * The edge is stored once, from the Hub requirement, as `implemented_by`; its
 * inverse - the work item `implements` the requirement - is derived from the
 * relation registry rather than stored again. ConqrHub's Context Graph is
 * authoritative for cross-product relationships, so ConqrPlan holds no second
 * copy that could disagree with it.
 *
 * `implemented_by` is also one of the delivery relations traceability already
 * counts as coverage, so linking work makes a requirement covered without a
 * parallel notion of coverage being invented here.
 */
const CANONICAL_RELATION = RelationType.ImplementedBy;

@Injectable()
export class RequirementDeliveryService {
  private readonly logger = new Logger(RequirementDeliveryService.name);

  constructor(
    private readonly requirements: RequirementRepo,
    private readonly relationships: RelationshipService,
    private readonly resolver: SmartObjectResolverService,
    private readonly deliveryRead: DeliveryReadService,
    private readonly creation: WorkItemCreationService,
    private readonly mappings: ProjectSpaceMappingService,
    @Inject(PAGE_LOCATOR) private readonly pages: PageLocator,
  ) {}

  /** URN of a requirement block. */
  static requirementUrn(pageId: string, blockId: string): string {
    return buildUrn('hub', 'page', pageId, blockId);
  }

  /**
   * A deterministic key for "work implementing this requirement in this
   * project".
   *
   * Deterministic on purpose: it is what makes a retry converge. The same
   * confirm pressed twice, a network timeout retried, or a repair after a
   * half-finished create all resolve to the same ConqrPlan work item instead
   * of creating a second one. It is scoped by project so the same requirement
   * can legitimately have work in two different projects.
   */
  static idempotencyKey(requirementUrn: string, planeProjectId: string): string {
    return `req:${requirementUrn}|project:${planeProjectId}`;
  }

  // -------------------------------------------------------------------------
  // Read: requirements on a page, with coverage and permission-shaped work
  // -------------------------------------------------------------------------

  async pageRequirements(params: {
    workspaceId: string;
    viewerId: string;
    pageId: string;
    planeProjectId?: string;
  }): Promise<PageRequirementsResult> {
    const rows = await this.requirements.listForPage(
      params.workspaceId,
      params.pageId,
    );

    const projectId =
      params.planeProjectId ??
      (await this.resolveProjectForPage(params.workspaceId, params.pageId));

    // Collect every linked work URN across the whole page first, so delivery
    // status is fetched in one batched pass rather than once per requirement.
    // A page with twenty requirements would otherwise make twenty round trips
    // to another product on every render.
    const perRequirement: Array<{ row: any; urn: string; workUrns: string[] }> = [];
    const planeProjectByUrn: Record<string, string> = {};
    for (const req of rows) {
      const urn = RequirementDeliveryService.requirementUrn(
        req.pageId,
        req.blockId,
      );
      const edges = await this.relationships.listForUrn(params.workspaceId, urn);
      const workUrns = edges
        .filter(
          (e) =>
            e.sourceUrn === urn &&
            e.relationType === CANONICAL_RELATION &&
            e.targetUrn.startsWith('conqr://plane/work-item/'),
        )
        .map((e) => e.targetUrn);
      perRequirement.push({ row: req, urn, workUrns });
      Object.assign(planeProjectByUrn, projectByUrnFromEdges(edges));
    }

    const allWorkUrns = Array.from(
      new Set(perRequirement.flatMap((p) => p.workUrns)),
    );
    const resolved = allWorkUrns.length
      ? await this.deliveryRead.resolveMany(allWorkUrns, {
          workspaceId: params.workspaceId,
          viewerId: params.viewerId,
          planeProjectId: projectId ?? undefined,
          planeProjectByUrn,
        })
      : [];
    const byUrn = new Map(resolved.map((r) => [r.urn, r]));

    const items: RequirementCoverage[] = [];
    const unresolvedSources = new Set<string>();

    for (const { row: req, urn, workUrns } of perRequirement) {
      const delivery = workUrns
        .map((u) => byUrn.get(u))
        .filter((d): d is ResolvedDelivery => Boolean(d));
      const models = delivery.map((d) => d.model);

      const coverage = coverageFor(models);
      for (const u of unresolvedFrom(models)) unresolvedSources.add(u);

      items.push({
        requirementId: req.id,
        blockId: req.blockId,
        urn,
        title: req.title,
        state: req.state,
        coverage,
        covered: countsAsCovered(coverage),
        // Deliberately the number of cards this viewer receives, which for a
        // restricted viewer is still the number of links - the cards
        // themselves carry nothing. What is never exposed is *which* items
        // they are.
        linkedCount: models.length,
        relatedWork: models,
        delivery: delivery.map((d) => ({
          urn: d.urn,
          origin: d.origin,
          stale: d.stale,
          lastSyncedAt: d.lastSyncedAt,
        })),
      });
    }

    const expected = items.filter((i) =>
      APPROVED_OR_BEYOND.has(i.state as any),
    );

    return {
      items,
      summary: {
        total: items.length,
        approvedOrBeyond: expected.length,
        covered: items.filter((i) => i.coverage === CoverageState.Covered).length,
        uncovered: items.filter((i) => i.coverage === CoverageState.Uncovered)
          .length,
        provisional: items.filter(
          (i) => i.coverage === CoverageState.Provisional,
        ).length,
        unresolvedSources: Array.from(unresolvedSources),
        // Only requirements that are *expected* to have delivery count as
        // gaps. A draft requirement with no work is not a gap, it is a draft.
        gaps: expected
          .filter((i) => i.coverage !== CoverageState.Covered)
          .map((i) => ({
            requirementId: i.requirementId,
            urn: i.urn,
            title: i.title,
            state: i.state,
            coverage: i.coverage,
          })),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  /**
   * What would be created, without creating it.
   *
   * A preview step exists because this is a cross-product mutation the user
   * cannot undo from here: ConqrHub can drop its relationship, but it can
   * never delete the ConqrPlan work item.
   */
  async previewLinkedWork(params: {
    workspaceId: string;
    viewerId: string;
    requirementId: string;
    planeProjectId?: string;
    title?: string;
    descriptionHtml?: string;
    priority?: string;
  }): Promise<CreateLinkedWorkPreview> {
    const req = await this.requirements.findById(
      params.requirementId,
      params.workspaceId,
    );
    if (!req) throw new BadRequestException('Requirement not found');

    const urn = RequirementDeliveryService.requirementUrn(req.pageId, req.blockId);
    const projectId =
      params.planeProjectId ??
      (await this.resolveProjectForPage(params.workspaceId, req.pageId));
    if (!projectId) {
      throw new BadRequestException(
        'This page has no mapped ConqrPlan project. Map one before creating work.',
      );
    }

    const edges = await this.relationships.listForUrn(params.workspaceId, urn);
    const existingUrns = edges
      .filter((e) => e.sourceUrn === urn && e.relationType === CANONICAL_RELATION)
      .map((e) => e.targetUrn);

    return {
      requirementUrn: urn,
      requirementTitle: req.title,
      planeProjectId: projectId,
      proposed: {
        title: params.title?.trim() || req.title || 'Untitled requirement',
        descriptionHtml: params.descriptionHtml,
        priority: params.priority,
      },
      relationType: CANONICAL_RELATION,
      idempotencyKey: RequirementDeliveryService.idempotencyKey(urn, projectId),
      existingWork: existingUrns.length
        ? await this.resolver.resolveMany(existingUrns, {
            workspaceId: params.workspaceId,
            viewerId: params.viewerId,
            planeProjectId: projectId,
          })
        : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Confirm
  // -------------------------------------------------------------------------

  async createLinkedWork(params: {
    workspaceId: string;
    actorId: string;
    requirementId: string;
    planeProjectId?: string;
    title?: string;
    descriptionHtml?: string;
    priority?: string;
  }): Promise<CreateLinkedWorkReceipt> {
    const preview = await this.previewLinkedWork({
      workspaceId: params.workspaceId,
      viewerId: params.actorId,
      requirementId: params.requirementId,
      planeProjectId: params.planeProjectId,
      title: params.title,
      descriptionHtml: params.descriptionHtml,
      priority: params.priority,
    });

    // The write runs under the acting human's delegation inside
    // WorkItemCreationService: ConqrPlan authorises them, not the bridge.
    const result = await this.creation.createFromHub({
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      sourceUrn: preview.requirementUrn,
      planeProjectId: preview.planeProjectId,
      title: preview.proposed.title,
      descriptionHtml: preview.proposed.descriptionHtml,
      priority: preview.proposed.priority,
      relationType: CANONICAL_RELATION,
      idempotencyKey: preview.idempotencyKey,
    });

    return {
      status: result.status,
      requirementUrn: preview.requirementUrn,
      workItemUrn: result.workItemUrn,
      workItemId: result.workItem.id,
      relationship: result.relationship
        ? {
            relationType: CANONICAL_RELATION,
            inverseRelationType: RelationType.Implements,
            id: result.relationship.id,
          }
        : null,
      actor: { hubUserId: params.actorId },
      correlationId: result.correlationId,
      idempotencyKey: preview.idempotencyKey,
      warning: result.warning,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * The ConqrPlan project this page's work belongs in.
   *
   * Mapping lives on the space, not the page: a space is the unit a team
   * already thinks of as "our area", and per-page mapping would multiply the
   * places a wrong target could hide. The slice requires the page's space to
   * have a mapped project and says so plainly when it has none, rather than
   * guessing at a destination for someone's work.
   */
  private async resolveProjectForPage(
    workspaceId: string,
    pageId: string,
  ): Promise<string | null> {
    try {
      const page = await this.pages.findById(pageId, { includeSpace: false });
      if (!page || page.workspaceId !== workspaceId || !page.spaceId) return null;
      const target = await this.mappings.resolveSpacePlaneTarget(
        workspaceId,
        page.spaceId,
      );
      return target.planeProjectId ?? null;
    } catch (err) {
      this.logger.warn(
        `Could not resolve a ConqrPlan project for page ${pageId}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

export { ResolutionState };
