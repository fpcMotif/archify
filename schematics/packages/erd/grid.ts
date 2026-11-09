/** Banded grid placement for the ER IR. Not auto-layout: column widths and row
 *  band heights are measured from the boxes the author declares, so the same
 *  spec always produces the same coordinates. */

import type { Point } from '../geometry/geometry.ts';

export interface ErGrid {
  mode: 'grid';
  origin: Point;
  gapX: number;
  gapY: number;
  entityW: number;
  headerH: number;
  rowH: number;
}

export type BandGrid = Pick<ErGrid, 'origin' | 'gapX' | 'gapY' | 'entityW'>;

export interface ErGridLayoutInput {
  mode?: string;
  origin?: Point;
  gapX?: number;
  gapY?: number;
  entityW?: number;
  headerH?: number;
  rowH?: number;
}

export interface GridEntityInput {
  id?: string;
  row?: number;
  col?: number;
  pos?: number[];
  width?: number;
}

export interface BandedEntity extends GridEntityInput {
  height: number;
}

export interface ErGridBands {
  columnX: Map<number, number>;
  rowY: Map<number, number>;
  widths: Map<number, number>;
  heights: Map<number, number>;
  totalWidth: number;
  totalHeight: number;
}

export const DEFAULT_ER_GRID: ErGrid = {
  mode: 'grid',
  // The top origin leaves room for a domain caption above the first band, and
  // the left origin starts the first column inside the page margin so the
  // canvas is not edge-to-edge. Row bands are taller than the generic rhythm
  // because a table row is text a reader has to scan, not a node label.
  origin: [32, 40],
  gapX: 56,
  gapY: 44,
  // Wide enough for a long field name plus its SQL type at the legibility
  // sizes below (a 20-character name and a numeric(12,2) type).
  entityW: 240,
  // Header and row bands are sized for the field type legibility the reader
  // asked for: an 11-unit field name and a 10.5-unit type sit on a 20-unit
  // row, and the table name leads them on a 30-unit header.
  headerH: 30,
  rowH: 20,
};

const isInteger = (value: unknown): value is number => Number.isInteger(value);
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);

function isGridLayout(raw: ErGridLayoutInput): raw is ErGridLayoutInput & { mode: 'grid' } {
  return raw.mode === 'grid';
}

export function erGridLayout(er: { layout?: ErGridLayoutInput | null; entities?: readonly (GridEntityInput | null | undefined)[] | null }): ErGrid | null {
  const raw = er.layout;
  // Grid cells without a layout block mean the default grid, not absolute
  // coordinates that were never supplied.
  if (!raw) {
    const gridPlaced = (er.entities || []).some((entity) => Number.isFinite(entity?.row) && Number.isFinite(entity?.col));
    return gridPlaced ? { ...DEFAULT_ER_GRID } : null;
  }
  if (!isGridLayout(raw)) return null;
  return { ...DEFAULT_ER_GRID, ...raw };
}

// An entity may omit `width` and inherit the grid's default. Both the layout and
// the placement validator must resolve that the same way: reading `entity.width`
// directly turned the documented default into NaN and reported a placement
// failure for a box the schema accepts.
export function resolvedEntityWidth(entity: GridEntityInput | null | undefined, grid: BandGrid | null | undefined): number {
  return isFiniteNumber(entity?.width) ? entity.width : (grid?.entityW ?? DEFAULT_ER_GRID.entityW);
}

// One header band plus one band per declared column. An entity with no columns
// still needs a readable body, so the minimum is a single row.
export function entityHeight(entity: { attributes?: readonly unknown[] | null }, grid: ErGrid): number {
  const rows = Math.max(1, Array.isArray(entity.attributes) ? entity.attributes.length : 0);
  return grid.headerH + rows * grid.rowH + 6;
}

// Every raw column index owns the widest box placed in it and every raw row
// index owns the tallest, so boxes in one band share a baseline without anyone
// measuring by hand. Indices with no box still contribute their gap, which is
// how an author asks for a routing channel between two bands. A box on a half
// column (a class grid's `col: 1.5`) is centred between two columns: it sizes
// its row but neither column.
const gridColumn = (col: unknown): col is number => typeof col === 'number' && Number.isInteger(col * 2) && col >= 0;
// `columnGaps` raises the gap after a column to a measured floor (see the
// renderer's relationship-label demand); the authored or default gapX stays
// the minimum everywhere, so an absent map reproduces the plain grid.
export function bandedLayout(entities: readonly BandedEntity[], grid: BandGrid, { columnGaps = null }: { columnGaps?: ReadonlyMap<number, number> | null } = {}): ErGridBands {
  const widths = new Map<number, number>();
  const heights = new Map<number, number>();
  let maxCol = -1;
  for (const entity of entities) {
    if (!isInteger(entity.row) || !gridColumn(entity.col)) continue;
    maxCol = Math.max(maxCol, Math.ceil(entity.col));
    if (Number.isInteger(entity.col)) widths.set(entity.col, Math.max(widths.get(entity.col) || 0, resolvedEntityWidth(entity, grid)));
    heights.set(entity.row, Math.max(heights.get(entity.row) || 0, entity.height));
  }

  const columnX = new Map<number, number>();
  const rowY = new Map<number, number>();
  let x = grid.origin[0];
  for (let col = 0; col <= maxCol; col += 1) {
    columnX.set(col, x);
    x += (widths.get(col) || 0) + Math.max(grid.gapX, columnGaps?.get(col) || 0);
  }
  // A half-column box may be wider than its empty neighbouring bands. Keep
  // every grid box inside the left margin without changing integer-only grids.
  let leftInset = 0;
  for (const entity of entities) {
    if (!isInteger(entity.row) || !gridColumn(entity.col) || Number.isInteger(entity.col)) continue;
    const centre = (col: number) => requiredBand(columnX, col) + (widths.get(col) || 0) / 2;
    const midpoint = (centre(Math.floor(entity.col)) + centre(Math.ceil(entity.col))) / 2;
    leftInset = Math.max(leftInset, grid.origin[0] - midpoint + resolvedEntityWidth(entity, grid) / 2);
  }
  if (leftInset > 0) {
    for (const [col, column] of columnX) columnX.set(col, column + leftInset);
    x += leftInset;
  }
  let y = grid.origin[1];
  const maxRow = Math.max(-1, ...heights.keys());
  for (let row = 0; row <= maxRow; row += 1) {
    rowY.set(row, y);
    y += (heights.get(row) || 0) + grid.gapY;
  }

  return { columnX, rowY, widths, heights, totalWidth: x, totalHeight: y };
}

function requiredBand(bands: ReadonlyMap<number, number>, index: number): number {
  const value = bands.get(index);
  if (value === undefined) throw new Error(`Grid has no band ${index}.`);
  return value;
}

export function resolveEntityPos(entity: GridEntityInput, grid: BandGrid | null | undefined, bands: ErGridBands | null | undefined): Point {
  if (Array.isArray(entity.pos) && entity.pos.length === 2) return [entity.pos[0], entity.pos[1]];
  if (!grid || !bands) return [NaN, NaN];
  if (!isInteger(entity.row) || !gridColumn(entity.col)) return [NaN, NaN];
  const width = resolvedEntityWidth(entity, grid);
  const rowY = bands.rowY.get(entity.row);
  if (!Number.isInteger(entity.col)) {
    const [left, right] = [Math.floor(entity.col), Math.ceil(entity.col)];
    const leftX = bands.columnX.get(left);
    const rightX = bands.columnX.get(right);
    if (!isFiniteNumber(leftX) || !isFiniteNumber(rightX) || !isFiniteNumber(rowY)) return [NaN, NaN];
    const centre = (column: number, col: number) => column + (bands.widths.get(col) || 0) / 2;
    return [(centre(leftX, left) + centre(rightX, right)) / 2 - width / 2, rowY];
  }
  const columnX = bands.columnX.get(entity.col);
  if (!isFiniteNumber(columnX) || !isFiniteNumber(rowY)) return [NaN, NaN];
  // Centre each box in its column so the gaps on both sides stay equal; the
  // router reads those gaps as corridors.
  const columnWidth = bands.widths.get(entity.col) || width;
  return [columnX + (columnWidth - width) / 2, rowY];
}

export function validateErGridPlacement(er: { entities?: readonly GridEntityInput[] | null }, grid: ErGrid | null | undefined, bands: ErGridBands | null | undefined, problems: string[]): void {
  const seen = new Map<string, string | undefined>();
  for (const entity of er.entities ?? []) {
    const hasPos = Array.isArray(entity.pos) && entity.pos.length === 2;
    if (!hasPos && !grid) {
      problems.push(`Entity "${entity.id}" needs pos [x,y] or a grid layout with row/col.`);
      continue;
    }
    if (hasPos) continue;
    if (!isInteger(entity.row) || !isInteger(entity.col)) {
      problems.push(`Entity "${entity.id}" needs pos [x,y] or grid row/col when layout.mode is "grid".`);
      continue;
    }
    if (entity.row < 0 || entity.col < 0) {
      problems.push(`Entity "${entity.id}" row/col must be non-negative integers.`);
      continue;
    }
    const key = `${entity.row},${entity.col}`;
    if (seen.has(key)) {
      problems.push(`Entities "${seen.get(key)}" and "${entity.id}" share grid cell row ${entity.row} col ${entity.col}.`);
    } else {
      seen.set(key, entity.id);
    }
    const [x, y] = resolveEntityPos(entity, grid, bands);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      problems.push(`Entity "${entity.id}" could not be placed from row ${entity.row} col ${entity.col}.`);
    }
  }
}
