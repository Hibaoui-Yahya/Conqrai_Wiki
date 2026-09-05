import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RelationshipRepo } from '@docmost/db/repos/integration/relationship.repo';
import { IntegrationEventService } from './integration-event.service';
import { DeliveryProjectionService } from './delivery-projection.service';
import { LifecycleAutomationService } from './lifecycle-automation.service';
import { buildUrn } from '../domain/urn.util';
import { EventType } from '../domain/event-envelope';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';

export interface ParsedPlaneEvent {
  event?: string; // "issue", "cycle", ...
  action?: string; // "created" | "updated" | "deleted"
  data?: { id?: string; project?: string; [k: string]: unknown };
}

/**
 * The work item's state, from whichever shape the payload uses.
 *
 * ConqrPlan expresses this two ways and they are not interchangeable. Its REST
 * API expands the state into `state_detail` and leaves `state` a bare uuid;
 * its *webhook* payload has no `state_detail` at all and sends `state` as the
 * expanded object `{id, name, color, group}`.
 *
 * This code was written against the REST shape, so on a webhook `state_detail`
 * was undefined and the fallback only accepted a string - and an object is not
 * a string. Both fields therefore came back null on every delivery, and the
 * projection silently never recorded state at all. It looked healthy: title
 * and timestamps updated, the card still showed the right state, because the
 * read path quietly fell back to a live call. The cache existed and held
 * nothing.
 *
 * A bare uuid is kept as a last resort. It is a poor label, but it is a true
 * one, and `stateName()` in the resolver turns it into a name.
 */
export function planeState(data: Record<string, unknown> | undefined): {
  state: string | null;
  stateGroup: string | null;
} {
  const raw = data?.['state'];
  const expanded =
    (data?.['state_detail'] as { name?: unknown; group?: unknown } | undefined) ??
    (raw && typeof raw === 'object'
      ? (raw as { name?: unknown; group?: unknown })
      : undefined);

  const name = expanded?.name;
  const group = expanded?.group;
  return {
    state:
      typeof name === 'string' && name
        ? name
        : typeof raw === 'string' && raw
          ? raw
          : null,
    stateGroup: typeof group === 'string' && group ? group : null,
  };
}

export interface ProcessResult {
  affectedWorkspaces: number;
  subject?: string;
}

/**
 * Translates a verified Plane webhook into refresh events for every workspace
 * that has linked the affected object (blueprint §8.4). Idempotent: re-running
 * for the same delivery only re-emits refresh signals, never mutating canonical
 * data. Cache invalidation / notification fan-out hang off the emitted event.
 */
@Injectable()
export class PlaneWebhookProcessorService {
  private readonly logger = new Logger(PlaneWebhookProcessorService.name);

  constructor(
    private readonly relationships: RelationshipRepo,
    private readonly events: IntegrationEventService,
    private readonly lifecycle: LifecycleAutomationService,
    private readonly projection: DeliveryProjectionService,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
  ) {}

  parse(rawBody: Buffer | string | undefined): ParsedPlaneEvent | null {
    if (!rawBody) return null;
    try {
      return JSON.parse(rawBody.toString());
    } catch {
      return null;
    }
  }

  async process(
    payload: ParsedPlaneEvent | null,
    deliveryId: string,
  ): Promise<ProcessResult> {
    if (!payload?.data?.id) return { affectedWorkspaces: 0 };

    // Cycle/module completion → lifecycle suggestions (§6.3/§6.4).
    if (
      (payload.event === 'cycle' || payload.event === 'module') &&
      payload.action === 'completed'
    ) {
      const res = await this.lifecycle.onContainerCompleted({
        kind: payload.event,
        projectId: String(payload.data.project ?? ''),
        id: String(payload.data.id),
        name: (payload.data as any).name,
      });
      return {
        affectedWorkspaces: res.suggestionsEmitted,
        subject: buildUrn('plane', payload.event, String(payload.data.id)),
      };
    }

    // Only work-item (issue) events map to smart-object refreshes.
    if (payload.event !== 'issue') {
      return { affectedWorkspaces: 0 };
    }

    const subject = buildUrn('plane', 'work-item', payload.data.id);
    const isDelete = payload.action === 'deleted';

    // Keep the suite semantic index fresh (gap-analysis A1). Enqueue-only:
    // the EE worker decides whether AI is available / the project is mapped.
    // Failure to enqueue must never break refresh fan-out.
    try {
      if (isDelete) {
        await this.aiQueue.add(QueueJob.DELETE_PLANE_WORK_ITEM_EMBEDDINGS, {
          workItemId: String(payload.data.id),
        });
      } else {
        await this.aiQueue.add(QueueJob.INDEX_PLANE_WORK_ITEM, {
          workItemId: String(payload.data.id),
          projectId: String(payload.data.project ?? ''),
        });
      }
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue semantic indexing for ${subject}: ${(err as Error).message}`,
      );
    }

    const affected = await this.relationships.findByUrnAnyWorkspace(subject);
    const workspaces = Array.from(
      new Set(affected.map((r) => r.workspaceId)),
    );

    for (const workspaceId of workspaces) {
      // Project the delivery status the Hub experience renders.
      //
      // Ordered by ConqrPlan's own updated_at, not by arrival: this stream is
      // at-least-once and unordered, so a retried delivery from ten minutes
      // ago would otherwise roll a work item's status backwards and the page
      // would show something that is no longer true. `apply` discards anything
      // older than what it already holds.
      try {
        await this.projection.apply({
          workspaceId,
          workItemUrn: subject,
          planeProjectId: payload.data.project ? String(payload.data.project) : null,
          title: (payload.data as any).name ?? null,
          ...planeState(payload.data),
          completed: Boolean((payload.data as any).completed_at),
          deletedInSource: isDelete,
          sourceUpdatedAt: (payload.data as any).updated_at ?? null,
          deliveryId,
        });
      } catch (err) {
        // A projection failure must not stop the fan-out below; the row is
        // repaired by reconciliation.
        this.logger.warn(
          `Failed to project status for ${subject} in ${workspaceId}: ${(err as Error).message}`,
        );
      }

      await this.events.record({
        workspaceId,
        type: isDelete
          ? EventType.PlaneWorkItemDeleted
          : EventType.PlaneWorkItemUpdated,
        source: 'plane-adapter',
        subject,
        data: {
          action: payload.action ?? 'updated',
          deliveryId,
          projectId: payload.data.project ?? null,
        },
      });
    }

    this.logger.log(
      `Processed Plane ${payload.action} for ${subject}: notified ${workspaces.length} workspace(s)`,
    );
    return { affectedWorkspaces: workspaces.length, subject };
  }
}
