"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlaneClient = exports.PlaneApiError = void 0;
class PlaneApiError extends Error {
    status;
    retryable;
    details;
    constructor(message, status, retryable, details) {
        super(message);
        this.status = status;
        this.retryable = retryable;
        this.details = details;
        this.name = 'PlaneApiError';
    }
}
exports.PlaneApiError = PlaneApiError;
/** Minimal counting semaphore: bounded concurrency without a dependency. */
class Semaphore {
    limit;
    active = 0;
    queue = [];
    constructor(limit) {
        this.limit = limit;
    }
    async run(fn) {
        if (this.active >= this.limit) {
            await new Promise((resolve) => this.queue.push(resolve));
        }
        this.active += 1;
        try {
            return await fn();
        }
        finally {
            this.active -= 1;
            this.queue.shift()?.();
        }
    }
}
class PlaneClient {
    opts;
    semaphore;
    fetchImpl;
    constructor(opts) {
        this.opts = opts;
        this.semaphore = new Semaphore(opts.maxConcurrency);
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }
    async request(path, ctx, init = {}) {
        const url = `${this.opts.baseUrl.replace(/\/$/, '')}${path}`;
        return this.semaphore.run(async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
            try {
                const res = await this.fetchImpl(url, {
                    method: init.method ?? 'GET',
                    signal: controller.signal,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Api-Key': this.opts.apiKey,
                        'X-Conqr-Delegation': ctx.delegation,
                        'X-Conqr-Correlation-Id': ctx.correlationId,
                    },
                    body: init.body === undefined ? undefined : JSON.stringify(init.body),
                });
                if (!res.ok) {
                    let details;
                    const text = await res.text().catch(() => '');
                    try {
                        details = text ? JSON.parse(text) : undefined;
                    }
                    catch {
                        details = text || undefined;
                    }
                    throw new PlaneApiError(`ConqrPlan ${res.status} for ${path}`, res.status, res.status === 429 || res.status >= 500, details);
                }
                if (res.status === 204)
                    return undefined;
                const text = await res.text();
                return (text ? JSON.parse(text) : undefined);
            }
            catch (err) {
                if (err instanceof PlaneApiError)
                    throw err;
                const aborted = err?.name === 'AbortError';
                throw new PlaneApiError(aborted
                    ? `ConqrPlan request timed out after ${this.opts.timeoutMs}ms`
                    : `ConqrPlan request failed: ${err.message}`, 0, true);
            }
            finally {
                clearTimeout(timer);
            }
        });
    }
    list(res) {
        if (!res)
            return [];
        return Array.isArray(res) ? res : (res.results ?? []);
    }
    base(ctx) {
        return `/workspaces/${ctx.workspaceSlug}`;
    }
    // -- projects, members ----------------------------------------------------
    async listProjects(ctx) {
        const res = await this.request(`${this.base(ctx)}/projects/`, ctx);
        return this.list(res).map((p) => ({
            id: String(p.id),
            name: p.name,
            identifier: p.identifier,
        }));
    }
    async listWorkspaceMembers(ctx) {
        const res = await this.request(`${this.base(ctx)}/members/`, ctx);
        return this.list(res);
    }
    // -- work items -----------------------------------------------------------
    async listWorkItems(projectId, opts, ctx) {
        const params = new URLSearchParams();
        if (opts.search)
            params.set('search', opts.search);
        if (opts.perPage)
            params.set('per_page', String(opts.perPage));
        const qs = params.toString() ? `?${params.toString()}` : '';
        const res = await this.request(`${this.base(ctx)}/projects/${projectId}/issues/${qs}`, ctx);
        return this.list(res);
    }
    async getWorkItem(projectId, workItemId, ctx) {
        return this.request(`${this.base(ctx)}/projects/${projectId}/issues/${workItemId}/`, ctx);
    }
    async createWorkItem(projectId, body, ctx) {
        return this.request(`${this.base(ctx)}/projects/${projectId}/issues/`, ctx, { method: 'POST', body });
    }
    async updateWorkItem(projectId, workItemId, body, ctx) {
        return this.request(`${this.base(ctx)}/projects/${projectId}/issues/${workItemId}/`, ctx, { method: 'PATCH', body });
    }
    // -- taxonomy -------------------------------------------------------------
    async listStates(projectId, ctx) {
        const res = await this.request(`${this.base(ctx)}/projects/${projectId}/states/`, ctx);
        return this.list(res);
    }
    async listLabels(projectId, ctx) {
        const res = await this.request(`${this.base(ctx)}/projects/${projectId}/labels/`, ctx);
        return this.list(res);
    }
    // -- cycles ---------------------------------------------------------------
    async listCycles(projectId, ctx) {
        const res = await this.request(`${this.base(ctx)}/projects/${projectId}/cycles/`, ctx);
        return this.list(res).map((c) => ({
            id: String(c.id),
            name: c.name,
            start_date: c.start_date ?? null,
            end_date: c.end_date ?? null,
        }));
    }
    async listCycleWorkItems(projectId, cycleId, ctx) {
        const res = await this.request(`${this.base(ctx)}/projects/${projectId}/cycles/${cycleId}/cycle-issues/`, ctx);
        return this.list(res);
    }
    async addWorkItemsToCycle(projectId, cycleId, workItemIds, ctx) {
        return this.request(`${this.base(ctx)}/projects/${projectId}/cycles/${cycleId}/cycle-issues/`, ctx, { method: 'POST', body: { issues: workItemIds } });
    }
    async addWorkItemsToModule(projectId, moduleId, workItemIds, ctx) {
        return this.request(`${this.base(ctx)}/projects/${projectId}/modules/${moduleId}/module-issues/`, ctx, { method: 'POST', body: { issues: workItemIds } });
    }
    // -- comments -------------------------------------------------------------
    async listWorkItemComments(projectId, workItemId, ctx) {
        const res = await this.request(`${this.base(ctx)}/projects/${projectId}/issues/${workItemId}/comments/`, ctx);
        return this.list(res);
    }
    async addWorkItemComment(projectId, workItemId, commentHtml, ctx) {
        return this.request(`${this.base(ctx)}/projects/${projectId}/issues/${workItemId}/comments/`, ctx, { method: 'POST', body: { comment_html: commentHtml } });
    }
    // -- estimates ------------------------------------------------------------
    async getProjectEstimate(projectId, ctx) {
        try {
            return await this.request(`${this.base(ctx)}/projects/${projectId}/estimates/`, ctx);
        }
        catch (err) {
            // No estimate system configured is an answer, not a failure.
            if (err instanceof PlaneApiError && err.status === 404)
                return null;
            throw err;
        }
    }
    async listEstimatePoints(projectId, estimateId, ctx) {
        const res = await this.request(`${this.base(ctx)}/projects/${projectId}/estimates/${estimateId}/estimate-points/`, ctx);
        return this.list(res);
    }
    async createEstimate(projectId, body, ctx) {
        return this.request(`${this.base(ctx)}/projects/${projectId}/estimates/`, ctx, { method: 'POST', body });
    }
    async updateEstimate(projectId, estimateId, body, ctx) {
        return this.request(`${this.base(ctx)}/projects/${projectId}/estimates/${estimateId}/`, ctx, { method: 'PATCH', body });
    }
    async createEstimatePoints(projectId, estimateId, points, ctx) {
        return this.request(`${this.base(ctx)}/projects/${projectId}/estimates/${estimateId}/estimate-points/`, ctx, { method: 'POST', body: { estimate_points: points } });
    }
}
exports.PlaneClient = PlaneClient;
