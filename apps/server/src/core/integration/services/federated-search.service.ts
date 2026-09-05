import { Injectable, Logger } from '@nestjs/common';
import { SearchService } from '../../search/search.service';
import { ProjectSpaceMappingRepo } from '@docmost/db/repos/integration/project-space-mapping.repo';
import { PlaneClientService } from './plane-client.service';
import { DelegatedTokenService } from './delegated-token.service';
import { DELEGATED_SCOPES } from '../domain/delegated-token.util';
import { buildUrn } from '../domain/urn.util';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

export interface FederatedResult {
  source: 'hub' | 'plane';
  type: string;
  urn: string;
  title: string;
  snippet?: string;
  key?: number | null;
  state?: string | null;
  deepLinkId?: string;
  /** Absolute link into the owning product (present when resolvable). */
  deepLink?: string;
}

// Bound the Plane fan-out so a federated query never blows the API rate limit.
const MAX_PLANE_PROJECTS = 3;
const PLANE_PER_PROJECT = 5;

/**
 * Permission-aware unified search (blueprint §5.3B). Federates Hub knowledge
 * (Typesense/BM25, already workspace-scoped) with Plane work items from mapped
 * projects, returning one result shape that identifies its source product.
 *
 * Authorization note: Hub results are permission-filtered by Hub. Plane results
 * are bounded to the workspace's mapped projects (a coarse tenant boundary);
 * per-user Plane item permissions need a per-user token, which the API-token
 * integration model does not provide — so Plane results here are workspace-level.
 */
@Injectable()
export class FederatedSearchService {
  private readonly logger = new Logger(FederatedSearchService.name);

  constructor(
    private readonly hubSearch: SearchService,
    private readonly mappings: ProjectSpaceMappingRepo,
    private readonly plane: PlaneClientService,
    private readonly environment: EnvironmentService,
    private readonly delegation: DelegatedTokenService,
  ) {}

  async search(
    query: string,
    opts: { workspaceId: string; userId: string; planeProjectId?: string },
  ): Promise<{ items: FederatedResult[]; sources: string[] }> {
    const trimmed = (query ?? '').trim();
    if (!trimmed) return { items: [], sources: [] };

    const [hub, plane] = await Promise.all([
      this.searchHub(trimmed, opts),
      this.searchPlane(trimmed, opts),
    ]);

    const sources: string[] = [];
    if (hub.length) sources.push('hub');
    if (plane.length) sources.push('plane');

    // Interleave so neither product dominates the top of the list.
    return { items: interleave(hub, plane), sources };
  }

  private async searchHub(
    query: string,
    opts: { workspaceId: string; userId: string },
  ): Promise<FederatedResult[]> {
    try {
      const res = await this.hubSearch.searchPage(
        { query, limit: 20 } as any,
        { workspaceId: opts.workspaceId, userId: opts.userId },
      );
      return (res.items ?? []).map((p: any) => ({
        source: 'hub' as const,
        type: 'page',
        urn: buildUrn('hub', 'page', p.id),
        title: p.title ?? 'Untitled',
        snippet: p.highlight ?? undefined,
        deepLinkId: p.slugId ?? p.id,
      }));
    } catch (err) {
      this.logger.warn(`Hub search failed: ${(err as Error).message}`);
      return [];
    }
  }

  private async searchPlane(
    query: string,
    opts: { workspaceId: string; userId: string; planeProjectId?: string },
  ): Promise<FederatedResult[]> {
    if (!this.plane.isEnabled()) return [];

    let projectIds: string[];
    if (opts.planeProjectId) {
      projectIds = [opts.planeProjectId];
    } else {
      const mapped = await this.mappings.listForWorkspace(opts.workspaceId);
      projectIds = Array.from(new Set(mapped.map((m) => m.planeProjectId))).slice(
        0,
        MAX_PLANE_PROJECTS,
      );
    }
    if (projectIds.length === 0) return [];

    const perProject = await Promise.all(
      projectIds.map(async (pid) => {
        try {
          // The Hub half of this search is already filtered to what the
          // searcher may read; the ConqrPlan half has to be too, or federated
          // search becomes a way to read titles from projects you are not in.
          const { results } = await this.plane.listWorkItems(
            pid,
            { search: query, perPage: PLANE_PER_PROJECT },
            this.delegation.mintCallContext(opts.userId, opts.workspaceId, [
              DELEGATED_SCOPES.workItemRead,
            ]),
          );
          const appUrl = this.environment.getPlaneAppUrl();
          const slug = this.environment.getPlaneWorkspaceSlug();
          return results.map((wi) => ({
            source: 'plane' as const,
            type: 'work-item',
            urn: buildUrn('plane', 'work-item', wi.id),
            title: wi.name,
            key: wi.sequence_id ?? null,
            // state_detail only — the raw `state` field is an opaque id, worse
            // than no badge at all.
            state: wi.state_detail?.name ?? null,
            deepLink:
              appUrl && slug
                ? `${appUrl}/${slug}/projects/${pid}/issues/${wi.id}`
                : undefined,
          }));
        } catch (err) {
          this.logger.warn(
            `Plane search failed for project ${pid}: ${(err as Error).message}`,
          );
          return [];
        }
      }),
    );
    return perProject.flat();
  }
}

function interleave(a: FederatedResult[], b: FederatedResult[]): FederatedResult[] {
  const out: FederatedResult[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}
