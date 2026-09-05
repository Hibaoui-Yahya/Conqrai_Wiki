
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

import { FederatedSearchService } from './federated-search.service';

function make(opts: {
  hubItems?: any[];
  planeEnabled?: boolean;
  mappings?: any[];
  listWorkItems?: jest.Mock;
}) {
  const hubSearch = {
    searchPage: jest
      .fn()
      .mockResolvedValue({ items: opts.hubItems ?? [] }),
  };
  const mappings = {
    listForWorkspace: jest.fn().mockResolvedValue(opts.mappings ?? []),
  };
  const plane = {
    isEnabled: () => opts.planeEnabled ?? true,
    listWorkItems:
      opts.listWorkItems ?? jest.fn().mockResolvedValue({ results: [] }),
  };
  const environment = {
    getPlaneAppUrl: () => 'https://plane.example.com',
    getPlaneWorkspaceSlug: () => 'acme',
  };
  return {
    service: new FederatedSearchService(
      hubSearch as any,
      mappings as any,
      plane as any,
      environment as any,
      makeDelegation(),
    ),
    hubSearch,
    plane,
  };
}

const ctx = { workspaceId: 'ws1', userId: 'u1' };

describe('FederatedSearchService', () => {
  it('returns empty for a blank query without calling either source', async () => {
    const { service, hubSearch, plane } = make({});
    const res = await service.search('   ', ctx);
    expect(res.items).toEqual([]);
    expect(hubSearch.searchPage).not.toHaveBeenCalled();
    expect(plane.listWorkItems).not.toHaveBeenCalled();
  });

  it('merges Hub pages and Plane work items with source labels', async () => {
    const { service } = make({
      hubItems: [{ id: 'p1', title: 'PRD', slugId: 'prd', highlight: '…' }],
      mappings: [{ planeProjectId: 'proj1' }],
      listWorkItems: jest.fn().mockResolvedValue({
        results: [{ id: 'wi1', name: 'Ship it', sequence_id: 5 }],
      }),
    });
    const res = await service.search('ship', ctx);
    expect(res.sources.sort()).toEqual(['hub', 'plane']);
    const hub = res.items.find((i) => i.source === 'hub');
    const plane = res.items.find((i) => i.source === 'plane');
    expect(hub?.urn).toBe('conqr://hub/page/p1');
    expect(plane?.urn).toBe('conqr://plane/work-item/wi1');
    expect(plane?.key).toBe(5);
  });

  it('omits Plane when the integration is disabled', async () => {
    const { service, plane } = make({
      planeEnabled: false,
      hubItems: [{ id: 'p1', title: 'X' }],
    });
    const res = await service.search('x', ctx);
    expect(res.sources).toEqual(['hub']);
    expect(plane.listWorkItems).not.toHaveBeenCalled();
  });

  it('degrades gracefully when Hub search throws (still returns Plane)', async () => {
    const { service, hubSearch } = make({
      mappings: [{ planeProjectId: 'proj1' }],
      listWorkItems: jest
        .fn()
        .mockResolvedValue({ results: [{ id: 'wi1', name: 'W' }] }),
    });
    hubSearch.searchPage.mockRejectedValue(new Error('typesense down'));
    const res = await service.search('w', ctx);
    expect(res.sources).toEqual(['plane']);
    expect(res.items).toHaveLength(1);
  });
});
