import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compileWorkflow, type WorkflowCompileResult, type WorkflowReceiptNode } from '../schematics/packages/workflow/workflow-compiler.ts';
import type { WorkflowDocument } from '../schematics/packages/workflow/workflow-document.ts';
import type { Point } from '../schematics/packages/geometry/geometry.ts';

function failureDiagnostics(result: WorkflowCompileResult) {
  return result.ok ? undefined : result.diagnostics;
}

const fixture = new URL('./fixtures/workflow-first-draft/automatic-port-slot.workflow.json', import.meta.url);

test('automatic branches use a clear port slot without reversing over an incoming line', () => {
  // The unconnected nodes and spare lane reserve the same columns and gutters
  // as surrounding work. Both branches must fit beside an incoming arrow;
  // shifting only their corners used to leave a reverse shared segment.
  const workflow: WorkflowDocument = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const original = structuredClone(workflow);
  const result = compileWorkflow({ workflow, qualityProfile: 'showcase' });
  assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result)));
  assert.deepEqual(workflow, original);
  assert.deepEqual(result.receipt.diagnostics, []);
  const { nodes, edges } = result.receipt;
  assert.ok(nodes && edges);
  assert.equal(nodes.length, workflow.nodes.length);
  assert.equal(edges.length, workflow.edges.length);
  for (const node of workflow.nodes) {
    const placed: WorkflowReceiptNode | undefined = nodes.find(item => item.id === node.id);
    assert.ok(placed);
    assert.equal(placed.width, node.width);
    assert.ok(result.svg.includes(node.label));
  }
  const incoming = edges.find(edge => edge.id === 'prepare-spawn');
  assert.ok(incoming);
  const branches = edges.filter(edge => edge.from === 'spawn');
  // Where ports share a node side, keep the arrow's 3.5-stroke half-width
  // clear of each outgoing stroke. Do not prescribe the selected side or slot.
  for (const branch of branches) {
    const tip: Point | undefined = incoming.points.at(-1), start: Point | undefined = branch.points[0];
    assert.ok(tip && start);
    if (Math.abs(tip[0] - start[0]) < 0.0001) {
      assert.ok(Math.abs(tip[1] - start[1]) >= 4 * 1.4 - 0.0001);
    }
  }
  const reordered = structuredClone(workflow);
  reordered.nodes.reverse();
  reordered.edges.reverse();
  assert.deepEqual(compileWorkflow({ workflow: reordered, qualityProfile: 'showcase' }), result);
});
