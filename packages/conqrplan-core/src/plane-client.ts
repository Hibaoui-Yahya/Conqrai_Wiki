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

export class PlaneApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PlaneApiError';
  }
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
  state?: string | { id?: string; name?: string; group?: string } | null;
  state_detail?: { name?: string; group?: string } | null;
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

/** Minimal counting semaphore: bounded concurrency without a dependency. */
class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

export class PlaneClient {
  private readonly semaphore: Semaphore;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PlaneClientOptions) {
    this.semaphore = new Semaphore(opts.maxConcurrency);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    path: string,
    ctx: PlaneCallContext,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
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
          let details: unknown;
          const text = await res.text().catch(() => '');
          try {
            details = text ? JSON.parse(text) : undefined;
          } catch {
            details = text || undefined;
          }
          throw new PlaneApiError(
            `ConqrPlan ${res.status} for ${path}`,
            res.status,
            res.status === 429 || res.status >= 500,
            details,
          );
        }
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      } catch (err) {
        if (err instanceof PlaneApiError) throw err;
        const aborted = (err as Error)?.name === 'AbortError';
        throw new PlaneApiError(
          aborted
            ? `ConqrPlan request timed out after ${this.opts.timeoutMs}ms`
            : `ConqrPlan request failed: ${(err as Error).message}`,
          0,
          true,
        );
      } finally {
        clearTimeout(timer);
      }
    });
  }

  private list<T>(res: { results?: T[] } | T[] | undefined): T[] {
    if (!res) return [];
    return Array.isArray(res) ? res : (res.results ?? []);
  }

  private base(ctx: PlaneCallContext): string {
    return `/workspaces/${ctx.workspaceSlug}`;
  }

  // -- projects, members ----------------------------------------------------

  async listProjects(ctx: PlaneCallContext) {
    const res = await this.request<{ results?: any[] } | any[]>(
      `${this.base(ctx)}/projects/`,
      ctx,
    );
    return this.list<any>(res).map((p) => ({
      id: String(p.id),
      name: p.name as string,
      identifier: p.identifier as string | undefined,
    }));
  }

  async listWorkspaceMembers(ctx: PlaneCallContext) {
    const res = await this.request<{ results?: any[] } | any[]>(
      `${this.base(ctx)}/members/`,
      ctx,
    );
    return this.list<any>(res);
  }

  // -- work items -----------------------------------------------------------

  async listWorkItems(
    projectId: string,
    opts: { search?: string; perPage?: number },
    ctx: PlaneCallContext,
  ): Promise<PlaneWorkItem[]> {
    const params = new URLSearchParams();
    if (opts.search) params.set('search', opts.search);
    if (opts.perPage) params.set('per_page', String(opts.perPage));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request<{ results?: PlaneWorkItem[] } | PlaneWorkItem[]>(
      `${this.base(ctx)}/projects/${projectId}/issues/${qs}`,
      ctx,
    );
    return this.list<PlaneWorkItem>(res);
  }

  async getWorkItem(projectId: string, workItemId: string, ctx: PlaneCallContext) {
    return this.request<PlaneWorkItem>(
      `${this.base(ctx)}/projects/${projectId}/issues/${workItemId}/`,
      ctx,
    );
  }

  async createWorkItem(
    projectId: string,
    body: Record<string, unknown>,
    ctx: PlaneCallContext,
  ) {
    return this.request<PlaneWorkItem>(
      `${this.base(ctx)}/projects/${projectId}/issues/`,
      ctx,
      { method: 'POST', body },
    );
  }

  async updateWorkItem(
    projectId: string,
    workItemId: string,
    body: Record<string, unknown>,
    ctx: PlaneCallContext,
  ) {
    return this.request<PlaneWorkItem>(
      `${this.base(ctx)}/projects/${projectId}/issues/${workItemId}/`,
      ctx,
      { method: 'PATCH', body },
    );
  }

  // -- taxonomy -------------------------------------------------------------

  async listStates(projectId: string, ctx: PlaneCallContext) {
    const res = await this.request<{ results?: any[] } | any[]>(
      `${this.base(ctx)}/projects/${projectId}/states/`,
      ctx,
    );
    return this.list<any>(res);
  }

  async listLabels(projectId: string, ctx: PlaneCallContext) {
    const res = await this.request<{ results?: any[] } | any[]>(
      `${this.base(ctx)}/projects/${projectId}/labels/`,
      ctx,
    );
    return this.list<any>(res);
  }

  // -- cycles ---------------------------------------------------------------

  async listCycles(projectId: string, ctx: PlaneCallContext) {
    const res = await this.request<{ results?: any[] } | any[]>(
      `${this.base(ctx)}/projects/${projectId}/cycles/`,
      ctx,
    );
    return this.list<any>(res).map((c) => ({
      id: String(c.id),
      name: c.name as string,
      start_date: c.start_date ?? null,
      end_date: c.end_date ?? null,
    }));
  }

  async listCycleWorkItems(projectId: string, cycleId: string, ctx: PlaneCallContext) {
    const res = await this.request<{ results?: any[] } | any[]>(
      `${this.base(ctx)}/projects/${projectId}/cycles/${cycleId}/cycle-issues/`,
      ctx,
    );
    return this.list<any>(res);
  }

  async addWorkItemsToCycle(
    projectId: string,
    cycleId: string,
    workItemIds: string[],
    ctx: PlaneCallContext,
  ) {
    return this.request(
      `${this.base(ctx)}/projects/${projectId}/cycles/${cycleId}/cycle-issues/`,
      ctx,
      { method: 'POST', body: { issues: workItemIds } },
    );
  }

  async addWorkItemsToModule(
    projectId: string,
    moduleId: string,
    workItemIds: string[],
    ctx: PlaneCallContext,
  ) {
    return this.request(
      `${this.base(ctx)}/projects/${projectId}/modules/${moduleId}/module-issues/`,
      ctx,
      { method: 'POST', body: { issues: workItemIds } },
    );
  }

  // -- comments -------------------------------------------------------------

  async listWorkItemComments(
    projectId: string,
    workItemId: string,
    ctx: PlaneCallContext,
  ) {
    const res = await this.request<{ results?: any[] } | any[]>(
      `${this.base(ctx)}/projects/${projectId}/issues/${workItemId}/comments/`,
      ctx,
    );
    return this.list<any>(res);
  }

  async addWorkItemComment(
    projectId: string,
    workItemId: string,
    commentHtml: string,
    ctx: PlaneCallContext,
  ) {
    return this.request<any>(
      `${this.base(ctx)}/projects/${projectId}/issues/${workItemId}/comments/`,
      ctx,
      { method: 'POST', body: { comment_html: commentHtml } },
    );
  }

  // -- estimates ------------------------------------------------------------

  async getProjectEstimate(projectId: string, ctx: PlaneCallContext) {
    try {
      return await this.request<any>(
        `${this.base(ctx)}/projects/${projectId}/estimates/`,
        ctx,
      );
    } catch (err) {
      // No estimate system configured is an answer, not a failure.
      if (err instanceof PlaneApiError && err.status === 404) return null;
      throw err;
    }
  }

  async listEstimatePoints(projectId: string, estimateId: string, ctx: PlaneCallContext) {
    const res = await this.request<{ results?: any[] } | any[]>(
      `${this.base(ctx)}/projects/${projectId}/estimates/${estimateId}/estimate-points/`,
      ctx,
    );
    return this.list<any>(res);
  }

  async createEstimate(
    projectId: string,
    body: Record<string, unknown>,
    ctx: PlaneCallContext,
  ) {
    return this.request<any>(
      `${this.base(ctx)}/projects/${projectId}/estimates/`,
      ctx,
      { method: 'POST', body },
    );
  }

  async updateEstimate(
    projectId: string,
    estimateId: string,
    body: Record<string, unknown>,
    ctx: PlaneCallContext,
  ) {
    return this.request<any>(
      `${this.base(ctx)}/projects/${projectId}/estimates/${estimateId}/`,
      ctx,
      { method: 'PATCH', body },
    );
  }

  async createEstimatePoints(
    projectId: string,
    estimateId: string,
    points: unknown[],
    ctx: PlaneCallContext,
  ) {
    return this.request<any>(
      `${this.base(ctx)}/projects/${projectId}/estimates/${estimateId}/estimate-points/`,
      ctx,
      { method: 'POST', body: { estimate_points: points } },
    );
  }
}
