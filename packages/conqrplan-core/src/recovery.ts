import { CONQRPLAN_TOOLS, isMutatingTool } from './tools';

/**
 * How to establish what actually happened when a routed mutation's outcome is
 * unknown.
 *
 * "Read it back by external_id" is only true for create. It is wrong for the
 * others, and confidently wrong advice is worse than none:
 *
 * - An **update** has no idempotency key. Finding the field already at the
 *   intended value does not prove this call applied it - a colleague may have
 *   made the same change a second earlier, and repeating the write would then
 *   silently overwrite whatever they did next.
 * - A **comment** has no natural key at all. Re-posting duplicates it visibly,
 *   in front of the whole project.
 * - A **bulk create** is not one outcome. Each row has to be resolved on its
 *   own key, and the rows that did land must not be created again because a
 *   later row failed.
 * - An **estimate configuration** is idempotent in effect but not in reporting:
 *   activation has two markers, and reading only one of them has been wrong
 *   here before.
 *
 * So this returns the operation's own answer rather than one sentence for
 * everything.
 */

export type MutationKind =
  | 'none'
  | 'create'
  | 'update'
  | 'bulk-create'
  | 'comment'
  | 'estimate-config';

export interface RecoveryGuidance {
  kind: MutationKind;
  /** Whether the tool accepts a caller-supplied key that survives a retry. */
  idempotencySupport: 'external-id' | 'per-row-external-id' | 'none' | 'n/a';
  /** What to read to find out whether it happened. */
  evidence: string;
  /** What is safe to do once the evidence is in. */
  safeRecovery: string;
  /** When repeating the operation is not safe. */
  unsafeRetryWhen: string;
}

const READ_ONLY: RecoveryGuidance = {
  kind: 'none',
  idempotencySupport: 'n/a',
  evidence: 'Nothing was written; the call can simply be repeated.',
  safeRecovery: 'Retry the read.',
  unsafeRetryWhen: 'Never unsafe.',
};

const BY_TOOL: Record<string, RecoveryGuidance> = {
  create_work_item: {
    kind: 'create',
    idempotencySupport: 'external-id',
    evidence:
      'List work items filtered by external_id/external_source; ConqrPlan returns the existing item if the create landed.',
    safeRecovery:
      'If the item exists under the key, adopt it as the result. If it does not, the create may be retried with the same externalId.',
    unsafeRetryWhen:
      'The call carried no externalId. There is then no way to tell a lost create from a duplicated one; ask a human before creating again.',
  },
  bulk_create_work_items: {
    kind: 'bulk-create',
    idempotencySupport: 'per-row-external-id',
    evidence:
      'Resolve each row independently on its own externalId. The per-item results already returned are authoritative for the rows they name.',
    safeRecovery:
      'Re-run only the rows with no item under their key, preserving the indices and outcomes of the rows that succeeded.',
    unsafeRetryWhen:
      'Re-running the whole batch. Rows that landed would be created a second time, and the partial result would be lost.',
  },
  update_work_item: {
    kind: 'update',
    idempotencySupport: 'none',
    evidence:
      'Read the work item back and compare it with the intended change, together with its updated_at and recent activity to see who applied it.',
    safeRecovery:
      'If the activity shows this actor applied the intended change, treat it as done. If the field merely already holds the value, do not assume this call did it.',
    unsafeRetryWhen:
      'Another actor has edited the item since. Repeating the write would overwrite their change without anyone seeing it.',
  },
  add_work_item_comment: {
    kind: 'comment',
    idempotencySupport: 'none',
    evidence:
      'List the work item comments and look for this actor posting this text around the attempt time.',
    safeRecovery:
      'If the comment is present, treat it as posted. If not, it may be posted again.',
    unsafeRetryWhen:
      'The comment thread cannot be read. A blind retry duplicates the comment visibly for the whole project.',
  },
  create_estimate_system: {
    kind: 'estimate-config',
    idempotencySupport: 'none',
    evidence:
      "Read the project's estimate configuration back and check both the estimate itself and its points.",
    safeRecovery:
      'If an estimate system exists, adopt it; the tool already refuses to create a second one and reports already_exists with the existing id.',
    unsafeRetryWhen:
      'Never blind-retry: a second create is refused, so a retry tells you nothing new that reading does not.',
  },
  activate_estimate_system: {
    kind: 'estimate-config',
    idempotencySupport: 'none',
    evidence:
      'Read the estimate configuration and check both activation markers, not just one.',
    safeRecovery:
      'Activation is idempotent in effect, so once the configuration is read the desired state can be set again safely.',
    unsafeRetryWhen:
      'Only when the configuration cannot be read at all, in which case the current state is unknown.',
  },
};

export function recoveryFor(toolName: string): RecoveryGuidance {
  const known = BY_TOOL[toolName];
  if (known) return known;
  if (!isMutatingTool(toolName)) return READ_ONLY;
  // A mutating tool with no entry is a gap in this table, not a safe default.
  return {
    kind: 'update',
    idempotencySupport: 'none',
    evidence: `No recovery procedure is recorded for ${toolName}. Read the affected object back before acting.`,
    safeRecovery: 'Establish the current state by reading, then decide manually.',
    unsafeRetryWhen: 'Always, until a procedure is recorded for this tool.',
  };
}

/** Every mutating tool must have an explicit entry; used by the tests. */
export function toolsMissingRecovery(): string[] {
  return CONQRPLAN_TOOLS.filter((t) => isMutatingTool(t.name) && !BY_TOOL[t.name]).map(
    (t) => t.name,
  );
}
