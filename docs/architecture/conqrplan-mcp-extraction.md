# Extracting ConqrPlan's agent tools

Measured from the code on 2026-09-06, not from the earlier "18 tools" note.

## What is actually there

63 registered agent tools. They fall into three groups, and the split is not
the one the tool names suggest:

| Group | Count | Depends on | Destination |
|---|---|---|---|
| Pure ConqrPlan | **17** | Plane REST client, delegation minter, field normalisation | **moves** to the MCP service |
| Composite (Hub + ConqrPlan) | 5 | page service, space ability, relationships, traceability | **stays** in Hub |
| Hub-only | 41 | pages, spaces, comments, attachments, verification, RAG | stays in Hub |

**The 17.** `list_conqrplan_projects`, `search_work_items`, `get_work_item`,
`create_work_item`, `update_work_item`, `bulk_create_work_items`,
`get_project_cycles`, `list_cycle_work_items`, `list_work_item_states`,
`list_work_item_labels`, `list_conqrplan_members`, `get_work_item_comments`,
`add_work_item_comment`, `list_estimate_points`, `get_estimate_system`,
`create_estimate_system`, `activate_estimate_system`.

**The 5 that stay.** `create_work_item_from_page`, `link_page_to_work_item`,
`get_page_links`, `get_page_work_coverage`, `search_suite`. Each one reads or
writes a Hub page, a relationship or a coverage roll-up. They are orchestration
that *calls* the product capability; moving them would drag Hub's page models
across the boundary, which is exactly what the boundary is for.

## What the 17 actually depend on

Less than expected, which is what makes this tractable:

```
17 tools
  ├── PlaneClientService        REST adapter        → moves (packages/conqrplan-core)
  ├── DelegatedTokenService     mint OBO            → moves (verify + mint)
  ├── DELEGATED_SCOPES          scope vocabulary    → moves
  ├── work-item-fields.ts       normalisation,      → moves
  │                             partial-write reporting, read-back
  └── ChatTool / ChatToolRegistry / ChatToolContext  → replaced by MCP SDK registration
```

`plane-control.tools.ts` also imports `WorkItemCreationService`, Hub's
orchestration service. It is **unused** - a leftover import. Nothing in the 17
touches a Hub repository, page model, session or bootstrap. Verified by reading
every import in the three tool files.

## Boundaries

- **ConqrPlan** owns work-item rules and the final authorization decision. It
  already does: a delegated request authorises the mapped human and ConqrPlan
  re-checks project membership per request.
- **ConqrPlan MCP** owns agent tool schemas, transport, input validation, and
  calls to ConqrPlan's REST API. No business logic, no database.
- **ConqrHub** owns pages, requirements, relationships, coverage, and the
  composite workflows.
- **Webhooks stay a direct ConqrPlan → Hub integration.** They are not agent
  traffic and must not be routed through MCP. Same for the indexer,
  reconciliation, and projection consumers - all of which read ConqrPlan
  through the REST client and stay where they are.

## Where it lives

`apps/conqrplan-mcp` (service) and `packages/conqrplan-core` (shared library),
both inside the ConqrHub repository's existing pnpm workspace.

A separate repository was considered and rejected: the client, the delegation
contract and the normalisation logic are all TypeScript that Hub's five
composite tools still need. A workspace package lets both consume one
implementation. Duplicating it across repositories would mean two copies of the
partial-write and read-back behaviour that took real effort to get right, and
they would drift.

Living in Hub's *repository* is not a runtime dependency on Hub's
*application*. The service builds, starts, and serves with Hub stopped; that is
what Step 5 has to demonstrate rather than assert.
