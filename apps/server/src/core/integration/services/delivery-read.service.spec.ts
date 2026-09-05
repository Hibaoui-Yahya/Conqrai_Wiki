jest.mock('./smart-object-resolver.service', () => ({
  SmartObjectResolverService: class {},
}));

import { DeliveryReadService } from './delivery-read.service';
import { ResolutionState } from '../domain/presentation.types';

/**
 * Bounded fallback and read repair.
 *
 * The panel must not trust the projection blindly — a work item linked a
 * moment ago has no row yet, and a row whose events stopped arriving is
 * quietly wrong — but it must not resolve every card live on every render
 * either, which would put an unbounded fan-out onto another product on the
 * critical path of a page load.
 */

const URN = 'conqr://plane/work-item/wi-1';
const CTX = { workspaceId: 'ws-1', viewerId: 'user-1', planeProjectId: 'proj-1' };
const NOW = new Date('2026-09-04T12:00:00Z');

const liveModel = (urn = URN) => ({
  urn,
  state: ResolutionState.Live,
  title: 'Implement login',
  fields: { state: 'In Progress', stateGroup: 'started', completed: false },
  sourceVersion: '2026-09-04T11:59:00Z',
});

const projectionRow = (over: Record<string, unknown> = {}) => ({
  workItemUrn: URN,
  planeProjectId: 'proj-1',
  title: 'Implement login',
  state: 'In Progress',
  stateGroup: 'started',
  completed: false,
  deletedInSource: false,
  sourceUpdatedAt: new Date('2026-09-04T11:00:00Z'),
  // One minute ago: comfortably inside the freshness window.
  lastEventAt: new Date('2026-09-04T11:59:00Z'),
  reconciledAt: null,
  ...over,
});

function make(over: Record<string, any> = {}) {
  const projection = over.projection ?? {
    getMany: jest.fn().mockResolvedValue(new Map()),
    apply: jest.fn().mockResolvedValue({ applied: true, reason: 'created' }),
  };
  const resolver = over.resolver ?? {
    resolveMany: jest.fn(async (urns: string[]) => urns.map((u) => liveModel(u))),
  };
  return {
    service: new DeliveryReadService(projection as any, resolver as any),
    projection,
    resolver,
  };
}

// ===========================================================================
// 13. A missing projection invokes bounded fallback
// ===========================================================================

describe('fallback', () => {
  it('resolves live when no projection row exists', async () => {
    const { service, resolver } = make();

    const [result] = await service.resolveMany([URN], CTX, { now: NOW });

    expect(resolver.resolveMany).toHaveBeenCalledWith([URN], CTX);
    expect(result.origin).toBe('live');
    expect(result.stale).toBe(false);
    expect(result.model.state).toBe(ResolutionState.Live);
  });

  it('serves a fresh projection without touching ConqrPlan', async () => {
    const projection = {
      getMany: jest.fn().mockResolvedValue(new Map([[URN, projectionRow()]])),
      apply: jest.fn(),
    };
    const { service, resolver } = make({ projection });

    const [result] = await service.resolveMany([URN], CTX, { now: NOW });

    // The whole point of the cache: a fresh row costs no cross-product call.
    expect(resolver.resolveMany).not.toHaveBeenCalled();
    expect(result.origin).toBe('projection');
    expect(result.stale).toBe(false);
    expect(result.model.state).toBe(ResolutionState.Live);
  });

  it('batches one resolution pass for many URNs', async () => {
    const urns = Array.from({ length: 8 }, (_, i) => `conqr://plane/work-item/wi-${i}`);
    const { service, resolver } = make();

    await service.resolveMany(urns, CTX, { now: NOW });

    // One call, not eight. A page with twenty requirements must not make
    // twenty round trips to another product.
    expect(resolver.resolveMany).toHaveBeenCalledTimes(1);
    expect(resolver.resolveMany.mock.calls[0][0]).toHaveLength(8);
  });

  it('caps how many items it will resolve live in one read', async () => {
    const urns = Array.from({ length: 40 }, (_, i) => `conqr://plane/work-item/wi-${i}`);
    const { service, resolver } = make();

    const results = await service.resolveMany(urns, CTX, { now: NOW });

    expect(resolver.resolveMany.mock.calls[0][0].length).toBeLessThanOrEqual(25);
    // Every requested URN still gets an answer; the ones beyond the cap are
    // labelled rather than dropped.
    expect(results).toHaveLength(40);
  });
});

// ===========================================================================
// 14. A stale projection is labelled correctly
// ===========================================================================

describe('staleness', () => {
  it('refreshes a projection that is past its freshness window', async () => {
    const projection = {
      getMany: jest
        .fn()
        .mockResolvedValue(
          new Map([[URN, projectionRow({ lastEventAt: new Date('2026-09-04T11:00:00Z') })]]),
        ),
      apply: jest.fn().mockResolvedValue({ applied: true, reason: 'updated' }),
    };
    const { service, resolver } = make({ projection });

    const [result] = await service.resolveMany([URN], CTX, { now: NOW });

    expect(resolver.resolveMany).toHaveBeenCalled();
    expect(result.origin).toBe('live');
    expect(result.stale).toBe(false);
  });

  it('serves a stale projection, marked stale, when ConqrPlan is unreachable', async () => {
    const projection = {
      getMany: jest
        .fn()
        .mockResolvedValue(
          new Map([[URN, projectionRow({ lastEventAt: new Date('2026-09-04T11:00:00Z') })]]),
        ),
      apply: jest.fn(),
    };
    const resolver = { resolveMany: jest.fn().mockRejectedValue(new Error('down')) };
    const { service } = make({ projection, resolver });

    const [result] = await service.resolveMany([URN], CTX, { now: NOW });

    // Something useful is still shown, but never dressed up as current.
    expect(result.origin).toBe('projection');
    expect(result.stale).toBe(true);
    expect(result.model.state).toBe(ResolutionState.Stale);
    expect(result.lastSyncedAt).toBe('2026-09-04T11:00:00.000Z');
  });

  it('reports source_unavailable when there is nothing cached and nothing reachable', async () => {
    const resolver = { resolveMany: jest.fn().mockRejectedValue(new Error('down')) };
    const { service } = make({ resolver });

    const [result] = await service.resolveMany([URN], CTX, { now: NOW });

    // Not "not found": we do not know the item is gone, only that we cannot
    // reach it, and the two mean very different things to a user.
    expect(result.model.state).toBe(ResolutionState.SourceUnavailable);
    expect(result.origin).toBe('unavailable');
  });

  it('presents a projection of a deleted item as deleted', async () => {
    const projection = {
      getMany: jest
        .fn()
        .mockResolvedValue(new Map([[URN, projectionRow({ deletedInSource: true })]])),
      apply: jest.fn(),
    };
    const { service } = make({ projection });

    const [result] = await service.resolveMany([URN], CTX, { now: NOW });
    expect(result.model.state).toBe(ResolutionState.Deleted);
  });
});

// ===========================================================================
// Read repair
// ===========================================================================

describe('read repair', () => {
  it('folds a live answer back into the projection', async () => {
    const { service, projection } = make();

    await service.resolveMany([URN], CTX, { now: NOW });

    expect(projection.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        workItemUrn: URN,
        state: 'In Progress',
        sourceUpdatedAt: '2026-09-04T11:59:00Z',
      }),
    );
  });

  it('never caches a restricted result', async () => {
    const resolver = {
      resolveMany: jest.fn(async (urns: string[]) =>
        urns.map((urn) => ({ urn, state: ResolutionState.Restricted })),
      ),
    };
    const { service, projection } = make({ resolver });

    const [result] = await service.resolveMany([URN], CTX, { now: NOW });

    // Restricted says something about the *viewer*, not the item. Writing it
    // to a shared projection would poison the row for everyone else.
    expect(projection.apply).not.toHaveBeenCalled();
    expect(result.model.state).toBe(ResolutionState.Restricted);
    expect(result.model).not.toHaveProperty('title');
  });

  it('does not fail the read when repair fails', async () => {
    const projection = {
      getMany: jest.fn().mockResolvedValue(new Map()),
      apply: jest.fn().mockRejectedValue(new Error('write failed')),
    };
    const { service } = make({ projection });

    const [result] = await service.resolveMany([URN], CTX, { now: NOW });

    // The user still gets their card; the cache miss is our problem, not theirs.
    expect(result.origin).toBe('live');
  });
});

// ===========================================================================
// Circuit breaker
// ===========================================================================

describe('circuit breaker', () => {
  it('stops calling ConqrPlan after repeated failures and serves projections', async () => {
    const projection = {
      getMany: jest
        .fn()
        .mockResolvedValue(
          new Map([[URN, projectionRow({ lastEventAt: new Date('2026-09-04T10:00:00Z') })]]),
        ),
      apply: jest.fn(),
    };
    const resolver = { resolveMany: jest.fn().mockRejectedValue(new Error('down')) };
    const { service } = make({ projection, resolver });

    for (let i = 0; i < 3; i++) {
      await service.resolveMany([URN], CTX, { now: NOW });
    }
    const callsAfterOpening = resolver.resolveMany.mock.calls.length;

    const [result] = await service.resolveMany([URN], CTX, { now: NOW });

    // Their outage does not become ours: once the breaker is open we stop
    // hammering and serve what we have, labelled stale.
    expect(resolver.resolveMany).toHaveBeenCalledTimes(callsAfterOpening);
    expect(result.origin).toBe('projection');
    expect(result.stale).toBe(true);
  });

  it('closes again after the cooldown', async () => {
    const projection = {
      getMany: jest
        .fn()
        .mockResolvedValue(
          new Map([[URN, projectionRow({ lastEventAt: new Date('2026-09-04T10:00:00Z') })]]),
        ),
      apply: jest.fn().mockResolvedValue({ applied: true, reason: 'updated' }),
    };
    const resolver = { resolveMany: jest.fn().mockRejectedValue(new Error('down')) };
    const { service } = make({ projection, resolver });

    for (let i = 0; i < 3; i++) {
      await service.resolveMany([URN], CTX, { now: NOW });
    }
    resolver.resolveMany.mockResolvedValue([liveModel()]);

    const later = new Date(NOW.getTime() + 60_000);
    const [result] = await service.resolveMany([URN], CTX, { now: later });

    expect(result.origin).toBe('live');
  });
});
