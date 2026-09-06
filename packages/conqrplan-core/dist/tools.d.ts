import { z } from 'zod';
import { DelegatedScope } from './delegation';
import { PlaneCallContext, PlaneClient, PlaneWorkItem } from './plane-client';
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
/** Structured error, never a throw-through of transport internals. */
export declare function toolError(err: unknown): {
    error: string;
    code?: string;
};
export declare function workItemSummary(w: PlaneWorkItem): {
    id: string;
    name: string;
    sequenceId: number | null;
    state: string | null;
    priority: string | null;
    estimatePointId: string | null;
    updatedAt: string | null;
};
export declare function normalizeWorkItem(w: PlaneWorkItem, projectId: string): {
    id: string;
    urn: string;
    projectId: string;
    name: string;
    description: string | null;
    state: string | null;
    stateName: string | null;
    priority: string | null;
    assigneeIds: string[];
    labelIds: string[];
    estimatePointId: string | null;
    startDate: string | null;
    targetDate: string | null;
    parentId: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    completedAt: string | null;
    archivedAt: string | null;
};
/** Fields a work item write accepts. Shared by create, update and bulk. */
export declare const workItemWritableFields: {
    description: z.ZodOptional<z.ZodString>;
    priority: z.ZodOptional<z.ZodEnum<{
        urgent: "urgent";
        high: "high";
        medium: "medium";
        low: "low";
        none: "none";
    }>>;
    stateId: z.ZodOptional<z.ZodString>;
    assigneeIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    labelIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    estimatePointId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    startDate: z.ZodOptional<z.ZodString>;
    targetDate: z.ZodOptional<z.ZodString>;
    parentId: z.ZodOptional<z.ZodString>;
    cycleId: z.ZodOptional<z.ZodString>;
    moduleId: z.ZodOptional<z.ZodString>;
    externalId: z.ZodOptional<z.ZodString>;
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
/**
 * Write a work item, then report what actually landed.
 *
 * Cycle and module assignment are separate ConqrPlan calls with no shared
 * transaction, so a create can succeed and its cycle assignment fail. Saying
 * "created" and stopping would hide that, so the partial outcome is reported
 * per field instead - and the item is read back so the answer describes
 * stored state rather than what was requested.
 */
export declare function writeWorkItem(client: PlaneClient, projectId: string, target: {
    kind: 'create';
    name: string;
} | {
    kind: 'update';
    workItemId: string;
}, fields: WriteFields, call: PlaneCallContext): Promise<{
    error: string;
    code?: string;
} | {
    id: string;
    urn: string;
    projectId: string;
    name: string;
    description: string | null;
    state: string | null;
    stateName: string | null;
    priority: string | null;
    assigneeIds: string[];
    labelIds: string[];
    estimatePointId: string | null;
    startDate: string | null;
    targetDate: string | null;
    parentId: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    completedAt: string | null;
    archivedAt: string | null;
} | {
    partialFailures: {
        field: string;
        error: string;
    }[];
    id: string;
    urn: string;
    projectId: string;
    name: string;
    description: string | null;
    state: string | null;
    stateName: string | null;
    priority: string | null;
    assigneeIds: string[];
    labelIds: string[];
    estimatePointId: string | null;
    startDate: string | null;
    targetDate: string | null;
    parentId: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    completedAt: string | null;
    archivedAt: string | null;
}>;
export declare const CONQRPLAN_TOOLS: ToolDefinition[];
export declare const CONQRPLAN_TOOL_NAMES: string[];
export {};
//# sourceMappingURL=tools.d.ts.map