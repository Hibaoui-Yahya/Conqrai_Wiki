import { Injectable, Logger } from '@nestjs/common';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

export interface PlaneWorkItem {
  id: string;
  name: string;
  description_stripped?: string;
  state?: string;
  state_detail?: { name?: string; group?: string };
  priority?: string;
  assignees?: string[];
  labels?: string[];
  project?: string;
  sequence_id?: number;
  estimate_point?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  parent?: string | null;
  type_id?: string | null;
  type?: string | null;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  archived_at?: string | null;
}

/** Field payload accepted by ConqrPlan's work-item create and patch endpoints. */
export interface PlaneWorkItemWrite {
  name?: string;
  description_html?: string | null;
  priority?: string;
  state?: string;
  assignees?: string[];
  labels?: string[];
  estimate_point?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  parent?: string | null;
  type_id?: string | null;
  /** ConqrPlan's native idempotency key, paired with external_source. */
  external_id?: string;
  external_source?: string;
}

/**
 * Who a ConqrPlan call is being made for.
 *
 * `delegation` is a signed on-behalf-of token naming the human actor and the
 * tenant; ConqrPlan verifies it and authorises that user. A call without one
 * is a service call and ConqrPlan will refuse it on any endpoint that requires
 * a human actor. There is deliberately no field here for a bare user id.
 */
export interface PlaneCallContext {
  workspaceSlug?: string;
  delegation?: string;
  correlationId?: string;
}

export interface PlaneEstimate {
  id: string;
  name: string;
  type?: string;
  points?: { id: string; key: number; value: string }[];
}

export interface PlaneLabel {
  id: string;
  name: string;
  color?: string;
}

export interface PlaneState {
  id: string;
  name: string;
  group?: string;
  color?: string;
  default?: boolean;
}

export interface PlaneComment {
  id: string;
  comment_html?: string;
  comment_stripped?: string;
  actor?: string;
  created_at?: string;
  updated_at?: string;
}

export interface PlaneMember {
  id: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
}

export class PlaneApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    /**
     * The parsed body ConqrPlan returned with the failure, when there was one.
     * Validation failures carry per-field messages that callers surface
     * verbatim instead of a bare status code.
     */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PlaneApiError';
  }
}

/** Read a response body without throwing when it is empty or not JSON. */
async function readBody(res: { text(): Promise<string> }): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return undefined;
  }
}

/**
 * Thin REST client for Plane (blueprint §8.1). ConqrHub never touches Plane's
 * database — all work data is read through this adapter. Handles auth header,
 * timeout, and surfaces rate-limit / transient failures as retryable so the
 * resolver can degrade to a stale snapshot instead of erroring.
 *
 * The documented Plane API-key limit is ~60 req/min, so callers should cache
 * and batch; this client only enforces a per-request timeout and classifies
 * 429/5xx as retryable.
 */
/**
 * Forward the caller's delegation on a read.
 *
 * Reads are delegated too. Without this ConqrPlan answers as the API key's
 * owner, so a viewer with no access to a project would still be shown its work
 * items - and once ConqrPlan started requiring delegation, every card resolved
 * as `restricted` instead, because the GET carried none.
 */
function readContext(ctx?: PlaneCallContext) {
  return { delegation: ctx?.delegation, correlationId: ctx?.correlationId };
}

@Injectable()
export class PlaneClientService {
  private readonly logger = new Logger(PlaneClientService.name);

  constructor(private readonly environment: EnvironmentService) {}

  isEnabled(): boolean {
    return this.environment.isPlaneIntegrationEnabled();
  }

  private async request<T>(
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      /**
       * A signed delegation token. NOT a user id: the previous
       * `X-Conqr-On-Behalf-Of` header carried a bare id that ConqrPlan never
       * read, so every write ran as the API key's owner. A caller that has no
       * delegation must not be able to assert an identity at all.
       */
      delegation?: string;
      /** Correlation id (the delegation's jti) for cross-product audit. */
      correlationId?: string;
    },
  ): Promise<T> {
    const base = this.environment.getPlaneApiUrl();
    const key = this.environment.getPlaneApiKey();
    if (!base || !key) {
      throw new PlaneApiError('Plane integration is not configured', 503, false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.environment.getPlaneApiTimeoutMs(),
    );

    try {
      const res = await fetch(`${base}${path}`, {
        method: init?.method ?? 'GET',
        headers: {
          // Transport identity: which service is calling. On its own this
          // authenticates ConqrHub, never a human.
          'X-Api-Key': key,
          Accept: 'application/json',
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          // Actor identity: a short-lived signed delegation naming the human
          // and tenant. ConqrPlan verifies it independently and authorises the
          // mapped user (§9.1).
          ...(init?.delegation
            ? { 'X-Conqr-Delegation': init.delegation }
            : {}),
          ...(init?.correlationId
            ? { 'X-Conqr-Correlation-Id': init.correlationId }
            : {}),
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        throw new PlaneApiError(
          `Plane API ${res.status} for ${path}`,
          res.status,
          true,
        );
      }
      if (res.status === 404) {
        throw new PlaneApiError(`Not found: ${path}`, 404, false, await readBody(res));
      }
      if (!res.ok) {
        // Keep ConqrPlan's own validation payload: it names the offending
        // field ("State is not valid please pass a valid state_id"), which is
        // what an agent needs in order to correct the call.
        const details = await readBody(res);
        throw new PlaneApiError(
          `Plane API ${res.status} for ${path}`,
          res.status,
          false,
          details,
        );
      }
      // 204 and other empty bodies are valid successes (membership removal).
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof PlaneApiError) throw err;
      // Network error / timeout — retryable (caller may serve a stale snapshot).
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Plane API request failed for ${path}: ${message}`);
      throw new PlaneApiError(message, 0, true);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fetch a single work item. The workspace falls back to the configured
   * default when omitted.
   */
  async getWorkItem(
    projectId: string,
    workItemId: string,
    ctx?: PlaneCallContext,
  ): Promise<PlaneWorkItem> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    return this.request<PlaneWorkItem>(
      `/workspaces/${slug}/projects/${projectId}/issues/${workItemId}/`,
      readContext(ctx),
    );
  }

  /** Create a work item in a Plane project (blueprint §5.1A). */
  async createWorkItem(
    projectId: string,
    input: PlaneWorkItemWrite & { name: string },
    opts?: PlaneCallContext,
  ): Promise<PlaneWorkItem> {
    const slug = opts?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    return this.request<PlaneWorkItem>(
      `/workspaces/${slug}/projects/${projectId}/issues/`,
      { method: 'POST', body: input, delegation: opts?.delegation,
        correlationId: opts?.correlationId },
    );
  }

  /**
   * List / search work items in a project. `search` filters by name where the
   * Plane API supports it; results are paginated by Plane.
   */
  async listWorkItems(
    projectId: string,
    opts: { search?: string; perPage?: number } = {},
    ctx?: PlaneCallContext,
  ): Promise<{ results: PlaneWorkItem[] }> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const params = new URLSearchParams();
    if (opts.search) params.set('search', opts.search);
    if (opts.perPage) params.set('per_page', String(opts.perPage));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request<{ results?: PlaneWorkItem[] } | PlaneWorkItem[]>(
      `/workspaces/${slug}/projects/${projectId}/issues/${qs}`,
      readContext(ctx),
    );
    // Plane returns either a paginated {results} or a bare array depending on endpoint.
    const results = Array.isArray(res) ? res : (res.results ?? []);
    return { results };
  }

  /** List a project's labels (id → name) for label prediction metadata. */
  async listLabels(
    projectId: string,
    ctx?: PlaneCallContext,
  ): Promise<PlaneLabel[]> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const res = await this.request<{ results?: PlaneLabel[] } | PlaneLabel[]>(
      `/workspaces/${slug}/projects/${projectId}/labels/`,
      readContext(ctx),
    );
    return Array.isArray(res) ? res : (res.results ?? []);
  }

  /**
   * Cursor-paginated work-item listing for backfills. Plane's cursor format is
   * `<page_size>:<page>:<offset>`; `next_page_results=false` marks the end.
   */
  async listWorkItemsPage(
    projectId: string,
    opts: { cursor?: string; perPage?: number } = {},
    ctx?: PlaneCallContext,
  ): Promise<{ results: PlaneWorkItem[]; nextCursor: string | null }> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const params = new URLSearchParams();
    if (opts.perPage) params.set('per_page', String(opts.perPage));
    if (opts.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request<{
      results?: PlaneWorkItem[];
      next_cursor?: string;
      next_page_results?: boolean;
    }>(`/workspaces/${slug}/projects/${projectId}/issues/${qs}`, readContext(ctx));
    return {
      results: res.results ?? [],
      nextCursor: res.next_page_results ? (res.next_cursor ?? null) : null,
    };
  }

  /** List projects in the configured workspace (suite AI/MCP tools). */
  async listProjects(ctx?: PlaneCallContext): Promise<{ id: string; name: string; identifier?: string }[]> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const res = await this.request<{ results?: any[] } | any[]>(`/workspaces/${slug}/projects/`, readContext(ctx));
    const results = Array.isArray(res) ? res : (res.results ?? []);
    return results.map((p: any) => ({ id: p.id, name: p.name, identifier: p.identifier }));
  }

  /** Partially update a work item (suite AI/MCP tools). */
  async updateWorkItem(
    projectId: string,
    workItemId: string,
    patch: PlaneWorkItemWrite,
    opts?: PlaneCallContext,
  ): Promise<PlaneWorkItem> {
    const slug = opts?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    return this.request<PlaneWorkItem>(
      `/workspaces/${slug}/projects/${projectId}/issues/${workItemId}/`,
      { method: 'PATCH', body: patch, delegation: opts?.delegation,
        correlationId: opts?.correlationId },
    );
  }

  /** List a project's workflow states so callers can set/read state by name. */
  async listStates(
    projectId: string,
    ctx?: PlaneCallContext,
  ): Promise<PlaneState[]> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const res = await this.request<{ results?: PlaneState[] } | PlaneState[]>(
      `/workspaces/${slug}/projects/${projectId}/states/`,
      readContext(ctx),
    );
    return Array.isArray(res) ? res : (res.results ?? []);
  }

  /** List comments on a work item. */
  async listWorkItemComments(
    projectId: string,
    workItemId: string,
    ctx?: PlaneCallContext,
  ): Promise<PlaneComment[]> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const res = await this.request<{ results?: PlaneComment[] } | PlaneComment[]>(
      `/workspaces/${slug}/projects/${projectId}/issues/${workItemId}/comments/`,
      readContext(ctx),
    );
    return Array.isArray(res) ? res : (res.results ?? []);
  }

  /** Add a comment to a work item. Plane expects sanitised `comment_html`. */
  async addWorkItemComment(
    projectId: string,
    workItemId: string,
    commentHtml: string,
    opts?: PlaneCallContext,
  ): Promise<PlaneComment> {
    const slug = opts?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    return this.request<PlaneComment>(
      `/workspaces/${slug}/projects/${projectId}/issues/${workItemId}/comments/`,
      {
        method: 'POST',
        body: { comment_html: commentHtml },
        delegation: opts?.delegation,
        correlationId: opts?.correlationId,
      },
    );
  }

  /** List the work items inside one cycle (sprint). */
  async listCycleWorkItems(
    projectId: string,
    cycleId: string,
    ctx?: PlaneCallContext,
  ): Promise<PlaneWorkItem[]> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const res = await this.request<{ results?: PlaneWorkItem[] } | PlaneWorkItem[]>(
      `/workspaces/${slug}/projects/${projectId}/cycles/${cycleId}/cycle-issues/`,
      readContext(ctx),
    );
    return Array.isArray(res) ? res : (res.results ?? []);
  }

  /** List a project's estimate systems with their points (estimate values). */
  async listEstimates(
    projectId: string,
    ctx?: PlaneCallContext,
  ): Promise<PlaneEstimate[]> {
    // ConqrPlan allows one estimate system per project and returns it as a
    // single object, not a collection, and without its point values. Reading
    // it as a list yielded an empty array for every configured project, so the
    // shape is normalised here and the points are fetched alongside. The
    // array return is kept for callers that already expect one.
    const estimate = await this.getProjectEstimate(projectId, ctx);
    if (!estimate) return [];
    let points = estimate.points ?? [];
    if (!points.length) {
      try {
        points = await this.listEstimatePoints(projectId, estimate.id, ctx);
      } catch {
        points = [];
      }
    }
    return [{ id: estimate.id, name: estimate.name, type: estimate.type, points }];
  }

  /** List the members of the configured Plane workspace (assignee resolution). */
  async listWorkspaceMembers(ctx?: PlaneCallContext): Promise<PlaneMember[]> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const res = await this.request<{ results?: PlaneMember[] } | PlaneMember[]>(
      `/workspaces/${slug}/members/`,
      readContext(ctx),
    );
    return Array.isArray(res) ? res : (res.results ?? []);
  }

  /** List cycles for a project (suite AI/MCP tools). */
  async listCycles(
    projectId: string,
    ctx?: PlaneCallContext,
  ): Promise<{ id: string; name: string; start_date?: string | null; end_date?: string | null }[]> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const res = await this.request<{ results?: any[] } | any[]>(
      `/workspaces/${slug}/projects/${projectId}/cycles/`,
      readContext(ctx),
    );
    const results = Array.isArray(res) ? res : (res.results ?? []);
    return results.map((c: any) => ({
      id: c.id,
      name: c.name,
      start_date: c.start_date ?? null,
      end_date: c.end_date ?? null,
    }));
  }

  // ----------------------------------------------------------------------
  // Control Foundation v1: reference lookups, cycle/module membership and
  // estimate configuration. ConqrPlan stays the authority for validation and
  // permissions; these are thin transport wrappers.
  // ----------------------------------------------------------------------

  /** Members of a single project, used to pre-validate assignees. */
  async listProjectMembers(
    projectId: string,
    ctx?: PlaneCallContext,
  ): Promise<{ id: string; member_id?: string; role?: number }[]> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const res = await this.request<{ results?: any[] } | any[]>(
      `/workspaces/${slug}/projects/${projectId}/members/`,
      readContext(ctx),
    );
    const results = Array.isArray(res) ? res : (res?.results ?? []);
    return results.map((m: any) => ({
      id: m.member ?? m.member_id ?? m.id,
      member_id: m.member ?? m.member_id,
      role: m.role,
    }));
  }

  /** List modules (feature groupings) for a project. */
  async listModules(
    projectId: string,
    ctx?: PlaneCallContext,
  ): Promise<{ id: string; name: string; status?: string }[]> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const res = await this.request<{ results?: any[] } | any[]>(
      `/workspaces/${slug}/projects/${projectId}/modules/`,
      readContext(ctx),
    );
    const results = Array.isArray(res) ? res : (res?.results ?? []);
    return results.map((m: any) => ({ id: m.id, name: m.name, status: m.status }));
  }

  /** Add work items to a cycle. ConqrPlan refuses cycles that already ended. */
  async addWorkItemsToCycle(
    projectId: string,
    cycleId: string,
    workItemIds: string[],
    opts?: PlaneCallContext,
  ): Promise<unknown> {
    const slug = opts?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    return this.request(
      `/workspaces/${slug}/projects/${projectId}/cycles/${cycleId}/cycle-issues/`,
      { method: 'POST', body: { issues: workItemIds }, delegation: opts?.delegation,
        correlationId: opts?.correlationId },
    );
  }

  /**
   * The cycle a work item currently belongs to, or null.
   *
   * ConqrPlan's work-item payload does not carry its cycle, and there is no
   * reverse lookup endpoint, so this scans the project's cycles. An item can be
   * in at most one cycle, so the scan stops at the first hit. Bounded by
   * `maxCycles` to keep a project with a long sprint history from turning one
   * call into hundreds; returns `undefined` (not null) when the bound was hit
   * without an answer, so a caller can tell "not in a cycle" from "did not
   * finish looking".
   */
  async findWorkItemCycle(
    projectId: string,
    workItemId: string,
    opts?: PlaneCallContext & { maxCycles?: number },
  ): Promise<string | null | undefined> {
    const slug = opts?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const maxCycles = opts?.maxCycles ?? 25;
    const cycles = await this.listCycles(projectId, opts);
    const scanned = cycles.slice(0, maxCycles);
    for (const cycle of scanned) {
      const res = await this.request<{ results?: any[] } | any[]>(
        `/workspaces/${slug}/projects/${projectId}/cycles/${cycle.id}/cycle-issues/`,
        readContext(opts),
      );
      const items = Array.isArray(res) ? res : (res?.results ?? []);
      if (items.some((i: any) => String(i.id) === String(workItemId))) return cycle.id;
    }
    return cycles.length > scanned.length ? undefined : null;
  }

  /** Remove a single work item from a cycle. */
  async removeWorkItemFromCycle(
    projectId: string,
    cycleId: string,
    workItemId: string,
    opts?: PlaneCallContext,
  ): Promise<void> {
    const slug = opts?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    await this.request(
      `/workspaces/${slug}/projects/${projectId}/cycles/${cycleId}/cycle-issues/${workItemId}/`,
      { method: 'DELETE', delegation: opts?.delegation,
        correlationId: opts?.correlationId },
    );
  }

  /** Add work items to a module. */
  async addWorkItemsToModule(
    projectId: string,
    moduleId: string,
    workItemIds: string[],
    opts?: PlaneCallContext,
  ): Promise<unknown> {
    const slug = opts?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    return this.request(
      `/workspaces/${slug}/projects/${projectId}/modules/${moduleId}/module-issues/`,
      { method: 'POST', body: { issues: workItemIds }, delegation: opts?.delegation,
        correlationId: opts?.correlationId },
    );
  }

  /** Remove a single work item from a module. */
  async removeWorkItemFromModule(
    projectId: string,
    moduleId: string,
    workItemId: string,
    opts?: PlaneCallContext,
  ): Promise<void> {
    const slug = opts?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    await this.request(
      `/workspaces/${slug}/projects/${projectId}/modules/${moduleId}/module-issues/${workItemId}/`,
      { method: 'DELETE', delegation: opts?.delegation,
        correlationId: opts?.correlationId },
    );
  }

  /**
   * The project's estimate system, or null when none is configured.
   * `is_active` reports whether ConqrPlan has the system switched on for the
   * project — a system that exists but is inactive is invisible in the UI and
   * cannot hold point values.
   */
  async getProjectEstimate(
    projectId: string,
    ctx?: PlaneCallContext,
  ): Promise<(PlaneEstimate & { is_active?: boolean }) | null> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    try {
      return await this.request<PlaneEstimate & { is_active?: boolean }>(
        `/workspaces/${slug}/projects/${projectId}/estimates/`,
      readContext(ctx),
      );
    } catch (err) {
      if (err instanceof PlaneApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Create the project's estimate system. ConqrPlan activates it on create. */
  async createEstimate(
    projectId: string,
    input: { name: string; type?: string; description?: string },
    opts?: PlaneCallContext,
  ): Promise<PlaneEstimate & { is_active?: boolean }> {
    const slug = opts?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    return this.request(`/workspaces/${slug}/projects/${projectId}/estimates/`, {
      method: 'POST',
      body: input,
      delegation: opts?.delegation,
        correlationId: opts?.correlationId,
    });
  }

  /** Patch the estimate system; `is_active` toggles activation idempotently. */
  async updateEstimate(
    projectId: string,
    patch: { name?: string; description?: string; is_active?: boolean },
    opts?: PlaneCallContext,
  ): Promise<PlaneEstimate & { is_active?: boolean }> {
    const slug = opts?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    return this.request(`/workspaces/${slug}/projects/${projectId}/estimates/`, {
      method: 'PATCH',
      body: patch,
      delegation: opts?.delegation,
        correlationId: opts?.correlationId,
    });
  }

  /** Bulk create the point values of an estimate system. */
  async createEstimatePoints(
    projectId: string,
    estimateId: string,
    points: { key: number; value: string; description?: string }[],
    opts?: PlaneCallContext,
  ): Promise<{ id: string; key: number; value: string }[]> {
    const slug = opts?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    return this.request(
      `/workspaces/${slug}/projects/${projectId}/estimates/${estimateId}/estimate-points/`,
      { method: 'POST', body: { estimate_points: points }, delegation: opts?.delegation,
        correlationId: opts?.correlationId },
    );
  }

  /** List the point values of an estimate system. */
  async listEstimatePoints(
    projectId: string,
    estimateId: string,
    ctx?: PlaneCallContext,
  ): Promise<{ id: string; key: number; value: string }[]> {
    const slug = ctx?.workspaceSlug || this.environment.getPlaneWorkspaceSlug();
    const res = await this.request<{ results?: any[] } | any[]>(
      `/workspaces/${slug}/projects/${projectId}/estimates/${estimateId}/estimate-points/`,
      readContext(ctx),
    );
    return Array.isArray(res) ? res : (res?.results ?? []);
  }
}
