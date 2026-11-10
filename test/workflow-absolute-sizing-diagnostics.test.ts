import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileWorkflow, type WorkflowCompileResult, type WorkflowDiagnostic } from '../schematics/packages/workflow/workflow-compiler.ts';
import type { WorkflowDocument } from '../schematics/packages/workflow/workflow-document.ts';

interface SizingEvidence {
  affectedNodes: { node: string; path: string; currentWidthPx: number; automaticWidthPx: number }[];
  absoluteConstraints: { path: string }[];
}

function failureDiagnostics(result: WorkflowCompileResult) {
  return result.ok ? undefined : result.diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sizingEvidence(diagnostic: WorkflowDiagnostic): SizingEvidence {
  const { evidence } = diagnostic;
  assert.ok(isRecord(evidence));
  const { affectedNodes, absoluteConstraints } = evidence;
  assert.ok(Array.isArray(affectedNodes) && Array.isArray(absoluteConstraints));
  return { affectedNodes, absoluteConstraints };
}

function subscriptionWorkflow(): WorkflowDocument {
  return {
    schema_version: 2,
    diagram_type: 'workflow',
    meta: { title: 'Subscription setup', output: 'subscription.html', quality_profile: 'showcase' },
    lanes: [{ id: 'main', label: 'Subscription' }],
    nodes: [
      { id: 'save', lane: 'main', col: 1, type: 'database', label: 'Save' },
      { id: 'prepare', lane: 'main', col: 0, type: 'backend', label: 'Prepare subscription' },
    ],
    edges: [{ id: 'write', from: 'prepare', to: 'save' }],
  };
}

test('an absolute-route failure also reports omitted widths that stopped fitting', () => {
  for (const pin of [{ via: [[999, 33]] }, { label: 'write', labelAt: [0, 0] }]) {
    const workflow = subscriptionWorkflow();
    Object.assign(workflow.edges[0], pin);
    const before = JSON.stringify(workflow);
    const result = compileWorkflow({ workflow });
    assert.equal(result.ok, false);
    assert.equal(Reflect.get(result, 'svg'), undefined);
    assert.equal(result.diagnostics[0].code, 'workflow/explicit-pin-conflict');
    const sizing = result.diagnostics.find(({ code }) => code === 'workflow/absolute-geometry-sizing');
    assert.ok(sizing, 'the pin failure must expose the collateral text-fit problem in the same response');
    assert.equal(sizing.severity, 'warning');
    assert.deepEqual(sizing.supportedFixes, [], 'intrinsic widths are not a verified full-diagram fix');
    const evidence = sizingEvidence(sizing);
    assert.equal(evidence.affectedNodes.length, 1);
    const [node] = evidence.affectedNodes;
    assert.equal(node.node, 'prepare');
    assert.equal(node.path, '/nodes/1/width', 'name the authored index, not canonical column order');
    assert.equal(node.currentWidthPx, 92);
    assert.ok(node.automaticWidthPx > node.currentWidthPx);
    assert.equal(evidence.absoluteConstraints[0].path,`/edges/0/${pin.via ? 'via' : 'labelAt'}`);
    assert.equal(JSON.stringify(workflow), before);

    // Resolving only the intrinsic width must leave the route error in place.
    workflow.nodes[1].width = node.automaticWidthPx;
    const widthOnly = compileWorkflow({ workflow });
    assert.equal(widthOnly.ok, false);
    assert.ok(widthOnly.diagnostics.some(({ code }) => code === 'workflow/explicit-pin-conflict'));
    assert.ok(widthOnly.diagnostics.every(({ code }) => code !== sizing.code));
  }
});

test('sizing evidence distinguishes an authored canvas and preserves unrelated explicit widths', () => {
  const workflow = subscriptionWorkflow();
  workflow.meta.viewBox = [1000, 500];
  workflow.nodes[0].width = 100;
  workflow.edges[0].via = [[999, 33]];
  const result = compileWorkflow({ workflow });
  assert.equal(result.ok, false);
  const sizing = result.diagnostics.find(({ code }) => code === 'workflow/absolute-geometry-sizing');
  assert.ok(sizing);
  const evidence = sizingEvidence(sizing);
  assert.deepEqual(evidence.absoluteConstraints.map(({ path }) => path), ['/meta/viewBox', '/edges/0/via']);
  assert.deepEqual(evidence.affectedNodes.map(({ node }) => node), ['prepare']);
  assert.equal(workflow.nodes[0].width, 100);
});

test('short labels, explicit widths and schema v1 do not acquire automatic-sizing warnings', () => {
  for (const edit of [
    (w: WorkflowDocument) => { w.nodes[1].label = 'Prepare'; },
    (w: WorkflowDocument) => { w.nodes[1].width = 160; },
    (w: WorkflowDocument) => { w.schema_version = 1; },
  ]) {
    const workflow = subscriptionWorkflow();
    workflow.edges[0].via = [[999, 33]];
    edit(workflow);
    const result = compileWorkflow({ workflow });
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.every(({ code }) => code !== 'workflow/absolute-geometry-sizing'));
  }
});

test('successful automatic and valid absolute plans remain deterministic and preserve input', () => {
  for (const pinned of [false, true]) {
    const workflow = subscriptionWorkflow();
    if (pinned) {
      workflow.nodes[1].width = 160;
      workflow.meta.viewBox = [1000, 500];
    }
    const before = JSON.stringify(workflow);
    const result = compileWorkflow({ workflow });
    assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result)));
    assert.deepEqual(result, compileWorkflow({ workflow }), 'successful compilation is deterministic');
    assert.equal(JSON.stringify(workflow), before);
    assert.match(result.svg, />Prepare subscription<\/text>/);
    assert.equal(result.receipt.edges?.length, 1);
  }
});
