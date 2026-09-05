import { Injectable, Logger } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { PlaneClientService, PlaneApiError } from './plane-client.service';
import { DelegatedTokenService } from './delegated-token.service';
import { DELEGATED_SCOPES } from '../domain/delegated-token.util';
import { parseUrn } from '../domain/urn.util';
import {
  DisplayMode,
  PresentationModel,
  ResolutionState,
} from '../domain/presentation.types';

export interface ResolveContext {
  workspaceId: string;
  viewerId: string;
  /** Needed for Plane work items — their API is project-scoped. */
  planeProjectId?: string;
  /**
   * Per-URN project override, keyed by work-item URN.
   *
   * A page's space maps to at most one ConqrPlan project, but the work items
   * linked from that page do not all have to live in it - and a page in an
   * unmapped space has no project at all. Falling back to the single
   * `planeProjectId` meant those items were never looked up: resolution
   * returned `source_unavailable`, a generic failure, for work that was
   * perfectly readable and sometimes simply deleted. The relationship already
   * records which project its target is in, so callers that hold the edge
   * should pass it here.
   */
  planeProjectByUrn?: Record<string, string>;
  displayMode?: DisplayMode;
  locale?: string;
}

/**
 * Common Smart Object Resolver (blueprint §8.6). Returns only fields the viewer
 * is authorized to see plus freshness state, so a single UI component can
 * render any linked object. Failures degrade explicitly (stale/unavailable/
 * restricted) instead of throwing.
 */
@Injectable()
export class SmartObjectResolverService {
  private readonly logger = new Logger(SmartObjectResolverService.name);

  /** projectId -> state id/name map, briefly cached. See stateName(). */
  private readonly stateCache = new Map<
    string,
    { byId: Map<string, string>; at: number }
  >();

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly planeClient: PlaneClientService,
    private readonly environment: EnvironmentService,
    private readonly delegation: DelegatedTokenService,
  ) {}

  async resolve(
    urn: string,
    ctx: ResolveContext,
  ): Promise<PresentationModel> {
    let parsed;
    try {
      parsed = parseUrn(urn);
    } catch {
      return { urn, state: ResolutionState.NotFound };
    }

    if (parsed.product === 'plane') {
      return this.resolvePlane(parsed.type, parsed.id, urn, ctx);
    }
    if (parsed.product === 'hub') {
      return this.resolveHub(parsed.type, parsed.id, urn, ctx);
    }
    return { urn, state: ResolutionState.NotFound };
  }

  async resolveMany(
    urns: string[],
    ctx: ResolveContext,
  ): Promise<PresentationModel[]> {
    // Dedup identical URNs so a page with many cards to the same object makes
    // one source call, not N (blueprint §8.4 "avoid N+1 / batch resolution").
    const unique = Array.from(new Set(urns));
    const resolved = await Promise.all(
      unique.map(async (u) => [u, await this.resolve(u, ctx)] as const),
    );
    const byUrn = new Map<string, PresentationModel>(resolved);
    // Preserve caller order and any duplicates.
    return urns.map(
      (u) => byUrn.get(u) ?? { urn: u, state: ResolutionState.NotFound },
    );
  }

  private async resolvePlane(
    type: string,
    id: string,
    urn: string,
    ctx: ResolveContext,
  ): Promise<PresentationModel> {
    if (!this.planeClient.isEnabled()) {
      return { urn, state: ResolutionState.IntegrationDisabled };
    }
    if (type !== 'work-item') {
      // Other Plane types resolve to a deep link only for now.
      return {
        urn,
        state: ResolutionState.Live,
        deepLink: this.planeDeepLink(type, id, ctx.planeProjectId),
      };
    }
    const projectId = ctx.planeProjectByUrn?.[urn] ?? ctx.planeProjectId;
    if (!projectId) {
      // Cannot locate a project-scoped item without its project.
      return { urn, state: ResolutionState.SourceUnavailable };
    }

    try {
      // Resolve as the viewer, never as the integration's own credential.
      // Without a delegation ConqrPlan would answer for whoever owns the API
      // key, so a viewer with no access to this project would still be shown
      // its title, state and assignees. Delegating makes the 403 below a real
      // permission decision about *this* person.
      const item = await this.planeClient.getWorkItem(
        projectId,
        id,
        this.viewerContext(ctx),
      );
      // ConqrPlan's public API does not expand state_detail, so `state` is a
      // bare uuid. Rendering that verbatim put a raw id on a work-item card
      // where a human expects "In Progress". Resolve it to a name, and show
      // nothing rather than an id when the lookup fails.
      const stateName = await this.stateName(
        projectId,
        item.state_detail?.name,
        typeof item.state === 'string' ? item.state : null,
        ctx,
      );

      return {
        urn,
        state: ResolutionState.Live,
        title: item.name,
        fields: {
          key: item.sequence_id ?? null,
          state: stateName,
          stateGroup: item.state_detail?.group ?? null,
          priority: item.priority ?? null,
          assignees: item.assignees ?? [],
          // Panel fields. Every one of these is only ever populated on a
          // `live` result, so a restricted viewer receives none of them.
          estimatePointId: item.estimate_point ?? null,
          targetDate: item.target_date ?? null,
          startDate: item.start_date ?? null,
          completed: Boolean(item.completed_at),
        },
        deepLink: this.planeDeepLink('work-item', id, projectId),
        sourceVersion: item.updated_at,
        lastRefreshedAt: new Date().toISOString(),
        actions: [
          { id: 'open', label: 'Open in Plane', allowed: true },
        ],
      };
    } catch (err) {
      if (err instanceof PlaneApiError) {
        if (err.status === 404) return { urn, state: ResolutionState.Deleted };
        if (err.status === 403)
          return { urn, state: ResolutionState.Restricted };
        // 429/5xx/network → no safe snapshot in this slice.
        return { urn, state: ResolutionState.SourceUnavailable };
      }
      this.logger.warn(`Unexpected resolve error for ${urn}`);
      return { urn, state: ResolutionState.SourceUnavailable };
    }
  }

  /**
   * Map a work item's state id to its name.
   *
   * Cached per project for a minute: a panel resolving ten cards would
   * otherwise fetch the same small state list ten times, and states change
   * rarely enough that a name a minute old costs nothing.
   */
  private async stateName(
    projectId: string,
    expanded: string | undefined,
    stateId: string | null,
    ctx: ResolveContext,
  ): Promise<string | null> {
    if (expanded) return expanded;
    if (!stateId) return null;

    const cached = this.stateCache.get(projectId);
    let byId = cached && Date.now() - cached.at < 60_000 ? cached.byId : undefined;

    if (!byId) {
      try {
        const states = await this.planeClient.listStates(
          projectId,
          this.viewerContext(ctx),
        );
        byId = new Map(states.map((s) => [String(s.id), s.name]));
        this.stateCache.set(projectId, { byId, at: Date.now() });
      } catch {
        // No name is better than a uuid on the card.
      }
    }
    return byId?.get(String(stateId)) ?? null;
  }

  /**
   * A short-lived read-only delegation for the viewer.
   *
   * Read scope only: resolving a card for display must never be able to change
   * anything, even if a downstream call were changed to a write by mistake.
   */
  private viewerContext(ctx: ResolveContext) {
    const minted = this.delegation.mintForPlane({
      hubUserId: ctx.viewerId,
      hubWorkspaceId: ctx.workspaceId,
      scope: [DELEGATED_SCOPES.workItemRead],
    });
    return { delegation: minted.token, correlationId: minted.jti };
  }

  private async resolveHub(
    type: string,
    id: string,
    urn: string,
    ctx: ResolveContext,
  ): Promise<PresentationModel> {
    try {
      const page = await this.pageRepo.findById(id, { includeSpace: false });
      if (!page || page.workspaceId !== ctx.workspaceId) {
        return { urn, state: ResolutionState.NotFound };
      }
      if (page.deletedAt) {
        return { urn, state: ResolutionState.Deleted, title: page.title ?? undefined };
      }
      return {
        urn,
        state: ResolutionState.Live,
        title: page.title ?? 'Untitled',
        fields: { spaceId: page.spaceId, icon: page.icon ?? null },
        // Absolute, like every other deep link this app hands out (page
        // promotion, space mapping). Resolve is answered for *other* products —
        // ConqrService renders these citations inside its launcher iframe,
        // where a relative href resolves against ConqrService and lands
        // nowhere. `/p/:slugId` redirects to the page's space route.
        deepLink: `${this.environment.getAppUrl()}/p/${page.slugId ?? page.id}`,
        sourceVersion: page.updatedAt
          ? new Date(page.updatedAt as unknown as string).toISOString()
          : undefined,
        lastRefreshedAt: new Date().toISOString(),
        actions: [{ id: 'open', label: 'Open page', allowed: true }],
      };
    } catch {
      return { urn, state: ResolutionState.SourceUnavailable };
    }
  }

  private planeDeepLink(
    type: string,
    id: string,
    projectId?: string,
  ): string | undefined {
    const base = this.environment.getPlaneAppUrl();
    const slug = this.environment.getPlaneWorkspaceSlug();
    if (!base || !slug || !projectId) return undefined;
    if (type === 'work-item') {
      return `${base}/${slug}/projects/${projectId}/issues/${id}`;
    }
    return `${base}/${slug}/projects/${projectId}`;
  }
}
