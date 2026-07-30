# wend-core

**The provenance-first personal graph engine.** wend-core is the open engine
behind [Wend](https://www.trywend.io), the relationship memory layer for AI
agents: a typed graph of the people, organizations, and events in one
person's life, where **every fact carries a source, every AI write is a
human-confirmed proposal**, and any MCP-capable agent can plug in.

> Anyone can vibe code an app. Nobody can vibe code a relationship, or the
> years of context behind it. Agents come and go; your network compounds for
> life. Its memory should live outside every agent, in a substrate you own
> and can audit. This is that substrate.

## Why this exists (and why it is open)

When many agents write to one memory, governance is the product. A memory
you cannot trust is worse than none. wend-core enforces the trust model in
the engine, not in prompts:

- **Provenance on every fact.** Committed rows reference a `sources` row.
  Ask "where did this come from" about anything, forever.
- **Propose, then confirm.** Agents never write to the graph. They write
  `pending_writes` proposals; a human confirms; the commit path
  (`src/core/apply.ts`) applies confirmed rows with dedup and safety nets.
  There is deliberately no confirm capability in the agent tool surface, so
  no agent can approve its own writes.
- **Ontology as data, not DDL.** The physical schema is fixed and
  multi-tenant. Each user's node types, link types, and attribute
  definitions are rows, seeded at signup and extended at confirm time
  (`created_by_ai` flags every minted type). Each graph speaks its own
  growing language without a migration ever running.
- **Conflicts are surfaced, never silently resolved.**

The engine is AGPLv3 so you can audit exactly what touches your data, run it
yourself, and know the project outlives any company. The hosted product pays
for the convenience: managed ingestion from Gmail/Calendar/LinkedIn, the
review UI, enrichment, outreach, and a tuned model pack.

## What's in the box

| Path | What it is |
|---|---|
| `schema/` | Postgres migrations: the graph layer (nodes, links, typed details, per-user ontology tables), provenance (`sources`), `pending_writes`, audit log, pgvector recall function, API keys |
| `src/core/apply.ts` | The commit path: confirmed proposals → graph rows, with fuzzy dedup, alias preservation, ontology auto-mint, multi-value details, location-specificity collapse |
| `src/core/dispatch.ts` | Reference dispatch for the governed tool surface (reads query, writes propose) |
| `src/core/tool-definitions.ts` | The agent tool set: `findNodeByName`, `recallNodes`, `getNodeDetails`, `proposeCreateNode/Link/AddDetail/AddLinkDetail/EditNode`, `flagPromise` |
| `src/core/recall.ts`, `src/core/path.ts` | Semantic recall (pgvector) and connection paths |
| `src/core/name-match.ts` | Identity heuristics: match-quality tiers that keep "Alinda" from merging into "Kalinda" |
| `src/core/build-items.ts` | Shapes `pending_writes` into review items for any confirm UI |
| `src/mcp/server.ts` | MCP server core: two meta-tools (`search`, `execute`) over the tool surface, JSON-RPC handling |
| `src/crypto/secret-box.ts` | AES-256-GCM secret box for OAuth tokens and other secrets at rest |
| `src/embed/provider.ts` | Pluggable embedding provider (bring any 1024-dim model) |
| `examples/serve.ts` | Self-hosted MCP server over node:http in ~90 lines |

## Quickstart (self-host)

1. Create a Postgres database with pgvector (a free Supabase project works).
2. Apply `schema/*.sql` in filename order.
3. `npm install`
4. Register an embedding provider (any 1024-dim model) if you want semantic
   recall:
   ```ts
   import { setEmbeddingProvider } from "wend-core";
   setEmbeddingProvider(async (text) => yourEmbedding(text));
   ```
5. Run the example MCP server:
   ```bash
   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… WEND_USER_ID=… npx tsx examples/serve.ts
   ```
6. Connect an agent:
   ```bash
   claude mcp add --transport http wend http://localhost:8787 --header "Authorization: Bearer dev"
   ```
   Then ask Claude: *"who do I know at Y Combinator?"* or *"remember that I
   met Sarah at the AI summit"* — the second lands as a proposal for you to
   confirm.

Confirmation is yours to build (that separation is the point): fetch
`pending_writes`, render them (see `build-items.ts`), and call the
`apply*` functions for approved rows. Or use the hosted product, which is
this engine plus everything around it.

## Is this actually the code you run?

Yes for the engine, and you can check rather than take our word for it.

**Byte-identical to what runs in production** (exported directly from the
hosted app's source, no reimplementation):

| Path | What it is |
|---|---|
| `src/core/apply.ts` | the commit path: confirmed proposals become graph rows, with dedup, alias preservation, ontology auto-mint |
| `src/core/recall.ts` | pgvector semantic recall |
| `src/core/path.ts` | connection paths between people |
| `src/core/name-match.ts` | identity match-quality tiers |
| `src/core/build-items.ts` | shapes the review queue |
| `src/core/types.ts`, `src/core/paginate.ts` | shared types and PostgREST paging |
| `src/crypto/secret-box.ts` | AES-256-GCM secret box for OAuth tokens |
| `schema/*.sql` | the graph, provenance, proposal-queue and recall DDL |

**Written for this repo, not lifted from production**: `src/core/dispatch.ts`,
`src/core/tool-definitions.ts`, `src/mcp/server.ts`, and `examples/serve.ts`.
The hosted app has its own equivalents wired into its request lifecycle. These
are functionally faithful, and the governance invariant is identical, but they
are reference implementations. We would rather say that than imply more.

Drift is checked mechanically, not by memory. The hosted repo runs a verifier
that re-derives this export from app source and fails on any mismatch, so the
files in the first table cannot silently diverge from production:

```
node scripts/verify-wend-core-parity.mjs --sha
# wend-core parity OK: 24 engine files identical to app source.
# engine digest: sha256:...
```

## Honest v0 notes

- The schema is Postgres/Supabase-shaped: row-level security policies
  reference Supabase's `auth.users` / `auth.uid()`. Self-hosting without
  Supabase means adapting the RLS layer (the engine code itself only needs a
  Postgres client). The `recall_nodes` SQL function is `security definer`
  and expects an authenticated context; adjust for pure service-role setups.
- Automated ingestion (email, calendar, LinkedIn archive), the extraction
  agent loop, enrichment, and the tuned prompt library are part of the
  hosted product and not in this repo (the extraction loop is on the
  roadmap to open).
- The hosted product's tool descriptions are longer and heavily tuned; the
  ones here are functionally complete.

## Security

See [SECURITY.md](SECURITY.md). Private vulnerability reporting is enabled
on this repository; please do not open public issues for security reports.

## License and trademarks

AGPL-3.0-only. "Wend" is a trademark of Wend Labs Inc.; the license does not
grant trademark rights. Contributions are accepted under the
[Developer Certificate of Origin](CONTRIBUTING.md).
