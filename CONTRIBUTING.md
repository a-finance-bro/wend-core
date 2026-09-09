# Contributing

Thanks for wanting to make relationship memory better. A few ground rules
keep the project healthy:

## Developer Certificate of Origin (DCO) and Contributor License Agreement (CLA)

All contributions must be signed off (`git commit -s`), certifying the
[Developer Certificate of Origin](https://developercertificate.org/): you
wrote the change or otherwise have the right to submit it under AGPL-3.0.

Contributions also require agreeing to the [Contributor License Agreement](CLA.md)
once, on your first pull request. The DCO certifies your right to submit the
change; the CLA grants Wend Labs the license it needs to keep shipping wend-core
inside its own application, which it can only do as a copyright holder. You keep
full ownership of your work. Read CLA.md and include the line it asks for in your
PR description.

## Principles that PRs must respect

1. **Provenance is not optional.** Any path that writes a fact must carry a
   `source_id`. PRs that add unsourced writes will be declined.
2. **Agents propose, humans confirm.** No PR may add a way for an agent to
   commit directly to the graph or to confirm its own proposals.
3. **Ontology is data.** Schema evolution happens through per-user
   vocabulary rows, never runtime DDL.
4. **Conflicts are surfaced.** Nothing silently overwrites a contradicting
   confirmed fact.

## Practical notes

- `npm run typecheck` must pass.
- Keep changes small and focused; describe the behavior change in the PR
  body in plain language.
- Security issues: never as PRs/issues — see [SECURITY.md](SECURITY.md).

## Licensing

The project is AGPL-3.0-only and intends to stay that way. Wend Labs Inc. holds
the copyright and also ships this code inside its proprietary application under
its own terms, which is why the CLA above exists. "Wend" is a trademark of Wend
Labs Inc.
