import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { ChatToolRegistry } from './chat-tool.registry';
import { ChatTool, ChatToolContext } from './chat-tool.types';

/**
 * What the dispatch log has to say.
 *
 * The rollout of the extracted MCP service is read off these lines, and the
 * first version of them only logged the remote route. That is the one shape
 * that cannot detect its own failure: a tool that quietly stops being routed
 * emits nothing, which is indistinguishable from nobody having called it. So
 * a routable tool is logged on both routes, and everything else stays out of
 * the log entirely.
 */

const ctx = {
  user: { id: '019dc8f3-7a10-707b-9f28-93aba84556e0' },
  workspaceId: '019dc8f3-7a14-7473-ad91-5d7c44862cd6',
} as unknown as ChatToolContext;

function toolNamed(name: string, execute = async () => 'result'): ChatTool {
  return {
    name,
    description: name,
    parameters: z.object({}),
    execute,
  } as unknown as ChatTool;
}

/** Only the fields the router is asked for during dispatch. */
function routerStub(opts: {
  routable: string[];
  routed: string[];
  remote?: () => Promise<unknown>;
}) {
  return {
    isRoutable: (name: string) => opts.routable.includes(name),
    routeFor: (name: string) =>
      opts.routable.includes(name) && opts.routed.includes(name) ? 'mcp' : 'local',
    callRemote: opts.remote ?? (async () => 'remote-result'),
  } as any;
}

describe('ChatToolRegistry dispatch logging', () => {
  let lines: string[];
  let warnings: string[];

  beforeEach(() => {
    lines = [];
    warnings = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: any) => {
      lines.push(String(m));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => {
      warnings.push(String(m));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs a routable tool that ran locally, so the rollout has a baseline', async () => {
    const registry = new ChatToolRegistry(
      routerStub({ routable: ['list_conqrplan_projects'], routed: [] }),
    );

    const result = await registry.executeTool(
      toolNamed('list_conqrplan_projects'),
      {},
      ctx,
    );

    expect(result).toBe('result');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      tool: 'list_conqrplan_projects',
      route: 'local',
      outcome: 'ok',
      actor: `conqr:person:${ctx.user.id}`,
      tenant: `conqr:org:${ctx.workspaceId}`,
    });
    expect(typeof record.durationMs).toBe('number');
  });

  it('logs the same shape when the tool is routed remotely', async () => {
    const registry = new ChatToolRegistry(
      routerStub({
        routable: ['list_conqrplan_projects'],
        routed: ['list_conqrplan_projects'],
      }),
    );

    await registry.executeTool(toolNamed('list_conqrplan_projects'), {}, ctx);

    const record = JSON.parse(lines[0]);
    expect(record.route).toBe('mcp');
    expect(record.outcome).toBe('ok');
    // Same keys on both routes, or the two cannot be compared.
    expect(Object.keys(record).sort()).toEqual(
      ['actor', 'correlationId', 'durationMs', 'outcome', 'route', 'tenant', 'tool'].sort(),
    );
  });

  it('says nothing about a tool the router does not own', async () => {
    const registry = new ChatToolRegistry(
      routerStub({ routable: ['list_conqrplan_projects'], routed: [] }),
    );

    await registry.executeTool(toolNamed('create_page'), {}, ctx);

    expect(lines).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('records a local failure rather than swallowing it', async () => {
    const registry = new ChatToolRegistry(
      routerStub({ routable: ['list_conqrplan_projects'], routed: [] }),
    );
    const boom = toolNamed('list_conqrplan_projects', async () => {
      throw new TypeError('nope');
    });

    await expect(registry.executeTool(boom, {}, ctx)).rejects.toThrow('nope');

    expect(lines).toEqual([]);
    const record = JSON.parse(warnings[0]);
    expect(record).toMatchObject({
      tool: 'list_conqrplan_projects',
      route: 'local',
      outcome: 'error',
      error: 'TypeError',
    });
  });

  it('runs unrouted when no router is wired in at all', async () => {
    const registry = new ChatToolRegistry();

    await expect(
      registry.executeTool(toolNamed('list_conqrplan_projects'), {}, ctx),
    ).resolves.toBe('result');
    expect(lines).toEqual([]);
  });
});
