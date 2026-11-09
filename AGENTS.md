# Agent instructions

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for repository changes and [REVIEWING.md](REVIEWING.md) for reviews.

## Runtime

Before adding, converting or reporting on a script or module, read [ADR 0001](docs/adr/0001-bun-typescript-runtime.md): new code is Bun TypeScript, and the `.mjs` ratchet tracks what is left.

Packages are deep modules. Before adding or importing one, read [packages/README.md](packages/README.md).

## PR preparation

Before requesting final review, follow the scoped [PR improvement check](CONTRIBUTING.md#pr-improvement-check) using the project Skills when applicable.

## Test selection

Before running tests, read [Choose evidence by impact](CONTRIBUTING.md#choose-evidence-by-impact) to select coverage for the changed behavior. Use the [focused test workflow](CONTRIBUTING.md#local-setup-and-verification) for local iteration. Before integration, follow [Final integration and follow-up](CONTRIBUTING.md#final-integration-and-follow-up) to verify CI and reused evidence against the final revision.

## Live Schematics installations

Install, update, reinstall, or remove a live Schematics installation only when the user explicitly requests that action. Repository editing, testing, reviewing, publishing, or syncing does not authorize installation. This applies to Skills CLI, manual ZIP copies, and DSH plugins. Reuse authorization already given for the same action and scope; ask only for unresolved decisions.

- Keep the source, Skill/package, target agents, and global/project scope within the request. Avoid bulk operations or force flags that expand that scope. An update notification is informational.
- Before a Skills CLI install, discover the selected source with `npx -y skills add <source> --list --full-depth` (default source: `fpcMotif/schematics`) and verify exactly one Skill named `schematics`. For an explicitly requested durable local source, inspect that checkout. Stop on failed or ambiguous discovery.
- Use the canonical remote source by default. Use a local source only when requested, from a durable checkout; live symlinks must not point into temporary directories or disposable worktrees.
- Preserve unrelated files and existing unmanaged destinations. Report a destination conflict before replacing it unless that exact replacement is already explicitly authorized; use the installer's documented conflict handling within the approved scope.
- Report the action, source, targets, and result, including skipped or failed destinations. A partial installation is not a complete success.
