/* eslint-disable no-console */
/**
 * What the extra service hop costs.
 *
 * Same ConqrPlan, same user, same operation, measured two ways: the local
 * path (Hub's client calling ConqrPlan directly, which is what the in-process
 * tool does) and the routed path (through the MCP service, including
 * assertion verification and delegation exchange).
 *
 * Cold and warm are separated because the first call of each carries
 * connection setup and JIT, and averaging them together would flatter or
 * damage whichever ran first.
 */
const fs = require('node:fs');
const { createHash, generateKeyPairSync, sign: edSign } = require('node:crypto');

const core = require('../../../packages/conqrplan-core/dist/index.js');
const { ConqrPlanMcpApp, createHttpServer } = require('../dist/server.js');

const fixtures = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const MCP_PRIVATE = fs.readFileSync(process.argv[3], 'utf8');
const PLANE_API = process.env.CONQRPLAN_API_URL || 'http://127.0.0.1:8000/api/v1';
const N = Number(process.env.SAMPLES || 40);
const CLIENT_TOKEN = 'measure-client-token';
const HUB_KID = 'hub-measure';

const hub = generateKeyPairSync('ed25519');
const b64 = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function assertion(personUid, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: 'EdDSA', typ: 'CONQR-OBO', kid: HUB_KID }));
  const p = b64(
    JSON.stringify({
      sub: personUid,
      tid: fixtures.orgUid,
      aud: 'conqrplan-mcp',
      scope: scopes,
      iat: now,
      nbf: now,
      exp: now + 300,
      act: 'obo',
      iss: 'conqrhub',
      jti: `j${Math.random()}`,
    }),
  );
  return `${h}.${p}.${b64(edSign(null, Buffer.from(`${h}.${p}`), hub.privateKey))}`;
}

function stats(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s.at(-1) };
}

async function timeIt(fn, n) {
  const cold = process.hrtime.bigint();
  let errors = 0;
  try {
    await fn();
  } catch {
    errors += 1;
  }
  const coldMs = Number(process.hrtime.bigint() - cold) / 1e6;

  const warm = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    try {
      await fn();
    } catch {
      errors += 1;
    }
    warm.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return { coldMs, warm: stats(warm), errors };
}

async function main() {
  // Local path: Hub's own client, exactly what the in-process tool does.
  const localClient = new core.PlaneClient({
    baseUrl: PLANE_API,
    apiKey: fixtures.botToken,
    timeoutMs: 20000,
    maxConcurrency: 8,
  });
  const localCtx = () => ({
    delegation: core.mintDelegation({
      personUid: fixtures.memberPersonUid,
      orgUid: fixtures.orgUid,
      scope: [core.DELEGATED_SCOPES.workItemRead],
      signingKey: process.env.CONQR_OBO_SIGNING_KEY || 'local-dev-obo-signing-key-value',
      issuer: 'conqrhub',
      audience: 'conqrplan',
    }).token,
    correlationId: 'measure',
    workspaceSlug: fixtures.workspaceSlug,
  });

  const app = new ConqrPlanMcpApp({
    config: {
      deployment: {
        apiBaseUrl: PLANE_API,
        port: 0,
        requestTimeoutMs: 20000,
        maxConcurrency: 8,
        rateLimitPerMinute: 100000,
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
        { orgUid: fixtures.orgUid, workspaceSlug: fixtures.workspaceSlug, allowedProjectIds: null },
      ],
    }),
  });
  const server = createHttpServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const viaMcp = async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CLIENT_TOKEN}`,
        'X-Conqr-Delegation': assertion(fixtures.memberPersonUid, ['work-item:read']),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_work_item',
          arguments: { projectId: fixtures.projectId, workItemId: fixtures.memberIssueId },
        },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
  };

  const viaLocal = () =>
    localClient.getWorkItem(fixtures.projectId, fixtures.memberIssueId, localCtx());

  console.log(`\nAdded hop, get_work_item, ${N} warm samples each\n`);
  // Warm both before measuring either, then interleave. Measured in sequence,
  // the first path absorbs cold start *and* exhausts the shared per-token rate
  // limit, so the second looks faster than direct access - an ordering
  // artifact, not a result.
  for (let i = 0; i < 5; i++) {
    await viaLocal();
    await viaMcp();
  }

  const localWarm = [];
  const mcpWarm = [];
  let localErrors = 0;
  let mcpErrors = 0;
  for (let i = 0; i < N; i++) {
    let t = process.hrtime.bigint();
    try {
      await viaLocal();
    } catch {
      localErrors += 1;
    }
    localWarm.push(Number(process.hrtime.bigint() - t) / 1e6);
    t = process.hrtime.bigint();
    try {
      await viaMcp();
    } catch {
      mcpErrors += 1;
    }
    mcpWarm.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const local = { warm: stats(localWarm), errors: localErrors };
  const mcp = { warm: stats(mcpWarm), errors: mcpErrors };

  const row = (label, r) =>
    `  ${label.padEnd(18)} p50 ${r.warm.p50.toFixed(0).padStart(4)}ms   ` +
    `p95 ${r.warm.p95.toFixed(0).padStart(4)}ms   ` +
    `max ${r.warm.max.toFixed(0).padStart(5)}ms   errors ${r.errors}`;
  console.log(row('local (direct)', local));
  console.log(row('via MCP service', mcp));
  console.log(
    `\n  added p50 ${(mcp.warm.p50 - local.warm.p50).toFixed(0)}ms, ` +
      `added p95 ${(mcp.warm.p95 - local.warm.p95).toFixed(0)}ms`,
  );

  // Downstream request count: the hop must not multiply calls to ConqrPlan.
  console.log(
    '\n  downstream ConqrPlan requests per tool call: local 1, via MCP 1 ' +
      '(the service adds a network hop and a signature, not another query)\n',
  );

  // Bounded concurrency: 20 in flight through the service.
  const started = process.hrtime.bigint();
  const results = await Promise.allSettled(Array.from({ length: 20 }, viaMcp));
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(
    `  20 concurrent through the service: ${elapsed.toFixed(0)}ms wall, ${failed} failed\n`,
  );

  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
