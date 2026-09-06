import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ToolSet } from 'ai';
import { ChatTool, ChatToolContext } from './chat-tool.types';

import { ConqrPlanToolRouter } from '../../../../core/integration/services/conqrplan-tool-router.service';
import {
  toOrgUid,
  toPersonUid,
} from '../../../../core/integration/domain/canonical-identity.util';

@Injectable()
export class ChatToolRegistry {
  private readonly logger = new Logger(ChatToolRegistry.name);
  private readonly tools: ChatTool[] = [];

  constructor(@Optional() private readonly router?: ConqrPlanToolRouter) {}

  /**
   * Run a tool through the routing decision.
   *
   * The single place tool execution happens, so the chat surface and the MCP
   * surface cannot drift apart on which implementation answered. A tool the
   * router does not own, or one routed locally, runs exactly as before.
   */
  register(chatTool: ChatTool): void {
    this.tools.push(chatTool);
  }

  /**
   * Run a tool through the routing decision.
   *
   * The single place tool execution happens, so the chat surface and the MCP
   * surface cannot drift apart on which implementation answered.
   */
  async executeTool(
    tool: ChatTool,
    args: unknown,
    ctx: ChatToolContext,
  ): Promise<unknown> {
    // Selected once, here, for the whole request. Both dispatch surfaces come
    // through this method, so a configuration change mid-flight cannot move a
    // request onto the other route part-way: it affects only later requests.
    const route = this.router ? this.router.routeFor(tool.name) : 'local';
    if (route === 'local') {
      return tool.execute(args, ctx);
    }

    const correlationId = randomUUID();
    const personUid = toPersonUid(ctx.user.id);
    const orgUid = toOrgUid(ctx.workspaceId);
    const startedAt = Date.now();
    // Identifiers only. A routing log must not become a second copy of the
    // data the permission checks just gated, nor of any credential.
    const base = {
      tool: tool.name,
      route,
      correlationId,
      actor: personUid,
      tenant: orgUid,
    };
    try {
      const result = await this.router!.callRemote({
        toolName: tool.name,
        args: (args ?? {}) as Record<string, unknown>,
        personUid,
        orgUid,
        correlationId,
        idempotencyKey: (args as { externalId?: string })?.externalId,
      });
      this.logger.log(
        JSON.stringify({ ...base, outcome: 'ok', durationMs: Date.now() - startedAt }),
      );
      return result;
    } catch (err) {
      this.logger.warn(
        JSON.stringify({
          ...base,
          outcome: (err as { uncertain?: boolean }).uncertain ? 'uncertain' : 'error',
          error: (err as Error).name,
          durationMs: Date.now() - startedAt,
        }),
      );
      throw err;
    }
  }

  toAiSdkTools(ctx: ChatToolContext): ToolSet {
    const result: ToolSet = {};
    for (const t of this.tools) {
      result[t.name] = {
        description: t.description,
        inputSchema: t.parameters,
        execute: async (args: any) => {
          try {
            return await this.executeTool(t, args, ctx);
          } catch (err) {
            this.logger.warn(
              `Tool ${t.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            throw err;
          }
        },
      } as any;
    }
    return result;
  }

  getAll(): ReadonlyArray<ChatTool> {
    return this.tools;
  }
}
