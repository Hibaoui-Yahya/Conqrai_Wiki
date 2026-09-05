import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { z } from 'zod';
import { PageService } from '../../../../core/page/services/page.service';
import SpaceAbilityFactory from '../../../../core/casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../../../core/casl/interfaces/space-ability.type';
import { PlaneClientService } from '../../../../core/integration/services/plane-client.service';
import { FederatedSearchService } from '../../../../core/integration/services/federated-search.service';
import { RelationshipService } from '../../../../core/integration/services/relationship.service';
import { WorkItemCreationService } from '../../../../core/integration/services/work-item-creation.service';
import { TraceabilityService } from '../../../../core/integration/services/traceability.service';
import { buildUrn, parseUrn } from '../../../../core/integration/domain/urn.util';
import { labelOf, RelationType } from '../../../../core/integration/domain/relationship-types';
import { ChatTool, ChatToolContext } from './chat-tool.types';
import { ChatToolRegistry } from './chat-tool.registry';
import { toolError, workItemSummary } from './plane-work-items.tools';
import { DELEGATED_SCOPES } from '../../../../core/integration/domain/delegated-token.util';
import { DelegatedTokenService } from '../../../../core/integration/services/delegated-token.service';
import { delegateForPlane } from './plane-delegation.helper';

/**
 * Suite integration tools: one-call cross-product workflows between ConqrHub
 * (knowledge) and ConqrPlan (work). These wrap the integration layer —
 * federated search, typed relationships, create-and-link, traceability — so
 * an agent passes plain page/work-item IDs and never has to construct URNs
 * or orchestrate multi-step flows itself. Registered only when the Plane
 * integration is configured, because every tool here spans both products.
 */

/** Relations an agent may state from a page to a work item. */
const PAGE_TO_WORK_RELATIONS = [
  RelationType.SpecifiedBy,
  RelationType.ImplementedBy,
  RelationType.DocumentedBy,
  RelationType.TestedBy,
  RelationType.EvidencedBy,
  RelationType.OperationalizedBy,
] as const;

async function loadAuthorizedPage(
  pageService: PageService,
  spaceAbility: SpaceAbilityFactory,
  ctx: ChatToolContext,
  pageId: string,
  action: SpaceCaslAction,
) {
  const page = await pageService.findById(pageId, true);
  if (!page || page.workspaceId !== ctx.workspaceId) {
    throw new NotFoundException(
      `Page not found for id "${pageId}". Pass the page UUID or short slugId.`,
    );
  }
  let ability;
  try {
    ability = await spaceAbility.createForUser(ctx.user, page.spaceId);
  } catch {
    throw new ForbiddenException('You do not have access to this page');
  }
  if (ability.cannot(action, SpaceCaslSubject.Page)) {
    throw new ForbiddenException('You do not have access to this page');
  }
  return page;
}

@Injectable()
export class SearchSuiteTool implements ChatTool, OnModuleInit {
  readonly name = 'search_suite';
  readonly description =
    'Search ConqrHub pages AND ConqrPlan work items in one call. Returns a mixed, interleaved result list where each hit says which product it came from, with a deep link when available. Use this first when you do not know whether the answer lives in the wiki or in project work.';
  readonly parameters = z.object({
    query: z.string().min(1).describe('What to search for'),
    limit: z.number().int().min(1).max(30).optional().default(10),
    planeProjectId: z
      .string()
      .optional()
      .describe('Restrict the work-item side to one ConqrPlan project'),
  });
  constructor(
    private readonly plane: PlaneClientService,
    private readonly federatedSearch: FederatedSearchService,
    private readonly registry: ChatToolRegistry,
  ) {}
  onModuleInit(): void {
    if (this.plane.isEnabled()) this.registry.register(this);
  }
  async execute(
    args: { query: string; limit?: number; planeProjectId?: string },
    ctx: ChatToolContext,
  ) {
    try {
      const { items, sources } = await this.federatedSearch.search(args.query, {
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        planeProjectId: args.planeProjectId,
      });
      return {
        sources,
        items: items.slice(0, args.limit ?? 10).map((i) => ({
          source: i.source === 'hub' ? 'conqrhub' : 'conqrplan',
          type: i.type,
          id: parseUrn(i.urn).id,
          title: i.title,
          snippet: i.snippet ?? null,
          key: i.key ?? null,
          state: i.state ?? null,
          deepLink: i.deepLink ?? null,
        })),
      };
    } catch (err) {
      return toolError(err);
    }
  }
}

@Injectable()
export class LinkPageToWorkItemTool implements ChatTool, OnModuleInit {
  readonly name = 'link_page_to_work_item';
  readonly description =
    'Create a typed link between a ConqrHub page and a ConqrPlan work item (e.g. this spec is specified_by that work item). The link is idempotent, navigable from both products, and powers get_page_work_coverage. Use when the user connects documentation to work.';
  readonly parameters = z.object({
    pageId: z.string().describe('ConqrHub page UUID or slugId'),
    projectId: z.string().describe('ConqrPlan project ID of the work item'),
    workItemId: z.string().describe('ConqrPlan work item ID'),
    relationType: z
      .enum(PAGE_TO_WORK_RELATIONS)
      .optional()
      .default(RelationType.SpecifiedBy)
      .describe('How the page relates to the work item'),
  });
  constructor(
    private readonly plane: PlaneClientService,
    private readonly relationships: RelationshipService,
    private readonly pageService: PageService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly registry: ChatToolRegistry,
    private readonly delegation: DelegatedTokenService,
  ) {}
  onModuleInit(): void {
    if (this.plane.isEnabled()) this.registry.register(this);
  }
  async execute(
    args: {
      pageId: string;
      projectId: string;
      workItemId: string;
      relationType?: string;
    },
    ctx: ChatToolContext,
  ) {
    const page = await loadAuthorizedPage(
      this.pageService,
      this.spaceAbility,
      ctx,
      args.pageId,
      SpaceCaslAction.Edit,
    );
    try {
      // Verify the work item actually exists before recording an edge to it.
      // Existence is checked as the linking human. A work item they cannot
      // see must not become linkable just because the bridge credential can
      // see it - that would leak the target's existence through the edge.
      const workItem = await this.plane.getWorkItem(
        args.projectId,
        args.workItemId,
        delegateForPlane(this.delegation, ctx, [DELEGATED_SCOPES.workItemRead]),
      );
      const relationType = args.relationType ?? RelationType.SpecifiedBy;
      const rel = await this.relationships.create({
        workspaceId: ctx.workspaceId,
        actorId: ctx.user.id,
        sourceUrn: buildUrn('hub', 'page', page.id),
        targetUrn: buildUrn('plane', 'work-item', workItem.id),
        relationType,
        provenance: 'mcp.link-page-to-work-item',
        metadata: { target_project_id: args.projectId },
      });
      return {
        relationshipId: rel.id,
        page: { id: page.id, title: page.title ?? null },
        workItem: workItemSummary(workItem),
        relationType,
        relationLabel: labelOf(relationType as RelationType),
        success: true,
      };
    } catch (err) {
      return toolError(err);
    }
  }
}

@Injectable()
export class GetPageLinksTool implements ChatTool, OnModuleInit {
  readonly name = 'get_page_links';
  readonly description =
    'List the typed cross-product links of a ConqrHub page: which ConqrPlan work items (and other objects) it is connected to and how. Use to answer "what work is attached to this page".';
  readonly parameters = z.object({
    pageId: z.string().describe('ConqrHub page UUID or slugId'),
  });
  constructor(
    private readonly plane: PlaneClientService,
    private readonly relationships: RelationshipService,
    private readonly pageService: PageService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly registry: ChatToolRegistry,
  ) {}
  onModuleInit(): void {
    if (this.plane.isEnabled()) this.registry.register(this);
  }
  async execute(args: { pageId: string }, ctx: ChatToolContext) {
    const page = await loadAuthorizedPage(
      this.pageService,
      this.spaceAbility,
      ctx,
      args.pageId,
      SpaceCaslAction.Read,
    );
    const pageUrn = buildUrn('hub', 'page', page.id);
    const edges = await this.relationships.listForUrn(ctx.workspaceId, pageUrn);
    return {
      page: { id: page.id, title: page.title ?? null },
      links: edges.map((e) => {
        const outgoing = e.sourceUrn === pageUrn;
        const other = parseUrn(outgoing ? e.targetUrn : e.sourceUrn);
        const relation = outgoing ? e.relationType : e.inverseRelationType;
        return {
          relationshipId: e.id,
          relation,
          relationLabel: labelOf(relation as RelationType),
          target: {
            product: other.product === 'hub' ? 'conqrhub' : 'conqrplan',
            type: other.type,
            id: other.id,
          },
          lifecycleState: e.lifecycleState,
          createdAt: (e.createdAt as any)?.toISOString?.() ?? e.createdAt ?? null,
        };
      }),
    };
  }
}

@Injectable()
export class CreateWorkItemFromPageTool implements ChatTool, OnModuleInit {
  readonly name = 'create_work_item_from_page';
  readonly description =
    'Create a ConqrPlan work item from a ConqrHub page AND link the two in one call (the page becomes the spec of the work item). Prefer this over create_work_item when the work originates from a page, so traceability is recorded. Use only when the user explicitly asks to create work.';
  readonly parameters = z.object({
    pageId: z.string().describe('The source ConqrHub page UUID or slugId'),
    projectId: z.string().describe('Target ConqrPlan project ID'),
    title: z.string().min(1).max(255),
    description: z.string().optional().describe('Plain-text or HTML description'),
    priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
    relationType: z
      .enum(PAGE_TO_WORK_RELATIONS)
      .optional()
      .default(RelationType.SpecifiedBy),
  });
  constructor(
    private readonly plane: PlaneClientService,
    private readonly workItemCreation: WorkItemCreationService,
    private readonly pageService: PageService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly registry: ChatToolRegistry,
  ) {}
  onModuleInit(): void {
    if (this.plane.isEnabled()) this.registry.register(this);
  }
  async execute(
    args: {
      pageId: string;
      projectId: string;
      title: string;
      description?: string;
      priority?: string;
      relationType?: string;
    },
    ctx: ChatToolContext,
  ) {
    const page = await loadAuthorizedPage(
      this.pageService,
      this.spaceAbility,
      ctx,
      args.pageId,
      SpaceCaslAction.Read,
    );
    try {
      const html = args.description?.trim().startsWith('<')
        ? args.description
        : args.description
          ? `<p>${args.description}</p>`
          : undefined;
      const res = await this.workItemCreation.createFromHub({
        workspaceId: ctx.workspaceId,
        actorId: ctx.user.id,
        sourceUrn: buildUrn('hub', 'page', page.id),
        planeProjectId: args.projectId,
        title: args.title,
        descriptionHtml: html,
        priority: args.priority,
        relationType: (args.relationType ?? RelationType.SpecifiedBy) as RelationType,
      });
      return {
        status: res.status,
        workItem: workItemSummary(res.workItem),
        page: { id: page.id, title: page.title ?? null },
        relationshipId: res.relationship?.id ?? null,
        ...(res.warning ? { warning: res.warning } : {}),
      };
    } catch (err) {
      return toolError(err);
    }
  }
}

@Injectable()
export class GetPageWorkCoverageTool implements ChatTool, OnModuleInit {
  readonly name = 'get_page_work_coverage';
  readonly description =
    'Report how much of the ConqrPlan work linked to a ConqrHub page is complete: every linked work item with its state, plus a 0-1 coverage ratio. Use to answer "is the work for this spec done" or "does this page have delivery work at all".';
  readonly parameters = z.object({
    pageId: z.string().describe('ConqrHub page UUID or slugId'),
  });
  constructor(
    private readonly plane: PlaneClientService,
    private readonly traceability: TraceabilityService,
    private readonly pageService: PageService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly registry: ChatToolRegistry,
  ) {}
  onModuleInit(): void {
    if (this.plane.isEnabled()) this.registry.register(this);
  }
  async execute(args: { pageId: string }, ctx: ChatToolContext) {
    const page = await loadAuthorizedPage(
      this.pageService,
      this.spaceAbility,
      ctx,
      args.pageId,
      SpaceCaslAction.Read,
    );
    try {
      const coverage = await this.traceability.pageCoverage(
        ctx.workspaceId,
        buildUrn('hub', 'page', page.id),
        ctx.user.id,
      );
      return {
        page: { id: page.id, title: page.title ?? null },
        totalLinkedWork: coverage.totalLinkedWork,
        completed: coverage.completed,
        coverage: coverage.coverage,
        hasDeliveryWork: coverage.hasDeliveryWork,
        items: coverage.items.map((i) => ({
          id: parseUrn(i.urn).id,
          title: i.title ?? null,
          state: i.state ?? null,
          completed: i.completed,
          resolution: i.resolutionState,
        })),
      };
    } catch (err) {
      return toolError(err);
    }
  }
}

export const SUITE_INTEGRATION_TOOLS = [
  SearchSuiteTool,
  LinkPageToWorkItemTool,
  GetPageLinksTool,
  CreateWorkItemFromPageTool,
  GetPageWorkCoverageTool,
];
