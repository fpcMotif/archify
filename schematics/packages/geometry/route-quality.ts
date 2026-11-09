import { recordDiagnostic } from '../diagnostics/diagnostics.ts';
import {
  asArray,
  isFinitePoint,
  normalizeRoutePoints,
  properSegmentIntersection,
  segmentIntersectsRect,
} from './geometry.ts';
import type { IdSet, IdentifiedRect, PathFor, Point, Rect, Relation, Segment } from './geometry.ts';

export interface RouteDetourThresholds {
  clearance: number;
  minimumDetourRatio: number;
  minimumExcessLengthPx: number;
  minimumEmptyExcursionPx: number;
  maximumObstacleCount: number;
  sharedCorridorMinimumPx: number;
}

export interface ContentBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface Excursion {
  left: number;
  top: number;
  right: number;
  bottom: number;
  maximum: number;
}

interface ControlPointClearance {
  maximum: number;
  point: Point;
}

interface HeapEntry {
  key: string;
  distance: number;
}

type GraphEdge = [string, number, string];

export interface GridRouteMetrics {
  status?: string;
  maximumGridNodes?: number;
  obstacleCount?: number;
  avoidedSegmentCount?: number;
  coordinateCount?: number;
  candidateNodeCount?: number;
  usableNodeCount?: number;
  graphEdgeCount?: number;
  visitedNodeCount?: number;
  attemptCount?: number;
}

export interface GridRouteOptions {
  start: Point;
  end: Point;
  points: Point[];
  obstacles: Iterable<IdentifiedRect>;
  fromSide: string;
  toSide: string;
  clearance: number;
  maximumObstacleCount: number;
  endpointStubPx?: number;
  maximumGridNodes?: number;
  avoidedSegments?: Iterable<Segment>;
  allowAvoidedCrossings?: boolean;
  minimumAvoidedOverlapPx?: number;
  routeSeparationPx?: number;
  minimumSegmentPx?: number;
  borderSegments?: Iterable<Segment>;
  bendPenaltyPx?: number;
  accept?: (points: Point[]) => boolean;
  metrics?: GridRouteMetrics | null;
}

export interface GridRoute {
  points: Point[];
  length: number | null;
  obstacleCount: number;
}

interface SharedCorridorOptions {
  relation: Relation;
  relations: (Relation | null | undefined)[] | null | undefined;
  pathFor: PathFor;
  points: Point[];
  contentBounds: ContentBounds | null;
  minimumOverlap: number;
}

export interface RouteDetourOptions {
  relations: (Relation | null | undefined)[] | null | undefined;
  obstacles: Iterable<IdentifiedRect>;
  contentRects?: Iterable<Rect>;
  endpointIds?: IdSet | null;
  pathFor: PathFor;
  fromSideFor?: (relation: Relation) => string | null | undefined;
  toSideFor?: (relation: Relation) => string | null | undefined;
  diagramType: string;
  relationCollection: string;
  profile?: string;
  thresholds?: Partial<RouteDetourThresholds>;
}

const DEFAULTS: Readonly<RouteDetourThresholds> = Object.freeze({
  clearance: 2,
  minimumDetourRatio: 2.5,
  minimumExcessLengthPx: 200,
  minimumEmptyExcursionPx: 96,
  maximumObstacleCount: 80,
  sharedCorridorMinimumPx: 32,
});

const OUTWARD: Readonly<Record<string, Point>> = Object.freeze({
  left: [-1, 0],
  right: [1, 0],
  top: [0, -1],
  bottom: [0, 1],
});

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function pointKey(point: Point): string {
  return `${point[0]}\u0000${point[1]}`;
}

class MinHeap {
  entries: HeapEntry[];

  constructor() {
    this.entries = [];
  }

  push(key: string, distance: number): void {
    const entry = { key, distance };
    this.entries.push(entry);
    let index = this.entries.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.entries[parent].distance <= distance) break;
      this.entries[index] = this.entries[parent];
      index = parent;
    }
    this.entries[index] = entry;
  }

  pop(): HeapEntry | null {
    if (!this.entries.length) return null;
    const first = this.entries[0];
    const last = this.entries.pop()!;
    if (!this.entries.length) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.entries.length) break;
      const child = right < this.entries.length
        && this.entries[right].distance < this.entries[left].distance ? right : left;
      if (this.entries[child].distance >= last.distance) break;
      this.entries[index] = this.entries[child];
      index = child;
    }
    this.entries[index] = last;
    return first;
  }
}

function orthogonalLength(points: Point[]): number | null {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[index + 1];
    if (x1 !== x2 && y1 !== y2) return null;
    total += Math.abs(x2 - x1) + Math.abs(y2 - y1);
  }
  return total;
}

function inferredSide(points: Point[], endpoint: 'source' | 'target'): string | null {
  if (points.length < 2) return null;
  const start = endpoint === 'source' ? points[0] : points.at(-2)!;
  const end = endpoint === 'source' ? points[1] : points.at(-1)!;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (endpoint === 'source') {
    if (dx > 0 && dy === 0) return 'right';
    if (dx < 0 && dy === 0) return 'left';
    if (dy > 0 && dx === 0) return 'bottom';
    if (dy < 0 && dx === 0) return 'top';
  } else {
    if (dx > 0 && dy === 0) return 'left';
    if (dx < 0 && dy === 0) return 'right';
    if (dy > 0 && dx === 0) return 'top';
    if (dy < 0 && dx === 0) return 'bottom';
  }
  return null;
}

function moveOutward(point: Point, side: string, distance: number): Point {
  const [dx, dy] = OUTWARD[side] || [0, 0];
  return [point[0] + dx * distance, point[1] + dy * distance];
}

function expandedRect(rect: IdentifiedRect, clearance: number): IdentifiedRect {
  return {
    id: rect.id,
    x: rect.x - clearance,
    y: rect.y - clearance,
    width: rect.width + clearance * 2,
    height: rect.height + clearance * 2,
  };
}

function boundsForRects(rects: Iterable<Rect>): ContentBounds | null {
  const usable = [...rects].filter((rect) => (
    rect && isFinitePoint(rect.x, rect.y, rect.width, rect.height)
      && rect.width >= 0 && rect.height >= 0
  ));
  if (!usable.length) return null;
  const left = Math.min(...usable.map((rect) => rect.x));
  const top = Math.min(...usable.map((rect) => rect.y));
  const right = Math.max(...usable.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...usable.map((rect) => rect.y + rect.height));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function boundsForPoints(points: Point[]): ContentBounds | null {
  if (!points.length) return null;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function outsideExcursion(routeBounds: ContentBounds | null, contentBounds: ContentBounds | null): Excursion | null {
  if (!routeBounds || !contentBounds) return null;
  const sides = {
    left: Math.max(0, contentBounds.left - routeBounds.left),
    top: Math.max(0, contentBounds.top - routeBounds.top),
    right: Math.max(0, routeBounds.right - contentBounds.right),
    bottom: Math.max(0, routeBounds.bottom - contentBounds.bottom),
  };
  return { ...sides, maximum: Math.max(...Object.values(sides)) };
}

function pointDistanceFromRect(point: Point, rect: Rect): number {
  const dx = Math.max(rect.x - point[0], 0, point[0] - (rect.x + rect.width));
  const dy = Math.max(rect.y - point[1], 0, point[1] - (rect.y + rect.height));
  return dx + dy;
}

function emptyControlPointClearance(points: Point[], contentRects: Iterable<Rect>): ControlPointClearance | null {
  const controls = points.slice(1, -1);
  const rects = [...contentRects].filter((rect) => (
    rect && isFinitePoint(rect.x, rect.y, rect.width, rect.height)
      && rect.width >= 0 && rect.height >= 0
  ));
  if (!controls.length || !rects.length) return null;
  const distances = controls.map((point) => Math.min(
    ...rects.map((rect) => pointDistanceFromRect(point, rect)),
  ));
  const maximum = Math.max(...distances);
  return { maximum, point: controls[distances.indexOf(maximum)] };
}

function pointBlocked(point: Point, obstacles: Rect[]): boolean {
  return obstacles.some((rect) => (
    point[0] >= rect.x && point[0] <= rect.x + rect.width
      && point[1] >= rect.y && point[1] <= rect.y + rect.height
  ));
}

// Prune only against the candidate segment, never the route's initial bounds:
// a later detour can still encounter any obstacle in the complete inventory.
// Keep epsilon-near bounds for the existing exact predicates to decide.
function segmentBlocked(start: Point, end: Point, obstacles: Rect[]): boolean {
  const minX = Math.min(start[0], end[0]);
  const maxX = Math.max(start[0], end[0]);
  const minY = Math.min(start[1], end[1]);
  const maxY = Math.max(start[1], end[1]);
  return obstacles.some((rect) => {
    if (maxX < Math.min(rect.x, rect.x + rect.width) - 0.0001
      || minX > Math.max(rect.x, rect.x + rect.width) + 0.0001
      || maxY < Math.min(rect.y, rect.y + rect.height) - 0.0001
      || minY > Math.max(rect.y, rect.y + rect.height) + 0.0001) return false;
    return segmentIntersectsRect({ start, end }, rect);
  });
}

function segmentConflictsWithAvoided(start: Point, end: Point, avoidedSegments: Segment[], minimumOverlapPx: number, allowCrossings: boolean): boolean {
  const minX = Math.min(start[0], end[0]);
  const maxX = Math.max(start[0], end[0]);
  const minY = Math.min(start[1], end[1]);
  const maxY = Math.max(start[1], end[1]);
  return avoidedSegments.some((segment) => {
    // A zero overlap threshold also rejects disjoint segments (0 >= 0).
    if (minimumOverlapPx > 0 && (maxX < Math.min(segment.start[0], segment.end[0]) - 0.0001
      || minX > Math.max(segment.start[0], segment.end[0]) + 0.0001
      || maxY < Math.min(segment.start[1], segment.end[1]) - 0.0001
      || minY > Math.max(segment.start[1], segment.end[1]) + 0.0001)) return false;
    return (!allowCrossings && (properSegmentIntersection(start, end, segment.start, segment.end)
      || orthogonalTouchOnAvoidedInterior(start, end, segment.start, segment.end)))
      || collinearOverlap(start, end, segment.start, segment.end) >= minimumOverlapPx;
  });
}

function orthogonalTouchOnAvoidedInterior(start: Point, end: Point, avoidedStart: Point, avoidedEnd: Point): boolean {
  const epsilon = 0.0001;
  const candidateHorizontal = Math.abs(start[1] - end[1]) <= epsilon;
  const candidateVertical = Math.abs(start[0] - end[0]) <= epsilon;
  const avoidedHorizontal = Math.abs(avoidedStart[1] - avoidedEnd[1]) <= epsilon;
  const avoidedVertical = Math.abs(avoidedStart[0] - avoidedEnd[0]) <= epsilon;
  if (candidateHorizontal && avoidedVertical) {
    const x = avoidedStart[0];
    const y = start[1];
    return x >= Math.min(start[0], end[0]) - epsilon
      && x <= Math.max(start[0], end[0]) + epsilon
      && y > Math.min(avoidedStart[1], avoidedEnd[1]) + epsilon
      && y < Math.max(avoidedStart[1], avoidedEnd[1]) - epsilon;
  }
  if (candidateVertical && avoidedHorizontal) {
    const x = start[0];
    const y = avoidedStart[1];
    return y >= Math.min(start[1], end[1]) - epsilon
      && y <= Math.max(start[1], end[1]) + epsilon
      && x > Math.min(avoidedStart[0], avoidedEnd[0]) + epsilon
      && x < Math.max(avoidedStart[0], avoidedEnd[0]) - epsilon;
  }
  return false;
}

function pointOnSegmentInterior(point: Point, start: Point, end: Point): boolean {
  const epsilon = 0.0001;
  const cross = (end[0] - start[0]) * (point[1] - start[1])
    - (end[1] - start[1]) * (point[0] - start[0]);
  if (Math.abs(cross) > epsilon) return false;
  const dot = (point[0] - start[0]) * (point[0] - end[0])
    + (point[1] - start[1]) * (point[1] - end[1]);
  return dot < -epsilon;
}

function pointOnAvoidedInterior(point: Point, avoidedSegments: Segment[]): boolean {
  return avoidedSegments.some((segment) => (
    pointOnSegmentInterior(point, segment.start, segment.end)
  ));
}

function writeGridMetrics(metrics: GridRouteMetrics | null | undefined, patch: GridRouteMetrics): void {
  if (!metrics || typeof metrics !== 'object') return;
  Object.assign(metrics, patch);
}

export function shortestOrthogonalGridRoute({
  start,
  end,
  points,
  obstacles,
  fromSide,
  toSide,
  clearance,
  maximumObstacleCount,
  endpointStubPx = clearance + 2,
  maximumGridNodes = Infinity,
  avoidedSegments = [],
  allowAvoidedCrossings = false,
  minimumAvoidedOverlapPx = 8,
  routeSeparationPx = 8,
  minimumSegmentPx = 8,
  borderSegments = [],
  bendPenaltyPx = 0,
  accept = () => true,
  metrics,
}: GridRouteOptions): GridRoute | null {
  writeGridMetrics(metrics, {
    status: 'initializing',
    maximumGridNodes,
    obstacleCount: 0,
    avoidedSegmentCount: 0,
    coordinateCount: 0,
    candidateNodeCount: 0,
    usableNodeCount: 0,
    graphEdgeCount: 0,
    visitedNodeCount: 0,
    attemptCount: 0,
  });
  if (!OUTWARD[fromSide] || !OUTWARD[toSide]) {
    writeGridMetrics(metrics, { status: 'unsupported-endpoint-side' });
    return null;
  }
  const startStub = moveOutward(start, fromSide, endpointStubPx);
  const endStub = moveOutward(end, toSide, endpointStubPx);
  // The graph may legally leave the initial endpoint bounds to find a clear
  // corridor. Keep every bounded obstacle and occupied relationship visible
  // to that search; filtering them against the initial box lets a detour walk
  // straight through geometry that only becomes relevant after it leaves the
  // box. The explicit obstacle/node budgets below keep this deterministic.
  const expanded = [...obstacles]
    .filter((rect) => rect && isFinitePoint(rect.x, rect.y, rect.width, rect.height))
    .map((rect) => expandedRect(rect, clearance));
  const relevantAvoidedSegments = [...avoidedSegments]
    .filter((segment) => segment?.start && segment?.end);
  // Frame borders may be crossed perpendicularly but never borrowed as a
  // corridor: the composition gate rejects any collinear run along them.
  const relevantBorderSegments = [...borderSegments]
    .filter((segment) => segment?.start && segment?.end);
  writeGridMetrics(metrics, {
    obstacleCount: expanded.length,
    avoidedSegmentCount: relevantAvoidedSegments.length,
  });
  if (expanded.length > maximumObstacleCount) {
    writeGridMetrics(metrics, { status: 'obstacle-budget-exceeded' });
    return null;
  }

  const xs = new Set([startStub[0], endStub[0], ...points.map(([x]) => x)]);
  const ys = new Set([startStub[1], endStub[1], ...points.map(([, y]) => y)]);
  for (const rect of expanded) {
    xs.add(rect.x - 1);
    xs.add(rect.x + rect.width + 1);
    ys.add(rect.y - 1);
    ys.add(rect.y + rect.height + 1);
  }
  for (const segment of relevantAvoidedSegments) {
    const [segmentStart, segmentEnd] = [segment.start, segment.end];
    xs.add(segmentStart[0]);
    xs.add(segmentEnd[0]);
    ys.add(segmentStart[1]);
    ys.add(segmentEnd[1]);
    if (Math.abs(segmentStart[0] - segmentEnd[0]) <= 0.0001) {
      xs.add(segmentStart[0] - routeSeparationPx);
      xs.add(segmentStart[0] + routeSeparationPx);
    }
    if (Math.abs(segmentStart[1] - segmentEnd[1]) <= 0.0001) {
      ys.add(segmentStart[1] - routeSeparationPx);
      ys.add(segmentStart[1] + routeSeparationPx);
    }
  }
  function addBorderCoordinates(distance: number): void {
    for (const segment of relevantBorderSegments) {
      if (Math.abs(segment.start[0] - segment.end[0]) <= 0.0001) {
        xs.add(segment.start[0] - distance);
        xs.add(segment.start[0] + distance);
      }
      if (Math.abs(segment.start[1] - segment.end[1]) <= 0.0001) {
        ys.add(segment.start[1] - distance);
        ys.add(segment.start[1] + distance);
      }
    }
  }
  addBorderCoordinates(routeSeparationPx);
  // Grid lines closer than a readable segment would let the search emit a
  // micro jog between two obstacle edges; keep the endpoint stubs and coalesce
  // the rest so every turn the route can take is at least one segment long.
  const coalesce = (values: number[], keep: Set<number>, fillGaps: boolean): number[] => {
    const sorted = values.sort((a, b) => a - b);
    if (!fillGaps) return sorted.filter((value, index) => (
      index === 0 || keep.has(value) || value - sorted[index - 1] >= minimumSegmentPx
    ));
    // A dense chain of discarded coordinates can erase a usable corridor.
    // Compare with the last retained line while reserving readable spacing
    // around the endpoint lines that must be kept.
    return sorted.reduce<number[]>((retained, value) => {
      if (keep.has(value) || ((!retained.length || value - retained.at(-1)! >= minimumSegmentPx)
        && [...keep].every(endpoint => Math.abs(value - endpoint) >= minimumSegmentPx))) retained.push(value);
      return retained;
    }, []);
  };
  // Keep accepted routes stable. A failed or caller-rejected search can use
  // the denser coordinate set, within the same original node budget.
  let remainingGridNodes = maximumGridNodes;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // A pinned endpoint stub may land on a frame border. Nearby candidates
    // closer than the minimum segment disappear during coalescing. Recovery
    // adds a full-segment corridor without changing the attempt or node budget.
    if (attempt > 0 && routeSeparationPx < minimumSegmentPx) addBorderCoordinates(minimumSegmentPx);
    const orderedX = coalesce([...xs], new Set([startStub[0], endStub[0]]), attempt > 0);
    const orderedY = coalesce([...ys], new Set([startStub[1], endStub[1]]), attempt > 0);
    const candidateNodeCount = orderedX.length * orderedY.length;
    writeGridMetrics(metrics, {
      coordinateCount: (metrics?.coordinateCount || 0) + orderedX.length + orderedY.length,
      candidateNodeCount: (metrics?.candidateNodeCount || 0) + candidateNodeCount,
      attemptCount: attempt + 1,
    });
    if (candidateNodeCount > remainingGridNodes) {
      writeGridMetrics(metrics, { status: 'node-budget-exceeded' });
      return null;
    }
    remainingGridNodes -= candidateNodeCount;
    const nodes: Map<string, Point> = new Map();
    for (const x of orderedX) {
      for (const y of orderedY) {
        const point: Point = [x, y];
        if (!pointBlocked(point, expanded)
            && (allowAvoidedCrossings || !pointOnAvoidedInterior(point, relevantAvoidedSegments))) {
          nodes.set(pointKey(point), point);
        }
      }
    }
    writeGridMetrics(metrics, { usableNodeCount: (metrics?.usableNodeCount || 0) + nodes.size });
    if (!nodes.has(pointKey(startStub)) || !nodes.has(pointKey(endStub))) {
      writeGridMetrics(metrics, { status: 'endpoint-blocked' });
      return null;
    }

    const adjacency: Map<string, GraphEdge[]> = new Map([...nodes.keys()].map((key): [string, GraphEdge[]] => [key, []]));
    let graphEdgeCount = 0;
    const connectLine = (line: Point[], axis: string): void => {
      for (let index = 0; index < line.length - 1; index += 1) {
        const left = line[index];
        const right = line[index + 1];
        if (segmentBlocked(left, right, expanded)) continue;
        if (segmentConflictsWithAvoided(
          left,
          right,
          relevantAvoidedSegments,
          minimumAvoidedOverlapPx,
          allowAvoidedCrossings,
        )) continue;
        if (relevantBorderSegments.some((segment) => (
          collinearOverlap(left, right, segment.start, segment.end) > 0.0001
        ))) continue;
        const distance = Math.abs(right[0] - left[0]) + Math.abs(right[1] - left[1]);
        const leftKey = pointKey(left);
        const rightKey = pointKey(right);
        adjacency.get(leftKey)!.push([rightKey, distance, axis === 'h' ? 'R' : 'D']);
        adjacency.get(rightKey)!.push([leftKey, distance, axis === 'h' ? 'L' : 'U']);
        graphEdgeCount += 1;
      }
    };
    for (const y of orderedY) {
      connectLine(orderedX.map((x) => nodes.get(pointKey([x, y]))).filter(Boolean) as Point[], 'h');
    }
    for (const x of orderedX) {
      connectLine(orderedY.map((y) => nodes.get(pointKey([x, y]))).filter(Boolean) as Point[], 'v');
    }
    writeGridMetrics(metrics, { graphEdgeCount: (metrics?.graphEdgeCount || 0) + graphEdgeCount });

    // The search state carries the incoming direction so a turn can cost extra
    // and a reversal is never taken: the pure shortest path hugs every obstacle
    // corner with a staircase of short jogs, while a bend-penalised one takes
    // the same corridor in a few long strokes. The first stub already leaves
    // the endpoint along its side and the last one arrives along the end side.
    const directionOf = ([dx, dy]: Point): string => (dx > 0 ? 'R' : dx < 0 ? 'L' : dy > 0 ? 'D' : 'U');
    const opposite: Record<string, string> = { R: 'L', L: 'R', D: 'U', U: 'D' };
    const stateKey = (key: string, direction: string): string => `${key}|${direction}`;
    const sourceAxis = directionOf(OUTWARD[fromSide]);
    const targetAxis = opposite[directionOf(OUTWARD[toSide])];
    const source = pointKey(startStub);
    const target = pointKey(endStub);
    const sourceState = stateKey(source, sourceAxis);
    const distances: Map<string, number> = new Map([[sourceState, 0]]);
    const previous: Map<string, string> = new Map();
    const queue = new MinHeap();
    queue.push(sourceState, 0);
    let visitedNodeCount = 0;
    let targetState: HeapEntry | null = null;
    while (queue.entries.length) {
      const next = queue.pop()!;
      const current = next.key;
      const currentDistance = next.distance;
      if (currentDistance !== distances.get(current)) continue;
      visitedNodeCount += 1;
      const [currentNode, currentAxis] = current.split('|');
      if (currentNode === target) {
        // The end stub is outside the graph: never reverse back onto it.
        if (currentAxis === opposite[targetAxis]) continue;
        // Arriving on the wrong axis costs one final turn onto the end stub.
        const arrival = currentDistance + (currentAxis === targetAxis ? 0 : bendPenaltyPx);
        if (targetState == null || arrival < targetState.distance) {
          targetState = { key: current, distance: arrival };
        }
        if (currentAxis === targetAxis || bendPenaltyPx === 0) break;
        continue;
      }
      if (targetState && currentDistance >= targetState.distance) break;
      for (const [neighbor, weight, axis] of adjacency.get(currentNode) || []) {
        if (axis === opposite[currentAxis]) continue;
        const candidate = currentDistance + weight + (axis === currentAxis ? 0 : bendPenaltyPx);
        const neighborState = stateKey(neighbor, axis);
        if (candidate >= (distances.get(neighborState) ?? Infinity)) continue;
        distances.set(neighborState, candidate);
        previous.set(neighborState, current);
        queue.push(neighborState, candidate);
      }
    }
    writeGridMetrics(metrics, { visitedNodeCount: (metrics?.visitedNodeCount || 0) + visitedNodeCount });
    if (!targetState) {
      writeGridMetrics(metrics, { status: 'no-route' });
      continue;
    }
    const reversed: Point[] = [];
    for (let key: string | undefined = targetState.key; key; key = previous.get(key)) {
      reversed.push(nodes.get(key.split('|')[0])!);
      if (key === sourceState) break;
    }
    if (pointKey(reversed.at(-1)!) !== source) {
      writeGridMetrics(metrics, { status: 'broken-predecessor-chain' });
      return null;
    }
    const shortestPoints = normalizeRoutePoints([start, ...reversed.reverse(), end]);
    if (!accept(shortestPoints)) {
      writeGridMetrics(metrics, { status: 'rejected' });
      continue;
    }
    writeGridMetrics(metrics, { status: 'routed' });
    return {
      points: shortestPoints,
      length: orthogonalLength(shortestPoints),
      obstacleCount: expanded.length,
    };
  }
  return null;
}

function collinearOverlap(leftStart: Point, leftEnd: Point, rightStart: Point, rightEnd: Point): number {
  if (leftStart[0] === leftEnd[0] && rightStart[0] === rightEnd[0]
      && leftStart[0] === rightStart[0]) {
    return Math.max(0, Math.min(Math.max(leftStart[1], leftEnd[1]), Math.max(rightStart[1], rightEnd[1]))
      - Math.max(Math.min(leftStart[1], leftEnd[1]), Math.min(rightStart[1], rightEnd[1])));
  }
  if (leftStart[1] === leftEnd[1] && rightStart[1] === rightEnd[1]
      && leftStart[1] === rightStart[1]) {
    return Math.max(0, Math.min(Math.max(leftStart[0], leftEnd[0]), Math.max(rightStart[0], rightEnd[0]))
      - Math.max(Math.min(leftStart[0], leftEnd[0]), Math.min(rightStart[0], rightEnd[0])));
  }
  return 0;
}

function segmentOutsideContent(start: Point, end: Point, contentBounds: ContentBounds | null): boolean {
  if (!contentBounds) return false;
  const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  return midpoint[0] < contentBounds.left || midpoint[0] > contentBounds.right
    || midpoint[1] < contentBounds.top || midpoint[1] > contentBounds.bottom;
}

function sharesOuterCorridor({ relation, relations, pathFor, points, contentBounds, minimumOverlap }: SharedCorridorOptions): boolean {
  for (const other of asArray(relations)) {
    if (!other || other === relation) continue;
    const related = relation.from === other.from || relation.from === other.to
      || relation.to === other.from || relation.to === other.to;
    if (!related) continue;
    const otherPoints = normalizeRoutePoints(pathFor(other)?.points || []);
    for (let left = 0; left < points.length - 1; left += 1) {
      if (!segmentOutsideContent(points[left], points[left + 1], contentBounds)) continue;
      for (let right = 0; right < otherPoints.length - 1; right += 1) {
        if (collinearOverlap(points[left], points[left + 1], otherPoints[right], otherPoints[right + 1]) >= minimumOverlap) {
          return true;
        }
      }
    }
  }
  return false;
}

function relationshipSubject(diagramType: string, relationCollection: string, relationIndex: number, relation: Relation): object {
  return {
    diagramType,
    collection: relationCollection,
    index: relationIndex,
    ...(relation.id ? { id: relation.id } : {}),
    from: relation.from,
    to: relation.to,
  };
}

/**
 * Reject conspicuous authored detours without penalizing routes whose length is
 * explained by opaque-node avoidance or a related shared outer corridor.
 */
export function cleanRouteDetourProblems({
  relations,
  obstacles,
  contentRects = obstacles,
  endpointIds,
  pathFor,
  fromSideFor,
  toSideFor,
  diagramType,
  relationCollection,
  profile,
  thresholds = {},
}: RouteDetourOptions): string[] {
  if (profile !== 'showcase') return [];
  const policy = { ...DEFAULTS, ...thresholds };
  const obstacleList = [...obstacles];
  const contentBounds = boundsForRects(contentRects);
  const problems: string[] = [];
  for (const [relationIndex, relation] of asArray(relations).entries()) {
    if (!relation || !endpointIds?.has(relation.from) || !endpointIds?.has(relation.to)) continue;
    if (!Array.isArray(relation.via) || relation.via.length === 0) continue;
    const points = normalizeRoutePoints(pathFor(relation)?.points || []);
    if (points.length < 3 || !points.every((point) => Array.isArray(point) && isFinitePoint(...point))) continue;
    const actualLength = orthogonalLength(points);
    if (!Number.isFinite(actualLength)) continue;
    const start = points[0];
    const end = points.at(-1)!;
    const manhattan = Math.abs(end[0] - start[0]) + Math.abs(end[1] - start[1]);
    if (actualLength! < manhattan * policy.minimumDetourRatio
        || actualLength! - manhattan < policy.minimumExcessLengthPx) continue;
    const routeBounds = boundsForPoints(points);
    const excursion = outsideExcursion(routeBounds, contentBounds);
    const emptyClearance = emptyControlPointClearance(points, obstacleList);
    if (Math.max(excursion?.maximum || 0, emptyClearance?.maximum || 0)
        < policy.minimumEmptyExcursionPx) continue;
    if (sharesOuterCorridor({
      relation,
      relations,
      pathFor,
      points,
      contentBounds,
      minimumOverlap: policy.sharedCorridorMinimumPx,
    })) continue;

    const fromSide = fromSideFor?.(relation) || inferredSide(points, 'source');
    const toSide = toSideFor?.(relation) || inferredSide(points, 'target');
    const shortest = shortestOrthogonalGridRoute({
      start,
      end,
      points,
      obstacles: obstacleList,
      fromSide: fromSide as string,
      toSide: toSide as string,
      clearance: policy.clearance,
      maximumObstacleCount: policy.maximumObstacleCount,
    });
    if (!shortest || !Number.isFinite(shortest.length) || shortest.length! <= 0) continue;
    const detourRatio = actualLength! / shortest.length!;
    const excessLength = actualLength! - shortest.length!;
    if (detourRatio < policy.minimumDetourRatio || excessLength < policy.minimumExcessLengthPx) continue;

    const relationId = relation.id ? ` id "${relation.id}"` : '';
    const message = `[composition/excessive-route-detour] ${diagramType} ${relationCollection}[${relationIndex}]${relationId} "${relation.from}" -> "${relation.to}" travels ${Math.round(actualLength!)}px, ${rounded(detourRatio)}x the ${Math.round(shortest.length!)}px shortest obstacle-clearing orthogonal route, and reaches ${Math.round(excursion!.maximum)}px beyond the content bounds — remove the distant via corridor or move it close to the connected content.`;
    const supportedFix = 'remove the distant via points and retry automatic routing, or keep the endpoint sides and move the via corridor near the connected nodes while preserving labels and direction';
    recordDiagnostic({
      code: 'composition/excessive-route-detour',
      severity: 'error',
      message,
      subject: relationshipSubject(diagramType, relationCollection, relationIndex, relation),
      evidence: {
        points,
        actualLengthPx: rounded(actualLength!),
        shortestLegalPoints: shortest.points,
        shortestLegalLengthPx: rounded(shortest.length!),
        detourRatio: rounded(detourRatio),
        excessLengthPx: rounded(excessLength),
        routeBounds,
        contentBounds,
        emptyExcursionPx: excursion,
        emptyControlPointClearancePx: emptyClearance,
        obstacleCount: shortest.obstacleCount,
        thresholds: {
          minimumDetourRatio: policy.minimumDetourRatio,
          minimumExcessLengthPx: policy.minimumExcessLengthPx,
          minimumEmptyExcursionPx: policy.minimumEmptyExcursionPx,
        },
      },
      supportedFixes: [supportedFix],
    });
    problems.push(message);
  }
  return problems;
}
