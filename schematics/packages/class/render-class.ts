import { esc, renderDefinitions, textUnits, type InfoCard } from '../svg/utils.ts';
import {
  animateAttr,
  focusEdgeAttrs,
  focusNodeAttrs,
  focusNodeTitle,
  loadDiagram,
  svgAccessibleText,
  svgRootAttrs,
  writeDiagram,
} from '../svg/cli.ts';
import { throwDiagnosticProblems } from '../diagnostics/diagnostics.ts';
import {
  legendFootprint,
  measureLegend,
  relationshipLegendObstacles,
  resolveLegend,
  renderLegend as renderResolvedLegend,
  type LegendConfig,
  type LegendEntry,
  type LegendLayoutOptions,
  type LegendObstacle,
  type PositionedLegendEntry,
} from '../svg/legend.ts';
import { nodeTextFit } from '../svg/text-fit.ts';
import { translateMessage as i18nText } from '../i18n/i18n.ts';
import { bandedLayout, resolveEntityPos } from '../erd/grid.ts';
import {
  asArray,
  cleanAmbiguousCorridorProblems,
  cleanCrossingProblems,
  cleanEndpointSideProblems,
  cleanFlowProblems,
  cleanLabelRouteClearanceProblems,
  cleanRouteRhythmProblems,
  collectAmbiguousCorridors,
  legacyDefaultFromSide,
  legacyDefaultToSide,
  properSegmentIntersection,
  rectsOverlap,
  roundedPath,
  routePointsValue,
  segmentIntersectsRect,
  suggestComponentSeparation,
  suggestLabelObstacleFix,
  type Point,
  type Rect,
  type Relation,
} from '../geometry/geometry.ts';
import { createRouter } from '../architecture/routing.ts';
import { placeAutomaticLabels } from '../svg/automatic-labels.ts';
import { connectionPath as relationshipPath, type ConnectionPathReport } from '../diagnostics/layout-report.ts';
import type { DiagnosticInput } from '../diagnostics/diagnostics.ts';

export type ClassKind = 'class' | 'abstract' | 'interface' | 'enum' | 'record';
export type ClassVisibility = 'public' | 'protected' | 'package' | 'private';
export type ClassRelationshipKind = 'dependency' | 'association' | 'inheritance' | 'realization' | 'composition' | 'aggregation';

export interface ClassMember {
  name: string;
  visibility?: ClassVisibility;
  static?: boolean;
}

export interface ClassAttribute extends ClassMember {
  type?: string;
}

export interface ClassMethod extends ClassMember {
  parameters?: string;
  returns?: string;
  abstract?: boolean;
}

export interface ClassType {
  id: string;
  label: string;
  kind: ClassKind;
  sublabel?: string;
  row?: number;
  col?: number;
  pos?: Point;
  width?: number;
  attributes?: ClassAttribute[];
  methods?: ClassMethod[];
  sources?: readonly unknown[];
}

export interface ClassRelationship extends Relation {
  id?: string;
  from: string;
  to: string;
  kind: ClassRelationshipKind;
  label?: string;
  fromSide?: string;
  toSide?: string;
  route?: 'auto' | 'straight' | 'orthogonal-h' | 'orthogonal-v';
  via?: Point[];
  labelAt?: Point;
  labelDx?: number;
  labelDy?: number;
  labelSegment?: number;
}

export interface ClassMeta {
  title: string;
  subtitle?: string;
  locale?: string;
  translations?: Record<string, unknown>;
  output?: string;
  animation?: unknown;
  visual_preset?: string;
  quality_profile?: string;
  repository?: unknown;
  views?: unknown;
  legend?: LegendConfig;
  viewBox?: [number, number];
}

export interface ClassDiagram {
  schema_version: 1;
  diagram_type: 'class';
  meta: ClassMeta;
  layout?: {
    mode: 'grid';
    origin?: Point;
    gapX?: number;
    gapY?: number;
    typeW?: number;
    typeMaxW?: number;
  };
  types: ClassType[];
  relationships?: ClassRelationship[];
  cards?: InfoCard[];
}

export interface ClassLayoutReport {
  diagram_type: 'class';
  viewBox: [number, number];
  types: { id: string; label: string; kind: ClassKind; x: number; y: number; width: number; height: number; row?: number; col?: number }[];
  relationships: (ConnectionPathReport & { kind: ClassRelationshipKind })[];
}

export interface ClassCompilation {
  readonly layout: ClassLayoutReport;
  readonly svg: string;
}

type AnyMember = ClassAttribute & ClassMethod;

interface MemberRow {
  member: AnyMember;
  text: string;
}

interface MemberLine {
  text: string;
  indent: number;
}

interface Compartment {
  kind: 'attributes' | 'methods';
  rows: MemberRow[];
}

interface WrappedRow extends MemberRow {
  lines: MemberLine[];
}

interface WrappedCompartment {
  kind: Compartment['kind'];
  rows: WrappedRow[];
}

interface MeasuredType extends ClassType {
  width: number;
  height: number;
}

interface PlacedType extends MeasuredType {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

interface Notation {
  dashed: boolean;
  start?: string;
  end?: string;
}

interface Glyph {
  width: number;
  height: number;
  refX: number;
  refY: number;
  body: string;
  orient?: string;
}

interface RoutedPath {
  d: string;
  points: Point[];
}

interface BusRoute {
  relation: ClassRelationship;
  points: Point[];
}

interface ClassLabel extends Rect {
  relation: ClassRelationship;
  relationIndex: number;
  label: string;
  lx: number;
  ly: number;
}

type RouterOptions = NonNullable<Parameters<typeof createRouter>[2]> & { preferReadableRoutes?: boolean; distinctAutomaticPorts?: boolean };
type Router = ReturnType<typeof createRouter>;

const isInteger = (value: unknown): value is number => Number.isInteger(value);
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const isHalfStep = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value * 2);

function required<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Class layout has no entry for ${JSON.stringify(key)}.`);
  return value;
}

function hasLabel(relationship: ClassRelationship): relationship is ClassRelationship & { label: string } {
  return Boolean(relationship.label);
}

function routeEnds(route: BusRoute): ['from' | 'to', Point][] {
  return [['from', route.points[0]], ['to', route.points[route.points.length - 1]]];
}

export function compileClass({ class: cd }: { class: ClassDiagram }): ClassCompilation {
  const locale = cd.meta.locale;

  // The grid is always on: a type without `pos` is placed by its row/col cell.
  // Gaps are wider than the ERD's because a relationship here carries a marker
  // at one end and usually a label, and both need a corridor to sit in.
  const grid: { origin: Point; gapX: number; gapY: number; typeW: number; typeMaxW: number } = {
    origin: [32, 40],
    gapX: 128,
    gapY: 84,
    typeW: 180,
    typeMaxW: 300,
    ...(cd.layout || {}),
  };

  const layout = {
    margin: 24,
    legendH: 34,
    padX: 12,
    headerH: 44,
    headerPlainH: 34,
    nameFont: 13.5,
    stereotypeFont: 9.5,
    memberFont: 11,
    rowH: 20,
    compartmentPad: 5,
    minRelationshipLength: 28,
  };

  // The kind owns the box's colour family and its header keyword. A plain class
  // carries no keyword, which is the UML default; every other kind states it, so
  // an interface can never be read as a class that merely has no fields.
  const KIND_TONE: Record<string, string> = {
    class: 'backend',
    abstract: 'backend',
    interface: 'frontend',
    enum: 'messagebus',
    record: 'database',
  };
  const STEREOTYPE: Partial<Record<string, string>> = {
    abstract: '«abstract»',
    interface: '«interface»',
    enum: '«enumeration»',
    record: '«record»',
  };

  const VISIBILITY_GLYPH: Record<ClassVisibility, string> = { public: '+', protected: '#', package: '~', private: '-' };

  function visibilityPrefix(member: ClassMember): string {
    return member.visibility ? `${VISIBILITY_GLYPH[member.visibility]} ` : '';
  }

  function attributeText(attribute: ClassAttribute): string {
    return `${visibilityPrefix(attribute)}${attribute.name}${attribute.type ? `: ${attribute.type}` : ''}`;
  }

  function methodText(method: ClassMethod): string {
    return `${visibilityPrefix(method)}${method.name}(${method.parameters ?? ''})${method.returns ? `: ${method.returns}` : ''}`;
  }

  // Member rows are set in a monospace face, whose ASCII advance is the shared
  // 0.6em estimate; wide glyphs count as two units, so the measurement never
  // under-reserves space and a member is never clipped by its own box.
  const MEMBER_ADVANCE = layout.memberFont * nodeTextFit.widthFactor;
  const CONTINUATION_INDENT = 2;
  // The visibility chip is wider than the two-character `+ ` prefix the member
  // text is measured with; every box reserves the difference.
  const VIS_CHIP = 14;
  const VIS_GAP = 6;
  const VIS_EXTRA = Math.ceil(VIS_CHIP + VIS_GAP - 2 * MEMBER_ADVANCE);

  function nameWidth(type: ClassType): number {
    // Bold display text runs wider than the regular estimate.
    return textUnits(type.label) * layout.nameFont * nodeTextFit.widthFactor * 1.08;
  }

  function memberRows(type: ClassType): Compartment[] {
    const rows: Compartment[] = [
      { kind: 'attributes', rows: asArray(type.attributes).map((attribute) => ({ member: attribute, text: attributeText(attribute) })) },
      { kind: 'methods', rows: asArray(type.methods).map((method) => ({ member: method, text: methodText(method) })) },
    ];
    return rows.filter((compartment) => compartment.rows.length);
  }

  // A member longer than its box wraps instead of being cut: breaks fall after
  // an opening parenthesis or a parameter comma, or before the return type, and
  // continuation lines are indented so they read as one signature. A method
  // that wraps is set the way a formatter sets it: the open parenthesis ends the
  // first line, parameters hang one step deeper, and `): Return` closes it, so
  // every wrapped signature in a diagram has the same shape. A single token
  // longer than a whole line is split by character, never dropped.
  const PARAMETER_INDENT = 4;

  function fillLines(pieces: string[], limit: number, firstIndent: number, indent: number): MemberLine[] {
    const lines: MemberLine[] = [];
    let current = '';
    const room = () => limit - (lines.length ? indent : firstIndent);
    const push = (text: string) => lines.push({ text, indent: lines.length ? indent : firstIndent });
    for (const piece of pieces) {
      if (textUnits(current + piece) <= room()) {
        current += piece;
        continue;
      }
      if (current) push(current.trimEnd());
      current = piece.trimStart();
      while (textUnits(current) > room()) {
        const chars = Array.from(current);
        let cut = 0;
        for (let units = 0; cut < chars.length && units + textUnits(chars[cut]) <= room(); cut += 1) units += textUnits(chars[cut]);
        push(chars.slice(0, Math.max(1, cut)).join(''));
        current = chars.slice(Math.max(1, cut)).join('');
      }
    }
    if (current) push(current.trimEnd());
    return lines;
  }

  function wrapMember(text: string, availablePx: number): MemberLine[] {
    const limit = Math.max(8, Math.floor(availablePx / MEMBER_ADVANCE));
    if (textUnits(text) <= limit) return [{ text, indent: 0 }];
    const lines = fillLines(text.split(/(?<=\(|, )|(?=\): )/), limit, 0, CONTINUATION_INDENT);
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open === -1 || close < open) return lines;
    const head = text.slice(0, open + 1);
    const parameters = text.slice(open + 1, close).split(/(?<=, )/);
    const tail = text.slice(close);
    return [
      ...fillLines([head], limit, 0, CONTINUATION_INDENT),
      ...fillLines(parameters, limit, PARAMETER_INDENT, PARAMETER_INDENT),
      ...fillLines([tail], limit, CONTINUATION_INDENT, CONTINUATION_INDENT),
    ];
  }

  function headerHeight(type: ClassType): number {
    return STEREOTYPE[type.kind] ? layout.headerH : layout.headerPlainH;
  }

  // Header badge (a lettered kind marker) reserves room on the left of the name.
  const BADGE_SIZE = 16;
  const BADGE_PORCH = BADGE_SIZE + 8;

  function headerWidth(type: ClassType): number {
    const stereotype = STEREOTYPE[type.kind];
    return Math.ceil(layout.padX * 2 + BADGE_PORCH * 2 + Math.max(
      nameWidth(type),
      stereotype ? textUnits(stereotype) * layout.stereotypeFont * nodeTextFit.widthFactor : 0,
    ));
  }

  // An authored width is authoritative. An omitted one grows to the widest
  // member up to `layout.typeMaxW`; past that, members wrap. The title never
  // wraps, so a box is always at least as wide as its header needs.
  function resolvedWidth(type: ClassType): number {
    if (isFiniteNumber(type.width)) return type.width;
    const members = memberRows(type).flatMap((compartment) => compartment.rows)
      .reduce((max, row) => Math.max(max, textUnits(row.text) * MEMBER_ADVANCE), 0);
    const wanted = Math.ceil(members + layout.padX * 2 + VIS_EXTRA);
    return Math.max(headerWidth(type), Math.min(grid.typeMaxW, Math.max(grid.typeW, wanted)));
  }

  function compartments(type: ClassType & { width: number }): WrappedCompartment[] {
    const available = type.width - layout.padX * 2 - VIS_EXTRA;
    return memberRows(type).map((compartment) => ({
      ...compartment,
      rows: compartment.rows.map((row) => ({ ...row, lines: wrapMember(row.text, available) })),
    }));
  }

  function typeHeight(type: ClassType & { width: number }): number {
    return headerHeight(type) + compartments(type).reduce((sum, compartment) => sum
      + compartment.rows.reduce((lines, row) => lines + row.lines.length, 0) * layout.rowH
      + layout.compartmentPad * 2, 0);
  }

  const measuredTypes = asArray(cd.types).map((type): MeasuredType => {
    const width = resolvedWidth(type);
    return { ...type, width, height: typeHeight({ ...type, width }) };
  });
  const bands = bandedLayout(measuredTypes, { ...grid, entityW: grid.typeW });
  // Types are centred in their row band, so a relationship between two types of
  // one row runs straight across instead of jogging between their centres.
  const types = new Map(measuredTypes.map((type): [string, PlacedType] => {
    const [x, top] = resolveEntityPos(type, { ...grid, entityW: grid.typeW }, bands);
    const y = placedByGrid(type) ? top + ((bands.heights.get(type.row ?? NaN) ?? type.height) - type.height) / 2 : top;
    return [type.id, { ...type, x, y, cx: x + type.width / 2, cy: y + type.height / 2 }];
  }));

  // Routing runs at module load, so a type without a position is reported before
  // any geometry is computed from it.
  {
    const unplaced = [...types.values()].filter((type) => !Number.isFinite(type.x) || !Number.isFinite(type.y));
    if (unplaced.length) {
      throwDiagnosticProblems('Class diagram placement failed',
        unplaced.map((type) => `Type "${type.id}" needs grid row/col or an absolute pos [x,y].`),
        { code: 'layout/constraint', subject: { diagramType: 'class' } });
    }
  }

  const relationships = asArray(cd.relationships).map((relationship): ClassRelationship => {
    if (!Array.isArray(relationship.via) || relationship.via.length) return relationship;
    // 空路径与省略字段等价，统一主干和普通路由的判断，同时保留作者原始文档。
    const automatic = { ...relationship };
    delete automatic.via;
    return automatic;
  });

  const typeSteps = new Map<string, number>();
  for (const [index, relationship] of relationships.entries()) {
    if (!typeSteps.has(relationship.to)) typeSteps.set(relationship.to, index);
    if (!typeSteps.has(relationship.from)) typeSteps.set(relationship.from, index + 1);
  }
  for (const [index, type] of asArray(cd.types).entries()) {
    if (!typeSteps.has(type.id)) typeSteps.set(type.id, index);
  }

  // One notation table owns the line dash, the marker at each end, and the legend
  // swatch, so the legend can never teach a different symbol than the lines draw.
  //
  // Every relationship reads `from` -> `to`:
  // - dependency:  `from` uses `to`            dashed, open arrow at `to`
  // - association: `from` holds a `to`         solid,  open arrow at `to`
  // - inheritance: `from` extends `to`         solid,  hollow triangle at `to`
  // - realization: `from` implements `to`      dashed, hollow triangle at `to`
  // - composition: `from` owns `to` (lifetime) solid,  filled diamond at `from`
  // - aggregation: `from` groups `to`          solid,  hollow diamond at `from`
  const NOTATION: Record<string, Notation> = {
    dependency: { dashed: true, end: 'open' },
    association: { dashed: false, end: 'open' },
    inheritance: { dashed: false, end: 'triangle' },
    realization: { dashed: true, end: 'triangle' },
    composition: { dashed: false, start: 'diamond-filled' },
    aggregation: { dashed: false, start: 'diamond-hollow' },
  };
  const RELATIONSHIP_KINDS = Object.keys(NOTATION);
  const GENERALIZATION = new Set(['inheritance', 'realization']);

  // Marker glyphs, in marker space. The path end sits on the type border at refX,
  // so a triangle's tip and a diamond's point touch the type they describe.
  const GLYPH: Record<string, Glyph> = {
    open: { width: 12, height: 12, refX: 11, refY: 6, body: '<path d="M 1 1 L 11 6 L 1 11" fill="none"/>' },
    triangle: { width: 16, height: 16, refX: 15, refY: 8, body: '<path d="M 1 1.5 L 15 8 L 1 14.5 Z" class="cl-marker-hollow"/>' },
    'diamond-filled': { width: 20, height: 12, refX: 1, refY: 6, body: '<path d="M 1 6 L 10 1 L 19 6 L 10 11 Z" class="cl-marker-filled"/>' },
    'diamond-hollow': { width: 20, height: 12, refX: 1, refY: 6, body: '<path d="M 1 6 L 10 1 L 19 6 L 10 11 Z" class="cl-marker-hollow"/>' },
  };
  // A hierarchy bus is drawn from the supertype outward (see renderRelationshipPath),
  // so its triangle is a start marker turned back toward the supertype.
  GLYPH['triangle-start'] = { ...GLYPH.triangle, orient: 'auto-start-reverse' };
  // The tallest glyph; ports on one side closer than this would draw overlapping
  // markers that read as one shape.
  const MARKER_HEIGHT = 16;
  const PORT_SPACING = 26;

  function renderMarkerDefs(): string {
    const used = new Set<string>();
    for (const relationship of relationships) {
      const notation = NOTATION[relationship.kind];
      if (notation?.end) used.add(notation.end);
      if (notation?.start) used.add(notation.start);
    }
    if (busPaths.size) used.add('triangle-start');
    const markup = Object.entries(GLYPH).filter(([id]) => used.has(id)).map(([id, glyph]) => (
      `          <marker id="cl-${id}" markerWidth="${glyph.width}" markerHeight="${glyph.height}" refX="${glyph.refX}" refY="${glyph.refY}" orient="${glyph.orient || 'auto'}" markerUnits="userSpaceOnUse" class="cl-marker" stroke-width="1.5" stroke-linejoin="round">
            ${glyph.body}
          </marker>`));
    return markup.length ? `\n          <!-- UML relationship markers -->\n${markup.join('\n')}` : '';
  }

  function placedByGrid(type: ClassType): boolean {
    return !(Array.isArray(type.pos) && type.pos.length === 2);
  }

  const LEGEND_CATALOG = RELATIONSHIP_KINDS
    .map((kind): LegendEntry => ({ kind, label: i18nText(locale, `legend.class.${kind}`), interactive: false }));
  const presentKinds = new Set(relationships.map((relationship) => relationship.kind));
  const LEGEND_SWATCH = 34;
  const LEGEND_BASELINE_GAP = 16;
  const LEGEND_FONT_SIZE = 10;
  const legendEntries = resolveLegend(cd.meta?.legend, LEGEND_CATALOG, presentKinds)
    .map((entry) => ({ ...entry, swatchWidth: LEGEND_SWATCH }));

  function contentBounds(): { maxX: number; maxY: number } {
    const placed = [...types.values()].filter((type) => Number.isFinite(type.x) && Number.isFinite(type.y));
    return {
      maxX: Math.max(0, ...placed.map((type) => type.x + type.width)),
      maxY: Math.max(0, ...placed.map((type) => type.y + type.height)),
    };
  }

  function legendLayout(width: number, height: number, { obstacles = [], unfit = 'error' }: { obstacles?: LegendObstacle[]; unfit?: 'error' | 'hide' } = {}): LegendLayoutOptions {
    return {
      x: layout.margin,
      baselineY: height - LEGEND_BASELINE_GAP,
      width: width - layout.margin * 2,
      fontSize: LEGEND_FONT_SIZE,
      minTitleY: contentBounds().maxY + 8,
      obstacles,
      unfit,
      diagramType: 'class',
    };
  }

  function autoViewBox(): [number, number] {
    const { maxX, maxY } = contentBounds();
    let width = Math.ceil(maxX + layout.margin);
    let footprint = legendFootprint(legendEntries, { width: Math.max(1, width - layout.margin * 2) });
    if (footprint.minWidth > width - layout.margin * 2) {
      width = Math.ceil(footprint.minWidth + layout.margin * 2);
      footprint = legendFootprint(legendEntries, { width: width - layout.margin * 2 });
    }
    let height = Math.ceil(maxY + layout.margin + (legendEntries.length ? layout.legendH + footprint.extraHeight : 0));
    for (let attempt = 0; legendEntries.length && attempt < 4; attempt += 1) {
      if (measureLegend(legendEntries, legendLayout(width, height, { unfit: 'hide' }))) break;
      height += layout.legendH;
    }
    return [Math.max(320, width), Math.max(240, height)];
  }

  const viewBox: [number, number] = Array.isArray(cd.meta?.viewBox) ? cd.meta.viewBox : autoViewBox();

  // A generalization is drawn vertically whenever the two types are not side by
  // side: the supertype above, its subtypes below, which is how a reader expects
  // a hierarchy to stand. Other relationships keep the shared horizontal-first
  // inference, and stacked types always use their facing top/bottom sides.
  const relationshipSet = new Set<object>(relationships);
  const isRelationship = (conn: object): conn is ClassRelationship => relationshipSet.has(conn);

  function sideFor(relationship: object, endpoint: 'source' | 'target'): string | undefined {
    if (!isRelationship(relationship)) return undefined;
    const from = types.get(relationship.from);
    const to = types.get(relationship.to);
    if (!from || !to) return undefined;
    const overlapX = from.x < to.x + to.width && to.x < from.x + from.width;
    const overlapY = from.y < to.y + to.height && to.y < from.y + from.height;
    const vertical = overlapX || (!overlapY && GENERALIZATION.has(relationship.kind));
    if (!vertical) return endpoint === 'source' ? legacyDefaultFromSide(from, to) : legacyDefaultToSide(from, to);
    const down = to.cy > from.cy;
    if (endpoint === 'source') return down ? 'bottom' : 'top';
    return down ? 'top' : 'bottom';
  }

  function renderableRelationship(relationship: ClassRelationship): boolean {
    return types.has(relationship.from) && types.has(relationship.to) && relationship.from !== relationship.to;
  }

  const routable = relationships.filter(renderableRelationship);

  // Two or more automatic generalizations of one kind into one supertype, all
  // from subtypes placed below it, draw as one tree: a single triangle and trunk
  // under the supertype, a horizontal bus, and a drop to each subtype. That is
  // the conventional UML shape, and it reads as "these all implement X" instead
  // of as N unrelated arrows. A bus that would cross another type is not drawn;
  // its members fall back to ordinary routes.
  const BUS_MIN_GAP = 40;

  function autoRouted(relationship: ClassRelationship): boolean {
    return !relationship.via?.length && (!relationship.route || relationship.route === 'auto')
      && !relationship.fromSide && !relationship.toSide && !relationship.labelAt;
  }

  const busPaths = new Map<Relation, Point[]>();
  const busGroups = new Map<ClassRelationship, ClassRelationship[]>();
  {
    const groups = new Map<string, ClassRelationship[]>();
    for (const relationship of routable) {
      if (!GENERALIZATION.has(relationship.kind) || !autoRouted(relationship)) continue;
      const key = `${relationship.to}\u0000${relationship.kind}`;
      const group = groups.get(key) ?? [];
      groups.set(key, group);
      group.push(relationship);
    }
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const target = required(types, members[0].to);
      const bottom = target.y + target.height;
      const sources = members.map((relationship) => required(types, relationship.from));
      const firstTop = Math.min(...sources.map((source) => source.y));
      if (firstTop - bottom < BUS_MIN_GAP) continue;
      const busY = Math.round(bottom + (firstTop - bottom) / 2);
      const paths = members.map((relationship, index): Point[] => {
        const source = sources[index];
        return Math.abs(source.cx - target.cx) < 0.5
          ? [[source.cx, source.y], [target.cx, bottom]]
          : [[source.cx, source.y], [source.cx, busY], [target.cx, busY], [target.cx, bottom]];
      });
      // Each drop may touch only its own subtype and the supertype; a deeper
      // subtype's drop must not run through a sibling placed above it.
      const clear = paths.every((points, member) => {
        const others = [...types.values()].filter((type) => type !== target && type !== sources[member]);
        return points.slice(1).every((point, index) => others
          .every((type) => !segmentIntersectsRect({ start: points[index], end: point }, type)));
      });
      if (!clear) continue;
      members.forEach((relationship, index) => {
        busPaths.set(relationship, paths[index]);
        busGroups.set(relationship, members);
      });
    }
  }

  let separateFallbackRoutes = false;
  function ordinaryRouter(): Router {
    const options: RouterOptions = {
      sideFor,
      maxPortSpacing: PORT_SPACING,
      distinctAutomaticPorts: separateFallbackRoutes,
      // As for the ERD: re-plan a route against the complete scene when it crosses
      // or bends needlessly, and look for a detour that crosses nothing before the
      // obstacle search that may cross earlier routes. The showcase gate rejects
      // any proper crossing, so the shorter crossing route only buys a repair.
      preferReadableRoutes: true,
      crossingFreeGridFirst: true,
      // A detour keeps a readable gap from every type it only passes instead of
      // running along its border at the grid's 2-unit clearance.
      componentGapPx: 10,
    };
    return createRouter(types, routable.filter((relationship) => !busPaths.has(relationship)), options);
  }

  function busRouteConflict(left: BusRoute, right: BusRoute): boolean {
    for (const [leftField, leftPoint] of routeEnds(left)) {
      for (const [rightField, rightPoint] of routeEnds(right)) {
        if (left.relation[leftField] === right.relation[rightField]
          && Math.hypot(leftPoint[0] - rightPoint[0], leftPoint[1] - rightPoint[1]) < MARKER_HEIGHT - 0.0001) return true;
      }
    }
    if (collectAmbiguousCorridors({
      routedRelations: [left, right],
      includeSharedEndpoints: () => true,
    }).length) return true;
    return left.points.slice(1).some((end, index) => right.points.slice(1)
      .some((otherEnd, otherIndex) => properSegmentIntersection(
        left.points[index], end, right.points[otherIndex], otherEnd,
      )));
  }

  let router: Router;
  for (;;) {
    router = ordinaryRouter();
    if (!busPaths.size) break;
    const routes = routable.map((relation): BusRoute => ({
      relation, points: busPaths.get(relation) || router.pathFor(relation).points,
    }));
    const rejected = new Set<ClassRelationship[]>();
    for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
      const left = routes[leftIndex];
      const leftGroup = busGroups.get(left.relation);
      for (let rightIndex = leftIndex + 1; rightIndex < routes.length; rightIndex += 1) {
        const right = routes[rightIndex];
        const rightGroup = busGroups.get(right.relation);
        // 只有同一主干组可以共享端口和线段；其他路线仍保留各自的关系符号。
        if ((!leftGroup && !rightGroup) || leftGroup === rightGroup) continue;
        if (!busRouteConflict(left, right)) continue;
        if (leftGroup) rejected.add(leftGroup);
        if (rightGroup) rejected.add(rightGroup);
      }
    }
    if (!rejected.size) break;
    // 回退后的独立关系即使共享目标，也不能重新合并成没有语义归属的走廊。
    separateFallbackRoutes = true;
    // 整组回退后重新规划，避免新路线撞到剩余主干；每轮只删除组，次数有界。
    for (const group of rejected) {
      for (const relationship of group) {
        busPaths.delete(relationship);
        busGroups.delete(relationship);
      }
    }
  }
  function pathFor(relationship: Relation): RoutedPath {
    const points = busPaths.get(relationship);
    return points ? { points, d: roundedPath(points, 8) } : router.pathFor(relationship);
  }
  // A bus drop leaves the subtype's top and the trunk enters the supertype's
  // bottom; every other relationship keeps the router's resolved sides.
  function connectionEndpointSide(relationship: Relation, endpoint: 'source' | 'target'): string {
    if (busPaths.has(relationship)) return endpoint === 'source' ? 'top' : 'bottom';
    return router.connectionEndpointSide(relationship, endpoint);
  }
  function inferredSides(relationship: Relation): { fromSide: string; toSide: string } {
    if (busPaths.has(relationship)) return { fromSide: 'top', toSide: 'bottom' };
    return router.inferredSides(relationship);
  }

  const RELATIONSHIP_LABEL_FONT = 9.5;
  const RELATIONSHIP_LABEL_ADVANCE = 0.62;
  function relationshipLabelWidth(relationship: ClassRelationship): number {
    return Math.max(30, textUnits(relationship.label) * RELATIONSHIP_LABEL_FONT * RELATIONSHIP_LABEL_ADVANCE + 10);
  }
  // A label sits on the segment with the most room unless the author picks one:
  // above a horizontal run, beside a vertical one, so it never covers its own
  // line or lands on the box the relationship leaves.
  const resolvedLabelPoints = new Map<ClassRelationship, Point>();
  function relationshipLabelPoint(relationship: ClassRelationship): Point {
    return resolvedLabelPoints.get(relationship) ?? defaultRelationshipLabelPoint(relationship);
  }
  function defaultRelationshipLabelPoint(relationship: ClassRelationship): Point {
    if (relationship.labelAt) return relationship.labelAt;
    const points = pathFor(relationship).points;
    const width = relationshipLabelWidth(relationship);
    const vertical = (index: number) => Math.abs(points[index][0] - points[index + 1][0]) < Math.abs(points[index][1] - points[index + 1][1]);
    const room = (index: number) => {
      const length = Math.hypot(points[index + 1][0] - points[index][0], points[index + 1][1] - points[index][1]);
      return length - (vertical(index) ? 22 : width + 8);
    };
    const index = isInteger(relationship.labelSegment)
      ? Math.min(points.length - 2, relationship.labelSegment)
      : points.slice(1).reduce((best: number, _, candidate) => (room(candidate) > room(best) ? candidate : best), 0);
    const [a, b] = [points[index], points[index + 1]];
    const dx = relationship.labelDx || 0;
    const dy = relationship.labelDy || 0;
    if (vertical(index)) return [a[0] + width / 2 + 6 + dx, (a[1] + b[1]) / 2 + 4 + dy];
    return [(a[0] + b[0]) / 2 + dx, a[1] - 6 + dy];
  }
  function relationshipLabelBox(relationship: ClassRelationship): Rect {
    const [lx, ly] = relationshipLabelPoint(relationship);
    const width = relationshipLabelWidth(relationship);
    return { x: lx - width / 2, y: ly - 10, width, height: 14 };
  }

  // The default point picks the roomiest segment but knows nothing about other
  // routes, markers, or types near it. A colliding unpinned label goes through the
  // shared bounded placer (architecture, dataflow, and erd use it too), with
  // every end marker reserved, so it moves beside its own route instead of
  // failing the gate; a clear default is kept as it is.
  const MARKER_REACH = 20;
  // Half the tallest marker plus the 2-unit overlap the placer tolerates.
  const MARKER_HALF = 10;
  function markerBox([x, y]: Point, side: string): Rect {
    if (side === 'left') return { x: x - MARKER_REACH, y: y - MARKER_HALF, width: MARKER_REACH, height: MARKER_HALF * 2 };
    if (side === 'right') return { x, y: y - MARKER_HALF, width: MARKER_REACH, height: MARKER_HALF * 2 };
    if (side === 'top') return { x: x - MARKER_HALF, y: y - MARKER_REACH, width: MARKER_HALF * 2, height: MARKER_REACH };
    return { x: x - MARKER_HALF, y, width: MARKER_HALF * 2, height: MARKER_REACH };
  }
  {
    const labels = routable.filter(hasLabel).map((relationship): ClassLabel => {
      const [lx, ly] = defaultRelationshipLabelPoint(relationship);
      return { relation: relationship, relationIndex: relationships.indexOf(relationship), label: relationship.label,
        ...relationshipLabelBox(relationship), lx, ly };
    });
    if (labels.length) {
      const markers = routable.flatMap((relationship) => {
        const { points } = pathFor(relationship);
        return [
          markerBox(points[0], connectionEndpointSide(relationship, 'source')),
          markerBox(points[points.length - 1], connectionEndpointSide(relationship, 'target')),
        ];
      });
      const footprint = legendEntries.length
        ? layout.legendH + legendFootprint(legendEntries, { width: Math.max(1, viewBox[0] - layout.margin * 2) }).extraHeight
        : 0;
      const placed = placeAutomaticLabels({
        labels,
        routes: routable.map((relationship) => ({ relationIndex: relationships.indexOf(relationship), points: pathFor(relationship).points })),
        components: [...types.values(), ...markers],
        titles: [],
        viewBox,
        placementBottom: viewBox[1] - footprint,
        keepFallbackNearRoute: true,
      });
      placed.forEach((rect, index) => {
        if (rect !== labels[index]) resolvedLabelPoints.set(rect.relation, [rect.lx, rect.ly]);
      });
    }
  }

  function detail(code: string, message: string, subject: Record<string, unknown>, evidence: Record<string, unknown>, supportedFixes: string[]): DiagnosticInput & { message: string } {
    return { code, severity: 'error', message, subject: { diagramType: 'class', ...subject }, evidence, supportedFixes };
  }

  function generalizationCycle(): string[] | null {
    const parents = new Map<string, string[]>();
    for (const relationship of relationships) {
      if (relationship.kind !== 'inheritance' || !renderableRelationship(relationship)) continue;
      const list = parents.get(relationship.from) ?? [];
      parents.set(relationship.from, list);
      list.push(relationship.to);
    }
    const state = new Map<string, 'open' | 'done'>();
    const stack: string[] = [];
    const visit = (id: string): string[] | null => {
      if (state.get(id) === 'done') return null;
      if (state.get(id) === 'open') return [...stack.slice(stack.indexOf(id)), id];
      state.set(id, 'open');
      stack.push(id);
      for (const parent of parents.get(id) || []) {
        const cycle = visit(parent);
        if (cycle) return cycle;
      }
      stack.pop();
      state.set(id, 'done');
      return null;
    };
    for (const id of parents.keys()) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
    return null;
  }

  function validateClassDiagram(): void {
    const problems: string[] = [];
    const details: DiagnosticInput[] = [];
    const fail = (entry: DiagnosticInput & { message: string }) => {
      problems.push(entry.message);
      details.push(entry);
    };

    const seen = new Set();
    const cells = new Map();
    for (const [index, type] of asArray(cd.types).entries()) {
      if (seen.has(type.id)) problems.push(`Type ids must be unique; "${type.id}" is declared twice.`);
      seen.add(type.id);
      if (placedByGrid(type)) {
        if (!isInteger(type.row) || !isHalfStep(type.col)) {
          problems.push(`Type "${type.id}" needs grid row/col (col may be a half step, e.g. 1.5) or an absolute pos [x,y].`);
        } else {
          // A half column straddles the two columns beside it.
          for (const col of new Set([Math.floor(type.col), Math.ceil(type.col)])) {
            const key = `${type.row},${col}`;
            if (cells.has(key)) problems.push(`Types "${cells.get(key)}" and "${type.id}" share grid cell row ${type.row} col ${col}.`);
            else cells.set(key, type.id);
          }
        }
      }
      const attributeNames = new Set<string>();
      for (const attribute of asArray(type.attributes)) {
        if (attributeNames.has(attribute.name)) problems.push(`Type "${type.id}" declares attribute "${attribute.name}" twice.`);
        attributeNames.add(attribute.name);
      }
      // Members wrap, but the title is one line: a box must be wide enough for it.
      const placed = types.get(type.id);
      const needed = headerWidth(type);
      if (placed && needed > placed.width) {
        fail(detail('class/title-text-capacity',
          `Type "${type.id}" title "${type.label}" needs ${needed}px but the type is ${placed.width}px wide — remove or raise the authored width, or shorten the title.`,
          { path: `/types/${index}/width`, typeId: type.id },
          { label: type.label, width: placed.width, requiredWidth: needed },
          ['Remove the authored width so the type sizes itself.', `Set width to at least ${needed}.`, 'Shorten the type title.']));
      }
    }

    for (const type of types.values()) {
      for (const other of types.values()) {
        if (type.id >= other.id || !rectsOverlap(type, other, 0)) continue;
        problems.push(`Type "${type.id}" overlaps type "${other.id}".\n${suggestComponentSeparation(type, other)}`);
      }
    }

    for (const [index, relationship] of relationships.entries()) {
      const id = relationship.id ? ` id "${relationship.id}"` : '';
      const from = types.get(relationship.from);
      const to = types.get(relationship.to);
      if (!from || !to) {
        problems.push(`Relationship ${index}${id} references unknown type "${from ? relationship.to : relationship.from}".`);
        continue;
      }
      if (relationship.from === relationship.to) {
        problems.push(`Relationship ${index}${id} connects type "${relationship.from}" to itself — describe the self-reference as a member type or in a card.`);
        continue;
      }
      // The hollow triangle claims a supertype; the claim has to agree with the
      // kinds, or the diagram states an impossible hierarchy.
      if (relationship.kind === 'realization' && (to.kind !== 'interface' || from.kind === 'interface')) {
        fail(detail('class/realization-target',
          `Relationship ${index}${id} "${relationship.from}" realizes "${relationship.to}", but realization runs from a non-interface type to an interface (here ${from.kind} -> ${to.kind}). Use inheritance for class-to-class or interface-to-interface extension.`,
          { path: `/relationships/${index}`, relationshipIndex: index },
          { from: relationship.from, fromKind: from.kind, to: relationship.to, toKind: to.kind },
          ['Use kind "inheritance" for extension between two classes or two interfaces.', 'Point the realization at the interface it implements.']));
      }
      if (relationship.kind === 'inheritance' && (from.kind === 'interface') !== (to.kind === 'interface')) {
        fail(detail('class/inheritance-kind',
          `Relationship ${index}${id} "${relationship.from}" inherits from "${relationship.to}" across an interface boundary (${from.kind} -> ${to.kind}). A class implementing an interface is a realization.`,
          { path: `/relationships/${index}`, relationshipIndex: index },
          { from: relationship.from, fromKind: from.kind, to: relationship.to, toKind: to.kind },
          ['Use kind "realization" for a class implementing an interface.']));
      }
      const routed = pathFor(relationship);
      const [start, end] = [routed.points[0], routed.points[routed.points.length - 1]];
      const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
      if (distance < layout.minRelationshipLength) {
        problems.push(`Relationship ${index}${id} "${relationship.from}" -> "${relationship.to}" is too short (${Math.round(distance)}px; minimum ${layout.minRelationshipLength}px) — place the types farther apart.`);
      }
    }

    const cycle = generalizationCycle();
    if (cycle) {
      fail(detail('class/inheritance-cycle',
        `Inheritance forms a cycle: ${cycle.map((id) => `"${id}"`).join(' -> ')}. A type cannot be its own supertype.`,
        { path: '/relationships', typeId: cycle[0] },
        { cycle },
        ['Remove or reverse one inheritance relationship in the cycle.']));
    }

    // Busy sides can leave less room than a marker is tall: the router spreads
    // ports by min(PORT_SPACING, available / (n - 1)).
    for (const [typeId, type] of types) {
      const sides = new Map<string, number>();
      // A bus enters its supertype through one shared trunk, which is one port.
      for (const relationship of routable.filter((candidate) => !busPaths.has(candidate))) {
        const { fromSide, toSide } = inferredSides(relationship);
        if (relationship.from === typeId) sides.set(fromSide, (sides.get(fromSide) || 0) + 1);
        if (relationship.to === typeId) sides.set(toSide, (sides.get(toSide) || 0) + 1);
      }
      for (const [side, count] of sides) {
        if (count < 2) continue;
        const extent = side === 'left' || side === 'right' ? type.height : type.width;
        const spacing = Math.min(PORT_SPACING, Math.max(0, extent - 32) / (count - 1));
        if (spacing >= MARKER_HEIGHT) continue;
        fail({
          ...detail('layout/marker-capacity',
            `Type "${typeId}" shares its ${side} side with ${count} relationship ends ${Math.round(spacing)}px apart, under the ${MARKER_HEIGHT}px a relationship marker needs, so the markers overlap. Spread the relationships across sides or place the related types so they arrive from different directions.`,
            { path: `/types/${typeId}` },
            { type: typeId, side, relationshipEnds: count, spacingPx: Math.round(spacing), markerHeightPx: MARKER_HEIGHT, sideExtentPx: extent },
            ['Spread the relationships across sides with room.', 'Move related types so they approach from different sides.']),
        });
      }
    }

    const shared = {
      relations: routable,
      endpointIds: new Set(types.keys()),
      pathFor,
      diagramType: 'class',
      relationCollection: 'relationships',
      profile: cd.meta?.quality_profile,
    };
    problems.push(...cleanEndpointSideProblems({
      ...shared,
      fromSideFor: (relationship) => connectionEndpointSide(relationship, 'source'),
      toSideFor: (relationship) => connectionEndpointSide(relationship, 'target'),
      routeHint: 'keep automatic routing, or set truthful fromSide/toSide',
    }));
    problems.push(...cleanFlowProblems({
      relations: routable,
      obstacles: types.values(),
      pathFor,
      diagramType: 'class',
      relationCollection: 'relationships',
      obstacleKind: 'type',
      routeHint: 'adjust fromSide/toSide, set route/via, or move the type',
    }));
    problems.push(...cleanCrossingProblems({ ...shared, routeHint: 'move the types so unrelated relationships use separate corridors' }));
    problems.push(...cleanAmbiguousCorridorProblems({ ...shared, routeHint: 'give the relationships different sides, or move a type so their corridors differ' })
      .filter((problem) => problem !== null));
    problems.push(...cleanRouteRhythmProblems({ ...shared, routeHint: 'widen layout.gapX/gapY so every turn has room to read' }));

    const labels: ClassLabel[] = [];
    for (const [index, relationship] of relationships.entries()) {
      if (!hasLabel(relationship) || !renderableRelationship(relationship)) continue;
      const [lx, ly] = relationshipLabelPoint(relationship);
      labels.push({ relation: relationship, relationIndex: index, label: relationship.label, ...relationshipLabelBox(relationship), lx, ly });
    }
    for (const rect of labels) {
      for (const type of types.values()) {
        if (!rectsOverlap(rect, type, -2)) continue;
        problems.push(`Label "${rect.label}" overlaps type "${type.id}" — adjust labelDx/labelDy/labelSegment or set labelAt.\n${suggestLabelObstacleFix(rect, rect.lx, rect.ly, type, 'type')}`);
      }
    }
    problems.push(...cleanLabelRouteClearanceProblems({ ...shared, labels }));

    if (problems.length) {
      throwDiagnosticProblems('Class diagram validation failed', problems, {
        code: 'layout/constraint',
        subject: { diagramType: 'class' },
        diagnostics: details,
      });
    }
  }

  function buildLayoutReport(): ClassLayoutReport {
    return {
      diagram_type: 'class',
      viewBox,
      types: [...types.values()].map((type) => ({
        id: type.id,
        label: type.label,
        kind: type.kind,
        x: Math.round(type.x),
        y: Math.round(type.y),
        width: type.width,
        height: type.height,
        ...(isInteger(type.row) ? { row: type.row } : {}),
        ...(isInteger(type.col) ? { col: type.col } : {}),
      })),
      relationships: routable.map((relationship) => ({
        ...relationshipPath(relationship, pathFor(relationship), relationship.labelAt),
        kind: relationship.kind,
      })),
    };
  }

  // A member reads like a signature in an editor: the visibility glyph and every
  // type annotation are quiet, so the names carry the row. Wrapping never splits
  // an annotation, so each line is coloured on its own.
  const VISIBILITY_CLASS: Record<string, string> = { '+': 'public', '#': 'protected', '~': 'package', '-': 'private' };

  function punctuated(text: string): string {
    return esc(text).replace(/[(),]/g, (mark) => `<tspan class="t-muted cl-punct">${mark}</tspan>`);
  }

  function memberSpans(text: string, first: boolean): string {
    let out = '';
    let rest = text;
    // A continuation line with no annotation of its own is the rest of a type
    // (`PaymentProcessor>`), so it is set like the start of that type.
    if (!first && !rest.includes(':') && !rest.startsWith(')')) return `<tspan class="t-muted cl-type-ref">${esc(rest)}</tspan>`;
    const glyph = first ? rest.match(/^([+#~-]) /) : null;
    if (glyph) {
      out += `<tspan class="t-muted cl-vis cl-vis-${VISIBILITY_CLASS[glyph[1]]}">${esc(glyph[1])}</tspan> `;
      rest = rest.slice(2);
    }
    const annotation = /:(\s*)([^,()]+)/g;
    let last = 0;
    for (const match of rest.matchAll(annotation)) {
      out += `${punctuated(rest.slice(last, match.index))}<tspan class="t-muted cl-punct">:</tspan>${esc(match[1])}<tspan class="t-muted cl-type-ref">${esc(match[2])}</tspan>`;
      last = match.index + match[0].length;
    }
    return out + punctuated(rest.slice(last));
  }

  // The visibility glyph is set as a chip in its own column, like a key badge in
  // an ERD; a one-line member puts its type in a right-aligned column so the
  // names and the types each read down one edge.
  function visibilityChip(glyph: string, x: number, baseline: number): string {
    const kind = VISIBILITY_CLASS[glyph];
    return `<rect x="${x}" y="${baseline - 10.5}" width="${VIS_CHIP}" height="${VIS_CHIP}" rx="4" class="cl-vis-chip cl-vis-${kind}"/><text x="${x + VIS_CHIP / 2}" y="${baseline}" class="t-muted cl-vis cl-vis-${kind}" font-size="${layout.memberFont}" text-anchor="middle">${esc(glyph)}</text>`;
  }

  function memberColumns(member: AnyMember, kind: Compartment['kind']): { left: string; right: string | undefined } {
    if (kind === 'attributes') return { left: punctuated(member.name), right: member.type };
    const parameters = member.parameters
      ? String(member.parameters).split(/(,\s*)/).map((part) => {
        if (/^,\s*$/.test(part)) return `<tspan class="t-muted cl-punct">,</tspan> `;
        const [name, ...annotation] = part.split(':');
        return annotation.length
          ? `<tspan class="cl-param">${esc(name)}</tspan><tspan class="t-muted cl-punct">:</tspan><tspan class="t-muted cl-type-ref">${esc(annotation.join(':'))}</tspan>`
          : `<tspan class="cl-param">${esc(part)}</tspan>`;
      }).join('')
      : '';
    return {
      left: `${esc(member.name)}<tspan class="t-muted cl-punct">(</tspan>${parameters}<tspan class="t-muted cl-punct">)</tspan>`,
      right: member.returns,
    };
  }

  function renderMembers(type: PlacedType): string {
    let top = type.y + headerHeight(type);
    let stripe = 0;
    return compartments(type).map((compartment) => {
      const rule = `<line x1="${type.x}" y1="${top}" x2="${type.x + type.width}" y2="${top}" class="cl-rule" stroke-width="1"/>`;
      let line = 0;
      const rows = compartment.rows.flatMap(({ member, lines }) => {
        const style = [
          member.static ? 'text-decoration: underline' : '',
          member.abstract ? 'font-style: italic' : '',
        ].filter(Boolean).join('; ');
        const styleAttr = style ? ` style="${style}"` : '';
        const rowTop = top + layout.compartmentPad + line * layout.rowH;
        const zebra = stripe++ % 2
          ? `<rect x="${type.x + 4}" y="${rowTop + 1}" width="${type.width - 8}" height="${lines.length * layout.rowH - 2}" rx="4" class="cl-zebra"/>`
          : '';
        const glyph = member.visibility ? VISIBILITY_GLYPH[member.visibility] : '';
        const x0 = type.x + layout.padX;
        const chip = glyph ? visibilityChip(glyph, x0, rowTop + layout.rowH - 5) : '';
        const textX = glyph ? x0 + VIS_CHIP + VIS_GAP : x0;
        if (lines.length === 1) {
          const baseline = top + layout.compartmentPad + (line += 1) * layout.rowH - 5;
          const { left, right } = memberColumns(member, compartment.kind);
          const typeText = right
            ? `<text data-detail="context" x="${type.x + type.width - layout.padX}" y="${baseline}" class="t-muted cl-member cl-type-ref" font-size="${layout.memberFont}" text-anchor="end"${styleAttr}>${esc(right)}</text>`
            : '';
          return [`${zebra}${chip}<text data-detail="context" data-class-member="${compartment.kind}" x="${textX}" y="${baseline}" class="t-primary cl-member" font-size="${layout.memberFont}"${styleAttr}>${left}</text>${typeText}`];
        }
        return lines.map((entry, index) => {
          const baseline = top + layout.compartmentPad + (line += 1) * layout.rowH - 5;
          const text = index || !glyph ? entry.text : entry.text.slice(2);
          const x = index || !glyph ? x0 + (glyph ? VIS_CHIP + VIS_GAP - 2 * MEMBER_ADVANCE : 0) + entry.indent * MEMBER_ADVANCE : textX;
          const continued = index ? ' data-class-continuation=""' : '';
          return `${index ? '' : `${zebra}${chip}`}<text data-detail="context" data-class-member="${compartment.kind}"${continued} x="${x}" y="${baseline}" class="t-primary cl-member" font-size="${layout.memberFont}"${styleAttr}>${memberSpans(text, !index)}</text>`;
        });
      });
      top += line * layout.rowH + layout.compartmentPad * 2;
      return `          <g data-detail="context" data-class-compartment="${compartment.kind}">
            ${rule}
            ${rows.join('\n            ')}
          </g>`;
    }).join('\n');
  }

  function renderType(type: PlacedType): string {
    const tone = KIND_TONE[type.kind] || 'backend';
    const header = headerHeight(type);
    const stereotype = STEREOTYPE[type.kind];
    const kindLabel = i18nText(locale, `node.context.class.${type.kind}`);
    const passport = { kind: type.kind, sublabel: type.sublabel, context: kindLabel };
    const cx = type.x + type.width / 2;
    const nameY = stereotype ? type.y + 34 : type.y + 22;
    const badgeX = type.x + layout.padX;
    const badgeY = type.y + (stereotype ? 14 : 9);
    const italic = type.kind === 'abstract' ? ' font-style="italic"' : '';
    const r = 8;
    return `        <g ${focusNodeAttrs(type.id, type.label, passport, locale)} data-class-kind="${esc(type.kind)}" class="cl-hue-${tone}">
          ${focusNodeTitle(type.label, passport)}
          <rect x="${type.x}" y="${type.y}" width="${type.width}" height="${type.height}" rx="${r}" class="c-mask"/>
          <rect x="${type.x}" y="${type.y}" width="${type.width}" height="${type.height}" rx="${r}" class="c-${tone} cl-type"${animateAttr(cd.meta, 'node', typeSteps.get(type.id))} stroke-width="1.2"/>
          <path class="cl-header c-${tone}" stroke="none" d="M ${type.x + r} ${type.y} H ${type.x + type.width - r} A ${r} ${r} 0 0 1 ${type.x + type.width} ${type.y + r} V ${type.y + header} H ${type.x} V ${type.y + r} A ${r} ${r} 0 0 1 ${type.x + r} ${type.y} Z"/>
          <path class="cl-cap" d="M ${type.x + 12} ${type.y + 1.4} H ${type.x + type.width - 12}" stroke-width="2.6" stroke-linecap="round" fill="none"/>
          <g aria-hidden="true" class="cl-badge">
            <rect x="${badgeX}" y="${badgeY}" width="${BADGE_SIZE}" height="${BADGE_SIZE}" rx="${BADGE_SIZE * 0.3}" class="cl-badge-chip"/>
            <text x="${badgeX + BADGE_SIZE / 2}" y="${badgeY + BADGE_SIZE / 2 + 3.5}" class="t-${tone} cl-badge-letter" font-size="10" font-weight="800" text-anchor="middle">${esc(type.kind[0].toUpperCase())}</text>
          </g>
          ${stereotype ? `<text x="${cx}" y="${type.y + 16}" class="t-muted cl-stereotype" font-size="${layout.stereotypeFont}" text-anchor="middle">${esc(stereotype)}</text>` : ''}
          <text data-node-label="" x="${cx}" y="${nameY}" class="t-primary" font-size="${layout.nameFont}" font-weight="700" text-anchor="middle"${italic}>${esc(type.label)}</text>
${renderMembers(type)}
        </g>`;
  }

  function markerAttrs(kind: string, { reversed = false }: { reversed?: boolean } = {}): string {
    const notation = NOTATION[kind];
    if (reversed) return ` marker-start="url(#cl-${notation.end}-start)"`;
    return `${notation.start ? ` marker-start="url(#cl-${notation.start})"` : ''}${notation.end ? ` marker-end="url(#cl-${notation.end})"` : ''}`;
  }

  function relationshipClass(kind: string): string {
    return `a-default cl-relationship${NOTATION[kind].dashed ? ' cl-dashed' : ''}`;
  }

  // Bus members share their trunk and bus, so each is drawn starting at the
  // supertype: the overlapping stretches then begin at one point and their dash
  // patterns coincide instead of beating into a smeared line.
  function renderRelationshipPath(relationship: ClassRelationship, index: number): string {
    const routed = pathFor(relationship);
    const reversed = busPaths.has(relationship);
    const d = reversed ? roundedPath([...routed.points].reverse(), 8) : routed.d;
    const bus = reversed ? ` data-class-bus="${esc(relationship.to)}" data-motion-path="${esc(routed.d)}"` : '';
    return `        <path ${focusEdgeAttrs(relationship.from, relationship.to, relationship.label, index, relationship.id)} data-class-relationship="${relationship.kind}"${bus} data-composition-points="${routePointsValue(routed.points)}" d="${d}" class="${relationshipClass(relationship.kind)}"${animateAttr(cd.meta, 'edge', index)} stroke-width="1.5"${markerAttrs(relationship.kind, { reversed })}/>`;
  }

  function renderRelationshipLabel(relationship: ClassRelationship, index: number): string {
    if (!hasLabel(relationship)) return '';
    const [lx, ly] = relationshipLabelPoint(relationship);
    const box = relationshipLabelBox(relationship);
    return `        <g data-detail="context" ${focusEdgeAttrs(relationship.from, relationship.to, relationship.label, index, relationship.id)} data-class-relationship="${relationship.kind}">
          <rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="${box.height / 2}" class="c-mask cl-label-box"/>
          <text x="${lx}" y="${ly}" class="t-muted" font-size="${RELATIONSHIP_LABEL_FONT}" text-anchor="middle">${esc(relationship.label)}</text>
        </g>`;
  }

  // A swatch is a short relationship drawn in the same notation: dash, line, and
  // the marker at the end it belongs to.
  function legendSwatch(entry: PositionedLegendEntry): string {
    const notation = NOTATION[entry.kind];
    const y = entry.baseline - 4;
    const x0 = entry.x + 2;
    const x1 = entry.x + LEGEND_SWATCH - 2;
    const hit = `<rect class="cl-legend-hit" tabindex="0" role="img" aria-label="${esc(entry.label)}" x="${entry.x - 6}" y="${entry.baseline - 15}" width="${entry.width + 12}" height="22" rx="11"/>`;
    return `${hit}<path d="M ${x0} ${y} L ${x1} ${y}" class="${relationshipClass(entry.kind)}" stroke-width="1.5"${markerAttrs(entry.kind)}/>`;
  }

  const LEGEND_HOVER_RULES = RELATIONSHIP_KINDS.map((kind) => `          svg[data-class-ui]:has([data-legend-semantic-kind="${kind}"]:is(:hover, :focus-within)) [data-class-relationship]:not([data-class-relationship="${kind}"]) { opacity: .15; }`).join('\n');

  function renderLegend(): string {
    const obstacles = relationshipLegendObstacles(routable, {
      pointsFor: (relationship) => pathFor(relationship).points,
      labelRectFor: (relationship) => (relationship.label ? relationshipLabelBox(relationship) : null),
    });
    return renderResolvedLegend({
      entries: legendEntries,
      locale,
      layout: legendLayout(viewBox[0], viewBox[1], { obstacles }),
      renderSwatch: legendSwatch,
    });
  }

  function renderSvg(): string {
    // Like the ERD, an automatic canvas lets the reader scroll a tall model
    // instead of shrinking member rows past legibility.
    const readerFit = cd.meta?.viewBox ? '' : ' data-reader-fit="intrinsic-height" data-reader-min-text="7.5"';
    return `      <svg viewBox="0 0 ${viewBox[0]} ${viewBox[1]}" ${svgRootAttrs(cd.meta)} data-class-ui=""${readerFit}>
${svgAccessibleText(cd.meta, 'class')}
${renderDefinitions(renderMarkerDefs())}
        <style>
          svg[data-class-ui] .cl-zebra { fill: color-mix(in srgb, var(--cl-hue) 6%, transparent); }
          svg[data-class-ui] .cl-param { fill: color-mix(in srgb, var(--text) 72%, var(--text-muted)); }
${[...new Set(Object.values(KIND_TONE))].map((tone) => `          svg[data-class-ui] .cl-hue-${tone} { --cl-hue: var(--${tone}-stroke); }`).join('\n')}
          svg[data-class-ui] .cl-type { fill: var(--mask); stroke: color-mix(in srgb, var(--cl-hue) 46%, var(--lane-stroke)); }
          svg[data-class-ui] [data-class-kind="abstract"] .cl-type { stroke-dasharray: 5 3; stroke: color-mix(in srgb, var(--cl-hue) 64%, var(--lane-stroke)); }
          svg[data-class-ui] .cl-header { stroke: none; }
          svg[data-class-ui] .cl-cap { stroke: var(--cl-hue); pointer-events: none; }
          svg[data-class-ui] .cl-badge-chip { fill: var(--cl-hue); }
          svg[data-class-ui] .cl-badge-letter { fill: var(--mask); }
          svg[data-class-ui] .cl-stereotype { fill: var(--text-muted); letter-spacing: .04em; }
          svg[data-class-ui] .cl-rule { stroke: color-mix(in srgb, var(--cl-hue) 22%, var(--lane-stroke)); }
          svg[data-class-ui] .cl-vis { font-weight: 700; }
          svg[data-class-ui] .cl-vis-chip { fill: color-mix(in srgb, var(--text) 6%, transparent); }
          svg[data-class-ui] .cl-type-ref { fill: var(--text-muted); }
          svg[data-class-ui] .cl-punct { fill: var(--text-muted); opacity: .8; }
          svg[data-class-ui] .cl-label-box { stroke: var(--lane-stroke); stroke-width: .8; }
          svg[data-class-ui] .cl-member { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono CJK SC', 'PingFang SC', 'Microsoft YaHei', monospace; }
          svg[data-class-ui] .cl-dashed { stroke-dasharray: 6 4; }
          svg[data-class-ui] .cl-marker { stroke: var(--arrow); }
          svg[data-class-ui] .cl-marker-hollow { fill: var(--mask); }
          svg[data-class-ui] .cl-marker-filled { fill: var(--arrow); }
          svg[data-class-ui] .cl-legend-hit { fill: transparent; transition: fill .15s; }
          svg[data-class-ui] .cl-legend-hit:focus { outline: none; }
          svg[data-class-ui] .cl-legend-hit:focus-visible { stroke: var(--arrow); stroke-width: 1.5; }
          svg[data-class-ui] [data-legend-semantic-kind]:is(:hover, :focus-within) .cl-legend-hit { fill: var(--lane-fill); }
          svg[data-class-ui] [data-class-relationship] { transition: opacity .15s; }
${LEGEND_HOVER_RULES}
          @media (prefers-reduced-motion: reduce) { svg[data-class-ui] * { transition: none !important; } }
        </style>

        <!-- Background Grid -->
        <rect width="100%" height="100%" fill="url(#grid)" />

        <!-- Relationships (before types for correct z-order) -->
${relationships.map((relationship, index) => (renderableRelationship(relationship) ? renderRelationshipPath(relationship, index) : '')).filter(Boolean).join('\n')}

        <!-- Types -->
${[...types.values()].map(renderType).join('\n\n')}

        <!-- Relationship labels -->
${relationships.map((relationship, index) => (renderableRelationship(relationship) ? renderRelationshipLabel(relationship, index) : '')).filter(Boolean).join('\n')}

        <!-- Legend -->
${renderLegend()}
      </svg>`;
  }

  validateClassDiagram();
  return {
    get layout() { return buildLayoutReport(); },
    get svg() { return renderSvg(); },
  };
}

export function main(argv: string[]): void {
  const layoutJsonMode = argv.includes('--layout-json');
  const { diagram: cd, template, outPath, sourceEvidence } = loadDiagram<ClassDiagram>({
    rendererDir: import.meta.dir,
    diagramType: 'class',
    defaultExample: 'payments.class.json',
    argv: argv.filter((arg) => arg !== '--layout-json'),
  });
  const compiled = compileClass({ class: cd });
  if (layoutJsonMode) {
    console.log(JSON.stringify(compiled.layout, null, 2));
    process.exit(0);
  }
  writeDiagram({
    outPath,
    template,
    diagramType: 'class',
    meta: cd.meta,
    svg: compiled.svg,
    cards: cd.cards,
    sourceEvidence,
  });
}

if (import.meta.main) main(process.argv);
