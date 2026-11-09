/** Grid placement for architecture IR (#8). Not auto-layout — fixed cell math only. */

import type { Point } from '../geometry/geometry.ts';

export interface GridOptions {
  mode: 'grid';
  origin: Point;
  cols: number;
  gapX: number;
  gapY: number;
  cellW: number;
  cellH: number;
}

export type GridLayoutInput = Partial<GridOptions> & { mode: 'grid' };

export interface GridComponentInput {
  id: string;
  pos?: Point;
  row?: number;
  col?: number;
}

export interface GridDocument {
  layout?: GridLayoutInput;
  components?: readonly GridComponentInput[];
}

export const DEFAULT_GRID: GridOptions = {
  mode: 'grid',
  origin: [40, 80],
  cols: 4,
  gapX: 30,
  gapY: 40,
  cellW: 130,
  cellH: 64,
};

function isGridIndex(value: unknown): value is number {
  return Number.isInteger(value);
}

export function gridLayout(arch: GridDocument): GridOptions | null {
  const raw = arch.layout;
  if (!raw || raw.mode !== 'grid') return null;
  return { ...DEFAULT_GRID, ...raw };
}

export function resolveComponentPos(component: GridComponentInput, grid: GridOptions | null): Point {
  if (Array.isArray(component.pos) && component.pos.length === 2) {
    return component.pos;
  }
  if (!grid) return [NaN, NaN];
  const { row, col } = component;
  if (!isGridIndex(row) || !isGridIndex(col)) {
    return [NaN, NaN];
  }
  const [ox, oy] = grid.origin;
  const stepX = grid.cellW + grid.gapX;
  const stepY = grid.cellH + grid.gapY;
  return [ox + col * stepX, oy + row * stepY];
}

export function validateGridPlacement(arch: GridDocument, grid: GridOptions | null, problems: string[]): void {
  if (!grid) return;
  if (arch.layout !== undefined && arch.layout.mode !== 'grid') {
    problems.push('layout.mode must be "grid" when layout is set (free placement omits layout entirely).');
    return;
  }
  const seen = new Map<string, string>();
  for (const c of arch.components ?? []) {
    const hasPos = Array.isArray(c.pos) && c.pos.length === 2;
    const { row, col } = c;
    if (hasPos) continue; // pos wins; row/col are optional hints only
    if (!isGridIndex(row) || !isGridIndex(col)) {
      problems.push(`Component "${c.id}" needs pos [x,y] or grid row/col when layout.mode is "grid".`);
      continue;
    }
    if (row < 0 || col < 0) {
      problems.push(`Component "${c.id}" row/col must be non-negative integers.`);
      continue;
    }
    if (col >= grid.cols) {
      problems.push(`Component "${c.id}" col ${col} exceeds layout.cols ${grid.cols} (valid: 0..${grid.cols - 1}).`);
    }
    const key = `${row},${col}`;
    if (seen.has(key)) {
      problems.push(`Components "${seen.get(key)}" and "${c.id}" share grid cell row ${row} col ${col}.`);
    } else {
      seen.set(key, c.id);
    }
  }
}
