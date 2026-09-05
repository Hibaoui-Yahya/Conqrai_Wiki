# Filtered work-item queries: implementation-ready design

Status: **design only.** Nothing in this document is implemented in Control
Foundation v1. It is written to be built directly in the next phase.

---

## 1. The constraint

ConqrPlan's public API refuses filtered work-item queries. The list endpoint
rejects `filters` and `pql` with HTTP 400 and an explicit message
("PQL and structured filters are not supported on this Plane edition"). It
accepts only `order_by` from an allow-list, `fields`, `expand`, `external_id`
lookup, and cursor pagination.

Rich filtering exists, but only on the internal application interface, which
authenticates by browser session rather than by API key. The MCP bridge holds an
API key and cannot reach it.

So the questions users actually ask — *my open work*, *what is in this sprint*,
*what is overdue* — cannot be answered by a single upstream call today.

**This limitation must be stated, not hidden.** A tool that filters only the
first page and presents the result as complete is worse than no tool: it returns
a confident wrong answer. Every design decision below follows from that.

---

## 2. Shape of the short-term solution

Fetch pages from ConqrPlan under a hard budget, filter in ConqrHub, and tell the
caller honestly whether the answer is complete.

```
 caller ── filter spec ──▶ ConqrHub
                            │  cursor-paginate ConqrPlan under a budget
                            │  ├─ page 1 …  page N
                            │  filter and sort in memory
                            │  ▼
                            └─ results + completeness signal
```

### 2.1 Pagination is completed, never truncated

The existing client already exposes cursor pagination and reports whether more
pages follow. The filter path pages until one of three stop conditions:

1. ConqrPlan reports no further pages — the scan is **complete**;
2. the item budget is reached — the scan is **capped**;
3. the time budget is reached — the scan is **capped**.

There is no fourth case where it silently stops. The distinction between
*complete* and *capped* is carried into the response.

Filtering never runs on a partial page set that is presented as whole. Either
the whole candidate set was examined, or the response says it was not.

### 2.2 Budgets

| Budget | Proposed value | Reason |
| --- | --- | --- |
| Page size | 100 | The endpoint's maximum |
| Maximum items scanned | 2,000 | 20 upstream calls, bounded work |
| Maximum wall clock | 10 s | Below the tool-call timeout |
| Maximum returned | 100 | Keeps the model's context usable |

Both maxima belong in configuration, not literals, so an operator can tune them
per deployment without a release.

An unbounded fetch is explicitly rejected. A project with 50,000 items would
exhaust memory, blow the rate limit, and time out with nothing to show.

### 2.3 Partial results are labelled

Every filtered response carries its own provenance:

```json
{
  "items": [ ... ],
  "coverage": {
    "complete": false,
    "scanned": 2000,
    "scannedOf": null,
    "stoppedBecause": "item_budget",
    "note": "Scanned the 2000 most recently updated items. Older items were not examined, so this list may be incomplete."
  }
}
```

`complete: true` is only ever set when ConqrPlan confirmed there were no further
pages. When it is false, the tool description instructs the model to say so in
its answer rather than presenting the list as exhaustive.

Ordering the scan by most-recently-updated makes a capped scan useful rather
than arbitrary: the items a user is likely to be asking about are the ones that
moved recently.

### 2.4 Stable pagination for the caller

In-memory filtering makes upstream cursors meaningless to the caller, and
re-scanning per page would be both slow and inconsistent.

The filtered result set is materialised once and addressed by an opaque token:

```
{ "cursor": "eyJxIjoiYWJjMTIzIiwib2Zmc2V0IjoxMDB9" }
```

The token encodes a hash of the filter spec plus an offset. Presenting a token
whose filter hash does not match the current request is an error, not a silent
re-interpretation. Each materialised set carries a short lifetime (5 minutes
proposed); an expired token returns a clear "re-run the query" error rather than
stale or shifted data.

This gives a caller stable paging over a snapshot, which is the honest guarantee
available. It does not claim consistency with items changing underneath.

### 2.5 Permissions are never widened

The scan uses the same delegated identity as every other write and read, so
ConqrPlan returns only what the acting user may see. Filtering removes rows; it
never adds any.

Two rules follow, and both are testable:

- Caches are keyed by acting user as well as by project and filter. A cache
  shared across users would leak items across permission boundaries.
- No filter may be satisfied from a source other than the scan. There is no
  path where ConqrHub answers from its own index and thereby bypasses
  ConqrPlan's authorisation.

### 2.6 Caching

A short-lived per-user, per-project page cache (60 seconds proposed) makes the
common pattern — several related questions about the same sprint — cost one
scan instead of five. Cache entries are invalidated whenever this ConqrHub
instance writes to that project, and on the existing ConqrPlan webhook for
work-item change.

Caching is an optimisation only. A cold cache changes latency, never
correctness, and never completeness reporting.

---

## 3. The filters worth supporting

| Query | Predicate | Notes |
| --- | --- | --- |
| My open work | assignee = me, state group not completed or cancelled | "Me" resolves through the acting user's ConqrPlan member id |
| Work in the current cycle | cycle membership | Cycle contents have a dedicated endpoint, so this needs no scan |
| By assignee | assignee in set | |
| By state | state id in set, or state group in set | Group needs the state list to map ids |
| By priority | priority in set | |
| By label | labels intersect set | |
| By cycle | cycle membership | Dedicated endpoint |
| By module | module membership | Dedicated endpoint |
| Overdue | target date before today, state group not completed or cancelled | Timezone comes from the project |
| Unassigned | assignee set empty | |

**Two of these avoid the scan entirely.** Cycle and module membership have their
own endpoints that return exactly the right rows. The design should route those
predicates upstream and scan only for the rest — the cheapest correct query is
the one that does not scan at all.

Combining a membership predicate with others is the best case: fetch the cycle's
items upstream, then filter that much smaller set in memory, and report
`complete: true` because the candidate set was bounded by ConqrPlan.

---

## 4. Proposed tool surface

One tool, not ten. A `search_work_items` sibling with a filter object keeps the
model from having to choose between near-identical tools.

```
find_work_items(
  projectId: string,
  filter: {
    assigneeIds?: string[] | "me",
    stateIds?: string[],
    stateGroups?: ("backlog"|"unstarted"|"started"|"completed"|"cancelled")[],
    priorities?: string[],
    labelIds?: string[],
    cycleId?: string,
    moduleId?: string,
    overdue?: boolean,
    unassigned?: boolean,
    updatedSince?: string
  },
  orderBy?: "updated_at" | "target_date" | "priority",
  limit?: number,
  cursor?: string
)
```

Returns normalised work items plus the `coverage` block. The tool description
must state plainly that a capped scan may be incomplete, so the model surfaces
that to the user instead of quietly asserting a total.

---

## 5. The long-term fix

Client-side filtering is a bridge, not a destination. It burns upstream calls,
it caps out on large projects, and it can only ever promise a snapshot.

The durable answer is native filtering on ConqrPlan's public API. The internal
interface already implements exactly this against the database, with a filter
vocabulary covering state, assignee, label, cycle, module, dates and more. The
work is to expose a deliberately narrow, safe subset of it on the public API —
not to port the whole internal query language.

Recommended shape:

- accept an allow-listed set of filter parameters on the public list endpoint,
  reusing the internal filter builder rather than writing a second one;
- keep the existing rejection for `pql` and arbitrary structured filters, so the
  edition boundary the fork deliberately drew stays drawn;
- preserve cursor pagination semantics so callers page the filtered set the same
  way they page an unfiltered one;
- add contract tests pinning both the accepted vocabulary and the rejection of
  everything outside it.

Once that exists, `find_work_items` passes the predicate upstream, `coverage`
reports `complete: true` on every call, the scan budget becomes irrelevant, and
the caching layer can be deleted rather than maintained.

**Sequencing.** Build the bounded scan now, because it unblocks real questions
with an honest completeness signal. Treat it as scaffolding with a scheduled
removal, and put the native-filtering change on the ConqrPlane roadmap in the
same phase, so the scaffolding does not calcify into architecture.
