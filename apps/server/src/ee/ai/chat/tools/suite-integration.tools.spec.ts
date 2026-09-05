jest.mock('../../../../core/page/services/page.service', () => ({
  PageService: class MockPageService {},
}));
jest.mock('../../../../core/integration/services/federated-search.service', () => ({
  FederatedSearchService: class MockFederatedSearchService {},
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChatToolRegistry } from './chat-tool.registry';
import {
  SearchSuiteTool,
  LinkPageToWorkItemTool,
  GetPageLinksTool,
  CreateWorkItemFromPageTool,
  GetPageWorkCoverageTool,
  SUITE_INTEGRATION_TOOLS,
} from './suite-integration.tools';

const ctx = { user: { id: 'user-1' } as any, workspaceId: 'ws-1' };

const page = {
  id: 'page-1',
  title: 'Payments spec',
  workspaceId: 'ws-1',
  spaceId: 'sp-1',
};

function makeMocks(planeEnabled = true) {
  return {
    plane: {
      isEnabled: jest.fn().mockReturnValue(planeEnabled),
      getWorkItem: jest.fn(),
    } as any,
    pageService: { findById: jest.fn().mockResolvedValue(page) } as any,
    spaceAbility: {
      createForUser: jest.fn().mockResolvedValue({ cannot: () => false }),
    } as any,
    federatedSearch: { search: jest.fn() } as any,
    relationships: { create: jest.fn(), listForUrn: jest.fn() } as any,
    workItemCreation: { createFromHub: jest.fn() } as any,
    traceability: { pageCoverage: jest.fn() } as any,
  };
}


/** Delegation stub: reads must carry a signed on-behalf-of token. */
function makeDelegation() {
  return {
    mintForPlane: jest.fn().mockImplementation(({ scope }: { scope: string[] }) => ({
      token: 'obo-token',
      jti: 'corr-1',
      personUid: 'conqr:person:user-1',
      orgUid: 'conqr:org:ws-1',
      scope,
      expiresAt: 9_999_999,
    })),
    mintCallContext: jest.fn().mockReturnValue({
      delegation: 'obo-token',
      correlationId: 'corr-1',
    }),
  } as any;
}

describe('Suite integration tools', () => {
  it('registers no tool when the Plane integration is disabled', () => {
    const m = makeMocks(false);
    const registry = new ChatToolRegistry();
    [
      new SearchSuiteTool(m.plane, m.federatedSearch, registry),
      new LinkPageToWorkItemTool(m.plane, m.relationships, m.pageService, m.spaceAbility, registry, makeDelegation()),
      new GetPageLinksTool(m.plane, m.relationships, m.pageService, m.spaceAbility, registry),
      new CreateWorkItemFromPageTool(m.plane, m.workItemCreation, m.pageService, m.spaceAbility, registry),
      new GetPageWorkCoverageTool(m.plane, m.traceability, m.pageService, m.spaceAbility, registry),
    ].forEach((t) => t.onModuleInit());
    expect(registry.getAll()).toHaveLength(0);
    expect(SUITE_INTEGRATION_TOOLS).toHaveLength(5);
  });

  it('search_suite maps federated results to product-labeled hits', async () => {
    const m = makeMocks();
    m.federatedSearch.search.mockResolvedValue({
      sources: ['hub', 'plane'],
      items: [
        {
          source: 'hub',
          type: 'page',
          urn: 'conqr://hub/page/page-1',
          title: 'Payments spec',
          snippet: 'How we charge…',
        },
        {
          source: 'plane',
          type: 'work-item',
          urn: 'conqr://plane/work-item/wi-1',
          title: 'Build charge API',
          key: 12,
          state: 'In Progress',
          deepLink: 'https://plane.example/w/p/issues/wi-1',
        },
      ],
    });
    const tool = new SearchSuiteTool(m.plane, m.federatedSearch, new ChatToolRegistry());

    const result: any = await tool.execute({ query: 'payments' }, ctx);

    expect(m.federatedSearch.search).toHaveBeenCalledWith('payments', {
      workspaceId: 'ws-1',
      userId: 'user-1',
      planeProjectId: undefined,
    });
    expect(result.items).toEqual([
      {
        source: 'conqrhub',
        type: 'page',
        id: 'page-1',
        title: 'Payments spec',
        snippet: 'How we charge…',
        key: null,
        state: null,
        deepLink: null,
      },
      {
        source: 'conqrplan',
        type: 'work-item',
        id: 'wi-1',
        title: 'Build charge API',
        snippet: null,
        key: 12,
        state: 'In Progress',
        deepLink: 'https://plane.example/w/p/issues/wi-1',
      },
    ]);
  });

  it('link_page_to_work_item verifies both ends and creates a typed edge', async () => {
    const m = makeMocks();
    m.plane.getWorkItem.mockResolvedValue({
      id: 'wi-1',
      name: 'Build charge API',
      sequence_id: 12,
      state_detail: { name: 'Backlog' },
    });
    m.relationships.create.mockResolvedValue({ id: 'rel-1' });
    const tool = new LinkPageToWorkItemTool(
      m.plane,
      m.relationships,
      m.pageService,
      m.spaceAbility,
      new ChatToolRegistry(),
      makeDelegation(),
    );

    const result: any = await tool.execute(
      { pageId: 'page-1', projectId: 'proj-1', workItemId: 'wi-1' },
      ctx,
    );

    expect(m.relationships.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        actorId: 'user-1',
        sourceUrn: 'conqr://hub/page/page-1',
        targetUrn: 'conqr://plane/work-item/wi-1',
        relationType: 'specified_by',
        provenance: 'mcp.link-page-to-work-item',
      }),
    );
    expect(result).toMatchObject({ relationshipId: 'rel-1', success: true });
  });

  it('page tools throw NotFound for a page outside the workspace', async () => {
    const m = makeMocks();
    m.pageService.findById.mockResolvedValue({ ...page, workspaceId: 'other-ws' });
    const tool = new GetPageLinksTool(
      m.plane,
      m.relationships,
      m.pageService,
      m.spaceAbility,
      new ChatToolRegistry(),
    );
    await expect(tool.execute({ pageId: 'page-1' }, ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('page tools throw Forbidden when the space ability denies access', async () => {
    const m = makeMocks();
    m.spaceAbility.createForUser.mockResolvedValue({ cannot: () => true });
    const tool = new GetPageWorkCoverageTool(
      m.plane,
      m.traceability,
      m.pageService,
      m.spaceAbility,
      new ChatToolRegistry(),
    );
    await expect(tool.execute({ pageId: 'page-1' }, ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('get_page_links labels both edge directions relative to the page', async () => {
    const m = makeMocks();
    m.relationships.listForUrn.mockResolvedValue([
      {
        id: 'rel-1',
        sourceUrn: 'conqr://hub/page/page-1',
        targetUrn: 'conqr://plane/work-item/wi-1',
        relationType: 'specified_by',
        inverseRelationType: 'specifies',
        lifecycleState: 'active',
        createdAt: '2026-08-01T00:00:00Z',
      },
      {
        id: 'rel-2',
        sourceUrn: 'conqr://plane/work-item/wi-2',
        targetUrn: 'conqr://hub/page/page-1',
        relationType: 'documents',
        inverseRelationType: 'documented_by',
        lifecycleState: 'active',
        createdAt: '2026-08-02T00:00:00Z',
      },
    ]);
    const tool = new GetPageLinksTool(
      m.plane,
      m.relationships,
      m.pageService,
      m.spaceAbility,
      new ChatToolRegistry(),
    );

    const result: any = await tool.execute({ pageId: 'page-1' }, ctx);

    expect(result.links).toHaveLength(2);
    expect(result.links[0]).toMatchObject({
      relation: 'specified_by',
      target: { product: 'conqrplan', type: 'work-item', id: 'wi-1' },
    });
    expect(result.links[1]).toMatchObject({
      relation: 'documented_by',
      target: { product: 'conqrplan', type: 'work-item', id: 'wi-2' },
    });
  });

  it('create_work_item_from_page surfaces created_link_failed honestly', async () => {
    const m = makeMocks();
    m.workItemCreation.createFromHub.mockResolvedValue({
      status: 'created_link_failed',
      workItem: { id: 'wi-3', name: 'New task', sequence_id: 5 },
      workItemUrn: 'conqr://plane/work-item/wi-3',
      correlationId: 'corr-1',
      warning: 'Work item was created in Plane but could not be linked. Retry the link.',
    });
    const tool = new CreateWorkItemFromPageTool(
      m.plane,
      m.workItemCreation,
      m.pageService,
      m.spaceAbility,
      new ChatToolRegistry(),
    );

    const result: any = await tool.execute(
      { pageId: 'page-1', projectId: 'proj-1', title: 'New task' },
      ctx,
    );

    expect(m.workItemCreation.createFromHub).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrn: 'conqr://hub/page/page-1',
        planeProjectId: 'proj-1',
        title: 'New task',
        relationType: 'specified_by',
      }),
    );
    expect(result.status).toBe('created_link_failed');
    expect(result.warning).toContain('Retry the link');
  });

  it('get_page_work_coverage returns the coverage summary with plain ids', async () => {
    const m = makeMocks();
    m.traceability.pageCoverage.mockResolvedValue({
      sourceUrn: 'conqr://hub/page/page-1',
      totalLinkedWork: 2,
      completed: 1,
      coverage: 0.5,
      hasDeliveryWork: true,
      items: [
        {
          urn: 'conqr://plane/work-item/wi-1',
          title: 'Build charge API',
          state: 'Done',
          completed: true,
          resolutionState: 'resolved',
        },
        {
          urn: 'conqr://plane/work-item/wi-2',
          title: 'Add refunds',
          state: 'In Progress',
          completed: false,
          resolutionState: 'resolved',
        },
      ],
    });
    const tool = new GetPageWorkCoverageTool(
      m.plane,
      m.traceability,
      m.pageService,
      m.spaceAbility,
      new ChatToolRegistry(),
    );

    const result: any = await tool.execute({ pageId: 'page-1' }, ctx);

    expect(m.traceability.pageCoverage).toHaveBeenCalledWith(
      'ws-1',
      'conqr://hub/page/page-1',
      'user-1',
    );
    expect(result.coverage).toBe(0.5);
    expect(result.items[0]).toEqual({
      id: 'wi-1',
      title: 'Build charge API',
      state: 'Done',
      completed: true,
      resolution: 'resolved',
    });
  });
});
