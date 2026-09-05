# Vertical Slice 01 — user experience and operations

Completes the backend delivered in `vertical-slice-01.md`: the Related Work
panel, the create-linked-work interaction, requirement authoring, projection
fallback, and scheduled reconciliation.

---

## 1. Contradictions with the phase brief, recorded

Two things the brief describes as existing did not exist. Both are implemented
to the specified shape; neither was quietly substituted.

**The coverage contract.** The brief calls `total`, `approvedOrBeyond`,
`covered`, `uncovered`, `provisional`, `unresolvedSources[]`, `gaps[]` and the
`all_restricted` state an *existing* contract. Only `total` and `gaps[]`
existed, on `RequirementService.coverageGaps`; `approvedOrBeyond` existed only
as the `APPROVED_OR_BEYOND` lifecycle constant. `provisional`,
`unresolvedSources` and `all_restricted` appeared nowhere in either repository.
Defined in `domain/requirement-coverage.ts`.

**The frontend test stack.** The brief says to use the existing frontend and
end-to-end testing stack. `apps/client` had no test runner, no test files and
no Playwright configuration. Vitest, Testing Library and jsdom were added — the
minimum needed to prove the state matrix and the permission behaviour, in a
config separate from the app build.

What *was* real and reused as instructed: `knowledge-panel.tsx`,
`useResolveSmartObjects`, `link-or-create-work-item.tsx`, the shared
`SmartObjectCard`, the SSE hook `useIntegrationEvents`, the seven resolution
states, and the BullMQ repeatable-job scheduling pattern.

---

## 2. Where the experience lives

The panel is not a new ConqrPlan widget bolted to the page. It is the existing
**Related work & knowledge** aside tab, with requirements added above the link
graph:

```
Aside ▸ "links" tab
├── RequirementDeliveryPanel     ← requirements, coverage, delivery status
│     └── SmartObjectCard         (shared, all seven resolution states)
├── Divider
└── KnowledgePanel                ← the general cross-product link graph
```

Requirements come first because they are the unit delivery is tracked against;
the link graph below is context for them rather than a peer. One tab, so there
is a single place to look for "what is connected to this page".

### Endpoint → component map

| Endpoint | Hook | Component |
|---|---|---|
| `POST /integrations/requirements/page` | `usePageRequirements` | `RequirementDeliveryPanel` |
| `POST /integrations/requirements/preview-linked-work` | `usePreviewLinkedWorkMutation` | `CreateLinkedWorkDialog` (preview) |
| `POST /integrations/requirements/create-linked-work` | `useCreateLinkedWorkMutation` | `CreateLinkedWorkDialog` (confirm → receipt) |
| `POST /integrations/requirements/register` | `useRegisterRequirementMutation` | `MarkRequirementFromSelection` |
| `POST /integrations/delivery/reconcile` | — | operations only |
| SSE `/integrations/events/stream` | `useIntegrationEvents` | live refresh |

---

## 3. UI state matrix

| State | Trigger | What the user sees |
|---|---|---|
| Loading | first fetch | Fixed-height skeletons, `aria-busy`, `aria-live` — no layout shift when data lands |
| Empty page | no requirements | Empty state naming the authoring action |
| Uncovered | no links | Grey "Uncovered" + **Create linked work** |
| Covered | ≥1 link resolves live or stale | Green "Covered", cards under "Implemented by", no create action |
| Provisional | links resolve, none verifiable | Yellow "Provisional" + create action still offered |
| **Uncovered for you** | every link `restricted` | Grey lock badge; no title, project, assignee, state or link |
| Pending sync | projection newer than last event | "Not confirmed recently" |
| Stale projection | past the 5-minute window | Card renders `stale`; "Synced 12m ago" |
| Reconciliation running | sweep in flight | Refresh control shows a spinner |
| Recoverable failure | request failed | Inline alert with **Try again** |
| Product unavailable | ConqrPlan unreachable | `source_unavailable` card + "couldn't be confirmed just now" |
| Deleted source | item gone | `deleted` card |
| Live update | SSE event | Query invalidated, panel re-renders |

---

## 4. Create-linked-work interaction

`Understand → Suggest → Preview → Confirm → Execute OBO → Receipt → Audit → Recover`

**Entry point** appears only when the requirement is uncovered or provisional,
a project mapping exists, and no equivalent item is already linked. Offering it
next to work that already exists is how duplicates get made.

**Preview** shows both sides of the boundary explicitly — what stays in
ConqrHub, what is copied into ConqrPlan, the relationship that will be created,
and that the action runs as the signed-in user. It calls only the preview
endpoint; a test asserts the create mutation is never invoked.

**Confirm** freezes the payload, disables the control, and is guarded by a
`useRef` rather than state — a double-click fires both handlers before React
re-renders, so a state flag would not have flipped yet and both would pass.

**Receipt** renders from the server's response: work-item id, relationship and
its derived inverse, actor, correlation id (copyable), and an "Open in
ConqrPlan" link. `already_exists` and `created_link_failed` get their own
honest wording rather than being flattened into "success".

### Failure handling

| Situation | Message | Retry offered |
|---|---|---|
| No project mapping | "This page's space isn't connected to a ConqrPlan project yet." | No — an admin must act |
| Permission denied | "You don't have permission to create work in this project." | No |
| ConqrPlan rejected | "ConqrPlan turned this down. Your access may have changed." | Yes, form retained |
| Unavailable (5xx) | "Temporarily unavailable. Nothing was changed." | Yes |
| Link pending | Receipt with warning naming the same idempotency key | Yes, converges |
| **Timeout / no response** | "We couldn't confirm the result… close and refresh." | **No** |

The timeout case is the one that matters. A retry there is the single piece of
advice guaranteed to be wrong half the time: if the create did succeed,
retrying is how a requirement ends up with two work items. The backend's
idempotency key would in fact catch it, but the user should not have to rely on
knowing that — the honest instruction is to look before acting.

No message contains a status code, URN, token or stack trace. The correlation
id is the one identifier shown, because support can trace it.

---

## 5. Requirement authoring

Follows the established selection pattern exactly: the bubble menu contributes
the selected text to a jotai atom, and a page-scoped host
(`MarkRequirementFromSelection`) supplies the page and calls the existing
`requirements/register` endpoint. The editor's schema, serialisation and
behaviour are untouched.

**The trade-off, stated plainly.** With no anchor in the document, the stable
id is derived from the requirement's text (FNV-1a over the normalised string).
Marking the same sentence twice is therefore idempotent — the backend upserts
on `(workspace, page, blockId)` — but *editing* the sentence later produces a
new requirement rather than renaming the existing one.

That is the known cost of authoring without an editor mark. A requirement mark
stored in the document would fix it, and would also be a change to the
collaborative content model — a far larger commitment than this slice is
allowed to make. Closing it is the first thing the next phase should do.

---

## 6. Projection fallback and read repair

`DeliveryReadService` sits between the panel and both sources.

```
panel → getMany(projection)
          ├── fresh (< 5 min)      → serve, no cross-product call
          └── missing or stale     → resolve live (batched, ≤25, breaker)
                                      ├── success → serve + read-repair
                                      └── failure → serve projection, marked stale
                                                    or source_unavailable
```

- **Batched.** One projection query and at most one live pass per render. A
  page with twenty requirements makes one call, not twenty.
- **Capped** at 25 live resolutions; anything beyond is served from the
  projection and labelled, never dropped.
- **Circuit breaker** opens after 3 consecutive failures for 30 seconds, so a
  ConqrPlan outage does not become a ConqrHub outage.
- **Read repair** folds a live answer back into the projection, ordering-
  protected by `apply`, so a slow response landing after a newer webhook cannot
  roll status backwards.
- **Restricted results are never cached.** Restricted describes the *viewer*,
  not the item; writing it to a shared projection would poison the row for
  everyone else.
- Resolution always goes through the delegated resolver. There is no path that
  reads ConqrPlan as the service account or touches its database.

---

## 7. Reconciliation runbook

**Schedule.** Every 15 minutes, `QueueJob.DELIVERY_PROJECTION_RECONCILE` on the
shared general queue with fixed job id `delivery-projection-reconcile-cron`.
BullMQ treats repeated registration as one repeatable job, so every instance
can register on boot and only one sweep is ever scheduled — that is the
single-run protection. An in-process guard additionally stops a manual run
landing on top of a scheduled one.

**Why 15 minutes.** The freshness window is 5 minutes and the read path repairs
anything a user looks at, so the sweep exists for rows nobody is looking at.
Quarter-hourly bounds the worst case while staying far below ConqrPlan's rate
limit.

**Bounds.** 50 rows per workspace per run; rows older than 30 minutes.

**Identity.** Each row is resolved as the human who created its relationship —
someone known to have had access. If no actor resolves, the row is **skipped**;
a stale card is a smaller problem than refreshing with elevated access. If that
person has since lost access the result is `restricted` and the row is left
alone.

**Manual run.**

```
POST /integrations/delivery/reconcile     # scoped to the caller's workspace
```

Returns `{ runId, workspaces, scanned, repaired, skipped, restricted, failed, durationMs }`.

**Metrics.** Same fields, logged per run with the `runId`, and written back onto
the BullMQ job so an operator can read the outcome from the queue.

**Retries and dead-lettering.** 3 attempts, exponential backoff from 30s.
Failures are retained (`removeOnFail: 50`) — that is the dead-letter record to
inspect after an outage.

**ConqrPlan downtime.** Rows count as `failed` and are retried on the next
sweep; nothing is marked reconciled on the strength of a failed read.

---

## 8. Deployment order

1. Apply `20260904T120000-work-item-delivery-projection` (ConqrHub).
2. Apply `0124_suite_identity_and_delegation_audit` (ConqrPlan) and provision
   identities — see `conqrsuite-delegation.md`.
3. Deploy ConqrPlan.
4. Deploy ConqrHub (registers the reconciliation schedule on boot).
5. Switch `PLANE_API_KEY` to a **bot** token last.

## 9. Rollback

| Undo | How |
|---|---|
| Scheduled sweep | Remove the repeatable job; the read path still repairs on demand |
| Projection table | `migration:down` — rebuilds from events and reconciliation |
| UI | Revert the commit; the aside falls back to the knowledge panel alone |
| Delegation | See `conqrsuite-delegation.md` §10 — reverting reopens the escalation |

The projection is a cache. Dropping it costs freshness, never data.
