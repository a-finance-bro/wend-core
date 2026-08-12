# Architecture

wend-core is a graph of the people in one person's life, plus the rules that
decide what is allowed to enter it. The rules are the interesting part. Storing
people is easy; storing them so that every fact can be traced to where it came
from, and so no agent can quietly rewrite one, is the work.

Almost all of that work is done by the schema rather than by code. This page
explains why the design is storage-shaped, how the same engine runs on two very
different databases, and exactly where the line between them falls.

## The model is storage-shaped on purpose

Three properties are enforced by table definitions, not by application logic:

**Provenance is not optional.** `node_details.source_id` and
`link_details.source_id` are `not null` and reference `sources` with
`on delete restrict`. A committed fact whose origin nobody can name is not a
bug to catch in review, it is a row the database refuses to store. Delete the
source and the database refuses that too, because a fact would be left with a
dangling explanation.

**Agents propose, the confirm path writes.** Every agent-initiated mutation is
a row in `pending_writes` with a `kind`, a payload, and a status. Only the
confirm path turns those rows into graph rows, and it records what it created
in `committed_id`. When a person edits a proposal before accepting it, the
agent's original wording stays in `payload` and the edit goes to
`edited_payload`, so what was proposed and what was kept remain separately
readable afterwards. There is deliberately no confirm capability in the agent
tool surface.

**Disagreements are recorded, not settled.** When two sources assert different
values for the same field, that is a `conflicts` row holding both values and
both sources. Nothing in the engine picks a winner. A graph that quietly
resolves disagreements is a graph whose individual facts cannot be trusted,
which is worse than a graph with a visible open question in it.

A fourth property is data rather than DDL. The node types, link types and field
definitions are rows in `node_types`, `link_types` and `detail_definitions`,
seeded when a graph is created and extended at confirm time when a write names
something that does not exist yet. Every type minted that way is flagged
`created_by_ai`. Each graph grows its own vocabulary without a migration ever
running, and the physical schema stays fixed.

## Two deployments, one model

The same tables exist in two dialects.

| | Postgres (`schema/`) | SQLite (`schema-sqlite/`) |
|---|---|---|
| Graphs per database | many | one |
| Tenancy enforced by | row level security, one policy set per table | ownership of the file |
| `uuid` | native | `text`, canonical 36-character form |
| `timestamptz` | native | `text`, ISO-8601 UTC with milliseconds |
| `jsonb` | native | `text` holding JSON |
| Embeddings | `vector(1024)` with an ivfflat index | `blob` of packed float32, scanned exactly |
| Fuzzy name search | trigram index | keyword match plus alias lookup |
| Set-based helpers | SQL functions | engine code |

Column names, value vocabularies, cascade rules and check constraints are
identical, so a graph exported from one loads into the other without a
translation step.

## Why one engine runs on both

The engine is coupled to a small query interface, not to a SQL dialect. It
selects rows from a named table with equality filters, ordering and limits;
it inserts, updates and soft-deletes by id. That surface is narrow enough to
implement over either database, which is what makes the port a data-access
concern rather than a rewrite.

What keeps it narrow is that the hard rules were pushed into the schema. The
constraints that carry the trust model are all constructs both engines have:
`not null`, `check` over a closed list of values, `on delete restrict` and
`on delete cascade`, unique indexes, partial indexes. Nothing load-bearing is
expressed as a stored procedure, a policy or a database-specific type.

Two conventions do the rest. Ids are UUID strings everywhere, so they survive a
move between deployments unchanged. Timestamps are ISO-8601 UTC strings with
milliseconds, chosen because that format sorts and compares correctly as plain
text; any other format would reorder a queue rather than fail, which is the
kind of difference that shows up as a strange list instead of as an error.

## Where the boundary sits

**Tenancy.** On Postgres the database holds many graphs, so the database is
what separates them: row level security is on for every table and each policy
checks `user_id` against the authenticated user. In the SQLite deployment there
is one graph in the file, so there is no second graph to reach and no policy
layer is defined. The boundary moves outward, to the filesystem permissions on
the file and to whatever the host puts in front of the engine.

The `user_id` columns are kept in both. They make an exported graph filter
correctly after it lands, and they let a query written against one deployment
run unchanged on the other. In the SQLite schema they are a portability key
and nothing more. Do not run that schema for more than one person: it has no
policy layer, and a second graph in the same file would be readable by anyone
holding it.

**Set-based work.** A few questions are answered inside Postgres by named
functions, `recall_nodes` and `search_person_attributes`. The SQLite deployment
implements the same two in engine code, so the query interface looks identical
from above. The rule for what is allowed to live in a database function is not
about performance: any routine that names the tenant in its arguments belongs
in engine code, where the caller has to pass the scope explicitly and omitting
it is a type error, rather than in a definer-rights function where an unset
scope silently matches nothing or, worse, everything.

**Recall.** With pgvector, similarity search is an index lookup. In SQLite it
is an exact scan over the embedded rows, which is why the SQLite schema indexes
which rows those are. Exactness is a fair trade at one person's scale, and it
removes a tuning parameter. One thing this puts on the caller: all the vectors
in a graph must come from the same embedding model, because two vectors of the
same width from different models are not comparable and nothing about them says
so.

**The project.** wend-core is the engine and the schema: the graph model, the
apply and confirm path, recall and search, name matching, the MCP server core,
the secret box, a pluggable embedding provider. It is AGPLv3, so what touches
the data can be read and run by the people whose data it is. The product built
on top is separate: managed ingestion and integration glue, the review
interfaces, enrichment, outreach, the tuned model pack, and the operations of
a hosted service. Nothing in this repository requires that product, and the
example server shows the engine running without it.
