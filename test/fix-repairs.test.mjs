import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyRepair } from '../schematics/renderers/shared/fixes.ts';

const skillRoot = fileURLToPath(new URL('../schematics/', import.meta.url));
const cli = path.join(skillRoot, 'bin/schematics.mjs');

function validate(type, candidate, directory) {
  const input = path.join(directory, `${type}.json`);
  fs.writeFileSync(input, JSON.stringify(candidate, null, 2));
  const result = spawnSync(process.execPath, [cli, 'validate', type, input, '--json'], { encoding: 'utf8' });
  return JSON.parse(result.stdout).diagnostics || [];
}

function firstRepair(edits) {
  return edits.flatMap((edit) => (edit.op === 'choose' ? edit.options[0] : [edit]));
}

const cases = [
  { type: 'sequence', example: 'cache-miss-request.sequence.json', code: 'sequence/message-spacing', op: 'set', mutate: (d) => { d.messages[3].y = d.messages[2].y + 6; } },
  { type: 'sequence', example: 'cache-miss-request.sequence.json', code: 'sequence/unknown-endpoint', op: 'choose', mutate: (d) => { d.messages[0].to = 'dbx'; } },
  { type: 'lifecycle', example: 'agent-run.lifecycle.json', code: 'lifecycle/unknown-endpoint', op: 'choose', mutate: (d) => { d.transitions[0].to = 'nope'; } },
  { type: 'workflow', example: 'agent-tool-call.workflow.json', code: 'workflow/unknown-edge-endpoint', op: 'choose', mutate: (d) => { d.edges[0].to = 'nope'; } },
  { type: 'dataflow', example: 'product-analytics.dataflow.json', code: 'dataflow/unknown-endpoint', op: 'choose', mutate: (d) => { d.flows[0].to = 'nope'; } },
  { type: 'architecture', example: 'web-app.architecture.json', code: 'architecture/unknown-endpoint', op: 'choose', mutate: (d) => { d.connections[0].to = 'nope'; } },
];

for (const { type, example, code, op, mutate } of cases) {
  test(`fix repairs: applying the ${code} edits clears it in the renderer`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schematics-fix-repairs-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const candidate = JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples', example), 'utf8'));
    mutate(candidate);
    const found = validate(type, candidate, directory).find((entry) => entry.code === code);
    assert.ok(found, `expected ${code}`);
    assert.equal(found.edits?.[0]?.op, op, JSON.stringify(found));
    const repaired = applyRepair(candidate, firstRepair(found.edits));
    assert.equal(repaired.ok, true, repaired.reason);
    const after = validate(type, repaired.candidate, directory);
    assert.equal(after.some((entry) => entry.code === code), false, JSON.stringify(after.map((entry) => entry.code)));
  });
}
