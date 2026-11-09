# Schematics

Schematics turns a typed JSON description of a system into a validated, self-contained HTML diagram. The diagram opens in any browser, works offline, and has dark and light themes, search, path tracing and image or SVG export.

This is a personal fork of [fpcMotif/schematics](https://github.com/fpcMotif/schematics). It keeps the diagram engine, the agent Skill, explainer pages and brand icons. It runs on [Bun](https://bun.sh) only. New code is TypeScript; see [ADR 0001](docs/adr/0001-bun-typescript-runtime.md).

## Diagram types

| Type | Use it for |
|---|---|
| **Architecture** | Components, boundaries and the connections between them |
| **Workflow** | Steps, decisions, approvals and retries |
| **Sequence** | Calls and returns between participants over time |
| **Data Flow** | Sources, transforms, stores and consumers |
| **Lifecycle** | States, events and terminal outcomes |
| **ERD** | Tables, every column with its type, keys and cardinality |
| **Class** | Types, key members, inheritance and composition |
| **Tree** | Single-parent hierarchies such as repositories or modules |
| **Timeline** | Events with timestamps, time zone and source lanes |
| **Waterfall** | Where the time went in one request or agent run |

An **explainer** is a one-page answer with the conclusion first, structured panels, native diagrams and charts.

Rendered examples live in [`schematics/examples/`](schematics/examples/). Open any `*.html` file there in a browser.

## Use it

Install Bun 1.4 or newer, then:

```bash
cd schematics
bun bin/schematics.mjs doctor
bun bin/schematics.mjs guide "Show an API request with Redis cache miss"
bun bin/schematics.mjs validate workflow examples/agent-tool-call.workflow.json --quality showcase --json
bun bin/schematics.mjs finalize workflow examples/agent-tool-call.workflow.json /tmp/workflow.html --quality showcase --json
bun bin/schematics.mjs preview workflow examples/agent-tool-call.workflow.json /tmp/workflow.html --no-open
```

- `finalize` runs four gates in order: validate, deliver, a strict artifact check and a real-browser check. Only a passing artifact replaces the target file.
- `preview` watches one JSON file on a random `127.0.0.1` port and reloads only verified revisions. Stop it with Ctrl-C.
- On failure, `--json` output names the rule, the subject and the supported fixes.

`meta.locale` translates the viewer chrome. `en`, `zh-CN`, `zh-TW`, `es`, `ko` and `ar` are bundled.

## Agent Skill

[`schematics/SKILL.md`](schematics/SKILL.md) holds the full generation and viewer contract. To use it with an agent, link or copy the `schematics/` folder into the agent's skills folder:

| Agent | Skills folder |
|---|---|
| Claude Code | `~/.claude/skills/` or `.claude/skills/` |
| Codex CLI | `~/.agents/skills/` or `.agents/skills/` |
| opencode | `~/.config/opencode/skills/` or `.opencode/skills/` |

## Viewer controls

| Action | Key |
|---|---|
| Diagram guide | <kbd>?</kbd> |
| Find and focus a node | <kbd>/</kbd> |
| Trace a route | <kbd>R</kbd> |
| Compare roles | <kbd>L</kbd> |
| Overview radar | <kbd>M</kbd> |
| Presentation stage | <kbd>F</kbd> |
| Style / theme / export | <kbd>S</kbd> / <kbd>T</kbd> / <kbd>E</kbd> |
| Zoom or reset | <kbd>+</kbd> / <kbd>-</kbd> / <kbd>0</kbd> |

## Develop

```bash
bun install && bun install --cwd schematics
bun run test:all
bun run test:generated
bun run test:browser
```

`test:all` skips the Chrome suites unless `SCHEMATICS_CHROME` is set. `test:browser` finds Chrome and runs them. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). Historical MIT grants remain in effect; see [NOTICE](NOTICE) and [LICENSE-MIT](LICENSE-MIT). Third-party components keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
