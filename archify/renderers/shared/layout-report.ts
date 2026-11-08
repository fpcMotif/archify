/** Serialize computed layout for dry-run / inspect (#9). */

import type { Point } from './geometry.ts';

export interface GridPlacement {
  row?: number;
  col?: number;
  pos?: number[];
}

export interface ComponentLayoutInput extends GridPlacement {
  id: string;
  type?: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComponentBox {
  id: string;
  type?: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  row?: number;
  col?: number;
  pos?: number[];
}

export interface EntityAttributeInput {
  name: string;
}

export interface EntityLayoutInput extends GridPlacement {
  id: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  attributes?: EntityAttributeInput[];
}

export interface EntityBox {
  id: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  attributes: string[];
  row?: number;
  col?: number;
  pos?: number[];
}

export interface BoundaryLayoutInput {
  kind?: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  wraps?: string[];
}

export interface BoundaryBox {
  kind?: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  wraps?: string[];
}

export interface ConnectionLayoutInput {
  from: string;
  to: string;
  label?: string | null;
  variant?: string | null;
  route?: string | null;
}

export interface RoutedConnection {
  points: Point[];
}

export interface ConnectionPathReport {
  from: string;
  to: string;
  label: string | null;
  variant: string;
  route: string;
  points: Point[];
  labelAt?: number[];
}

export function componentBox(c: ComponentLayoutInput): ComponentBox {
  return {
    id: c.id,
    type: c.type,
    label: c.label,
    x: Math.round(c.x),
    y: Math.round(c.y),
    width: c.width,
    height: c.height,
    ...(Number.isInteger(c.row) ? { row: c.row } : {}),
    ...(Number.isInteger(c.col) ? { col: c.col } : {}),
    ...(Array.isArray(c.pos) ? { pos: c.pos.map(Math.round) } : {}),
  };
}

export function entityBox(e: EntityLayoutInput): EntityBox {
  return {
    id: e.id,
    label: e.label,
    x: Math.round(e.x),
    y: Math.round(e.y),
    width: e.width,
    height: e.height,
    attributes: (Array.isArray(e.attributes) ? e.attributes : []).map((attribute) => attribute.name),
    ...(Number.isInteger(e.row) ? { row: e.row } : {}),
    ...(Number.isInteger(e.col) ? { col: e.col } : {}),
    ...(Array.isArray(e.pos) ? { pos: e.pos.map(Math.round) } : {}),
  };
}

export function boundaryBox(b: BoundaryLayoutInput): BoundaryBox {
  return {
    kind: b.kind,
    label: b.label,
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
    wraps: b.wraps,
  };
}

export function connectionPath(conn: ConnectionLayoutInput, routed: RoutedConnection, labelAt?: number[] | null): ConnectionPathReport {
  return {
    from: conn.from,
    to: conn.to,
    label: conn.label ?? null,
    variant: conn.variant ?? 'default',
    route: conn.route ?? 'auto',
    // These points are repair inputs: rounding a fractional port makes a
    // reused waypoint diagonal relative to the actual endpoint.
    points: routed.points.map(([x, y]) => [x, y]),
    ...(labelAt ? { labelAt: labelAt.map(Math.round) } : {}),
  };
}
