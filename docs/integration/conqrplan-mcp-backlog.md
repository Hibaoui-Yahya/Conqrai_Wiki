# ConqrPlan MCP coverage backlog

What remains after Control Foundation v1, and the order worth doing it in.

---

## Deliberately out of scope in this phase

Recorded so they are not mistaken for oversights.

- **Workflow engine.** This fork has no transition rules, approvals or gates.
  Delivery states are an ordered set and a state change is a plain field update.
  Anything else would be a build, not a configuration, and is not represented as
  existing.
- **Hard delete.** No delete tool was added. The public API can delete a work
  item, but lifecycle rules around archive and restore are only partly on the
  public surface, so exposing destruction without the safe counterparts would be
  the wrong order. See the archive gap below.
- **UI redesign.** No ConqrPlan interface changes beyond the backend fixes.

---

## Archive, restore and delete: the gap

| Operation | Public API | Internal only | Exposed by MCP |
| --- | --- | --- | --- |
| Delete work item | Yes | | No |
| Archive work item | | Yes | No |
| Unarchive work item | | Yes | No |
| Archive cycle or module | Yes | | No |
| Delete comment | Yes | | No |

The asymmetry is the problem: the destructive operation is public while the
reversible one is not. A delete tool built today would give an agent an
irreversible action with no safe alternative beside it.

**Recommendation for the next phase.** Add archive and unarchive to the public
API in ConqrPlane first, then expose archive, unarchive and delete together,
with delete requiring explicit confirmation.

---

## Ranked backlog

### 1. Real delegation: make ConqrPlan evaluate the calling user

The one item here that is a security boundary rather than a feature.

Every write the bridge makes is authorised as the owner of the `PLANE_API_KEY`
token. `PlaneClientService` sends `X-Conqr-On-Behalf-Of` with the acting
ConqrHub user, but ConqrPlan ignores it —
`APIKeyAuthentication.validate_api_token` returns `api_token.user`, and no code
under `apps/api/plane/` reads the header. Permission checks run, but always
against the same identity, so a ConqrHub user with no ConqrPlan membership can
drive anything the token owner may do.

This predates the phase; what changed is the blast radius, now that the bridge
can bulk-create, assign, activate estimation and move items between cycles and
modules.

Interim mitigation, applicable today: issue `PLANE_API_KEY` to a service
account whose ConqrPlan project membership is exactly the intended reach, and
keep tool-level authorisation in ConqrHub.

The real fix needs identity federation — a ConqrHub↔ConqrPlan user mapping,
then either a delegation header ConqrPlan honours (validated against a trusted
issuer, never a bare user id) or short-lived per-user tokens minted by
ConqrPlan. It should land before the bridge is opened to users who are not
already ConqrPlan members, and before any destructive tool is added.

### 2. Native filtering on the public API

The highest-value item and a prerequisite for most agent questions. Design is
written: `conqrplan-filtering-design.md`. Until it lands, filtered queries need
a bounded client-side scan with an explicit completeness signal.

### 3. Cycle and module lifecycle

Membership is reachable now, but only as a side effect of a work-item write.
Missing: create and update a cycle, transfer incomplete items at sprint close,
create and update a module, remove an item from a module.

Note the ordering constraint: ConqrPlan refuses to add items to a cycle that has
already ended, so a sprint-close tool must transfer before it archives.

### 4. Relations, and making page links visible in ConqrPlan

`link_page_to_work_item` writes only to ConqrHub's relationship graph. Someone
working in ConqrPlan sees nothing. Writing a matching relation into ConqrPlan
would make the connection visible from both sides, which is the point of
traceability.

Constraint: the public API creates and lists relations but cannot remove one.
Removal exists only on the internal interface. Either accept links that are hard
to retract, or add a public removal endpoint first. The latter is preferable.

### 5. Worklogs and time tracking

A ConqrPlane original rather than an upstream feature, fully available on the
public API, and completely untouched by the bridge. Needed for any real
execution reporting: logged time, remaining effort, actual against estimate.

Gated per project by a time-tracking flag, so tools must read that first and
explain when it is off.

### 6. Intake and triage

The queue where unstructured requests land. Accept, reject, snooze and mark
duplicate are all on the public API. This is the natural entry point for
requests arriving from ConqrHub or Onyx.

### 7. Attachments and links on work items

Evidence of delivery lives here. Attachments use a presigned upload flow, so it
is more than a single call and deserves its own design.

### 8. Work item types

An item's type can be set, but types cannot be created or listed over the public
API. Until that endpoint exists, `typeId` has to come from somewhere else, which
makes the field awkward for an agent to use.

### 9. Comment editing

Comments can be added and read but not edited or deleted, unlike ConqrHub page
comments which support both. A small, self-contained gap.

---

## Known limitations carried forward

- **Cycle clearing needs the current cycle.** Removing an item from its cycle
  requires knowing which cycle it is in, and the work-item read does not return
  it. Passing `cycleId: null` is accepted but does nothing until cycle
  membership is readable per item.
- **Comment and cycle listings still truncate in memory.** `get_work_item_comments`
  and `list_cycle_work_items` fetch everything and slice. Not addressed here
  because it belongs with the pagination work in item 1.
- **The rate limit is configured but not enforced.** A per-minute value is read
  from the environment and never applied; only a per-request timeout is honoured.
  Worth fixing before any tool starts issuing scans.
- **The integration health check ignores the workspace slug.** It checks the API
  URL and key only, while every request path interpolates the slug. A deployment
  missing that variable reports healthy and then calls a malformed path.
