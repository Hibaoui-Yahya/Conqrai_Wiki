import { generateKeyPairSync } from 'node:crypto';
import { toolsMissingRecovery } from '@conqr/conqrplan-core';
import {
  ConqrPlanToolRouter,
  RoutingUnavailableError,
  UncertainMutationError,
} from './conqrplan-tool-router.service';

/**
 * The router decides which implementation answers for a ConqrPlan tool.
 *
 * The mistakes it exists to prevent: a mutation reaching both
 * implementations, a mutation whose outcome is unknown being retried
 * somewhere else, and a broken remote configuration quietly running locally
 * while an operator believes traffic moved.
 */

const hub = generateKeyPairSync('ed25519');
const PRIVATE_PEM = hub.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

function makeRouter(env: Record<string, string> = {}) {
  const v: Record<string, string> = {
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
    getConqrPlanMcpUrl: () => v.CONQRPLAN_MCP_URL,
    getConqrPlanMcpRoutedTools: () =>
      v.CONQRPLAN_MCP_ROUTED_TOOLS.split(',').map((s) => s.trim()).filter(Boolean),
    getConqrPlanMcpClientToken: () => v.CONQRPLAN_MCP_CLIENT_TOKEN,
    getConqrPlanMcpTimeoutMs: () => Number(v.CONQRPLAN_MCP_TIMEOUT_MS),
    getConqrPlanMcpAssertionTtlSeconds: () => Number(v.CONQRPLAN_MCP_ASSERTION_TTL_SECONDS),
    getConqrHubAssertionPrivateKey: () => v.CONQRHUB_ASSERTION_PRIVATE_KEY_PEM,
    getConqrHubAssertionKeyId: () => v.CONQRHUB_ASSERTION_KEY_ID,
    getConqrOboIssuer: () => v.CONQR_OBO_ISSUER,
  };
  return new ConqrPlanToolRouter(environment as any);
}

const create = {
  toolName: 'create_work_item',
  args: { projectId: 'p', name: 'x' },
  personUid: 'conqr:person:aaaa',
  orgUid: 'conqr:org:bbbb',
  idempotencyKey: 'req:page#block|project:p',
};
const read = { ...create, toolName: 'get_work_item' };

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status }) as any;
}

describe('ConqrPlanToolRouter — routing decisions', () => {
  it('keeps every tool local until one is listed', () => {
    const router = makeRouter();
    expect(router.routeFor('create_work_item')).toBe('local');
  });

  it('routes only the named tools', () => {
    const router = makeRouter({ CONQRPLAN_MCP_ROUTED_TOOLS: 'get_work_item' });
    expect(router.routeFor('get_work_item')).toBe('mcp');
    expect(router.routeFor('create_work_item')).toBe('local');
  });

  it('never routes a tool it does not own', () => {
    // Composite and Hub-only tools keep their existing ownership even under
    // the wildcard.
    const router = makeRouter({ CONQRPLAN_MCP_ROUTED_TOOLS: '*' });
    expect(router.routeFor('create_work_item_from_page')).toBe('local');
    expect(router.routeFor('create_page')).toBe('local');
    expect(router.routeFor('bulk_create_work_items')).toBe('mcp');
  });
});

describe('ConqrPlanToolRouter — broken remote configuration', () => {
  it('does not silently fall back to local when the URL is missing', async () => {
    // The failure an operator must see, rather than believing traffic moved.
    const router = makeRouter({
      CONQRPLAN_MCP_URL: '',
      CONQRPLAN_MCP_ROUTED_TOOLS: '*',
    });
    await expect(router.callRemote(read)).rejects.toBeInstanceOf(RoutingUnavailableError);
  });

  it('rejects a malformed service URL', async () => {
    const router = makeRouter({ CONQRPLAN_MCP_URL: 'not a url' });
    await expect(router.callRemote(read)).rejects.toThrow(/not a valid URL/);
  });

  it('rejects a non-http service URL', async () => {
    const router = makeRouter({ CONQRPLAN_MCP_URL: 'file:///etc/passwd' });
    await expect(router.callRemote(read)).rejects.toThrow(/not http/);
  });

  it('fails at boot when tools are routed but the service is unconfigured', () => {
    const router = makeRouter({
      CONQRPLAN_MCP_URL: '',
      CONQRPLAN_MCP_ROUTED_TOOLS: 'get_work_item',
    });
    expect(() => router.assertConfigurationCoherent()).toThrow(/no service URL/);
  });

  it('is coherent when nothing is routed', () => {
    expect(() =>
      makeRouter({ CONQRPLAN_MCP_URL: '' }).assertConfigurationCoherent(),
    ).not.toThrow();
  });
});

describe('ConqrPlanToolRouter — outcome classification', () => {
  afterEach(() => jest.restoreAllMocks());

  it('treats a refusal raised before the tool ran as definite', async () => {
    for (const classification of [
      'client_unauthenticated',
      'invalid_arguments',
      'tenant_unmapped',
      'project_not_approved',
      'delegation_expired',
      'rate_limited',
    ]) {
      jest.spyOn(global, 'fetch').mockResolvedValue(reply({ error: classification }, 403));
      const err: any = await makeRouter().callRemote(create).catch((e: any) => e);
      expect(err).not.toBeInstanceOf(UncertainMutationError);
      expect(err.message).toMatch(/nothing was applied/);
    }
  });

  it('treats an unrecognised 4xx on a mutation as uncertain', async () => {
    // "The server said 400" is not evidence about whether a write landed.
    jest.spyOn(global, 'fetch').mockResolvedValue(reply({ error: 'something_new' }, 409));
    await expect(makeRouter().callRemote(create)).rejects.toBeInstanceOf(
      UncertainMutationError,
    );
  });

  it('treats a 5xx on a mutation as uncertain', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(reply({ error: 'internal_error' }, 502));
    await expect(makeRouter().callRemote(create)).rejects.toBeInstanceOf(
      UncertainMutationError,
    );
  });

  it('names the idempotency key so the write can be resolved by reading back', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    await expect(makeRouter().callRemote(create)).rejects.toThrow(
      'Idempotency key: req:page#block|project:p',
    );
  });

  it('does not classify a failed read as uncertain', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(reply({ error: 'internal_error' }, 502));
    const err: any = await makeRouter().callRemote(read).catch((e: any) => e);
    expect(err).not.toBeInstanceOf(UncertainMutationError);
  });

  it('derives mutating from declared scopes, not a hand-kept list', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(reply({ error: 'internal_error' }, 502));
    // Declares estimate:configure, so it must be treated as a write.
    await expect(
      makeRouter().callRemote({ ...create, toolName: 'activate_estimate_system' }),
    ).rejects.toBeInstanceOf(UncertainMutationError);
    // Declares only estimate:read.
    const err: any = await makeRouter()
      .callRemote({ ...create, toolName: 'get_estimate_system' })
      .catch((e: any) => e);
    expect(err).not.toBeInstanceOf(UncertainMutationError);
  });

  it('returns a partial write verbatim rather than treating it as a failure', async () => {
    // A 200 carries the tool's own outcome; a partial write is definite and
    // must reach the caller exactly as the local implementation reports it.
    const partial = {
      id: 'wi-1',
      partialFailures: [{ field: 'cycleId', error: 'ConqrPlan request failed (403)' }],
    };
    jest.spyOn(global, 'fetch').mockResolvedValue(
      reply({ result: { content: [{ text: JSON.stringify(partial) }] } }),
    );
    expect(await makeRouter().callRemote(create)).toEqual(partial);
  });

  it('returns bulk per-item results verbatim', async () => {
    const bulk = {
      requested: 2,
      created: 1,
      failed: 1,
      results: [
        { index: 0, status: 'created', workItemId: 'a' },
        { index: 1, status: 'failed', error: 'boom' },
      ],
    };
    jest.spyOn(global, 'fetch').mockResolvedValue(
      reply({ result: { content: [{ text: JSON.stringify(bulk) }] } }),
    );
    expect(
      await makeRouter().callRemote({ ...create, toolName: 'bulk_create_work_items' }),
    ).toEqual(bulk);
  });
});

describe('ConqrPlanToolRouter — assertion', () => {
  afterEach(() => jest.restoreAllMocks());

  it('signs an Ed25519 assertion addressed to the service, with the tool scopes', async () => {
    let captured: any;
    jest.spyOn(global, 'fetch').mockImplementation(async (_u, init: any) => {
      captured = init;
      return reply({ result: { content: [{ text: 'null' }] } });
    });

    await makeRouter().callRemote(read);
    const [header, payload] = captured.headers['X-Conqr-Delegation']
      .split('.')
      .slice(0, 2)
      .map((p: string) => JSON.parse(Buffer.from(p, 'base64url').toString('utf8')));

    expect(header.alg).toBe('EdDSA');
    expect(header.kid).toBe('hub-2026-09');
    // Addressed to the service. Hub cannot mint a ConqrPlan-addressed token at
    // all, which is what keeps each issuer's compromise attributable.
    expect(payload.aud).toBe('conqrplan-mcp');
    expect(payload.sub).toBe(read.personUid);
    expect(payload.scope).toEqual(['work-item:read']);
    expect(payload.exp - payload.iat).toBe(120);
    expect(captured.headers.Authorization).toBe('Bearer client-token');
    expect(captured.headers['X-Conqr-Correlation-Id']).toBeTruthy();
  });
});

/**
 * "Read it back by external_id" is only true for create. Telling an operator
 * that after a failed update or comment is confidently wrong advice, which is
 * worse than none.
 */
describe('ConqrPlanToolRouter — operation-specific recovery', () => {
  afterEach(() => jest.restoreAllMocks());

  const uncertain = async (toolName: string): Promise<any> => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'internal_error' }), { status: 502 }) as any,
    );
    return makeRouter()
      .callRemote({ ...create, toolName })
      .catch((e: any) => e);
  };

  it('every mutating tool has a recorded recovery procedure', () => {
    // A gap here is a tool nobody can safely recover, which is exactly the
    // situation this table exists to prevent.
    expect(toolsMissingRecovery()).toEqual([]);
  });

  it('a create points at the idempotency key', async () => {
    const err = await uncertain('create_work_item');
    expect(err.message).toMatch(/Operation type: create/);
    expect(err.message).toMatch(/external_id/);
  });

  it('an update does not claim the key resolves it', async () => {
    const err = await uncertain('update_work_item');
    expect(err.message).toMatch(/Operation type: update/);
    expect(err.message).toMatch(/recent activity/);
    expect(err.message).toMatch(/overwrite their change/);
  });

  it('a bulk create recovers per row and preserves partial results', async () => {
    const err = await uncertain('bulk_create_work_items');
    expect(err.message).toMatch(/Operation type: bulk-create/);
    expect(err.message).toMatch(/each row independently/);
    expect(err.message).toMatch(/created a second time/);
  });

  it('a comment warns that a blind retry duplicates it publicly', async () => {
    const err = await uncertain('add_work_item_comment');
    expect(err.message).toMatch(/Operation type: comment/);
    expect(err.message).toMatch(/duplicates the comment/);
  });

  it('an estimate change says to check both activation markers', async () => {
    const err = await uncertain('activate_estimate_system');
    expect(err.message).toMatch(/Operation type: estimate-config/);
    expect(err.message).toMatch(/both activation markers/);
  });
});
