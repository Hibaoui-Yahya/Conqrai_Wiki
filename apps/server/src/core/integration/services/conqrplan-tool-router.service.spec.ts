import { generateKeyPairSync } from 'node:crypto';
import {
  ConqrPlanToolRouter,
  UncertainMutationError,
} from './conqrplan-tool-router.service';

/**
 * The router decides which implementation answers for a ConqrPlan tool during
 * the migration. The dangerous mistakes it exists to prevent are a mutation
 * reaching both implementations, and a mutation whose outcome is unknown being
 * quietly retried somewhere else.
 */

const hub = generateKeyPairSync('ed25519');
const PRIVATE_PEM = hub.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

function makeRouter(env: Record<string, string> = {}) {
  const values: Record<string, string> = {
    CONQRPLAN_MCP_URL: 'https://mcp.test',
    CONQRPLAN_MCP_ROUTED_TOOLS: '',
    CONQRPLAN_MCP_CLIENT_TOKEN: 'client-token',
    CONQRPLAN_MCP_TIMEOUT_MS: '5000',
    CONQRPLAN_MCP_ASSERTION_TTL_SECONDS: '120',
    CONQRHUB_ASSERTION_PRIVATE_KEY_PEM: PRIVATE_PEM,
    CONQRHUB_ASSERTION_KEY_ID: 'hub-2026-09',
    CONQR_OBO_ISSUER: 'conqrhub',
    ...env,
  };
  const environment = {
    getConqrPlanMcpUrl: () => values.CONQRPLAN_MCP_URL,
    getConqrPlanMcpRoutedTools: () =>
      values.CONQRPLAN_MCP_ROUTED_TOOLS.split(',').map((s) => s.trim()).filter(Boolean),
    getConqrPlanMcpClientToken: () => values.CONQRPLAN_MCP_CLIENT_TOKEN,
    getConqrPlanMcpTimeoutMs: () => Number(values.CONQRPLAN_MCP_TIMEOUT_MS),
    getConqrPlanMcpAssertionTtlSeconds: () =>
      Number(values.CONQRPLAN_MCP_ASSERTION_TTL_SECONDS),
    getConqrHubAssertionPrivateKey: () => values.CONQRHUB_ASSERTION_PRIVATE_KEY_PEM,
    getConqrHubAssertionKeyId: () => values.CONQRHUB_ASSERTION_KEY_ID,
    getConqrOboIssuer: () => values.CONQR_OBO_ISSUER,
  };
  return new ConqrPlanToolRouter(environment as any);
}

const call = {
  toolName: 'create_work_item',
  args: { projectId: 'p', name: 'x' },
  personUid: 'conqr:person:aaaa',
  orgUid: 'conqr:org:bbbb',
  scopes: ['work-item:create'],
  mutating: true,
  idempotencyKey: 'req:page#block|project:p',
};

describe('ConqrPlanToolRouter — routing', () => {
  it('keeps every tool local by default', () => {
    // Deploying the service must change nothing until a route is turned on.
    const router = makeRouter();
    expect(router.routeFor('create_work_item')).toBe('local');
    expect(router.isRoutingAnything()).toBe(false);
  });

  it('routes only the named tools', () => {
    const router = makeRouter({ CONQRPLAN_MCP_ROUTED_TOOLS: 'get_work_item,search_work_items' });
    expect(router.routeFor('get_work_item')).toBe('mcp');
    expect(router.routeFor('create_work_item')).toBe('local');
  });

  it('routes everything on the wildcard', () => {
    const router = makeRouter({ CONQRPLAN_MCP_ROUTED_TOOLS: '*' });
    expect(router.routeFor('bulk_create_work_items')).toBe('mcp');
  });

  it('stays local when no service URL is configured, whatever is listed', () => {
    // Rollback by clearing the URL must be total, not partial.
    const router = makeRouter({ CONQRPLAN_MCP_URL: '', CONQRPLAN_MCP_ROUTED_TOOLS: '*' });
    expect(router.routeFor('get_work_item')).toBe('local');
  });
});

describe('ConqrPlanToolRouter — uncertain mutations', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports a timed-out mutation as uncertain, naming the idempotency key', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    await expect(makeRouter().callRemote(call)).rejects.toBeInstanceOf(
      UncertainMutationError,
    );
    // Substring, not a regex: the key contains characters a pattern would
    // have to escape, and the point is that the operator sees it verbatim.
    await expect(makeRouter().callRemote(call)).rejects.toThrow(
      'reading back external_id req:page#block|project:p',
    );
  });

  it('reports a 5xx on a mutation as uncertain rather than failed', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('boom', { status: 502 }) as any);
    await expect(makeRouter().callRemote(call)).rejects.toBeInstanceOf(
      UncertainMutationError,
    );
  });

  it('treats a refusal as a definite outcome, not an uncertain one', async () => {
    // 4xx means nothing was applied, so it is an ordinary error and the caller
    // may act on it without reading anything back.
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('nope', { status: 403 }) as any);
    const err: any = await makeRouter().callRemote(call).catch((e: any) => e);
    expect(err).not.toBeInstanceOf(UncertainMutationError);
    expect(err.message).toMatch(/refused/);
  });

  it('does not treat a failed read as uncertain', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const err: any = await makeRouter()
      .callRemote({ ...call, toolName: 'get_work_item', mutating: false })
      .catch((e: any) => e);
    expect(err).not.toBeInstanceOf(UncertainMutationError);
  });
});

describe('ConqrPlanToolRouter — assertion', () => {
  afterEach(() => jest.restoreAllMocks());

  it('signs an Ed25519 assertion addressed to the MCP service', async () => {
    let captured: any;
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init: any) => {
      captured = init;
      return new Response(
        JSON.stringify({ result: { content: [{ text: '{"ok":true}' }] } }),
        { status: 200 },
      ) as any;
    });

    const result = await makeRouter().callRemote({ ...call, mutating: false });
    expect(result).toEqual({ ok: true });

    const token = captured.headers['X-Conqr-Delegation'];
    const [header, payload] = token
      .split('.')
      .slice(0, 2)
      .map((p: string) => JSON.parse(Buffer.from(p, 'base64url').toString('utf8')));

    expect(header.alg).toBe('EdDSA');
    expect(header.kid).toBe('hub-2026-09');
    // Addressed to the service, not to ConqrPlan: Hub cannot mint a token
    // ConqrPlan will accept, which is the point of the split.
    expect(payload.aud).toBe('conqrplan-mcp');
    expect(payload.sub).toBe(call.personUid);
    expect(payload.tid).toBe(call.orgUid);
    expect(payload.scope).toEqual(['work-item:create']);
    expect(captured.headers.Authorization).toBe('Bearer client-token');
  });

  it('keeps the assertion short-lived', async () => {
    let captured: any;
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init: any) => {
      captured = init;
      return new Response(
        JSON.stringify({ result: { content: [{ text: 'null' }] } }),
        { status: 200 },
      ) as any;
    });
    await makeRouter().callRemote({ ...call, mutating: false });
    const payload = JSON.parse(
      Buffer.from(captured.headers['X-Conqr-Delegation'].split('.')[1], 'base64url').toString(
        'utf8',
      ),
    );
    expect(payload.exp - payload.iat).toBe(120);
  });
});
