# Security policy

wend-core stores some of the most sensitive data a person has: who they
know and what they know about them. Security reports are treated as
first-priority work.

## Reporting a vulnerability

- Use GitHub's **private vulnerability reporting** on this repository
  (Security tab → Report a vulnerability), or email **security@trywend.io**.
- Please do not open public issues or pull requests for security problems.
- We aim to acknowledge within **72 hours** and to ship or coordinate a fix
  within **90 days** (usually much faster).

## Safe harbor

Good-faith research against your own self-hosted instance, or against
accounts you own on the hosted product, will never result in legal action
from us. Do not access other people's data, degrade the service, or
exfiltrate more than needed to demonstrate the issue.

## Scope notes

- The hosted product (trywend.io) has additional closed components; reports
  against it are welcome at the same address.
- A paid bounty program is planned post-funding; today we credit reporters
  in release notes (opt-in) and are genuinely grateful.

## Supply chain

- Dependabot is enabled; dependency updates are reviewed, not auto-merged.
- Releases are tagged; the commit history of this repository is
  fresh-history by design (the engine was extracted from a private
  monorepo).
