import { Injectable, Logger } from '@nestjs/common';
import {
  PlaneApiError,
  PlaneClientService,
} from '../../../core/integration/services/plane-client.service';
import { ProjectSpaceMappingRepo } from '@docmost/db/repos/integration/project-space-mapping.repo';
import { AiProviderService } from '../providers/ai-provider.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { ChunkingService } from './chunking.service';
import { EmbeddingRepository } from './embedding.repository';
import { DelegatedTokenService } from '../../../core/integration/services/delegated-token.service';
import { DELEGATED_SCOPES } from '../../../core/integration/domain/delegated-token.util';
import { PlaneCallContext } from '../../../core/integration/services/plane-client.service';

export interface IndexWorkItemResult {
  workItemId: string;
  status:
    | 'indexed'
    | 'skipped'
    | 'deleted'
    | 'no_content'
    | 'ai_unavailable'
    | 'unmapped'
    | 'no_actor';
  chunksIndexed?: number;
}

const LABEL_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Indexes ConqrPlan work items into the suite semantic store (gap-analysis
 * A1). A work item is scoped to the Hub space its Plane project is mapped to;
 * projects without a mapping are deliberately never indexed. Indexing alone
 * does not gate visibility — read-side enforcement lives in
 * `WorkIntelService`, which restricts `similaritySearch` to the caller's
 * readable space ids (via `SpaceMemberRepo.getUserSpaceIds`) before returning
 * any chunk.
 */
@Injectable()
export class WorkItemIndexerService {
  private readonly logger = new Logger(WorkItemIndexerService.name);
  /** projectId → { at, byId } — bounds label lookups under Plane's 60/min API limit. */
  private labelCache = new Map<
    string,
    { at: number; byId: Map<string, string> }
  >();

  constructor(
    private readonly plane: PlaneClientService,
    private readonly mappings: ProjectSpaceMappingRepo,
    private readonly aiProvider: AiProviderService,
    private readonly env: EnvironmentService,
    private readonly chunking: ChunkingService,
    private readonly repo: EmbeddingRepository,
    private readonly delegation: DelegatedTokenService,
  ) {}

  /**
   * A delegation for a mapping, or `null`.
   *
   * Indexing is background work with no human on the other end, and there is
   * no such thing as a request that reads ConqrPlan as nobody. It runs as the
   * person who mapped the project to the space - they were authorised to see
   * both sides when they made the link - and a mapping with no recorded
   * creator is skipped rather than read with the bridge credential's reach.
   * Skipping costs freshness; the alternative silently indexes work items
   * nobody in the space was ever allowed to see.
   */
  private actorContext(mapping: {
    workspaceId: string;
    createdBy: string | null;
  }): PlaneCallContext | null {
    if (!mapping.createdBy) return null;
    return this.delegation.mintCallContext(mapping.createdBy, mapping.workspaceId, [
      DELEGATED_SCOPES.workItemRead,
    ]);
  }

  async indexWorkItem(
    workItemId: string,
    projectId: string,
  ): Promise<IndexWorkItemResult> {
    if (!this.aiProvider.isAvailable()) {
      return { workItemId, status: 'ai_unavailable' };
    }

    const mapping =
      await this.mappings.findPrimaryForProjectAnyWorkspace(projectId);
    if (!mapping) {
      return { workItemId, status: 'unmapped' };
    }

    const call = this.actorContext(mapping);
    if (!call) {
      this.logger.warn(
        `Work item ${workItemId}: mapping for project ${projectId} has no creator; not indexed`,
      );
      return { workItemId, status: 'no_actor' };
    }

    let item;
    try {
      item = await this.plane.getWorkItem(projectId, workItemId, call);
    } catch (err) {
      if (err instanceof PlaneApiError && err.status === 404) {
        await this.repo.deleteBySource('plane_work_item', workItemId);
        return { workItemId, status: 'deleted' };
      }
      throw err;
    }

    if (item.archived_at) {
      await this.repo.deleteBySource('plane_work_item', workItemId);
      return { workItemId, status: 'deleted' };
    }

    const text = [item.name, item.description_stripped]
      .filter(Boolean)
      .join('\n\n');
    if (!text.trim()) {
      await this.repo.deleteBySource('plane_work_item', workItemId);
      return { workItemId, status: 'no_content' };
    }

    const model = this.env.getAiEmbeddingModel() || 'mistral-embed';
    const dim = this.aiProvider.getEmbeddingDimension();
    const contentHash = this.chunking.contentHash(text);

    const unchanged = await this.repo.isContentUnchanged(
      'plane_work_item',
      workItemId,
      model,
      contentHash,
    );
    if (unchanged) {
      return { workItemId, status: 'skipped' };
    }

    const chunks = this.chunking.chunk(text, {
      chunkChars: this.env.getAiEmbeddingChunkChars(),
      overlap: this.env.getAiEmbeddingChunkOverlap(),
    });
    if (chunks.length === 0) {
      await this.repo.deleteBySource('plane_work_item', workItemId);
      return { workItemId, status: 'no_content' };
    }

    const batchSize = this.env.getAiEmbeddingBatchSize();
    const texts = chunks.map((c) => c.chunkText);
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const vectors = await this.aiProvider.embedMany(
        texts.slice(i, i + batchSize),
      );
      allEmbeddings.push(...vectors);
    }

    const labelNames = await this.resolveLabelNames(
      projectId,
      item.labels ?? [],
      call,
    );
    const appUrl = this.env.getPlaneAppUrl();
    const slug = this.env.getPlaneWorkspaceSlug();
    const url =
      appUrl && slug
        ? `${appUrl}/${slug}/projects/${projectId}/issues/${workItemId}`
        : null;

    const metadata = {
      workItemId,
      projectId,
      title: item.name ?? null,
      sequenceId: item.sequence_id ?? null,
      state: item.state_detail?.name ?? null,
      labels: labelNames,
      url,
    };

    await this.repo.upsertChunks({
      workspaceId: mapping.workspaceId,
      spaceId: mapping.spaceId,
      sourceKind: 'plane_work_item',
      sourceId: workItemId,
      model,
      dim,
      contentHash,
      chunks: chunks.map((c, i) => ({
        chunkIndex: c.chunkIndex,
        chunkText: c.chunkText,
        embedding: allEmbeddings[i],
        metadata,
      })),
    });

    this.logger.debug(
      `Indexed work item ${workItemId}: ${chunks.length} chunk(s) (model=${model})`,
    );
    return { workItemId, status: 'indexed', chunksIndexed: chunks.length };
  }

  async deleteWorkItemEmbeddings(workItemId: string): Promise<void> {
    await this.repo.deleteBySource('plane_work_item', workItemId);
  }

  /** Sequentially index every work item in a project (admin backfill). */
  async backfillProject(
    projectId: string,
  ): Promise<{ indexed: number; skipped: number; failed: number }> {
    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    let cursor: string | undefined;

    const mapping =
      await this.mappings.findPrimaryForProjectAnyWorkspace(projectId);
    const call = mapping ? this.actorContext(mapping) : null;
    if (!call) {
      this.logger.warn(
        `Backfill of project ${projectId} skipped: no mapping creator to act as`,
      );
      return { indexed, skipped, failed };
    }

    do {
      const page = await this.plane.listWorkItemsPage(
        projectId,
        { perPage: 100, cursor },
        call,
      );
      for (const item of page.results) {
        try {
          const res = await this.indexWorkItem(item.id, projectId);
          if (res.status === 'indexed') indexed++;
          else skipped++;
        } catch (err) {
          failed++;
          this.logger.warn(
            `Backfill: failed work item ${item.id}: ${(err as Error).message}`,
          );
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    return { indexed, skipped, failed };
  }

  private async resolveLabelNames(
    projectId: string,
    labelIds: string[],
    call: PlaneCallContext,
  ): Promise<string[]> {
    if (labelIds.length === 0) return [];
    try {
      let cached = this.labelCache.get(projectId);
      if (!cached || Date.now() - cached.at > LABEL_CACHE_TTL_MS) {
        const labels = await this.plane.listLabels(projectId, call);
        cached = {
          at: Date.now(),
          byId: new Map(labels.map((l) => [l.id, l.name])),
        };
        this.labelCache.set(projectId, cached);
      }
      return labelIds
        .map((id) => cached!.byId.get(id))
        .filter((n): n is string => Boolean(n));
    } catch (err) {
      this.logger.warn(
        `Label lookup failed for project ${projectId}: ${(err as Error).message}`,
      );
      return [];
    }
  }
}
