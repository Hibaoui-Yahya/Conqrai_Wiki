/* eslint-disable no-console */
/**
 * The built container against a real ConqrPlan.
 *
 * Everything here crosses the container's network boundary. Importing the
 * service's classes into the test process would prove the code works and say
 * nothing about the artefact we are about to deploy - which is exactly the gap
 * that let a green build die on boot in production.
 *
 * Usage:
 *   node test/container-check.js <base-url> <fixtures.json>
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { generateKeyPairSync, sign: edSign } = require('node:crypto');

const BASE = process.argv[2];
const fixtures = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const CLIENT_TOKEN = process.env.CLIENT_TOKEN;
const HUB_KID = process.env.HUB_KID || 'hub-container-test';
const HUB_PRIVATE_PEM = fs.readFileSync(process.env.HUB_KEY_FILE, 'utf8');

const b64 = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

function assertion(personUid, scopes, opts = {}) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const header = b64(
    JSON.stringify({ alg: 'EdDSA', typ: 'CONQR-OBO', kid: opts.kid ?? HUB_KID }),
  );
  const payload = b64(
    JSON.stringify({
      sub: personUid,
      tid: opts.tid ?? fixtures.orgUid,
      aud: opts.aud ?? 'conqrplan-mcp',
      scope: scopes,
      iat: now,
      nbf: now,
      exp: now + (opts.ttl ?? 300),
      act: 'obo',
      iss: opts.iss ?? 'conqrhub',
      jti: `jti-${Math.random().toString(36).slice(2)}`,
    }),
  );
  const { createPrivateKey } = require('node:crypto');
  const key = createPrivateKey(opts.key ?? HUB_PRIVATE_PEM);
  return `${header}.${payload}.${b64(edSign(null, Buffer.from(`${header}.${payload}`), key))}`;
}

async function rpc(method, params, headers = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const authed = (personUid, scopes = ['work-item:read'], opts = {}) => ({
  Authorization: `Bearer ${CLIENT_TOKEN}`,
  'X-Conqr-Delegation': assertion(personUid, scopes, opts),
});

const toolResult = (body) => JSON.parse(body.result.content[0].text);

async function main() {
  console.log(`\nContainer check against ${BASE} (ConqrHub not running)\n`);

  await check('becomes ready without ConqrHub', async () => {
    const r = await fetch(`${BASE}/ready`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).tools, 17);
  });

  await check('exposes exactly the 17 pure ConqrPlan tools', async () => {
    const { body } = await rpc('tools/list', {});
    const names = body.result.tools.map((t) => t.name);
    assert.equal(names.length, 17);
    // The five composite tools stay Hub orchestration and must not appear.
    for (const composite of [
      'create_work_item_from_page',
      'link_page_to_work_item',
      'get_page_links',
      'get_page_work_coverage',
      'search_suite',
    ]) {
      assert.ok(!names.includes(composite), `composite tool leaked: ${composite}`);
    }
  });

  await check('bot transport without human delegation is refused', async () => {
    const { status, body } = await rpc(
      'tools/call',
      { name: 'list_conqrplan_projects', arguments: {} },
      { Authorization: `Bearer ${CLIENT_TOKEN}` },
    );
    assert.equal(status, 403);
    assert.equal(body.error, 'delegation_missing');
  });

  let memberProjects;
  await check('a valid inbound assertion is verified and exchanged', async () => {
    const { status, body } = await rpc(
      'tools/call',
      { name: 'list_conqrplan_projects', arguments: {} },
      authed(fixtures.memberPersonUid),
    );
    assert.equal(status, 200);
    memberProjects = toolResult(body);
    assert.ok(Array.isArray(memberProjects), JSON.stringify(memberProjects).slice(0, 160));
    assert.ok(
      memberProjects.some((p) => p.id === fixtures.projectId),
      'member cannot see the fixture project',
    );
  });

  await check('an unmapped identity fails closed', async () => {
    const { body } = await rpc(
      'tools/call',
      { name: 'list_conqrplan_projects', arguments: {} },
      authed('conqr:person:00000000-0000-0000-0000-000000000000'),
    );
    const text = JSON.stringify(body);
    assert.ok(!text.includes(fixtures.projectId), 'project id leaked to an unmapped identity');
  });

  await check('a disallowed scope fails closed', async () => {
    const { status, body } = await rpc(
      'tools/call',
      { name: 'list_conqrplan_projects', arguments: {} },
      authed(fixtures.memberPersonUid, ['estimate:configure']),
    );
    // Either the service refuses the exchange, or ConqrPlan refuses the token.
    const refused = status !== 200 || JSON.stringify(body).includes('error');
    assert.ok(refused, `expected refusal, got ${JSON.stringify(body).slice(0, 160)}`);
  });

  await check('an unauthorized organization fails closed', async () => {
    const { status, body } = await rpc(
      'tools/call',
      { name: 'list_conqrplan_projects', arguments: {} },
      authed(fixtures.memberPersonUid, ['work-item:read'], {
        tid: 'conqr:org:99999999-9999-9999-9999-999999999999',
      }),
    );
    assert.equal(status, 403);
    assert.equal(body.error, 'tenant_unmapped');
  });

  await check('an assertion for another audience is refused', async () => {
    const { status, body } = await rpc(
      'tools/call',
      { name: 'list_conqrplan_projects', arguments: {} },
      authed(fixtures.memberPersonUid, ['work-item:read'], { aud: 'conqrplan' }),
    );
    assert.equal(status, 403);
    assert.equal(body.error, 'delegation_wrong_audience');
  });

  await check('an unregistered key id is refused', async () => {
    const { status, body } = await rpc(
      'tools/call',
      { name: 'list_conqrplan_projects', arguments: {} },
      authed(fixtures.memberPersonUid, ['work-item:read'], { kid: 'not-registered' }),
    );
    assert.equal(status, 403);
    assert.equal(body.error, 'delegation_unknown_key');
  });

  await check('two concurrent humans never share actor or results', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        rpc(
          'tools/call',
          { name: 'search_work_items', arguments: { projectId: fixtures.projectId, limit: 50 } },
          authed(i % 2 ? fixtures.guestPersonUid : fixtures.memberPersonUid),
        ).then(({ body }) => toolResult(body)),
      ),
    );
    results.forEach((items, i) => {
      const ids = Array.isArray(items) ? items.map((x) => x.id) : [];
      if (i % 2) {
        assert.ok(
          !ids.includes(fixtures.memberIssueId),
          `guest saw another person's work item at ${i}`,
        );
      } else {
        assert.ok(ids.includes(fixtures.memberIssueId), `member lost access at ${i}`);
      }
    });
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
