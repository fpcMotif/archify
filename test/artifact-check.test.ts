import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkArtifact } from '../schematics/scripts/check-render-output.ts';
import { checkExplainerHtml } from '../schematics/packages/explainer/check.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(repoRoot, 'schematics/scripts/check-render-output.ts');
const passing = path.join(repoRoot, 'schematics/examples/web-app-rendered.html');

function artifactFile(t: TestContext, body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schematics-artifact-check-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'diagram.html');
  fs.writeFileSync(file, body);
  return file;
}

const malformedPath = '<!doctype html><html><body><svg viewBox="0 0 400 250" data-quality-profile="showcase">'
  + '<path id="route" data-edge-id="route" data-edge-from="a" data-edge-to="b" d="M 20 20 L 100" class="a-default" marker-end="url(#arrowhead)" />'
  + '</svg></body></html>';

test('artifact check: bytes give the same receipt the script prints for that path', () => {
  const run = spawnSync(process.execPath, [checker, passing], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(checkArtifact(fs.readFileSync(passing), { file: passing }), JSON.parse(run.stdout));
});

test('artifact check: each call starts from empty state', (t) => {
  const broken = artifactFile(t, malformedPath);
  const brokenBytes = fs.readFileSync(broken);
  const passingBytes = fs.readFileSync(passing);
  const brokenAlone = checkArtifact(brokenBytes, { file: broken });
  assert.equal(brokenAlone.ok, false);
  assert.equal(brokenAlone.diagnostics?.[0]?.code, 'artifact/svg-path-malformed');

  const passingAlone = checkArtifact(passingBytes, { file: passing });
  assert.equal(passingAlone.ok, true);
  assert.deepEqual(checkArtifact(passingBytes, { file: passing }), passingAlone);
  checkArtifact(brokenBytes, { file: broken });
  assert.deepEqual(checkArtifact(passingBytes, { file: passing }), passingAlone);
  assert.deepEqual(checkArtifact(brokenBytes, { file: broken }), brokenAlone);
});

test('artifact check: explainer artifacts get the explainer receipt', () => {
  const html = '<!doctype html><html data-schematics-artifact="explainer"><body><main></main></body></html>';
  assert.deepEqual(
    checkArtifact(Buffer.from(html), { file: 'answer.html' }),
    checkExplainerHtml(html, { file: 'answer.html' }),
  );
});
