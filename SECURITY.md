# Security policy

wend-core is the engine over some of the most sensitive data a person has:
who they know and what they know about them. The engine stores nothing on
its own. It runs against a database the operator supplies, and in Wend's Mac
app that database is a file on the user's own machine.

Security reports are treated as first-priority work.

## Reporting a vulnerability

- Email **security@trywend.io**, or use GitHub's private vulnerability
  reporting on this repository (Security tab, "Report a vulnerability").
- Please do not open public issues or pull requests for security problems.
- Tell us what you tested against: the commit sha, or the engine digest
  printed by the parity verifier (see Supply chain).
- We acknowledge every report, tell you what we found, and tell you when the
  fix ships. If a report turns out not to be a vulnerability, we say why
  rather than closing it silently.

The same address covers the hosted product. Machine-readable contact details
are published at
[`/.well-known/security.txt`](https://www.trywend.io/.well-known/security.txt)
and the public policy page is at
[trywend.io/security](https://www.trywend.io/security).

## Supported versions

This project is pre-1.0. Security fixes land on `main` and in the next
release. There are no backports to earlier versions, and there is no long
term support branch. If you self-host, track `main` or the latest tag.

Quote a commit sha or an engine digest in your report. "Latest" is not a
version we can reproduce a finding against.

## Threat model

Assume the caller is hostile. Not because users are, but because an agent
connected to this engine runs a model we did not choose, over content we do
not control. A page it browses, an email it reads, or a file a colleague
sent can carry instructions written for the agent rather than for the human,
and an agent can be talked into calling any tool it holds.

So the interesting question is not whether an agent can be fooled. It can.
The question is what a fooled agent is able to do.

The answer is a split in the credentials: the component that proposes is not
the component that confirms. An agent holds propose capabilities and no
confirm capability. Confirmation happens in a surface the agent cannot call,
under the user's own credentials. Prompt injection that reaches the write
path therefore produces a row in a review queue, carrying the source it came
from. That is a bad suggestion, not a corrupted memory.

The second assumption follows from the first. Several agents write into one
graph, and they are not equally trustworthy on any given day. Governance
belongs in the engine, where it can be read and tested, rather than in a
prompt, where it is advice.

## Security properties this engine intends to hold

These are falsifiable on purpose. Each one names where to look.

1. **No path reachable from the agent tool surface commits to the graph.**
   The tool set in `src/core/tool-definitions.ts` is three reads and six
   writes. Every write goes through `pendingWrite()` in
   `src/core/dispatch.ts`, which inserts a row into `pending_writes` and
   touches nothing else. There is deliberately no confirm capability in the
   tool surface, so no agent can approve its own proposal. The commit path
   (`src/core/apply.ts`) is called by the confirming surface, never by a
   tool.
2. **Every committed fact references a source.** `node_details.source_id`
   and `link_details.source_id` are `not null references public.sources (id)
   on delete restrict`, so a fact cannot be written without provenance and a
   source cannot be deleted out from under the facts that cite it. The apply
   functions decline to commit a detail that arrives with no source id.
3. **Reads and writes are scoped to one user id, and a caller cannot widen
   its own scope.** Every query in `dispatch.ts` filters on `user_id`.
   `recallNodes()` takes the user id as a required positional argument, so
   omitting it is a compile error rather than a query with no tenant.
   The `recall_nodes` SQL function resolves the tenant as
   `coalesce(auth.uid(), p_user_id)`, so an authenticated caller cannot read
   another person's graph by passing an id.
4. **A confirmed fact is not silently overwritten by a contradicting one.**
   Details are multi-value by default: a new value is added as its own row
   rather than replacing what was there. Replacement is an explicit act
   through `proposeEditNode`, which is itself a proposal with a visible
   before and after. Genuine contradictions land in `conflicts` for a human
   to resolve, and that table has no delete policy, so a resolved conflict
   stays on the record. `pending_writes` keeps the agent's original
   `payload` next to any `edited_payload` a user supplied.
5. **Ontology minted by an agent is flagged as such.** Confirm-time
   auto-mint stamps `created_by_ai` on the new type or definition, so a
   graph can always be asked which parts of its vocabulary a human chose.
6. **Secrets at rest are AES-256-GCM, with the key held outside the store.**
   `src/crypto/secret-box.ts`, authenticated so tampering is detected. Read
   "Deploying this safely" before relying on it.

A reproducible violation of any of the above is a vulnerability. Report it.

## Scope

**In scope**

- The engine in `src/`.
- The DDL and row-level security policies in `schema/`.
- MCP request handling in `src/mcp/server.ts`.
- The hosted product at trywend.io and its MCP endpoint.
- The Wend Mac app, which is closed source, along with the local engine it
  runs and the MCP endpoint that engine serves on that machine.
- A user-owned cloud mirror, where a user has turned one on.

Reports on any of these go to the same address.

**Out of scope**, with the reason attached so this does not read as ducking:

- Findings that require the service-role key or database credentials already
  in hand. That key is the trust root of any deployment; holding it is
  equivalent to holding the database.
- Denial of service, volumetric testing, and automated scanning against the
  hosted product.
- Social engineering, physical access, and misconfiguration of a
  self-hoster's own instance.
- Scanner output with no demonstrated impact. Show us the path, not the
  signature.

**Always in scope, whatever else this section says:**

- Any cross-tenant read or write.
- Any path that commits a fact without a human confirming it.
- Any fact committed without provenance.

## Deploying this safely

Four items. Three of them are not obvious from reading the code, which is
why they are written down.

1. **Set `WEND_ENCRYPTION_KEY` before storing any token, and assert
   `isEncryptionConfigured()` at boot.** `encryptSecret()` returns its
   input unchanged when no key is configured, which is right for the callers
   that only obfuscate and wrong for anything holding a credential. An operator
   who never sets the key would store secrets in plaintext with no error and no
   warning, so fail your own boot instead.
2. **Treat the service-role key as the trust root.** Keep it server side,
   never in a browser or a client binary, and pass an explicit user id on
   every call rather than leaning on row-level security. RLS does not apply
   to that role.
3. **The definer functions ship locked down. Keep them that way.**
   `schema/20260818_178_definer_grants.sql` revokes EXECUTE from `public` and
   `anon` on every `security definer` function and grants it to the roles that
   need it. A definer function bypasses row-level security, and Postgres grants
   EXECUTE to `PUBLIC` on a new function by default, so this is not optional.
   Grants are per signature, not per name: an added or replaced overload does
   not inherit an earlier one's grants, so repeat both statements for the new
   signature in the migration that creates it.
4. **`examples/serve.ts` maps one bearer token to one user id.** It is there
   to get an agent talking to a graph in a few minutes. Multi-user hosting
   needs real key management, such as the `api_keys` table in `schema/`,
   which stores only a SHA-256 hash of each key.

## Safe harbour

Good-faith research against your own self-hosted instance, or against
accounts you own on the hosted product, will never result in legal action
from us.

Do not access other people's data, degrade the service for anyone else, or
take more than you need to demonstrate the issue.

Two limits we cannot waive, stated up front rather than argued about after a
report. We cannot grant safe harbour on behalf of the infrastructure
providers the hosted product runs on, so your testing has to stay inside
their terms as well as ours. And we ask that a public write-up wait until a
fix has shipped or until we have agreed a date with you. We will not ask for
silence beyond that.

## Recognition

There is no paid bounty programme. Reporters are credited in the release
notes for the fix if they want to be, and are told when it ships.

## Supply chain

The files exported from production are checked mechanically against the app
source they came from. The verifier re-derives this export, fails on any
mismatch, and prints a digest of the engine:

```
# wend-core parity OK: 24 engine files identical to app source.
# engine digest: sha256:6397880d2c88ff99635bdeaac64b8da44ceab155b0dd03956f5c69e9d56d4617
```

That digest is the useful thing to quote in a report. It has already caught
one real drift, where a change to the review-queue builder in the app left
this repo stale and the check failed rather than letting the claim rot.
Which files are covered, and which are reference implementations written for
this repo, is spelled out in the README.

Runtime dependencies are kept deliberately small: one production dependency,
plus TypeScript and type definitions for development. Security patches to
dependencies are prioritised over feature work.

The engine is distributed from this repository's `main`. Releases will be
tagged from 0.2 onward.

## Provenance of this repository

The commit history here starts fresh. The engine was extracted from a
private repository, and rather than publish that history we publish the code
and prove the correspondence mechanically, through the parity check above.
What you can audit is the code as published, at the digest it reports.
