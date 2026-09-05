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
          state:
            (payload.data as any).state_detail?.name ??
            (typeof (payload.data as any).state === 'string'
              ? (payload.data as any).state
              : null),
          stateGroup: (payload.data as any).state_detail?.group ?? null,
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
