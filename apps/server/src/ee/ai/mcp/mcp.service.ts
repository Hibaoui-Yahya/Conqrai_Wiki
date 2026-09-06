import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ChatToolRegistry } from '../chat/tools/chat-tool.registry';
import { isMcpContentResult } from '../chat/tools/chat-tool.types';
import {
  SERVER_INSTRUCTIONS,
  GUIDE_SECTIONS,
  MCP_PROMPTS,
} from './mcp-guide';
import { User, Workspace } from '@docmost/db/types/entity.types';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export interface McpContext {
  user: User;
  workspace: Workspace;
}

const SUITE_INTEGRATION_TOOL_NAMES = new Set([
  'search_suite',
  'link_page_to_work_item',
  'get_page_links',
  'create_work_item_from_page',
  'get_page_work_coverage',
]);

function categorizeTool(name: string): string {
  if (SUITE_INTEGRATION_TOOL_NAMES.has(name)) return 'Suite integration';
  if (
    name.includes('work_item') ||
    name.includes('conqrplan') ||
    name === 'get_project_cycles'
  ) {
    return 'ConqrPlan';
  }
  if (
    name.includes('verif') ||
    name === 'submit_for_approval' ||
    name === 'mark_obsolete'
  ) {
    return 'Verification';
  }
  if (name.includes('attachment')) return 'Attachments';
  if (name === 'rag_retrieve' || name === 'search_pages') return 'Search & RAG';
  if (name.endsWith('_comment') || name.endsWith('_comments')) {
    return /^(create|update|delete)_comment$/.test(name)
      ? 'Comments (write)'
      : 'Comments (read)';
  }
  if (name === 'get_current_user' || name.includes('member')) return 'Users';
  if (name.includes('space')) {
    return /^(create|update|delete)_space/.test(name) ? 'Spaces (write)' : 'Spaces (read)';
  }
  if (
    /^(create|update|delete|move|duplicate|copy)_page/.test(name) ||
    name === 'copy_page_to_space' ||
    name === 'move_page_to_space' ||
    name === 'add_diagram'
  ) {
    return 'Pages (write)';
  }
  return 'Pages (read)';
}

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  private readonly serverInfo = {
    name: 'ConqrHub MCP',
    version: '0.80.1',
  };

  // Most recent first — we echo back the client's version if we support it,
  // otherwise fall back to our latest. Per MCP spec §Initialization.
  private readonly supportedProtocolVersions = [
    '2025-06-18',
    '2025-03-26',
    '2024-11-05',
  ];

  private readonly jsonSchemaCache = new Map<string, unknown>();

  constructor(private readonly toolRegistry: ChatToolRegistry) {}

  /**
   * Build a fresh StreamableHTTPServerTransport for a single request.
   *
   * The previous singleton transport accumulated internal session state
   * (`_streamMapping`, `_requestToStreamMapping`, `_requestResponseMap`)
   * across every concurrent caller — under load this is unbounded memory
   * growth and a cross-session leak hazard. Per-request instantiation
   * keeps each request's state isolated and lets the GC reclaim it when
   * the response stream closes.
   */
  private buildTransport(ctx: McpContext): StreamableHTTPServerTransport {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onmessage = async (
      message: JSONRPCMessage,
      extra?: MessageExtraInfo,
    ) => {
      try {
        const messageCtx =
          (extra?.authInfo?.extra as unknown as McpContext | undefined) ?? ctx;

        if ('method' in message) {
          if (!messageCtx?.user?.id || !messageCtx?.workspace?.id) {
            throw new Error('Unauthorized: missing session context');
          }
          const result = await this.handleRequest(
            { method: message.method, params: (message as any).params },
            messageCtx,
          );
          await transport.send({
            jsonrpc: '2.0',
            id: (message as any).id,
            result,
          } as JSONRPCMessage);
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Internal error';
        await transport.send({
          jsonrpc: '2.0',
          id: (message as any).id ?? 0,
          error: { code: -32603, message: errorMessage },
        } as JSONRPCMessage);
      }
    };

    transport.onclose = () => {
      this.logger.debug('MCP stream transport closed (per-request)');
    };

    return transport;
  }

  async handleStreamRequest(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: McpContext,
    parsedBody?: unknown,
  ): Promise<void> {
    (req as any).auth = {
      token: '',
      clientId: ctx.user.id,
      scopes: [],
      extra: ctx as unknown as Record<string, unknown>,
    } as AuthInfo;

    const transport = this.buildTransport(ctx);
    try {
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      // Help the SDK release any internal stream-map entries it kept
      // alive past the response — best-effort, since older SDK versions
      // don't expose a close() method.
      const maybeClose = (transport as unknown as { close?: () => unknown })
        .close;
      if (typeof maybeClose === 'function') {
        try {
          await maybeClose.call(transport);
        } catch (err) {
          this.logger.debug(
            `MCP transport close error: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  async handleRequest(
    request: { method: string; params?: any },
    ctx: McpContext,
  ): Promise<any> {
    switch (request.method) {
      case 'initialize':
        return this.initialize(request.params);

      case 'notifications/initialized':
        return {};

      case 'tools/list':
        return this.listTools();

      case 'tools/call':
        return this.callTool(request.params, ctx);

      case 'prompts/list':
        return this.listPrompts();

      case 'prompts/get':
        return this.getPrompt(request.params);

      case 'resources/list':
        return this.listResources();

      case 'resources/read':
        return this.readResource(request.params);

      case 'resources/templates/list':
        return { resourceTemplates: [] };

      default:
        throw new Error(`Unknown method: ${request.method}`);
    }
  }

  private readonly guideUriPrefix = 'conqrhub://guide/';

  private initialize(params: any) {
    const requested =
      typeof params?.protocolVersion === 'string'
        ? params.protocolVersion
        : undefined;
    const negotiated =
      requested && this.supportedProtocolVersions.includes(requested)
        ? requested
        : this.supportedProtocolVersions[0];

    return {
      protocolVersion: negotiated,
      capabilities: {
        tools: {},
        // We serve reusable workflow prompts and on-demand guide resources,
        // but never push list-changed notifications (stateless per request).
        prompts: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      },
      serverInfo: this.serverInfo,
      // The always-loaded "skill": how to use these tools well. MCP clients
      // inject this into the model's context on connect.
      instructions: SERVER_INSTRUCTIONS,
    };
  }

  private listPrompts() {
    return {
      prompts: MCP_PROMPTS.map((p) => ({
        name: p.name,
        title: p.title,
        description: p.description,
        arguments: p.arguments,
      })),
    };
  }

  private getPrompt(params: any) {
    const name = params?.name;
    const def = MCP_PROMPTS.find((p) => p.name === name);
    if (!def) {
      throw new Error(`Prompt not found: ${name}`);
    }
    const args = (params?.arguments ?? {}) as Record<string, string>;
    const missing = def.arguments
      .filter((a) => a.required && !((args?.[a.name] ?? '').trim()))
      .map((a) => a.name);
    if (missing.length > 0) {
      throw new Error(
        `Missing required argument(s) for prompt "${name}": ${missing.join(', ')}`,
      );
    }
    return {
      description: def.description,
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: def.build(args) },
        },
      ],
    };
  }

  private listResources() {
    return {
      resources: GUIDE_SECTIONS.map((s) => ({
        uri: `${this.guideUriPrefix}${s.slug}`,
        name: s.title,
        description: s.description,
        mimeType: 'text/markdown',
      })),
    };
  }

  private readResource(params: any) {
    const uri: string = params?.uri ?? '';
    if (!uri.startsWith(this.guideUriPrefix)) {
      throw new Error(`Unknown resource: ${uri}`);
    }
    const slug = uri.slice(this.guideUriPrefix.length);
    const section = GUIDE_SECTIONS.find((s) => s.slug === slug);
    if (!section) {
      throw new Error(`Unknown guide section: ${slug}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text: `# ${section.title}\n\n${section.body}`,
        },
      ],
    };
  }

  private listTools() {
    const tools = this.toolRegistry.getAll();
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: this.toInputJsonSchema(t.name, t.parameters),
      })),
    };
  }

  getToolsCatalog(): {
    name: string;
    description: string;
    category: string;
    inputSchema: unknown;
  }[] {
    return this.toolRegistry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      category: categorizeTool(t.name),
      inputSchema: this.toInputJsonSchema(t.name, t.parameters),
    }));
  }

  private toInputJsonSchema(name: string, parameters: unknown): unknown {
    const cached = this.jsonSchemaCache.get(name);
    if (cached) return cached;

    let schema: unknown;
    if (parameters instanceof z.ZodType) {
      schema = z.toJSONSchema(parameters, { io: 'input' });
    } else if (
      parameters &&
      typeof parameters === 'object' &&
      (parameters as any).type === 'object'
    ) {
      schema = parameters;
    } else {
      schema = { type: 'object', properties: {} };
    }

    if (schema && typeof schema === 'object') {
      delete (schema as any).$schema;
    }
    this.jsonSchemaCache.set(name, schema);
    return schema;
  }

  private async callTool(
    params: { name: string; arguments?: any },
    ctx: McpContext,
  ) {
    const tool = this.toolRegistry.getAll().find((t) => t.name === params.name);
    if (!tool) {
      throw new Error(`Tool not found: ${params.name}`);
    }

    const toolCtx = { user: ctx.user, workspaceId: ctx.workspace.id };

    let args: unknown = params.arguments ?? {};
    if (tool.parameters instanceof z.ZodType) {
      const parsed = (tool.parameters as z.ZodType).safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid arguments for ${tool.name}: ${issues}`,
            },
          ],
          isError: true,
        };
      }
      args = parsed.data;
    }

    try {
      // Same routing decision as the chat surface: one place decides which
      // implementation answers, so the two cannot disagree.
      const result = await this.toolRegistry.executeTool(
        tool,
        args,
        toolCtx as any,
      );

      // A tool may return rich MCP content (e.g. an image the model can view,
      // a document's extracted text) via `{ __mcpContent: [...] }`. Forward
      // those blocks verbatim instead of JSON-stringifying them.
      if (isMcpContentResult(result)) {
        const content = [...result.__mcpContent];
        if (result.meta && Object.keys(result.meta).length > 0) {
          content.push({
            type: 'text' as const,
            text: JSON.stringify(result.meta, null, 2),
          });
        }
        return { content };
      }

      const text = result === undefined || result === null
        ? 'null'
        : typeof result === 'string'
          ? result
          : JSON.stringify(result, (key, value) => {
              if (value === undefined) return null;
              return value;
            }, 2);

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tool execution failed';
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
}
