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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schematics-presentation-'));

const CASES = {
  architecture: 'web-app.architecture.json',
  workflow: 'agent-tool-call.workflow.json',
  sequence: 'cache-miss-request.sequence.json',
  dataflow: 'product-analytics.dataflow.json',
  lifecycle: 'agent-run.lifecycle.json',
};

function render(mode: string, example: string) {
  const output = path.join(tmp, `${mode}.html`);
  execFileSync(process.execPath, [
    rendererEntry(skillRoot, mode),
    path.join(skillRoot, 'examples', example),
    output,
  ]);
  return fs.readFileSync(output, 'utf8');
}

function svg(html: string) {
  return html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0] || '';
}

test('all typed renderers ship the same presentation stage contract', () => {
  for (const [mode, example] of Object.entries(CASES)) {
    const html = render(mode, example);
    assert.match(html, /id="btn-present"[^>]+aria-label="Enter presentation stage"[^>]+aria-pressed="false"/, mode);
    assert.doesNotMatch(html.match(/<html[^>]*>/)?.[0] || '', /data-present=/, mode);
    assert.doesNotMatch(svg(html), /data-present|btn-present|Presentation Stage/, mode);
  }
});

process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
