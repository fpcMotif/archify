import type { WorkflowDocument, WorkflowEdge } from './workflow-document.ts';

const TARGET_SCHEMA_VERSION = 2;

export interface ChangedCoordinate {
  path: string;
  from: number;
  to: number;
}

export interface MappedWorkflowCandidate {
  document: WorkflowDocument;
  changedCoordinates: ChangedCoordinate[];
}

// Planning removes absolute route assertions, but must keep the same rank
// policy as the document whose coordinates will be mapped into that plan.
// An authored canvas likewise keeps its established plan: draft-only optional
// corridor growth must not consume space that a valid fixed canvas lacks.
const absoluteGeometryPolicy = Symbol('workflow absolute geometry policy');
export function preservesWorkflowAbsoluteGeometry(workflow: WorkflowDocument): boolean {
  const policy = workflow[absoluteGeometryPolicy];
  return typeof policy === 'boolean' ? policy : (Array.isArray(workflow.meta?.viewBox) || (workflow.edges || []).some((edge) => (
    Array.isArray(edge.via) || Array.isArray(edge.labelAt)
    || edge.channelX !== undefined || edge.channelY !== undefined
  )));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Return the authored workflow as a schema-v2 document without its capacity
 * override. The compiler can use this projection to discover the intrinsic v2
 * rank plan before deciding whether an explicit viewBox needs to grow.
 */
export function intrinsicWorkflow(workflow: WorkflowDocument): WorkflowDocument {
  const intrinsic = clone(workflow);
  intrinsic.schema_version = TARGET_SCHEMA_VERSION;
  intrinsic[absoluteGeometryPolicy] = preservesWorkflowAbsoluteGeometry(workflow);
  intrinsic.meta = { ...intrinsic.meta };
  delete intrinsic.meta.viewBox;
  return intrinsic;
}

/**
 * Return a schema-v2 planning projection that removes authored route geometry
 * which may only become valid after its legacy X coordinates are remapped.
 * Rank-affecting automatic and straight relationships remain in the projection.
 */
export function planningWorkflow(workflow: WorkflowDocument): WorkflowDocument {
  const planned = intrinsicWorkflow(workflow);
  planned.edges = planned.edges.flatMap((edge) => {
    const hasRoutedGeometry = Array.isArray(edge.via)
      || (edge.route && !['auto', 'straight'].includes(edge.route))
      || edge.channelX !== undefined
      || edge.channelY !== undefined;
    if (hasRoutedGeometry) return [];

    const automatic: Partial<WorkflowEdge> = {};
    for (const property of ['id', 'from', 'to', 'variant', 'role', 'width'] as const) {
      if (edge[property] !== undefined) Object.assign(automatic, { [property]: edge[property] });
    }
    if (edge.route === 'straight') automatic.route = 'straight';
    if (edge.labelAt === undefined && edge.label !== undefined) automatic.label = edge.label;
    return [{ ...automatic, from: edge.from, to: edge.to }];
  });

  // Full-topology contracts cannot be checked against a layout-only subgraph.
  // The source and final mapped candidate retain and validate these contracts.
  if (planned.edges.length !== workflow.edges.length) delete planned.semanticChecks;

  const mainPath = planned.mainPath;
  if (Array.isArray(mainPath)) {
    const projectedPairs = new Set(planned.edges.map((edge) => `${edge.from}\u0000${edge.to}`));
    const projectionBreaksMainPath = mainPath.some((from, index) => (
      index < mainPath.length - 1
      && !projectedPairs.has(`${from}\u0000${mainPath[index + 1]}`)
    ));
    if (projectionBreaksMainPath) delete planned.mainPath;
  }

  return planned;
}

export class WorkflowRankMappingError extends TypeError {
  name = 'WorkflowRankMappingError';
}

function mappedNumber(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Build a deterministic piecewise-linear mapping between corresponding legacy
 * and readable rank centers. Coordinates outside the rank span are extrapolated
 * using the nearest segment so explicitly authored outside corridors retain
 * their relative offset.
 */
export function createHorizontalRankMapper(oldColumns: readonly number[], newColumns: readonly number[]): (x: number) => number {
  if (
    !Array.isArray(oldColumns)
    || !Array.isArray(newColumns)
    || oldColumns.length !== newColumns.length
    || oldColumns.length < 2
    || !oldColumns.every(Number.isFinite)
    || !newColumns.every(Number.isFinite)
  ) {
    throw new WorkflowRankMappingError('Horizontal rank mapping requires matching finite column arrays.');
  }
  for (let index = 1; index < oldColumns.length; index += 1) {
    if (oldColumns[index] <= oldColumns[index - 1] || newColumns[index] <= newColumns[index - 1]) {
      throw new WorkflowRankMappingError('Horizontal rank mapping requires strictly increasing columns.');
    }
  }

  return (x) => {
    if (!Number.isFinite(x)) throw new WorkflowRankMappingError('Horizontal rank mapping requires a finite x coordinate.');
    let segment = oldColumns.length - 2;
    if (x <= oldColumns[0]) {
      segment = 0;
    } else {
      for (let index = 0; index < oldColumns.length - 1; index += 1) {
        if (x <= oldColumns[index + 1]) {
          segment = index;
          break;
        }
      }
    }
    const oldSpan = oldColumns[segment + 1] - oldColumns[segment];
    const newSpan = newColumns[segment + 1] - newColumns[segment];
    const ratio = (x - oldColumns[segment]) / oldSpan;
    return mappedNumber(newColumns[segment] + ratio * newSpan);
  };
}

/**
 * Apply one horizontal coordinate mapping to every schema-v1 absolute X pin.
 * The caller owns the supplied workflow; this function reports an audit trail
 * for each changed coordinate in stable document order.
 */
export function mapExplicitCoordinates(workflow: WorkflowDocument, mapX: (x: number) => number): ChangedCoordinate[] {
  const changedCoordinates: ChangedCoordinate[] = [];
  const record = (path: string, from: number, assign: (to: number) => void) => {
    const to = mapX(from);
    assign(to);
    if (to !== from) changedCoordinates.push({ path, from, to });
  };

  for (const [edgeIndex, edge] of workflow.edges.entries()) {
    if (Array.isArray(edge.via)) {
      for (const [pointIndex, point] of edge.via.entries()) {
        if (Array.isArray(point) && Number.isFinite(point[0])) {
          record(`/edges/${edgeIndex}/via/${pointIndex}/0`, point[0], (to) => { point[0] = to; });
        }
      }
    }
    const labelAt = edge.labelAt;
    if (Array.isArray(labelAt) && Number.isFinite(labelAt[0])) {
      record(`/edges/${edgeIndex}/labelAt/0`, labelAt[0], (to) => { labelAt[0] = to; });
    }
    const channelX = edge.channelX;
    if (typeof channelX === 'number' && Number.isFinite(channelX)) {
      record(`/edges/${edgeIndex}/channelX`, channelX, (to) => { edge.channelX = to; });
    }
  }
  return changedCoordinates;
}

/**
 * Construct an independently owned schema-v2 candidate with all authored
 * absolute X pins mapped to the readable rank plan.
 */
export function createMappedWorkflowCandidate(workflow: WorkflowDocument, oldColumns: readonly number[], newColumns: readonly number[]): MappedWorkflowCandidate {
  const document = clone(workflow);
  document.schema_version = TARGET_SCHEMA_VERSION;
  const mapX = createHorizontalRankMapper(oldColumns, newColumns);
  const changedCoordinates = mapExplicitCoordinates(document, mapX);
  return { document, changedCoordinates };
}
