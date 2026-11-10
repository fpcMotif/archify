import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileWorkflow } from '../schematics/packages/workflow/workflow-compiler.ts';
import { rectsOverlap, segmentRectClearance, type Point, type Rect } from '../schematics/packages/geometry/geometry.ts';
import type { WorkflowCompileResult } from '../schematics/packages/workflow/workflow-compiler.ts';
import type { WorkflowDocument } from '../schematics/packages/workflow/workflow-document.ts';

function failureDiagnostics(result: WorkflowCompileResult) {
  return result.ok ? undefined : result.diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fieldAt(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

function rectFrom(value: unknown): Rect {
  assert.ok(isRecord(value));
  const { x, y, width, height } = value;
  assert.ok(typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number');
  return { x, y, width, height };
}

function pointFrom(value: unknown): Point {
  assert.ok(Array.isArray(value) && value.length === 2);
  const [x, y] = value;
  assert.ok(typeof x === 'number' && typeof y === 'number');
  return [x, y];
}

function fixture(kind: string, offset?: number): WorkflowDocument {
  return {
    schema_version: 2, diagram_type: 'workflow',
    meta: { title: 'Measured label collision', output: 'fixture.html', legend: { mode: 'hidden' } },
    lanes: [{ id: 'top', label: 'Top' }, { id: 'bottom', label: 'Bottom' }],
    nodes: [
      { id: 'a', lane: 'top', col: 0, type: 'backend', label: 'A' },
      { id: 'b', lane: 'top', col: 2, type: 'backend', label: 'B' },
      { id: 'c', lane: 'bottom', col: 0, type: 'backend', label: 'C' },
      { id: 'd', lane: 'bottom', col: 2, type: 'backend', label: 'D' },
    ],
    edges: [
      { ...(kind === 'label-route' ? {} : { id: 'a-placed', label: 'Placed', labelDy: offset ?? (kind === 'label-label' ? 124 : 138) }), from: 'a', to: 'b', route: 'straight' },
      { id: 'z-candidate', from: 'c', to: 'd', route: 'straight', label: 'Candidate', ...(kind === 'label-route' ? { labelDy: offset ?? -110 } : {}) },
    ],
  };
}

for (const kind of ['label-label', 'route-label', 'label-route']) {
  for (const qualityProfile of ['standard', 'showcase']) {
    test(`${qualityProfile} placed-label diagnostics expose the actual ${kind} conflict`, () => {
      const document = fixture(kind);
      // Reverse authorship to verify evidence pointers survive canonical routing order.
      document.edges.reverse();
      const result = compileWorkflow({ workflow: document, qualityProfile });
      assert.equal(result.ok, false);
      const diagnostic = result.diagnostics.find(({ code }) => code === 'workflow/route-preset-conflict');
      assert.ok(diagnostic);
      const evidence = diagnostic.evidence;
      assert.equal(fieldAt(evidence, 'invariant'), 'placed edge-label clearance');
      assert.equal(fieldAt(evidence, 'conflictType'), kind);
      assert.deepEqual(fieldAt(evidence, 'candidateEdge'), { edge: 'z-candidate', from: 'c', to: 'd', path: '/edges/0' });
      assert.deepEqual(fieldAt(evidence, 'otherEdge'), { edge: kind === 'label-route' ? null : 'a-placed', from: 'a', to: 'b', path: '/edges/1' });
      assert.equal(fieldAt(evidence, 'candidateLabel', 'label'), 'Candidate');
      assert.deepEqual(fieldAt(evidence, 'candidateLabel', 'rect'), { x: 187.4, y: kind === 'label-route' ? 113 : 223, width: 53.199999999999996, height: 14 });
      if (kind === 'label-label') {
        assert.equal(fieldAt(evidence, 'otherLabel', 'label'), 'Placed');
        const margin = fieldAt(evidence, 'rectangleMarginPx');
        assert.equal(margin, -2);
        assert.equal(fieldAt(evidence, 'overlapPx', 'y'), 14);
        assert.ok(rectsOverlap(rectFrom(fieldAt(evidence, 'candidateLabel', 'rect')), rectFrom(fieldAt(evidence, 'otherLabel', 'rect')), margin));
        assert.equal(fieldAt(evidence, 'segment'), undefined);
        assert.equal(fieldAt(evidence, 'measuredClearancePx'), undefined);
      } else {
        assert.equal(fieldAt(evidence, 'segment', 'edge'), kind === 'route-label' ? 'candidate' : 'other');
        assert.equal(fieldAt(evidence, 'segment', 'index'), 0);
        assert.deepEqual(fieldAt(evidence, 'segment', 'from'), [140, kind === 'route-label' ? 243 : 119]);
        assert.deepEqual(fieldAt(evidence, 'segment', 'to'), [288, kind === 'route-label' ? 243 : 119]);
        const rect = rectFrom(kind === 'route-label' ? fieldAt(evidence, 'otherLabel', 'rect') : fieldAt(evidence, 'candidateLabel', 'rect'));
        const segment = { start: pointFrom(fieldAt(evidence, 'segment', 'from')), end: pointFrom(fieldAt(evidence, 'segment', 'to')) };
        assert.equal(fieldAt(evidence, 'measuredClearancePx'), segmentRectClearance(segment, rect));
        assert.equal(fieldAt(evidence, 'measuredClearancePx'), 0);
        assert.equal(fieldAt(evidence, 'requiredClearancePx'), 4);
        if (kind === 'label-route') assert.equal(fieldAt(evidence, 'otherLabel'), undefined, 'an unlabeled obstacle route must not acquire a fabricated label');
      }
      for (const fix of diagnostic.supportedFixes) {
        const repaired = structuredClone(document);
        const preset = fix.match(/verified preset "([^"]+)"/)?.[1];
        if (preset) repaired.edges[0].route = preset;
        else delete repaired.edges[0].route;
        assert.equal(compileWorkflow({ workflow: repaired, qualityProfile }).ok, true, fix);
      }
    });
  }
}

test('placed-label acceptance retains the 2px overlap tolerance and 4px route clearance boundary', () => {
  for (const qualityProfile of ['standard', 'showcase']) {
    for (const [kind, offset] of [['label-label', 112], ['route-label', 148], ['label-route', -122]] as const) {
      const result = compileWorkflow({ workflow: fixture(kind, offset), qualityProfile });
      assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result)));
      assert.match(result.svg, /Candidate/);
    }
  }
});
