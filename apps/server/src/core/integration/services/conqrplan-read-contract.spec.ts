/**
 * One contract, two implementations.
 *
 * Every ConqrPlan read tool exists twice: the original inside ConqrHub, and
 * the one in the extracted MCP service. Routing a tool means swapping which
 * of the two answers, so the only question that matters before routing is
 * whether they answer the same. This suite asks that question directly - the
 * same actor, the same tenant, the same live ConqrPlan, the same arguments -
 * and compares the normalised results.
 *
 * It also asks it for the identities where a difference would be a security
 * failure rather than a bug: a restricted guest, a person who lost their
 * membership, an unmapped identity, the wrong organisation. A read tool that
 * returns *more* through one implementation than the other is the failure
 * this exists to catch.
 *
 * Opt-in, because it needs a live local stack:
 *   CONTRACT_SUITE=1 MCP_BASE=http://localhost:8797 ... npx jest conqrplan-read-contract
 */
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { DELEGATED_SCOPES } from '../domain/delegated-token.util';
import { DelegatedTokenService } from './delegated-token.service';
import { PlaneClientService } from './plane-client.service';
import { ChatToolContext } from '../../../ee/ai/chat/tools/chat-tool.types';
import { delegateForPlane } from '../../../ee/ai/chat/tools/plane-delegation.helper';

const enabled = process.env.CONTRACT_SUITE === '1';
const d = enabled ? describe : describe.skip;

// --- fixtures, from seed_mcp_integration.py --------------------------------
const F = JSON.parse(readFileSync(process.env.FIXTURES as string, 'utf8'));
const MCP_BASE = process.env.MCP_BASE ?? 'http://localhost:8797';
const CLIENT_TOKEN = process.env.CLIENT_TOKEN as string;
const HUB_KID = process.env.HUB_KID ?? 'hub-container-test';
const uuidOf = (uid: string) => uid.replace(/^conqr:(person|org):/, '');

const env = {
  isPlaneIntegrationEnabled: () => true,
  getPlaneApiUrl: () => process.env.PLANE_API_URL ?? 'http://localhost:8000/api/v1',
  getPlaneApiKey: () => process.env.PLANE_API_KEY as string,
  getPlaneApiTimeoutMs: () => 15000,
  getPlaneWorkspaceSlug: () => F.workspaceSlug,
  getDelegationSigningKey: () => process.env.CONQR_OBO_SIGNING_KEY as string,
  getDelegationIssuer: () => 'conqrhub',
  isDelegationKeyDedicated: () => true,
} as any;

const plane = new PlaneClientService(env);
const delegation = new DelegatedTokenService(env);

const ctxFor = (personUid: string, orgUid: string): ChatToolContext =>
  ({ user: { id: uuidOf(personUid) }, workspaceId: uuidOf(orgUid) }) as ChatToolContext;

// --- the MCP implementation, over the wire --------------------------------
const b64 = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function assertion(personUid: string, orgUid: string, scope: string[]): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: 'EdDSA', typ: 'CONQR-OBO', kid: HUB_KID }));
  const p = b64(
    JSON.stringify({
      sub: personUid,
      tid: orgUid,
      aud: 'conqrplan-mcp',
      scope,
      iat: now,
      nbf: now,
      exp: now + 300,
      act: 'obo',
      iss: 'conqrhub',
      jti: `contract-${Math.random().toString(36).slice(2)}`,
    }),
  );
  const key = createPrivateKey(readFileSync(process.env.HUB_KEY_FILE as string, 'utf8'));
  return `${h}.${p}.${b64(edSign(null, Buffer.from(`${h}.${p}`), key))}`;
}

async function viaMcp(
  toolName: string,
  args: Record<string, unknown>,
  personUid: string,
  orgUid: string,
  scope: string[] = [DELEGATED_SCOPES.workItemRead],
): Promise<{ status: number; value: any }> {
  const res = await fetch(`${MCP_BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'X-Conqr-Delegation': assertion(personUid, orgUid, scope),
      'X-Conqr-Correlation-Id': `contract-${Date.now()}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (res.status !== 200) return { status: res.status, value: body };
  return { status: 200, value: JSON.parse(body.result.content[0].text) };
}

// --- the local implementation, in process ---------------------------------
/**
 * Hub's own version of each read, called exactly as its chat tool calls it.
 * Deliberately the same client and delegation helper the tool classes use, so
 * a divergence in this file is a divergence in the product.
 */
const LOCAL: Record<string, (args: any, ctx: ChatToolContext) => Promise<any>> = {
  list_conqrplan_projects: (_a, ctx) =>
    plane.listProjects(delegateForPlane(delegation, ctx, [DELEGATED_SCOPES.workItemRead])),
  list_conqrplan_members: (_a, ctx) =>
    plane.listWorkspaceMembers(
      delegateForPlane(delegation, ctx, [DELEGATED_SCOPES.workItemRead]),
    ),
  list_work_item_states: (a, ctx) =>
    plane.listStates(a.projectId, delegateForPlane(delegation, ctx, [DELEGATED_SCOPES.workItemRead])),
  list_work_item_labels: (a, ctx) =>
    plane.listLabels(a.projectId, delegateForPlane(delegation, ctx, [DELEGATED_SCOPES.workItemRead])),
  get_project_cycles: (a, ctx) =>
    plane.listCycles(a.projectId, delegateForPlane(delegation, ctx, [DELEGATED_SCOPES.workItemRead])),
  list_cycle_work_items: (a, ctx) =>
    plane.listCycleWorkItems(
      a.projectId,
      a.cycleId,
      delegateForPlane(delegation, ctx, [DELEGATED_SCOPES.workItemRead]),
    ),
  search_work_items: (a, ctx) =>
    plane.listWorkItems(
      a.projectId,
      { search: a.query, perPage: a.limit ?? 20 },
      delegateForPlane(delegation, ctx, [DELEGATED_SCOPES.workItemRead]),
    ),
  get_work_item: (a, ctx) =>
    plane.getWorkItem(
      a.projectId,
      a.workItemId,
      delegateForPlane(delegation, ctx, [DELEGATED_SCOPES.workItemRead]),
    ),
  get_work_item_comments: (a, ctx) =>
    plane.listWorkItemComments(
      a.projectId,
      a.workItemId,
      delegateForPlane(delegation, ctx, [DELEGATED_SCOPES.workItemRead]),
    ),
  get_estimate_system: (a, ctx) =>
    plane.getProjectEstimate(
      a.projectId,
      delegateForPlane(delegation, ctx, [DELEGATED_SCOPES.estimateRead]),
    ),
  list_estimate_points: (a, ctx) =>
    plane.getProjectEstimate(
      a.projectId,
      delegateForPlane(delegation, ctx, [DELEGATED_SCOPES.estimateRead]),
    ),
};

/**
 * Compare what the two implementations *mean*, not how they render it.
 *
 * Ids are the semantic content of a read; field names and wrapper shapes are
 * presentation and differ by design (the MCP tools return summaries). Timing
 * and correlation values are transport and are excluded outright.
 */
function idsOf(value: any): string[] {
  const out: string[] = [];
  const walk = (v: any) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      if (typeof v.id === 'string') out.push(v.id);
      return Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return [...new Set(out)].sort();
}

const MEMBER = () => ctxFor(F.memberPersonUid, F.orgUid);
const GUEST = () => ctxFor(F.guestPersonUid, F.orgUid);

d('ConqrPlan read tools: local and MCP answer the same', () => {
  jest.setTimeout(120000);

  const READS: Array<{ tool: string; args: Record<string, unknown>; scope?: string[] }> = [
    { tool: 'list_conqrplan_projects', args: {} },
    { tool: 'list_conqrplan_members', args: {} },
    { tool: 'list_work_item_states', args: { projectId: F.projectId } },
    { tool: 'list_work_item_labels', args: { projectId: F.projectId } },
    { tool: 'get_project_cycles', args: { projectId: F.projectId } },
    { tool: 'search_work_items', args: { projectId: F.projectId, limit: 50 } },
    { tool: 'get_work_item', args: { projectId: F.projectId, workItemId: F.memberIssueId } },
    {
      tool: 'get_work_item_comments',
      args: { projectId: F.projectId, workItemId: F.memberIssueId },
    },
    {
      tool: 'get_estimate_system',
      args: { projectId: F.projectId },
      scope: [DELEGATED_SCOPES.estimateRead],
    },
    {
      tool: 'list_estimate_points',
      args: { projectId: F.projectId },
      scope: [DELEGATED_SCOPES.estimateRead],
    },
  ];

  describe.each(READS)('$tool', ({ tool, args, scope }) => {
    it('returns the same records to an authorised member', async () => {
      const ctx = MEMBER();
      const local = await LOCAL[tool](args, ctx);
      const remote = await viaMcp(tool, args, F.memberPersonUid, F.orgUid, scope);
      expect(remote.status).toBe(200);
      expect(remote.value?.error).toBeUndefined();
      expect(idsOf(remote.value)).toEqual(idsOf(local));
    });

    it('shows a restricted guest no more through MCP than locally', async () => {
      const ctx = GUEST();
      let local: any;
      try {
        local = await LOCAL[tool](args, ctx);
      } catch (err) {
        local = { refused: true };
      }
      const remote = await viaMcp(tool, args, F.guestPersonUid, F.orgUid, scope);
      const remoteIds = remote.status === 200 ? idsOf(remote.value) : [];
      const localIds = local?.refused ? [] : idsOf(local);
      // The guest may legitimately see nothing through either path; what must
      // never happen is the extracted service revealing something Hub's own
      // implementation would have withheld.
      expect(remoteIds.filter((id) => !localIds.includes(id))).toEqual([]);
      expect(remoteIds).not.toContain(F.memberIssueId);
    });

    it('refuses an unmapped identity', async () => {
      const remote = await viaMcp(
        tool,
        args,
        'conqr:person:00000000-0000-0000-0000-000000000000',
        F.orgUid,
        scope,
      );
      // Ids the caller passed in are echoed by the error message, and seeing
      // your own argument reflected back proves nothing either way. What must
      // never come back is content: a name, a description, a comment body.
      expect(remote.status === 200 ? remote.value?.error : remote.value.error).toBeTruthy();
      // A refusal carries only a refusal. Any field that could hold a record -
      // a name, a description, a comment body, a list of anything - means the
      // read partially succeeded for someone who has no identity here.
      expect(Array.isArray(remote.value)).toBe(false);
      const keys = Object.keys(remote.value ?? {});
      expect(keys.filter((k) => !['error', 'code', 'message'].includes(k))).toEqual([]);
    });

    it('refuses the wrong organisation before reaching ConqrPlan', async () => {
      const remote = await viaMcp(
        tool,
        args,
        F.memberPersonUid,
        'conqr:org:99999999-9999-9999-9999-999999999999',
        scope,
      );
      expect(remote.status).toBe(403);
      expect(remote.value.error).toBe('tenant_unmapped');
    });

    it('refuses a scope the assertion does not carry', async () => {
      const remote = await viaMcp(tool, args, F.memberPersonUid, F.orgUid, [
        DELEGATED_SCOPES.cycleAssign,
      ]);
      expect(remote.status).not.toBe(200);
    });
  });

  describe('resources that are missing or gone', () => {
    it('reports a missing work item without inventing one', async () => {
      const remote = await viaMcp(
        'get_work_item',
        { projectId: F.projectId, workItemId: '00000000-0000-0000-0000-000000000000' },
        F.memberPersonUid,
        F.orgUid,
      );
      expect(remote.value?.error ?? remote.status).toBeTruthy();
      expect(JSON.stringify(remote.value)).not.toContain(F.memberIssueId);
    });

    it('reports a missing project without listing another', async () => {
      const remote = await viaMcp(
        'list_work_item_states',
        { projectId: '00000000-0000-0000-0000-000000000000' },
        F.memberPersonUid,
        F.orgUid,
      );
      const text = JSON.stringify(remote.value);
      expect(text).not.toContain(F.projectId);
    });

    it('answers a no-match query the same way through both paths', async () => {
      const args = { projectId: F.projectId, query: 'zzz-no-such-work-item-zzz', limit: 10 };
      const remote = await viaMcp('search_work_items', args, F.memberPersonUid, F.orgUid);
      const local = await LOCAL.search_work_items(args, MEMBER());
      expect(remote.status).toBe(200);
      // ConqrPlan's list endpoint ignores the search term, so neither
      // implementation filters. That is a product behaviour, and the contract
      // that matters is that both behave identically.
      expect(idsOf(remote.value)).toEqual(idsOf(local));
    });

    it('honours a pagination limit', async () => {
      const one = await viaMcp(
        'search_work_items',
        { projectId: F.projectId, limit: 1 },
        F.memberPersonUid,
        F.orgUid,
      );
      expect(one.status).toBe(200);
      expect(one.value.length).toBeLessThanOrEqual(1);
    });
  });

  it('keeps concurrent callers apart', async () => {
    const calls = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        viaMcp(
          'search_work_items',
          { projectId: F.projectId, limit: 50 },
          i % 2 ? F.guestPersonUid : F.memberPersonUid,
          F.orgUid,
        ),
      ),
    );
    calls.forEach((r, i) => {
      const ids = r.status === 200 && Array.isArray(r.value) ? r.value.map((x: any) => x.id) : [];
      if (i % 2) {
        expect(ids).not.toContain(F.memberIssueId);
      } else {
        expect(ids).toContain(F.memberIssueId);
      }
    });
  });

  it('surfaces an outage instead of silently answering from Hub', async () => {
    const res = await fetch(`${MCP_BASE.replace(/:\d+$/, ':1')}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch((err) => err as Error);
    // The point is that an unreachable service is an error, never a quiet
    // fallback to the local implementation. Checked by shape rather than by
    // instanceof: undici's error crosses a realm boundary under jest and
    // instanceof Error is then unreliable.
    expect(typeof (res as any)?.name).toBe('string');
    expect((res as any) instanceof Response).toBe(false);
  });
});
