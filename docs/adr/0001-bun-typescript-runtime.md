---
status: accepted
---

# Bun and TypeScript are the target runtime

This fork moves its CLI, renderers, scripts and tests from Node `.mjs` to TypeScript run by Bun. Bun runs `.ts` files without a build step, and `bun build --compile` can ship the CLI as one native executable. The owner wants one runtime and one typed language across the repository.

The migration is not done. Node still runs the shipped Skill, CI, the test runner and the canonical ZIP build, and `CONTRIBUTING.md` describes that current state. A file keeps working under Node until it is converted.

## Rules for the migration

- New code is TypeScript run by Bun. The `.mjs` ratchet (`bun scripts/check-mjs-ratchet.ts`, run by hk and CI) fails on any `.mjs` path missing from `scripts/mjs-ratchet.txt`.
- Convert one module or renderer per change, with its tests. In the same change, run the ratchet with `--update` to drop the converted paths.
- Report progress by the ratchet's remaining count. A change that converts some files is a partial migration, not "all `.mjs` removed".
- Claim a speed-up only with a before and after measurement of the same render.

## Considered options

- **Keep Node `.mjs`.** Rejected. The owner prefers Bun, and the untyped renderers carry the most risk.
- **Rewrite the solver in Rust, Swift, C or Zig.** Rejected for now. An `archify_core` Rust crate was built, but no code path called it, so it was deleted. A native rewrite of one part needs a measured bottleneck first.

## Consequences

- The repository cannot type-check TypeScript yet: it has no `tsconfig.json` or `@types/bun`. The first migration change adds them and moves from `package-lock.json` to Bun's lockfile.
- Users who install the Skill run it with Node today. Moving the shipped Skill to Bun changes what users must install, so it needs its own decision before the ZIP build changes.
- The upstream repository `tt-a1i/archify` stays on Node, so merges from upstream will conflict more as files convert.
