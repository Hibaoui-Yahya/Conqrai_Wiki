import { PlaneWebhookProcessorService, planeState } from './plane-webhook-processor.service';
import { EventType } from '../domain/event-envelope';

function make(findResult: any[] = []) {
  const relationships = {
    findByUrnAnyWorkspace: jest.fn().mockResolvedValue(findResult),
  };
  const events = { record: jest.fn().mockResolvedValue({}) };
  const lifecycle = {
    onContainerCompleted: jest
      .fn()
      .mockResolvedValue({ suggestionsEmitted: 1 }),
  };
  const aiQueue = { add: jest.fn().mockResolvedValue({}) };
  // The delivery-status projection. Recorded per call so ordering and
  // idempotency can be asserted without a database here; the real ordering
  // rule is proven against Postgres in delivery-projection.service.spec.ts.
  const projection = {
    apply: jest.fn().mockResolvedValue({ applied: true, reason: 'created' }),
  };
  return {
    service: new PlaneWebhookProcessorService(
      relationships as any,
      events as any,
      lifecycle as any,
      projection as any,
      aiQueue as any,
    ),
    projection,
    events,
    relationships,
    lifecycle,
    aiQueue,
  };
}

describe('PlaneWebhookProcessorService', () => {
  it('parses a JSON body and null for garbage', () => {
    const { service } = make();
    expect(service.parse('{"a":1}')).toEqual({ a: 1 });
    expect(service.parse('not json')).toBeNull();
    expect(service.parse(undefined)).toBeNull();
  });

  it('ignores non-issue events', async () => {
    const { service, events } = make();
    const res = await service.process({ event: 'cycle', data: { id: 'c1' } }, 'd1');
    expect(res.affectedWorkspaces).toBe(0);
    expect(events.record).not.toHaveBeenCalled();
  });

  it('emits one refresh event per affected workspace (deduped)', async () => {
    const { service, events } = make([
      { workspaceId: 'ws1' },
      { workspaceId: 'ws1' }, // same workspace twice → one event
      { workspaceId: 'ws2' },
    ]);
    const res = await service.process(
      { event: 'issue', action: 'updated', data: { id: 'wi1', project: 'p1' } },
      'd1',
    );
    expect(res.affectedWorkspaces).toBe(2);
    expect(events.record).toHaveBeenCalledTimes(2);
    expect(events.record.mock.calls[0][0].type).toBe(
      EventType.PlaneWorkItemUpdated,
    );
    expect(events.record.mock.calls[0][0].subject).toBe(
      'conqr://plane/work-item/wi1',
    );
  });

  it('routes a completed cycle to lifecycle suggestions', async () => {
    const { service, lifecycle } = make();
    const res = await service.process(
      { event: 'cycle', action: 'completed', data: { id: 'cy1', project: 'p1', name: 'Sprint 3' } },
      'd1',
    );
    expect(lifecycle.onContainerCompleted).toHaveBeenCalledWith({
      kind: 'cycle',
      projectId: 'p1',
      id: 'cy1',
      name: 'Sprint 3',
    });
    expect(res.affectedWorkspaces).toBe(1);
  });

  it('does not treat a non-completed cycle as a lifecycle event', async () => {
    const { service, lifecycle } = make();
    const res = await service.process(
      { event: 'cycle', action: 'updated', data: { id: 'cy1' } },
      'd1',
    );
    expect(lifecycle.onContainerCompleted).not.toHaveBeenCalled();
    expect(res.affectedWorkspaces).toBe(0);
  });

  it('uses the deleted event type on delete actions', async () => {
    const { service, events } = make([{ workspaceId: 'ws1' }]);
    await service.process(
      { event: 'issue', action: 'deleted', data: { id: 'wi1' } },
      'd1',
    );
    expect(events.record.mock.calls[0][0].type).toBe(
      EventType.PlaneWorkItemDeleted,
    );
  });

  it('enqueues semantic indexing for issue create/update events', async () => {
    const { service, aiQueue } = make();
    await service.process(
      { event: 'issue', action: 'updated', data: { id: 'wi-1', project: 'proj-1' } },
      'delivery-1',
    );
    expect(aiQueue.add).toHaveBeenCalledWith('index-plane-work-item', {
      workItemId: 'wi-1',
      projectId: 'proj-1',
    });
  });

  it('enqueues embedding deletion for issue deleted events', async () => {
    const { service, aiQueue } = make();
    await service.process(
      { event: 'issue', action: 'deleted', data: { id: 'wi-1', project: 'proj-1' } },
      'delivery-2',
    );
    expect(aiQueue.add).toHaveBeenCalledWith(
      'delete-plane-work-item-embeddings',
      { workItemId: 'wi-1' },
    );
  });

  it('still succeeds when the AI queue is unavailable', async () => {
    const { service, aiQueue } = make();
    aiQueue.add.mockRejectedValueOnce(new Error('redis down'));
    const res = await service.process(
      { event: 'issue', action: 'updated', data: { id: 'wi-1', project: 'proj-1' } },
      'delivery-3',
    );
    expect(res).toBeDefined(); // refresh fan-out must not fail because indexing didn't enqueue
  });
});

/**
 * Captured from a real production delivery (CONQR-E2E-CANARY-20260905T232445Z):
 * the webhook payload has no `state_detail` and sends `state` expanded. The
 * REST API does the opposite. Reading only the REST shape meant the projection
 * recorded no state on any delivery, which was invisible because the read path
 * fell back to a live call.
 */
describe('planeState', () => {
  it('reads the expanded state a webhook actually sends', () => {
    expect(
      planeState({
        state: {
          id: 'be8aa62c-7ac7-4b56-9a09-3290eb5fde7c',
          name: 'Todo',
          color: '#60646C',
          group: 'unstarted',
        },
      }),
    ).toEqual({ state: 'Todo', stateGroup: 'unstarted' });
  });

  it('reads the REST shape, where state_detail is expanded and state is a uuid', () => {
    expect(
      planeState({
        state: 'be8aa62c-7ac7-4b56-9a09-3290eb5fde7c',
        state_detail: { name: 'Todo', group: 'unstarted' },
      }),
    ).toEqual({ state: 'Todo', stateGroup: 'unstarted' });
  });

  it('prefers state_detail when a payload somehow carries both', () => {
    expect(
      planeState({
        state: { name: 'Stale', group: 'backlog' },
        state_detail: { name: 'Todo', group: 'unstarted' },
      }),
    ).toEqual({ state: 'Todo', stateGroup: 'unstarted' });
  });

  it('falls back to a bare uuid rather than losing the state entirely', () => {
    // A poor label, but a true one, and the resolver maps it to a name.
    expect(planeState({ state: 'be8aa62c-7ac7-4b56-9a09-3290eb5fde7c' })).toEqual({
      state: 'be8aa62c-7ac7-4b56-9a09-3290eb5fde7c',
      stateGroup: null,
    });
  });

  it('returns nulls when there is no state at all', () => {
    expect(planeState({})).toEqual({ state: null, stateGroup: null });
    expect(planeState(undefined)).toEqual({ state: null, stateGroup: null });
  });

  it('ignores a non-string name or group instead of writing junk', () => {
    expect(planeState({ state: { name: 42, group: {} } })).toEqual({
      state: null,
      stateGroup: null,
    });
  });
});
