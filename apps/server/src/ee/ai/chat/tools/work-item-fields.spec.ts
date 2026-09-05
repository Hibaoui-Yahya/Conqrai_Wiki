import { PlaneApiError } from '../../../../core/integration/services/plane-client.service';
import {
  buildWorkItemWrite,
  detectDroppedFields,
  isEmptyWrite,
  normalizeWorkItem,
  planeError,
  validateDateRange,
  writeWorkItem,
} from './work-item-fields';

// writeWorkItem takes a ConqrPlan call context: a signed delegation plus its
// correlation id. There is deliberately no way to pass a bare user id.
const ctx = { delegation: 'obo-token', correlationId: 'corr-1' };

function makePlane(overrides: Record<string, any> = {}) {
  return {
    isEnabled: jest.fn().mockReturnValue(true),
    createWorkItem: jest.fn(),
    updateWorkItem: jest.fn(),
    getWorkItem: jest.fn(),
    listProjectMembers: jest.fn().mockResolvedValue([{ id: 'member-1' }, { id: 'member-2' }]),
    listLabels: jest.fn().mockResolvedValue([{ id: 'label-1' }, { id: 'label-2' }]),
    addWorkItemsToCycle: jest.fn().mockResolvedValue({}),
    removeWorkItemFromCycle: jest.fn().mockResolvedValue(undefined),
    findWorkItemCycle: jest.fn().mockResolvedValue(null),
    addWorkItemsToModule: jest.fn().mockResolvedValue({}),
    removeWorkItemFromModule: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

const storedItem = (extra: Record<string, any> = {}) => ({
  id: 'wi-1',
  name: 'Item',
  sequence_id: 7,
  project: 'proj-1',
  state: 'state-1',
  state_detail: { name: 'Todo' },
  priority: 'high',
  assignees: [],
  labels: [],
  ...extra,
});

// ===========================================================================
// Tri-state field handling
// ===========================================================================

describe('buildWorkItemWrite — omitted vs cleared vs set', () => {
  it('omits fields that were not supplied', () => {
    const built = buildWorkItemWrite({ priority: 'high' });
    expect(built.payload).toEqual({ priority: 'high' });
    expect('target_date' in built.payload).toBe(false);
    expect('assignees' in built.payload).toBe(false);
    expect(built.cycle).toBeUndefined();
    expect(built.modules).toBeUndefined();
  });

  it('sends null for a field that was explicitly cleared', () => {
    const built = buildWorkItemWrite({ targetDate: null, parentId: null, estimatePointId: null });
    expect(built.payload.target_date).toBeNull();
    expect(built.payload.parent).toBeNull();
    expect(built.payload.estimate_point).toBeNull();
  });

  it('treats null and [] alike for the list fields', () => {
    expect(buildWorkItemWrite({ assigneeIds: null }).payload.assignees).toEqual([]);
    expect(buildWorkItemWrite({ assigneeIds: [] }).payload.assignees).toEqual([]);
    expect(buildWorkItemWrite({ labelIds: null }).payload.labels).toEqual([]);
  });

  it('clears a description with an empty string rather than dropping the key', () => {
    const built = buildWorkItemWrite({ description: null });
    expect(built.payload.description_html).toBe('');
  });

  it('wraps plain-text descriptions but leaves HTML alone', () => {
    expect(buildWorkItemWrite({ description: 'hello' }).payload.description_html).toBe('<p>hello</p>');
    expect(buildWorkItemWrite({ description: '<h1>hi</h1>' }).payload.description_html).toBe('<h1>hi</h1>');
  });

  it('routes cycle and modules away from the issue payload', () => {
    const built = buildWorkItemWrite({ cycleId: 'cyc-1', moduleIds: ['mod-1', 'mod-2'] });
    expect(built.payload).toEqual({});
    expect(built.cycle).toEqual({ id: 'cyc-1' });
    expect(built.modules).toEqual({ ids: ['mod-1', 'mod-2'] });
  });

  it('pairs an idempotency key with a default source', () => {
    const built = buildWorkItemWrite({ externalId: 'row-9' });
    expect(built.payload.external_id).toBe('row-9');
    expect(built.payload.external_source).toBe('conqrhub-mcp');
  });

  it('recognises a request that asks for nothing', () => {
    expect(isEmptyWrite(buildWorkItemWrite({}))).toBe(true);
    expect(isEmptyWrite(buildWorkItemWrite({ cycleId: null }))).toBe(false);
  });
});

// ===========================================================================
// Local validation
// ===========================================================================

describe('validateDateRange', () => {
  it('rejects a target date before the start date', () => {
    const problem = validateDateRange({ startDate: '2026-09-10', targetDate: '2026-09-01' });
    expect(problem).toMatchObject({ field: 'targetDate' });
  });

  it('accepts a valid range and partial input', () => {
    expect(validateDateRange({ startDate: '2026-09-01', targetDate: '2026-09-10' })).toBeNull();
    expect(validateDateRange({ targetDate: '2026-09-10' })).toBeNull();
    expect(validateDateRange({})).toBeNull();
  });
});

// ===========================================================================
// Normalisation
// ===========================================================================

describe('normalizeWorkItem', () => {
  it('surfaces every field and a stable URN', () => {
    const result = normalizeWorkItem(
      storedItem({
        assignees: ['member-1'],
        labels: ['label-1'],
        start_date: '2026-09-01',
        target_date: '2026-09-10',
        parent: 'wi-parent',
        estimate_point: 'pt-1',
      }) as any,
      'proj-1',
    );

    expect(result).toMatchObject({
      id: 'wi-1',
      urn: 'conqr://plane/work-item/wi-1',
      projectId: 'proj-1',
      sequenceId: 7,
      assigneeIds: ['member-1'],
      labelIds: ['label-1'],
      startDate: '2026-09-01',
      targetDate: '2026-09-10',
      parentId: 'wi-parent',
      estimatePointId: 'pt-1',
    });
  });

  it('keeps the original state contract while adding the split fields', () => {
    const named = normalizeWorkItem(storedItem() as any);
    expect(named.state).toBe('Todo');
    expect(named.stateId).toBe('state-1');
    expect(named.stateName).toBe('Todo');

    // No expansion: `state` falls back to the id exactly as it used to.
    const bare = normalizeWorkItem(storedItem({ state_detail: undefined }) as any);
    expect(bare.state).toBe('state-1');
    expect(bare.stateName).toBeNull();
  });
});

// ===========================================================================
// Dropped-field detection
// ===========================================================================

describe('detectDroppedFields', () => {
  it('reports ids that were requested but not stored', () => {
    const dropped = detectDroppedFields(
      { assigneeIds: ['member-1', 'ghost'] },
      normalizeWorkItem(storedItem({ assignees: ['member-1'] }) as any),
    );
    expect(dropped).toEqual([
      { field: 'assigneeIds', requested: ['member-1', 'ghost'], applied: ['member-1'], missing: ['ghost'] },
    ]);
  });

  it('says nothing when everything landed', () => {
    const dropped = detectDroppedFields(
      { assigneeIds: ['member-1'], labelIds: ['label-1'] },
      normalizeWorkItem(storedItem({ assignees: ['member-1'], labels: ['label-1'] }) as any),
    );
    expect(dropped).toEqual([]);
  });

  it('ignores fields the caller never mentioned', () => {
    expect(detectDroppedFields({}, normalizeWorkItem(storedItem() as any))).toEqual([]);
  });
});

// ===========================================================================
// Error mapping
// ===========================================================================

describe('planeError', () => {
  it('maps status codes onto stable codes', () => {
    expect(planeError(new PlaneApiError('x', 400, false)).code).toBe('VALIDATION_FAILED');
    expect(planeError(new PlaneApiError('x', 403, false)).code).toBe('PERMISSION_DENIED');
    expect(planeError(new PlaneApiError('x', 404, false)).code).toBe('NOT_FOUND');
    expect(planeError(new PlaneApiError('x', 409, false)).code).toBe('CONFLICT');
    expect(planeError(new PlaneApiError('x', 503, false)).code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it("surfaces ConqrPlan's own field message instead of a bare status", () => {
    const err = new PlaneApiError('Plane API 400', 400, false, {
      error: 'State is not valid please pass a valid state_id',
    });
    expect(planeError(err).error).toContain('State is not valid');
  });

  it('flattens per-field validation bodies', () => {
    const err = new PlaneApiError('Plane API 400', 400, false, { target_date: ['Enter a valid date.'] });
    expect(planeError(err).error).toContain('target_date: Enter a valid date.');
  });
});

// ===========================================================================
// End-to-end write behaviour
// ===========================================================================

describe('writeWorkItem', () => {
  it('creates with the full field set and returns the normalised item', async () => {
    const plane = makePlane();
    plane.createWorkItem.mockResolvedValue(
      storedItem({ assignees: ['member-1'], labels: ['label-1'] }),
    );
    plane.getWorkItem.mockResolvedValue(
      storedItem({ assignees: ['member-1'], labels: ['label-1'] }),
    );

    const result: any = await writeWorkItem(
      plane,
      'proj-1',
      { kind: 'create', name: 'Item' },
      {
        priority: 'high',
        stateId: 'state-1',
        assigneeIds: ['member-1'],
        labelIds: ['label-1'],
        startDate: '2026-09-01',
        targetDate: '2026-09-10',
      },
      ctx,
    );

    expect(result.error).toBeUndefined();
    expect(result.id).toBe('wi-1');
    expect(result.urn).toBe('conqr://plane/work-item/wi-1');
    expect(plane.createWorkItem).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({
        name: 'Item',
        priority: 'high',
        state: 'state-1',
        assignees: ['member-1'],
        labels: ['label-1'],
        start_date: '2026-09-01',
        target_date: '2026-09-10',
      }),
      { delegation: 'obo-token', correlationId: 'corr-1' },
    );
  });

  it('refuses an assignee who is not on the project, before writing anything', async () => {
    const plane = makePlane();

    const result: any = await writeWorkItem(
      plane,
      'proj-1',
      { kind: 'create', name: 'Item' },
      { assigneeIds: ['member-1', 'outsider'] },
      ctx,
    );

    expect(result.code).toBe('INVALID_REFERENCE');
    expect(result.error).toContain('outsider');
    expect(plane.createWorkItem).not.toHaveBeenCalled();
  });

  it('refuses a label that does not belong to the project', async () => {
    const plane = makePlane();
    const result: any = await writeWorkItem(
      plane,
      'proj-1',
      { kind: 'create', name: 'Item' },
      { labelIds: ['nope'] },
      ctx,
    );
    expect(result.code).toBe('INVALID_REFERENCE');
    expect(plane.createWorkItem).not.toHaveBeenCalled();
  });

  it('rejects an inverted date range locally', async () => {
    const plane = makePlane();
    const result: any = await writeWorkItem(
      plane,
      'proj-1',
      { kind: 'create', name: 'Item' },
      { startDate: '2026-09-10', targetDate: '2026-09-01' },
      ctx,
    );
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(plane.createWorkItem).not.toHaveBeenCalled();
  });

  it('reports a partial write when cycle membership fails', async () => {
    const plane = makePlane({
      addWorkItemsToCycle: jest
        .fn()
        .mockRejectedValue(new PlaneApiError('Plane API 400', 400, false, { error: 'CYCLE_COMPLETED' })),
    });
    plane.createWorkItem.mockResolvedValue(storedItem());

    const result: any = await writeWorkItem(
      plane,
      'proj-1',
      { kind: 'create', name: 'Item' },
      { cycleId: 'ended-cycle' },
      ctx,
    );

    // The item exists, so its id is still returned - but this is not a success.
    expect(result.id).toBe('wi-1');
    expect(result.code).toBe('PARTIAL_WRITE');
    expect(result.error).toContain('did not apply');
    expect(result.membership.failures).toHaveLength(1);
  });

  it('reports a partial write when ConqrPlan silently drops an assignee', async () => {
    // Membership changed between the pre-flight and the write.
    const plane = makePlane();
    plane.createWorkItem.mockResolvedValue(storedItem({ assignees: [] }));
    plane.getWorkItem.mockResolvedValue(storedItem({ assignees: [] }));

    const result: any = await writeWorkItem(
      plane,
      'proj-1',
      { kind: 'create', name: 'Item' },
      { assigneeIds: ['member-1'] },
      ctx,
    );

    expect(result.code).toBe('PARTIAL_WRITE');
    expect(result.details.droppedFields[0].missing).toEqual(['member-1']);
  });

  it('turns a duplicate idempotency key into a conflict carrying the existing id', async () => {
    const plane = makePlane({
      createWorkItem: jest.fn().mockRejectedValue(
        new PlaneApiError('Plane API 409', 409, false, {
          error: 'Issue with the same external id and external source already exists',
          id: 'wi-existing',
        }),
      ),
    });

    const result: any = await writeWorkItem(
      plane,
      'proj-1',
      { kind: 'create', name: 'Item' },
      { externalId: 'row-1' },
      ctx,
    );

    expect(result.code).toBe('CONFLICT');
    expect(result.details.existingWorkItemId).toBe('wi-existing');
  });

  it('refuses an update that changes nothing', async () => {
    const plane = makePlane();
    const result: any = await writeWorkItem(plane, 'proj-1', { kind: 'update', workItemId: 'wi-1' }, {}, ctx);
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(plane.updateWorkItem).not.toHaveBeenCalled();
  });

  it('clears fields on update without touching the others', async () => {
    const plane = makePlane();
    plane.updateWorkItem.mockResolvedValue(storedItem({ target_date: null }));

    await writeWorkItem(
      plane,
      'proj-1',
      { kind: 'update', workItemId: 'wi-1' },
      { targetDate: null },
      ctx,
    );

    const payload = plane.updateWorkItem.mock.calls[0][2];
    expect(payload.target_date).toBeNull();
    expect('priority' in payload).toBe(false);
    expect('name' in payload).toBe(false);
  });

  it('looks up the current cycle and removes the item when cycleId is cleared', async () => {
    const plane = makePlane();
    plane.updateWorkItem.mockResolvedValue(storedItem());
    plane.findWorkItemCycle.mockResolvedValue('cyc-7');

    const result: any = await writeWorkItem(
      plane,
      'proj-1',
      { kind: 'update', workItemId: 'wi-1' },
      { cycleId: null },
      { ...ctx },
    );

    // ConqrPlan's work-item payload does not carry its cycle, so the id has to
    // be resolved before it can be removed.
    expect(plane.findWorkItemCycle).toHaveBeenCalledWith('proj-1', 'wi-1');
    expect(plane.removeWorkItemFromCycle).toHaveBeenCalledWith('proj-1', 'cyc-7', 'wi-1', {
      delegation: 'obo-token',
      correlationId: 'corr-1',
    });
    expect(result.membership.applied).toContain('cycleId:cleared');
    expect(result.code).toBeUndefined();
  });

  it('treats clearing an item that is in no cycle as already applied', async () => {
    const plane = makePlane();
    plane.updateWorkItem.mockResolvedValue(storedItem());
    plane.findWorkItemCycle.mockResolvedValue(null);

    const result: any = await writeWorkItem(
      plane,
      'proj-1',
      { kind: 'update', workItemId: 'wi-1' },
      { cycleId: null },
      { ...ctx },
    );

    expect(plane.removeWorkItemFromCycle).not.toHaveBeenCalled();
    expect(result.membership.applied).toContain('cycleId:cleared');
    expect(result.membership.failures).toEqual([]);
  });

  it('reports a partial write when the current cycle cannot be determined', async () => {
    const plane = makePlane();
    plane.updateWorkItem.mockResolvedValue(storedItem());
    // undefined means the bounded scan did not finish - not "no cycle".
    plane.findWorkItemCycle.mockResolvedValue(undefined);

    const result: any = await writeWorkItem(
      plane,
      'proj-1',
      { kind: 'update', workItemId: 'wi-1' },
      { cycleId: null },
      { ...ctx },
    );

    // The one thing this must never do is report the clear as done.
    expect(plane.removeWorkItemFromCycle).not.toHaveBeenCalled();
    expect(result.membership.applied).not.toContain('cycleId:cleared');
    expect(result.code).toBe('PARTIAL_WRITE');
    expect(result.error).toMatch(/could not determine which cycle/i);
  });
});
