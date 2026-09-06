/**
 * ConqrPlan REST adapter, framework-free.
 *
 * Two things differ from the version this was lifted from, and both are the
 * point of the extraction.
 *
 * The workspace slug now arrives on the call, not from a module-wide
 * environment variable. A single global slug is only correct while there is
 * exactly one tenant, and it silently routes every caller into that tenant.
 *
 * The delegation is required on the context type rather than optional. Hub's
 * version made it optional and sixteen call sites quietly omitted it, which
 * meant ConqrPlan answered as the API key's owner. Making it non-optional
 * moves that class of mistake to compile time.
 */
export declare class PlaneApiError extends Error {
    readonly status: number;
    readonly retryable: boolean;
    readonly details?: unknown | undefined;
    constructor(message: string, status: number, retryable: boolean, details?: unknown | undefined);
}
/** Who is calling, and on whose behalf. Both are required. */
export interface PlaneCallContext {
    /** Signed on-behalf-of token naming the human actor. */
    delegation: string;
    /** Correlates this call across both products' audit trails. */
    correlationId: string;
    /** The tenant's ConqrPlan workspace. Never a global default. */
    workspaceSlug: string;
}
export interface PlaneWorkItem {
    id: string;
    name: string;
    sequence_id?: number | null;
    project?: string;
    state?: string | {
        id?: string;
        name?: string;
        group?: string;
    } | null;
    state_detail?: {
        name?: string;
        group?: string;
    } | null;
    priority?: string | null;
    assignees?: string[];
    labels?: string[];
    estimate_point?: string | null;
    start_date?: string | null;
    target_date?: string | null;
    parent?: string | null;
    description_stripped?: string | null;
    completed_at?: string | null;
    archived_at?: string | null;
    updated_at?: string;
    created_at?: string;
}
export interface PlaneClientOptions {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    /** Bounded in-flight requests, shared across callers. */
    maxConcurrency: number;
    fetchImpl?: typeof fetch;
}
export declare class PlaneClient {
    private readonly opts;
    private readonly semaphore;
    private readonly fetchImpl;
    constructor(opts: PlaneClientOptions);
    private request;
    private list;
    private base;
    listProjects(ctx: PlaneCallContext): Promise<{
        id: string;
        name: string;
        identifier: string | undefined;
    }[]>;
    listWorkspaceMembers(ctx: PlaneCallContext): Promise<any[]>;
    listWorkItems(projectId: string, opts: {
        search?: string;
        perPage?: number;
    }, ctx: PlaneCallContext): Promise<PlaneWorkItem[]>;
    getWorkItem(projectId: string, workItemId: string, ctx: PlaneCallContext): Promise<PlaneWorkItem>;
    createWorkItem(projectId: string, body: Record<string, unknown>, ctx: PlaneCallContext): Promise<PlaneWorkItem>;
    updateWorkItem(projectId: string, workItemId: string, body: Record<string, unknown>, ctx: PlaneCallContext): Promise<PlaneWorkItem>;
    listStates(projectId: string, ctx: PlaneCallContext): Promise<any[]>;
    listLabels(projectId: string, ctx: PlaneCallContext): Promise<any[]>;
    listCycles(projectId: string, ctx: PlaneCallContext): Promise<{
        id: string;
        name: string;
        start_date: any;
        end_date: any;
    }[]>;
    listCycleWorkItems(projectId: string, cycleId: string, ctx: PlaneCallContext): Promise<any[]>;
    addWorkItemsToCycle(projectId: string, cycleId: string, workItemIds: string[], ctx: PlaneCallContext): Promise<unknown>;
    addWorkItemsToModule(projectId: string, moduleId: string, workItemIds: string[], ctx: PlaneCallContext): Promise<unknown>;
    listWorkItemComments(projectId: string, workItemId: string, ctx: PlaneCallContext): Promise<any[]>;
    addWorkItemComment(projectId: string, workItemId: string, commentHtml: string, ctx: PlaneCallContext): Promise<any>;
    getProjectEstimate(projectId: string, ctx: PlaneCallContext): Promise<any>;
    listEstimatePoints(projectId: string, estimateId: string, ctx: PlaneCallContext): Promise<any[]>;
    createEstimate(projectId: string, body: Record<string, unknown>, ctx: PlaneCallContext): Promise<any>;
    updateEstimate(projectId: string, estimateId: string, body: Record<string, unknown>, ctx: PlaneCallContext): Promise<any>;
    createEstimatePoints(projectId: string, estimateId: string, points: unknown[], ctx: PlaneCallContext): Promise<any>;
}
//# sourceMappingURL=plane-client.d.ts.map