# Vertical Slice 01 — requirement to linked execution

The first flow that makes ConqrSuite more than two products sharing a login: a
delivery-accountable lead opens a ConqrHub page, sees which requirements have
no work behind them, creates that work in ConqrPlan **under their own
identity**, and watches its delivery status without leaving the requirement's
context.

- **Status:** complete. UI, authoring, fallback and reconciliation shipped in
  the follow-on phase — see `vertical-slice-01-ui.md` and
  `vertical-slice-01-evidence.md`.
- **Depends on:** `conqrsuite-delegation.md` (gate 1). Every ConqrPlan call in
  this slice is delegated.

---

## 1. Ownership boundaries

| Owns | ConqrHub | ConqrPlan |
|---|---|---|
| Page, requirements, lifecycle | ✅ | |
| Coverage | ✅ | |
| Cross-product relationships (Context Graph) | ✅ | |
| Work item, assignment, estimate, delivery state | | ✅ |
| Authorization for work | | ✅ |

No shared database, no cross-product database write, no distributed
transaction, no authorization fallback, and neither product copies the other's
objects — ConqrHub keeps a canonical URN and a small status projection, nothing
more.

---

## 2. Canonical relationship

One edge, stored once, from the Hub requirement:

```
conqr://hub/page/<pageId>#block=<blockId>
        ──implemented_by──▶  conqr://plane/work-item/<id>
        ◀──implements─────   (derived, never stored a second time)
```

`relationType` is `implemented_by`; `inverseRelationType` is `implements` and
comes from the relation registry, so the inverse is navigable without a second
row that could disagree. ConqrPlan holds no copy of the relationship at all —
ConqrHub's Context Graph is authoritative for cross-product edges.

The direction was verified against the existing model rather than invented:
`implemented_by` is already one of the delivery relations `TraceabilityService`
counts as coverage, so linking work makes a requirement covered without a
parallel notion of coverage being introduced.

---

## 3. Create-linked-work flow

```
1. user picks an uncovered requirement
2. ConqrHub resolves the mapped ConqrPlan project (space → project mapping)
3. preview          POST /integrations/requirements/preview-linked-work
                    - proposed item, relation, idempotency key, existing work
                    - changes nothing
4. user confirms
5. ConqrHub mints an OBO token (work-item:create) for the acting human
6. ConqrPlan creates the item, keyed on external_id
7. ConqrHub records the canonical relationship
   (integration event emitted in the same transaction as the edge)
8. receipt          urn, relationship + derived inverse, actor, correlation id
9. Related Work refreshes through permission-filtered resolution
```

### Why a preview step

The mutation is not undoable from ConqrHub. Removing the relationship later
never deletes the ConqrPlan work item, and it should not — ConqrHub does not own
that work. So the user is shown what will happen in the other product before it
does.

### Idempotency

```
req:conqr://hub/page/<pageId>#block=<blockId>|project:<planeProjectId>
```

Sent as ConqrPlan's `external_id` with `external_source: conqrhub`. ConqrPlan
enforces uniqueness per project and answers a repeat with `409` plus the id of
the item that already exists.

Deterministic on purpose: it is what makes a retry converge. A double-clicked
confirm, a retried timeout, and a repair after a half-finished create all
resolve to the same work item. Scoped by project, because the same requirement
may legitimately have work in two projects.

### Partial failure

There is no global transaction and the slice does not pretend otherwise. Two
systems each commit their own half:

| Outcome | Status | What the user sees |
|---|---|---|
| Both halves committed | `created` | Success receipt |
| Key already resolved; link ensured | `already_exists` | Success, no duplicate |
| ConqrPlan committed, Hub link failed | `created_link_failed` | Explicit warning naming the retry |

`created_link_failed` is honest rather than convenient: the work item really
does exist, and saying otherwise would leave an orphan nobody knows about.
Retrying with the same key re-finds that item and creates only the missing
link — proven by a test that fails the graph write, then succeeds on retry, and
asserts exactly one work item and one relationship exist.

---

## 4. Status synchronization

ConqrPlan remains authoritative. ConqrHub keeps `integration_work_item_status`,
a projection holding only what a Related Work card needs.

| Concern | How |
|---|---|
| Duplicate delivery | `integration_webhook_deliveries` refuses a delivery id it has seen; `apply` is idempotent regardless |
| Out-of-order delivery | Every update carries ConqrPlan's `updated_at`; anything strictly older than the stored value is discarded |
| Equal timestamps | Accepted — ConqrPlan's `updated_at` has second granularity, and refusing them would silently lose the later of two genuine changes |
| Missing event | `findStale` lists rows not heard about recently; reconciliation refreshes them from the source |
| Repaired vs reported | `reconciled_at` ("we asked") is separate from `last_event_at` ("we were told") |
| Deleted items | `deleted_in_source` excludes them from reconciliation instead of re-querying a 404 |
| Retry / dead-letter | Existing `integration_webhook_deliveries` attempts, dead-letter list and replay |

A projection write failure never blocks event fan-out; the row is repaired by
reconciliation instead.

---

## 5. Permission-shaped presentation

Related Work goes through `SmartObjectResolverService`, and this phase fixed a
real leak in it.

**Before:** `resolvePlane` called ConqrPlan with the integration's own
credential, so it answered as whoever owned the API key. Any viewer who could
open the Hub page was shown the title, state, priority and assignees of linked
work — including work in projects they had no access to.

**After:** the resolver mints a read-only delegation for the *viewer*
(`work-item:read`), so ConqrPlan's own permissions decide and a `403` becomes a
real statement about that person.

| Viewer | Result |
|---|---|
| Has access | `live` — title, key, state, priority, assignees, deep link |
| No access | `restricted` — **no** title, project, assignee, status, or link |
| Item deleted | `deleted` |
| ConqrPlan unreachable | `source_unavailable` |

> **Revised.** This section originally said a requirement with only restricted
> links still reads *covered*. That was wrong, and the follow-on phase changed
> it: a viewer who cannot see the linked work cannot verify that it covers
> anything, so calling it covered asks them to trust an invisible item. The
> answer is now a third state, `all_restricted`, rendered as **"Uncovered for
> you"** — it leaks nothing and it does not claim delivery the viewer cannot
> confirm. See `requirement-coverage.ts`.

Permission is checked again when the user follows the link into ConqrPlan.

---

## 6. API

| Endpoint | Purpose |
|---|---|
| `POST /integrations/requirements/page` | Requirements on a page with coverage and permission-shaped related work |
| `POST /integrations/requirements/preview-linked-work` | What would be created; changes nothing |
| `POST /integrations/requirements/create-linked-work` | Create + link under the user's delegation; returns a receipt |

Receipt shape:

```json
{
  "status": "created",
  "requirementUrn": "conqr://hub/page/<pageId>#block=<blockId>",
  "workItemUrn": "conqr://plane/work-item/<id>",
  "workItemId": "<id>",
  "relationship": {
    "relationType": "implemented_by",
    "inverseRelationType": "implements",
    "id": "<edge id>"
  },
  "actor": { "hubUserId": "<user id>" },
  "correlationId": "<delegation jti>",
  "idempotencyKey": "req:...|project:..."
}
```

The correlation id is the delegation's `jti`, so ConqrHub's event, ConqrPlan's
audit row and this receipt all name the same exchange.

---

## 7. Tests

```
npx jest src/core/integration/services/requirement-delivery.service.spec.ts
  17 passed

DATABASE_URL=... npx jest --config jest-int.json
  10 passed   (real Postgres, real migration)
```

| Acceptance criterion | Covered by |
|---|---|
| 1. Authorized user creates one linked item | `creates one work item and records exactly one canonical relationship` |
| 2. Created under the real user's identity | `writes under the acting user, not the integration credential` + ConqrPlan `test_delegation.py` |
| 3. Valid canonical URNs | `returns valid canonical URNs for both objects` |
| 4. Exactly one canonical relationship | same as 1 |
| 5. Retry creates no duplicates | `a repeated confirm creates no second work item and no second relationship` |
| 6. Requirement becomes covered | `is uncovered before, covered after` |
| 7. State change updates Hub presentation | int: `a later state change replaces the earlier one` |
| 8. Duplicate delivery changes nothing | int: `applying the identical payload twice leaves the same row` |
| 9. Older event cannot overwrite newer | int: `discards an event older than the stored version` |
| 10. Missing event repaired by reconciliation | int: `finds rows that have not been heard about recently`, `repairs the projection from the source` |
| 11. Unauthorized viewer gets no metadata | `reveals nothing about work the viewer may not see` |
| 12. No create permission → no linked work | ConqrPlan `test_delegation.py::test_scope_does_not_grant_what_membership_denies` |
| 13. ConqrPlan success + Hub failure recoverable | `recovers on retry: re-finds the item and only creates the link` |
| 14. Losing a relationship never deletes work | `leaves the ConqrPlan work item untouched` |
| 15. Existing regressions pass | full suites, §8 of the evidence report |

---

## 8. Migration and rollback

```bash
pnpm --filter server migration:latest    # 20260904T120000-work-item-delivery-projection
pnpm --filter server migration:down      # reverses it
```

Additive: one new table and one index, no existing table changed. Reversing
drops only the projection; the Context Graph, requirements and ConqrPlan work
are untouched, and the projection rebuilds itself from events and
reconciliation.

---

## 9. What is not built

> **Superseded.** Everything below was completed in the follow-on phase. See
> `vertical-slice-01-ui.md` (experience and operations),
> `vertical-slice-01-architecture.md` (before/after) and
> `vertical-slice-01-evidence.md` (test results and screenshots). The remaining
> gaps are listed there, not here.

### Original list, kept for history

Stated plainly because the slice is not finished without it.

- **No UI.** The Related Work panel, the uncovered-requirement affordance, the
  preview and confirm dialogs, the receipt, and the pending / restricted /
  failure states are specified here and exposed by the three endpoints above,
  but no React component was written. The slice is therefore **not
  demonstrable end to end through the interface**, which the phase requires.
- **Reconciliation is not scheduled.** `findStale` and `markReconciled` exist
  and are tested; nothing runs them on a timer yet, and no job re-reads
  ConqrPlan for the rows they return.
- **Requirements are not authored from the editor.** `RequirementService.register`
  exists, but no editor affordance marks a block as a requirement, so the slice
  currently depends on requirements registered through the API.
- **The projection is not read by the resolver.** Related Work still resolves
  live from ConqrPlan on every request. The projection is written and correct
  but not yet used as a fallback when ConqrPlan is unreachable.
