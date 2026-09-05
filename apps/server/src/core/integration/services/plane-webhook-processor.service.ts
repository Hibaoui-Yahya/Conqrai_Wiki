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
 * What a delivery tells us about the work item's state.
 *
 * ConqrPlan expresses state two ways and they are not interchangeable. Its
 * REST API expands the state into `state_detail` and leaves `state` a bare
 * uuid; its *webhook* payload has no `state_detail` at all and sends `state`
 * as the expanded object `{id, name, color, group}`.
 *
 * Three outcomes, because "we were not told" and "we were told and cannot read
 * it" must not collapse into the same answer:
 *
 * - `absent`     - the payload carried no state. Leave what is stored alone;
 *                  an unrelated partial update must not erase a good value.
 * - `resolved`   - a trustworthy display name, and a group when one came with
 *                  it.
 * - `unresolved` - a state arrived that we cannot render. The stored name is
 *                  cleared rather than shown, because it may describe the
 *                  state the item just left, and a confidently wrong label is
 *                  worse than a blank one. A uuid is never used as the name.
 *
 * Enriching an `unresolved` event by calling ConqrPlan is deliberately not
 * done here: a webhook has no viewer to act for, so the call would have to run
 * as the bridge credential. The read path resolves the name as the viewer, and
 * reconciliation repairs the row.
 */
export type PlaneStateUpdate =
  | { kind: 'absent' }
  | { kind: 'resolved'; id: string | null; name: string; group: string | null }
  | { kind: 'unresolved'; id: string | null };

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Normalise the state a delivery carries.
 *
 * Precedence: `state_detail` wins when both expanded forms are present. It is
 * the field ConqrPlan's REST API populates deliberately, whereas a `state`
 * object on the same payload would be the webhook's own shape arriving
 * alongside it - an ambiguity that should not exist, and if it ever does, the
 * explicitly-expanded field is the one that was meant.
 */
export function normalizePlaneState(
  data: Record<string, unknown> | undefined,
): PlaneStateUpdate {
  if (!data) return { kind: 'absent' };

  const hasState = 'state' in data && data['state'] != null;
  const hasDetail = 'state_detail' in data && data['state_detail'] != null;
  if (!hasState && !hasDetail) return { kind: 'absent' };

  const raw = data['state'];
  const expanded = readObject(data['state_detail']) ?? readObject(raw);
  const id = readString(expanded?.['id']) ?? readString(raw);

  const name = readString(expanded?.['name']);
  if (!name) return { kind: 'unresolved', id };

  return { kind: 'resolved', id, name, group: readString(expanded?.['group']) };
}

/**
 * The state fields to hand to the projection.
 *
 * `undefined` leaves the stored value untouched; `null` clears it. The
 * distinction is the whole point - see {@link PlaneStateUpdate}.
 */
export function stateFieldsFor(update: PlaneStateUpdate): {
  state?: string | null;
  stateGroup?: string | null;
} {
  switch (update.kind) {
    case 'absent':
      return {};
    case 'resolved':
      return { state: update.name, stateGroup: update.group };
    case 'unresolved':
      return { state: null, stateGroup: null };
  }
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
          ...stateFieldsFor(normalizePlaneState(payload.data)),
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
