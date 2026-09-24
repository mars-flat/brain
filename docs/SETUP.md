# Setup

Developer setup for a clean clone. The running system — the gateway, the
console and the tasks store on `brain-vm` — is described in
`architecture/03-deployment.md` and `architecture/13-setup.md`; this file
is only what a laptop needs to build and test the code.

## Prerequisites

- [Bun](https://bun.sh) 1.4 (CI and the container image pin 1.4.0)
- git
- Docker, for the compose e2e smoke (`scripts/compose-smoke.sh`) — optional
  otherwise
- [gitleaks](https://github.com/gitleaks/gitleaks) — optional locally
  (`brew install gitleaks`); the pre-commit hook uses it if present and
  warns if not, and CI scans the full history regardless

## Developing

```sh
git clone https://github.com/mars-flat/brain && cd brain
git config core.hooksPath .githooks   # REQUIRED: vault/secret guards (§9.1)
bun install
bun run check                          # lint + typecheck + depcruise + tests
```

`bun run format` applies Biome fixes. `bun scripts/gen-example-vault.ts`
regenerates the synthetic vault (CI verifies the committed output is fresh).
`bun packages/cli/src/main.ts --help` lists the `brain` commands; every one
runs against `examples/vault-example` with no setup.

## Your private vault

Your real vault lives at `vault/` inside this tree but is **its own git
repository** (architecture §9.1). Create it with `brain init` — it lays out
the directories, writes `BRAIN.md` and the vault `.gitignore`, and runs
`git init`:

```sh
bun packages/cli/src/main.ts init --vault ./vault
```

Point `BRAIN_VAULT_PATH` at it in `.env` (copy `.env.example`). Never weaken
the four guards that keep it out of the public repo (§9.1).

In the owner's deployment the vault has a private remote and **the VM is
the only writer** (§3.1): the laptop clone is read-only, pulled to browse in
Obsidian, and memory is captured through the gateway rather than by local
tools. A fresh clone of this repo has no vault at all and every hook and
script is inert without one.
