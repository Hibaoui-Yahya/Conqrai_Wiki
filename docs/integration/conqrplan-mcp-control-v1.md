# ConqrPlan MCP Control Foundation v1

Reference for the ConqrPlan work-management tools exposed by ConqrHub's MCP
server after the Control Foundation change.

**Scope.** Complete work-item create and update, working story points, and safe
bulk creation. Ordered delivery states are *not* a workflow engine; transition
rules, approvals and gates are explicitly out of scope for this phase.

**Boundaries.** ConqrPlan remains the source of truth for execution data and the
final authority on validation, permissions and tenant scoping. ConqrHub reaches
it only over the public REST API. No cross-product database writes exist.

---

## 1. What changed

| | Before | After |
| --- | --- | --- |
| Fields settable on create | 3 | 15 |
| Fields settable on update | 5 | 15 |
| Fields returned when reading an item | 7 | 20 |
| Story points | Endpoint returned 404 on every project | Create, activate, read, set, clear |
| Bulk creation | Service existed, no tool | `bulk_create_work_items`, 1-100 |
| Silent field loss | Assignees and labels dropped without warning | Rejected up front, and verified after the write |
| Errors | Bare status code | Stable `code` plus ConqrPlan's own field message |

### Tools added

| Tool | Purpose |
| --- | --- |
| `bulk_create_work_items` | Create 1-100 items, one result per row |
| `get_estimate_system` | Read the estimation configuration and its points |
| `create_estimate_system` | Create and activate a point system |
| `activate_estimate_system` | Switch estimation on or off, idempotently |

### Tools modified

`create_work_item`, `update_work_item`, `get_work_item`. All three keep their
previous response keys, so existing callers are unaffected; the new fields are
additive. The remaining 15 tools are untouched.

---

## 2. Work-item fields

Shared by `create_work_item`, `update_work_item` and every row of
`bulk_create_work_items`.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string 1-255 | Required on create |
| `description` | string \| null | Plain text is wrapped in a paragraph; HTML passes through |
| `priority` | enum | `urgent` `high` `medium` `low` `none` |
| `stateId` | string | From `list_work_item_states` |
| `assigneeIds` | string[] \| null | From `list_conqrplan_members`. Replaces the set |
| `labelIds` | string[] \| null | From `list_work_item_labels`. Replaces the set |
| `startDate` | string \| null | `YYYY-MM-DD` |
| `targetDate` | string \| null | `YYYY-MM-DD`, must not precede `startDate` |
| `parentId` | string \| null | Makes the item a sub-item |
| `typeId` | string \| null | Must be enabled on the project |
| `estimatePointId` | string \| null | Requires an active estimation system |
| `cycleId` | string \| null | Applied as a separate membership call |
| `moduleIds` | string[] \| null | Applied as separate membership calls |
| `externalId` | string | Idempotency key |
| `externalSource` | string | Namespace, defaults to `conqrhub-mcp` |

### Omitted, cleared, assigned

The three are distinct and the distinction is load-bearing.

| Intent | How to express it |
| --- | --- |
| Leave a field untouched | Omit the key entirely |
| Clear a field | Send `null` |
| Set a value | Send the value |

For `assigneeIds`, `labelIds` and `moduleIds`, `null` and `[]` both mean "remove
all". Changing a priority never disturbs a due date, because the due date key is
simply absent from the request.

---

## 3. Examples

### Create a complete work item

```json
{
  "projectId": "6819555f-8bf6-403d-936a-981cf57fe67f",
  "name": "Wire the ConqrHub docs panel to the project overview",
  "description": "Panel renders but the view is unavailable.",
  "priority": "high",
  "stateId": "af925bae-8f6b-4be0-acb7-f606e11a4dcd",
  "assigneeIds": ["aa45c2a3-4529-47a9-822e-66292069d95f"],
  "labelIds": ["3b1f...", "9c2e..."],
  "startDate": "2026-09-07",
  "targetDate": "2026-09-21",
  "estimatePointId": "pt-5",
  "cycleId": "cyc-sprint-14",
  "moduleIds": ["mod-docs"],
  "externalId": "CONQRPLAN-142"
}
```

Response, abbreviated:

```json
{
  "id": "7c303eaa-...",
  "urn": "conqr://plane/work-item/7c303eaa-...",
  "projectId": "6819555f-...",
  "sequenceId": 7,
  "name": "Wire the ConqrHub docs panel to the project overview",
  "state": "Todo",
  "stateId": "af925bae-...",
  "stateName": "Todo",
  "priority": "high",
  "assigneeIds": ["aa45c2a3-..."],
  "labelIds": ["3b1f...", "9c2e..."],
  "startDate": "2026-09-07",
  "targetDate": "2026-09-21",
  "estimatePointId": "pt-5",
  "membership": { "applied": ["cycleId:cyc-sprint-14", "moduleId:mod-docs"], "failures": [] }
}
```

### Clear fields

```json
{ "projectId": "...", "workItemId": "...", "targetDate": null, "assigneeIds": null }
```

### Bulk create

```json
{
  "projectId": "6819555f-...",
  "items": [
    { "name": "Audit intake queue", "priority": "medium", "externalId": "SPRINT14-1" },
    { "name": "Backfill worklogs",  "priority": "low",    "externalId": "SPRINT14-2" }
  ]
}
```

```json
{
  "projectId": "6819555f-...",
  "total": 2, "created": 2, "partial": 0, "duplicate": 0, "failed": 0,
  "results": [
    { "index": 0, "status": "created", "workItemId": "wi-1", "urn": "conqr://plane/work-item/wi-1", "sequenceId": 8, "name": "Audit intake queue" },
    { "index": 1, "status": "created", "workItemId": "wi-2", "urn": "conqr://plane/work-item/wi-2", "sequenceId": 9, "name": "Backfill worklogs" }
  ]
}
```

### Set up story points

```json
{ "projectId": "...", "name": "Fibonacci", "type": "points", "values": ["1","2","3","5","8","13"] }
```

`create_estimate_system` creates the system, adds its point values, and then
re-reads the project to confirm activation rather than assuming it. If the
system came back inactive the tool returns the item with
`code: 'PARTIAL_WRITE'` telling the caller to run `activate_estimate_system` —
it never reports a system as usable when it would be invisible in the UI.

Activation in ConqrPlan is two markers, and `is_active` is true only when both
are set: `project.estimate` (which makes the field exist at all) and
`Estimate.last_used` (which selects the live system, and without which every
stored point renders as "None"). Projects configured before this phase may hold
either marker alone; `conqrplan-estimate-runbook.md` covers repairing them.

---

## 4. Bulk semantics

These describe what the server actually does. They are not a design choice made
in the MCP layer.

- **Between 1 and 100 items.** A larger request is refused before any item is
  created, so an oversized call never leaves a half-finished batch.
- **No transaction.** ConqrPlan exposes no bulk-create endpoint and no
  cross-item transaction, so items are created one at a time. There is nothing
  to roll back to, and partial completion is reported rather than hidden.
- **One result per requested row**, carrying its `index`, in request order.
- **Four row outcomes:** `created`, `duplicate` (the idempotency key already
  exists; the existing id is returned), `partial` (the item exists but cycle or
  module membership failed), `failed`.
- **Duplicate keys within one batch are refused up front**, because the first
  row would succeed and the rest would return conflicts that read like a server
  fault rather than a malformed request.

### Idempotency

ConqrPlan's own mechanism is `external_id` paired with `external_source`.
Creating twice with the same pair in one project is refused with a conflict that
carries the id of the item that already exists. Supply `externalId` on every row
of a batch you might retry; a retry then converges instead of duplicating.

---

## 5. Error catalogue

Every failure carries a stable `code` and a human-readable `error`. The `error`
key keeps the shape it had before this change, so existing callers still work.

| Code | Meaning | Typical fix |
| --- | --- | --- |
| `VALIDATION_FAILED` | The request is malformed, or ConqrPlan rejected a field | Read `details`, correct the field |
| `INVALID_REFERENCE` | An assignee or label does not belong to the project | Re-resolve ids from the list tools |
| `CROSS_PROJECT_REFERENCE` | An id belongs to another project or workspace | Use ids from the target project |
| `PERMISSION_DENIED` | The acting user may not do this | Check project membership and role |
| `NOT_FOUND` | Project, item or endpoint does not exist | Verify ids |
| `CONFLICT` | Idempotency key or estimate system already exists | Use the returned existing id |
| `LIMIT_EXCEEDED` | More than 100 items | Split the batch |
| `NO_ESTIMATE_SYSTEM` | The project has no estimation system | `create_estimate_system` |
| `PARTIAL_WRITE` | The item exists but part of the request did not apply | Read `details`, retry that part |
| `UPSTREAM_UNAVAILABLE` | Timeout, rate limit or 5xx | Retry with backoff |
| `UPSTREAM_ERROR` | Anything else | Inspect `details` |

`PARTIAL_WRITE` still returns the work item at the top level, because the caller
needs its id in order to retry. It is never a success.

### Field loss is never silent

ConqrPlan filters assignees to project members and labels to project labels
without reporting it: the write returns success having quietly discarded the
rest. Two defences run:

1. **Before the write**, unknown assignee and label ids are rejected with
   `INVALID_REFERENCE`, naming each offending id.
2. **After the write**, what was requested is compared against what was stored.
   Any difference is reported as `PARTIAL_WRITE` with the missing ids.

---

## 6. Permissions

Authorisation is decided entirely by ConqrPlan. ConqrHub adds no rules and
bypasses none: every write goes through the public API and is evaluated by
`ProjectEntityPermission` and the serializers, exactly as a request from the
web client would be.

| Action | Required in ConqrPlan |
| --- | --- |
| Read projects, items, states, labels, members | Project member |
| Create or update a work item | Project member with write access |
| Be assigned work | Active project member, role 15 or above |
| Bulk create | Same as single create, per row |
| Create or activate an estimate system | Project entity permission (admin) |
| Set an estimate on an item | Project member with write access |

Cross-project and cross-workspace references are refused by ConqrPlan's
serializer: states, parents, types and estimate points are all validated
against the target project. Assignees and labels are not — ConqrPlan filters
those silently — so the bridge pre-flights them and refuses the write instead
(§5).

### The identity the permission check actually sees

**Every ConqrPlan write made through this bridge is authorised as the owner of
the `PLANE_API_KEY` token, not as the ConqrHub user who invoked the tool.**

`PlaneClientService` sends the acting user in an `X-Conqr-On-Behalf-Of` header,
but ConqrPlan does not read it: `APIKeyAuthentication.validate_api_token`
returns `api_token.user`, and nothing in `apps/api/plane/` references the
header. It is an audit hint, not a delegation mechanism.

The practical consequences:

- Permission checks are real, but they are all evaluated against one identity.
  A ConqrHub user with no ConqrPlan membership can still drive any write the
  token owner is allowed to make.
- The `PLANE_API_KEY` must therefore be issued to a service account whose
  ConqrPlan membership is scoped to exactly what the bridge is meant to reach.
  A token owned by a workspace admin grants every MCP caller workspace-admin
  reach into ConqrPlan.
- Authorisation for *who may call the tool at all* is ConqrHub's, at the MCP
  and chat layer, using `ChatToolContext.user` and `workspaceId`.

This is pre-existing — the three mutating tools that shipped before this phase
had the same property — but this phase widens what that single identity can do
(bulk creation, assignment, estimate activation, cycle and module membership),
so it is stated explicitly rather than left implicit. Closing it needs identity
federation on the ConqrPlan side and is the top item in
`conqrplan-mcp-backlog.md`.

---

## 7. Coverage after this phase

| Capability | Status |
| --- | --- |
| Work-item fields | Complete for the public API |
| Story points | Complete |
| Bulk creation | Complete |
| Delivery states | Read only |
| Cycles | Read, plus membership on write |
| Modules | Membership on write only |
| Relations, sub-item listing | Parent set on write; no relation tools |
| Worklogs, intake, attachments | Not exposed |
| Filtered queries | Not available; see the filtering design |

Remaining gaps and the recommended order are in
`docs/integration/conqrplan-mcp-backlog.md`.
