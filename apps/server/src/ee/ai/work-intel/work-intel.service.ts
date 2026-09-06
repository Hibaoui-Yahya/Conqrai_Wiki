import { Injectable } from '@nestjs/common';
import { AiProviderService } from '../providers/ai-provider.service';
import { EmbeddingRepository } from '../embeddings/embedding.repository';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PlaneClientService } from '../../../core/integration/services/plane-client.service';
import { DelegatedTokenService } from '../../../core/integration/services/delegated-token.service';
import { DELEGATED_SCOPES } from '../../../core/integration/domain/delegated-token.util';

export interface SimilarWorkItem {
  workItemId: string;
  projectId: string | null;
  title: string | null;
  sequenceId: number | null;
  state: string | null;
  labels: string[];
  url: string | null;
  score: number;
}

const OVERSAMPLE = 4; // chunks-per-item headroom before grouping
const DEFAULT_LIMIT = 5;

/**
 * How long a viewer's readable ConqrPlan project set is reused.
 *
 * This is a *narrowing* cache, not revocation enforcement, and the difference
 * matters: for up to a minute after a project membership is removed, this set
 * can still contain that project. Nothing is released on its strength alone -
 * every candidate that survives it is authorised again, uncached, against
 * ConqrPlan before any of its content is returned. Treating this cache as the
 * access decision would give a removed member a minute of read access.
 */
const PROJECT_ACCESS_TTL_MS = 60_000;

/**
 * Candidates authorised per request at the content-release boundary.
 *
 * Bounded by the caller's limit, so this is a handful of reads, not one per
 * chunk.
 */
const MAX_AUTHORIZATION_CHECKS = 25;

/**
 * Semantic work-item intelligence (gap-analysis A2): duplicate detection and
 * label prediction over the plane_work_item embedding space. Consumed by
 * ConqrPlan's create-work-item and intake surfaces.
 */
@Injectable()
export class WorkIntelService {
  /** viewer -> the ConqrPlan projects they may read */
  private readonly projectAccessCache = new Map<
    string,
    { at: number; projectIds: Set<string> }
  >();

  constructor(
    private readonly aiProvider: AiProviderService,
    private readonly repo: EmbeddingRepository,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly plane: PlaneClientService,
    private readonly delegation: DelegatedTokenService,
  ) {}

  /**
   * The ConqrPlan projects this viewer may actually read, asked as the viewer.
   *
   * Hub space membership is not an answer to this question. Work items are
   * indexed into the space their project is mapped to, and indexing runs as
   * the person who created that mapping - so the index can hold items only
   * that person could see. Scoping retrieval by space membership alone then
   * hands those titles, states and labels to every member of the space, and
   * feeds them to a model. The source product owns this decision, so ask it.
   *
   * An unmapped or unauthorised viewer gets an empty set and therefore no
   * results, rather than falling back to anything broader.
   */
  private async readableProjectIds(
    userId: string,
    workspaceId: string,
  ): Promise<Set<string>> {
    const key = `${workspaceId}:${userId}`;
    const cached = this.projectAccessCache.get(key);
    if (cached && Date.now() - cached.at < PROJECT_ACCESS_TTL_MS) {
      return cached.projectIds;
    }
    if (!this.plane.isEnabled()) return new Set();

    try {
      const projects = await this.plane.listProjects(
        this.delegation.mintCallContext(userId, workspaceId, [
          DELEGATED_SCOPES.workItemRead,
        ]),
      );
      const projectIds = new Set(projects.map((p) => String(p.id)));
      this.projectAccessCache.set(key, { at: Date.now(), projectIds });
      return projectIds;
    } catch {
      // Fail closed. A ConqrPlan outage means we cannot establish what this
      // viewer may see, and "cannot check" must never read as "allowed".
      return new Set();
    }
  }

  /**
   * Which of these work items ConqrPlan will actually show this viewer, asked
   * now and never from cache.
   *
   * Project membership is not item-level authorization. ConqrPlan restricts
   * guests in a project configured with guest_view_all_features = False to
   * work they created, so two people with identical project access can be
   * entitled to different items inside it. The only reliable answer is the
   * source product's answer about the specific item, so each candidate is
   * read back as the viewer and anything refused or missing is dropped.
   *
   * Deliberately at the release boundary: after ranking, before any title,
   * label, state, snippet or link is put in a response or into a prompt.
   */
  private async authorizedItemIds(
    candidates: { workItemId: string; projectId: string | null }[],
    opts: { userId: string; workspaceId: string },
  ): Promise<Set<string>> {
    const allowed = new Set<string>();
    if (!this.plane.isEnabled()) return allowed;

    const checks = candidates.slice(0, MAX_AUTHORIZATION_CHECKS);
    await Promise.all(
      checks.map(async (candidate) => {
        if (!candidate.projectId) return;
        try {
          await this.plane.getWorkItem(
            candidate.projectId,
            candidate.workItemId,
            this.delegation.mintCallContext(opts.userId, opts.workspaceId, [
              DELEGATED_SCOPES.workItemRead,
            ]),
          );
          allowed.add(candidate.workItemId);
        } catch {
          // Refused, deleted, or unreachable. All three mean the same thing
          // here: this viewer does not get this item's content.
        }
      }),
    );
    return allowed;
  }

  async findSimilar(opts: {
    workspaceId: string;
    userId: string;
    title: string;
    description?: string;
    limit?: number;
  }): Promise<SimilarWorkItem[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const raw = await this.retrieve(opts, limit);

    const byItem = new Map<string, SimilarWorkItem>();
    for (const r of raw) {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const existing = byItem.get(r.sourceId);
      if (existing && existing.score >= r.score) continue;
      byItem.set(r.sourceId, {
        workItemId: r.sourceId,
        projectId: (meta.projectId as string) ?? null,
        title: (meta.title as string) ?? null,
        sequenceId: (meta.sequenceId as number) ?? null,
        state: (meta.state as string) ?? null,
        labels: (meta.labels as string[]) ?? [],
        url: (meta.url as string) ?? null,
        score: r.score,
      });
    }

    const ranked = Array.from(byItem.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const allowed = await this.authorizedItemIds(ranked, opts);
    return ranked.filter((item) => allowed.has(item.workItemId));
  }

  async predictLabels(opts: {
    workspaceId: string;
    userId: string;
    title: string;
    description?: string;
    limit?: number;
  }): Promise<{ labels: { label: string; confidence: number }[] }> {
    const raw = await this.retrieve(opts, opts.limit ?? DEFAULT_LIMIT);

    // Weight each label by the best chunk score per work item that carries it.
    const bestPerItem = new Map<
      string,
      { score: number; labels: string[]; projectId: string | null }
    >();
    for (const r of raw) {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const labels = (meta.labels as string[]) ?? [];
      const existing = bestPerItem.get(r.sourceId);
      if (!existing || r.score > existing.score) {
        bestPerItem.set(r.sourceId, {
          score: r.score,
          labels,
          projectId: (meta.projectId as string) ?? null,
        });
      }
    }

    // Labels are content too. A label only this viewer's colleague may see
    // must not reach the prediction, the response, or the prompt behind it.
    const allowedLabelItems = await this.authorizedItemIds(
      Array.from(bestPerItem.entries()).map(([workItemId, v]) => ({
        workItemId,
        projectId: (v as { projectId?: string | null }).projectId ?? null,
      })),
      opts,
    );
    for (const key of Array.from(bestPerItem.keys())) {
      if (!allowedLabelItems.has(key)) bestPerItem.delete(key);
    }

    const weights = new Map<string, number>();
    let total = 0;
    for (const { score, labels } of bestPerItem.values()) {
      const s = Math.max(0, score);
      for (const label of labels) {
        weights.set(label, (weights.get(label) ?? 0) + s);
        total += s;
      }
    }
    if (total === 0) return { labels: [] };

    const labels = Array.from(weights.entries())
      .filter(([, w]) => w > 0)
      .map(([label, w]) => ({ label, confidence: w / total }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
    return { labels };
  }

  private async retrieve(
    opts: {
      workspaceId: string;
      userId: string;
      title: string;
      description?: string;
    },
    limit: number,
  ) {
    if (!this.aiProvider.isAvailable()) return [];

    // Space-permission scoping: plane_work_item chunks are indexed into the
    // Hub space their project is mapped to (see WorkItemIndexerService), but
    // that alone does not gate visibility. Restrict the search to spaces the
    // caller can actually read, the same boundary RagRetrieveTool uses for
    // unscoped RAG search. An empty allow-list means the caller can read no
    // spaces — skip the embedding call entirely and return no results.
    const spaceIds = await this.spaceMemberRepo.getUserSpaceIds(opts.userId);
    if (spaceIds.length === 0) return [];

    // Both boundaries must hold, and they answer different questions. Space
    // membership says the viewer may see this corner of the Hub; the project
    // set says ConqrPlan will show them this work. Neither substitutes for
    // the other, so a result has to clear both.
    const readableProjects = await this.readableProjectIds(
      opts.userId,
      opts.workspaceId,
    );
    if (readableProjects.size === 0) return [];

    const query = [opts.title, opts.description].filter(Boolean).join('\n\n');
    if (!query.trim()) return [];
    const [embedding] = await this.aiProvider.embedMany([query]);
    const chunks = await this.repo.similaritySearch({
      workspaceId: opts.workspaceId,
      queryEmbedding: embedding,
      sourceKind: 'plane_work_item',
      spaceIds,
      topK: limit * OVERSAMPLE,
    });

    return chunks.filter((chunk) => {
      const projectId = (chunk.metadata as { projectId?: unknown } | null)
        ?.projectId;
      // A chunk that cannot say which project it belongs to cannot be
      // authorised, so it is dropped rather than shown.
      return typeof projectId === 'string' && readableProjects.has(projectId);
    });
  }
}
