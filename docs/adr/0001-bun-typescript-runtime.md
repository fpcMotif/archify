---
status: accepted
---

# Bun and TypeScript are the target runtime

This fork moves its CLI, renderers, scripts and tests from Node `.mjs` to typed TypeScript. Bun is the only runtime: it runs the Skill, the CLI, the tests and CI. Node is not supported. The goal is a release that ships as a compiled executable, so users need no JavaScript runtime: `bun build --compile` builds the whole CLI, and scriptc compiles the typed layout core to native code. The owner wants one typed language across the repository, and a fast native release.

The language migration is not done. `packages/geometry/geometry.ts` is the first converted module; the other `.mjs` files run unchanged under Bun until they are converted. The ratchet's remaining count is the progress measure.

## Measurements behind the choice

Measured on an Apple Silicon Mac on 2026-11-06 with hyperfine:

| Run | Wall time |
|---|---|
| `node schematics.mjs render sequence` | 172 ms |
| The same `.mjs` under `bun` | 68 ms, byte-identical output |
| A layout-style loop: scriptc native / `bun --compile` / `bun` / `node` | 8.4 / 18.3 / 19.2 / 88 ms |
| Read the 880 KB template, one regex, SHA-256: scriptc native / `bun` / `node` | 5 / 12.2 / 80 ms |

In a sequence render under Bun, the layout code itself takes about 5 ms. Most of the rest is process start-up, a second renderer process, locale loading and string patching of the template.

`scriptc coverage` reports that `packages/geometry/geometry` and `fixes` compile 100% to native code. `text-fit`, `utils`, `i18n` and `legend` each compile 99%; one `Map` typing blocks each. The generated Ajv validators (`generated-validators/<type>.js`) do not compile, because they read a `var` before its assignment.

`bun test` runs the existing `node:test` files. All golden example renders are byte-identical under Bun. A few tests needed Bun equivalents: fault injection through Node's `--import` loader hooks moves to a `--preload` script with `Bun.plugin`.

## Rules for the migration

- New code is TypeScript. The `.mjs` ratchet (`bun scripts/check-mjs-ratchet.ts`, run by hk and CI) fails on any `.mjs` path missing from `scripts/mjs-ratchet.txt`.
- Convert one module or renderer per change, with its tests. In the same change, run the ratchet with `--update` to drop the converted paths.
- A converted renderer exports a function from diagram to HTML, and the CLI calls it in-process instead of starting a second process.
- Layout code stays inside scriptc's supported subset. Check it with `scriptc coverage`.
- Report progress by the ratchet's remaining count. A change that converts some files is a partial migration, not "all `.mjs` removed".
- Claim a speed-up only with a before and after measurement of the same render.

## Considered options

- **Keep Node `.mjs`.** Rejected. Node is the slowest runtime measured, and the untyped renderers carry the most risk.
- **Support both Node and Bun.** Rejected. Two runtimes double the test matrix, and Node-only hooks such as loader `register` keep tests from moving to Bun APIs.
- **Porffor.** Rejected. It compiled the layout loop to a 200 KB binary, but the binary ran in 33.7 ms, slower than Bun. It also could not compile an `import` declaration, so it cannot build schematics's module graph.
- **Rewrite the core by hand in Zig, C, Swift or Rust.** Rejected. scriptc already reaches native speed from the same TypeScript, so a second language would add a second codebase without a measured gain. An earlier `schematics_core` Rust crate was deleted because no code path called it.

## Consequences

- The Ajv-generated validators must be replaced by typed validators that scriptc can compile before the whole CLI can build with scriptc. Until then, `bun build --compile` builds the release executable.
- `tsconfig.json` uses `erasableSyntaxOnly` and `verbatimModuleSyntax`, so every `.ts` file runs by type stripping alone. `bun check` type-checks it. Dependencies lock in `bun.lock`.
- The fork drops what does not render or show a diagram: the website, gallery, release ZIP and its gates, the update notifier, community packages and agent integrations. Node compatibility lanes go with them.
- The Skill runs as `bun bin/schematics.ts` until per-platform executables exist.
- scriptc is experimental. Each scriptc build must produce byte-identical output to the Bun build of the same source.
- The upstream repository `fpcMotif/schematics` stays on Node, so merges from upstream will conflict more as files convert.
