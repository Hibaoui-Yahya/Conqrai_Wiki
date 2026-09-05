import { PlaneApiError } from '../../../../core/integration/services/plane-client.service';
import { ChatToolRegistry } from './chat-tool.registry';
import {
  ActivateEstimateSystemTool,
  BulkCreateWorkItemsTool,
  CreateEstimateSystemTool,
  GetEstimateSystemTool,
  PLANE_CONTROL_TOOLS,
} from './plane-control.tools';

/**
 * A delegation service stub. Every ConqrPlan call from a tool must carry a
 * signed on-behalf-of token; these tests assert the token is minted with the
 * right scopes and travels with the call, not that HMAC works (covered by
 * delegated-token.util.spec.ts).
 */
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
  } as any;
}

/** The call context every delegated ConqrPlan request should carry. */
const DELEGATED_CALL = { delegation: 'obo-token', correlationId: 'corr-1' };


const ctx = { user: { id: 'user-1' } as any, workspaceId: 'ws-1' };

function makePlane(overrides: Record<string, any> = {}) {
  let counter = 0;
  return {
    isEnabled: jest.fn().mockReturnValue(true),
    createWorkItem: jest.fn().mockImplementation(async (_p: string, body: any) => ({
      id: `wi-${++counter}`,
      name: body.name,
      sequence_id: counter,
      project: 'proj-1',
      assignees: body.assignees ?? [],
      labels: body.labels ?? [],
    })),
    getWorkItem: jest.fn().mockImplementation(async (_p: string, id: string) => ({
      id,
      name: 'Item',
      project: 'proj-1',
      assignees: [],
      labels: [],
    })),
    updateWorkItem: jest.fn(),
    listProjectMembers: jest.fn().mockResolvedValue([{ id: 'member-1' }]),
    listLabels: jest.fn().mockResolvedValue([{ id: 'label-1' }]),
    addWorkItemsToCycle: jest.fn().mockResolvedValue({}),
    addWorkItemsToModule: jest.fn().mockResolvedValue({}),
    removeWorkItemFromCycle: jest.fn(),
    getProjectEstimate: jest.fn(),
    createEstimate: jest.fn(),
    updateEstimate: jest.fn(),
    createEstimatePoints: jest.fn(),
    listEstimatePoints: jest.fn(),
    ...overrides,
  } as any;
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Item ${i + 1}` }));

// ===========================================================================
// Registration
// ===========================================================================

describe('control tool registration', () => {
  it('registers every tool when the integration is configured', () => {
    const registry = new ChatToolRegistry();
    const plane = makePlane();
    const tools = PLANE_CONTROL_TOOLS.map((T) => new (T as any)(plane, registry));
    tools.forEach((t: any) => t.onModuleInit());
    expect(registry.getAll().map((t: any) => t.name).sort()).toEqual(
      ['activate_estimate_system', 'bulk_create_work_items', 'create_estimate_system', 'get_estimate_system'].sort(),
    );
  });

  it('registers nothing when the integration is not configured', () => {
    const registry = new ChatToolRegistry();
    const plane = makePlane({ isEnabled: jest.fn().mockReturnValue(false) });
    PLANE_CONTROL_TOOLS.forEach((T) => new (T as any)(plane, registry).onModuleInit());
    expect(registry.getAll()).toHaveLength(0);
  });
});

// ===========================================================================
// Bulk creation
// ===========================================================================

describe('bulk_create_work_items', () => {
  it('creates a single item and reports it by index', async () => {
    const plane = makePlane();
    const tool = new BulkCreateWorkItemsTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute({ projectId: 'proj-1', items: rows(1) }, ctx);

    expect(result).toMatchObject({ total: 1, created: 1, failed: 0, duplicate: 0, partial: 0 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ index: 0, status: 'created', name: 'Item 1' });
    expect(result.results[0].urn).toMatch(/^conqr:\/\/plane\/work-item\//);
  });

  it('creates the maximum batch of 100', async () => {
    const plane = makePlane();
    const tool = new BulkCreateWorkItemsTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute({ projectId: 'proj-1', items: rows(100) }, ctx);

    expect(result.total).toBe(100);
    expect(result.created).toBe(100);
    expect(result.results).toHaveLength(100);
    expect(plane.createWorkItem).toHaveBeenCalledTimes(100);
  });

  it('rejects 101 items before creating anything', async () => {
    const plane = makePlane();
    const tool = new BulkCreateWorkItemsTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute({ projectId: 'proj-1', items: rows(101) }, ctx);

    expect(result.code).toBe('LIMIT_EXCEEDED');
    expect(result.error).toContain('Nothing was created');
    expect(plane.createWorkItem).not.toHaveBeenCalled();
  });

  it('rejects an empty batch', async () => {
    const plane = makePlane();
    const tool = new BulkCreateWorkItemsTool(plane, new ChatToolRegistry(), makeDelegation());
    const result: any = await tool.execute({ projectId: 'proj-1', items: [] }, ctx);
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(plane.createWorkItem).not.toHaveBeenCalled();
  });

  it('rejects a batch that repeats an idempotency key, before creating anything', async () => {
    const plane = makePlane();
    const tool = new BulkCreateWorkItemsTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute(
      {
        projectId: 'proj-1',
        items: [
          { name: 'A', externalId: 'dup' },
          { name: 'B', externalId: 'dup' },
        ],
      },
      ctx,
    );

    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.error).toContain('dup');
    expect(plane.createWorkItem).not.toHaveBeenCalled();
  });

  it('returns a result for every row when one fails part-way through', async () => {
    let call = 0;
    const plane = makePlane({
      createWorkItem: jest.fn().mockImplementation(async (_p: string, body: any) => {
        call += 1;
        if (call === 2) {
          throw new PlaneApiError('Plane API 400', 400, false, {
            error: 'State is not valid please pass a valid state_id',
          });
        }
        return { id: `wi-${call}`, name: body.name, sequence_id: call, project: 'proj-1' };
      }),
    });
    const tool = new BulkCreateWorkItemsTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute({ projectId: 'proj-1', items: rows(3) }, ctx);

    expect(result).toMatchObject({ total: 3, created: 2, failed: 1 });
    expect(result.results.map((r: any) => r.index)).toEqual([0, 1, 2]);
    expect(result.results[1]).toMatchObject({ status: 'failed', code: 'VALIDATION_FAILED' });
    expect(result.results[1].error).toContain('State is not valid');
    // No rollback: the rows before and after the failure still exist.
    expect(result.results[0].status).toBe('created');
    expect(result.results[2].status).toBe('created');
  });

  it('marks a repeated idempotency key as a duplicate carrying the existing id', async () => {
    const plane = makePlane({
      createWorkItem: jest.fn().mockRejectedValue(
        new PlaneApiError('Plane API 409', 409, false, { error: 'already exists', id: 'wi-existing' }),
      ),
    });
    const tool = new BulkCreateWorkItemsTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute(
      { projectId: 'proj-1', items: [{ name: 'A', externalId: 'row-1' }] },
      ctx,
    );

    expect(result.duplicate).toBe(1);
    expect(result.created).toBe(0);
    expect(result.results[0]).toMatchObject({ status: 'duplicate', workItemId: 'wi-existing' });
  });

  it('flags a row whose cycle membership failed as partial, not created', async () => {
    const plane = makePlane({
      addWorkItemsToCycle: jest
        .fn()
        .mockRejectedValue(new PlaneApiError('Plane API 400', 400, false, { error: 'CYCLE_COMPLETED' })),
    });
    const tool = new BulkCreateWorkItemsTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute(
      { projectId: 'proj-1', items: [{ name: 'A', cycleId: 'ended' }] },
      ctx,
    );

    expect(result.partial).toBe(1);
    expect(result.created).toBe(0);
    expect(result.results[0]).toMatchObject({ status: 'partial', code: 'PARTIAL_WRITE' });
    expect(result.results[0].workItemId).toBeDefined();
  });

  it('passes the full field set through for each row', async () => {
    const plane = makePlane();
    const tool = new BulkCreateWorkItemsTool(plane, new ChatToolRegistry(), makeDelegation());

    await tool.execute(
      {
        projectId: 'proj-1',
        items: [
          {
            name: 'Rich',
            priority: 'urgent',
            stateId: 'state-1',
            assigneeIds: ['member-1'],
            labelIds: ['label-1'],
            targetDate: '2026-12-01',
          },
        ],
      },
      ctx,
    );

    expect(plane.createWorkItem).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({
        name: 'Rich',
        priority: 'urgent',
        state: 'state-1',
        assignees: ['member-1'],
        labels: ['label-1'],
        target_date: '2026-12-01',
      }),
      DELEGATED_CALL,
    );
  });
});

// ===========================================================================
// Estimates
// ===========================================================================

describe('get_estimate_system', () => {
  it('reports plainly when no system is configured', async () => {
    const plane = makePlane({ getProjectEstimate: jest.fn().mockResolvedValue(null) });
    const tool = new GetEstimateSystemTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute({ projectId: 'proj-1' }, ctx);

    expect(result).toMatchObject({ configured: false, isActive: false });
    expect(result.message).toContain('create_estimate_system');
  });

  it('returns the active system with its points', async () => {
    const plane = makePlane({
      getProjectEstimate: jest
        .fn()
        .mockResolvedValue({ id: 'est-1', name: 'Fibonacci', type: 'points', is_active: true }),
      listEstimatePoints: jest.fn().mockResolvedValue([
        { id: 'pt-1', key: 0, value: '1' },
        { id: 'pt-2', key: 1, value: '2' },
      ]),
    });
    const tool = new GetEstimateSystemTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute({ projectId: 'proj-1' }, ctx);

    expect(result).toMatchObject({ configured: true, isActive: true, id: 'est-1' });
    expect(result.points).toHaveLength(2);
  });

  it('shows a system that exists but is switched off', async () => {
    const plane = makePlane({
      getProjectEstimate: jest.fn().mockResolvedValue({ id: 'est-1', name: 'X', is_active: false }),
      listEstimatePoints: jest.fn().mockResolvedValue([]),
    });
    const tool = new GetEstimateSystemTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute({ projectId: 'proj-1' }, ctx);
    expect(result).toMatchObject({ configured: true, isActive: false });
  });
});

describe('create_estimate_system', () => {
  it('creates the system, its points, and confirms activation', async () => {
    const plane = makePlane({
      getProjectEstimate: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'est-1', name: 'Fibonacci', is_active: true }),
      createEstimate: jest.fn().mockResolvedValue({ id: 'est-1', name: 'Fibonacci', type: 'points' }),
      createEstimatePoints: jest.fn().mockResolvedValue([
        { id: 'pt-1', key: 0, value: '1' },
        { id: 'pt-2', key: 1, value: '2' },
        { id: 'pt-3', key: 2, value: '3' },
      ]),
    });
    const tool = new CreateEstimateSystemTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute(
      { projectId: 'proj-1', name: 'Fibonacci', type: 'points', values: ['1', '2', '3'] },
      ctx,
    );

    expect(result).toMatchObject({ id: 'est-1', isActive: true });
    expect(result.points).toHaveLength(3);
    expect(plane.createEstimatePoints).toHaveBeenCalledWith(
      'proj-1',
      'est-1',
      [
        { key: 0, value: '1' },
        { key: 1, value: '2' },
        { key: 2, value: '3' },
      ],
      DELEGATED_CALL,
    );
  });

  it('refuses when the project already has a system', async () => {
    const plane = makePlane({
      getProjectEstimate: jest.fn().mockResolvedValue({ id: 'est-existing', name: 'Old' }),
    });
    const tool = new CreateEstimateSystemTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute({ projectId: 'proj-1', name: 'New', values: ['1'] }, ctx);

    expect(result.code).toBe('CONFLICT');
    expect(plane.createEstimate).not.toHaveBeenCalled();
  });

  it('warns rather than claiming success when the system did not activate', async () => {
    const plane = makePlane({
      getProjectEstimate: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'est-1', name: 'F', is_active: false }),
      createEstimate: jest.fn().mockResolvedValue({ id: 'est-1', name: 'F' }),
      createEstimatePoints: jest.fn().mockResolvedValue([{ id: 'pt-1', key: 0, value: '1' }]),
    });
    const tool = new CreateEstimateSystemTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute({ projectId: 'proj-1', name: 'F', values: ['1'] }, ctx);

    expect(result.code).toBe('PARTIAL_WRITE');
    expect(result.error).toContain('activate_estimate_system');
  });
});

describe('activate_estimate_system', () => {
  it('activates and is safe to repeat', async () => {
    const plane = makePlane({
      getProjectEstimate: jest.fn().mockResolvedValue({ id: 'est-1', name: 'F', is_active: false }),
      updateEstimate: jest.fn().mockResolvedValue({ id: 'est-1', name: 'F', is_active: true }),
    });
    const tool = new ActivateEstimateSystemTool(plane, new ChatToolRegistry(), makeDelegation());

    const first: any = await tool.execute({ projectId: 'proj-1' }, ctx);
    const second: any = await tool.execute({ projectId: 'proj-1' }, ctx);

    expect(first).toMatchObject({ id: 'est-1', isActive: true });
    expect(second).toMatchObject({ id: 'est-1', isActive: true });
    expect(plane.updateEstimate).toHaveBeenCalledWith('proj-1', { is_active: true }, DELEGATED_CALL);
  });

  it('switches estimation off when asked', async () => {
    const plane = makePlane({
      getProjectEstimate: jest.fn().mockResolvedValue({ id: 'est-1', name: 'F', is_active: true }),
      updateEstimate: jest.fn().mockResolvedValue({ id: 'est-1', name: 'F', is_active: false }),
    });
    const tool = new ActivateEstimateSystemTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute({ projectId: 'proj-1', active: false }, ctx);

    expect(result.isActive).toBe(false);
    expect(plane.updateEstimate).toHaveBeenCalledWith('proj-1', { is_active: false }, DELEGATED_CALL);
  });

  it('explains when there is no system to activate', async () => {
    const plane = makePlane({ getProjectEstimate: jest.fn().mockResolvedValue(null) });
    const tool = new ActivateEstimateSystemTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute({ projectId: 'proj-1' }, ctx);

    expect(result.code).toBe('NO_ESTIMATE_SYSTEM');
    expect(plane.updateEstimate).not.toHaveBeenCalled();
  });

  it('surfaces a permission failure as such', async () => {
    const plane = makePlane({
      getProjectEstimate: jest.fn().mockResolvedValue({ id: 'est-1', name: 'F' }),
      updateEstimate: jest.fn().mockRejectedValue(new PlaneApiError('Plane API 403', 403, false)),
    });
    const tool = new ActivateEstimateSystemTool(plane, new ChatToolRegistry(), makeDelegation());

    const result: any = await tool.execute({ projectId: 'proj-1' }, ctx);
    expect(result.code).toBe('PERMISSION_DENIED');
  });
});
