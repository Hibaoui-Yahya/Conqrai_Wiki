import { createServer, Server } from 'node:http';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { z } from 'zod';
import { ChatToolRegistry } from '../chat/tools/chat-tool.registry';
import { ConqrPlanToolRouter } from '../../../core/integration/services/conqrplan-tool-router.service';
import { McpService } from './mcp.service';

/**
 * Both of Hub's tool entry points must actually reach the extracted service.
 *
 * A router unit test proves the router works; it does not prove the chat
 * surface and the MCP surface are wired to it. This drives the two real entry
 * points - `toAiSdkTools(...).execute` and `McpService.handleRequest` - with
 * the real MCP service running in-process, and asserts the call arrived at
 * ConqrPlan with the right human named, and that the local implementation was
 * not also invoked.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('@conqr/conqrplan-core');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ConqrPlanMcpApp, createHttpServer } = require('../../../../../conqrplan-mcp/dist/server.js');

const hub = generateKeyPairSync('ed25519');
const mcp = generateKeyPairSync('ed25519');
const HUB_KID = 'hub-int-test';
const CLIENT_TOKEN = 'int-test-client-token';

const ORG_UUID = '019dc8f3-7a14-7473-ad91-5d7c44862cd6';
const USER_UUID = '019dc8f3-7a10-707b-9f28-93aba84556e0';
const PROJECT = '3fedb71d-f118-4565-99a4-3962b2732614';

let planeSeen: any[] = [];
let localCalls: string[] = [];
let planeServer: Server;
let mcpServer: Server;
let mcpPort = 0;
let defaultRegistry: ChatToolRegistry;
const mcpBase = () => `http://127.0.0.1:${mcpPort}`;
const ctxFor = () => ({ user: { id: USER_UUID } as any, workspaceId: ORG_UUID });

/** A registry wired to a router with the given routing configuration. */
function buildRegistry(opts: { routed: string[] | (() => string[]); url: string }) {
  const routedOf = () =>
    typeof opts.routed === 'function' ? opts.routed() : opts.routed;
  const environment = {
    getConqrPlanMcpUrl: () => opts.url,
    getConqrPlanMcpRoutedTools: routedOf,
    getConqrPlanMcpClientToken: () => CLIENT_TOKEN,
    getConqrPlanMcpTimeoutMs: () => 5000,
    getConqrPlanMcpAssertionTtlSeconds: () => 120,
    getConqrHubAssertionPrivateKey: () =>
      hub.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    getConqrHubAssertionKeyId: () => HUB_KID,
    getConqrOboIssuer: () => 'conqrhub',
  };
  const registry = new ChatToolRegistry(new ConqrPlanToolRouter(environment as any));
  for (const name of ['get_work_item', 'search_work_items']) {
    registry.register({
      name,
      description: `local ${name}`,
      parameters: z.object({ projectId: z.string(), workItemId: z.string().optional() }),
      execute: async () => {
        localCalls.push(name);
        return { ranLocally: true };
      },
    } as any);
  }
  return registry;
}

beforeAll(async () => {
  planeSeen = [];
  planeServer = createServer((req, res) => {
    let claims: any = {};
    try {
      claims = JSON.parse(
        Buffer.from(
          String(req.headers['x-conqr-delegation']).split('.')[1],
          'base64url',
        ).toString('utf8'),
      );
    } catch {
      /* ignore */
    }
    planeSeen.push({ url: req.url, sub: claims.sub, tid: claims.tid, aud: claims.aud });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'wi-1', name: `answered-for:${claims.sub}` }));
  });
  await new Promise<void>((r) => planeServer.listen(0, r));
  const planePort = (planeServer.address() as any).port;

  const app = new ConqrPlanMcpApp({
    config: {
      deployment: {
        apiBaseUrl: `http://127.0.0.1:${planePort}`,
        port: 0,
        requestTimeoutMs: 5000,
        maxConcurrency: 8,
        rateLimitPerMinute: 1000,
        logLevel: 'error',
        serviceName: 'conqrplan-mcp',
      },
      secrets: {
        planeApiKey: 'plane_api_stub',
        signingPrivateKeyPem: mcp.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        signingKeyId: 'mcp-int-test',
        issuer: 'conqrplan-mcp',
        oboAudience: 'conqrplan',
        inboundIssuers: {
          conqrhub: {
            issuer: 'conqrhub',
            algorithm: 'EdDSA',
            publicKeys: {
              [HUB_KID]: hub.publicKey.export({ type: 'spki', format: 'pem' }),
            },
          },
        },
        clientTokenHashes: [createHash('sha256').update(CLIENT_TOKEN).digest('hex')],
      },
    },
    tenants: new core.StaticTenantMappingProvider({
      tenants: [
        {
          orgUid: `conqr:org:${ORG_UUID}`,
          workspaceSlug: 'conqrvantage',
          allowedProjectIds: null,
        },
      ],
    }),
  });
  mcpServer = createHttpServer(app);
  await new Promise<void>((r) => mcpServer.listen(0, r));
  mcpPort = (mcpServer.address() as any).port;

  const environment = {
    getConqrPlanMcpUrl: () => `http://127.0.0.1:${mcpPort}`,
    getConqrPlanMcpRoutedTools: () => ['get_work_item'],
    getConqrPlanMcpClientToken: () => CLIENT_TOKEN,
    getConqrPlanMcpTimeoutMs: () => 5000,
    getConqrPlanMcpAssertionTtlSeconds: () => 120,
    getConqrHubAssertionPrivateKey: () =>
      hub.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    getConqrHubAssertionKeyId: () => HUB_KID,
    getConqrOboIssuer: () => 'conqrhub',
  };

  defaultRegistry = buildRegistry({ routed: ['get_work_item'], url: mcpBase() });
});

afterAll(() => {
  planeServer?.close();
  mcpServer?.close();
});


describe('Hub tool routing reaches the extracted MCP service', () => {

  const ctx = {
    user: { id: USER_UUID } as any,
    workspaceId: ORG_UUID,
  };

  beforeEach(() => {
    planeSeen.length = 0;
    localCalls.length = 0;
  });

  it('the chat entry point reaches the service, not the local tool', async () => {
    const tools = defaultRegistry.toAiSdkTools(ctx as any);
    const result: any = await (tools.get_work_item as any).execute({
      projectId: PROJECT,
      workItemId: 'wi-1',
    });

    expect(localCalls).toEqual([]);
    expect(planeSeen).toHaveLength(1);
    expect(planeSeen[0].sub).toBe(`conqr:person:${USER_UUID}`);
    expect(planeSeen[0].tid).toBe(`conqr:org:${ORG_UUID}`);
    // Re-addressed to ConqrPlan by the service, not forwarded by Hub.
    expect(planeSeen[0].aud).toBe('conqrplan');
    expect(result.name).toBe(`answered-for:conqr:person:${USER_UUID}`);
  });

  it('the MCP entry point reaches the service, not the local tool', async () => {
    const service = new McpService(defaultRegistry);
    const response = await service.handleRequest(
      {
        method: 'tools/call',
        params: { name: 'get_work_item', arguments: { projectId: PROJECT, workItemId: 'wi-1' } },
      },
      { user: { id: USER_UUID }, workspace: { id: ORG_UUID } } as any,
    );

    expect(localCalls).toEqual([]);
    expect(planeSeen).toHaveLength(1);
    expect(planeSeen[0].sub).toBe(`conqr:person:${USER_UUID}`);
    const text = JSON.parse(response.content[0].text);
    expect(text.name).toBe(`answered-for:conqr:person:${USER_UUID}`);
  });

  it('an unrouted tool still runs locally on both entry points', async () => {
    const tools = defaultRegistry.toAiSdkTools(ctx as any);
    await (tools.search_work_items as any).execute({ projectId: PROJECT });

    const service = new McpService(defaultRegistry);
    await service.handleRequest(
      { method: 'tools/call', params: { name: 'search_work_items', arguments: { projectId: PROJECT } } },
      { user: { id: USER_UUID }, workspace: { id: ORG_UUID } } as any,
    );

    expect(localCalls).toEqual(['search_work_items', 'search_work_items']);
    expect(planeSeen).toEqual([]);
  });

  it('both entry points name the same human for the same caller', async () => {
    const tools = defaultRegistry.toAiSdkTools(ctx as any);
    await (tools.get_work_item as any).execute({ projectId: PROJECT, workItemId: 'wi-1' });
    const viaChat = planeSeen[0].sub;

    planeSeen.length = 0;
    await new McpService(defaultRegistry).handleRequest(
      { method: 'tools/call', params: { name: 'get_work_item', arguments: { projectId: PROJECT, workItemId: 'wi-1' } } },
      { user: { id: USER_UUID }, workspace: { id: ORG_UUID } } as any,
    );

    expect(planeSeen[0].sub).toBe(viaChat);
  });
});

/**
 * The routing policy, proved through both real dispatch entry points.
 *
 * The row that matters most is the third: a non-empty routed list with the
 * service unconfigured must fail, not quietly run locally. Removing the URL
 * while names remain listed is not a rollback - it is a broken configuration
 * that would otherwise look like a successful one.
 */
describe('routing policy table, both entry points', () => {
  beforeEach(() => {
    planeSeen.length = 0;
    localCalls.length = 0;
  });

  const bothEntryPoints = async (registry: ChatToolRegistry, toolName: string) => {
    const viaChat = await (registry.toAiSdkTools(ctxFor()) as any)[toolName]
      .execute({ projectId: PROJECT, workItemId: 'wi-1' })
      .then((r: unknown) => ({ ok: true, r }))
      .catch((e: Error) => ({ ok: false, e }));
    const viaMcp = await new McpService(registry)
      .handleRequest(
        {
          method: 'tools/call',
          params: { name: toolName, arguments: { projectId: PROJECT, workItemId: 'wi-1' } },
        },
        { user: { id: USER_UUID }, workspace: { id: ORG_UUID } } as any,
      )
      .then((r: any) => ({ ok: true, r }))
      .catch((e: Error) => ({ ok: false, e }));
    return { viaChat, viaMcp };
  };

  it('empty list, configured URL -> both entry points run locally', async () => {
    const registry = buildRegistry({ routed: [], url: mcpBase() });
    await bothEntryPoints(registry, 'get_work_item');
    expect(localCalls).toEqual(['get_work_item', 'get_work_item']);
    expect(planeSeen).toEqual([]);
  });

  it('empty list, missing URL -> both entry points run locally', async () => {
    const registry = buildRegistry({ routed: [], url: '' });
    await bothEntryPoints(registry, 'get_work_item');
    expect(localCalls).toEqual(['get_work_item', 'get_work_item']);
  });

  it('non-empty list, valid URL -> both entry points run remotely', async () => {
    const registry = buildRegistry({ routed: ['get_work_item'], url: mcpBase() });
    await bothEntryPoints(registry, 'get_work_item');
    expect(localCalls).toEqual([]);
    expect(planeSeen).toHaveLength(2);
  });

  it('non-empty list, missing URL -> both entry points fail, neither falls back', async () => {
    const registry = buildRegistry({ routed: ['get_work_item'], url: '' });
    const { viaChat, viaMcp } = await bothEntryPoints(registry, 'get_work_item');
    expect(localCalls).toEqual([]);
    expect(planeSeen).toEqual([]);
    expect((viaChat as any).ok).toBe(false);
    expect((viaChat as any).e.name).toBe('RoutingUnavailableError');
    // The MCP surface reports the failure rather than answering locally.
    const mcpFailed =
      (viaMcp as any).ok === false || (viaMcp as any).r?.isError === true;
    expect(mcpFailed).toBe(true);
  });

  it('tool not listed -> runs locally even while another tool is routed', async () => {
    const registry = buildRegistry({ routed: ['get_work_item'], url: mcpBase() });
    await bothEntryPoints(registry, 'search_work_items');
    expect(localCalls).toEqual(['search_work_items', 'search_work_items']);
    expect(planeSeen).toEqual([]);
  });

  it('a configuration change does not move an in-flight request', async () => {
    // Route is chosen once per request; flipping configuration mid-flight must
    // affect only what comes after.
    let routed = ['get_work_item'];
    const registry = buildRegistry({ routed: () => routed, url: mcpBase() });
    const inFlight = (registry.toAiSdkTools(ctxFor()) as any).get_work_item.execute({
      projectId: PROJECT,
      workItemId: 'wi-1',
    });
    routed = [];
    await inFlight;
    expect(planeSeen).toHaveLength(1);
    expect(localCalls).toEqual([]);

    await (registry.toAiSdkTools(ctxFor()) as any).get_work_item.execute({
      projectId: PROJECT,
      workItemId: 'wi-1',
    });
    expect(localCalls).toEqual(['get_work_item']);
  });
});
