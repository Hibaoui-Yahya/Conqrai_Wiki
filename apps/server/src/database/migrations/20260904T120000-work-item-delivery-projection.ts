import { type Kysely, sql } from 'kysely';

/**
 * Delivery-status projection for linked ConqrPlan work (Vertical Slice 01).
 *
 * ConqrPlan remains authoritative for execution state. This table holds only
 * what the Hub experience needs to render a Related Work card without a live
 * round trip, and to survive ConqrPlan being briefly unreachable.
 *
 * Two columns exist purely to make an at-least-once event stream safe:
 *
 *   source_updated_at   ConqrPlan's own updated_at for the version this row
 *                       reflects. A projection update whose payload is older
 *                       than this is discarded, so a delivery that arrives out
 *                       of order cannot roll the status backwards.
 *   last_delivery_id    the webhook delivery this row was last written from,
 *                       for tracing a value back to the event that produced it.
 *
 * Duplicate suppression itself lives in integration_webhook_deliveries, which
 * already refuses a delivery id it has seen.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('integration_work_item_status')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    // Canonical URN, so the projection is keyed the same way the graph is.
    .addColumn('work_item_urn', 'varchar', (col) => col.notNull())
    .addColumn('plane_project_id', 'varchar')
    .addColumn('title', 'varchar')
    .addColumn('state', 'varchar')
    .addColumn('state_group', 'varchar')
    .addColumn('completed', 'boolean', (col) => col.notNull().defaultTo(false))
    // Null means "we know the item is gone", which is different from "we have
    // never heard about it" (no row at all).
    .addColumn('deleted_in_source', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    .addColumn('source_updated_at', 'timestamptz')
    .addColumn('last_delivery_id', 'varchar')
    .addColumn('last_event_at', 'timestamptz')
    // When the projection was last confirmed against ConqrPlan directly,
    // rather than inferred from an event. Reconciliation sets this.
    .addColumn('reconciled_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('integration_work_item_status_urn_unique', [
      'workspace_id',
      'work_item_urn',
    ])
    .execute();

  // Reconciliation sweeps "what have I not heard about recently", so it reads
  // by workspace ordered by staleness.
  await db.schema
    .createIndex('integration_work_item_status_stale_idx')
    .on('integration_work_item_status')
    .columns(['workspace_id', 'last_event_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex('integration_work_item_status_stale_idx')
    .ifExists()
    .execute();
  await db.schema
    .dropTable('integration_work_item_status')
    .ifExists()
    .execute();
}
