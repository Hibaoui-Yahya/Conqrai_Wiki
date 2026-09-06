/* eslint-disable no-console */
/**
 * The MCP service against a real ConqrPlan.
 *
 * A stub proves the service's own logic; only the real product proves the
 * thing that matters most - that two people using the same transport get the
 * answers their own permissions allow, decided by ConqrPlan's database and
 * not by anything this service believes.
 *
 * Fixtures come from apps/api/seed_mcp_integration.py: a MEMBER who sees the
 * whole project and a GUEST in a project with guest_view_all_features = False,
 * who may only see work they created.
 *
 * Usage:
 *   node test/real-conqrplan-check.js <fixtures.json> <mcp-private-key.pem>
 */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign: edSign } = require('node:crypto');

const core = require('../../../packages/conqrplan-core/dist/index.js');
const { ConqrPlanMcpApp, createHttpServer } = require('../dist/server.js');

const fixtures = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const MCP_PRIVATE = fs.readFileSync(process.argv[3], 'utf8');
const PLANE_API = process.env.CONQRPLAN_API_URL || 'http://127.0.0.1:8000/api/v1';
const CLIENT_TOKEN = 'real-integration-client-token';
const HUB_KID = 'hub-local-test';

const hub = generateKeyPairSync('ed25519');
const b64 = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let passed = 0;
const timings = [];
async function check(name, fn) {
  const started = process.hrtime.bigint();
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  } finally {
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
}

function assertion(personUid, scopes, ttl = 300) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'EdDSA', typ: 'CONQR-OBO', kid: HUB_KID }));
  const payload = b64(
    JSON.stringify({
      sub: personUid,
      tid: fixtures.orgUid,
      aud: 'conqrplan-mcp',
      scope: scopes,
      iat: now,
      nbf: now,
      exp: now + ttl,
      act: 'obo',
      iss: 'conqrhub',
      jti: `jti-${Math.random().toString(36).slice(2)}`,
    }),
  );
  const sig = b64(edSign(null, Buffer.from(`${header}.${payload}`), hub.privateKey));
  return `${header}.${payload}.${sig}`;
}

async function main() {
  const app = new ConqrPlanMcpApp({
    config: {
      deployment: {
        apiBaseUrl: PLANE_API,
        port: 0,
        requestTimeoutMs: 20000,
        maxConcurrency: 8,
        rateLimitPerMinute: 10000,
        logLevel: 'error',
        serviceName: 'conqrplan-mcp',
      },
      secrets: {
        planeApiKey: fixtures.botToken,
        signingPrivateKeyPem: MCP_PRIVATE,
        signingKeyId: 'mcp-local-test',
        issuer: 'conqrplan-mcp',
        oboAudience: 'conqrplan',
        inboundIssuers: {
          conqrhub: {
            issuer: 'conqrhub',
            algorithm: 'EdDSA',
            publicKeys: { [HUB_KID]: hub.publicKey.export({ type: 'spki', format: 'pem' }) },
          },
        },
        clientTokenHashes: [createHash('sha256').update(CLIENT_TOKEN).digest('hex')],
      },
    },
    tenants: new core.StaticTenantMappingProvider({
      tenants: [
        {
          orgUid: fixtures.orgUid,
          workspaceSlug: fixtures.workspaceSlug,
          allowedProjectIds: null,
        },
      ],
    }),
  });

  const server = createHttpServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = (name, args, personUid, scopes) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CLIENT_TOKEN}`,
        'X-Conqr-Delegation': assertion(personUid, scopes),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }).then(async (r) => {
      const body = await r.json();
      if (!r.ok) return { httpStatus: r.status, error: body.error };
      return JSON.parse(body.result.content[0].text);
    });

  const READ = ['work-item:read'];
  const WRITE = ['work-item:create', 'work-item:update', 'cycle:assign', 'module:assign'];

  console.log(`\nConqrPlan MCP against real ConqrPlan at ${PLANE_API}\n`);

  await check('a member reads the project through the service', async () => {
    const items = await call(
      'search_work_items',
      { projectId: fixtures.projectId, limit: 50 },
      fixtures.memberPersonUid,
      READ,
    );
    assert.ok(Array.isArray(items), `expected a list, got ${JSON.stringify(items)}`);
    const ids = items.map((i) => i.id);
    assert.ok(ids.includes(fixtures.memberIssueId), 'member cannot see their own work item');
    assert.ok(ids.includes(fixtures.guestIssueId), 'member should see the whole project');
  });

  await check("a restricted guest sees only their own work", async () => {
    // The decisive one. Same transport, same bot credential, same project -
    // and ConqrPlan's database decides.
    const items = await call(
      'search_work_items',
      { projectId: fixtures.projectId, limit: 50 },
      fixtures.guestPersonUid,
      READ,
    );
    assert.ok(Array.isArray(items), `expected a list, got ${JSON.stringify(items)}`);
    const ids = items.map((i) => i.id);
    assert.ok(ids.includes(fixtures.guestIssueId), 'guest cannot see their own work item');
    assert.ok(
      !ids.includes(fixtures.memberIssueId),
      "guest was shown another person's work item",
    );
  });

  await check("a guest cannot read another person's item directly", async () => {
    const result = await call(
      'get_work_item',
      { projectId: fixtures.projectId, workItemId: fixtures.memberIssueId },
      fixtures.guestPersonUid,
      READ,
    );
    const text = JSON.stringify(result);
    assert.ok(
      result.error || result.httpStatus,
      `expected a refusal, got ${text.slice(0, 160)}`,
    );
    assert.ok(!text.includes('member-owned work item'), 'the title leaked in the refusal');
  });

  await check('an unmapped identity fails closed', async () => {
    const res = await call(
      'search_work_items',
      { projectId: fixtures.projectId },
      'conqr:person:00000000-0000-0000-0000-000000000000',
      READ,
    );
    assert.equal(res.httpStatus, undefined);
    assert.ok(res.error, `expected a ConqrPlan refusal, got ${JSON.stringify(res).slice(0, 120)}`);
  });

  let createdId;
  await check('a member creates a work item with complete fields', async () => {
    const created = await call(
      'create_work_item',
      {
        projectId: fixtures.projectId,
        name: 'MCPIT created through MCP',
        description: 'created by the integration check',
        priority: 'high',
        stateId: fixtures.stateId,
        externalId: `mcpit-${Date.now()}`,
      },
      fixtures.memberPersonUid,
      WRITE,
    );
    assert.ok(created.id, `create failed: ${JSON.stringify(created).slice(0, 200)}`);
    assert.equal(created.priority, 'high');
    // The REST contract returns a bare state id, not an expanded object, so
    // stateName is null on this path. That matches the local implementation
    // exactly - Hub resolves the name separately via list_work_item_states -
    // and asserting otherwise would be asserting a shape ConqrPlan does not
    // send.
    assert.equal(created.state, fixtures.stateId);
    assert.equal(created.stateName, null);
    createdId = created.id;
  });

  await check('the create is visible on read-back with its stored state', async () => {
    const item = await call(
      'get_work_item',
      { projectId: fixtures.projectId, workItemId: createdId },
      fixtures.memberPersonUid,
      READ,
    );
    assert.equal(item.id, createdId);
    assert.equal(item.priority, 'high');
    assert.equal(item.name, 'MCPIT created through MCP');
  });

  await check('an update changes only what was sent', async () => {
    const updated = await call(
      'update_work_item',
      { projectId: fixtures.projectId, workItemId: createdId, priority: 'low' },
      fixtures.memberPersonUid,
      WRITE,
    );
    assert.equal(updated.priority, 'low');
    // The unrelated field must survive a partial update.
    assert.equal(updated.state, fixtures.stateId, 'state changed on an unrelated update');
  });

  await check('a guest cannot write to another person\'s item', async () => {
    const res = await call(
      'update_work_item',
      { projectId: fixtures.projectId, workItemId: createdId, priority: 'urgent' },
      fixtures.guestPersonUid,
      WRITE,
    );
    assert.ok(res.error || res.httpStatus, `expected a refusal, got ${JSON.stringify(res)}`);
  });

  await check('bulk create reports per-item outcomes', async () => {
    const stamp = Date.now();
    const res = await call(
      'bulk_create_work_items',
      {
        projectId: fixtures.projectId,
        items: [
          { name: `MCPIT bulk A ${stamp}`, externalId: `mcpit-bulk-a-${stamp}` },
          { name: `MCPIT bulk B ${stamp}`, externalId: `mcpit-bulk-b-${stamp}` },
        ],
      },
      fixtures.memberPersonUid,
      ['work-item:bulk-create', ...WRITE],
    );
    assert.equal(res.requested, 2);
    assert.equal(res.created, 2, `bulk create failed: ${JSON.stringify(res).slice(0, 300)}`);
    assert.deepEqual(res.results.map((r) => r.index), [0, 1]);
  });

  await check('concurrent callers keep their own permissions', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call(
          'search_work_items',
          { projectId: fixtures.projectId, limit: 50 },
          i % 2 ? fixtures.guestPersonUid : fixtures.memberPersonUid,
          READ,
        ),
      ),
    );
    results.forEach((items, i) => {
      const ids = items.map((x) => x.id);
      if (i % 2) {
        assert.ok(!ids.includes(fixtures.memberIssueId), `guest leak at ${i}`);
      } else {
        assert.ok(ids.includes(fixtures.memberIssueId), `member lost access at ${i}`);
      }
    });
  });

  await check('states and labels are readable through the service', async () => {
    const states = await call(
      'list_work_item_states',
      { projectId: fixtures.projectId },
      fixtures.memberPersonUid,
      READ,
    );
    assert.ok(states.some((s) => s.name === 'Backlog'));
  });

  server.close();
  console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}`);
  const sorted = timings.slice().sort((a, b) => a - b);
  console.log(
    `latency over ${sorted.length} checks: median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)}ms, ` +
      `max ${sorted.at(-1).toFixed(0)}ms\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
