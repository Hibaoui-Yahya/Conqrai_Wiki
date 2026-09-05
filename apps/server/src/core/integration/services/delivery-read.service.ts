import { Injectable, Logger } from '@nestjs/common';
import {
  DeliveryProjectionService,
  ProjectedStatus,
} from './delivery-projection.service';
import { SmartObjectResolverService } from './smart-object-resolver.service';
import { PresentationModel, ResolutionState } from '../domain/presentation.types';

/**
 * Read path for linked delivery status, with bounded fallback and read repair.
 *
 * The panel must not depend blindly on the projection: a work item linked five
 * minutes ago has no projection row yet (the first webhook may not have
 * arrived), and a row whose events stopped arriving is quietly wrong. Equally
 * it must not resolve every card live on every render — that is an unbounded
 * fan-out onto another product, and it makes the panel as slow and as fragile
 * as the slowest ConqrPlan request.
 *
 * So: read the projection, judge its freshness, and fall back to ConqrPlan
 * only for the URNs that actually need it — batched, capped, and behind a
 * circuit breaker. Whatever comes back is permission-shaped by the resolver,
 * which delegates as the viewer; there is no path here that reads ConqrPlan as
 * the service account or ConqrPlan's database directly.
 *
 * ConqrPlan stays the source of truth for delivery state. The projection is a
 * cache that is allowed to be wrong, and says so when it might be.
 */

/** Older than this and a projection row is no longer trusted on its own. */
const FRESH_FOR_MS = 5 * 60 * 1000;

/** Most URNs we will resolve live in one read. */
const MAX_LIVE_FALLBACK = 25;

/**
 * Consecutive failures before the breaker opens.
 *
 * Deliberately small. The failure we are protecting against is ConqrPlan being
 * down, and in that state every request will fail; retrying dozens of times per
 * page render turns their outage into ours.
 */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30 * 1000;

export interface ResolvedDelivery {
  urn: string;
  model: PresentationModel;
  /** Where the answer came from, so the UI can label it honestly. */
  origin: 'live' | 'projection' | 'unavailable';
  /** True when shown from a projection that is past its freshness window. */
  stale: boolean;
  /** ISO timestamp of the last time this status was confirmed. */
  lastSyncedAt: string | null;
}

@Injectable()
export class DeliveryReadService {
  private readonly logger = new Logger(DeliveryReadService.name);

  private consecutiveFailures = 0;
  private breakerOpenedAt: number | null = null;

  constructor(
    private readonly projection: DeliveryProjectionService,
    private readonly resolver: SmartObjectResolverService,
  ) {}

  /**
   * Resolve delivery status for a set of work-item URNs.
   *
   * Batched by design: one projection query for all of them, then at most one
   * live resolution pass for the subset that needs it.
   */
  async resolveMany(
    urns: string[],
    ctx: {
      workspaceId: string;
      viewerId: string;
      planeProjectId?: string;
      /** Per-URN project, from the relationship that recorded the link. */
      planeProjectByUrn?: Record<string, string>;
    },
    opts: { now?: Date; forceLive?: boolean } = {},
  ): Promise<ResolvedDelivery[]> {
    if (!urns.length) return [];
    const now = opts.now ?? new Date();
    const unique = Array.from(new Set(urns));

    const projected = await this.projection.getMany(ctx.workspaceId, unique);

    // Decide per URN whether the projection can answer on its own.
    const needsLive: string[] = [];
    for (const urn of unique) {
      const row = projected.get(urn);
      if (opts.forceLive || !row || this.isStale(row, now)) needsLive.push(urn);
    }

    let liveByUrn = new Map<string, PresentationModel>();
    const capped = needsLive.slice(0, MAX_LIVE_FALLBACK);
    const skipped = new Set(needsLive.slice(MAX_LIVE_FALLBACK));

    if (capped.length && !this.breakerOpen(now)) {
      try {
        const models = await this.resolver.resolveMany(capped, ctx);
        liveByUrn = new Map(models.map((m) => [m.urn, m]));
        this.recordSuccess();
        // Read repair: fold what we just learned back into the projection so
        // the next reader does not pay for the same round trip. Idempotent and
        // ordering-protected by the projection itself, so a slow response that
        // lands after a newer webhook cannot roll status backwards.
        await this.repair(ctx.workspaceId, models);
      } catch (err) {
        this.recordFailure(now);
        this.logger.warn(
          `Live delivery resolution failed for ${capped.length} item(s): ${(err as Error).message}`,
        );
      }
    }

    return unique.map((urn) => {
      const live = liveByUrn.get(urn);
      const row = projected.get(urn);

      // A live answer always wins, including a restricted one — that is the
      // authoritative statement about this viewer's access.
      if (live && live.state !== ResolutionState.SourceUnavailable) {
        return {
          urn,
          model: live,
          origin: 'live',
          stale: false,
          lastSyncedAt: now.toISOString(),
        };
      }

      if (row) {
        const stale = this.isStale(row, now) || skipped.has(urn);
        return {
          urn,
          model: this.fromProjection(urn, row, stale),
          origin: 'projection',
          stale,
          lastSyncedAt: (row.lastEventAt ?? row.reconciledAt)?.toISOString() ?? null,
        };
      }

      // Nothing cached and nothing reachable. Say so rather than implying the
      // item does not exist.
      return {
        urn,
        model: live ?? { urn, state: ResolutionState.SourceUnavailable },
        origin: 'unavailable',
        stale: true,
        lastSyncedAt: null,
      };
    });
  }

  // -------------------------------------------------------------------------

  private isStale(row: ProjectedStatus, now: Date): boolean {
    const seen = row.lastEventAt ?? row.reconciledAt;
    if (!seen) return true;
    return now.getTime() - seen.getTime() > FRESH_FOR_MS;
  }

  /**
   * Present a projection row.
   *
   * Marked `Stale` rather than `Live` whenever it is past the freshness window,
   * because the card is then showing something ConqrPlan has not confirmed
   * recently and the user is entitled to know that.
   *
   * The projection holds no per-viewer permission information, so it carries
   * only what a work-item card needs and never fields like assignees that
   * would be a leak if the viewer's access had been revoked since the row was
   * written. Access is re-checked live at the next refresh and on navigation.
   */
  private fromProjection(
    urn: string,
    row: ProjectedStatus,
    stale: boolean,
  ): PresentationModel {
    if (row.deletedInSource) {
      return { urn, state: ResolutionState.Deleted, title: row.title ?? undefined };
    }
    return {
      urn,
      state: stale ? ResolutionState.Stale : ResolutionState.Live,
      title: row.title ?? undefined,
      fields: {
        state: row.state,
        stateGroup: row.stateGroup,
        completed: row.completed,
      },
      sourceVersion: row.sourceUpdatedAt?.toISOString(),
      lastRefreshedAt: (row.lastEventAt ?? row.reconciledAt)?.toISOString(),
    };
  }

  /** Fold a live answer back into the projection. Never throws. */
  private async repair(
    workspaceId: string,
    models: PresentationModel[],
  ): Promise<void> {
    for (const model of models) {
      // Only a live answer is worth caching. A restricted result says nothing
      // about the item, only about the viewer, and writing it would poison the
      // projection for everyone else.
      if (model.state !== ResolutionState.Live) continue;
      try {
        await this.projection.apply({
          workspaceId,
          workItemUrn: model.urn,
          title: model.title ?? null,
          state: (model.fields?.state as string) ?? null,
          stateGroup: (model.fields?.stateGroup as string) ?? null,
          completed: Boolean(model.fields?.completed),
          sourceUpdatedAt: model.sourceVersion ?? null,
        });
      } catch (err) {
        this.logger.warn(
          `Read repair failed for ${model.urn}: ${(err as Error).message}`,
        );
      }
    }
  }

  private breakerOpen(now: Date): boolean {
    if (this.breakerOpenedAt === null) return false;
    if (now.getTime() - this.breakerOpenedAt > BREAKER_COOLDOWN_MS) {
      // Cooldown elapsed: let one pass through to test the water.
      this.breakerOpenedAt = null;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  /**
   * `now` is passed in rather than read from the clock so the cooldown is
   * measured on the same clock the caller used to judge freshness. Mixing the
   * two makes the cooldown untestable and, under a shifted clock, unbounded.
   */
  private recordFailure(now: Date): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= BREAKER_THRESHOLD) {
      this.breakerOpenedAt = now.getTime();
      this.logger.warn(
        `ConqrPlan resolution breaker opened after ${this.consecutiveFailures} failures; serving projections for ${BREAKER_COOLDOWN_MS / 1000}s`,
      );
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.breakerOpenedAt = null;
  }
}
