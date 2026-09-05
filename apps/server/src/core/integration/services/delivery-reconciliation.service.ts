import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { randomUUID } from 'node:crypto';
import { DeliveryProjectionService } from './delivery-projection.service';
import { DeliveryReadService } from './delivery-read.service';
import { ResolutionState } from '../domain/presentation.types';

/**
 * Reconciles delivery projections that events did not keep current.
 *
 * At-least-once delivery still loses events: a webhook that never fired, a
 * consumer down past the sender's retry budget, a delivery dead-lettered and
 * never replayed. Without a sweep those rows stay wrong forever and the page
 * quietly shows stale delivery status — the failure mode is invisible, which
 * is what makes it worth a scheduled job rather than an alert.
 *
 * The sweep refreshes from ConqrPlan through the same permission-shaped read
 * path everything else uses. It has no elevated access: reconciliation is a
 * refresh, not a privilege, and a row belonging to work nobody can see stays
 * unrefreshed rather than being resolved with a service credential.
 */

/** A row not heard about for this long is a candidate. */
const STALE_AFTER_MS = 30 * 60 * 1000;

/** Rows per workspace per run. Bounded so one workspace cannot own the queue. */
const BATCH_SIZE = 50;

export interface ReconciliationMetrics {
  runId: string;
  workspaces: number;
  scanned: number;
  repaired: number;
  skipped: number;
  restricted: number;
  failed: number;
  durationMs: number;
}

@Injectable()
export class DeliveryReconciliationService {
  private readonly logger = new Logger(DeliveryReconciliationService.name);

  /**
   * In-process guard against an overlapping run.
   *
   * BullMQ's fixed `jobId` already prevents two *scheduled* runs colliding
   * across instances; this additionally stops a manual run from landing on top
   * of a scheduled one on the same instance. Two concurrent sweeps would not
   * corrupt anything — every write is idempotent and ordering-protected — but
   * they would double the load on ConqrPlan for no benefit.
   */
  private running = false;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly projection: DeliveryProjectionService,
    private readonly deliveryRead: DeliveryReadService,
  ) {}

  /**
   * Reconcile stale projections across every workspace that has any.
   *
   * @param opts.workspaceId  limit to one workspace (operational runs)
   * @param opts.force        run even if another sweep is in progress
   */
  async reconcile(
    opts: {
      workspaceId?: string;
      staleAfterMs?: number;
      batchSize?: number;
      force?: boolean;
      now?: Date;
    } = {},
  ): Promise<ReconciliationMetrics> {
    const runId = randomUUID();
    const startedAt = Date.now();
    const metrics: ReconciliationMetrics = {
      runId,
      workspaces: 0,
      scanned: 0,
      repaired: 0,
      skipped: 0,
      restricted: 0,
      failed: 0,
      durationMs: 0,
    };

    if (this.running && !opts.force) {
      this.logger.log(
        `Reconciliation ${runId} skipped: a run is already in progress`,
      );
      metrics.durationMs = Date.now() - startedAt;
      return metrics;
    }
    this.running = true;

    try {
      const now = opts.now ?? new Date();
      const cutoff = new Date(
        now.getTime() - (opts.staleAfterMs ?? STALE_AFTER_MS),
      );
      const batchSize = opts.batchSize ?? BATCH_SIZE;

      const workspaceIds = opts.workspaceId
        ? [opts.workspaceId]
        : await this.workspacesWithProjections();
      metrics.workspaces = workspaceIds.length;

      for (const workspaceId of workspaceIds) {
        const stale = await this.projection.findStale(
          workspaceId,
          cutoff,
          batchSize,
        );
        metrics.scanned += stale.length;
        if (!stale.length) continue;

        // Reconciliation runs with no human in the request, so it needs an
        // identity to resolve as. It borrows one that already has access to
        // the work: the person who linked it. If nobody can be resolved the
        // row is skipped rather than refreshed with elevated access — a stale
        // card is a smaller problem than a permission bypass.
        for (const row of stale) {
          const actorId = await this.actorForWorkItem(workspaceId, row.workItemUrn);
          if (!actorId) {
            metrics.skipped += 1;
            continue;
          }

          try {
            const [resolved] = await this.deliveryRead.resolveMany(
              [row.workItemUrn],
              {
                workspaceId,
                viewerId: actorId,
                planeProjectId: row.planeProjectId ?? undefined,
              },
              { forceLive: true, now },
            );

            if (!resolved) {
              metrics.skipped += 1;
              continue;
            }
            if (resolved.model.state === ResolutionState.Restricted) {
              // The borrowed identity has lost access. Not an error, and not
              // something to escalate around.
              metrics.restricted += 1;
              continue;
            }
            if (resolved.origin === 'unavailable') {
              metrics.failed += 1;
              continue;
            }

            // resolveMany already read-repaired a live answer; this records
            // that the row was deliberately confirmed rather than merely
            // reported, which is what distinguishes it in the audit trail.
            await this.projection.markReconciled(workspaceId, row.workItemUrn);
            metrics.repaired += 1;
          } catch (err) {
            metrics.failed += 1;
            this.logger.warn(
              `[${runId}] Reconciliation failed for ${row.workItemUrn}: ${(err as Error).message}`,
            );
          }
        }
      }

      metrics.durationMs = Date.now() - startedAt;
      this.logger.log(
        `[${runId}] Reconciliation finished: ${JSON.stringify({
          workspaces: metrics.workspaces,
          scanned: metrics.scanned,
          repaired: metrics.repaired,
          skipped: metrics.skipped,
          restricted: metrics.restricted,
          failed: metrics.failed,
          durationMs: metrics.durationMs,
        })}`,
      );
      return metrics;
    } finally {
      this.running = false;
    }
  }

  // -------------------------------------------------------------------------

  private async workspacesWithProjections(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('integrationWorkItemStatus')
      .select('workspaceId')
      .distinct()
      .execute();
    return rows.map((r) => r.workspaceId);
  }

  /**
   * Someone who is known to have had access to this work item.
   *
   * The creator of the relationship that links it: they were authorised to
   * create it, so resolving as them is the least surprising choice and it goes
   * through exactly the same delegation and permission checks a page view
   * would. If their access has since been revoked the resolve returns
   * `restricted` and the row is left alone.
   */
  private async actorForWorkItem(
    workspaceId: string,
    workItemUrn: string,
  ): Promise<string | null> {
    const edge = await this.db
      .selectFrom('integrationRelationships')
      .select('createdBy')
      .where('workspaceId', '=', workspaceId)
      .where('targetUrn', '=', workItemUrn)
      .where('createdBy', 'is not', null)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst();
    return edge?.createdBy ?? null;
  }
}
