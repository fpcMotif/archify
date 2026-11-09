import { throwDiagnosticError } from './diagnostics.ts';
import { rectsOverlap, segmentIntersectsRect } from './geometry.ts';
import type { Point, Rect } from './geometry.ts';
import { esc, textUnits } from './utils.ts';
import { translateMessage } from './i18n.ts';

const DEFAULT_FONT_SIZE = 8;
const DEFAULT_ITEM_GAP = 14;
const DEFAULT_LINE_GAP = 22;
const DEFAULT_SWATCH_GAP = 8;
const TEXT_ADVANCE_EM = 0.62;
const INTERACTIVE_BADGE_ALLOWANCE = 21;

export interface LegendSegmentObstacle {
  kind?: string;
  start: Point;
  end: Point;
}

export interface LegendRectObstacle extends Rect {
  kind?: string;
  start?: undefined;
  end?: undefined;
}

export type LegendObstacle = LegendSegmentObstacle | LegendRectObstacle;

export interface RelationshipLegendObstacleOptions<R> {
  pointsFor?: (relation: R, index: number) => unknown;
  labelRectFor?: (relation: R, index: number) => Rect | null | undefined;
}

export interface LegendEntry {
  kind: string;
  label: string;
  interactive?: boolean;
  present?: boolean;
  swatchWidth?: number;
  swatchGap?: number;
  trailingWidth?: number;
  [key: string]: unknown;
}

export interface ResolvedLegendEntry extends LegendEntry {
  present: boolean;
  interactive: boolean;
}

export interface LegendEntryOverride {
  visible?: boolean;
  label?: string;
}

export interface LegendConfig {
  mode?: string;
  entries?: Record<string, LegendEntryOverride>;
}

export interface MeasuredLegendEntry extends LegendEntry {
  width: number;
}

export interface PositionedLegendEntry extends MeasuredLegendEntry {
  x: number;
  baseline: number;
  row: number;
}

export interface LegendFootprintOptions {
  width: number;
  fontSize?: number;
  itemGap?: number;
  lineGap?: number;
  swatchGap?: number;
}

export interface LegendFootprint {
  measured: MeasuredLegendEntry[];
  rows: MeasuredLegendEntry[][];
  rowCount: number;
  minWidth: number;
  extraHeight: number;
}

export interface LegendLayoutOptions extends LegendFootprintOptions {
  x: number;
  baselineY: number;
  minTitleY?: number;
  obstacles?: LegendObstacle[];
  unfit?: 'error' | 'hide';
  diagramType?: string;
}

export interface MeasuredLegend {
  entries: PositionedLegendEntry[];
  rowCount: number;
  titleY: number | null;
  fontSize?: number;
}

export interface RenderLegendOptions {
  entries: LegendEntry[];
  layout: LegendLayoutOptions;
  renderSwatch: (entry: PositionedLegendEntry) => string;
  locale?: string;
  labelClass?: string;
  labelWeight?: number;
}

interface LegendRect extends Rect {
  kind: string;
}

export function relationshipLegendObstacles<R>(relations: readonly R[] | null | undefined, { pointsFor, labelRectFor }: RelationshipLegendObstacleOptions<R> = {}): LegendObstacle[] {
  const obstacles: LegendObstacle[] = [];
  for (const [index, relation] of (Array.isArray(relations) ? relations as readonly R[] : []).entries()) {
    const points = typeof pointsFor === 'function' ? pointsFor(relation, index) : [];
    const finitePoints = (Array.isArray(points) ? points : []).filter((point: unknown): point is Point => (
      Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    ));
    for (let pointIndex = 0; pointIndex < finitePoints.length - 1; pointIndex += 1) {
      obstacles.push({
        kind: 'relationship-segment',
        start: finitePoints[pointIndex],
        end: finitePoints[pointIndex + 1],
      });
    }
    const labelRect = typeof labelRectFor === 'function' ? labelRectFor(relation, index) : null;
    if (labelRect && [labelRect.x, labelRect.y, labelRect.width, labelRect.height].every(Number.isFinite)) {
      obstacles.push({ kind: 'relationship-label', ...labelRect });
    }
  }
  return obstacles;
}

export function resolveLegend(config: LegendConfig | null | undefined, catalog: LegendEntry[], presentKinds: Iterable<string> | null | undefined): ResolvedLegendEntry[] {
  const mode = config?.mode || 'auto';
  if (mode === 'hidden') return [];
  const present = presentKinds instanceof Set ? presentKinds : new Set(presentKinds || []);
  const overrides = config?.entries || {};

  return catalog.flatMap((catalogEntry) => {
    const override: LegendEntryOverride = overrides[catalogEntry.kind] || {};
    const selectedByMode = mode === 'all' || present.has(catalogEntry.kind);
    const visible = override.visible === true || (selectedByMode && override.visible !== false);
    if (!visible) return [];
    return [{
      ...catalogEntry,
      label: override.label || catalogEntry.label,
      present: present.has(catalogEntry.kind),
      interactive: catalogEntry.interactive !== false && present.has(catalogEntry.kind),
    }];
  });
}

// Labels render slightly larger than the layout font size; measure the
// rendered size so a long label cannot run into the next entry.
function renderedLegendFontSize(fontSize: number): number {
  return fontSize < 8 ? fontSize + 0.5 : fontSize + 2;
}

function measuredEntryWidth(entry: LegendEntry, fontSize: number, swatchGap: number): number {
  const swatchWidth = entry.swatchWidth ?? 14;
  return Math.ceil(
    swatchWidth
    + swatchGap
    + textUnits(entry.label) * renderedLegendFontSize(fontSize) * TEXT_ADVANCE_EM
    + (entry.interactive ? INTERACTIVE_BADGE_ALLOWANCE : 0)
    + (entry.trailingWidth ?? 0),
  );
}

// One pure footprint calculation owns both auto-viewBox sizing and final SVG
// placement. Callers must not maintain a second approximation of legend width
// or row count; that would make generated geometry disagree with validation.
export function legendFootprint(entries: LegendEntry[], {
  width,
  fontSize = DEFAULT_FONT_SIZE,
  itemGap = DEFAULT_ITEM_GAP,
  lineGap = DEFAULT_LINE_GAP,
  swatchGap = DEFAULT_SWATCH_GAP,
}: LegendFootprintOptions = {} as LegendFootprintOptions): LegendFootprint {
  if (!entries.length) {
    return { measured: [], rows: [], rowCount: 0, minWidth: 0, extraHeight: 0 };
  }
  const measured: MeasuredLegendEntry[] = entries.map((entry) => ({
    ...entry,
    width: measuredEntryWidth(entry, fontSize, entry.swatchGap ?? swatchGap),
  }));
  const rows: MeasuredLegendEntry[][] = [[]];
  let cursor = 0;
  for (const entry of measured) {
    const row = rows.at(-1) as MeasuredLegendEntry[];
    const required = (row.length ? itemGap : 0) + entry.width;
    if (row.length && cursor + required > width) {
      rows.push([entry]);
      cursor = entry.width;
    } else {
      row.push(entry);
      cursor += required;
    }
  }
  return {
    measured,
    rows,
    rowCount: rows.length,
    minWidth: measured.reduce((width, entry) => Math.max(width, entry.width), 0),
    extraHeight: (rows.length - 1) * lineGap,
  };
}

export function measureLegend(entries: LegendEntry[], {
  x,
  baselineY,
  width,
  fontSize = DEFAULT_FONT_SIZE,
  itemGap = DEFAULT_ITEM_GAP,
  lineGap = DEFAULT_LINE_GAP,
  swatchGap = DEFAULT_SWATCH_GAP,
  minTitleY = 0,
  obstacles = [],
  unfit = 'error',
  diagramType = 'diagram',
}: LegendLayoutOptions = {} as LegendLayoutOptions): MeasuredLegend | null {
  if (!entries.length) return { entries: [], rowCount: 0, titleY: null };
  const footprint = legendFootprint(entries, { width, fontSize, itemGap, lineGap, swatchGap });
  const tooWide = footprint.measured.find((entry) => entry.width > width);
  if (tooWide) {
    if (unfit === 'hide') return null;
    const message = `[legend/label-too-wide] ${diagramType} legend label for "${tooWide.kind}" needs ${tooWide.width}px but only ${width}px is available.`;
    throwDiagnosticError(message, [{
      code: 'legend/label-too-wide',
      severity: 'error',
      message,
      subject: { diagramType, path: `/meta/legend/entries/${tooWide.kind}/label` },
      evidence: { kind: tooWide.kind, measuredWidthPx: tooWide.width, availableWidthPx: width },
      supportedFixes: ['shorten the legend label or use a wider viewBox'],
    }]);
  }

  const titleY = baselineY - footprint.extraHeight - 20;
  const legendTopY = titleY - 10;
  if (legendTopY < minTitleY) {
    if (unfit === 'hide') return null;
    const message = `[legend/vertical-overflow] ${diagramType} legend needs ${footprint.rowCount} rows, which would start at y=${legendTopY} above the available legend band at y=${minTitleY}.`;
    throwDiagnosticError(message, [{
      code: 'legend/vertical-overflow',
      severity: 'error',
      message,
      subject: { diagramType, path: '/meta/legend' },
      evidence: { rowCount: footprint.rowCount, requiredTopY: legendTopY, availableTopY: minTitleY },
      supportedFixes: ['shorten legend labels, hide nonessential entries, or use a wider viewBox'],
    }]);
  }

  const positioned: PositionedLegendEntry[] = [];
  footprint.rows.forEach((row, rowIndex) => {
    let entryX = x;
    const baseline = baselineY - (footprint.rowCount - rowIndex - 1) * lineGap;
    for (const entry of row) {
      positioned.push({ ...entry, x: entryX, baseline, row: rowIndex });
      entryX += entry.width + itemGap;
    }
  });

  const legendRects: LegendRect[] = [
    { kind: 'title', x, y: legendTopY, width: 48, height: 14 },
    ...positioned.map((entry) => ({
      kind: entry.kind,
      x: entry.x,
      y: entry.baseline - 10,
      width: entry.width,
      height: 14,
    })),
  ];
  const collision = legendRects.find((legendRect) => obstacles.some((obstacle) => (
    Array.isArray(obstacle.start) && Array.isArray(obstacle.end)
      ? segmentIntersectsRect({ start: obstacle.start, end: obstacle.end }, legendRect)
      : rectsOverlap(obstacle as Rect, legendRect)
  )));
  if (collision) {
    if (unfit === 'hide') return null;
    const message = `[legend/content-overlap] ${diagramType} legend entry "${collision.kind}" overlaps authored relationship geometry.`;
    throwDiagnosticError(message, [{
      code: 'legend/content-overlap',
      severity: 'error',
      message,
      subject: { diagramType, path: '/meta/legend' },
      evidence: { legendKind: collision.kind, legendRect: collision },
      supportedFixes: ['shorten or hide legend entries, use a wider viewBox, or move the authored relationship route/label out of the legend band'],
    }]);
  }

  return {
    entries: positioned,
    rowCount: footprint.rowCount,
    titleY,
    fontSize,
  };
}

// `labelClass`/`labelWeight` let a renderer state that its legend labels are
// the same ink and weight as the value they describe; both default to the
// shared presentation, so callers that pass nothing keep their exact bytes.
export function renderLegend({ entries, layout, renderSwatch, locale, labelClass = 't-muted', labelWeight = 500 }: RenderLegendOptions): string {
  if (!entries.length) return '';
  const measured = measureLegend(entries, layout);
  if (!measured) return '';
  const hasInteractiveEntries = measured.entries.some((entry) => entry.interactive);
  const renderedFontSize = renderedLegendFontSize(measured.fontSize as number);
  const rootAttributes = hasInteractiveEntries ? ' data-legend="" data-legend-bridge=""' : ' data-legend=""';
  const parts = [
    `        <g${rootAttributes}>`,
    `          <text x="${layout.x}" y="${measured.titleY}" class="t-primary" font-size="12" font-weight="650">${esc(translateMessage(locale, 'legend.title'))}</text>`,
  ];

  for (const entry of measured.entries) {
    const interactive = entry.interactive
      ? ` data-legend-kind="${esc(entry.kind)}" data-legend-label="${esc(entry.label)}"`
      : '';
    parts.push(`          <g data-legend-semantic-kind="${esc(entry.kind)}"${interactive} data-legend-x="${entry.x}" data-legend-baseline="${entry.baseline}" data-legend-width="${entry.width}">`);
    parts.push(`            ${renderSwatch(entry)}`);
    parts.push(`            <text x="${entry.x + (entry.swatchWidth ?? 14) + (entry.swatchGap ?? DEFAULT_SWATCH_GAP)}" y="${entry.baseline}" class="${labelClass}" font-size="${renderedFontSize}" font-weight="${labelWeight}">${esc(entry.label)}</text>`);
    parts.push('          </g>');
  }
  parts.push('        </g>');
  return parts.join('\n');
}
