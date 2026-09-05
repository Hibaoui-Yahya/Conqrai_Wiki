jest.mock('./smart-object-resolver.service', () => ({
  SmartObjectResolverService: class {},
}));

import { DeliveryReconciliationService } from './delivery-reconciliation.service';
import { ResolutionState } from '../domain/presentation.types';

/**
 * Scheduled reconciliation.
 *
 * Its job is the rows nobody is looking at: an at-least-once stream still
 * loses events, and without a sweep those projections stay wrong forever while
 * the page quietly shows stale delivery status. The failure mode is invisible,
 * which is exactly why it needs a job rather than an alert.
 */

const WS = 'ws-1';
const URN = 'conqr://plane/work-item/wi-1';

function makeDb(over: Record<string, any> = {}) {
  // A tiny stand-in for the two Kysely reads this service makes. The
  // database-backed behaviour it depends on (findStale, markReconciled) is
  // covered against real Postgres in delivery-projection.service.int-spec.ts.
  const workspaces = over.workspaces ?? [{ workspaceId: WS }];
  const edge = 'edge' in over ? over.edge : { createdBy: 'linker-1' };
  return {
    selectFrom: (table: string) => {
      const chain: any = {
        select: () => chain,
        distinct: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        execute: async () => (table === 'integrationWorkItemStatus' ? workspaces : []),
        executeTakeFirst: async () => edge ?? undefined,
      };
      return chain;
    },
  } as any;
}

function make(over: Record<string, any> = {}) {
  const projection = over.projection ?? {
    findStale: jest
      .fn()
      .mockResolvedValue([{ workItemUrn: URN, planeProjectId: 'proj-1' }]),
    markReconciled: jest.fn().mockResolvedValue(undefined),
  };
  const deliveryRead = over.deliveryRead ?? {
    resolveMany: jest.fn(async (urns: string[]) =>
      urns.map((urn) => ({
        urn,
        model: { urn, state: ResolutionState.Live, title: 'Implement login' },
        origin: 'live' as const,
        stale: false,
        lastSyncedAt: '2026-09-04T12:00:00Z',
      })),
    ),
  };
  const service = new DeliveryReconciliationService(
    makeDb(over),
    projection as any,
    deliveryRead as any,
  );
  return { service, projection, deliveryRead };
}

// ===========================================================================
// 15. Scheduled reconciliation repairs missing projections
// ===========================================================================

describe('reconciliation sweep', () => {
  it('refreshes a stale row and records that it was confirmed', async () => {
    const { service, projection, deliveryRead } = make();

    const metrics = await service.reconcile();

    expect(deliveryRead.resolveMany).toHaveBeenCalledWith(
      [URN],
      expect.objectContaining({ workspaceId: WS }),
      // forceLive: the whole point is to go past the cache that is wrong.
      expect.objectContaining({ forceLive: true }),
    );
    expect(projection.markReconciled).toHaveBeenCalledWith(WS, URN);
    expect(metrics).toMatchObject({ scanned: 1, repaired: 1, failed: 0 });
  });

  it('reports metrics an operator can act on', async () => {
    const { service } = make();
    const metrics = await service.reconcile();

    expect(metrics).toMatchObject({
      runId: expect.any(String),
      workspaces: 1,
      scanned: expect.any(Number),
      repaired: expect.any(Number),
      skipped: expect.any(Number),
      restricted: expect.any(Number),
      failed: expect.any(Number),
      durationMs: expect.any(Number),
    });
  });

  it('bounds the batch it asks for', async () => {
    const { service, projection } = make();
    await service.reconcile({ batchSize: 10 });

    expect(projection.findStale).toHaveBeenCalledWith(WS, expect.any(Date), 10);
  });

  it('can be scoped to a single workspace for an operational run', async () => {
    const { service, projection } = make();
    await service.reconcile({ workspaceId: 'ws-only' });

    expect(projection.findStale).toHaveBeenCalledWith(
      'ws-only',
      expect.any(Date),
      expect.any(Number),
    );
  });
});

// ===========================================================================
// Permissions are not weakened by running as a job
// ===========================================================================

describe('permissions', () => {
  it('resolves as a human who linked the work, never as the service account', async () => {
    const { service, deliveryRead } = make();
    await service.reconcile();

    const ctx = deliveryRead.resolveMany.mock.calls[0][1];
    // A real viewer id. Reconciliation is a refresh, not a privilege.
    expect(ctx.viewerId).toBe('linker-1');
  });

  it('skips a row when no actor can be resolved', async () => {
    const { service, projection, deliveryRead } = make({ edge: null });

    const metrics = await service.reconcile();

    // A stale card is a smaller problem than refreshing with elevated access.
    expect(deliveryRead.resolveMany).not.toHaveBeenCalled();
    expect(projection.markReconciled).not.toHaveBeenCalled();
    expect(metrics).toMatchObject({ scanned: 1, skipped: 1, repaired: 0 });
  });

  it('counts a restricted result without treating it as a failure', async () => {
    const deliveryRead = {
      resolveMany: jest.fn(async (urns: string[]) =>
        urns.map((urn) => ({
          urn,
          model: { urn, state: ResolutionState.Restricted },
          origin: 'live' as const,
          stale: false,
          lastSyncedAt: null,
        })),
      ),
    };
    const { service, projection } = make({ deliveryRead });

    const metrics = await service.reconcile();

    // The borrowed identity lost access. Expected, not an error to escalate.
    expect(metrics).toMatchObject({ restricted: 1, repaired: 0, failed: 0 });
    expect(projection.markReconciled).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// ConqrPlan downtime and overlapping runs
// ===========================================================================

describe('resilience', () => {
  it('counts an unreachable source as failed and keeps going', async () => {
    const deliveryRead = {
      resolveMany: jest.fn(async (urns: string[]) =>
        urns.map((urn) => ({
          urn,
          model: { urn, state: ResolutionState.SourceUnavailable },
          origin: 'unavailable' as const,
          stale: true,
          lastSyncedAt: null,
        })),
      ),
    };
    const { service, projection } = make({ deliveryRead });

    const metrics = await service.reconcile();

    expect(metrics).toMatchObject({ failed: 1, repaired: 0 });
    // Nothing is marked confirmed on the strength of a failed read.
    expect(projection.markReconciled).not.toHaveBeenCalled();
  });

  it('does not mark a row reconciled when the read throws', async () => {
    const deliveryRead = {
      resolveMany: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const { service, projection } = make({ deliveryRead });

    const metrics = await service.reconcile();

    expect(metrics.failed).toBe(1);
    expect(projection.markReconciled).not.toHaveBeenCalled();
  });

  it('refuses to start on top of a run already in progress', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliveryRead = {
      resolveMany: jest.fn(async (urns: string[]) => {
        await gate;
        return urns.map((urn) => ({
          urn,
          model: { urn, state: ResolutionState.Live },
          origin: 'live' as const,
          stale: false,
          lastSyncedAt: null,
        }));
      }),
    };
    const { service } = make({ deliveryRead });

    const first = service.reconcile();
    const second = await service.reconcile();

    // Two concurrent sweeps would corrupt nothing - every write is idempotent
    // and ordering-protected - but they would double the load on ConqrPlan for
    // no benefit.
    expect(second).toMatchObject({ scanned: 0, repaired: 0 });
    release();
    await first;
  });

  it('releases the guard so the next scheduled run can proceed', async () => {
    const deliveryRead = {
      resolveMany: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const { service } = make({ deliveryRead });

    await service.reconcile();
    const second = await service.reconcile();

    // A failed run must not wedge the sweep permanently.
    expect(second.scanned).toBe(1);
  });
});
