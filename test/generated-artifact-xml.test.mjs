import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSvgs, parseXml } from './helpers/xml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..', 'schematics');
const repoRoot = path.resolve(skillRoot, '..');
const artifactRoots = ['schematics/examples'];

function trackedHtmlArtifacts() {
  const tracked = spawnSync('git', ['ls-files', '-z', '--', ...artifactRoots], {
    cwd: repoRoot,
    encoding: 'buffer',
  });
  assert.equal(tracked.status, 0, tracked.stderr.toString());
  return tracked.stdout.toString()
    .split('\0')
    .filter((entry) => entry.endsWith('.html'))
    .sort();
}

test('artifact SVG extraction follows HTML quoting and preserves SVG document boundaries', () => {
  const extracted = extractSvgs(`
    <script>const ignored = '<svg data-node-label></svg>';</script>
    <template><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/></template>
    <iframe srcdoc='&lt;svg xmlns=&quot;http://www.w3.org/2000/svg&quot;&gt;&lt;svg viewBox=&quot;0 0 1 1&quot;/&gt;&lt;/svg&gt;'></iframe>
  `);
  assert.equal(extracted.direct.length, 1, 'template SVG is markup while script text is not');
  assert.equal(extracted.embedded.length, 1, 'srcdoc contributes one top-level SVG document');
  for (const svg of [...extracted.direct, ...extracted.embedded]) assert.doesNotThrow(() => parseXml(svg));

  const inheritedNamespace = extractSvgs(`
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <svg><use xlink:href="#icon"/></svg>
    </svg>
  `);
  assert.equal(inheritedNamespace.direct.length, 1, 'nested SVG remains inside its XML document');
  assert.doesNotThrow(() => parseXml(inheritedNamespace.direct[0]));
});

test('tracked browsable HTML embeds well-formed XML SVG', () => {
  const artifacts = trackedHtmlArtifacts();
  assert.ok(artifacts.length > 0, 'expected tracked HTML artifacts');

  for (const relative of artifacts) {
    const html = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    const extracted = extractSvgs(html);
    const svgs = [...extracted.direct, ...extracted.embedded];
    if (svgs.length === 0) continue;
    for (const [index, svg] of svgs.entries()) {
      assert.doesNotThrow(
        () => parseXml(svg),
        `${relative}: SVG ${index + 1} must be well-formed XML`,
      );
    }
  }
});
