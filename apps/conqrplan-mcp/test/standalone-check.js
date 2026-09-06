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
const { createHash, generateKeyPairSync, sign: edSign } = require('node:crypto');

const core = require('../../../packages/conqrplan-core/dist/index.js');
const { ConqrPlanMcpApp, createHttpServer } = require('../dist/server.js');

const CLIENT_TOKEN = 'client-token-value';
const HUB_KID = 'hub-test-key';
const MCP_KID = 'mcp-test-key';

// Test-only key pairs, generated per run. Nothing here is a production key.
const hub = generateKeyPairSync('ed25519');
const mcp = generateKeyPairSync('ed25519');
const spki = (k) => k.export({ type: 'spki', format: 'pem' });
const pkcs8 = (k) => k.export({ type: 'pkcs8', format: 'pem' });
const HUB_PUBLIC = spki(hub.publicKey);

const b64 = (b) =>
  Buffer.from(b).toString('base64').replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');

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
    let claims = {};
    let kid = null;
    try {
      const parts = String(delegation).split('.');
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      kid = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')).kid ?? null;
    } catch {
      /* leave empty */
    }
    seen.push({
      url: req.url,
      apiKey: req.headers['x-api-key'],
      sub: claims.sub ?? null,
      aud: claims.aud ?? null,
      scope: claims.scope ?? null,
      iss: claims.iss ?? null,
      exp: claims.exp ?? null,
      kid,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ results: [{ id: PROJECT, name: `seen-by:${claims.sub ?? null}` }] }),
    );
  });
  return new Promise((resolve) =>
    server.listen(0, () =>
      resolve({ server, seen, port: server.address().port }),
    ),
  );
}

/** An assertion as ConqrHub would issue it: Ed25519, addressed to this service. */
function inboundToken(personUid, orgUid, opts = {}) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const header = b64(
    JSON.stringify({
      alg: opts.alg ?? 'EdDSA',
      typ: 'CONQR-OBO',
      kid: opts.kid ?? HUB_KID,
    }),
  );
  const payload = b64(
    JSON.stringify({
      sub: personUid,
      tid: orgUid,
      aud: opts.audience ?? 'conqrplan-mcp',
      scope: opts.scope ?? [core.DELEGATED_SCOPES.workItemRead],
      iat: now,
      nbf: now,
      exp: now + (opts.ttlSeconds ?? 300),
      act: 'obo',
      iss: opts.issuer ?? 'conqrhub',
      jti: 'jti-' + Math.random().toString(36).slice(2),
    }),
  );
  const key = opts.signWith ?? hub.privateKey;
  const sig = b64(edSign(null, Buffer.from(header + '.' + payload), key));
  return header + '.' + payload + '.' + sig;
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
      // This service signs with its OWN key. It never holds ConqrPlan's.
      signingPrivateKeyPem: pkcs8(mcp.privateKey),
      signingKeyId: MCP_KID,
      issuer: 'conqrplan-mcp',
      oboAudience: 'conqrplan',
      inboundIssuers: {
        conqrhub: {
          issuer: 'conqrhub',
          algorithm: 'EdDSA',
          publicKeys: { [HUB_KID]: HUB_PUBLIC },
        },
      },
      clientTokenHashes: [createHash('sha256').update(CLIENT_TOKEN).digest('hex')],
    },
  };

  const tenants = new core.StaticTenantMappingProvider({
    tenants: [
      { orgUid: ORG, workspaceSlug: 'acme', allowedProjectIds: null },
    ],
  });

  const app = new ConqrPlanMcpApp({ config, tenants });
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

  await check('an assertion signed with the wrong private key is refused', async () => {
    const res = await callProjects({
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'X-Conqr-Delegation': inboundToken(ALICE, ORG, { signWith: mcp.privateKey }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'delegation_bad_signature');
  });

  await check('an unregistered key id is refused', async () => {
    const res = await callProjects({
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'X-Conqr-Delegation': inboundToken(ALICE, ORG, { kid: 'rotated-out' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'delegation_unknown_key');
  });

  await check('an unknown issuer is refused before any key is consulted', async () => {
    const res = await callProjects({
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'X-Conqr-Delegation': inboundToken(ALICE, ORG, { issuer: 'somebody-else' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'delegation_wrong_issuer');
  });

  await check('an algorithm the issuer does not use is refused', async () => {
    const res = await callProjects({
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'X-Conqr-Delegation': inboundToken(ALICE, ORG, { alg: 'HS256' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'delegation_bad_algorithm');
  });

  await check('the downstream token is signed by MCP, not by Hub', async () => {
    plane.seen.length = 0;
    await callProjects({
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'X-Conqr-Delegation': inboundToken(ALICE, ORG),
    });
    const call = plane.seen.at(-1);
    assert.equal(call.iss, 'conqrplan-mcp');
    assert.equal(call.kid, MCP_KID);
  });

  await check('the downstream token never outlives the assertion', async () => {
    plane.seen.length = 0;
    const shortLived = 45;
    await callProjects({
      Authorization: `Bearer ${CLIENT_TOKEN}`,
      'X-Conqr-Delegation': inboundToken(ALICE, ORG, { ttlSeconds: shortLived }),
    });
    const call = plane.seen.at(-1);
    assert.ok(
      call.exp <= Math.floor(Date.now() / 1000) + shortLived,
      'downstream expiry exceeded the inbound assertion',
    );
  });

  await check('a tool cannot claim a scope the assertion did not carry', async () => {
    await assert.rejects(
      () =>
        app.callTool({
          toolName: 'create_work_item',
          args: { projectId: PROJECT, name: 'nope' },
          bearerToken: CLIENT_TOKEN,
          delegationToken: inboundToken(ALICE, ORG, {
            scope: [core.DELEGATED_SCOPES.workItemRead],
          }),
        }),
      (err) => err.classification === 'delegation_insufficient_scope',
    );
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
    const narrowApp = new ConqrPlanMcpApp({ config, tenants: narrow });
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

  await check('a private key that is not a private key is refused at load', async () => {
    assert.throws(
      () =>
        core.loadServiceConfig({
          CONQRPLAN_API_URL: 'https://x.test/api/v1',
          CONQRPLAN_API_KEY: 'k',
          CONQRPLAN_MCP_PRIVATE_KEY_PEM: 'not-a-key',
          CONQRPLAN_MCP_KEY_ID: 'k1',
          CONQRPLAN_MCP_INBOUND_ISSUERS: '{"conqrhub":{"algorithm":"EdDSA"}}',
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
