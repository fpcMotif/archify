// Golden-file harness for the schematics renderers. No test framework needed:
// renderers are deterministic, so fresh renders must match both checked-in
// development and packaged example HTML aside from platform checkout line endings. Also covers schema enforcement (negative cases),
// template freshness of the architecture-mode example, and version sync.
//
// Run from the repository root: npm test

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererEntry } from '../schematics/packages/svg/renderer-entry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..', 'schematics');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schematics-test-'));

let failures = 0;

function check(name: string, ok: unknown, detail?: string) {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function render(mode: string, inputPath: string, outPath: string) {
  execFileSync(process.execPath, [
    rendererEntry(skillRoot, mode),
    inputPath,
    outPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

function normalizeNewlines(text: string) {
  return text.replace(/\r\n?/g, '\n');
}

function failureText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const stderr = 'stderr' in err ? err.stderr : undefined;
  return String(stderr || err.message);
}

// ---------------------------------------------------------------------------
console.log('golden renders (renderer output must match checked-in examples)');

const GOLDEN: [string, string, string][] = [
  ['workflow', 'agent-tool-call.workflow.json', 'workflow-agent-tool-call-rendered.html'],
  ['sequence', 'cache-miss-request.sequence.json', 'sequence-cache-miss-request.html'],
  ['dataflow', 'product-analytics.dataflow.json', 'dataflow-product-analytics.html'],
  ['lifecycle', 'agent-run.lifecycle.json', 'lifecycle-agent-run.html'],
  ['architecture', 'web-app.architecture.json', 'web-app-rendered.html'],
  ['erd', 'orders.erd.json', 'erd-orders-rendered.html'],
  ['erd', 'subscription-billing.erd.json', 'subscription-billing-rendered.html'],
  ['tree', 'payment-platform.tree.json', 'tree-payment-platform-rendered.html'],
  ['tree', 'schematics-repository.tree.json', 'tree-schematics-repository-rendered.html'],
  ['class', 'payments.class.json', 'class-payments-rendered.html'],
  ['class', 'payment-processors.class.json', 'class-payment-processors-rendered.html'],
  ['timeline', 'payment-incident.timeline.json', 'timeline-payment-incident-rendered.html'],
  ['timeline', 'schematics-dev-activity.timeline.json', 'timeline-schematics-dev-activity-rendered.html'],
  ['waterfall', 'checkout-request.waterfall.json', 'waterfall-checkout-request-rendered.html'],
  ['waterfall', 'example-rebuild.waterfall.json', 'waterfall-example-rebuild-rendered.html'],
];

for (const [mode, input, golden] of GOLDEN) {
  const out = path.join(tmp, golden);
  try {
    render(mode, path.join(skillRoot, 'examples', input), out);
    const fresh = fs.readFileSync(out, 'utf8');
    const checked = fs.readFileSync(path.join(skillRoot, 'examples', golden), 'utf8');
    check(`${mode}: ${golden}`, normalizeNewlines(fresh) === normalizeNewlines(checked),
      `fresh render differs from schematics/examples/${golden}; if the change is intentional, run render:examples and commit the result`);
  } catch (err) {
    check(`${mode}: ${golden}`, false, failureText(err).slice(0, 300));
  }
}

// ---------------------------------------------------------------------------
console.log('schema enforcement (invalid JSON must fail with a path-prefixed message)');

type JsonDocument = ReturnType<typeof JSON.parse>;

function exampleInput(mode: string): string {
  const entry = GOLDEN.find(([m]) => m === mode);
  if (!entry) throw new Error(`no golden example for ${mode}`);
  return entry[1];
}

function expectFailure(name: string, mode: string, mutate: (document: JsonDocument) => void, expectInMessage: string) {
  const base = JSON.parse(fs.readFileSync(
    path.join(skillRoot, 'examples', exampleInput(mode)), 'utf8'));
  mutate(base);
  const input = path.join(tmp, `neg-${name.replace(/[^a-z0-9]+/gi, '-')}.json`);
  fs.writeFileSync(input, JSON.stringify(base));
  try {
    render(mode, input, path.join(tmp, 'neg-out.html'));
    check(name, false, 'renderer exited 0 on invalid input');
  } catch (err) {
    const message = failureText(err);
    check(name, message.includes(expectInMessage),
      `expected "${expectInMessage}" in:\n${message.slice(0, 300)}`);
  }
}

expectFailure('card dot outside enum', 'workflow',
  (d: JsonDocument) => { d.cards[0].dot = 'pink'; }, '/cards/0/dot');
expectFailure('node id starting with a digit', 'workflow',
  (d: JsonDocument) => { d.nodes[0].id = '1user'; }, 'pattern');
expectFailure('extra property rejected', 'workflow',
  (d: JsonDocument) => { d.nodes[0].colour = 'red'; }, 'additional properties');
{
  // Schema 1/2 files may still carry retired guided views: accept, ignore.
  const d = JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples', exampleInput('workflow')), 'utf8'));
  d.meta.views = [{ id: 'v', label: 'Legacy view', focus: [d.nodes[0].id] }];
  const input = path.join(tmp, 'legacy-views.json');
  const out = path.join(tmp, 'legacy-views.html');
  fs.writeFileSync(input, JSON.stringify(d));
  let html = '';
  try { render('workflow', input, out); html = fs.readFileSync(out, 'utf8'); } catch (_) {}
  check('legacy meta.views accepted and ignored', html && !html.includes('Legacy view'),
    'a file with meta.views must still render, without guided-view UI');
}
expectFailure('column beyond layout maximum', 'workflow',
  (d: JsonDocument) => { d.nodes[0].col = 7; }, '<= 5');
expectFailure('missing schema_version', 'sequence',
  (d: JsonDocument) => { delete d.schema_version; }, 'schema_version');
expectFailure('main-path step without a transition', 'lifecycle',
  (d: JsonDocument) => { d.transitions = d.transitions.filter((t: JsonDocument) => !(t.from === 'queued' && t.to === 'planning')); },
  'mainPath step "queued" -> "planning" has no transition');
expectFailure('zero component width rejected by schema', 'architecture',
  (d: JsonDocument) => { d.components[0].size = [0, 60]; }, '/components/0/size/0');
expectFailure('zero component height rejected by schema', 'architecture',
  (d: JsonDocument) => { d.components[0].size = [120, 0]; }, '/components/0/size/1');
expectFailure('negative component width rejected by schema', 'architecture',
  (d: JsonDocument) => { d.components[0].size = [-1, 60]; }, '/components/0/size/0');
expectFailure('unknown attribute key rejected by schema', 'erd',
  (d: JsonDocument) => { d.entities[0].attributes[0].key = 'super'; }, '/entities/0/attributes/0/key');
expectFailure('key role outside the list enum rejected by schema', 'erd',
  (d: JsonDocument) => { d.entities[0].attributes[0].key = ['pk', 'super']; }, '/entities/0/attributes/0/key');
expectFailure('fk role inside a key list without a target rejected by schema', 'erd',
  (d: JsonDocument) => { d.entities[0].attributes[0].key = ['fk', 'pk']; }, "must have required property 'references'");
expectFailure('identifying false with a contradicting variant rejected by schema', 'erd',
  (d: JsonDocument) => {
    d.relationships[0].identifying = false;
    d.relationships[0].variant = 'emphasis';
  }, '/relationships/0/variant');
expectFailure('entity without a label rejected by schema', 'erd',
  (d: JsonDocument) => { delete d.entities[0].label; }, '/entities/0');
expectFailure('unknown relationship cardinality rejected by schema', 'erd',
  (d: JsonDocument) => { d.relationships[0].toCardinality = 'several'; }, '/relationships/0/toCardinality');
expectFailure('unstated relationship cardinality rejected by schema', 'erd',
  (d: JsonDocument) => { delete d.relationships[0].fromCardinality; }, '/relationships/0');
expectFailure('fk attribute without a target rejected by schema', 'erd',
  (d: JsonDocument) => {
    const fk = d.entities.flatMap((entity: JsonDocument) => entity.attributes).find((attribute: JsonDocument) => attribute.key === 'fk');
    delete fk.references;
  }, "must have required property 'references'");
expectFailure('tree node without a label rejected by schema', 'tree',
  (d: JsonDocument) => { delete d.nodes[1].label; }, '/nodes/1');
expectFailure('unknown tree direction rejected by schema', 'tree',
  (d: JsonDocument) => { d.layout = { direction: 'up' }; }, '/layout/direction');
expectFailure('type without a kind rejected by schema', 'class',
  (d: JsonDocument) => { delete d.types[0].kind; }, '/types/0');
expectFailure('unknown relationship kind rejected by schema', 'class',
  (d: JsonDocument) => { d.relationships[0].kind = 'uses'; }, '/relationships/0/kind');
expectFailure('unknown member visibility rejected by schema', 'class',
  (d: JsonDocument) => { d.types[0].methods[0].visibility = 'internal'; }, '/types/0/methods/0/visibility');
expectFailure('timeline timestamp without an offset rejected by schema', 'timeline',
  (d: JsonDocument) => { d.events[0].at = '2026-10-01T10:00:00'; }, '/events/0/at');
expectFailure('timeline without evidence status rejected by schema', 'timeline',
  (d: JsonDocument) => { delete d.meta.evidence; }, "must have required property 'evidence'");
expectFailure('negative span start rejected by schema', 'waterfall',
  (d: JsonDocument) => { d.spans[0].start = -1; }, '/spans/0/start');
expectFailure('waterfall without evidence status rejected by schema', 'waterfall',
  (d: JsonDocument) => { delete d.meta.evidence; }, "must have required property 'evidence'");
expectFailure('references outside entity.attribute rejected by schema', 'erd',
  (d: JsonDocument) => {
    const fk = d.entities.flatMap((entity: JsonDocument) => entity.attributes).find((attribute: JsonDocument) => attribute.key === 'fk');
    fk.references = 'product';
  }, 'pattern');

// ---------------------------------------------------------------------------
console.log('template freshness (architecture example must carry the current template)');

function blocks(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g');
  return html.match(re) || [];
}

const template = fs.readFileSync(path.join(skillRoot, 'assets/template.html'), 'utf8');
const webApp = fs.readFileSync(path.join(skillRoot, 'examples/web-app-rendered.html'), 'utf8');
// Viewer styles in the document head and executable scripts pass through
// applyTemplate untouched. Renderer-owned SVG styles are covered by golden renders.
for (const tag of ['style', 'script']) {
  // The guided-view JSON script is generated from meta.views; compare only
  // template-owned executable scripts, not per-diagram data payloads.
  const isTemplateOwned = (block: string) => !block.includes('type="application/json"');
  const t = blocks(template, tag).filter((b) => !b.includes('[PROJECT NAME]') && isTemplateOwned(b));
  const viewerHtml = tag === 'style' ? webApp.slice(0, webApp.indexOf('</head>')) : webApp;
  const w = blocks(viewerHtml, tag).filter((b) => !b.includes('Sample Web App') && isTemplateOwned(b));
  check(`web-app-rendered.html ${tag} blocks match template`,
    JSON.stringify(t) === JSON.stringify(w),
    'schematics/examples/web-app-rendered.html was generated from a stale template — re-derive it');
}

// ---------------------------------------------------------------------------
console.log('version sync');

const pkg = JSON.parse(fs.readFileSync(path.join(skillRoot, 'package.json'), 'utf8'));
check('template generator meta matches package.json version',
  template.includes(`<meta name="generator" content="schematics ${pkg.version}">`),
  `package.json says ${pkg.version}`);

const skillMd = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
const skillVersion = (skillMd.match(/^\s*version:\s*"([^"]+)"/m) || [])[1];
const packageMajorMinor = pkg.version.match(/^(\d+\.\d+)\./)?.[1];
check('SKILL.md metadata version matches package.json major.minor',
  !!packageMajorMinor && skillVersion === packageMajorMinor,
  `SKILL.md says ${skillVersion}, package.json says ${pkg.version}`);

// ---------------------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
