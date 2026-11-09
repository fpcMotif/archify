import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererEntry } from '../schematics/packages/svg/renderer-entry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..', 'schematics');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schematics-animation-'));

const CASES = {
  architecture: 'web-app.architecture.json',
  workflow: 'agent-tool-call.workflow.json',
  sequence: 'cache-miss-request.sequence.json',
  dataflow: 'product-analytics.dataflow.json',
  lifecycle: 'agent-run.lifecycle.json',
};

const NODE_COLLECTION = {
  architecture: 'components',
  workflow: 'nodes',
  sequence: 'participants',
  dataflow: 'nodes',
  lifecycle: 'states',
};

function render(mode, example, animation = 'trace', visualPreset) {
  const doc = JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples', example), 'utf8'));
  if (animation) doc.meta = { ...doc.meta, animation };
  else delete doc.meta.animation;
  if (visualPreset) doc.meta.visual_preset = visualPreset;
  else if (visualPreset === null) delete doc.meta.visual_preset;
  const suffix = `${animation || 'static'}-${visualPreset || 'default'}`;
  const input = path.join(tmp, `${mode}-${suffix}.json`);
  const output = path.join(tmp, `${mode}-${suffix}.html`);
  fs.writeFileSync(input, JSON.stringify(doc));
  execFileSync(process.execPath, [rendererEntry(skillRoot, mode), input, output], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return fs.readFileSync(output, 'utf8');
}

function svgBlock(html) {
  return html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0] || '';
}

test('all ten diagram modes enable motion without an authoring switch', () => {
  const examples = { ...CASES, erd: 'orders.erd.json', class: 'payments.class.json',
    tree: 'payment-platform.tree.json', timeline: 'payment-incident.timeline.json',
    waterfall: 'checkout-request.waterfall.json' };
  for (const [mode, example] of Object.entries(examples)) {
    const defaultSvg = svgBlock(render(mode, example, null, null));
    assert.match(defaultSvg, /data-animation="trace"/, mode);
    assert.match(defaultSvg, /data-animate="node"/, mode);
    assert.equal(defaultSvg, svgBlock(render(mode, example, 'trace', null)), `${mode}: unchanged geometry`);
    assert.equal(defaultSvg, svgBlock(render(mode, example, 'none', null)), `${mode}: legacy input remains accepted`);
  }
});

test('classic preset remains the default for existing diagrams', () => {
  const html = render('architecture', CASES.architecture, null, null);
  assert.match(html, /<html lang="en" data-theme="dark" data-preset="classic">/);
  assert.match(svgBlock(html), /data-preset="classic"/);
});

test('a retired signal-flow source renders as Classic with the full viewer and export surface', () => {
  const html = render('workflow', CASES.workflow, 'trace', 'signal-flow');
  assert.match(html, /<html lang="en" data-theme="dark" data-preset="classic">/);
  assert.match(svgBlock(html), /data-preset="classic"/);
  assert.doesNotMatch(html, /data-preset-badge|signal-flow/);
  assert.doesNotMatch(html, /data-last-motion-bytes|Schematics\.motion = /);
  assert.match(html, /aria-label="Diagram view controls"/);
  assert.match(html, /Schematics\.focus = \(function \(\)/);
  assert.match(html, /Schematics\.view = \(function \(\)/);
  assert.match(html, /clone\.style\.removeProperty\('transform'\)/);
  assert.match(html, /clone\.removeAttribute\('data-view-scale'\)/);
  assert.match(html, /data-last-export-canonical/);
  assert.match(html, /data-last-export-error-format/);
  assert.match(html, /data-last-export-error/);
  assert.match(html, /canonicalStateClean: canonicalStateClean/);
  assert.match(html, /recordExportReceipt\('svg', blob, d\.canonicalStateClean\)/);
});

test('blueprint preset reaches every visual surface without changing the default', () => {
  const html = render('architecture', CASES.architecture, null, 'blueprint');
  assert.match(html, /<html lang="en" data-theme="dark" data-preset="blueprint">/);
  assert.match(svgBlock(html), /data-preset="blueprint"/);
  assert.doesNotMatch(html, /data-preset-badge|\[data-preset="blueprint"\]\[data-theme/);
  assert.match(html, /html\[data-preset="blueprint"\] \.overview-map \{ border-radius: 0\.28rem; \}/);
});

test('blueprint preset is accepted by all five typed renderers', () => {
  for (const [mode, example] of Object.entries(CASES)) {
    const html = render(mode, example, null, 'blueprint');
    assert.match(html, /data-preset="blueprint"/, mode);
    assert.match(svgBlock(html), /data-preset="blueprint"/, mode);
  }
});

test('editorial preset reaches every visual surface and all five typed renderers', () => {
  for (const [mode, example] of Object.entries(CASES)) {
    const html = render(mode, example, null, 'editorial');
    assert.match(html, /<html lang="en" data-theme="dark" data-preset="editorial">/, mode);
    assert.match(svgBlock(html), /data-preset="editorial"/, mode);
    assert.doesNotMatch(html, /data-preset-badge|\[data-preset="editorial"\]\[data-theme/, mode);
    assert.match(html, /html\[data-preset="editorial"\] h1,\s*html\[data-preset="editorial"\] \.card h3 \{/, mode);
  }
});

test('all five renderers add one geometry-neutral semantic sigil per sigil-bearing node', () => {
  for (const [mode, example] of Object.entries(CASES)) {
    const source = JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples', example), 'utf8'));
    // Lifecycle start, active and neutral states have no default sigil unless final.
    const outgoing = new Set((source.transitions || []).map((transition) => transition.from));
    const expected = source[NODE_COLLECTION[mode]].filter((node) => mode !== 'lifecycle' || node.icon
      || !['start', 'active', 'neutral'].includes(node.type) || !outgoing.has(node.id)).length;
    const staticHtml = render(mode, example, null, 'classic');
    const traceHtml = render(mode, example, 'trace', 'classic');
    const staticSvg = svgBlock(staticHtml);
    const traceSvg = svgBlock(traceHtml);
    // Legend swatches reuse the sigil glyph; only node sigils are counted.
    const legendSwatch = (svg, index) => /data-legend-semantic-kind="[^"]*"[^>]*>\s*$/.test(svg.slice(Math.max(0, index - 300), index));
    const sigils = (svg) => [...svg.matchAll(/<g aria-hidden="true" data-semantic-sigil="[^"]+"[\s\S]*?<\/g>/g)]
      .filter((match) => !legendSwatch(svg, match.index))
      .map((match) => match[0]);

    assert.equal(sigils(staticSvg).length, expected, mode);
    assert.deepEqual(sigils(traceSvg), sigils(staticSvg), `${mode} trace must not change sigil geometry`);
    assert.match(staticHtml, /svg \.semantic-sigil \{/i, mode);
    assert.match(staticHtml, /svg \.s-database\s+\{ color: var\(--database-stroke\); \}/, mode);
  }
});

test('unknown visual presets are rejected by schema validation', () => {
  assert.throws(
    () => render('architecture', CASES.architecture, null, 'hologram'),
    /visual_preset/,
  );
});

for (const [mode, example] of Object.entries(CASES)) {
  test(`${mode}: trace animation annotates svg, edges, and nodes`, () => {
    const svg = svgBlock(render(mode, example));
    assert.match(svg, /<svg[^>]+data-animation="trace"/);
    assert.match(svg, /data-animate="edge" style="--step:0"/);
    assert.match(svg, /data-animate="node" style="--step:0"/);
    assert.match(svg, /aria-labelledby="schematics-diagram-title schematics-diagram-description"/);
    assert.match(svg, /<title id="schematics-diagram-title">[^<]+<\/title>/);
    assert.match(svg, /<desc id="schematics-diagram-description">[^<]+<\/desc>/);
    assert.match(svg, /id="node-[^"]+" data-node-id="[^"]+"[^>]+role="button"[^>]+aria-pressed="false"/);
    assert.match(svg, /data-edge-from="[^"]+" data-edge-to="[^"]+"/);
  });
}

test('semantic SVG identity is deterministic for unchanged input', () => {
  const first = svgBlock(render('workflow', CASES.workflow));
  const second = svgBlock(render('workflow', CASES.workflow));
  const hooks = (svg) => [...svg.matchAll(/(?:id="node-|data-edge-from=")[^>]+/g)].map((match) => match[0]);
  assert.deepEqual(hooks(first), hooks(second));
});

test('Live relay ships comet layers whose timing the Motion Governor plans', () => {
  const html = render('architecture', CASES.architecture);
  for (const layer of ['wake', 'glow', 'halo', 'tail', 'head', 'ripple']) {
    assert.match(html, new RegExp(`\\.ambient-flow-${layer} \\{`));
  }
  assert.match(html, /@keyframes schematics-node-enter/);
  assert.match(html, /--flow-cycle: 6\.4s/);
  assert.match(html, /html\[data-theme="light"\] svg\[data-animation="trace"\] \{/);
  assert.match(html, /html\[data-theme="light"\] \.ambient-flow-head \{/);
  // Per-edge keyframes come from the planned relay; no fixed shared-cycle
  // cascade, echo comet or load-time trace layer remains.
  assert.match(html, /function planRelay\(records, windows\)/);
  assert.match(html, /animation-name: var\(--flow-name, none\)/);
  assert.doesNotMatch(html, /schematics-cascade-|schematics-flow-ripple-echo|tail echo|--flow-step-delay/);
  assert.doesNotMatch(html, /schematics-ambient-flow|--ambient-flow-duration/);
  assert.doesNotMatch(html, /ambient-flow-trace|schematics-trace-in|schematics-trace-fade/);
});

process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
