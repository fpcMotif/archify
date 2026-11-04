import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createOwnedTempDirectory } from '../archify/renderers/shared/owned-temp-directory.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const archifyBin = path.resolve(__dirname, '../archify/bin/archify.mjs');

test('archify chart compiles Mermaid pie chart to static SVG via Pele', () => {
  const chartInput = `pie title "Market Share"
  "Alpha" : 60
  "Beta" : 40`;

  const res = spawnSync(process.execPath, [archifyBin, 'chart', chartInput], { encoding: 'utf-8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert(res.stdout.includes('<svg'), 'Output should contain an SVG root element');
  assert(res.stdout.includes('class="pele pele-pie"'), 'Output should be styled with Pele vector class');
  assert(res.stdout.includes('Alpha'), 'Output should include slice label Alpha');
});

test('archify autofix converges collided sequence diagrams in a single execution', () => {
  const tempDir = createOwnedTempDirectory('archify-test-autofix-');
  try {
    const candidatePath = path.join(tempDir.path, 'candidate.json');
    const outputPath = path.join(tempDir.path, 'output.html');

    const candidate = {
      schema_version: 1,
      diagram_type: 'sequence',
      meta: {
        title: 'Autofix Test',
        output: 'output.html',
        quality_profile: 'showcase'
      },
      participants: [
        { id: 'client', type: 'external', label: 'Client' },
        { id: 'server', type: 'backend', label: 'Server' }
      ],
      messages: [
        { id: 'm1', from: 'client', to: 'server', y: 165, label: 'Ping', variant: 'default' },
        { id: 'm2', from: 'server', to: 'client', y: 170, label: 'Pong', variant: 'return' }
      ]
    };

    fs.writeFileSync(candidatePath, JSON.stringify(candidate, null, 2), 'utf-8');

    const res = spawnSync(
      process.execPath,
      [archifyBin, 'autofix', 'sequence', 'candidate.json', 'output.html', '--json'],
      { cwd: tempDir.path, encoding: 'utf-8' }
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert(fs.existsSync(outputPath), 'Output HTML file should be created');

    const updatedCandidate = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'));
    assert(updatedCandidate.messages[1].y >= updatedCandidate.messages[0].y + 28, 'Autofix should space messages at least 28px apart');
  } finally {
    tempDir.cleanup();
  }
});
