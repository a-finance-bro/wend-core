# wend-core

**The provenance-first personal graph engine.** wend-core is the open engine
behind [Wend](https://www.trywend.io), the relationship memory layer for AI
agents: a typed graph of the people, organizations, places and events in one
person's life, where **every fact carries the source it came from, and nothing
an agent proposes is saved until a person approves it**.

Agents are replaceable. The frontier model you use next year will not be the
one you use today, and neither will the client around it. What does not get
replaced is the record of who you know and what you know about them. That
record is worth keeping outside any single agent, in a store you can read,
export and run yourself. This repository is that store's engine.

## The problem it solves

Point several agents at one memory and the interesting questions stop being
about retrieval. They become: where did this claim come from, who put it here,
and what happens when two sources disagree. wend-core answers those in the
engine rather than in a prompt, because a prompt is advice and a schema is a
rule.

- **Provenance on every fact.** Committed rows reference a `sources` row, so
  "where did this come from" has an answer for as long as the row exists.
- **Propose, then confirm.** The tool surface in this repo has six propose
  operations and three read operations. It has no confirm operation, so an
  agent connected to it cannot commit a fact on its own. Proposals land in
  `pending_writes`; a person acts on them; `src/core/apply.ts` commits the
  rows that were approved.
- **Ontology as data, not DDL.** The physical schema is fixed. Each user's
  node types, link types and attribute definitions are rows, seeded once and
  extended at confirm time, with `created_by_ai` set on anything a model
  minted. A graph learns new vocabulary without a migration running.
- **A contradiction is a row, not an overwrite.** The `conflicts` table holds
  a contradicting value next to the one already committed, with both sources,
  for a person to settle. Where two values can both be true, two roles or two
  cities over time, the commit path keeps both as multi-value details instead
  of treating the second as a contradiction.

## One engine, two storage backends

The engine does not talk to a database directly. It talks to the Supabase
query-builder interface, plus a small number of named database functions
(`recall_nodes`, `search_person_attributes`). That indirection is why the same
engine code runs in two very different places.

- **Postgres with pgvector.** The DDL in `schema/` sets this up. Recall is a
  vector index scan through the `recall_nodes` function. This is the setup the
  quickstart below documents, and the one to use if you want to self-host a
  server.
- **A local SQLite file.** In the shipped Mac product the graph is a file on
  the user's own machine, reached through a client shim that implements the
  same query interface and provides those named functions in TypeScript, with
  vector recall as an exact scan rather than an index. Extraction happens on
  that machine. A mirror in cloud infrastructure the user owns is optional and
  answers when the machine is off.

This repository carries the Postgres DDL. The SQLite shim and its migrations
ship with the desktop app. If you are writing code against the engine, target
the query-builder interface and avoid dialect-specific SQL, and it will run on
either.

## What's in this repo

| Path | What it is |
|---|---|
| `schema/` | Postgres DDL: the graph layer (`nodes`, `links`, `node_details`, `link_details`), the per-user ontology (`node_types`, `link_types`, `detail_definitions`), `node_aliases`, provenance (`sources`), the proposal queue (`pending_writes`), `conflicts`, `schema_proposals`, tags, agent conversations, `api_keys`, and the recall functions |
| `src/core/apply.ts` | The commit path: approved proposals become graph rows, with fuzzy dedup, alias preservation, ontology auto-mint, multi-value details and location-specificity collapse |
| `src/core/recall.ts` | Recall in three modes: hybrid (the default), semantic, keyword. Keyword is first class rather than a fallback, since an exact company name, email or URL is better matched as text, needs no embedding call, and searches detail values as well as names. Every result reports which mode actually produced it |
| `src/core/structured-recall.ts` | Deterministic edge-first retrieval. "Who do I know at Acme" is a join, not a similarity search, so this answers it from the graph with no model call |
| `src/core/recall-digest.ts` | Expands recall hits into one-line facts in the database, so an agent can answer without a details round trip per match |
| `src/core/path.ts` | Connection paths between people |
| `src/core/name-match.ts` | Identity heuristics: match-quality tiers, so a partial hit is never treated as an identity |
| `src/core/build-items.ts` | Shapes `pending_writes` into review items for any confirm interface |
| `src/core/tool-definitions.ts`, `src/core/dispatch.ts` | The governed tool surface and a reference dispatcher: reads query, writes propose |
| `src/mcp/server.ts` | MCP server core: two meta-tools (`search`, `execute`) over that surface, and JSON-RPC handling. Bring your own transport |
| `src/crypto/secret-box.ts` | AES-256-GCM secret box for tokens and other secrets at rest |
| `src/embed/provider.ts` | Pluggable embedding provider. Register any 1024-dimension model |
| `examples/serve.ts` | A single-user MCP server over `node:http`, about 90 lines |

## What is deliberately not here

The engine is open. The product around it is not, and it is worth being plain
about where the line falls.

- Source connectors and ingestion. In the shipped product these read local
  data on the user's own machine and are part of the closed desktop app.
- The extraction loop and the prompt library it runs, which ship as a tuned
  model pack.
- The interface people review and approve proposals in.
- Outreach, scheduling, billing and hosted operations.
- Web research, which runs on the user's own provider credentials rather than
  on ours. There is no hosted enrichment service here to open.

## Quickstart (self-host)

1. Create a Postgres database with pgvector. A Supabase project works.
2. Apply `schema/*.sql` in filename order.
3. `npm install`
4. Register an embedding provider if you want semantic recall. Keyword recall
   works without one.
   ```ts
   import { setEmbeddingProvider } from "wend-core";
   setEmbeddingProvider(async (text) => yourEmbedding(text));
   ```
5. Run the example server:
   ```bash
   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… API_TOKEN=… WEND_USER_ID=… npx tsx examples/serve.ts
   ```
   **Read this before you run it.** `examples/serve.ts` is a development
   server for one user on one machine. It holds a service-role key, which
   bypasses row-level security, it maps a single bearer token to a single
**Read this before you run it.** `examples/serve.ts` is a development server
for one user on one machine. It binds `127.0.0.1`, refuses to start without
`API_TOKEN`, sends no CORS headers, and holds a service-role key, which bypasses
row-level security. Keep it off any network you do not control.
   Set `API_TOKEN` to a real secret and keep the port off any network you do
   not control. Multi-user hosting needs real key management, which the
   `api_keys` table in `schema/` is the starting point for.
6. Connect an agent:
   ```bash
   claude mcp add --transport http wend http://localhost:8787 --header "Authorization: Bearer $API_TOKEN"
   ```
   Then ask it *"who do I know at Acme?"* or tell it *"remember that I
   met Sarah at the AI summit"*. The second lands as a proposal.

Confirmation is yours to build, and that separation is the point: read
`pending_writes`, render the rows (`build-items.ts` shapes them), and call the
`apply*` functions for the ones a person approved.

## Is this the code you run?

For the engine, yes, and the mechanism is worth stating precisely rather than
overstating.

The files under `src/core`, `src/crypto` and `schema/` are copied from the
app's own source by an export script. They are not a reimplementation written
for publication. A verifier in the private repository re-derives this export
from that source and exits non-zero on any difference, so a change in the app
that has not reached here fails a check rather than going unnoticed.

`src/core/dispatch.ts`, `src/core/tool-definitions.ts`, `src/mcp/server.ts`,
`src/embed/provider.ts` and `examples/serve.ts` are written for this repo. The
app has its own equivalents wired into its own request lifecycle. These are
functionally faithful and the governance rule is the same in both, but they
are reference implementations, and we would rather say so than imply more.

That is a process guarantee, not a cryptographic one. What you can verify
without trusting anyone is the code in front of you, under a licence that lets
you read it, run it and keep running it.

## Honest notes

- The schema is Supabase-shaped. Row-level security policies reference
  `auth.users` and `auth.uid()`, and `recall_nodes` is `security definer` and
  expects an authenticated context. Self-hosting without Supabase means
  adapting that layer. The engine code itself only needs a client.
- `flagPromise` records a commitment as a proposal, and committing one writes
  to a `promises` table that is not part of this export.
- The tool descriptions in the hosted server are longer and more heavily
  tuned. The ones here are functionally complete.
- Version 0.1.0. The interfaces are in use in production, and they are still
  young enough to change.

## Security

See [SECURITY.md](SECURITY.md). Private vulnerability reporting is enabled on
this repository. Please do not open public issues for security reports.

## Licence and trademarks

AGPL-3.0-only. Wend is a trademark of Wend Labs Inc. The licence grants no
trademark rights. Contributions are accepted under the
[Developer Certificate of Origin](CONTRIBUTING.md) and the
[Contributor License Agreement](CLA.md), agreed once on your first pull request.
