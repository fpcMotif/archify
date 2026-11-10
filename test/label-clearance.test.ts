import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'schematics');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schematics-label-clearance-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
interface MarkupNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: MarkupNode[];
}

let counter = 0;
const load = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
function find(node: MarkupNode, predicate: (node: MarkupNode) => boolean): MarkupNode[] {
  return [...(predicate(node) ? [node] : []), ...(node.childNodes || []).flatMap(child => find(child, predicate))];
}
const attr = (node: MarkupNode, name: string) => node.attrs?.find(a => a.name === name)?.value;
const text = (node: MarkupNode): string => node.nodeName === '#text' ? node.value ?? '' : (node.childNodes || []).map(text).join('');
function deliver(type: string, doc: { meta: Record<string, unknown> }, quality = 'standard') {
  const id = ++counter;
  doc.meta = { ...doc.meta, output: `case-${id}.html`, quality_profile: quality };
  const input = path.join(tmp, `case-${id}.json`), output = path.join(tmp, `case-${id}.html`);
  fs.writeFileSync(input, JSON.stringify(doc));
  const receipt = JSON.parse(execFileSync(process.execPath, [path.join(root, 'bin/schematics.ts'), 'deliver', type, input, output, '--quality', quality, '--json'], { encoding: 'utf8' }));
  assert.equal(receipt.ok, true);
  return parse(fs.readFileSync(output, 'utf8'));
}
function parts(page: MarkupNode, id: string) {
  const group = find(page, n => attr(n, 'data-node-id') === id)[0];
  assert.ok(group, id);
  const label = find(group, n => n.tagName === 'text' && attr(n, 'data-node-label') !== undefined)[0];
  const rect = find(group, n => n.tagName === 'rect')[0];
  const sigil = find(group, n => attr(n, 'data-semantic-sigil') !== undefined)[0];
  const transform = attr(sigil, 'transform');
  assert.ok(transform);
  const numbers = transform.match(/-?[\d.]+/g);
  assert.ok(numbers);
  const [x, y, scale] = numbers.map(Number);
  return { group, label, rect, icon: { x, y, size: scale * 16 } };
}
function checkLabel(p: ReturnType<typeof parts>, expected: string) {
  assert.equal(text(p.label), expected);
  const x = Number(attr(p.label, 'x')), y = Number(attr(p.label, 'y')), font = Number(attr(p.label, 'font-size'));
  // ASCII reproductions: reserve the entire icon square, not just its paths.
  const half = expected.length * font * 0.6 / 2, icon = p.icon;
  assert.ok(x - half >= icon.x + icon.size || x + half <= icon.x || y - font * 1.2 >= icon.y + icon.size,
    `label overlaps sigil: ${JSON.stringify({ x, y, font, icon })}`);
  assert.ok(x - half >= Number(attr(p.rect, 'x')));
  assert.ok(x + half <= Number(attr(p.rect, 'x')) + Number(attr(p.rect, 'width')));
}
for (const quality of ['standard', 'showcase']) {
  test(`previously valid narrow dataflow still delivers with full text and sigil (${quality})`, () => {
    const doc = load('examples/product-analytics.dataflow.json');
    const first = doc.nodes[0]; Object.assign(first, { label: 'Ingester', width: 50 });
    delete first.brand; delete first.sublabel; delete first.tag;
    const p = parts(deliver('dataflow', doc, quality), first.id);
    checkLabel(p, 'Ingester');
    assert.equal(Number(attr(p.rect, 'width')), 50);
    assert.equal(p.icon.size, 11);
  });
  test(`long stage header wraps without rejecting or losing text (${quality})`, () => {
    const doc = load('examples/product-analytics.dataflow.json');
    const title = 'Stream Processing, Enrichment, and Deduplication'; doc.stages[0].label = title;
    const header = find(deliver('dataflow', doc, quality), n => n.tagName === 'text' && text(n) === `01 / ${title}`)[0];
    assert.ok(header);
    const lines = find(header, n => n.tagName === 'tspan');
    assert.ok(lines.length >= 2);
    assert.ok(Number(attr(header, 'font-size')) >= 7);
    assert.ok(Number(attr(header, 'y')) + (lines.length - 1) * 11 < 128);
  });
}
for (const version of [1, 2]) {
  test(`workflow v${version} clears PromptScript without changing box width or shrinking text`, () => {
    const doc = version === 1 ? load('../test/fixtures/v1-workflow-700x400.workflow.json') : load('examples/agent-tool-call.workflow.json');
    const first = doc.nodes[0]; Object.assign(first, { label: 'PromptScript', width: 92 });
    delete first.brand; delete first.sublabel; delete first.tag;
    const p = parts(deliver('workflow', doc), first.id); checkLabel(p, 'PromptScript');
    assert.equal(Number(attr(p.rect, 'width')), 92);
    assert.equal(Number(attr(p.label, 'font-size')), 11);
  });
}
test('a short fixed box fits only the decorative sigil while retaining text and bounds', () => {
  const doc = load('../test/fixtures/v1-workflow-700x400.workflow.json');
  const first = doc.nodes[0]; Object.assign(first, { label: 'PromptScript', width: 92, height: 32 });
  delete first.brand; delete first.sublabel; delete first.tag;
  const p = parts(deliver('workflow', doc), first.id); checkLabel(p, 'PromptScript');
  assert.equal(Number(attr(p.rect, 'height')), 32); assert.equal(Number(attr(p.label, 'font-size')), 11);
  assert.ok(p.icon.size > 0);
});
test('lifecycle clears its right-hand sigil and retains the step and text details', () => {
  const doc = load('examples/agent-run.lifecycle.json');
  const first = doc.states[0]; Object.assign(first, { label: 'Prompt Compiler', step: '01', sublabel: 'context', tag: 'tag', icon: 'start' });
  delete first.brand;
  const p = parts(deliver('lifecycle', doc), first.id); checkLabel(p, 'Prompt Compiler');
  for (const value of ['01', 'context', 'tag']) assert.ok(find(p.group, n => n.tagName === 'text' && text(n) === value).length);
});
test('Chinese stage titles retain every character when wrapped', () => {
  const doc = load('examples/product-analytics.dataflow.json');
  const title = '用户行为采集与事件清洗标准化处理以及后续数据分发'; doc.stages[0].label = title;
  assert.ok(find(deliver('dataflow', doc), n => n.tagName === 'text' && text(n) === `01 / ${title}`).length);
});

test('an extreme title does not wrap into the node area', () => {
  const doc = load('examples/product-analytics.dataflow.json');
  const title = 'Stream processing and enrichment '.repeat(12);
  doc.stages[0].label = title;
  const header = find(deliver('dataflow', doc), n => n.tagName === 'text' && text(n) === `01 / ${title}`)[0];
  assert.ok(header);
  assert.equal(find(header, n => n.tagName === 'tspan').length, 0,
    'keep the compatible single line when the full title cannot fit above the nodes');
});
