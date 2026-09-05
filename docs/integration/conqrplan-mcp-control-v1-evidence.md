# Control Foundation v1 — evidence report

Everything below was run on 2026-09-04 against a real local stack: the ConqrPlan
Django API and Postgres in Docker, the ConqrPlan web client on a dev server, and
the ConqrHub server test suite. Nothing in this report is derived from mocked
HTTP responses alone.

Repositories and branches:

- `ConqrHub` — `feat/conqrplan-mcp-control-v1`
- `ConqrPlane` — `feat/conqrplan-estimate-activation`

---

## 1. Test results

### ConqrHub (jest, from `apps/server`)

```
npx jest src/ee/ai/chat/tools/work-item-fields.spec.ts \
         src/ee/ai/chat/tools/plane-control.tools.spec.ts \
         src/ee/ai/chat/tools/plane-work-management.tools.spec.ts \
         src/ee/ai/chat/tools/plane-work-items.tools.spec.ts \
         src/core/integration

Test Suites: 24 passed, 24 total
Tests:       177 passed, 177 total
```

Across the whole ConqrPlan-adjacent tree (`npx jest src/ee/ai/chat/tools
src/core/integration`): **52 suites passed, 5 failed; 301 tests passed, 11
failed.** The 5 failing suites are pre-existing page-tool specs (`get-page`,
`get-page-comments`, `get-page-history`, `list-child-pages`,
`update-comment`) - unrelated to ConqrPlan, and none of them import a file this
phase touched. Before this work the same command failed **7** suites; the two
extra were in the changed area and are fixed below.

```
npx tsc --noEmit -p tsconfig.json     # exit 0
```

Two pre-existing specs needed updating, and both were real contract changes
rather than cosmetic churn:

- `plane-client.service.spec.ts` — the fetch mock only implemented `json()`.
  The client now reads the body with `text()` so that an empty `204` (cycle and
  module membership removal) does not fail on `JSON.parse`. The mock now
  mirrors a real `Response` and implements both.
- `plane-work-items.tools.spec.ts` — `create_work_item` returns the full
  normalised item instead of the old seven-key summary. The assertion became a
  superset check: every previous key with its previous value, plus the fields
  that were previously unreachable.

A third defect was found during the final diff review and fixed: clearing a
work item's cycle (`cycleId: null` on update) was a **silent no-op reported as
success**. `applyMembership` needed the id of the cycle the item was in,
`writeWorkItem` never supplied it, and the guard simply skipped the removal.
ConqrPlan's work-item payload does not carry its cycle and there is no reverse
lookup endpoint, so `PlaneClientService.findWorkItemCycle` now resolves it with
a bounded scan of the project's cycles. Three outcomes, none of which can
report a clear that did not happen:

| Situation | Result |
| --- | --- |
| Cycle found | Removed; `cycleId:cleared` applied |
| Item is in no cycle | Already in the requested state; applied |
| Scan bound hit, answer unknown | `PARTIAL_WRITE` with an actionable message |

The spec that previously asserted `removeWorkItemFromCycle` was *not* called
had encoded the bug as intended behaviour; it is replaced by three tests
covering the outcomes above.

### ConqrPlan (pytest, in Docker against Postgres)

```
docker compose -f docker-compose-test.yml run --rm api-tests \
  pytest plane/tests/contract/api/test_estimate_activation.py

27 passed
```

```
docker compose -f docker-compose-test.yml run --rm api-tests pytest plane/tests

548 passed, 8 failed
```

The 8 failures are the magic-link authentication tests. They are pre-existing:
stashing this change and re-running the same suite gives **9 failed, 520
passed**. So this phase adds 28 passing tests, introduces no regression, and
removes one pre-existing flake.

---

## 1b. Known failures, and proof they are the baseline

These are recorded by name so that "the suite is green apart from X" is a
checkable claim rather than a hand-wave. Neither set is caused by this work.

### Five Jest suites, eleven tests

```
src/ee/ai/chat/tools/get-page.tool.spec.ts
  GetPageTool > returns page content for an accessible page
  GetPageTool > throws ForbiddenException when user lacks Read access
  GetPageTool > passes the requesting user to SpaceAbilityFactory
src/ee/ai/chat/tools/get-page-comments.tool.spec.ts
  GetPageCommentsTool > returns comments for an accessible page
  GetPageCommentsTool > throws ForbiddenException when user lacks Read access
src/ee/ai/chat/tools/get-page-history.tool.spec.ts
  GetPageHistoryTool > returns history entries for an accessible page
  GetPageHistoryTool > throws ForbiddenException when user lacks Read access
src/ee/ai/chat/tools/list-child-pages.tool.spec.ts
  ListChildPagesTool > lists child pages of a given parent
  ListChildPagesTool > passes parentPageId to getSidebarPages
  ListChildPagesTool > throws ForbiddenException when user cannot read
src/ee/ai/chat/tools/update-comment.tool.spec.ts
  UpdateCommentTool > updates a comment with plain text
```

Verified against the unchanged baseline: the entire working tree (all 17 changed
and untracked files) was stashed with `git stash push -u`, the five suites were
run on the clean checkout, and the result was **5 suites failed, 11 tests
failed, 6 passed** - identical suites, identical test names. The stash was then
restored and every file compared against a filesystem backup taken beforehand.

### Eight pytest tests

```
plane/tests/contract/app/test_authentication.py
  TestMagicSignIn::test_user_does_not_exist
  TestMagicSignIn::test_magic_code_sign_in
  TestMagicSignIn::test_magic_sign_in_with_next_path
  TestMagicSignUp::test_without_data
  TestMagicSignUp::test_user_already_exists
  TestMagicSignUp::test_expired_invalid_magic_link
  TestMagicSignUp::test_magic_code_sign_up
  TestMagicSignUp::test_magic_sign_up_with_next_path
```

`test_authentication.py` is not touched by this work. Running the file alone
gives **8 failed, 22 passed**, and the same eight names appear on a baseline
checkout with this change stashed. They depend on SMTP/magic-link configuration
absent from the test environment.

---

## 2. Live end-to-end, public API only

Workspace `cf-v1-verify`, project `CF Verify`, authenticated with an API key.

### Estimate system

```
GET   .../estimates/                              -> 404 {"error":"Estimate not found"}
POST  .../estimates/ {"name":"Fibonacci","type":"points"}
                                                  -> 201, is_active = True
POST  .../estimates/<eid>/estimate-points/        -> 5 points: 1, 2, 3, 5, 8
PATCH .../estimates/ {"is_active": true}          -> is_active = True
PATCH .../estimates/ {"is_active": true}          -> is_active = True   (idempotent)
```

### A complete work item

Created with name, description, priority, state, assignees, labels, start date,
target date, parent, estimate point and an idempotency key; then read back:

```
id             = f2a952c7-2bf7-4536-910f-94a0e6ce82b9
sequence_id    = 3
name           = CF-V1 complete work item
priority       = high
state          = f929e4cf-8f21-4a43-853e-d8ed41c59c56
assignees      = ['5d7a6ea0-13e3-4702-a7bb-288a9de0201a']
labels         = ['45e4c7ba-18d7-482f-b7ac-edc82e3a1d77']
start_date     = 2026-09-05
target_date    = 2026-09-20
parent         = 87d2aeab-43ec-45dc-ad65-6f2d03ef8cab
estimate_point = 565a9318-e9ac-493d-8017-8818a2653448
external_id    = cf-v1-evidence-1
```

Cycle and module membership applied through their own endpoints, both accepted.

### Idempotency

The exact response shape the MCP bulk tool branches on:

```
POST .../work-items/   (same external_id again)
HTTP 409
{"error":"Issue with the same external id and external source already exists",
 "id":"f2a952c7-2bf7-4536-910f-94a0e6ce82b9"}
```

`writeWorkItem` maps this to `code: 'CONFLICT'` carrying
`existingWorkItemId`, so a retried batch converges instead of duplicating.

### Route registration, before and after

```
GET .../projects/<id>/estimates/       -> 401   (route exists, auth required)
GET .../projects/<id>/work-items/      -> 401   (known-good route, for comparison)
GET .../projects/<id>/not-a-real-thing/-> 404   (what an unregistered route gives)
```

At `HEAD`, `plane/api/urls/__init__.py` contained zero references to `estimate`,
while `plane/api/urls/estimate.py` already defined three URL patterns and
`plane/api/views/estimate.py` three endpoint classes. The endpoints existed and
were unreachable.

---

## 3. UI verification

The work item above — created entirely through the public API — opened in the
ConqrPlan web client.

**Before the `last_used` fix.** Every field rendered correctly except one:
state `Todo`, assignee `cf-v1`, priority `High`, start `Sep 05, 2026`, due
`Sep 20, 2026`, module `CF Module A`, cycle `CF Sprint 1`, parent `CFV-2`,
label `cf-v1-label` — and `Estimate: None`, even though the database and the
API response the UI itself consumes both carried the correct point id. That is
the defect 3 symptom, reproduced live.

**After the repair.** `Estimate: 5` in the detail panel, `5` on the list row,
and the dropdown lists the five API-created values plus "No estimate" with 5
checked — visible and editable, as required.

Screenshots: `cfv1-issues-list.png`, `cfv1-detail.png` (before),
`cfv1-after-repair-list.png`, `cfv1-after-repair-detail.png`,
`cfv1-estimate-open.png` (after).

### Repair command

```
$ python manage.py repair_unlinked_estimates --workspace cf-v1-verify

1 project(s) with exactly one unlinked estimate system:
  cf-v1-verify/CFV  CF Verify
    -> activate 'Fibonacci' (type=points, 5 point(s), id=88b32ce4-...)
       missing: last_used

Dry run - nothing was written. Re-run with --apply to make these changes.
```

```
$ python manage.py repair_unlinked_estimates --workspace cf-v1-verify \
    --apply --rollback-file /code/cfv1-rollback.json

Rollback state written to /code/cfv1-rollback.json
Activated 1 estimate system(s).
```

```json
[
  {
    "project_id": "f13091de-9d8a-4fb5-873e-43745e72827c",
    "workspace_slug": "cf-v1-verify",
    "previous_estimate_id": "88b32ce4-7a86-43c7-bb3b-8a2e82c738cf",
    "previous_last_used": false,
    "estimate_id": "88b32ce4-7a86-43c7-bb3b-8a2e82c738cf",
    "new_estimate_id": "88b32ce4-7a86-43c7-bb3b-8a2e82c738cf"
  }
]
```

---

## 4. Where the repository contradicted the audit

Recorded rather than quietly corrected, because the audit is the reference this
phase was scoped against.

| Audit said | Source says |
| --- | --- |
| `list_estimate_points` 404s because no estimate system is configured | The estimate routes were never registered in `urls/__init__.py`. Every estimate endpoint 404'd regardless of configuration. |
| Activation is a single missing step (`project.estimate`) | Activation is two markers. `project.estimate` gates the feature; `Estimate.last_used` selects the live system and is what the web client reads. Setting only the pointer leaves the field visible and every value displaying "None". |
| Writes carry the acting user's identity through the delegation header | ConqrPlan never reads `X-Conqr-On-Behalf-Of`. `APIKeyAuthentication` returns `api_token.user`. Every write is authorised as the token owner. See §5. |

The audit's conclusions — that story points were unusable and that the MCP
surface was too narrow — were correct. Two of its stated causes were not.

---

## 5. Security and permission validation

**What holds.** Authorisation is ConqrPlan's throughout. Every write goes
through the public API and is evaluated by `ProjectEntityPermission` and the
serializers. Nothing in this phase writes to a ConqrPlan table, adds a
permission rule, or bypasses one. Cross-project and cross-workspace references
are refused by ConqrPlan itself, and contract tests cover a non-member being
refused estimate creation and activation, and an estimate point from another
project being rejected.

**What does not hold, and is now written down.** Every ConqrPlan write made
through this bridge is authorised as the owner of the `PLANE_API_KEY` token,
not as the ConqrHub user who invoked the tool. The delegation header is sent
and ignored. Permission checks are real but all evaluated against one identity,
so a ConqrHub user with no ConqrPlan membership can drive anything the token
owner may do.

This predates the phase — the three mutating tools that shipped before it had
the same property — but the blast radius is now larger: bulk creation,
assignment, estimate activation, cycle and module membership. Until identity
federation lands, `PLANE_API_KEY` must belong to a service account whose
ConqrPlan membership is scoped to exactly the intended reach, and tool-level
authorisation stays ConqrHub's job. It is item 1 in
`conqrplan-mcp-backlog.md`.

**Silent field loss.** ConqrPlan filters unknown assignees and labels out of a
write and returns `201`. The bridge pre-flights both against the project and
refuses the write with `INVALID_REFERENCE`, then re-reads after a create and
compares what was asked for against what was stored, returning `PARTIAL_WRITE`
if anything is missing. Success never means "some of it landed".

---

## 6. Tenant isolation

`projectId` is passed to ConqrPlan, which scopes every query by workspace slug
and project id. The workspace slug comes from `PLANE_WORKSPACE_SLUG`, a single
global environment variable, so this deployment is single-tenant with respect
to ConqrPlan; `ChatToolContext.workspaceId` is not used to select a ConqrPlan
workspace. That is unchanged by this phase and worth stating before any
multi-tenant ConqrPlan deployment.
