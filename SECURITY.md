# Security

## Reporting a vulnerability

Use **GitHub's private vulnerability reporting** on this repository
(Security tab → "Report a vulnerability"). Reports are read by the
maintainer; please allow a few days for a first response.

Do not open public issues for suspected vulnerabilities.

## Scope notes for researchers

- This is a single-tenant personal system; there is no hosted instance to
  test against. Findings in the code and workflows are welcome.
- The threat model is in `architecture/09-security.md`, and the repo-split /
  secret-hygiene design in `architecture/11-repo-safety.md`.
- Secrets never live in this repo (`.env.example` only, gitleaks pre-commit
  and CI, push protection on). If you find one anyway, that is a report.
