# Contributing to Archify

This fork keeps one product: typed JSON in, a validated, self-contained HTML diagram out. Keep each change focused on one user-visible behavior. Reviews follow [Reviewing](REVIEWING.md). The runtime is Bun, and new code is TypeScript; see [ADR 0001](docs/adr/0001-bun-typescript-runtime.md).

Do not put secrets, tokens, credentials, private repository content or personal data in fixtures, logs, screenshots or artifacts.

## Choose the right path

- A renderer, validator or Viewer defect: open an issue with the [bug report form](.github/ISSUE_TEMPLATE/bug-report.yml) and a minimal JSON reproduction.
- A behavior change: agree on the problem and scope in an issue before substantial work.
- A mechanical documentation fix, such as a typo or a broken link: open a PR directly.

## Prepare a reviewable change

Before you ask for a final review, explain these three things:

- The trigger, the intended outcome and why the benefit is worth the maintenance cost.
- The changed behavior, its shared callers and the existing behavior that must stay stable.
- The checks you ran and their actual results.

Use [the PR template](.github/PULL_REQUEST_TEMPLATE.md). Link receipts or CI runs instead of pasting long logs. Classify impact by behavior and callers, not by file extension or diff size.

## AI assistance and contributor responsibility

When an Agent did part of the work, the PR names the tool, the model when known and the work it did. A human reviews the change and can explain its choices. Separate checks run by an Agent, by CI and by a person, and keep failures and untested areas visible.

## PR improvement check

Before you ask for a final review of a behavior change, assess the changed behavior, its direct callers and the affected tests with the project Skills:

- [test-value](.agents/skills/test-value/SKILL.md): decide which tests to add, adapt, reuse or retire. Protect user outcomes and real failure boundaries.
- [simplify-codebase](.agents/skills/simplify-codebase/SKILL.md): use Focused Survey mode when the diff touches duplicate logic, dead paths or redundant layers. Trace the consumers before you recommend a cut.

Keep the check inside the PR's changed boundaries. "No worthwhile improvement" is a valid result. Pure prose changes can skip it. Treat the two vendored Skills as read-only; see [Skill sources](.agents/README.md).

## Choose evidence by impact

| Impact | Typical change | Evidence |
| --- | --- | --- |
| Text | Prose, links, review procedure | Check content and links. No renderer suite. |
| Local behavior | One CLI path, one test fix | A reproduction and the affected tests. |
| Shared behavior | Geometry, text measurement, Viewer, delivery helpers | Trace callers. Compare fixed inputs on base and candidate. |
| Contract change | Schema, defaults, validation, Skill instructions | State the allowed and preserved behavior, plus local or shared evidence. |

Skill instructions, examples and generated-template sources are behavioral inputs, even when they look like documentation.

Tests protect a user outcome or a real failure boundary. Prefer rendered content, successful interaction and preserved authored intent over matching implementation source or frozen automatic coordinates. Keep explicit geometry, compatibility, accessibility, failure cleanup and protection against lost output as observable contracts.

## Product and compatibility contracts

- Existing schema-v1 JSON stays valid unless a reviewed change adds a breaking rule and a migration path.
- Preserve authored topology and intent. Explicit geometry stays authoritative; see the [authoring contract](archify/references/authoring-contract.md).
- `standard` keeps broad compatibility. A new `showcase` failure must name a real, repairable defect.
- Agent-facing failures go in `diagnostics[]` with a stable `code`, a precise `subject`, concrete `evidence` and executable `supportedFixes`. Failed stages keep a non-zero exit and a machine-readable receipt.
- Keep one canonical contract per behavior. Link it instead of copying it.

## Local setup and verification

The renderer package is in `archify/`. Repository tests and their dependencies live at the root. Install both with Bun 1.4 or newer:

```sh
bun install && bun install --cwd archify
```

| Command | What it checks |
| --- | --- |
| `bun run test` | The core smoke: all ten diagram types through the public CLI. |
| `bun test test/<name>.test.mjs` | Only the selected files. Add `-t '<name pattern>'` to narrow further. |
| `bun run test:generated` | The Viewer template, brand marks, validators and golden example renders match their sources. |
| `bun run test:all` | Every test file, with a 120-second per-test timeout. Chrome suites skip unless `ARCHIFY_CHROME` is set. |
| `bun run test:browser` | The Chrome suites. It fails when no Chrome, Chromium or Edge is found. |
| `bun check` | TypeScript types. |
| `bun scripts/check-mjs-ratchet.ts` | No new `.mjs` file. Run it with `--update` after you convert or delete one. |

A skipped browser test is skipped, not passed. To run one browser file:

```sh
ARCHIFY_CHROME="/path/to/chrome" bun run test:browser ./test/desktop-reader-browser.test.mjs
```

Test through public behavior such as `render`, `validate`, `deliver`, `finalize` or the final SVG/HTML. A behavior fix includes a regression test that fails without the fix.

For geometry and layout changes, use the smallest redacted JSON reproduction and the checked-in examples. Compare base and candidate with the same input and browser. Updating golden files alone does not prove visual acceptance. A visual change needs screenshots or reproducible steps at a comparable viewport, theme and preset.

## Packages and generated artifacts

Viewer work starts in [`viewer/`](viewer/README.md). Edit its sources, then run `bun run generate:viewer` from `archify/`. `bun run test:generated` checks that the template is fresh.

Regenerate only outputs whose sources changed. `bun run render:examples` from `archify/` rebuilds the example pages. List the regenerated files in the PR.

## Final integration and follow-up

Refresh the base branch and the PR head before you merge. Rerun the checks whose evidence the update invalidated. Confirm that CI ran on the final head. Zero checks is not green.

On a revision, summarize what changed since the reviewed head and which findings it addresses.

## License

New contributions are under the [Apache License 2.0](LICENSE). Historical MIT contributions and third-party licenses remain in effect; see [NOTICE](NOTICE) and [LICENSE-MIT](LICENSE-MIT).
