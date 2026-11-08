# Packages

Each folder under `packages/` is a deep module: a lot of behaviour behind a small interface. dependency-cruiser enforces the boundary with the rules in [`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs).

## Layout

```
packages/
  <name>/
    index.ts        ← an entry point (public). Import this from outside.
    client.ts       ← another entry point. A package may expose several.
    lib/            ← implementation. Hidden from outside the package.
    tests/          ← tests and fixtures. Also a subfolder, so also private.
```

A package's public surface is its root files. Anything in a subfolder is private. Packages are flat: a package must not contain another package. [`example/`](example/) is a starter template that you can copy or delete.

## Rules

**Entry-point boundary.** Code outside a package, in the app or in another package, imports only that package's root files. It never imports anything in the package's subfolders.

**Intra-package freedom.** A package's own files import each other freely, including files in `lib/`.

**Tests through the entry points.** Files in `<name>/tests/` import package entry points and their own `tests/` fixtures. They never import any package's subfolder internals, including their own `lib/`.

**No cycles.** The dependency graph must have no cycles.

## No barrel files

Do not write an `index.ts` that re-exports a whole subtree. Add a small root file for each entry point instead, such as `client.ts` or `server.ts`. A new entry point needs no config change.

## Check the boundaries

```bash
bun run lint:boundaries
```

`hk check` runs the same step.
