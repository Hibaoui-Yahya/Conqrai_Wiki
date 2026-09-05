import {
  PlaneWebhookProcessorService,
  normalizePlaneState,
  stateFieldsFor,
} from './plane-webhook-processor.service';
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
 * Fixtures below are the real shapes, taken from production deliveries in run
 * CONQR-E2E-CANARY-20260905T232445Z with identifiers replaced. The webhook
 * sends `state` expanded and carries no `state_detail`; the REST API does the
 * opposite. Reading only the REST shape stored null on every delivery, and the
 * read path's live fallback hid it.
 */
describe('normalizePlaneState', () => {
  const WEBHOOK_STATE = {
    id: 'be8aa62c-0000-0000-0000-000000000001',
    name: 'Todo',
    color: '#60646C',
    group: 'unstarted',
  };

  it('reads the expanded state a webhook actually sends', () => {
    const result = normalizePlaneState({ state: WEBHOOK_STATE });
    expect(result).toEqual({
      kind: 'resolved',
      id: WEBHOOK_STATE.id,
      name: 'Todo',
      group: 'unstarted',
    });
    expect(stateFieldsFor(result)).toEqual({ state: 'Todo', stateGroup: 'unstarted' });
  });

  it('still reads the REST shape, where state is a uuid beside state_detail', () => {
    const result = normalizePlaneState({
      state: 'be8aa62c-0000-0000-0000-000000000001',
      state_detail: { name: 'Todo', group: 'unstarted' },
    });
    expect(stateFieldsFor(result)).toEqual({ state: 'Todo', stateGroup: 'unstarted' });
  });

  it('prefers state_detail when both expanded forms are present', () => {
    const result = normalizePlaneState({
      state: { ...WEBHOOK_STATE, name: 'Stale', group: 'backlog' },
      state_detail: { name: 'Todo', group: 'unstarted' },
    });
    expect(stateFieldsFor(result)).toEqual({ state: 'Todo', stateGroup: 'unstarted' });
  });

  it('never renders a bare state id as the display name', () => {
    const result = normalizePlaneState({
      state: 'be8aa62c-0000-0000-0000-000000000001',
    });
    expect(result).toEqual({
      kind: 'unresolved',
      id: 'be8aa62c-0000-0000-0000-000000000001',
    });
    // Cleared, not the uuid and not the previous name.
    expect(stateFieldsFor(result)).toEqual({ state: null, stateGroup: null });
  });

  it('leaves stored state alone when the payload says nothing about it', () => {
    // A priority-only or title-only update must not erase a good value.
    expect(normalizePlaneState({ name: 'renamed', priority: 'high' })).toEqual({
      kind: 'absent',
    });
    expect(stateFieldsFor({ kind: 'absent' })).toEqual({});
  });

  it('treats an unreadable state as unresolved rather than guessing', () => {
    for (const state of [{ name: 42 }, { name: '' }, { group: 'started' }, []]) {
      const result = normalizePlaneState({ state });
      expect(result.kind).toBe('unresolved');
      expect(stateFieldsFor(result)).toEqual({ state: null, stateGroup: null });
    }
  });

  it('keeps a resolved name even when no group came with it', () => {
    const result = normalizePlaneState({ state: { id: 's1', name: 'Todo' } });
    expect(stateFieldsFor(result)).toEqual({ state: 'Todo', stateGroup: null });
  });

  it('is absent for an explicitly null state, not unresolved', () => {
    // Plane omits the key or sends null on payloads that do not touch state.
    expect(normalizePlaneState({ state: null }).kind).toBe('absent');
    expect(normalizePlaneState(undefined).kind).toBe('absent');
  });
});
