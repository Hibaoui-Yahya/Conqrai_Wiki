import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

/**
 * Delivery-status projection for linked ConqrPlan work (Vertical Slice 01).
 *
 * ConqrPlan owns execution state. This is a cache of the little the Hub
 * experience needs — enough to render a Related Work card and to keep
 * rendering it when ConqrPlan is briefly unreachable — and it is always
 * reconcilable against the source.
 *
 * The delivery guarantee we are handed is at-least-once and unordered, so two
 * things have to be true independently:
 *
 * **Duplicates change nothing.** Suppression happens upstream, on the delivery
 * id, in `integration_webhook_deliveries`. Even if a duplicate slipped past it,
 * `apply` is idempotent: the same payload applied twice produces the same row.
 *
 * **Older news never overwrites newer.** Every update carries ConqrPlan's own
 * `updated_at`, and an update whose timestamp is not newer than the stored one
 * is discarded. Without this, a retried delivery from ten minutes ago would
 * quietly roll a work item's status backwards, and the page would show
 * something that is not true any more.
 */

export interface DeliveryStatusUpdate {
  workspaceId: string;
  workItemUrn: string;
  planeProjectId?: string | null;
  title?: string | null;
  state?: string | null;
  stateGroup?: string | null;
  completed?: boolean;
  deletedInSource?: boolean;
  /** ConqrPlan's updated_at for this version. Drives ordering. */
  sourceUpdatedAt?: string | Date | null;
  deliveryId?: string | null;
}

export type ApplyOutcome =
  | { applied: true; reason: 'created' | 'updated' }
  | { applied: false; reason: 'stale' | 'no_change' };

export interface ProjectedStatus {
  workItemUrn: string;
  planeProjectId: string | null;
  title: string | null;
  state: string | null;
  stateGroup: string | null;
  completed: boolean;
  deletedInSource: boolean;
  sourceUpdatedAt: Date | null;
  lastEventAt: Date | null;
  reconciledAt: Date | null;
}

@Injectable()
export class DeliveryProjectionService {
  private readonly logger = new Logger(DeliveryProjectionService.name);

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * Apply one status update.
   *
   * Returns what happened rather than void, so a caller — and a test — can
   * tell "we ignored an old event" apart from "we wrote it", instead of both
   * looking like success.
   */
  async apply(update: DeliveryStatusUpdate): Promise<ApplyOutcome> {
    const incoming = toDate(update.sourceUpdatedAt);

    const existing = await this.db
      .selectFrom('integrationWorkItemStatus')
      .selectAll()
      .where('workspaceId', '=', update.workspaceId)
      .where('workItemUrn', '=', update.workItemUrn)
      .executeTakeFirst();

    if (existing) {
      const stored = existing.sourceUpdatedAt
        ? new Date(existing.sourceUpdatedAt as any)
        : null;

      // Strictly older is discarded. Equal timestamps are allowed through:
      // ConqrPlan's updated_at has second granularity, so two genuine changes
      // can share one, and refusing them would lose the later of the two.
      if (incoming && stored && incoming < stored) {
        this.logger.debug(
          `Discarded stale update for ${update.workItemUrn}: ${incoming.toISOString()} < ${stored.toISOString()}`,
        );
        return { applied: false, reason: 'stale' };
      }
    }

    const row = {
      workspaceId: update.workspaceId,
      workItemUrn: update.workItemUrn,
      planeProjectId: update.planeProjectId ?? existing?.planeProjectId ?? null,
      title: update.title ?? existing?.title ?? null,
      state: update.state ?? existing?.state ?? null,
      stateGroup: update.stateGroup ?? existing?.stateGroup ?? null,
      completed: update.completed ?? existing?.completed ?? false,
      deletedInSource: update.deletedInSource ?? existing?.deletedInSource ?? false,
      sourceUpdatedAt: incoming ?? (existing?.sourceUpdatedAt as any) ?? null,
      lastDeliveryId: update.deliveryId ?? existing?.lastDeliveryId ?? null,
      lastEventAt: new Date(),
      updatedAt: new Date(),
    };

    await this.db
      .insertInto('integrationWorkItemStatus')
      .values(row as any)
      .onConflict((oc) =>
        oc.columns(['workspaceId', 'workItemUrn']).doUpdateSet({
          planeProjectId: row.planeProjectId,
          title: row.title,
          state: row.state,
          stateGroup: row.stateGroup,
          completed: row.completed,
          deletedInSource: row.deletedInSource,
          sourceUpdatedAt: row.sourceUpdatedAt,
          lastDeliveryId: row.lastDeliveryId,
          lastEventAt: row.lastEventAt,
          updatedAt: row.updatedAt,
        } as any),
      )
      .execute();

    return { applied: true, reason: existing ? 'updated' : 'created' };
  }

  async get(
    workspaceId: string,
    workItemUrn: string,
  ): Promise<ProjectedStatus | null> {
    const row = await this.db
      .selectFrom('integrationWorkItemStatus')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('workItemUrn', '=', workItemUrn)
      .executeTakeFirst();
    return row ? toProjected(row) : null;
  }

  async getMany(
    workspaceId: string,
    workItemUrns: string[],
  ): Promise<Map<string, ProjectedStatus>> {
    if (!workItemUrns.length) return new Map();
    const rows = await this.db
      .selectFrom('integrationWorkItemStatus')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('workItemUrn', 'in', workItemUrns)
      .execute();
    return new Map(rows.map((r) => [r.workItemUrn, toProjected(r)]));
  }

  /**
   * Work items whose status has not been confirmed recently.
   *
   * An at-least-once stream still loses events — a webhook that never fired, a
   * consumer that was down past the sender's retry budget, a dead-lettered
   * delivery nobody replayed. Reconciliation is what makes that recoverable
   * rather than permanent: the projection is refreshed from the source, which
   * is authoritative, instead of waiting for an event that is not coming.
   */
  async findStale(
    workspaceId: string,
    olderThan: Date,
    limit = 100,
  ): Promise<ProjectedStatus[]> {
    const rows = await this.db
      .selectFrom('integrationWorkItemStatus')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('deletedInSource', '=', false)
      .where((eb) =>
        eb.or([
          eb('lastEventAt', 'is', null),
          eb('lastEventAt', '<', olderThan),
        ]),
      )
      .orderBy('lastEventAt', 'asc')
      .limit(limit)
      .execute();
    return rows.map(toProjected);
  }

  /**
   * Record that a row was confirmed directly against ConqrPlan.
   *
   * Kept separate from `apply` so a reconciliation pass cannot be mistaken for
   * an event in the audit trail: `reconciled_at` says "we asked", while
   * `last_event_at` says "we were told".
   */
  async markReconciled(
    workspaceId: string,
    workItemUrn: string,
  ): Promise<void> {
    await this.db
      .updateTable('integrationWorkItemStatus')
      .set({ reconciledAt: new Date(), updatedAt: new Date() } as any)
      .where('workspaceId', '=', workspaceId)
      .where('workItemUrn', '=', workItemUrn)
      .execute();
  }
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toProjected(row: any): ProjectedStatus {
  return {
    workItemUrn: row.workItemUrn,
    planeProjectId: row.planeProjectId ?? null,
    title: row.title ?? null,
    state: row.state ?? null,
    stateGroup: row.stateGroup ?? null,
    completed: Boolean(row.completed),
    deletedInSource: Boolean(row.deletedInSource),
    sourceUpdatedAt: row.sourceUpdatedAt ? new Date(row.sourceUpdatedAt) : null,
    lastEventAt: row.lastEventAt ? new Date(row.lastEventAt) : null,
    reconciledAt: row.reconciledAt ? new Date(row.reconciledAt) : null,
  };
}
