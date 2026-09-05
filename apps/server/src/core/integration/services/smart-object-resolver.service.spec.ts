import { SmartObjectResolverService } from './smart-object-resolver.service';
import { PlaneApiError } from './plane-client.service';
import { ResolutionState } from '../domain/presentation.types';

function makeResolver(overrides: {
  enabled?: boolean;
  getWorkItem?: jest.Mock;
  findPage?: jest.Mock;
}) {
  const planeClient = {
    isEnabled: () => overrides.enabled ?? true,
    getWorkItem: overrides.getWorkItem ?? jest.fn(),
  };
  const pageRepo = { findById: overrides.findPage ?? jest.fn() };
  const environment = {
    getAppUrl: () => 'https://hub.example.com',
    getPlaneApiUrl: () => 'https://plane.example.com/api/v1',
    getPlaneAppUrl: () => 'https://plane.example.com',
    getPlaneWorkspaceSlug: () => 'acme',
  };
  return new SmartObjectResolverService(
    pageRepo as any,
    planeClient as any,
    environment as any,
    // Work items are resolved as the *viewer*, so the resolver mints a
    // read-only delegation per call. Asserting it is passed is the point of
    // the permission-leak tests below.
    {
      mintForPlane: jest.fn().mockReturnValue({
        token: 'viewer-obo-token',
        jti: 'viewer-corr',
        personUid: 'conqr:person:viewer',
        orgUid: 'conqr:org:ws',
        scope: ['work-item:read'],
        expiresAt: 9_999_999,
      }),
    } as any,
  );
}

const ctx = { workspaceId: 'ws1', viewerId: 'u1', planeProjectId: 'proj1' };

describe('SmartObjectResolverService', () => {
  it('returns not_found for a malformed URN', async () => {
    const r = makeResolver({});
    const m = await r.resolve('garbage', ctx);
    expect(m.state).toBe(ResolutionState.NotFound);
  });

  it('returns integration_disabled for Plane URNs when off', async () => {
    const r = makeResolver({ enabled: false });
    const m = await r.resolve('conqr://plane/work-item/wi1', ctx);
    expect(m.state).toBe(ResolutionState.IntegrationDisabled);
  });

  it('returns source_unavailable when project context is missing', async () => {
    const r = makeResolver({});
    const m = await r.resolve('conqr://plane/work-item/wi1', {
      ...ctx,
      planeProjectId: undefined,
    });
    expect(m.state).toBe(ResolutionState.SourceUnavailable);
  });

  it('maps a live Plane work item into a presentation model', async () => {
    const getWorkItem = jest.fn().mockResolvedValue({
      id: 'wi1',
      name: 'Ship login',
      sequence_id: 42,
      state_detail: { name: 'In Progress', group: 'started' },
      priority: 'high',
      updated_at: '2026-07-18T00:00:00Z',
    });
    const r = makeResolver({ getWorkItem });
    const m = await r.resolve('conqr://plane/work-item/wi1', ctx);
    expect(m.state).toBe(ResolutionState.Live);
    expect(m.title).toBe('Ship login');
    expect(m.fields?.state).toBe('In Progress');
    expect(m.fields?.key).toBe(42);
    expect(m.deepLink).toContain('/acme/projects/proj1/issues/wi1');
  });

  it('maps Plane errors to explicit states', async () => {
    const cases: Array<[number, ResolutionState]> = [
      [404, ResolutionState.Deleted],
      [403, ResolutionState.Restricted],
      [429, ResolutionState.SourceUnavailable],
      [500, ResolutionState.SourceUnavailable],
    ];
    for (const [status, expected] of cases) {
      const getWorkItem = jest
        .fn()
        .mockRejectedValue(new PlaneApiError('x', status, status >= 429));
      const r = makeResolver({ getWorkItem });
      const m = await r.resolve('conqr://plane/work-item/wi1', ctx);
      expect(m.state).toBe(expected);
    }
  });

  it('resolves a Hub page in the same workspace as live', async () => {
    const findPage = jest.fn().mockResolvedValue({
      id: 'p1',
      workspaceId: 'ws1',
      title: 'PRD',
      slugId: 'prd-1',
      spaceId: 's1',
      updatedAt: '2026-07-18T00:00:00Z',
    });
    const r = makeResolver({ findPage });
    const m = await r.resolve('conqr://hub/page/p1', ctx);
    expect(m.state).toBe(ResolutionState.Live);
    expect(m.title).toBe('PRD');
    // Absolute: other products render these links in their own origin (the
    // ConqrService launcher iframe), where a relative href goes nowhere.
    expect(m.deepLink).toBe('https://hub.example.com/p/prd-1');
  });

  it('returns not_found for a Hub page in a different workspace', async () => {
    const findPage = jest
      .fn()
      .mockResolvedValue({ id: 'p1', workspaceId: 'OTHER', title: 'x' });
    const r = makeResolver({ findPage });
    const m = await r.resolve('conqr://hub/page/p1', ctx);
    expect(m.state).toBe(ResolutionState.NotFound);
  });

  it('resolveMany dedups repeated URNs (one source call) but preserves order/dupes', async () => {
    const getWorkItem = jest
      .fn()
      .mockResolvedValue({ id: 'wi1', name: 'Ship' });
    const r = makeResolver({ getWorkItem });
    const urns = [
      'conqr://plane/work-item/wi1',
      'conqr://plane/work-item/wi1',
      'conqr://plane/work-item/wi1',
    ];
    const out = await r.resolveMany(urns, ctx);
    expect(out).toHaveLength(3); // caller order + dupes preserved
    expect(out.every((m) => m.state === ResolutionState.Live)).toBe(true);
    expect(getWorkItem).toHaveBeenCalledTimes(1); // deduped → one call
  });
});


/**
 * A page's space maps to at most one ConqrPlan project, but the work linked
 * from that page does not have to live in it - and a page in an unmapped space
 * has no project at all. Those items used to report `source_unavailable`, a
 * generic failure indistinguishable from ConqrPlan being down, when the truth
 * was often "deleted" or an ordinary readable work item.
 */
describe('SmartObjectResolverService — per-URN project', () => {
  const URN = 'conqr://plane/work-item/wi-1';

  function withClient(getWorkItem: jest.Mock) {
    return { service: makeResolver({ getWorkItem }), getWorkItem };
  }

  it('uses the project recorded on the relationship over the space mapping', async () => {
    const { service, getWorkItem } = withClient(
      jest.fn().mockResolvedValue({ id: 'wi-1', name: 'Charge API', state: null }),
    );

    await service.resolveMany([URN], {
      workspaceId: 'ws-1',
      viewerId: 'user-1',
      planeProjectId: 'project-from-space-mapping',
      planeProjectByUrn: { [URN]: 'project-from-relationship' },
    });

    expect(getWorkItem).toHaveBeenCalledWith(
      'project-from-relationship',
      'wi-1',
      expect.anything(),
    );
  });

  it('falls back to the space mapping when the edge recorded no project', async () => {
    const { service, getWorkItem } = withClient(
      jest.fn().mockResolvedValue({ id: 'wi-1', name: 'x', state: null }),
    );

    await service.resolveMany([URN], {
      workspaceId: 'ws-1',
      viewerId: 'user-1',
      planeProjectId: 'project-from-space-mapping',
      planeProjectByUrn: {},
    });

    expect(getWorkItem).toHaveBeenCalledWith(
      'project-from-space-mapping',
      'wi-1',
      expect.anything(),
    );
  });

  it('resolves a soft-deleted work item as deleted, not a generic failure', async () => {
    const { service } = withClient(
      jest.fn().mockRejectedValue(new PlaneApiError('not found', 404, false)),
    );

    const [model] = await service.resolveMany([URN], {
      workspaceId: 'ws-1',
      viewerId: 'user-1',
      planeProjectByUrn: { [URN]: 'project-from-relationship' },
    });

    expect(model.state).toBe(ResolutionState.Deleted);
  });

  it('still reports source_unavailable when no project is known at all', async () => {
    const { service, getWorkItem } = withClient(jest.fn());

    const [model] = await service.resolveMany([URN], {
      workspaceId: 'ws-1',
      viewerId: 'user-1',
    });

    expect(model.state).toBe(ResolutionState.SourceUnavailable);
    expect(getWorkItem).not.toHaveBeenCalled();
  });
});
