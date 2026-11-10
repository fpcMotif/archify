import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileWorkflow, type WorkflowCompileResult } from '../schematics/packages/workflow/workflow-compiler.ts';
import type { WorkflowDocument, WorkflowSemanticChecks } from '../schematics/packages/workflow/workflow-document.ts';

type RetryWorkflow = WorkflowDocument & {
  mainPath: string[];
  semanticChecks: Required<Pick<WorkflowSemanticChecks, 'allowedRoots' | 'allowedTerminals' | 'requiredPaths'>>;
};

function failureDiagnostics(result: WorkflowCompileResult) {
  return result.ok ? undefined : result.diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function fixture(): RetryWorkflow {
  const rows: [string, string, number, number][] = [
    ['submit', 'buyer', 0, 0], ['retry', 'buyer', 3, 0],
    ['validate', 'order', 0, -50], ['pending', 'order', 1, 50], ['rejected', 'order', 3, -50],
    ['reserve', 'stock', 0, -50], ['release', 'stock', 4, 50],
    ['pay', 'payment', 1, -50], ['result', 'payment', 2, -50],
    ['failed', 'payment', 3, -50], ['deadline', 'payment', 4, 50],
    ['paid', 'confirmation', 2, 0], ['event', 'confirmation', 3, 0], ['close', 'confirmation', 4, 0],
    ['pick', 'warehouse', 3, 0], ['ship', 'warehouse', 4, 0],
  ];
  const links: [string, string, string, string?][] = [
    ['submit', 'validate', ''], ['validate', 'reserve', 'Valid'],
    ['reserve', 'pending', 'Held'], ['reserve', 'rejected', 'Empty', 'error'],
    ['pending', 'pay', ''], ['pay', 'result', ''],
    ['result', 'paid', 'Yes'], ['result', 'failed', 'No', 'error'],
    ['failed', 'retry', 'Retry', 'return'], ['retry', 'pay', 'In time', 'return'],
    ['pending', 'deadline', 'Wait', 'branch'], ['deadline', 'close', 'Yes', 'error'],
    ['paid', 'event', ''], ['event', 'pick', 'Paid', 'async'],
    ['pick', 'ship', ''], ['close', 'release', 'Release'],
  ];
  return {
    schema_version: 2, diagram_type: 'workflow',
    meta: { title: 'Retry and expiry', output: 'retry-expiry.html' },
    lanes: ['buyer', 'order', 'stock', 'payment', 'confirmation', 'warehouse'].map(id => ({ id, label: id })),
    nodes: rows.map(([id, lane, col, yOffset]) => ({ id, lane, col, yOffset, type: 'backend', label: id, width: 152, height: 60 })),
    edges: links.map(([from, to, label, role]) => ({ id: `${from}-${to}`, from, to, label, ...(role ? { role } : {}) })),
    mainPath: ['submit', 'validate', 'reserve', 'pending', 'pay', 'result', 'paid', 'event', 'pick', 'ship'],
    semanticChecks: { allowedRoots: ['submit'], allowedTerminals: ['rejected', 'release', 'ship'], requiredPaths: [{ from: 'failed', to: 'pay' }, { from: 'pending', to: 'release' }] },
  };
}

function findRepair(result: WorkflowCompileResult): unknown {
  return failureDiagnostics(result)?.map(d => field(d.evidence, 'verifiedRepair')).find(r => field(r, 'kind') === 'optional-node-placement');
}

function withoutPositions(workflow: WorkflowDocument) {
  const copy = structuredClone(workflow);
  for (const node of copy.nodes) { Reflect.deleteProperty(node, 'col'); delete node.yOffset; }
  return copy;
}

function applyRepair<T extends WorkflowDocument>(workflow: T, repair: unknown): T {
  const copy = structuredClone(workflow);
  const changes = field(repair, 'changes');
  assert.ok(Array.isArray(changes));
  for (const change of changes) {
    assert.ok(['replace', 'add'].includes(change.op));
    const match: RegExpMatchArray | null = change.path.match(/^\/nodes\/(\d+)\/(col|yOffset)$/);
    assert.ok(match, `only node placement may change: ${change.path}`);
    assert.ok(Number.isFinite(change.value));
    const key = match[2];
    assert.ok(key === 'col' || key === 'yOffset');
    copy.nodes[Number(match[1])][key] = change.value;
  }
  assert.deepEqual(withoutPositions(copy), withoutPositions(workflow));
  return copy;
}

test('failed workflow offers a complete optional placement repair without applying it', () => {
  const input = fixture(), original = structuredClone(input);
  const result = compileWorkflow({ workflow: input, qualityProfile: 'showcase' });
  assert.equal(result.ok, false);
  assert.deepEqual(input, original);
  const repair = findRepair(result);
  assert.ok(repair, JSON.stringify(result.diagnostics));
  assert.equal(field(repair, 'scope'), 'complete-workflow-compile');
  const diagnostic = result.diagnostics.find(d => field(d.evidence, 'verifiedRepair') === repair);
  assert.ok(diagnostic);
  assert.match(diagnostic.supportedFixes[0], /if node columns and row offsets are flexible/);
  assert.match(diagnostic.supportedFixes[0], /browser verification and visual review still required/);
  const repaired = applyRepair(input, repair);
  const success = compileWorkflow({ workflow: repaired, qualityProfile: 'showcase' });
  assert.equal(success.ok, true, JSON.stringify(failureDiagnostics(success)));
  assert.equal(success.receipt.nodes?.length, input.nodes.length);
  assert.equal(success.receipt.edges?.length, input.edges.length);
  assert.equal(findRepair(success), undefined);
});

test('placement patch indexes follow authored node order and do not depend on domain IDs', () => {
  const input = fixture();
  const names = new Map(input.nodes.map((n, i) => [n.id, `step-${i}`]));
  const rename = (id: string): string => {
    const name = names.get(id);
    assert.ok(name);
    return name;
  };
  input.nodes = input.nodes.map(n => ({ ...n, id: rename(n.id) })).reverse();
  input.edges = input.edges.map(e => ({ ...e, from: rename(e.from), to: rename(e.to) })).reverse();
  input.mainPath = input.mainPath.map(id => rename(id));
  input.semanticChecks.allowedRoots = input.semanticChecks.allowedRoots.map(id => rename(id));
  input.semanticChecks.allowedTerminals = input.semanticChecks.allowedTerminals.map(id => rename(id));
  input.semanticChecks.requiredPaths = input.semanticChecks.requiredPaths.map(p => ({ from: rename(p.from), to: rename(p.to) }));
  const result = compileWorkflow({ workflow: input, qualityProfile: 'showcase' });
  const repair = findRepair(result);
  assert.ok(repair, JSON.stringify(failureDiagnostics(result)));
  assert.equal(compileWorkflow({ workflow: applyRepair(input, repair), qualityProfile: 'showcase' }).ok, true);
});

test('standard acceptance and an authored canvas do not acquire placement suggestions', () => {
  const input = fixture();
  assert.equal(findRepair(compileWorkflow({ workflow: input, qualityProfile: 'standard' })), undefined);
  input.meta.viewBox = [1200, 1600];
  const original = structuredClone(input);
  assert.equal(findRepair(compileWorkflow({ workflow: input, qualityProfile: 'showcase' })), undefined);
  assert.deepEqual(input, original);
});

test('a proposed route repair that still fails text checks is not advertised as complete', () => {
  const input = fixture();
  const retry = input.nodes.find(n => n.id === 'retry');
  assert.ok(retry);
  retry.label = 'W'.repeat(30);
  const result = compileWorkflow({ workflow: input, qualityProfile: 'showcase' });
  assert.equal(result.ok, false);
  assert.equal(findRepair(result), undefined);
});
