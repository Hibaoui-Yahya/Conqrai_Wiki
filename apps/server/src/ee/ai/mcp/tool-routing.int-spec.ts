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

describe('Hub tool routing reaches the extracted MCP service', () => {
  let planeSeen: any[];
  let planeServer: Server;
  let mcpServer: Server;
  let registry: ChatToolRegistry;
  let localRan: string[];

  const ctx = {
    user: { id: USER_UUID } as any,
    workspaceId: ORG_UUID,
  };

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
    const mcpPort = (mcpServer.address() as any).port;

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

    localRan = [];
    registry = new ChatToolRegistry(new ConqrPlanToolRouter(environment as any));
    for (const name of ['get_work_item', 'search_work_items']) {
      registry.register({
        name,
        description: `local ${name}`,
        parameters: z.object({ projectId: z.string(), workItemId: z.string().optional() }),
        execute: async () => {
          localRan.push(name);
          return { ranLocally: true };
        },
      } as any);
    }
  });

  afterAll(() => {
    planeServer?.close();
    mcpServer?.close();
  });

  beforeEach(() => {
    planeSeen.length = 0;
    localRan.length = 0;
  });

  it('the chat entry point reaches the service, not the local tool', async () => {
    const tools = registry.toAiSdkTools(ctx as any);
    const result: any = await (tools.get_work_item as any).execute({
      projectId: PROJECT,
      workItemId: 'wi-1',
    });

    expect(localRan).toEqual([]);
    expect(planeSeen).toHaveLength(1);
    expect(planeSeen[0].sub).toBe(`conqr:person:${USER_UUID}`);
    expect(planeSeen[0].tid).toBe(`conqr:org:${ORG_UUID}`);
    // Re-addressed to ConqrPlan by the service, not forwarded by Hub.
    expect(planeSeen[0].aud).toBe('conqrplan');
    expect(result.name).toBe(`answered-for:conqr:person:${USER_UUID}`);
  });

  it('the MCP entry point reaches the service, not the local tool', async () => {
    const service = new McpService(registry);
    const response = await service.handleRequest(
      {
        method: 'tools/call',
        params: { name: 'get_work_item', arguments: { projectId: PROJECT, workItemId: 'wi-1' } },
      },
      { user: { id: USER_UUID }, workspace: { id: ORG_UUID } } as any,
    );

    expect(localRan).toEqual([]);
    expect(planeSeen).toHaveLength(1);
    expect(planeSeen[0].sub).toBe(`conqr:person:${USER_UUID}`);
    const text = JSON.parse(response.content[0].text);
    expect(text.name).toBe(`answered-for:conqr:person:${USER_UUID}`);
  });

  it('an unrouted tool still runs locally on both entry points', async () => {
    const tools = registry.toAiSdkTools(ctx as any);
    await (tools.search_work_items as any).execute({ projectId: PROJECT });

    const service = new McpService(registry);
    await service.handleRequest(
      { method: 'tools/call', params: { name: 'search_work_items', arguments: { projectId: PROJECT } } },
      { user: { id: USER_UUID }, workspace: { id: ORG_UUID } } as any,
    );

    expect(localRan).toEqual(['search_work_items', 'search_work_items']);
    expect(planeSeen).toEqual([]);
  });

  it('both entry points name the same human for the same caller', async () => {
    const tools = registry.toAiSdkTools(ctx as any);
    await (tools.get_work_item as any).execute({ projectId: PROJECT, workItemId: 'wi-1' });
    const viaChat = planeSeen[0].sub;

    planeSeen.length = 0;
    await new McpService(registry).handleRequest(
      { method: 'tools/call', params: { name: 'get_work_item', arguments: { projectId: PROJECT, workItemId: 'wi-1' } } },
      { user: { id: USER_UUID }, workspace: { id: ORG_UUID } } as any,
    );

    expect(planeSeen[0].sub).toBe(viaChat);
  });
});
