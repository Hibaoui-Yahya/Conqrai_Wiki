import { z } from 'zod';
import {
  PlaneApiError,
  PlaneCallContext,
  PlaneClientService,
  PlaneWorkItem,
  PlaneWorkItemWrite,
} from '../../../../core/integration/services/plane-client.service';
import { buildUrn } from '../../../../core/integration/domain/urn.util';

/**
 * Shared work-item field handling for the ConqrPlan MCP tools
 * (Control Foundation v1).
 *
 * Create, update and bulk-create all speak the same field vocabulary, so the
 * schema, the payload builder, the reference pre-flight and the response
 * normaliser live here rather than being restated three times and drifting.
 *
 * Two rules drive the design:
 *
 * 1. **Omitted is not cleared.** A field left out of the call is untouched;
 *    an explicit `null` clears it. JSON cannot express "absent" inside a
 *    validated object without this distinction, and an agent that wants to
 *    change a priority must not wipe a due date as a side effect.
 *
 * 2. **Never report success for a field that was dropped.** ConqrPlan filters
 *    assignees to project members and labels to project labels *silently* -
 *    it returns 201 having quietly discarded the rest. We compare what was
 *    asked for against what came back and surface the difference.
 */

/**
 * Narrow an options object back to just the call context.
 *
 * Keeps the delegation and correlation id travelling with every ConqrPlan
 * request without letting local-only fields (like `currentCycleId`) leak into
 * the transport layer.
 */
function ctxOf(opts: PlaneCallContext): PlaneCallContext {
  return {
    workspaceSlug: opts.workspaceSlug,
    delegation: opts.delegation,
    correlationId: opts.correlationId,
  };
}

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

/** Stable machine-readable codes. Agents branch on these, not on prose. */
export type WorkItemErrorCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_REFERENCE'
  | 'CROSS_PROJECT_REFERENCE'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'LIMIT_EXCEEDED'
  | 'NO_ESTIMATE_SYSTEM'
  | 'PARTIAL_WRITE'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_ERROR';

export interface StructuredToolError {
  /** Human-readable summary. Kept as `error` for backward compatibility. */
  error: string;
  code: WorkItemErrorCode;
  /** The offending input field, when one can be identified. */
  field?: string;
  /** ConqrPlan's own response payload or a list of per-field problems. */
  details?: unknown;
}

export function fail(
  code: WorkItemErrorCode,
  message: string,
  extra?: { field?: string; details?: unknown },
): StructuredToolError {
  return { error: message, code, ...extra };
}

/** Map a ConqrPlan transport failure onto a stable code plus its payload. */
export function planeError(err: unknown): StructuredToolError {
  if (err instanceof PlaneApiError) {
    const status = err.status;
    let code: WorkItemErrorCode = 'UPSTREAM_ERROR';
    if (status === 400) code = 'VALIDATION_FAILED';
    else if (status === 401 || status === 403) code = 'PERMISSION_DENIED';
    else if (status === 404) code = 'NOT_FOUND';
    else if (status === 409) code = 'CONFLICT';
    else if (status === 0 || status === 503) code = 'UPSTREAM_UNAVAILABLE';
    else if (status === 429 || status >= 500) code = 'UPSTREAM_UNAVAILABLE';

    const detailText = summariseDetails(err.details);
    return {
      error: detailText
        ? `ConqrPlan rejected the request (${status || 'network'}): ${detailText}`
        : `ConqrPlan request failed (${status || 'network'}): ${err.message}`,
      code,
      details: err.details,
    };
  }
  return {
    error: `ConqrPlan request failed: ${err instanceof Error ? err.message : String(err)}`,
    code: 'UPSTREAM_ERROR',
  };
}

/** Flatten a DRF error body into one readable line. */
function summariseDetails(details: unknown): string | null {
  if (!details) return null;
  if (typeof details === 'string') return details;
  if (Array.isArray(details)) {
    const parts = details.map((d) => summariseDetails(d)).filter(Boolean);
    return parts.length ? parts.join('; ') : null;
  }
  if (typeof details === 'object') {
    const obj = details as Record<string, unknown>;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.detail === 'string') return obj.detail;
    const parts: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      const rendered = summariseDetails(value);
      if (rendered) parts.push(key === 'non_field_errors' ? rendered : `${key}: ${rendered}`);
    }
    return parts.length ? parts.join('; ') : null;
  }
  return null;
}

// --------------------------------------------------------------------------
// Schema
// --------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateField = (label: string) =>
  z
    .string()
    .regex(ISO_DATE, `${label} must be an ISO calendar date (YYYY-MM-DD)`)
    .nullable()
    .optional();

export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;

/**
 * Every field ConqrPlan accepts on a work item, shared by create and update.
 *
 * `null` clears a field; omitting it leaves the field untouched. For the list
 * fields, `null` and `[]` both mean "remove all".
 */
export const workItemWritableFields = {
  description: z
    .string()
    .nullable()
    .optional()
    .describe('Plain text or HTML. null clears the description.'),
  priority: z
    .enum(PRIORITIES)
    .optional()
    .describe("One of urgent, high, medium, low, none. Use 'none' to clear."),
  stateId: z
    .string()
    .optional()
    .describe('Workflow state id from list_work_item_states. Must belong to the project.'),
  assigneeIds: z
    .array(z.string())
    .nullable()
    .optional()
    .describe(
      'Member ids from list_conqrplan_members. Replaces the current assignees. null or [] removes all. Members without project access are rejected rather than silently dropped.',
    ),
  labelIds: z
    .array(z.string())
    .nullable()
    .optional()
    .describe(
      'Label ids from list_work_item_labels. Replaces the current labels. null or [] removes all.',
    ),
  startDate: dateField('startDate'),
  targetDate: dateField('targetDate').describe(
    'Due date as YYYY-MM-DD. null clears it. Must not precede startDate.',
  ),
  parentId: z
    .string()
    .nullable()
    .optional()
    .describe('Parent work item id, making this a sub-item. null detaches it.'),
  typeId: z
    .string()
    .nullable()
    .optional()
    .describe('Work item type id. Must be enabled on the project. null restores the default type.'),
  estimatePointId: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Estimate point id from list_estimate_points. Requires an active estimation system on the project. null clears the estimate.',
    ),
  cycleId: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Cycle to place this item in. Applied as a separate membership call after the write. null removes it from its cycle.',
    ),
  moduleIds: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Modules to add this item to. Applied as separate membership calls after the write.'),
  externalId: z
    .string()
    .optional()
    .describe(
      "Idempotency key. Creating twice with the same externalId in a project is refused and the existing item is returned instead of a duplicate. Pair it with externalSource (defaults to 'conqrhub-mcp').",
    ),
  externalSource: z
    .string()
    .optional()
    .describe("Namespace for externalId. Defaults to 'conqrhub-mcp'."),
};

/** Default namespace for MCP-supplied idempotency keys. */
export const DEFAULT_EXTERNAL_SOURCE = 'conqrhub-mcp';

export type WorkItemFieldArgs = {
  description?: string | null;
  priority?: (typeof PRIORITIES)[number];
  stateId?: string;
  assigneeIds?: string[] | null;
  labelIds?: string[] | null;
  startDate?: string | null;
  targetDate?: string | null;
  parentId?: string | null;
  typeId?: string | null;
  estimatePointId?: string | null;
  cycleId?: string | null;
  moduleIds?: string[] | null;
  externalId?: string;
  externalSource?: string;
};

// --------------------------------------------------------------------------
// Payload building
// --------------------------------------------------------------------------

/** Wrap plain text so ConqrPlan's HTML parser accepts it. */
export function toDescriptionHtml(description: string): string {
  return description.trim().startsWith('<') ? description : `<p>${description}</p>`;
}

export interface BuiltWrite {
  /** Fields that go on the issue create/patch call itself. */
  payload: PlaneWorkItemWrite;
  /** Cycle membership, applied separately. `undefined` means untouched. */
  cycle?: { id: string | null };
  /** Module membership, applied separately. `undefined` means untouched. */
  modules?: { ids: string[] };
}

/**
 * Translate tool arguments into a ConqrPlan payload, honouring the
 * omitted / cleared / set distinction.
 */
export function buildWorkItemWrite(args: WorkItemFieldArgs & { name?: string }): BuiltWrite {
  const payload: PlaneWorkItemWrite = {};

  if (args.name !== undefined) payload.name = args.name;

  if (args.description !== undefined) {
    payload.description_html = args.description === null ? '' : toDescriptionHtml(args.description);
  }
  if (args.priority !== undefined) payload.priority = args.priority;
  if (args.stateId !== undefined) payload.state = args.stateId;
  if (args.assigneeIds !== undefined) payload.assignees = args.assigneeIds ?? [];
  if (args.labelIds !== undefined) payload.labels = args.labelIds ?? [];
  if (args.startDate !== undefined) payload.start_date = args.startDate;
  if (args.targetDate !== undefined) payload.target_date = args.targetDate;
  if (args.parentId !== undefined) payload.parent = args.parentId;
  if (args.typeId !== undefined) payload.type_id = args.typeId;
  if (args.estimatePointId !== undefined) payload.estimate_point = args.estimatePointId;
  if (args.externalId !== undefined) {
    payload.external_id = args.externalId;
    payload.external_source = args.externalSource ?? DEFAULT_EXTERNAL_SOURCE;
  }

  const built: BuiltWrite = { payload };
  if (args.cycleId !== undefined) built.cycle = { id: args.cycleId };
  if (args.moduleIds !== undefined) built.modules = { ids: args.moduleIds ?? [] };
  return built;
}

/** True when the caller asked for nothing at all. */
export function isEmptyWrite(built: BuiltWrite): boolean {
  return (
    Object.keys(built.payload).length === 0 &&
    built.cycle === undefined &&
    built.modules === undefined
  );
}

// --------------------------------------------------------------------------
// Pre-flight reference validation
// --------------------------------------------------------------------------

export interface ReferenceProblem {
  field: string;
  value: string;
  reason: string;
}

/**
 * Check ids against the project before writing.
 *
 * ConqrPlan validates states, parents, types and estimate points itself and
 * returns a useful 400, so those are left to it - it is the authority. What it
 * does *not* do is complain about unknown assignees or labels: it filters them
 * out and reports success. Those two are checked here so a caller is never told
 * a write succeeded when part of it was discarded.
 */
export async function validateAssigneesAndLabels(
  plane: PlaneClientService,
  projectId: string,
  args: { assigneeIds?: string[] | null; labelIds?: string[] | null },
): Promise<ReferenceProblem[]> {
  const problems: ReferenceProblem[] = [];

  const wantedAssignees = args.assigneeIds ?? [];
  const wantedLabels = args.labelIds ?? [];
  if (wantedAssignees.length === 0 && wantedLabels.length === 0) return problems;

  const [members, labels] = await Promise.all([
    wantedAssignees.length
      ? plane.listProjectMembers(projectId).catch(() => null)
      : Promise.resolve(null),
    wantedLabels.length ? plane.listLabels(projectId).catch(() => null) : Promise.resolve(null),
  ]);

  if (members) {
    const allowed = new Set(members.map((m) => String(m.id)));
    for (const id of wantedAssignees) {
      if (!allowed.has(String(id))) {
        problems.push({
          field: 'assigneeIds',
          value: id,
          reason:
            'not an active member of this project with permission to be assigned work. ConqrPlan would drop this id without reporting it.',
        });
      }
    }
  }

  if (labels) {
    const allowed = new Set(labels.map((l: any) => String(l.id)));
    for (const id of wantedLabels) {
      if (!allowed.has(String(id))) {
        problems.push({
          field: 'labelIds',
          value: id,
          reason: 'not a label of this project. ConqrPlan would drop this id without reporting it.',
        });
      }
    }
  }

  return problems;
}

/** Local date sanity so the caller gets a precise message, not a generic 400. */
export function validateDateRange(args: {
  startDate?: string | null;
  targetDate?: string | null;
}): ReferenceProblem | null {
  if (args.startDate && args.targetDate && args.startDate > args.targetDate) {
    return {
      field: 'targetDate',
      value: args.targetDate,
      reason: `must not precede startDate (${args.startDate})`,
    };
  }
  return null;
}

// --------------------------------------------------------------------------
// Normalised representation
// --------------------------------------------------------------------------

export interface NormalizedWorkItem {
  id: string;
  urn: string;
  projectId: string | null;
  name: string;
  sequenceId: number | null;
  description: string | null;
  /** Name when ConqrPlan expanded it, otherwise the id (unchanged contract). */
  state: string | null;
  stateId: string | null;
  stateName: string | null;
  priority: string | null;
  assigneeIds: string[];
  labelIds: string[];
  estimatePointId: string | null;
  startDate: string | null;
  targetDate: string | null;
  parentId: string | null;
  typeId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
}

/**
 * Full representation returned after every write.
 *
 * The previous summary dropped assignees and labels even though the payload
 * carried them, which made it impossible for a caller to confirm what actually
 * landed. Everything ConqrPlan returns is surfaced here.
 */
export function normalizeWorkItem(w: PlaneWorkItem, projectId?: string): NormalizedWorkItem {
  const anyItem = w as any;
  return {
    id: w.id,
    urn: buildUrn('plane', 'work-item', w.id),
    projectId: w.project ?? projectId ?? null,
    name: w.name,
    sequenceId: w.sequence_id ?? null,
    description: w.description_stripped ?? null,
    // `state` keeps its original meaning (name when expanded, else the raw id)
    // so existing callers are unaffected; the split fields are additive.
    state: w.state_detail?.name ?? (typeof w.state === 'string' ? w.state : null),
    stateId: typeof w.state === 'string' ? w.state : null,
    stateName: w.state_detail?.name ?? null,
    priority: w.priority ?? null,
    assigneeIds: (w.assignees ?? []).map(String),
    labelIds: (w.labels ?? []).map(String),
    estimatePointId: w.estimate_point ?? null,
    startDate: w.start_date ?? null,
    targetDate: w.target_date ?? null,
    parentId: w.parent ?? null,
    typeId: anyItem.type_id ?? anyItem.type ?? null,
    createdAt: anyItem.created_at ?? null,
    updatedAt: w.updated_at ?? null,
    completedAt: w.completed_at ?? null,
    archivedAt: w.archived_at ?? null,
  };
}

// --------------------------------------------------------------------------
// Post-write verification
// --------------------------------------------------------------------------

export interface DroppedField {
  field: string;
  requested: string[];
  applied: string[];
  missing: string[];
}

/**
 * Compare what was asked for against what ConqrPlan stored.
 *
 * The pre-flight catches ids we can know are bad. This catches anything else
 * the server discarded - a race with a membership change, or a filter rule we
 * do not model. Together they make "success" mean the write actually happened.
 */
export function detectDroppedFields(
  requested: WorkItemFieldArgs,
  applied: NormalizedWorkItem,
): DroppedField[] {
  const dropped: DroppedField[] = [];

  const compare = (field: string, want: string[] | null | undefined, got: string[]) => {
    if (want === undefined || want === null) return;
    const gotSet = new Set(got.map(String));
    const missing = want.map(String).filter((id) => !gotSet.has(id));
    if (missing.length) {
      dropped.push({ field, requested: want.map(String), applied: got.map(String), missing });
    }
  };

  compare('assigneeIds', requested.assigneeIds, applied.assigneeIds);
  compare('labelIds', requested.labelIds, applied.labelIds);
  return dropped;
}

// --------------------------------------------------------------------------
// Cycle / module membership
// --------------------------------------------------------------------------

export interface MembershipOutcome {
  applied: string[];
  failures: { target: string; reason: string }[];
}

/**
 * Apply cycle and module membership after the item exists.
 *
 * These are separate endpoints in ConqrPlan, so they cannot be part of the same
 * atomic write. A failure here is reported as a partial write rather than being
 * folded into the success path.
 */
export async function applyMembership(
  plane: PlaneClientService,
  projectId: string,
  workItemId: string,
  built: BuiltWrite,
  opts: PlaneCallContext & {
    /**
     * The cycle the item is in, when the caller already knows it. Omitted
     * entirely (not `null`) means "look it up" — `null` is a real answer
     * meaning the item is in no cycle.
     */
    currentCycleId?: string | null;
  },
): Promise<MembershipOutcome> {
  const outcome: MembershipOutcome = { applied: [], failures: [] };

  if (built.cycle !== undefined) {
    const target = built.cycle.id;
    try {
      if (target === null) {
        // Removal needs the cycle the item is in, and ConqrPlan's work-item
        // payload does not carry it. Resolve it rather than skipping the
        // request: quietly doing nothing here would report a clear as applied.
        const current =
          opts.currentCycleId !== undefined
            ? opts.currentCycleId
            : await plane.findWorkItemCycle(projectId, workItemId);

        if (current === undefined) {
          // The scan could not finish, so we cannot say the item is in no
          // cycle. Reported as a failure, never as a successful clear.
          outcome.failures.push({
            target: 'cycleId:cleared',
            reason:
              'could not determine which cycle this item belongs to (the project has more cycles than the lookup scans). Remove it from its cycle in ConqrPlan, or pass the cycle explicitly.',
          });
        } else if (current === null) {
          // Already in no cycle: the requested state, so this is applied.
          outcome.applied.push('cycleId:cleared');
        } else {
          await plane.removeWorkItemFromCycle(projectId, current, workItemId, ctxOf(opts));
          outcome.applied.push('cycleId:cleared');
        }
      } else {
        await plane.addWorkItemsToCycle(projectId, target, [workItemId], ctxOf(opts));
        outcome.applied.push(`cycleId:${target}`);
      }
    } catch (err) {
      outcome.failures.push({
        target: `cycleId:${target ?? 'cleared'}`,
        reason: planeError(err).error,
      });
    }
  }

  if (built.modules !== undefined) {
    for (const moduleId of built.modules.ids) {
      try {
        await plane.addWorkItemsToModule(projectId, moduleId, [workItemId], ctxOf(opts));
        outcome.applied.push(`moduleId:${moduleId}`);
      } catch (err) {
        outcome.failures.push({
          target: `moduleId:${moduleId}`,
          reason: planeError(err).error,
        });
      }
    }
  }

  return outcome;
}

// --------------------------------------------------------------------------
// Write orchestration
// --------------------------------------------------------------------------

export type WriteMode =
  | { kind: 'create'; name: string }
  | { kind: 'update'; workItemId: string };

export type WriteResult =
  | (NormalizedWorkItem & {
      membership?: MembershipOutcome;
      /** Present only when part of the request did not land. */
      error?: string;
      code?: WorkItemErrorCode;
      details?: unknown;
    })
  | StructuredToolError;

/**
 * Run one complete work-item write: pre-flight, field write, membership, then
 * verification of what actually landed.
 *
 * Returns the normalised item at the top level so existing callers that read
 * `id`, `name`, `state`, `priority` or `sequenceId` keep working - the shape is
 * a superset of the previous summary. A partial failure still returns the item
 * (the caller needs its id) but carries `error` and `code: 'PARTIAL_WRITE'` so
 * it can never be mistaken for a clean success.
 */
export async function writeWorkItem(
  plane: PlaneClientService,
  projectId: string,
  mode: WriteMode,
  args: WorkItemFieldArgs,
  opts: PlaneCallContext = {},
): Promise<WriteResult> {
  // ---- local validation, for precise messages ----
  const dateProblem = validateDateRange(args);
  if (dateProblem) {
    return fail('VALIDATION_FAILED', `targetDate ${dateProblem.reason}.`, {
      field: 'targetDate',
      details: [dateProblem],
    });
  }

  // ---- pre-flight the two fields ConqrPlan drops silently ----
  let problems: ReferenceProblem[] = [];
  try {
    problems = await validateAssigneesAndLabels(plane, projectId, args);
  } catch (err) {
    return planeError(err);
  }
  if (problems.length) {
    const summary = problems.map((p) => `${p.field} ${p.value}: ${p.reason}`).join(' ');
    return fail('INVALID_REFERENCE', `Rejected before writing. ${summary}`, {
      field: problems[0].field,
      details: problems,
    });
  }

  const built = buildWorkItemWrite(
    mode.kind === 'create' ? { ...args, name: mode.name } : args,
  );

  if (mode.kind === 'update' && isEmptyWrite(built)) {
    return fail(
      'VALIDATION_FAILED',
      'Nothing to update. Pass at least one field to change.',
    );
  }

  // ---- the write itself ----
  let written: PlaneWorkItem;
  try {
    written =
      mode.kind === 'create'
        ? await plane.createWorkItem(
            projectId,
            { ...built.payload, name: mode.name },
            ctxOf(opts),
          )
        : await plane.updateWorkItem(projectId, mode.workItemId, built.payload, ctxOf(opts));
  } catch (err) {
    // ConqrPlan's own idempotency: a repeated externalId in the same project is
    // refused with 409 and the id of the item that already exists. Surface that
    // as a duplicate outcome carrying the existing id, so a retried batch
    // converges instead of creating a second copy.
    if (
      mode.kind === 'create' &&
      err instanceof PlaneApiError &&
      err.status === 409 &&
      args.externalId
    ) {
      const existingId = (err.details as any)?.id;
      return fail(
        'CONFLICT',
        `A work item with externalId '${args.externalId}' already exists in this project. Nothing was created.`,
        { field: 'externalId', details: { existingWorkItemId: existingId ?? null } },
      );
    }
    return planeError(err);
  }

  // ---- cycle / module membership (separate endpoints) ----
  let membership: MembershipOutcome | undefined;
  if (built.cycle !== undefined || built.modules !== undefined) {
    membership = await applyMembership(plane, projectId, written.id, built, { ...opts });
  }

  // ---- verify what landed ----
  let normalized = normalizeWorkItem(written, projectId);

  // A create response does not always echo the m2m sets; re-read so the caller
  // sees the stored truth rather than the request echoed back.
  if (mode.kind === 'create' && (args.assigneeIds?.length || args.labelIds?.length)) {
    try {
      normalized = normalizeWorkItem(await plane.getWorkItem(projectId, written.id), projectId);
    } catch {
      /* keep the create response; the drop check below still runs on it */
    }
  }

  const dropped = detectDroppedFields(args, normalized);
  const membershipFailed = membership?.failures.length ? membership.failures : null;

  if (dropped.length || membershipFailed) {
    const parts: string[] = [];
    for (const d of dropped) {
      parts.push(`${d.field} not stored: ${d.missing.join(', ')}`);
    }
    for (const f of membershipFailed ?? []) {
      parts.push(`${f.target} failed: ${f.reason}`);
    }
    return {
      ...normalized,
      ...(membership ? { membership } : {}),
      error: `Work item ${mode.kind === 'create' ? 'created' : 'updated'}, but part of the request did not apply. ${parts.join(' ')}`,
      code: 'PARTIAL_WRITE',
      details: { droppedFields: dropped, membershipFailures: membershipFailed ?? [] },
    };
  }

  return { ...normalized, ...(membership ? { membership } : {}) };
}
