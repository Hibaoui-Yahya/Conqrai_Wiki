# Estimate activation and repair runbook

Operational guide for ConqrPlan story points: what was broken, what changed, how
to repair existing projects, and how to roll back.

---

## 1. What was wrong

Three independent defects, all in ConqrPlane, stacked on top of each other.
Fixing any two of them still leaves story points unusable.

### Defect 1 — the estimate routes were never registered

`plane/api/urls/estimate.py` defined the public estimate endpoints and
`plane/api/views/estimate.py` implemented them, but the module was never added
to `plane/api/urls/__init__.py`. Every call to

```
/api/v1/workspaces/<slug>/projects/<id>/estimates/
```

returned 404, on every project, in every workspace. This is the cause of the
production 404 that started the investigation.

> **Correction to the original audit.** The audit attributed the 404 to "no
> estimate system configured on the project". The source shows otherwise: the
> route did not exist. The audit's conclusion that story points were unusable
> was right; its stated cause was not. Source and reproducible tests are the
> authority, and both are recorded here.

### Defect 2 — creation never activated the system

Every estimate control in the app gates on `project.estimate`. Commit
`df7c9a690` set that pointer from the **web client** after creating a system, in
`apps/web/core/store/estimates/project-estimate.store.ts` — the only file it
touched. The backend never set it.

So even with the routes registered, a system created over the API left
`project.estimate` NULL: the row existed, the UI showed no estimate field, and
work items could not carry a point value.

### Defect 3 — activation is two markers, and only one was being set

Fixing defects 1 and 2 made the estimate field appear, and a work item would
accept and store an `estimate_point`. The UI still displayed **"None"** for
every stored value.

`project.estimate` gates the *feature*. It does not identify *which* system is
live. That is `Estimate.last_used`, and it is what the web client reads:

```ts
// apps/web/core/store/estimates/project-estimate.store.ts
currentActiveEstimateIdByProjectId = computedFn((projectId: string) => {
  const currentActiveEstimateId = Object.values(this.estimates || {}).find(
    (p) => p.project === projectId && p.last_used
  );
  return currentActiveEstimateId?.id ?? undefined;
});
```

The estimate dropdown resolves a work item's `estimate_point` id against the
points of *that* system (`components/dropdowns/estimate.tsx`). With
`last_used` false there is no active system to resolve against, so a correctly
stored point id renders as "No estimate".

The web client sets both markers — it posts `last_used: true` to the internal
endpoint (`plane/app/views/estimate/base.py` reads it straight off the request)
— which is why systems created in the UI always worked.

Verified on a live instance: an API-created system with the pointer set and
`last_used` false showed `Estimate: None` on a work item whose
`estimate_point_id` was correct in the database and correct in the API response
the UI itself consumed.

---

## 2. What changed

**`plane/api/urls/__init__.py`** — the estimate routes are registered.

**`plane/api/views/estimate.py`** — `ProjectEstimateAPIEndpoint` now:

- sets **both** activation markers when a system is created —
  `project.estimate` and `Estimate.last_used` — so activation is a property of
  the API rather than of one client;
- keeps at most one live system per project: activating one clears `last_used`
  on any other system belonging to that project;
- reports `is_active` on `GET`, and reports it as `false` unless **both**
  markers are set, so a half-activated system is never described as working;
- accepts `is_active` on `PATCH` to activate or deactivate, idempotently;
- clears `project.estimate` on delete. `Estimate` is soft-deleted, so the
  foreign key's `SET_NULL` never fires and the pointer would otherwise dangle at
  a deleted system.

`name` and `description` on `PATCH` behave exactly as before.

**`plane/db/management/commands/repair_unlinked_estimates.py`** — repairs
projects whose system is missing either marker, and names which one was missing.

---

## 3. Repairing existing projects

Projects that had a system created through the API before this change are left
either fully unlinked (`project.estimate` NULL) or half activated (pointer set,
`last_used` false). Both need one operational step. Nothing repairs itself
automatically.

### Step 1 — inspect

Writes nothing.

```bash
python manage.py repair_unlinked_estimates
python manage.py repair_unlinked_estimates --workspace conqrvantage
python manage.py repair_unlinked_estimates --project <project-id>
```

Output lists each project holding exactly one live but unlinked system, with the
system's name, type and point count.

### Step 2 — apply, capturing rollback state

```bash
python manage.py repair_unlinked_estimates --apply --rollback-file /tmp/estimates-rollback.json
```

Runs in a single transaction. The rollback file records each project's previous
pointer.

### Step 3 — verify

```bash
curl -H "X-API-Key: $KEY" \
  https://<plane-host>/api/v1/workspaces/<slug>/projects/<id>/estimates/
```

Expect `"is_active": true`. Then open a work item in the ConqrPlan UI and
confirm the estimate field appears in the sidebar.

### Projects the command will not touch

A project owning **more than one** live estimate system is reported and skipped.
Choosing one would be a guess. Activate the intended system explicitly:

```bash
curl -X PATCH -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"is_active": true}' \
  https://<plane-host>/api/v1/workspaces/<slug>/projects/<id>/estimates/
```

---

## 4. Rollback

### Rolling back the data change

```bash
python manage.py repair_unlinked_estimates --restore /tmp/estimates-rollback.json
```

Restores each project's previous `estimate_id`. Estimate rows and their points
are never deleted by either direction, so nothing is lost.

### Rolling back the code change

Reverting the branch restores the previous behaviour: estimate routes disappear
and return 404 again, and any system created meanwhile stops being reachable
over the API. Systems already activated keep working in the UI, because
`project.estimate` is ordinary data that the revert does not touch.

Deactivating a single project without a code revert:

```bash
curl -X PATCH -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"is_active": false}' \
  https://<plane-host>/api/v1/workspaces/<slug>/projects/<id>/estimates/
```

---

## 5. Compatibility

- **Projects configured through the UI are unaffected.** They already have
  `project.estimate` set; the API reports `is_active: true` and changes nothing.
  Covered by `test_ui_configured_system_still_reads_active`.
- **One system per project** is unchanged. A second create still returns 409
  with the existing id.
- **Existing MCP callers** keep working. `list_estimate_points` returns the same
  array shape it always advertised — it simply returns real data now instead of
  an empty list caused by reading a single object as a collection.

---

## 6. Using it from MCP

```
get_estimate_system      → configured?, active?, points
create_estimate_system   → create and activate in one call
activate_estimate_system → switch on or off, safe to repeat
update_work_item         → estimatePointId to set, null to clear
```

`create_estimate_system` re-reads the project afterwards and confirms activation
rather than assuming it. If the system was created but did not activate, the
call returns `PARTIAL_WRITE` naming the follow-up, instead of reporting success.

---

## 7. Verification performed

Run on 2026-09-04 against a local stack (Django API in Docker, web dev server,
Postgres), not against mocks.

### Contract tests

`docker compose -f docker-compose-test.yml run --rm api-tests pytest   plane/tests/contract/api/test_estimate_activation.py`

**27 passed.** Covering:

| Check | Result |
| --- | --- |
| Create sets `project.estimate` **and** `last_used` | Passed |
| `GET` reports `is_active` | Passed |
| Half-activated system reports `is_active: false` | Passed |
| Activation idempotent across repeat calls | Passed |
| Deactivate clears both markers | Passed |
| Reactivate restores `last_used` | Passed |
| At most one live system per project | Passed |
| Rename preserves activation (backward compatibility) | Passed |
| Delete clears the pointer | Passed |
| UI-configured system still reads active | Passed |
| Point round trip on a work item, set and cleared | Passed |
| Estimate point from another project rejected | Passed |
| Non-project-member cannot create or activate | Passed |
| Repair: dry run, apply, sets `last_used`, repairs half-activated, idempotent, ambiguous skip, rollback restore | Passed |

### Full Django suite

`pytest plane/tests` — **542 passed, 8 failed**. The 8 failures are the
pre-existing magic-link authentication tests, which fail identically on a
baseline checkout (verified by stashing this change and re-running: 9 failed,
520 passed). No regression; net one fewer failure, because this phase also
removed a throttle-induced flake (§8).

### Live end-to-end, public API only

Estimate system created, points added, work item created with the full field
set, then read back:

```
POST /api/v1/workspaces/cf-v1-verify/projects/<id>/estimates/
  -> 201, is_active = True
POST .../estimates/<eid>/estimate-points/   -> 5 points (1, 2, 3, 5, 8)
PATCH .../estimates/ {"is_active": true}    -> is_active True (twice, unchanged)

POST .../work-items/  with name, description_html, priority, state, assignees,
     labels, start_date, target_date, parent, estimate_point, external_id

GET  .../work-items/<id>/
  id             = f2a952c7-2bf7-4536-910f-94a0e6ce82b9
  sequence_id    = 3
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

Idempotency, confirming the code path the MCP bulk tool branches on:

```
POST .../work-items/ (same external_id)
  -> HTTP 409
  {"error":"Issue with the same external id and external source already exists",
   "id":"f2a952c7-2bf7-4536-910f-94a0e6ce82b9"}
```

### UI verification

The work item above, created entirely through the public API, opened in the
ConqrPlan web client:

- **Before the `last_used` fix:** every other field rendered correctly
  (state, assignee, priority, both dates, parent, cycle, module, label) but
  `Estimate` read **None** — the defect 3 symptom, reproduced.
- **After running the repair command:** `Estimate` reads **5**, the list row
  shows `5`, and opening the dropdown lists the five API-created values
  (1, 2, 3, 5, 8) plus "No estimate", with 5 checked — so the value is both
  visible and editable.

Repair command output on that project:

```
1 project(s) with exactly one unlinked estimate system:
  cf-v1-verify/CFV  CF Verify
    -> activate 'Fibonacci' (type=points, 5 point(s), id=88b32ce4-...)
       missing: last_used

Dry run - nothing was written. Re-run with --apply to make these changes.
```

---

## 8. A test-suite fix that came with this change

`plane/settings/test.py` now lifts `API_KEY_RATE_LIMIT`.

The API-key throttle is keyed on the token string and counts through the shared
cache, which nothing resets between tests. Every contract test reuses one token,
so any suite issuing more than 60 requests in a minute starts handing `429`s to
whichever tests happen to run last. Adding the estimate tests pushed the API
contract suite over that line and broke 16 unrelated tests — failures that
looked like data pollution and were not.

No test asserts a 429 from this throttle, so it is lifted in test settings only.
Production rate limiting is unchanged.
