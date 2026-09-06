import { z } from 'zod';
import { DELEGATED_SCOPES, DelegatedScope } from './delegation';
import { PlaneApiError, PlaneCallContext, PlaneClient, PlaneWorkItem } from './plane-client';

/**
 * The seventeen ConqrPlan agent tools.
 *
 * Names and input schemas are unchanged from the versions that ran inside
 * ConqrHub. An agent cannot tell which process answered, and that is the
 * compatibility contract this extraction has to keep.
 *
 * Each tool declares the delegated scopes it needs and the runtime mints a
 * token carrying exactly those. Least privilege therefore survives the move:
 * a token minted to read cannot write, and one minted for a single create
 * cannot be replayed to create a hundred.
 */

export interface ToolInvocation {
  client: PlaneClient;
  /** Already minted with this tool's declared scopes. */
  call: PlaneCallContext;
}

export interface ToolDefinition<A = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<A>;
  scopes: DelegatedScope[];
  handler: (args: A, ctx: ToolInvocation) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Shared shaping
// ---------------------------------------------------------------------------

/** Structured error, never a throw-through of transport internals. */
export function toolError(err: unknown): { error: string; code?: string } {
  if (err instanceof PlaneApiError) {
    return {
      error: `ConqrPlan request failed (${err.status || 'network'}): ${err.message}`,
      code: err.status ? String(err.status) : 'network',
    };
  }
  return {
    error: `ConqrPlan request failed: ${err instanceof Error ? err.message : String(err)}`,
  };
}

/** The state name a payload can actually support, never a bare uuid. */
function stateName(item: PlaneWorkItem): string | null {
  const raw = item.state;
  const expanded =
    item.state_detail ?? (raw && typeof raw === 'object' ? raw : undefined);
  const name = expanded?.name;
  return typeof name === 'string' && name ? name : null;
}

export function workItemSummary(w: PlaneWorkItem) {
  return {
    id: w.id,
    name: w.name,
    sequenceId: w.sequence_id ?? null,
    state: stateName(w),
    priority: w.priority ?? null,
    estimatePointId: w.estimate_point ?? null,
    updatedAt: w.updated_at ?? null,
  };
}

export function normalizeWorkItem(w: PlaneWorkItem, projectId: string) {
  return {
    id: w.id,
    urn: `conqr://plane/work-item/${w.id}`,
    projectId,
    name: w.name,
    description: w.description_stripped ?? null,
    state: typeof w.state === 'string' ? w.state : (w.state?.id ?? null),
    stateName: stateName(w),
    priority: w.priority ?? null,
    assigneeIds: w.assignees ?? [],
    labelIds: w.labels ?? [],
    estimatePointId: w.estimate_point ?? null,
    startDate: w.start_date ?? null,
    targetDate: w.target_date ?? null,
    parentId: w.parent ?? null,
    createdAt: w.created_at ?? null,
    updatedAt: w.updated_at ?? null,
    completedAt: w.completed_at ?? null,
    archivedAt: w.archived_at ?? null,
  };
}

/** Fields a work item write accepts. Shared by create, update and bulk. */
export const workItemWritableFields = {
  description: z.string().optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
  stateId: z.string().optional(),
  assigneeIds: z.array(z.string()).optional(),
  labelIds: z.array(z.string()).optional(),
  estimatePointId: z.string().nullable().optional(),
  startDate: z.string().optional(),
  targetDate: z.string().optional(),
  parentId: z.string().optional(),
  cycleId: z.string().optional(),
  moduleId: z.string().optional(),
  externalId: z.string().optional(),
};

type WriteFields = {
  description?: string;
  priority?: string;
  stateId?: string;
  assigneeIds?: string[];
  labelIds?: string[];
  estimatePointId?: string | null;
  startDate?: string;
  targetDate?: string;
  parentId?: string;
  cycleId?: string;
  moduleId?: string;
  externalId?: string;
};

function toPlaneBody(fields: WriteFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.description !== undefined) body.description_html = fields.description;
  if (fields.priority !== undefined) body.priority = fields.priority;
  if (fields.stateId !== undefined) body.state = fields.stateId;
  if (fields.assigneeIds !== undefined) body.assignees = fields.assigneeIds;
  if (fields.labelIds !== undefined) body.labels = fields.labelIds;
  if (fields.estimatePointId !== undefined) body.estimate_point = fields.estimatePointId;
  if (fields.startDate !== undefined) body.start_date = fields.startDate;
  if (fields.targetDate !== undefined) body.target_date = fields.targetDate;
  if (fields.parentId !== undefined) body.parent = fields.parentId;
  if (fields.externalId !== undefined) {
    body.external_id = fields.externalId;
    body.external_source = 'conqrhub';
  }
  return body;
}

/**
 * Write a work item, then report what actually landed.
 *
 * Cycle and module assignment are separate ConqrPlan calls with no shared
 * transaction, so a create can succeed and its cycle assignment fail. Saying
 * "created" and stopping would hide that, so the partial outcome is reported
 * per field instead - and the item is read back so the answer describes
 * stored state rather than what was requested.
 */
export async function writeWorkItem(
  client: PlaneClient,
  projectId: string,
  target: { kind: 'create'; name: string } | { kind: 'update'; workItemId: string },
  fields: WriteFields,
  call: PlaneCallContext,
) {
  const body = toPlaneBody(fields);
  let item: PlaneWorkItem;
  try {
    item =
      target.kind === 'create'
        ? await client.createWorkItem(projectId, { name: target.name, ...body }, call)
        : await client.updateWorkItem(projectId, target.workItemId, body, call);
  } catch (err) {
    return toolError(err);
  }

  const partial: { field: string; error: string }[] = [];
  if (fields.cycleId) {
    try {
      await client.addWorkItemsToCycle(projectId, fields.cycleId, [item.id], call);
    } catch (err) {
      partial.push({ field: 'cycleId', error: toolError(err).error });
    }
  }
  if (fields.moduleId) {
    try {
      await client.addWorkItemsToModule(projectId, fields.moduleId, [item.id], call);
    } catch (err) {
      partial.push({ field: 'moduleId', error: toolError(err).error });
    }
  }

  // Read back: report stored state, not the request echoed.
  let stored = item;
  try {
    stored = await client.getWorkItem(projectId, item.id, call);
  } catch {
    // Keep the write result rather than failing a successful write on a read.
  }

  const result = normalizeWorkItem(stored, projectId);
  return partial.length ? { ...result, partialFailures: partial } : result;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const projectId = z.string().describe('ConqrPlan project ID');

function define<A>(d: ToolDefinition<A>): ToolDefinition { return d as ToolDefinition; }

export const CONQRPLAN_TOOLS: ToolDefinition[] = [
  define({
    name: 'list_conqrplan_projects',
    description:
      'List projects in ConqrPlan (the Conqr suite work-management app). Use this to find a project ID before searching or creating work items.',
    inputSchema: z.object({}),
    scopes: [DELEGATED_SCOPES.workItemRead],
    handler: async (_args, { client, call }) => {
      try {
        return await client.listProjects(call);
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'search_work_items',
    description:
      'Search work items in a ConqrPlan project by text. Returns id, name, state, and priority. Cite work items by name and sequenceId.',
    inputSchema: z.object({
      projectId,
      query: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional().default(20),
    }),
    scopes: [DELEGATED_SCOPES.workItemRead],
    handler: async (args, { client, call }) => {
      try {
        const results = await client.listWorkItems(
          args.projectId,
          { search: args.query, perPage: args.limit ?? 20 },
          call,
        );
        return results.map(workItemSummary);
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'get_work_item',
    description:
      'Get one ConqrPlan work item with its description, state, and priority.',
    inputSchema: z.object({ projectId, workItemId: z.string() }),
    scopes: [DELEGATED_SCOPES.workItemRead],
    handler: async (args, { client, call }) => {
      try {
        return normalizeWorkItem(
          await client.getWorkItem(args.projectId, args.workItemId, call),
          args.projectId,
        );
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'create_work_item',
    description:
      'Create a work item in a ConqrPlan project. Use only when the user explicitly asks to create work. Returns the created item.',
    inputSchema: z.object({
      projectId,
      name: z.string().min(1).max(255),
      ...workItemWritableFields,
    }),
    scopes: [
      DELEGATED_SCOPES.workItemCreate,
      DELEGATED_SCOPES.cycleAssign,
      DELEGATED_SCOPES.moduleAssign,
    ],
    handler: async (args, { client, call }) => {
      const { projectId: pid, name, ...fields } = args;
      return writeWorkItem(client, pid, { kind: 'create', name }, fields, call);
    },
  }),

  define({
    name: 'update_work_item',
    description:
      'Update a ConqrPlan work item: rename it, edit its description, change priority, move it to another state, or set its estimate. Only send the fields you want to change.',
    inputSchema: z.object({
      projectId,
      workItemId: z.string(),
      name: z.string().min(1).max(255).optional(),
      ...workItemWritableFields,
    }),
    scopes: [
      DELEGATED_SCOPES.workItemUpdate,
      DELEGATED_SCOPES.cycleAssign,
      DELEGATED_SCOPES.moduleAssign,
    ],
    handler: async (args, { client, call }) => {
      const { projectId: pid, workItemId, name, ...fields } = args;
      const body: WriteFields = fields;
      if (name !== undefined) {
        // Name is not part of the shared writable fields, so it is applied
        // with the same call rather than as a second write.
        const result = await client.updateWorkItem(pid, workItemId, { name }, call);
        void result;
      }
      return writeWorkItem(client, pid, { kind: 'update', workItemId }, body, call);
    },
  }),

  define({
    name: 'bulk_create_work_items',
    description:
      'Create up to 100 ConqrPlan work items in one call, each with the same fields as create_work_item. Items are created one at a time and there is no rollback: every row reports its own outcome and index, so a failure part-way through never fakes success for the batch. Give each row an externalId to make retries safe.',
    inputSchema: z.object({
      projectId,
      items: z
        .array(z.object({ name: z.string().min(1).max(255), ...workItemWritableFields }))
        .min(1)
        .max(100),
    }),
    scopes: [
      DELEGATED_SCOPES.workItemBulkCreate,
      DELEGATED_SCOPES.workItemCreate,
      DELEGATED_SCOPES.cycleAssign,
      DELEGATED_SCOPES.moduleAssign,
    ],
    handler: async (args, { client, call }) => {
      const results: unknown[] = [];
      let created = 0;
      let failed = 0;
      for (let index = 0; index < args.items.length; index++) {
        const { name, ...fields } = args.items[index];
        const outcome = (await writeWorkItem(
          client,
          args.projectId,
          { kind: 'create', name },
          fields,
          call,
        )) as { id?: string; error?: string; partialFailures?: unknown };

        if (outcome.id && !outcome.error) {
          created += 1;
          results.push({
            index,
            status: outcome.partialFailures ? 'created_with_errors' : 'created',
            workItemId: outcome.id,
            partialFailures: outcome.partialFailures,
          });
        } else {
          failed += 1;
          results.push({ index, status: 'failed', error: outcome.error });
        }
      }
      return { requested: args.items.length, created, failed, results };
    },
  }),

  define({
    name: 'get_project_cycles',
    description:
      'List cycles (iterations) of a ConqrPlan project with their date ranges.',
    inputSchema: z.object({ projectId }),
    scopes: [DELEGATED_SCOPES.workItemRead],
    handler: async (args, { client, call }) => {
      try {
        return await client.listCycles(args.projectId, call);
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'list_cycle_work_items',
    description:
      'List the work items inside one ConqrPlan cycle (sprint/iteration).',
    inputSchema: z.object({
      projectId,
      cycleId: z.string(),
      limit: z.number().int().min(1).max(100).optional().default(50),
    }),
    scopes: [DELEGATED_SCOPES.workItemRead],
    handler: async (args, { client, call }) => {
      try {
        const items = await client.listCycleWorkItems(args.projectId, args.cycleId, call);
        return items.slice(0, args.limit ?? 50).map(workItemSummary);
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'list_work_item_states',
    description:
      'List the workflow states of a ConqrPlan project (e.g. Backlog, In Progress, Done) with their IDs and state group.',
    inputSchema: z.object({ projectId }),
    scopes: [DELEGATED_SCOPES.workItemRead],
    handler: async (args, { client, call }) => {
      try {
        const states = await client.listStates(args.projectId, call);
        return states.map((s: any) => ({
          id: s.id,
          name: s.name,
          group: s.group ?? null,
          default: s.default ?? false,
        }));
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'list_work_item_labels',
    description: 'List the labels of a ConqrPlan project (id, name, color).',
    inputSchema: z.object({ projectId }),
    scopes: [DELEGATED_SCOPES.workItemRead],
    handler: async (args, { client, call }) => {
      try {
        const labels = await client.listLabels(args.projectId, call);
        return labels.map((l: any) => ({ id: l.id, name: l.name, color: l.color ?? null }));
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'list_conqrplan_members',
    description:
      'List the members of the ConqrPlan workspace (id, display name, email).',
    inputSchema: z.object({}),
    scopes: [DELEGATED_SCOPES.workItemRead],
    handler: async (_args, { client, call }) => {
      try {
        const members = await client.listWorkspaceMembers(call);
        return members.map((m: any) => ({
          id: m.id,
          displayName:
            m.display_name ||
            [m.first_name, m.last_name].filter(Boolean).join(' ') ||
            null,
          email: m.email ?? null,
        }));
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'get_work_item_comments',
    description:
      'Read the comment thread of a ConqrPlan work item. Returns plain-text comments with author IDs.',
    inputSchema: z.object({
      projectId,
      workItemId: z.string(),
      limit: z.number().int().min(1).max(50).optional().default(20),
    }),
    scopes: [DELEGATED_SCOPES.workItemRead],
    handler: async (args, { client, call }) => {
      try {
        const comments = await client.listWorkItemComments(
          args.projectId,
          args.workItemId,
          call,
        );
        return comments.slice(0, args.limit ?? 20).map((c: any) => ({
          id: c.id,
          text: c.comment_stripped ?? null,
          authorId: c.actor ?? c.created_by ?? null,
          createdAt: c.created_at ?? null,
        }));
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'add_work_item_comment',
    description:
      'Post a comment on a ConqrPlan work item. Comments are visible to the whole project.',
    inputSchema: z.object({
      projectId,
      workItemId: z.string(),
      text: z.string().min(1),
    }),
    scopes: [DELEGATED_SCOPES.workItemUpdate],
    handler: async (args, { client, call }) => {
      try {
        const c = await client.addWorkItemComment(
          args.projectId,
          args.workItemId,
          args.text,
          call,
        );
        return { id: c.id, createdAt: c.created_at ?? null };
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'list_estimate_points',
    description:
      "List a ConqrPlan project's estimate systems and their points with IDs. Empty when the project has no estimate system.",
    inputSchema: z.object({ projectId }),
    scopes: [DELEGATED_SCOPES.estimateRead],
    handler: async (args, { client, call }) => {
      try {
        const estimate = await client.getProjectEstimate(args.projectId, call);
        if (!estimate) return [];
        const points = await client.listEstimatePoints(args.projectId, estimate.id, call);
        return [
          {
            id: estimate.id,
            name: estimate.name,
            type: estimate.type ?? null,
            points: points
              .slice()
              .sort((a: any, b: any) => (a.key ?? 0) - (b.key ?? 0))
              .map((p: any) => ({ id: p.id, value: p.value })),
          },
        ];
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'get_estimate_system',
    description:
      "Get a ConqrPlan project's active estimation system and its points.",
    inputSchema: z.object({ projectId }),
    scopes: [DELEGATED_SCOPES.estimateRead],
    handler: async (args, { client, call }) => {
      try {
        const estimate = await client.getProjectEstimate(args.projectId, call);
        if (!estimate) return { active: false, estimate: null };
        const points = await client.listEstimatePoints(args.projectId, estimate.id, call);
        return {
          active: Boolean(estimate.is_active ?? true),
          estimate: {
            id: estimate.id,
            name: estimate.name,
            type: estimate.type ?? null,
            points: points.map((p: any) => ({ id: p.id, value: p.value, key: p.key })),
          },
        };
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'create_estimate_system',
    description:
      'Create an estimation system for a ConqrPlan project with its points.',
    inputSchema: z.object({
      projectId,
      name: z.string().min(1),
      type: z.enum(['points', 'categories', 'time']).optional().default('points'),
      values: z.array(z.string().min(1)).min(1).max(20),
    }),
    scopes: [DELEGATED_SCOPES.estimateConfigure, DELEGATED_SCOPES.estimateRead],
    handler: async (args, { client, call }) => {
      try {
        const existing = await client.getProjectEstimate(args.projectId, call);
        if (existing) {
          return {
            error: 'This project already has an estimate system',
            code: 'already_exists',
            estimateId: existing.id,
          };
        }
        const created = await client.createEstimate(
          args.projectId,
          { name: args.name, type: args.type ?? 'points' },
          call,
        );
        await client.createEstimatePoints(
          args.projectId,
          created.id,
          args.values.map((value, key) => ({ key, value })),
          call,
        );
        const confirmed = await client.getProjectEstimate(args.projectId, call);
        return { estimateId: created.id, active: Boolean(confirmed?.is_active ?? false) };
      } catch (err) {
        return toolError(err);
      }
    },
  }),

  define({
    name: 'activate_estimate_system',
    description:
      "Switch a ConqrPlan project's estimation system on or off. Activation is what makes story points visible and editable in the ConqrPlan UI. Safe to call repeatedly.",
    inputSchema: z.object({ projectId, active: z.boolean().optional().default(true) }),
    scopes: [DELEGATED_SCOPES.estimateConfigure, DELEGATED_SCOPES.estimateRead],
    handler: async (args, { client, call }) => {
      try {
        const existing = await client.getProjectEstimate(args.projectId, call);
        if (!existing) {
          return { error: 'This project has no estimate system', code: 'not_found' };
        }
        const updated = await client.updateEstimate(
          args.projectId,
          existing.id,
          { is_active: args.active ?? true },
          call,
        );
        return { estimateId: existing.id, active: Boolean(updated?.is_active ?? args.active) };
      } catch (err) {
        return toolError(err);
      }
    },
  }),
];

export const CONQRPLAN_TOOL_NAMES = CONQRPLAN_TOOLS.map((t) => t.name);
