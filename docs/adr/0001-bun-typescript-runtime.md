---
status: accepted
---

# Bun and TypeScript are the target runtime

This fork moves its CLI, renderers, scripts and tests from Node `.mjs` to typed TypeScript. Bun runs the TypeScript during development and tests. Releases ship as compiled executables, so users need no JavaScript runtime: `bun build --compile` builds the whole CLI, and scriptc compiles the typed layout core to native code. The owner wants one typed language across the repository, and a fast native release.

The migration is not done. Node still runs the shipped Skill, CI, the test runner and the canonical ZIP build, and `CONTRIBUTING.md` describes that current state. A file keeps working under Node until it is converted.

## Measurements behind the choice

Measured on an Apple Silicon Mac on 2026-11-06 with hyperfine:

| Run | Wall time |
|---|---|
| `node archify.mjs render sequence` | 172 ms |
| The same `.mjs` under `bun` | 68 ms, byte-identical output |
| A layout-style loop: scriptc native / `bun --compile` / `bun` / `node` | 8.4 / 18.3 / 19.2 / 88 ms |
| Read the 880 KB template, one regex, SHA-256: scriptc native / `bun` / `node` | 5 / 12.2 / 80 ms |

In a sequence render under Bun, the layout code itself takes about 5 ms. Most of the rest is process start-up, a second renderer process, locale loading and string patching of the template.

`scriptc coverage` reports that `renderers/shared/geometry.mjs` and `fixes.mjs` compile 100% to native code. `text-fit`, `utils`, `i18n` and `legend` each compile 99%; one `Map` typing blocks each. The generated Ajv validators (`generated-validators.mjs`) do not compile, because they read a `var` before its assignment.

`bun test` runs the existing `node:test` files unchanged: `geometry.test.mjs` passes 87 of 87.

## Rules for the migration

- New code is TypeScript. The `.mjs` ratchet (`bun scripts/check-mjs-ratchet.ts`, run by hk and CI) fails on any `.mjs` path missing from `scripts/mjs-ratchet.txt`.
- Convert one module or renderer per change, with its tests. In the same change, run the ratchet with `--update` to drop the converted paths.
- A converted renderer exports a function from diagram to HTML, and the CLI calls it in-process instead of starting a second process.
- Layout code stays inside scriptc's supported subset. Check it with `scriptc coverage`.
- Report progress by the ratchet's remaining count. A change that converts some files is a partial migration, not "all `.mjs` removed".
- Claim a speed-up only with a before and after measurement of the same render.

## Considered options

- **Keep Node `.mjs`.** Rejected. Node is the slowest runtime measured, and the untyped renderers carry the most risk.
- **Porffor.** Rejected. It compiled the layout loop to a 200 KB binary, but the binary ran in 33.7 ms, slower than Bun. It also could not compile an `import` declaration, so it cannot build archify's module graph.
- **Rewrite the core by hand in Zig, C, Swift or Rust.** Rejected. scriptc already reaches native speed from the same TypeScript, so a second language would add a second codebase without a measured gain. An earlier `archify_core` Rust crate was deleted because no code path called it.

## Consequences

- The Ajv-generated validators must be replaced by typed validators that scriptc can compile before the whole CLI can build with scriptc. Until then, `bun build --compile` builds the release executable.
- The repository cannot type-check TypeScript yet: it has no `tsconfig.json` or `@types/bun`. The first migration change adds them and moves from `package-lock.json` to Bun's lockfile.
- The shipped Skill moves from Node to per-platform executables. This drops the Node 18, 20 and 24 compatibility lanes, and it replaces the Node 22 canonical ZIP build.
- scriptc is experimental. Each scriptc build must produce byte-identical output to the Bun build of the same source.
- The upstream repository `tt-a1i/archify` stays on Node, so merges from upstream will conflict more as files convert.
