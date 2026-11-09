import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createOwnedTempDirectory } from '../schematics/packages/output/owned-temp-directory.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schematicsBin = path.resolve(__dirname, '../schematics/bin/schematics.mjs');

test('schematics chart compiles Mermaid pie chart to static SVG via Pele', () => {
  const chartInput = `pie title "Market Share"
  "Alpha" : 60
  "Beta" : 40`;

  const res = spawnSync(process.execPath, [schematicsBin, 'chart', chartInput], { encoding: 'utf-8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert(res.stdout.includes('<svg'), 'Output should contain an SVG root element');
  assert(res.stdout.includes('class="pele pele-pie"'), 'Output should be styled with Pele vector class');
  assert(res.stdout.includes('Alpha'), 'Output should include slice label Alpha');
});

test('schematics autofix converges collided sequence diagrams in a single execution', () => {
  const tempDir = createOwnedTempDirectory('schematics-test-autofix-');
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
      [schematicsBin, 'autofix', 'sequence', 'candidate.json', 'output.html', '--json'],
      { cwd: tempDir.path, encoding: 'utf-8' }
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert(fs.existsSync(outputPath), 'Output HTML file should be created');
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.passes[0].applied.map((entry) => entry.code), ['sequence/message-spacing']);

    const updatedCandidate = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'));
    assert(updatedCandidate.messages[1].y >= updatedCandidate.messages[0].y + 28, 'Autofix should space messages at least 28px apart');
  } finally {
    tempDir.cleanup();
  }
});

test('schematics autofix leaves a choice for the agent and keeps the candidate unchanged', () => {
  const tempDir = createOwnedTempDirectory('schematics-test-autofix-choice-');
  try {
    const candidatePath = path.join(tempDir.path, 'candidate.json');
    const candidate = {
      schema_version: 1,
      diagram_type: 'sequence',
      meta: { title: 'Autofix Choice', output: 'output.html', quality_profile: 'showcase' },
      participants: [
        { id: 'client', type: 'external', label: 'Client' },
        { id: 'server', type: 'backend', label: 'Server' },
      ],
      messages: [{ id: 'm1', from: 'client', to: 'srv', y: 165, label: 'Ping', variant: 'default' }],
    };
    const authored = `${JSON.stringify(candidate, null, 2)}\n`;
    fs.writeFileSync(candidatePath, authored, 'utf-8');

    const res = spawnSync(
      process.execPath,
      [schematicsBin, 'autofix', 'sequence', 'candidate.json', 'output.html', '--json'],
      { cwd: tempDir.path, encoding: 'utf-8' },
    );
    assert.equal(res.status, 1, res.stderr || res.stdout);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(report.passes[0].applied, []);
    assert.ok(report.passes[0].skipped.some((entry) => entry.code === 'sequence/unknown-endpoint' && /choice/.test(entry.reason)));
    assert.equal(fs.readFileSync(candidatePath, 'utf-8'), authored);
  } finally {
    tempDir.cleanup();
  }
});
