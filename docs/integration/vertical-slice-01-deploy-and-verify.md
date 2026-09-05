# Deploying and verifying the delegation + slice release

A runbook for someone with production access. Every step is a command or a
click with a stated expected result, so "it deployed" and "it works" are
different claims and both get checked.

**Read this first:** the cutover has an ordering constraint that will take the
integration down if you get it wrong, and a security step that leaves a hole
open if you skip it. Both are in §2.

---

## 1. Before you start

| | |
|---|---|
| ConqrPlane PR | [#4](https://github.com/Hibaoui-Yahya/ConqrPlane/pull/4) → `conqr/integration` |
| ConqrHub PR | [#18](https://github.com/Hibaoui-Yahya/ConqrHub/pull/18) → `main` |
| Merge order | **ConqrPlane first.** ConqrHub mints delegation tokens; ConqrPlane verifies them. Merging ConqrHub alone ships signed tokens nobody checks. |

Generate the shared signing key once, and keep it somewhere you can retrieve
it — both products need the identical value:

```bash
openssl rand -base64 48
```

It must **not** be ConqrHub's `APP_SECRET`. ConqrPlan has to hold this key to
verify delegations, and `APP_SECRET` also signs ConqrHub sessions and share
links — handing that to another product lets it mint ConqrHub sessions.

### Recommended: staging first

One thing has never been exercised anywhere: **the ConqrPlan → ConqrHub webhook
leg**. Everything else in this release has been run end to end. If you only do
one thing on staging, do §5.

---

## 2. Cutover order

Steps 3 and 6 are the two that bite.

```
1. ConqrPlan: set CONQR_OBO_SIGNING_KEY, CONQR_OBO_ISSUER, CONQR_OBO_AUDIENCE
2. ConqrPlan: migrate  (0124_suite_identity_and_delegation_audit)
3. ConqrPlan: provision every org and person          ← skip this and it all stops
4. ConqrPlan: deploy
5. ConqrHub:  set CONQR_OBO_SIGNING_KEY (same value), migrate, deploy
6. ConqrHub:  switch PLANE_API_KEY to a BOT token     ← skip this and the hole stays open
```

**Why step 3 is a hard gate.** Delegation fails closed. An unmapped
`person_uid` or `org_uid` is refused, not guessed. Deploy without provisioning
and every cross-product call stops — safely, but completely.

**Step 6 has a prerequisite that is easy to miss.** A bot token is refused on
every delegated endpoint unless the request carries a delegation, so *any*
ConqrHub call site that does not delegate breaks the moment the key is
rotated. Before switching, confirm none are left:

```bash
grep -rn "this\.plane\.\|this\.planeClient\." apps/server/src --include=*.ts \n  | grep -v spec | grep -v isEnabled
```

Every hit must pass a call context. The check matters twice over: a call site
with no delegation that happens to hit a *non*-delegated endpoint does not
fail - it answers as the API key's owner, which is the escalation this release
exists to close.

**Why step 6 is last.** A *bot* token (`user_type` 1) authenticates no human on
its own and is refused without a valid delegation. A *human* token keeps
working undelegated, which is exactly the privilege escalation this release
closes. So:

- switch it **before** ConqrHub is deployed → ConqrHub isn't sending delegations yet → everything breaks
- never switch it → ConqrHub works, but an undelegated caller can still act as the key owner

### Commands

```bash
# 2. migrate
python manage.py migrate db 0124_suite_identity_and_delegation_audit

# 3. provision — one org, then every person who uses the integration
python manage.py provision_suite_identity \
  --org-uid conqr:org:<hub-workspace-uuid> --workspace-slug <plane-workspace>

python manage.py provision_suite_identity \
  --person-uid conqr:person:<hub-user-uuid> --email <their-conqrplan-email>

python manage.py provision_suite_identity --list   # confirm before deploying
```

The uuids are ConqrHub's own primary keys:

```sql
SELECT id, name  FROM workspaces;          -- → conqr:org:<id>
SELECT id, email FROM users WHERE ...;     -- → conqr:person:<id>
```

`--list` printing nothing is the failure everyone hits. It means every
delegated request will be refused.

---

## 3. Verify delegation (10 minutes)

Do these in order. Each one should fail in a *specific* way; a generic failure
means something else is wrong.

### 3.1 A bot token alone is refused

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-Api-Key: $PLANE_BOT_TOKEN" \
  "$PLANE_API/workspaces/$SLUG/projects/$PROJECT/work-items/"
```

**Expect `403`.** A `200` means `PLANE_API_KEY` is still a human token — step 6
was skipped, and the escalation is still open.

### 3.2 A personal token still works

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-Api-Key: $SOMEONES_PERSONAL_TOKEN" \
  "$PLANE_API/workspaces/$SLUG/projects/$PROJECT/work-items/"
```

**Expect `200`.** Plane's public API is deliberately unchanged — a personal
token *is* its owner. A `403` here means the human/bot distinction is being
applied too broadly and existing integrations are broken.

### 3.3 The audit trail is recording

```sql
SELECT result, error_classification, person_uid, calling_service, action
FROM delegation_audits ORDER BY created_at DESC LIMIT 10;
```

After 3.1 you should see `rejected` / `delegation_required`. After real use,
`accepted` rows carrying a `person_uid`. **No rows at all means auditing is not
running** — investigate before going further.

### 3.4 Two people get different answers

The whole point of the release. Pick someone **with** access to a project and
someone **without**, have each open the same ConqrHub page, and compare the
Related Work panel:

| | Sees |
|---|---|
| Has access | Work item card: title, key, state |
| No access | **"Uncovered for you"** and a Restricted card — no title, project, assignee or status |

If both see the same thing, delegation is not reaching the read path.

---

## 4. Verify the slice (5 minutes)

On a page in a space mapped to a ConqrPlan project:

1. Select text → **Mark as requirement**. It appears in Related Work as
   **Uncovered**.
2. **Create linked work** → preview appears. *Nothing is created yet* — confirm
   in ConqrPlan that no item exists.
3. Confirm. Receipt shows the work-item id, `IMPLEMENTED_BY` with
   *inverse: implements*, "Created by You", and a copyable reference.
4. Panel now reads **Covered**, with the item and its state.
5. **Press Create again on the same requirement.** The action should be gone.
   If you force it via the API, you get `already_exists` and the *same* id.

Confirm no duplicates:

```sql
-- ConqrPlan: exactly one row
SELECT sequence_id, name, external_id FROM issues
WHERE external_source = 'conqrhub';

-- ConqrHub: exactly one edge
SELECT relation_type, target_urn FROM integration_relationships
WHERE source_urn LIKE '%<blockId>%';
```

---

## 5. Verify the webhook leg — the one that has never run

**This is the step that matters most.** Everything above has been demonstrated;
this has not, anywhere.

1. Confirm ConqrPlan has a webhook pointing at ConqrHub's
   `/api/integrations/plane/webhook` endpoint, subscribed to issue events.
2. In ConqrPlan, change the state of the work item you created in §4.
3. Watch the ConqrHub page **without refreshing**.

**Expect** the card's state to change within a few seconds, via SSE.

If it doesn't, check in this order:

```sql
-- Did the delivery arrive at all?
SELECT delivery_id, event_type, status, error, received_at
FROM integration_webhook_deliveries ORDER BY received_at DESC LIMIT 5;

-- Did the projection update?
SELECT state, source_updated_at, last_event_at, reconciled_at
FROM integration_work_item_status WHERE work_item_urn = 'conqr://plane/work-item/<id>';
```

- **No delivery row** → the webhook never reached ConqrHub. Check the URL,
  network path, and the signing secret.
- **Delivery row but no projection change** → processing failed. Check the
  server log for that `delivery_id`.
- **Projection updated but the page didn't** → SSE. Check the browser's
  EventSource connection to `/api/integrations/events/stream`.

Reconciliation will repair a missed event within ~15 minutes regardless — which
is why a broken webhook shows up as *mysterious lag* rather than an outage.
That is exactly why this needs checking deliberately.

---

## 6. Verify reconciliation

```bash
curl -s -X POST -H "Cookie: $SESSION" \
  https://<hub>/api/integrations/delivery/reconcile | jq
```

Returns `{ runId, workspaces, scanned, repaired, skipped, restricted, failed,
durationMs }`.

`skipped` counts rows where no actor could be resolved — reconciliation
refreshes as the human who created the relationship, never with elevated
access, so it declines rather than escalating. A high `restricted` count means
people have lost access to work they linked.

The scheduled sweep registers on boot as a BullMQ repeatable job
(`delivery-projection-reconcile-cron`, every 15 min). Confirm it exists in the
queue after deploy — `onModuleInit` logs but does not throw if registration
fails.

---

## 7. Rolling back

| Undo | How | Cost |
|---|---|---|
| Scheduled sweep | Remove the repeatable job | Read path still repairs on demand |
| Projection | `migration:down` | Freshness only; rebuilds from events |
| UI | Revert the ConqrHub commit | Aside falls back to the knowledge panel |
| **Delegation** | Revert ConqrPlan | **Reopens the privilege escalation** |

Roll delegation back only if it is actively breaking production, and treat it
as reopening a known security finding — not as a neutral revert.

Identity mappings are safe to leave in place: they do nothing without the code
that reads them.

---

## 7b. What production actually runs (2026-09-05)

The cutover is done. Recorded here so the next operator does not have to
re-derive it.

| | |
|---|---|
| Bridge credential | `api_tokens.label = 'conqrhub-bridge'`, `user_type` 1 (Bot), `is_service` true |
| Owner | user `ConqrHub Bridge`, `is_bot` true, unusable password, **0 workspace memberships, 0 project memberships** |
| Revoke | `UPDATE api_tokens SET is_active = false WHERE label = 'conqrhub-bridge';` |

The bot deliberately has no membership anywhere. It needs none: a delegated
request authorises the *mapped human*, and `assert_workspace_membership`
checks that human, not the token owner. An undelegated bot request is refused
outright. So there is no configuration in which the bot's own access matters -
which is the point, and is what makes "least privilege" here mean *zero*
privilege rather than a smaller role.

Verified against production after the switch:

| Request | Result |
|---|---|
| bot alone, no delegation | 403 |
| bot + delegation, caller is a project member | 200 |
| bot + delegation, caller is a workspace member but **not** in the project | 403 |
| bot + delegation for an unmapped person | 403 `identity_unmapped` |
| wrong scope / wrong audience / expired / tampered signature | 403, each with its own classification |
| a personal token, undelegated | 200 - Plane's public API is unchanged |

Audit rows name both halves: `calling_service = 'conqrhub-bridge'` and the
resolved human. The previous credential appears in older rows as
`conqrservice-integration`; it is a personal token and is no longer used by
the integration.

One thing to expect when reading the audit table: only endpoints that require
a delegation write rows. `GET /projects/` does not, so a project listing
carries a delegation but leaves no audit row. Absence of a row is not absence
of a delegation.

## 8. Known limits

- The webhook leg is unproven (§5). Production has recorded **zero** webhook
  deliveries to date, so this is untested rather than merely unobserved.
- Background indexing runs as the person who created the project→space
  mapping. A mapping with no recorded creator is skipped, so its work items
  are never indexed and never appear in semantic search.
- Symmetric signing — both products hold the same key. ConqrPlan could mint a
  delegation for ConqrPlan; it cannot mint anything for ConqrHub.
- No `jti` replay cache — a captured token is replayable within its 5-minute
  life. Server-to-server over TLS, and every replay shares one correlation id
  in the audit.
- Requirement ids derive from their text, so editing a requirement's wording
  creates a new one rather than renaming it.
