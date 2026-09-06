/* eslint-disable no-console */
/**
 * Standalone proof for the ConqrPlan MCP service.
 *
 * Runs the real service against a stub ConqrPlan, with ConqrHub not running
 * and not importable. Everything asserted here is behaviour the extraction
 * claims: it starts on its own configuration, serves the seventeen tools,
 * establishes the human actor only from a signed delegation, exchanges that
 * delegation rather than forwarding it, and keeps two concurrent callers apart.
 *
 * Plain Node so it can run anywhere the service can, including a container
 * that has no test runner.
 */
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const core = require('../../../packages/conqrplan-core/dist/index.js');
const { ConqrPlanMcpApp, createHttpServer } = require('../dist/server.js');

const INBOUND_KEY = 'inbound-key-that-is-long-enough-for-validation';
const OBO_KEY = 'conqrplan-key-that-is-long-enough-for-validation';
const CLIENT_TOKEN = 'client-token-value';

const ORG = 'conqr:org:11111111-1111-1111-1111-111111111111';
const OTHER_ORG = 'conqr:org:22222222-2222-2222-2222-222222222222';
const ALICE = 'conqr:person:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOB = 'conqr:person:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PROJECT = '33333333-3333-3333-3333-333333333333';

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  PASS  ${name}`);
    })
    .catch((err) => {
      console.error(`  FAIL  ${name}\n        ${err.message}`);
      process.exitCode = 1;
    });
}

/** Stub ConqrPlan: echoes back which human the delegation named. */
function startStubPlane() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const delegation = req.headers['x-conqr-delegation'];
    let sub = null;
    let aud = null;
    let scope = null;
    try {
      const payload = JSON.parse(
        Buffer.from(String(delegation).split('.')[1], 'base64url').toString('utf8'),
      );
      sub = payload.sub;
      aud = payload.aud;
      scope = payload.scope;
    } catch {
      /* leave null */
    }
    seen.push({ url: req.url, apiKey: req.headers['x-api-key'], sub, aud, scope });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [{ id: PROJECT, name: `seen-by:${sub}` }] }));
  });
  return new Promise((resolve) =>
    server.listen(0, () =>
      resolve({ server, seen, port: server.address().port }),
    ),
  );
}

function inboundToken(personUid, orgUid, opts = {}) {
  return core.mintDelegation({
    personUid,
    orgUid,
    scope: [core.DELEGATED_SCOPES.workItemRead],
    signingKey: opts.key ?? INBOUND_KEY,
    issuer: 'conqrhub',
    audience: opts.audience ?? 'conqrplan-mcp',
    ttlSeconds: opts.ttlSeconds ?? 300,
    now: opts.now,
  }).token;
}

async function main() {
  const plane = await startStubPlane();

  const config = {
    deployment: {
      apiBaseUrl: `http://127.0.0.1:${plane.port}`,
      port: 0,
      requestTimeoutMs: 5000,
      maxConcurrency: 8,
      rateLimitPerMinute: 1000,
      logLevel: 'error',
      serviceName: 'conqrplan-mcp',
    },
    secrets: {
      planeApiKey: 'plane_api_stub',
      oboSigningKey: OBO_KEY,
      oboIssuer: 'conqrhub',
      oboAudience: 'conqrplan',
      clientTokenHashes: [createHash('sha256').update(CLIENT_TOKEN).digest('hex')],
    },
  };

  const tenants = new core.StaticTenantMappingProvider({
    tenants: [
      { orgUid: ORG, workspaceSlug: 'acme', allowedProjectIds: null },
    ],
  });

  const app = new ConqrPlanMcpApp({ config, tenants, inboundSigningKey: INBOUND_KEY });
  const server = createHttpServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const rpc = (body, headers = {}) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  console.log('\nConqrPlan MCP standalone check (ConqrHub not running)\n');

  await check('service is healthy and ready without Hub', async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const ready = await (await fetch(`${base}/ready`)).json();
    assert.equal(ready.status, 'ready');
    assert.equal(ready.tools, 17);
  });

  await check('advertises the seventeen ConqrPlan tools', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const body = await res.json();
    const names = body.result.tools.map((t) => t.name);
    assert.equal(names.length, 17);
    for (const expected of [
      'list_conqrplan_projects',
      'search_work_items',
      'get_work_item',
      'create_work_item',
      'update_work_item',
      'bulk_create_work_items',
      'activate_estimate_system',
    ]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
  });

  const callProjects = (headers) =>
    rpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_conqrplan_projects', arguments: {} },
      },
      headers,
    );

  await check('no bearer token is refused', async () => {
    assert.equal((await callProjects({})).status, 401);
  });

  await check('unknown bearer token is refused', async () => {
    const res = await callProjects({ Authorization: 'Bearer wrong-token' });
    assert.equal(res.status, 401);
  });

  await check('authenticated client with no delegation names no human', async () => {
    const res = await callProjects({ Authorization: `Bearer ${CLIENT_TOKEN}` });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'delegation_missing');
  });

  await check('a delegation addressed to ConqrPlan is not accepted here', async () => {
    // Signed, valid, and for the wrong audience. Being signed with a key we
    // hold does not make it addressed to this service.
    const res = await callProjects({
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'X-Conqr-Delegation': inboundToken(ALICE, ORG, { audience: 'conqrplan' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'delegation_wrong_audience');
  });

  await check('a delegation signed with the wrong key is refused', async () => {
    const res = await callProjects({
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'X-Conqr-Delegation': inboundToken(ALICE, ORG, { key: OBO_KEY }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'delegation_bad_signature');
  });

  await check('an expired delegation is refused', async () => {
    const res = await callProjects({
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'X-Conqr-Delegation': inboundToken(ALICE, ORG, {
        now: Math.floor(Date.now() / 1000) - 3600,
      }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'delegation_expired');
  });

  await check('an unapproved tenant fails closed', async () => {
    const res = await callProjects({
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'X-Conqr-Delegation': inboundToken(ALICE, OTHER_ORG),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'tenant_unmapped');
  });

  await check('an unsigned userId argument cannot set the actor', async () => {
    const res = await rpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'list_conqrplan_projects',
          arguments: { userId: BOB, personUid: BOB, orgUid: OTHER_ORG },
        },
      },
      {
        Authorization: `Bearer ${CLIENT_TOKEN}`,
        'X-Conqr-Delegation': inboundToken(ALICE, ORG),
      },
    );
    assert.equal(res.status, 200);
    const text = JSON.parse((await res.json()).result.content[0].text);
    // ConqrPlan saw Alice, the signed subject - not the argument.
    assert.equal(text[0].name, `seen-by:${ALICE}`);
  });

  await check('the delegation is exchanged, not forwarded', async () => {
    plane.seen.length = 0;
    await callProjects({
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'X-Conqr-Delegation': inboundToken(ALICE, ORG),
    });
    const call = plane.seen.at(-1);
    // Re-addressed to ConqrPlan, and carrying only this tool's scope.
    assert.equal(call.aud, 'conqrplan');
    assert.deepEqual(call.scope, ['work-item:read']);
    assert.equal(call.sub, ALICE);
    assert.equal(call.apiKey, 'plane_api_stub');
  });

  await check('two concurrent callers never mix actor or tenant', async () => {
    plane.seen.length = 0;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        callProjects({
          Authorization: `Bearer ${CLIENT_TOKEN}`,
          'X-Conqr-Delegation': inboundToken(i % 2 ? BOB : ALICE, ORG),
        }).then(async (r) =>
          JSON.parse((await r.json()).result.content[0].text)[0].name,
        ),
      ),
    );
    results.forEach((name, i) => {
      assert.equal(name, `seen-by:${i % 2 ? BOB : ALICE}`);
    });
  });

  await check('a project outside the tenant allow-list is refused', async () => {
    const narrow = new core.StaticTenantMappingProvider({
      tenants: [
        { orgUid: ORG, workspaceSlug: 'acme', allowedProjectIds: [PROJECT] },
      ],
    });
    const narrowApp = new ConqrPlanMcpApp({
      config,
      tenants: narrow,
      inboundSigningKey: INBOUND_KEY,
    });
    await assert.rejects(
      () =>
        narrowApp.callTool({
          toolName: 'get_work_item',
          args: { projectId: '99999999-9999-9999-9999-999999999999', workItemId: 'w1' },
          bearerToken: CLIENT_TOKEN,
          delegationToken: inboundToken(ALICE, ORG),
        }),
      (err) => err.classification === 'project_not_approved' && err.status === 403,
    );
  });

  await check('invalid tool arguments are rejected before any call', async () => {
    plane.seen.length = 0;
    const res = await rpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_work_item', arguments: { projectId: 123 } },
      },
      {
        Authorization: `Bearer ${CLIENT_TOKEN}`,
        'X-Conqr-Delegation': inboundToken(ALICE, ORG),
      },
    );
    assert.equal(res.status, 400);
    assert.equal(plane.seen.length, 0);
  });

  await check('missing configuration fails clearly, naming the variable', async () => {
    assert.throws(
      () => core.loadServiceConfig({ CONQRPLAN_API_URL: 'https://x.test/api/v1' }),
      /Missing required configuration: CONQRPLAN_API_KEY/,
    );
  });

  await check('a too-short signing key is refused at load', async () => {
    assert.throws(
      () =>
        core.loadServiceConfig({
          CONQRPLAN_API_URL: 'https://x.test/api/v1',
          CONQRPLAN_API_KEY: 'k',
          CONQR_OBO_SIGNING_KEY: 'short',
          CONQRPLAN_MCP_CLIENT_TOKEN_SHA256: 'a'.repeat(64),
        }),
      /Invalid secret configuration/,
    );
  });

  server.close();
  plane.server.close();
  console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
