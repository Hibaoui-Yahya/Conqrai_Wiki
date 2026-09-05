# Vertical Slice 01 — architecture, before and after

## Before

Two products with a bridge that answered as itself, and no user-facing path
between a requirement and the work that delivers it.

```mermaid
flowchart LR
  subgraph Hub["ConqrHub"]
    Page["Page"]
    Req["Requirement<br/>(API only, no authoring)"]
    Graph["Context Graph"]
    Panel["Knowledge panel<br/>(links only)"]
  end

  subgraph Plan["ConqrPlan"]
    WI["Work item"]
    Perm["ProjectEntityPermission"]
  end

  Page --- Req
  Req -.->|"no UI path"| Graph
  Panel -->|"resolve"| Bridge["PlaneClientService"]
  Bridge -->|"X-Api-Key only"| Perm
  Perm --> WI

  Owner(["API key owner"])
  Bridge -. "every call authorised as" .-> Owner

  classDef bad fill:#fde8e8,stroke:#c92a2a,color:#7d1a1a
  class Owner,Bridge bad
```

**What was wrong**

- Every cross-product read and write was authorised as the `PLANE_API_KEY`
  owner, so any viewer of a Hub page saw the title, state, priority and
  assignees of linked work — including work in projects they had no access to.
- Requirements existed only as API objects: nothing authored them, nothing
  displayed them, nothing showed whether they had delivery behind them.
- Delivery status was resolved live on every render or not at all; there was no
  projection, so a ConqrPlan outage meant an empty panel.

---

## After

```mermaid
flowchart TB
  subgraph Browser["ConqrHub UI"]
    Bubble["Bubble menu<br/>Mark as requirement"]
    RPanel["RequirementDeliveryPanel"]
    Dialog["CreateLinkedWorkDialog<br/>preview → confirm → receipt"]
    Card["SmartObjectCard<br/>7 resolution states"]
    RPanel --> Card
    RPanel --> Dialog
  end

  subgraph HubSrv["ConqrHub server"]
    ReqSvc["RequirementService"]
    Slice["RequirementDeliveryService<br/>coverage + linking"]
    Read["DeliveryReadService<br/>fallback · cap 25 · breaker"]
    Proj[("integration_work_item_status<br/>projection")]
    Graph[("Context Graph<br/>implemented_by")]
    Resolver["SmartObjectResolver"]
    Recon["Reconciliation<br/>every 15 min"]
    Mint["DelegatedTokenService"]
  end

  subgraph PlanSrv["ConqrPlan"]
    Verify["DelegatedAPIKeyAuthentication"]
    Ident[("Suite identity<br/>person_uid · org_uid")]
    PPerm["ProjectEntityPermission"]
    WI["Work item"]
    Audit[("DelegationAudit")]
  end

  Bubble --> ReqSvc
  Dialog --> Slice
  RPanel --> Slice
  Slice --> Graph
  Slice --> Read
  Read --> Proj
  Read -->|"missing / stale"| Resolver
  Recon --> Read
  Resolver --> Mint

  Mint -->|"X-Api-Key + X-Conqr-Delegation"| Verify
  Verify --> Ident
  Verify --> PPerm
  PPerm --> WI
  Verify --> Audit

  WI -.->|"webhook · dedup · ordered"| Proj

  classDef good fill:#e6f7ed,stroke:#2f9e44,color:#14532d
  class Mint,Verify,Ident good
```

**What changed**

| | Before | After |
|---|---|---|
| Identity on a ConqrPlan call | API key owner | The signed-in human, via a signed OBO token |
| Restricted work in the panel | Fully visible | `restricted` card, no metadata |
| Coverage for a viewer who can't see the work | Would read "covered" | **"Uncovered for you"** |
| Requirement authoring | None | Bubble-menu selection → register |
| Delivery status source | Live only | Projection first, live fallback, read repair |
| ConqrPlan outage | Empty panel | Last known state, labelled stale |
| Missed webhook | Permanently wrong | Repaired by a 15-minute sweep |
| Duplicate / late events | Could regress status | Deduped on delivery id, ordered on `updated_at` |

---

## The one flow, end to end

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant P as Panel
  participant H as ConqrHub
  participant C as ConqrPlan

  U->>P: select text → Mark as requirement
  P->>H: requirements/register
  H-->>P: requirement (draft)
  P-->>U: "Uncovered"

  U->>P: Create linked work
  P->>H: preview-linked-work
  H-->>P: proposal + idempotency key
  Note over P,H: nothing mutated

  U->>P: Confirm (button disabled)
  P->>H: create-linked-work
  H->>H: mint OBO (work-item:create)
  H->>C: POST work-item + external_id
  C->>C: verify delegation → map identity → permissions
  C-->>H: 201 (or 409 with existing id)
  H->>H: record implemented_by (event in same tx)
  H-->>P: receipt: urn · relationship · actor · correlation id
  P-->>U: "Covered"

  C-->>H: webhook (state change)
  H->>H: dedup, order on updated_at, project
  H-->>P: SSE → panel refresh
```

The dashed and numbered paths are the two independent guarantees: the create is
idempotent, so a retry converges rather than duplicating; the event stream is
deduplicated and ordered, so a replay or a late delivery cannot roll status
backwards. There is no distributed transaction anywhere in the diagram, and
none is claimed.
