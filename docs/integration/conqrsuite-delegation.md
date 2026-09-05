# ConqrSuite trusted delegation (on-behalf-of)

How ConqrHub calls ConqrPlan as the authenticated human being served, rather
than as the owner of a shared integration key.

- **Status:** implemented, gate 1 of Trusted Delegation + Vertical Slice 01
- **Repos:** ConqrHub `feat/conqrplan-mcp-control-v1`, ConqrPlane `feat/conqrplan-estimate-activation`

---

## 1. The defect this closes

`APIKeyAuthentication.validate_api_token` returned `api_token.user`. ConqrHub
sent an `X-Conqr-On-Behalf-Of` header naming the acting user, and no code in
`apps/api/plane/` ever read it.

The result looked delegated and behaved like a shared root account:

- Every ConqrHub-initiated write was authorised as whoever owned
  `PLANE_API_KEY`.
- Two different ConqrHub users had *identical* power in ConqrPlan, and it was
  never the power either of them actually had.
- A ConqrHub user with no ConqrPlan membership at all could still drive any
  write the key owner could make.
- ConqrPlan's audit trail attributed every one of those actions to the key
  owner, so the record of who did what was wrong.

Control Foundation v1 widened what that single identity could do — bulk
creation, assignment, estimate activation, cycle and module membership — which
is what turned a latent design flaw into a release blocker.

### Before and after

```
BEFORE
  ConqrHub ──X-Api-Key────────────────────────▶ ConqrPlan
           ──X-Conqr-On-Behalf-Of: <user id>──▶  (ignored)
                                                 actor = api_token.user
                                                 ▲
                                     every user collapses to one identity

AFTER
  ConqrHub ──X-Api-Key: <bot token>──────────▶ ConqrPlan
           ──X-Conqr-Delegation: <signed>────▶   verify signature, iss, aud,
                                                 nbf/exp, claim shape, scope
                                                   │
                                                 org_uid  → Workspace
                                                 person_uid → User
                                                   │
                                                 membership check
                                                   │
                                                 actor = that human
                                                   │
                                                 ProjectEntityPermission
```

---

## 2. Threat model

| # | Threat | Control |
|---|---|---|
| T1 | Shared service key acts as its owner, so any bridge user inherits the owner's permissions | A **bot** API token authenticates no human on its own. Every delegated endpoint refuses it without a valid delegation. |
| T2 | Caller forges an identity in a header | Identity travels only in an HMAC-signed token. The unsigned `X-Conqr-On-Behalf-Of` header has no authority and is covered by a test that asserts it does nothing. |
| T3 | Token minted for one product replayed against another | `aud` is bound to `conqrplan` and checked before anything else is trusted. |
| T4 | Token from an untrusted issuer | `iss` must equal the configured issuer. |
| T5 | Stolen token replayed later | 5-minute TTL, `nbf`/`exp` both enforced with a bounded 30s skew. |
| T6 | Token tampering | HMAC-SHA256 over `header.payload`, compared in constant time. |
| T7 | Over-broad delegation | Least-privilege `scope` per operation; a read token cannot write, a work-item token cannot configure estimation. |
| T8 | Cross-tenant access | `org_uid` resolves to exactly one workspace, and it must be the workspace in the URL. Caller-supplied routing never overrides the token. |
| T9 | Unknown or deprovisioned identity silently treated as someone | Explicit identity mapping. No email matching. Unmapped fails closed. |
| T10 | Verification bug degrades into escalation | **No fallback to `api_token.user` after a delegation fails.** Every failure path raises. |
| T11 | Compromise of ConqrPlan escalates into ConqrHub | The OBO key is dedicated (`CONQR_OBO_SIGNING_KEY`), not ConqrHub's `APP_SECRET` which also signs sessions and share links. |
| T12 | Loss of accountability | One audit row per delegated request, accepted or rejected, naming the human, the tenant, the calling service and the correlation id. |

### Accepted residual risks

- **Symmetric signing.** Both products hold the same key, so ConqrPlan could
  mint a delegation for ConqrPlan. It cannot mint anything for ConqrHub, which
  is the escalation that matters. The suite has no JWKS or asymmetric signing
  infrastructure; introducing one here would create a second, incompatible
  identity system, which this phase was explicitly told not to do. Migrating to
  asymmetric keys is a contained change: only `mintDelegatedToken` and
  `decode_delegation` would move.
- **No `jti` replay cache.** Within the 5-minute window a captured token can be
  replayed by whoever captured it. The token travels only server-to-server over
  TLS, and every replay is audited under the same correlation id. A replay
  cache keyed on `jti` is the natural next step.

---

## 3. Identity contract

Products do not share a database, so a delegated request cannot name a
ConqrPlan row id — ConqrHub has never seen one. Two canonical identifiers
travel instead.

| Identifier | Shape | Meaning |
|---|---|---|
| `person_uid` | `conqr:person:<hub user id>` | Immutable human identity |
| `org_uid` | `conqr:org:<hub workspace id>` | Immutable tenant identity |

Derived deterministically from ConqrHub's primary keys, which are UUIDs and are
never reused or rewritten. That gives immutability without a new allocation
service. An email address would not: it can be reassigned, and matching on one
would let anyone able to set an address in ConqrHub choose which ConqrPlan user
they become.

> **These identifiers did not previously exist in either repository.** The
> phase brief describes them as existing canonical identifiers; the source did
> not contain them, so they are defined here (`canonical-identity.util.ts`) and
> mapped explicitly in ConqrPlan. Only ConqrHub may extract the raw id from a
> canonical uid — another product doing so would be assuming ConqrHub's id
> space is meaningful in its own database, which is the coupling these
> identifiers exist to prevent.

### Mapping in ConqrPlan

`SuiteOrgIdentity` (`org_uid` → `Workspace`) and `SuitePersonIdentity`
(`person_uid` → `User`), both with `is_active` so access can be revoked without
destroying audit history. Provisioned with:

```bash
python manage.py provision_suite_identity --org-uid conqr:org:<id> --workspace-slug acme
python manage.py provision_suite_identity --person-uid conqr:person:<id> --email person@example.com
python manage.py provision_suite_identity --list
python manage.py provision_suite_identity --person-uid conqr:person:<id> --deactivate
```

An empty table means every delegated request fails closed. That is the correct
starting state, not a bug to work around.

---

## 4. Token contract

Compact HMAC format, no external dependency:
`base64url(header).base64url(payload).signature`

Header: `{"alg":"HS256","typ":"CONQR-OBO"}`

| Claim | Type | Meaning |
|---|---|---|
| `sub` | string | Canonical `person_uid` of the acting human |
| `tid` | string | Canonical `org_uid` of the tenant |
| `aud` | string | `conqrplan` |
| `iss` | string | Issuing service, default `conqrhub` |
| `scope` | string[] | Least-privilege scopes for this one operation |
| `iat` | int | Issued at (epoch seconds) |
| `nbf` | int | Not before |
| `exp` | int | Expiry — 5 minutes after `iat` |
| `act` | `"obo"` | Marks a delegation, not a session token |
| `jti` | string | Unique token id; **doubles as the correlation id** |

`iss`, `jti` and `nbf` are additions in this phase; `sub`, `tid`, `aud`,
`scope`, `iat`, `exp` and `act` keep their existing names, and `sub`/`tid` now
carry canonical identifiers rather than raw row ids.

Signed with `CONQR_OBO_SIGNING_KEY` — deliberately **not** ConqrHub's
`APP_SECRET`. ConqrPlan must hold the key to verify delegations, and the app
secret also signs ConqrHub sessions and share links; handing that to another
product would let it mint ConqrHub sessions. ConqrHub falls back to
`APP_SECRET` when the dedicated key is unset so an existing deployment keeps
working, and logs a warning once per process. ConqrPlan does not fall back: an
unset key rejects delegated requests with `delegation_not_configured`.

---

## 5. Delegated scope matrix

| Scope | Grants an attempt at | Minted by |
|---|---|---|
| `work-item:read` | Reading work items | `get_estimate_system` reads, list/detail GETs |
| `work-item:create` | Creating one work item | `create_work_item`, `bulk_create_work_items` |
| `work-item:update` | Updating a work item, commenting | `update_work_item`, `add_work_item_comment` |
| `work-item:bulk-create` | Creating a batch | `bulk_create_work_items` |
| `estimate:read` | Reading estimation configuration | `get_estimate_system`, `create_estimate_system`, `activate_estimate_system` |
| `estimate:configure` | Creating, activating, deactivating estimation | `create_estimate_system`, `activate_estimate_system` |
| `cycle:assign` | Cycle membership | `create_work_item`, `update_work_item` |
| `module:assign` | Module membership | `create_work_item`, `update_work_item` |

**A scope narrows what a delegation may attempt; it never grants anything.**
The human still has to have the ConqrPlan permission. A correctly scoped
`estimate:configure` token for someone who is not a project admin is refused.

### Endpoint requirements

| Endpoint | GET | POST | PATCH / DELETE |
|---|---|---|---|
| `/work-items/` | `work-item:read` | `work-item:create` | — |
| `/work-items/<pk>/` | `work-item:read` | — | `work-item:update` |
| `/estimates/` | `estimate:read` | `estimate:configure` | `estimate:configure` |
| `/estimates/<id>/estimate-points/` | `estimate:read` | `estimate:configure` | `estimate:configure` |

---

## 6. Workspace and tenant routing

The delegated tenant decides the workspace. Specifically:

1. `org_uid` resolves through `SuiteOrgIdentity` to exactly one workspace.
2. That workspace must equal the `slug` in the request path
   (`tenant_mismatch` otherwise).
3. The acting human must be an active `WorkspaceMember` of it
   (`not_workspace_member` otherwise).
4. ConqrPlan's own project permissions then run against that user.

Caller-provided routing never overrides the token. A delegation for
organization A pointed at organization B's URL is refused on the tenant
boundary, before any permission check — proven by a test in which the acting
user is a full admin of *both* workspaces, so the only thing that can stop it
is the tenant rule.

`PLANE_WORKSPACE_SLUG` is no longer a security dependency. It survives as a
default for non-delegated read paths and local development; on a delegated
request the token's tenant is authoritative.

---

## 7. Authorization sequence

```
ConqrHub                                   ConqrPlan
   │
   │ 1. authenticate the human (session)
   │ 2. check they may request this action
   │ 3. mint OBO token
   │      sub=person_uid tid=org_uid
   │      aud=conqrplan scope=[...] exp=+5m
   │
   ├─ X-Api-Key: <bot token> ──────────────▶ 4. authenticate the service
   ├─ X-Conqr-Delegation: <token> ─────────▶ 5. verify signature
   ├─ X-Conqr-Correlation-Id: <jti> ───────▶    type, act, iss, aud
   │                                            nbf/exp (±30s)
   │                                            claim shape, jti
   │                                        6. scope for this method
   │                                        7. org_uid → Workspace
   │                                           == slug in path
   │                                        8. person_uid → User (live)
   │                                        9. WorkspaceMember check
   │                                       10. ProjectEntityPermission
   │                                       11. execute as that human
   │◀─────────────────────────────────────── 12. audit row, both identities
```

Any failure between 5 and 10 raises. There is no step that falls back to the
API token's owner.

---

## 8. Compatibility rules for non-delegated integrations

Plane already distinguishes the two kinds of API token, and that distinction is
exactly the security boundary.

| Token | Delegation | Behaviour |
|---|---|---|
| **Human** (`user_type` 0) — a personal token | absent | Works exactly as before, everywhere. Reads and writes as its owner. |
| **Human** | present | Delegation verified strictly; acts as the delegated human. |
| **Bot** (`user_type` 1) — a shared service credential | absent | Refused with `delegation_required`, audited as a machine action. Not even reads. |
| **Bot** | present | Delegation verified strictly; acts as the delegated human. |
| Any | invalid delegation | Refused. Never degrades to the token owner. |

**Plane's public API is unchanged.** A personal token *is* its owner, so acting
as that owner is what the token means, not impersonation; requiring a
delegation from it would break every existing integration to fix a problem it
does not have. The escalation was always specific to a *shared* credential used
to act for other people.

**Operational requirement:** `PLANE_API_KEY` used by ConqrHub must be a **bot**
token. A human token would keep working but would silently permit undelegated
calls, which is the behaviour being removed.

Genuinely machine-only endpoints may set `allow_service_calls = True`; such
requests are audited as machine actions with the calling service named, never
dressed up as user actions. No endpoint currently sets it.

---

## 9. Audit

One `DelegationAudit` row per delegated request, accepted or rejected:
`person_uid`, `org_uid`, `calling_service`, resolved `user`, `workspace`,
`action`, `target_urn`, `scopes`, `result`, `error_classification`,
`correlation_id`.

Tokens are never stored — only `jti`, which identifies a delegation without
being usable as one. A test asserts no audit row contains the token or the
signing key.

### Error classifications

`delegation_required`, `delegation_missing`, `delegation_malformed`,
`delegation_not_configured`, `delegation_bad_signature`, `delegation_bad_type`,
`delegation_not_obo`, `delegation_wrong_issuer`, `delegation_wrong_audience`,
`delegation_not_yet_valid`, `delegation_expired`, `delegation_bad_subject`,
`delegation_bad_tenant`, `delegation_missing_jti`, `delegation_bad_scope`,
`delegation_insufficient_scope`, `tenant_unmapped`, `tenant_mismatch`,
`identity_unmapped`, `identity_disabled`, `not_workspace_member`.

A refused request returns HTTP 403. Plane's API authenticators define no
`WWW-Authenticate` header, so DRF renders `AuthenticationFailed` as 403 rather
than 401. That is long-standing public behaviour and is deliberately not
changed here.

---

## 10. Configuration

| Variable | Product | Default | Notes |
|---|---|---|---|
| `CONQR_OBO_SIGNING_KEY` | both | ConqrHub: `APP_SECRET`; ConqrPlan: unset | Must match. Unset in ConqrPlan rejects all delegated requests. |
| `CONQR_OBO_ISSUER` | both | `conqrhub` | Must match. |
| `CONQR_OBO_AUDIENCE` | ConqrPlan | `conqrplan` | ConqrHub's value is fixed in `CONQRPLAN_AUDIENCE`. |
| `PLANE_API_KEY` | ConqrHub | — | Must be a **bot** token. |

### Migration

```bash
python manage.py migrate db 0124_suite_identity_and_delegation_audit
python manage.py provision_suite_identity --org-uid ... --workspace-slug ...
python manage.py provision_suite_identity --person-uid ... --email ...
```

Additive: three new tables, no existing table changed, nothing back-filled.

### Rollback

```bash
python manage.py migrate db 0123_projectupdate
```

Drops only the tables this feature created. Reverting the code restores the
previous behaviour — including the escalation, so roll back the code only if
delegation is breaking production, and treat it as reopening the finding.
Deployment order that avoids a window where writes fail: migrate and provision
identities first, deploy ConqrPlan, then deploy ConqrHub. Until ConqrHub is
deployed it sends no delegation, so switch `PLANE_API_KEY` to a bot token last.
