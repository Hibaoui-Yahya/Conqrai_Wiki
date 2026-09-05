import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { DeliveryProjectionService } from './delivery-projection.service';

/**
 * Database-backed tests for the delivery-status projection.
 *
 * The properties under test — duplicate suppression, ordering, reconciliation
 * — are all about what the *database* ends up holding after a sequence of
 * events, so a mock would only prove the mock agrees with itself. These run
 * against real Postgres with the real migration applied.
 *
 * They live behind their own Jest config, so `pnpm test` on a machine with
 * nothing running is unaffected. Running this config *is* the choice to test
 * against a database, so an unreachable one fails loudly rather than skipping:
 * a suite that quietly passes when it never ran is worse than no suite.
 *
 *   docker compose up -d db
 *   pnpm --filter server migration:latest
 *   npx jest --config jest-int.json
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://docmost:docmostdev@localhost:5433/docmost';

const URN = 'conqr://plane/work-item/wi-projection-test';

let db: Kysely<any>;
let service: DeliveryProjectionService;
let workspaceId: string;

beforeAll(async () => {
  db = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: DATABASE_URL, max: 2 }),
    }),
    // Same as the application's connection: column names are snake_case in
    // Postgres and camelCase in the query builder.
    plugins: [new CamelCasePlugin()],
  });
  const ws = await db
    .selectFrom('workspaces')
    .select('id')
    .limit(1)
    .executeTakeFirst();
  if (!ws) {
    throw new Error(
      'No workspace found. These tests need a migrated database with at least one workspace: ' +
        'docker compose up -d db && pnpm --filter server migration:latest',
    );
  }
  workspaceId = ws.id;
  service = new DeliveryProjectionService(db as any);
}, 30_000);

afterAll(async () => {
  if (db) await db.destroy();
});

beforeEach(async () => {
  await db
    .deleteFrom('integrationWorkItemStatus')
    .where('workItemUrn', '=', URN)
    .execute();
});

const update = (over: Record<string, unknown> = {}) => ({
  workspaceId,
  workItemUrn: URN,
  planeProjectId: 'proj-1',
  title: 'Implement login',
  state: 'In Progress',
  stateGroup: 'started',
  sourceUpdatedAt: '2026-09-04T10:00:00Z',
  deliveryId: 'delivery-1',
  ...over,
});

// ===========================================================================
// 7. A ConqrPlan state change updates the Hub presentation
// ===========================================================================

describe('status projection', () => {
  it('records a status the Hub can render', async () => {
    const outcome = await service.apply(update());
    expect(outcome).toEqual({ applied: true, reason: 'created' });

    const stored = await service.get(workspaceId, URN);
    expect(stored).toMatchObject({
      state: 'In Progress',
      stateGroup: 'started',
      title: 'Implement login',
    });
  });

  it('a later state change replaces the earlier one', async () => {
    await service.apply(update());
    const outcome = await service.apply(
      update({
        state: 'Done',
        stateGroup: 'completed',
        completed: true,
        sourceUpdatedAt: '2026-09-04T11:00:00Z',
        deliveryId: 'delivery-2',
      }),
    );

    expect(outcome).toEqual({ applied: true, reason: 'updated' });
    const stored = await service.get(workspaceId, URN);
    expect(stored).toMatchObject({ state: 'Done', completed: true });
  });
});

// ===========================================================================
// 8. Duplicate delivery changes nothing after the first
// ===========================================================================

describe('duplicate deliveries', () => {
  it('applying the identical payload twice leaves the same row', async () => {
    await service.apply(update());
    const first = await service.get(workspaceId, URN);

    await service.apply(update());
    const second = await service.get(workspaceId, URN);

    // Same content. `apply` is idempotent even if the upstream delivery-id
    // guard were bypassed.
    expect(second).toMatchObject({
      state: first!.state,
      stateGroup: first!.stateGroup,
      title: first!.title,
      completed: first!.completed,
      sourceUpdatedAt: first!.sourceUpdatedAt,
    });

    // And exactly one row, not two.
    const rows = await db
      .selectFrom('integrationWorkItemStatus')
      .selectAll()
      .where('workItemUrn', '=', URN)
      .execute();
    expect(rows).toHaveLength(1);
  });
});

// ===========================================================================
// 9. An older event cannot overwrite newer status
// ===========================================================================

describe('out-of-order deliveries', () => {
  it('discards an event older than the stored version', async () => {
    await service.apply(
      update({
        state: 'Done',
        completed: true,
        sourceUpdatedAt: '2026-09-04T12:00:00Z',
      }),
    );

    // A retry of an earlier delivery arrives late. At-least-once delivery
    // makes this normal, not exotic.
    const outcome = await service.apply(
      update({
        state: 'In Progress',
        completed: false,
        sourceUpdatedAt: '2026-09-04T10:00:00Z',
        deliveryId: 'delivery-late',
      }),
    );

    expect(outcome).toEqual({ applied: false, reason: 'stale' });
    const stored = await service.get(workspaceId, URN);
    // Status did not roll backwards.
    expect(stored).toMatchObject({ state: 'Done', completed: true });
  });

  it('accepts an event with the same timestamp', async () => {
    // ConqrPlan's updated_at has second granularity, so two genuine changes
    // can share one. Refusing them would silently lose the later change.
    await service.apply(update({ state: 'A' }));
    const outcome = await service.apply(
      update({ state: 'B', deliveryId: 'delivery-same-ts' }),
    );

    expect(outcome).toEqual({ applied: true, reason: 'updated' });
    expect((await service.get(workspaceId, URN))!.state).toBe('B');
  });

  it('accepts an event when nothing is stored yet', async () => {
    const outcome = await service.apply(update({ sourceUpdatedAt: null }));
    expect(outcome.applied).toBe(true);
  });
});

// ===========================================================================
// 10. A missing event is repaired through reconciliation
// ===========================================================================

describe('reconciliation', () => {
  it('finds rows that have not been heard about recently', async () => {
    await service.apply(update());
    // Simulate an item whose events stopped arriving.
    await db
      .updateTable('integrationWorkItemStatus')
      .set({ lastEventAt: new Date('2026-09-01T00:00:00Z') } as any)
      .where('workItemUrn', '=', URN)
      .execute();

    const stale = await service.findStale(
      workspaceId,
      new Date('2026-09-03T00:00:00Z'),
    );

    expect(stale.map((s) => s.workItemUrn)).toContain(URN);
  });

  it('a fresh row is not treated as stale', async () => {
    await service.apply(update());
    const stale = await service.findStale(
      workspaceId,
      new Date('2020-01-01T00:00:00Z'),
    );
    expect(stale.map((s) => s.workItemUrn)).not.toContain(URN);
  });

  it('repairs the projection from the source and records that it asked', async () => {
    // Event lost: the Hub still believes the item is in progress.
    await service.apply(update({ state: 'In Progress' }));

    // Reconciliation reads the truth from ConqrPlan and applies it.
    await service.apply(
      update({
        state: 'Done',
        completed: true,
        sourceUpdatedAt: '2026-09-04T13:00:00Z',
        deliveryId: null,
      }),
    );
    await service.markReconciled(workspaceId, URN);

    const stored = await service.get(workspaceId, URN);
    expect(stored).toMatchObject({ state: 'Done', completed: true });
    // reconciledAt says "we asked"; lastEventAt says "we were told". Keeping
    // them apart is what makes a repaired row distinguishable from a reported
    // one in the audit trail.
    expect(stored!.reconciledAt).toBeInstanceOf(Date);
  });

  it('excludes items known to be deleted in the source', async () => {
    await service.apply(update({ deletedInSource: true }));
    await db
      .updateTable('integrationWorkItemStatus')
      .set({ lastEventAt: new Date('2026-09-01T00:00:00Z') } as any)
      .where('workItemUrn', '=', URN)
      .execute();

    const stale = await service.findStale(
      workspaceId,
      new Date('2026-09-03T00:00:00Z'),
    );
    // Nothing to reconcile: it is gone, and asking again would only 404.
    expect(stale.map((s) => s.workItemUrn)).not.toContain(URN);
  });
});
