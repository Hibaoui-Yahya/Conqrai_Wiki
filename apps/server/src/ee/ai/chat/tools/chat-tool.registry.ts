import { Injectable, Logger, Optional } from '@nestjs/common';
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
  async executeTool(
    tool: ChatTool,
    args: unknown,
    ctx: ChatToolContext,
  ): Promise<unknown> {
    if (!this.router || this.router.routeFor(tool.name) !== 'mcp') {
      return tool.execute(args, ctx);
    }
    return this.router.callRemote({
      toolName: tool.name,
      args: (args ?? {}) as Record<string, unknown>,
      personUid: toPersonUid(ctx.user.id),
      orgUid: toOrgUid(ctx.workspaceId),
      idempotencyKey: (args as { externalId?: string })?.externalId,
    });
  }

  register(chatTool: ChatTool): void {
    this.tools.push(chatTool);
  }

  /**
   * Converts the registry into a ToolSet that the AI SDK's
   * `streamText({ tools })` parameter expects.
   * Each tool's `execute` is closed over the provided context so the
   * model can never invoke a tool as a different user.
   *
   * Per ai@6 SDK behaviour (dist/index.js:2913-2933, 3992-4006), thrown
   * errors from execute() are caught by the SDK and emitted as 'tool-error'
   * parts which are auto-converted to tool-result entries in the next
   * step's prompt — so we let throws propagate, only wrapping for logging.
   */
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
