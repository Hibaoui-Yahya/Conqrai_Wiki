# Vertical Slice 01 — completion evidence

Everything here was produced against the two applications running together:
ConqrHub (server + Vite client) and ConqrPlan (Django API in Docker), with real
delegation configured between them and real identity mappings provisioned.

---

## 1. Test results

### ConqrHub backend (jest)

```
npx jest src/ee/ai/chat/tools src/core/integration
Test Suites: 5 failed, 55 passed, 60 total
Tests:       11 failed, 355 passed, 366 total
```

The 5 failing suites are the recorded baseline (§4). Passing tests went
**330 → 355** across this phase.

| Suite | Tests |
|---|---|
| `requirement-delivery.service.spec.ts` | 18 |
| `delivery-read.service.spec.ts` | 13 |
| `delivery-reconciliation.service.spec.ts` | 11 |
| `delivery-projection.service.int-spec.ts` (real Postgres) | 10 |

```
DATABASE_URL=… npx jest --config jest-int.json
Test Suites: 1 passed, 1 total
Tests:       10 passed, 10 total
```

The run logs the ordering guard firing, which is the point of the suite:

```
DEBUG [DeliveryProjectionService] Discarded stale update for
  conqr://plane/work-item/wi-projection-test:
  2026-09-04T10:00:00.000Z < 2026-09-04T12:00:00.000Z
```

### ConqrHub frontend (vitest — added this phase)

```
npx vitest run --root apps/client
Test Files  2 passed (2)
Tests       26 passed (26)
```

> One earlier run of this suite reported 2 failures. It was executed while the
> backend suite was saturating the machine (vitest reported a 55,000-second
> duration, 100% in "import"). Re-run on an idle machine it is 26/26. Recorded
> because a flake that is explained is still a flake.

### ConqrPlan (pytest, unchanged this phase)

```
589 passed, 2 failed   # both pre-existing magic-link tests
```

---

## 2. Acceptance criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | Requirement authored through the page workflow | `req-11syl4s` — the hash-derived block id produced by `MarkRequirementFromSelection`, created by clicking the bubble-menu action in the live editor |
| 2 | Appears as uncovered | `vs01-04-uncovered-fixed.png` — "0 COVERED / 1 UNCOVERED", row badge "Uncovered" |
| 3 | Authorized user opens the preview | `vs01-05-preview.png` |
| 4 | Preview performs no mutation | `create-linked-work-dialog.test.tsx` › *asks for a preview and creates nothing* |
| 5 | Confirmation creates exactly one work item | §3 below — 3 attempts, 1 item |
| 6 | Executes as the real human | ConqrPlan `DelegationAudit`: `accepted … scopes=['work-item:create']` with the mapped `person_uid` |
| 7 | Canonical relationship visible | `vs01-06-receipt.png` — `IMPLEMENTED_BY`, *inverse: implements* |
| 8 | Requirement becomes covered | `vs01-07-covered.png` — "1 COVERED / 0 UNCOVERED" |
| 9 | Receipt contains authoritative data | Receipt renders the server response; asserted in `create-linked-work-dialog.test.tsx` |
| 10 | Double-click and retry create no duplicates | §3; plus *sends exactly one create for a double-click* |
| 11 | Delayed response resolved before retry | *does not offer a blind retry when the outcome is unknown* |
| 12 | ConqrPlan status change updates the panel | SSE hook wired; panel re-renders on invalidation. **Not demonstrated live** — see §5 |
| 13 | Missing projection invokes bounded fallback | `delivery-read.service.spec.ts` › *resolves live when no projection row exists*; observed live after clearing the projection table |
| 14 | Stale projection labelled | *serves a stale projection, marked stale*; live: "Synced 4m ago" from the projection |
| 15 | Scheduled reconciliation repairs projections | `delivery-reconciliation.service.spec.ts` (11 tests) |
| 16 | Duplicate / out-of-order events do not regress status | `delivery-projection.service.int-spec.ts`, real Postgres |
| 17 | Unauthorized viewer sees no protected metadata | *leaks no title, project, assignee or status*; observed live as a Restricted card |
| 18 | `all_restricted` renders "Uncovered for you" | Panel test; observed live in `vs01-03-uncovered.png` before the read fix |
| 19 | Keyboard and screen reader | 4 accessibility tests: list semantics, accessible names, focus, conditional action |
| 20 | Mobile and desktop layouts | `vs01-08-mobile.png` at 390px — `scrollWidth === innerWidth`, no horizontal overflow |
| 21 | Baseline failures unchanged | §4 |
| 22 | No new regression | §4 |

---

## 3. Idempotency, measured

One create through the UI, then two fired concurrently against the API with the
same requirement:

```
ConqrPlan  — items carrying a ConqrHub idempotency key: 1
             #5  Get accounts provisioned via ConqrCore SSO
             external_id: req:conqr://hub/page/019f760d…#block=req-11syl4s|project:f13091de…

ConqrHub   — relationships from that requirement: 1
             implemented_by → conqr://plane/work-item/f4c90e15-6e32-4b75-be86-ea660da76e80
```

---

## 4. Baseline failures — unchanged

```
src/ee/ai/chat/tools/get-page.tool.spec.ts            (3)
src/ee/ai/chat/tools/get-page-comments.tool.spec.ts   (2)
src/ee/ai/chat/tools/get-page-history.tool.spec.ts    (2)
src/ee/ai/chat/tools/list-child-pages.tool.spec.ts    (3)
src/ee/ai/chat/tools/update-comment.tool.spec.ts      (1)
                                                      = 11 tests, 5 suites
```

Identical to the set recorded before this phase and proven against a clean
stashed checkout in `conqrplan-mcp-control-v1-evidence.md` §1b.

One suite, `cross-product-insight.service.spec.ts`, failed in a loaded run and
passes in isolation (3/3). Load-induced, not a regression.

---

## 5. What the live demonstration did *not* cover

- **SSE-driven status update (criterion 12).** The subscription is wired and
  the panel invalidates on a work-item event, but no ConqrPlan webhook was
  delivered to ConqrHub during this session, so the update was not observed
  end to end. Panel refresh was observed via explicit refetch instead.
- **The editor was not editable in this environment.** The collaboration
  WebSocket handshake fails locally (`socket.io … 400`), which is a known local
  dev-proxy issue unrelated to this work. The bubble-menu action nevertheless
  fired and registered `req-11syl4s`, so the authoring path is demonstrated;
  what could not be demonstrated is typing into the page afterwards.
- **ConqrPlan's own UI** was stopped to free port 3000 for ConqrHub, so
  "Open in ConqrPlan" was not followed to a rendered work item. The item's
  existence is evidenced directly from ConqrPlan's database instead.

---

## 6. Three defects found by running it

Recorded because they are the argument for doing this at all — none appeared in
unit tests.

**Delegated reads carried no delegation.** Converting the client's read methods
to a call context made them resolve the workspace slug from it but never
forward the token; only writes did. Every card came back `Restricted`.
ConqrPlan's audit trail named it exactly: `rejected · delegation_required ·
scopes=[]`. The failure mode was fail-closed rather than a leak — the design
held, the wiring did not.

**A raw state uuid on work-item cards.** ConqrPlan's public API does not expand
`state_detail`, so the card showed `F929E4CF-8F21-4A43-853E-D8ED41C59C56` where
a person expects "Todo".

**The requirement title clamped to "Get account…".** With the action button
beside it, the row was unusable for any requirement longer than a few words.

---

## 7. Screenshot index

| File | Shows |
|---|---|
| `vs01-01-page.png` | The Hub page before any requirement exists |
| `vs01-03-uncovered.png` | First render — also the two layout defects, and an `all_restricted` card |
| `vs01-04-uncovered-fixed.png` | Uncovered requirement, corrected layout, create action offered |
| `vs01-05-preview.png` | Preview: both sides of the boundary, editable fields, "runs as you" |
| `vs01-06-receipt.png` | Receipt: work item, `IMPLEMENTED_BY` + inverse, actor, reference |
| `vs01-07-covered.png` | Covered: "1 COVERED", card `#5 … Todo`, "Synced just now" |
| `vs01-08-mobile.png` | 390px — no horizontal overflow |

`vs01-03` is kept deliberately: it is the before-picture for the defects in §6.
