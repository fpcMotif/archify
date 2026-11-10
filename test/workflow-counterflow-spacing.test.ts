import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileWorkflow, type WorkflowCompileResult, type WorkflowReceiptNode } from '../schematics/packages/workflow/workflow-compiler.ts';
import type { WorkflowDocument } from '../schematics/packages/workflow/workflow-document.ts';
import type { Point } from '../schematics/packages/geometry/geometry.ts';

function failureDiagnostics(result: WorkflowCompileResult) {
  return result.ok ? undefined : result.diagnostics;
}

function receiptNode(result: WorkflowCompileResult, id: string): WorkflowReceiptNode {
  const node = result.receipt.nodes?.find((item) => item.id === id);
  assert.ok(node);
  return node;
}

function routeEnd(points: Point[]): [Point, Point] {
  const end = points.at(-1), beforeEnd = points.at(-2);
  assert.ok(end && beforeEnd);
  return [beforeEnd, end];
}

function libraryApproval(): WorkflowDocument {
  return {
    schema_version: 2, diagram_type: 'workflow',
    meta: { title: 'Library approval routing', output: 'library.html', quality_profile: 'showcase' },
    lanes: [{ id: 'desk', label: 'Approval desk' }, { id: 'review', label: 'Book review' }, { id: 'delivery', label: 'Delivery' }],
    nodes: [
      { id: 'special', lane: 'desk', col: 2, type: 'backend', label: 'Special review', yOffset: 100, width: 136 },
      { id: 'regular', lane: 'desk', col: 2, type: 'backend', label: 'Regular review' },
      { id: 'queue', lane: 'desk', col: 3, type: 'backend', label: 'Lending queue', width: 132 },
      { id: 'issue', lane: 'delivery', col: 3, type: 'backend', label: 'Issue book' },
      { id: 'inspection', lane: 'review', col: 4, type: 'backend', label: 'Inspection' },
      { id: 'shelf', lane: 'delivery', col: 5, type: 'backend', label: 'Shelf record', yOffset: 100 },
      { id: 'request', lane: 'desk', col: 1, type: 'backend', label: 'Request' },
    ],
    edges: [
      { id: 'release', from: 'queue', to: 'issue', label: 'release book', fromSide: 'bottom', toSide: 'top' },
      { id: 'special-queue', from: 'special', to: 'queue', label: 'reviewed', role: 'branch' },
      { id: 'regular-queue', from: 'regular', to: 'queue' },
      { id: 'a-shelf', from: 'inspection', to: 'shelf', label: 'record checked book', fromSide: 'bottom', toSide: 'top' },
      { id: 'a-special', from: 'request', to: 'special', label: 'special review', role: 'branch' },
      { id: 'a-regular', from: 'request', to: 'regular', label: 'regular' },
    ],
  };
}

const route = (result: WorkflowCompileResult, id: string): Point[] => {
  const edge = result.receipt.edges?.find((item) => item.id === id);
  assert.ok(edge);
  return edge.points;
};
const routeLength = (points: Point[]) => points.slice(1).reduce((total, point, index) => total
  + Math.hypot(point[0] - points[index][0], point[1] - points[index][1]), 0);

function parallelWitness({ overlap = 56, gap = 3.5, sameDirection = false, split = false } = {}): WorkflowDocument {
  const track = 214 + gap;
  const low = 209 - overlap;
  const via: Point[] = sameDirection
    ? [[454, low], [track, low], [track, 209], [454, 209]]
    : [[454, 209], [track, 209],
      ...(split ? [[track, 209 - overlap / 3], [track, 209 - 2 * overlap / 3]] satisfies Point[] : []),
      [track, low], [454, low]];
  return {
    schema_version: 2, diagram_type: 'workflow',
    meta: { title: 'Parallel return controls', output: 'parallel.html', quality_profile: 'showcase', legend: { mode: 'hidden' } },
    lanes: [{ id: 'top', label: 'Top' }, { id: 'bottom', label: 'Bottom' }],
    nodes: [
      { id: 'a', lane: 'top', col: 1, type: 'backend', label: 'A' },
      { id: 'b', lane: 'bottom', col: 1, type: 'backend', label: 'B' },
      { id: 'c', lane: 'bottom', col: 3, type: 'backend', label: 'C' },
      { id: 'd', lane: 'top', col: 3, type: 'backend', label: 'D' },
    ],
    edges: [
      { id: 'z-auto', from: 'a', to: 'b', fromSide: 'bottom', toSide: 'top' },
      { id: 'a-witness', from: sameDirection ? 'd' : 'c', to: sameDirection ? 'c' : 'd',
        fromSide: sameDirection ? 'bottom' : 'top', toSide: sameDirection ? 'top' : 'bottom', via },
    ],
  };
}

function longOppositeVerticalNeighbours(left: Point[], right: Point[]) {
  const hits: { overlap: number; gap: number }[] = [];
  for (let a = 1; a < left.length; a += 1) {
    for (let b = 1; b < right.length; b += 1) {
      if (left[a][0] !== left[a - 1][0] || right[b][0] !== right[b - 1][0]) continue;
      if ((left[a][1] - left[a - 1][1]) * (right[b][1] - right[b - 1][1]) >= 0) continue;
      const overlap = Math.min(Math.max(left[a][1], left[a - 1][1]), Math.max(right[b][1], right[b - 1][1]))
        - Math.max(Math.min(left[a][1], left[a - 1][1]), Math.min(right[b][1], right[b - 1][1]));
      const gap = Math.abs(left[a][0] - right[b][0]);
      if (overlap > 24 && gap < 8) hits.push({ overlap, gap });
    }
  }
  return hits;
}

test('automatic workflow routes separate long opposite-direction neighbours while preserving authored sides', () => {
  for (const qualityProfile of ['standard', 'showcase']) {
    const workflow = libraryApproval();
    const before = JSON.stringify(workflow);
    const result = compileWorkflow({ workflow, qualityProfile });
    assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result)));
    assert.deepEqual(result.receipt.diagnostics, []);
    assert.deepEqual(longOppositeVerticalNeighbours(route(result, 'special-queue'), route(result, 'release')), []);
    assert.equal(JSON.stringify(workflow), before);
    const release = route(result, 'release');
    const source = receiptNode(result, 'queue');
    const target = receiptNode(result, 'issue');
    const [beforeEnd, end] = routeEnd(release);
    assert.equal(release[0][1], source.y + source.height);
    assert.ok(release[1][1] > release[0][1]);
    assert.equal(end[1], target.y);
    assert.ok(beforeEnd[1] < target.y);
    assert.ok(result.receipt.nodes && result.receipt.edges);
    assert.equal(result.receipt.nodes.length, workflow.nodes.length);
    assert.deepEqual(result.receipt.edges.map(({ id, from, to }) => [id, from, to]).sort(), workflow.edges.map(({ id, from, to }) => [id, from, to]).sort());
    for (const node of workflow.nodes) assert.ok(result.svg.includes(`>${node.label}</text>`), node.label);
    for (const edge of workflow.edges.filter(({ label }) => label)) assert.ok(result.svg.includes(`>${edge.label}</text>`), `${edge.label}`);
  }
});

test('counterflow route preference remains deterministic after repeated compilation and input reordering', () => {
  const workflow = libraryApproval();
  const first = compileWorkflow({ workflow });
  assert.equal(first.ok, true, JSON.stringify(failureDiagnostics(first)));
  assert.deepEqual(compileWorkflow({ workflow }), first);
  workflow.nodes.reverse();
  workflow.edges.reverse();
  assert.deepEqual(compileWorkflow({ workflow }), first);
});

test('a side-constrained automatic route can avoid the earlier branch when edge IDs reverse their order', () => {
  const workflow = libraryApproval();
  const releaseEdge = workflow.edges.find(({ id }) => id === 'release');
  assert.ok(releaseEdge);
  releaseEdge.id = 'zz-release';
  const before = JSON.stringify(workflow);
  const result = compileWorkflow({ workflow });
  assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result)));
  assert.deepEqual(longOppositeVerticalNeighbours(route(result, 'special-queue'), route(result, 'zz-release')), []);
  const release = route(result, 'zz-release');
  const source = receiptNode(result, 'queue');
  const target = receiptNode(result, 'issue');
  const [beforeEnd, end] = routeEnd(release);
  assert.equal(release[0][1], source.y + source.height);
  assert.ok(release[1][1] > release[0][1]);
  assert.equal(end[1], target.y);
  assert.ok(beforeEnd[1] < target.y);
  assert.equal(JSON.stringify(workflow), before);
});

test('same-direction, short opposite runs and the outer spacing boundary retain compact routes', () => {
  for (const options of [{ sameDirection: true }, { overlap: 24 }, { gap: 8 }]) {
    const workflow = parallelWitness(options);
    const before = JSON.stringify(workflow);
    const result = compileWorkflow({ workflow });
    assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result)));
    assert.ok(routeLength(route(result, 'z-auto')) <= 80, 'a clear 72px route should stay compact');
    assert.deepEqual(route(result, 'a-witness').slice(1, -1), workflow.edges[1].via);
    assert.equal(JSON.stringify(workflow), before);
  }
});

test('long opposite runs stay visible to routing across redundant authored waypoints', () => {
  let unsplit: Point[] | undefined;
  for (const split of [false, true]) {
    const workflow = parallelWitness({ split });
    const before = JSON.stringify(workflow);
    const result = compileWorkflow({ workflow });
    assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result)));
    assert.deepEqual(route(result, 'a-witness').slice(1, -1), workflow.edges[1].via);
    const witnessRun: Point[] = [[217.5, 209], [217.5, 153]];
    assert.deepEqual(longOppositeVerticalNeighbours(route(result, 'z-auto'), witnessRun), []);
    if (split) assert.deepEqual(route(result, 'z-auto'), unsplit);
    else unsplit = route(result, 'z-auto');
    assert.equal(JSON.stringify(workflow), before);
  }
});
