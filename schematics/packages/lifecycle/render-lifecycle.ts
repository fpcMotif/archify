import { esc, renderDefinitions, renderSemanticSigil, textUnits, SEMANTIC_SIGIL_FOOTPRINT, SOURCE_BADGE_FOOTPRINT, type InfoCard } from '../svg/utils.ts';
import { animateAttr, focusEdgeAttrs, focusNodeAttrs, focusNodeTitle, loadDiagramWithBrandMarks, writeDiagram, svgAccessibleText, svgRootAttrs } from '../svg/cli.ts';
import { throwDiagnosticProblems, type DiagnosticInput } from '../diagnostics/diagnostics.ts';
import { chooseFix, fixFields, setFix } from '../diagnostics/fixes.ts';
import { legendFootprint, resolveLegend, renderLegend as renderResolvedLegend, type LegendConfig, type LegendEntry, type PositionedLegendEntry } from '../svg/legend.ts';
import { availableNodeTextWidth, fittedNodeFontSize, minimumNodeTextWidth, nodeLabelLayout, nodeTextFit } from '../svg/text-fit.ts';
import { brandLabelFitWidth, brandMarkFor, brandMetadataFor, brandTopRailProblem, renderBrandMark } from '../svg/brand-marks.ts';
import { translateMessage as i18nText, type Translations } from '../i18n/i18n.ts';
import { DESKTOP_READER_DIAGRAM_WIDTH, MIN_PROJECTED_NODE_TEXT_PX } from '../diagnostics/desktop-readability.ts';
import { asArray, rectsOverlap, segmentRectClearance, roundedPath, routePointsValue, arrowClassMap, edgeLabelAccent, type Point, type Rect, type Segment } from '../geometry/geometry.ts';

// Lifecycle v3 draws one shape: the main path as a left-to-right row, loops
// back to earlier phases as arcs above it, and every other state (exits,
// waiting or recovery states) in one row below the phase it branches from.
// Geometry is derived from that structure alone; there are no routing controls.

const TEXT = { labelPreferred: 12, labelMinimum: 10, sublabelPreferred: 9, sublabelMinimum: 8, tagPreferred: 8, tagMinimum: 7, step: 8 };
const LABEL_FONT = 10;
const NOTE_FONT = 9;
const STATE_H = 64;
const STATE_MIN_W = 140;
const STATE_MAX_W = 220;
const MARGIN_X = 56;
const MARGIN_TOP = 28;
const PORT_PAD = 22;
const PORT_STEP = 26;
const CORNER = 12;
const FRAME_PAD = 10;
const ARC_BASE = 30;
const ARC_STEP = 24;
const TRACK_STEP = 18;
const LABEL_GAP = 6;
const CLEARANCE = 5;
const SPACING_ROUNDS = 5;

const typeClass: Record<string, string> = {
  start: 'c-frontend', active: 'c-frontend', waiting: 'c-cloud', decision: 'c-database',
  success: 'c-backend', failure: 'c-security', neutral: 'c-external', external: 'c-external',
};
// Ordinary states carry no default corner sigil, so the ones a reader should
// notice (waiting, decision, outcomes, external) stand out. An ordinary state
// that ends the lifecycle is still an outcome and gets a stop sigil.
const QUIET_TYPES = new Set(['start', 'active', 'neutral']);
const textClass: Record<string, string> = {
  start: 't-frontend', active: 't-frontend', waiting: 't-cloud', decision: 't-database',
  success: 't-backend', failure: 't-security', neutral: 't-muted', external: 't-muted',
};

export type LifecycleStateType = 'start' | 'active' | 'waiting' | 'decision' | 'success' | 'failure' | 'neutral' | 'external';
export type LifecycleVariant = 'default' | 'emphasis' | 'security' | 'dashed';

export interface LifecycleState {
  id: string;
  type: LifecycleStateType;
  label: string;
  sublabel?: string;
  tag?: string;
  icon?: string;
  brand?: unknown;
  sources?: readonly unknown[];
  step?: string;
}

export interface LifecycleTransition {
  id?: string;
  from: string;
  to: string;
  label?: string;
  note?: string;
  variant?: LifecycleVariant;
}

export interface LifecycleMeta {
  title: string;
  output: string;
  locale?: string;
  translations?: Translations;
  subtitle?: string;
  animation?: 'trace' | 'none';
  visual_preset?: string;
  quality_profile?: string;
  repository?: unknown;
  views?: unknown;
  legend?: LegendConfig;
}

export interface LifecycleDiagram {
  schema_version: 3;
  diagram_type: 'lifecycle';
  meta: LifecycleMeta;
  mainPath: string[];
  states: LifecycleState[];
  transitions: LifecycleTransition[];
  cards?: InfoCard[];
}

export interface LifecycleSourceEvidence {
  nodes?: Record<string, readonly unknown[] | undefined>;
}

export interface CompileLifecycleOptions {
  lifecycle: LifecycleDiagram;
  sourceEvidence?: LifecycleSourceEvidence | null;
}

interface PlacedState extends LifecycleState {
  width: number;
  height: number;
  x: number;
  cx: number;
  y: number;
  cy: number;
  offset: number;
}

type TransitionKind = 'spine' | 'arc' | 'same' | 'between';
type PortMode = 'partner' | 'even';
type LabelMode = 'above' | 'on' | 'beside' | 'none';

interface Bracket {
  key: string;
  sources: string[];
  targets: string[];
  transitions: LifecycleTransition[];
  frame?: { lo: number; hi: number };
}

interface SingleConnector {
  kind: 'single';
  transition: LifecycleTransition;
  down: boolean;
  upperId: string;
  lowerId: string;
  gap: number;
  order: number;
}

interface BracketConnector {
  kind: 'bracket';
  bracket: Bracket;
  gap: number;
  order: number;
}

interface FrameConnector {
  kind: 'frame';
  bracket: Bracket;
  rect: Rect;
  lowerId: string;
  gap: number;
  order: number;
  exitX?: number;
}

interface LoopConnector {
  kind: 'loop';
  transition: LifecycleTransition;
  gap: number;
  order: number;
}

type Connector = SingleConnector | BracketConnector | FrameConnector | LoopConnector;
type PortKey = Connector | string;

interface Port {
  key: PortKey;
  otherX: number;
  order: number;
  x: number;
}

type Ports = Map<string, Map<PortKey, Port>>;
type PortLookup = (id: string, side: string, key: PortKey) => Port | undefined;

interface Arc {
  transition: LifecycleTransition;
  key: string;
  lo: number;
  hi: number;
  index: number;
  level: number;
}

interface Run {
  connector: Connector;
  tops: number[];
  bottoms: number[];
  lo: number;
  hi: number;
  straight: boolean;
  track?: number;
}

interface Route {
  points: Point[];
  segment: number;
  labelMode: LabelMode;
  bracket?: Bracket;
}

interface LabelRect extends Rect {
  cx: number;
  cy: number;
}

interface LabelPlacement {
  placedLabels: Map<LifecycleTransition, LabelRect>;
  unplacedLabels: LifecycleTransition[];
}

interface LayoutResult extends LabelPlacement {
  routes: Map<LifecycleTransition, Route>;
  junctions: Point[];
  frames: Rect[];
  contentBottom: number;
  contentRight: number;
}

interface Spacing {
  spineGap: number;
  rowGap: number;
  drop: number;
  firstTrack: number;
}

function required<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Lifecycle layout has no entry for ${typeof key === 'string' ? JSON.stringify(key) : 'a transition'}.`);
  return value;
}

function lastOf<T>(items: readonly T[]): T {
  const item = items.at(-1);
  if (item === undefined) throw new Error('Lifecycle layout expected a non-empty list.');
  return item;
}

function portKind(key: PortKey | undefined): Connector | undefined {
  return typeof key === 'object' ? key : undefined;
}

export function compileLifecycle({ lifecycle, sourceEvidence = null }: CompileLifecycleOptions): { svg: string } {
  const transitions = asArray(lifecycle.transitions);
  const mainPath = asArray(lifecycle.mainPath);
  const states = new Map(asArray(lifecycle.states).map((state): [string, PlacedState] => [state.id, { ...state, width: 0, height: 0, x: 0, cx: 0, y: 0, cy: 0, offset: 0 }]));
  const spineIndex = new Map(mainPath.map((id, index): [string, number] => [id, index]));
  const onSpine = (id: string) => spineIndex.has(id);
  const stateOf = (id: string) => required(states, id);

  validateStructure();

  function fonts(state: LifecycleState, width: number): { label: number; sublabel: number; tag: number } {
    return {
      label: fittedNodeFontSize(state.label, brandLabelFitWidth(state, width), TEXT.labelPreferred, TEXT.labelMinimum),
      sublabel: fittedNodeFontSize(state.sublabel ?? '', width, TEXT.sublabelPreferred, TEXT.sublabelMinimum),
      tag: fittedNodeFontSize(state.tag ?? '', width, TEXT.tagPreferred, TEXT.tagMinimum),
    };
  }

  // Wide enough for every row at its preferred size; the label also clears the
  // top-rail decorations (sigil or step, brand, source badge) that share its row.
  function preferredWidth(state: LifecycleState): number {
    const need = (text: string | undefined, font: number) => (text ? textUnits(text) * font * nodeTextFit.widthFactor + nodeTextFit.horizontalPadding + 36 : 0);
    const left = Math.max(SEMANTIC_SIGIL_FOOTPRINT + 2, state.step ? 26 + minimumNodeTextWidth(state.step, TEXT.step) : 0);
    const right = (brandMarkFor(state) ? 26 : 4) + (sourceEvidence?.nodes?.[state.id]?.length ? SOURCE_BADGE_FOOTPRINT : 0);
    const label = minimumNodeTextWidth(state.label, TEXT.labelPreferred) + left + right + 4;
    return Math.ceil(Math.min(STATE_MAX_W, Math.max(STATE_MIN_W,
      label, need(state.sublabel, TEXT.sublabelPreferred), need(state.tag, TEXT.tagPreferred))));
  }

  for (const state of states.values()) {
    state.width = preferredWidth(state);
    state.height = STATE_H;
  }
  const smallestText = Math.min(LABEL_FONT, ...[...states.values()].flatMap((state) => {
    const fitted = fonts(state, state.width);
    return [fitted.label, state.sublabel ? fitted.sublabel : Infinity];
  }));
  const readableWidthBudget = Math.floor(DESKTOP_READER_DIAGRAM_WIDTH * smallestText / MIN_PROJECTED_NODE_TEXT_PX);

  function labelBox(transition: LifecycleTransition): { width: number; height: number } {
    const text = transition.label || '';
    const note = transition.note || '';
    const width = Math.ceil(Math.max(
      text ? textUnits(text) * LABEL_FONT * 0.6 : 0,
      note ? textUnits(note) * NOTE_FONT * 0.6 : 0,
    ) + 12);
    return { width, height: text && note ? 28 : 16 };
  }
  const hasLabel = (transition: LifecycleTransition) => Boolean(transition.label || transition.note);

  // The first forward transition between consecutive main-path states is the
  // row itself; any other main-path pair is an arc above the row.
  const spineEdges = new Map<number, LifecycleTransition>();
  for (const transition of transitions) {
    const from = spineIndex.get(transition.from);
    const to = spineIndex.get(transition.to);
    if (from !== undefined && to === from + 1 && !spineEdges.has(from)) spineEdges.set(from, transition);
  }
  const mainPathStateWidth = mainPath.reduce((sum, id) => sum + stateOf(id).width, 0);
  const minimumSpineGaps = mainPath.slice(0, -1).map((_, index) => {
    const edge = spineEdges.get(index);
    return (edge && hasLabel(edge) ? labelBox(edge).width : 0) + 26;
  });

  // Every other state sits in a row below the main path at its distance from
  // it, so each transition stays within one row or joins two adjacent rows.
  const depth = new Map(mainPath.map((id): [string, number] => [id, 0]));
  for (let frontier = [...mainPath]; frontier.length;) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const transition of transitions) {
        const other = transition.from === id ? transition.to : transition.to === id ? transition.from : null;
        if (other && states.has(other) && !depth.has(other)) {
          depth.set(other, required(depth, id) + 1);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  for (const id of states.keys()) if (!depth.has(id)) depth.set(id, 1);
  const depthOf = (id: string) => required(depth, id);
  const rowCount = Math.max(...depth.values()) + 1;
  const rows = Array.from({ length: rowCount }, (_, row) => (row === 0
    ? mainPath.map((id) => stateOf(id))
    : [...states.values()].filter((state) => depthOf(state.id) === row)));
  const offStates = rows.slice(1).flat();

  const kindOf = new Map(transitions.map((transition): [LifecycleTransition, TransitionKind] => {
    const [from, to] = [depthOf(transition.from), depthOf(transition.to)];
    if (from === 0 && to === 0) return [transition, spineEdges.get(required(spineIndex, transition.from)) === transition ? 'spine' : 'arc'];
    return [transition, from === to ? 'same' : 'between'];
  }));
  const ofKind = (kind: TransitionKind) => transitions.filter((transition) => kindOf.get(transition) === kind);

  // Exits that leave several main-path phases for one state are drawn once:
  // from a composite frame around consecutive phases, or from a shared bus.
  const downByTarget = new Map<string, LifecycleTransition[]>();
  for (const transition of ofKind('between')) {
    if (depthOf(transition.from) !== 0) continue;
    if (!downByTarget.has(transition.to)) downByTarget.set(transition.to, []);
    required(downByTarget, transition.to).push(transition);
  }
  // A merged exit promises one meaning. Only a target with one eligible
  // complete-signature bucket joins a bracket; all other exits stay singles.
  const exitSignature = (transition: LifecycleTransition) => [transition.label ?? '', transition.note ?? '', variantOf(transition)].join('\u0000');
  const brackets = new Map<string, Bracket>();
  for (const [target, list] of downByTarget) {
    const buckets = new Map<string, LifecycleTransition[]>();
    for (const transition of list) {
      const signature = exitSignature(transition);
      if (!buckets.has(signature)) buckets.set(signature, []);
      required(buckets, signature).push(transition);
    }
    const eligible = [...buckets.values()].filter((bucket) => new Set(bucket.map((transition) => transition.from)).size >= 2);
    if (eligible.length !== 1) continue;
    const [group] = eligible;
    const sources = [...new Set(group.map((transition) => transition.from))].sort((a, b) => required(spineIndex, a) - required(spineIndex, b));
    const key = sources.join('\u0000');
    if (!brackets.has(key)) brackets.set(key, { key, sources, targets: [], transitions: [] });
    required(brackets, key).targets.push(target);
    required(brackets, key).transitions.push(...group);
  }
  const bracketOf = new Map<LifecycleTransition, Bracket>();
  for (const bracket of brackets.values()) {
    for (const transition of bracket.transitions) bracketOf.set(transition, bracket);
  }
  // Consecutive main-path phases form a composite state: one frame around them
  // and one exit per target, like a UML superstate transition. Frames never
  // partially overlap; such a bracket keeps a shared bus under its phases.
  const frameSpans: { lo: number; hi: number }[] = [];
  for (const bracket of brackets.values()) {
    const indexes = bracket.sources.map((id) => required(spineIndex, id));
    const lo = Math.min(...indexes);
    const hi = Math.max(...indexes);
    if (hi - lo + 1 !== indexes.length || frameSpans.some((span) => span.lo <= hi && lo <= span.hi)) continue;
    bracket.frame = { lo, hi };
    frameSpans.push(bracket.frame);
  }
  const bracketTargets = new Map<string, Bracket>();
  for (const bracket of brackets.values()) for (const target of bracket.targets) bracketTargets.set(target, bracket);

  const outgoing = new Set(transitions.map((transition) => transition.from));
  const isFinal = (state: LifecycleState) => !outgoing.has(state.id);

  // Each round tries ports pulled toward their partners and ports spread evenly,
  // and keeps the placed layout with the fewest bends and short jogs.
  let spacing: Spacing = { spineGap: 72, rowGap: 44, drop: 58, firstTrack: 34 };
  let laidOut: LayoutResult | null = null;
  // Labels that could not be placed at tighter spacing and prompted retries.
  const spacingWideners = new Set<LifecycleTransition>();
  for (let round = 0; round < SPACING_ROUNDS; round += 1) {
    const candidates = (['partner', 'even'] as const).map((ports) => ({ ports, ...layout({ ...spacing, ports }) }));
    const placed = candidates.filter((candidate) => !candidate.unplacedLabels.length);
    const best = placed.sort((a, b) => routeCost(a.routes) - routeCost(b.routes))[0] || candidates[0];
    // layout() positions the shared states, so the winner is laid out again.
    laidOut = best === candidates.at(-1) ? best : layout({ ...spacing, ports: best.ports });
    if (placed.length) break;
    if (round === 0) {
      const closest = [...candidates].sort((a, b) => a.unplacedLabels.length - b.unplacedLabels.length)[0];
      for (const transition of closest.unplacedLabels) spacingWideners.add(transition);
    }
    const nextSpineGap = spacing.spineGap + 28;
    // The canvas includes this whole row. Widening beyond its text budget
    // cannot succeed; keep its current gaps while other spacing still grows.
    const nextMainPathWidth = MARGIN_X * 2 + mainPathStateWidth
      + minimumSpineGaps.reduce((sum, minimum) => sum + Math.max(nextSpineGap, minimum), 0);
    spacing = { spineGap: nextMainPathWidth > readableWidthBudget ? spacing.spineGap : nextSpineGap,
      rowGap: spacing.rowGap + 28, drop: spacing.drop + 14, firstTrack: spacing.firstTrack + 6 };
  }
  if (!laidOut) throw new Error('lifecycle layout produced no geometry');
  const geometry: LayoutResult = laidOut;

  function routeCost(routes: Map<LifecycleTransition, Route>): number {
    let cost = 0;
    for (const { points } of routes.values()) {
      cost += Math.max(0, points.length - 2) * 10;
      for (let index = 1; index < points.length; index += 1) {
        const run = Math.abs(points[index][0] - points[index - 1][0]);
        if (points.length > 2 && Math.abs(points[index][1] - points[index - 1][1]) < 0.5) cost += run * 0.1 + (run < 30 ? 40 : 0);
      }
    }
    return cost;
  }

  function layout({ spineGap, rowGap, drop, firstTrack, ports: portMode }: Spacing & { ports: PortMode }): LayoutResult {
    // Main-path x positions: each gap fits its row label.
    let cursor = MARGIN_X;
    mainPath.forEach((id, index) => {
      const state = stateOf(id);
      state.x = cursor;
      state.cx = cursor + state.width / 2;
      cursor += state.width + Math.max(spineGap, minimumSpineGaps[index] ?? 26);
    });
    for (let row = 1; row < rowCount; row += 1) placeRow(row, rowGap);

    // Shift horizontally so the leftmost element keeps the margin.
    const minX = Math.min(...[...states.values()].map((state) => state.x));
    const dx = MARGIN_X - minX;
    for (const state of states.values()) { state.x += dx; state.cx += dx; }

    const arcs = assignArcLevels();
    const maxLevel = Math.max(0, ...arcs.map((arc) => arc.level));
    const arcLabelReserve = arcs.some((arc) => hasLabel(arc.transition)) ? 12 : 0;
    const spineTop = MARGIN_TOP + (maxLevel ? ARC_BASE + (maxLevel - 1) * ARC_STEP + arcLabelReserve : 0);

    const ports: Ports = new Map();
    const portOf = (id: string, side: string, key: PortKey) => ports.get(`${id}|${side}`)?.get(key);
    const portAt = (id: string, side: string, key: PortKey): Port => {
      const port = portOf(id, side, key);
      if (!port) throw new Error(`Lifecycle layout has no ${side} port on ${JSON.stringify(id)}.`);
      return port;
    };
    const requestPort = (id: string, side: string, key: PortKey, otherX: number, order: number) => {
      const slot = `${id}|${side}`;
      if (!ports.has(slot)) ports.set(slot, new Map());
      if (!required(ports, slot).has(key)) required(ports, slot).set(key, { key, otherX, order, x: 0 });
    };
    const cx = (id: string) => stateOf(id).cx;

    // Connectors cross the gap below row `gap`: single transitions between two
    // rows, composite frame exits, shared buses, and loops between two
    // non-adjacent states of one row.
    const connectors: Connector[] = [];
    for (const transition of ofKind('between')) {
      if (bracketOf.has(transition)) continue;
      const down = depthOf(transition.from) < depthOf(transition.to);
      const upperId = down ? transition.from : transition.to;
      const lowerId = down ? transition.to : transition.from;
      connectors.push({ kind: 'single', transition, down, upperId, lowerId, gap: depthOf(upperId), order: transitions.indexOf(transition) });
    }
    const frames: Rect[] = [];
    for (const bracket of brackets.values()) {
      const order = transitions.indexOf(bracket.transitions[0]);
      if (!bracket.frame) {
        connectors.push({ kind: 'bracket', bracket, gap: 0, order });
        continue;
      }
      const first = stateOf(mainPath[bracket.frame.lo]);
      const last = stateOf(mainPath[bracket.frame.hi]);
      const rect = { x: first.x - FRAME_PAD, y: spineTop - FRAME_PAD, width: last.x + last.width - first.x + FRAME_PAD * 2, height: STATE_H + FRAME_PAD * 2 };
      frames.push(rect);
      for (const target of bracket.targets) connectors.push({ kind: 'frame', bracket, rect, lowerId: target, gap: 0, order });
    }
    // Neighbours in one lower row connect side to side; others loop underneath.
    const rowOrder = rows.map((list) => [...list].sort((a, b) => a.x - b.x).map((state) => state.id));
    const adjacent = (transition: LifecycleTransition) => transition.from !== transition.to
      && Math.abs(rowOrder[depthOf(transition.from)].indexOf(transition.from) - rowOrder[depthOf(transition.from)].indexOf(transition.to)) === 1;
    const sides = ofKind('same').filter(adjacent);
    // Side labels ride on the line for groups of three or more. Reserve their
    // actual height before placing rows: horizontal gap growth cannot clear a
    // label trapped between two full-width parallel strokes.
    const sideGroups = new Map<string, LifecycleTransition[]>();
    for (const transition of sides) {
      const key = [transition.from, transition.to].sort().join('\u0000');
      if (!sideGroups.has(key)) sideGroups.set(key, []);
      required(sideGroups, key).push(transition);
    }
    const sideLanes: { ordered: LifecycleTransition[]; step: number }[] = [];
    const rowHeights = rows.map(() => STATE_H);
    for (const group of sideGroups.values()) {
      const rightward = (transition: LifecycleTransition) => stateOf(transition.from).x < stateOf(transition.to).x;
      const ordered = [...group.filter(rightward), ...group.filter((transition) => !rightward(transition))];
      if (ordered.length > 5) {
        const message = `${ordered.length} transitions between the neighbouring states "${ordered[0].from}" and "${ordered[0].to}" cannot spread apart on the shared edge; at most five stay legible.`;
        throwDiagnosticProblems('Lifecycle validation failed', [message], {
          subject: { diagramType: 'lifecycle' },
          diagnostics: [structureProblem('lifecycle/crowded-side-transitions', message,
            { collection: 'transitions', from: ordered[0].from, to: ordered[0].to },
            ['merge the triggers into one transition label'])],
        });
      }
      let step = Math.min(20, 48 / (ordered.length - 1));
      if (ordered.length > 2) {
        const heights = ordered.map((transition) => hasLabel(transition) ? labelBox(transition).height : 0);
        step = Math.max(step, ...heights.map((height) => height ? height / 2 + CLEARANCE : 0),
          ...heights.slice(1).map((height, index) => height && heights[index] ? (height + heights[index]) / 2 + 4 : 0));
        const row = depthOf(ordered[0].from);
        // Keep every side port eight pixels inside the rounded state corners.
        rowHeights[row] = Math.max(rowHeights[row], step * (ordered.length - 1) + 16);
      }
      sideLanes.push({ ordered, step });
    }
    for (const transition of ofKind('same').filter((transition) => !adjacent(transition))) {
      connectors.push({ kind: 'loop', transition, gap: depthOf(transition.from), order: transitions.indexOf(transition) });
    }

    for (const connector of connectors) {
      if (connector.kind === 'single') {
        requestPort(connector.upperId, 'bottom', connector, cx(connector.lowerId), connector.order);
        requestPort(connector.lowerId, 'top', connector, cx(connector.upperId), connector.order);
      } else if (connector.kind === 'frame') {
        requestPort(connector.lowerId, 'top', connector, connector.rect.x + connector.rect.width / 2, connector.order);
      } else if (connector.kind === 'loop') {
        const { from, to } = connector.transition;
        if (from === to) {
          requestPort(from, 'bottom', `${connector.order}:out`, Infinity, 0);
          requestPort(from, 'bottom', `${connector.order}:in`, Infinity, 1);
        } else {
          requestPort(from, 'bottom', `${connector.order}:out`, cx(to), connector.order);
          requestPort(to, 'bottom', `${connector.order}:in`, cx(from), connector.order);
        }
      } else {
        const { sources, targets } = connector.bracket;
        const dropCenter = targets.reduce((sum, id) => sum + cx(id), 0) / targets.length;
        const sourceCenter = sources.reduce((sum, id) => sum + cx(id), 0) / sources.length;
        for (const id of sources) requestPort(id, 'bottom', connector, dropCenter, connector.order);
        for (const id of targets) requestPort(id, 'top', connector, sourceCenter, connector.order);
      }
    }
    for (const arc of arcs) {
      const { transition } = arc;
      if (transition.from === transition.to) {
        requestPort(transition.from, 'top', `${arc.key}:out`, Infinity, 0);
        requestPort(transition.from, 'top', `${arc.key}:in`, Infinity, 1);
      } else {
        requestPort(transition.from, 'top', `${arc.key}:out`, cx(transition.to), 0);
        requestPort(transition.to, 'top', `${arc.key}:in`, cx(transition.from), 0);
      }
    }
    distributePorts(ports, arcs, portMode);
    placeFrameExits(connectors, ports, portOf);

    // Each gap assigns its horizontal runs to tracks, then the next row follows.
    const runs = connectors.map((connector): Run => {
      if (connector.kind === 'loop') {
        const { from, to } = connector.transition;
        const tops = [portAt(from, 'bottom', `${connector.order}:out`).x, portAt(to, 'bottom', `${connector.order}:in`).x];
        return { connector, tops, bottoms: [], lo: Math.min(...tops), hi: Math.max(...tops), straight: false };
      }
      if (connector.kind === 'bracket') {
        const { sources, targets } = connector.bracket;
        const tops = sources.map((id) => portAt(id, 'bottom', connector).x);
        const bottoms = targets.map((id) => portAt(id, 'top', connector).x);
        const xs = [...tops, ...bottoms];
        return { connector, tops, bottoms, lo: Math.min(...xs), hi: Math.max(...xs), straight: false };
      }
      const top = connector.kind === 'frame' ? connector.exitX ?? 0 : portAt(connector.upperId, 'bottom', connector).x;
      const bottom = portAt(connector.lowerId, 'top', connector).x;
      return { connector, tops: [top], bottoms: [bottom], lo: Math.min(top, bottom), hi: Math.max(top, bottom), straight: Math.abs(top - bottom) < 0.5 };
    });
    const rowTop = [spineTop];
    const trackY: ((track: number) => number)[] = [];
    for (let row = 0; row < rowCount; row += 1) {
      for (const state of rows[row]) {
        state.y = rowTop[row];
        state.height = rowHeights[row];
        state.cy = rowTop[row] + state.height / 2;
      }
      const bottom = rowTop[row] + rowHeights[row];
      const count = assignTracks(runs.filter((run) => run.connector.gap === row));
      trackY[row] = (track) => bottom + firstTrack + track * TRACK_STEP;
      if (row + 1 < rowCount) rowTop.push((count ? trackY[row](count - 1) : bottom + firstTrack) + drop);
    }
    const rowBottom = (row: number) => rowTop[row] + rowHeights[row];

    // Routes, keyed by transition.
    const routes = new Map<LifecycleTransition, Route>();
    const junctions: Point[] = [];
    for (const [index, transition] of spineEdges) {
      const from = stateOf(mainPath[index]);
      const to = stateOf(mainPath[index + 1]);
      routes.set(transition, { points: [[from.x + from.width, from.cy], [to.x, to.cy]], segment: 0, labelMode: 'above' });
    }
    for (const arc of arcs) {
      const { transition } = arc;
      const out = portAt(transition.from, 'top', `${arc.key}:out`).x;
      const inn = portAt(transition.to, 'top', `${arc.key}:in`).x;
      const y = spineTop - ARC_BASE - (arc.level - 1) * ARC_STEP;
      routes.set(transition, { points: [[out, spineTop], [out, y], [inn, y], [inn, spineTop]], segment: 1, labelMode: 'on' });
    }
    for (const run of runs) {
      const { connector } = run;
      const { gap } = connector;
      const y = trackY[gap](run.track ?? 0);
      const upper = rowBottom(gap);
      const lower = rowTop[gap + 1];
      if (connector.kind === 'loop') {
        const [a, b] = run.tops;
        routes.set(connector.transition, { points: [[a, upper], [a, y], [b, y], [b, upper]], segment: 1, labelMode: 'on' });
        continue;
      }
      if (connector.kind === 'single' || connector.kind === 'frame') {
        const [top] = run.tops;
        const [bottom] = run.bottoms;
        const start = connector.kind === 'frame' ? connector.rect.y + connector.rect.height : upper;
        const down: Point[] = run.straight ? [[top, start], [top, lower]] : [[top, start], [top, y], [bottom, y], [bottom, lower]];
        if (connector.kind === 'single') {
          const points = connector.down ? down : [...down].reverse();
          routes.set(connector.transition, { points, segment: connector.down ? points.length - 2 : 0, labelMode: 'beside' });
        } else {
          connector.bracket.transitions.filter((transition) => transition.to === connector.lowerId)
            .forEach((transition, index) => routes.set(transition, {
              points: down, segment: down.length - 2, labelMode: index ? 'none' : 'beside', bracket: connector.bracket,
            }));
        }
        continue;
      }
      const { bracket } = connector;
      const labelled = new Set<string>();
      for (const transition of bracket.transitions) {
        const tick = portAt(transition.from, 'bottom', connector).x;
        const dropX = portAt(transition.to, 'top', connector).x;
        const points: Point[] = Math.abs(tick - dropX) < 0.5
          ? [[tick, upper], [tick, lower]]
          : [[tick, upper], [tick, y], [dropX, y], [dropX, lower]];
        const owner = !labelled.has(transition.to);
        labelled.add(transition.to);
        routes.set(transition, { points, segment: points.length - 2, labelMode: owner ? 'beside' : 'none', bracket });
      }
      for (const x of [...run.tops, ...run.bottoms]) {
        if (x > run.lo + 0.5 && x < run.hi - 0.5) junctions.push([x, y]);
      }
    }
    // Parallel transitions between two neighbours spread symmetrically around
    // the shared edge, left-to-right ones first; a reciprocal pair lands at ±10.
    for (const { ordered, step } of sideLanes) {
      ordered.forEach((transition, index) => {
        const from = stateOf(transition.from);
        const to = stateOf(transition.to);
        const y = from.cy + (index - (ordered.length - 1) / 2) * step;
        const points: Point[] = from.x < to.x ? [[from.x + from.width, y], [to.x, y]] : [[from.x, y], [to.x + to.width, y]];
        // With three or more parallels the inner strokes leave no lane for a
        // floating label, so their labels ride on the line like arc labels.
        routes.set(transition, { points, segment: 0, labelMode: ordered.length > 2 ? 'on' : 'above' });
      });
    }

    const stateRight = Math.max(...[...states.values()].map((state) => state.x + state.width));
    const placed = placeLabels({ routes, contentRight: stateRight });
    const boxes = [...states.values(), ...placed.placedLabels.values()];
    const contentBottom = Math.max(
      ...boxes.map((box) => box.y + box.height),
      ...[...routes.values()].flatMap((route) => route.points.map((point) => point[1])),
    );
    const contentRight = Math.max(...boxes.map((box) => box.x + box.width));
    return { routes, junctions, frames, contentBottom, contentRight, ...placed };
  }

  // A composite exit leaves the frame directly above its target when possible,
  // clear of the inner phases' own connectors and of sibling exits.
  function placeFrameExits(connectors: Connector[], ports: Ports, portOf: PortLookup): void {
    const frameConnectors = connectors.filter((connector): connector is FrameConnector => connector.kind === 'frame');
    for (const connector of frameConnectors) {
      const { rect, bracket } = connector;
      const frame = bracket.frame ?? { lo: 0, hi: -1 };
      const inner = mainPath.slice(frame.lo, frame.hi + 1)
        .flatMap((id) => [...(ports.get(`${id}|bottom`)?.values() || [])].map((port) => port.x));
      const taken = [...inner, ...frameConnectors.flatMap((other) => other.rect === rect && other.exitX !== undefined ? [other.exitX] : [])];
      const target = portOf(connector.lowerId, 'top', connector);
      if (!target) throw new Error(`Lifecycle layout has no top port on ${JSON.stringify(connector.lowerId)}.`);
      const low = rect.x + 16;
      const high = rect.x + rect.width - 16;
      const wanted = Math.min(high, Math.max(low, target.x));
      const free = (x: number) => x >= low && x <= high && taken.every((other) => Math.abs(other - x) >= 14);
      let exitX = wanted;
      for (let step = 0; step <= 40 && !free(exitX); step += 1) {
        exitX = [wanted + step * 7, wanted - step * 7].find(free) ?? exitX;
      }
      connector.exitX = exitX;
      // Snap the target's port to the exit when that keeps its spacing.
      const delta = Math.abs(exitX - target.x);
      if (delta >= 0.5 && delta < 24) {
        const state = stateOf(connector.lowerId);
        const others = [...required(ports, `${connector.lowerId}|top`).values()].filter((port) => port !== target);
        if (exitX >= state.x + 12 && exitX <= state.x + state.width - 12 && others.every((port) => Math.abs(port.x - exitX) >= 12)) {
          target.x = exitX;
        } else if (delta < 16) {
          connector.exitX = [target.x, exitX + Math.sign(exitX - target.x || 1) * (16 - delta)].find(free) ?? exitX;
        }
      }
    }
  }

  // Each lower row starts every state under the states it connects to in the
  // row above; overlapping blocks merge and centre on their combined ideal.
  function placeRow(row: number, rowGap: number): void {
    const members = rows[row];
    const ideal = new Map<string, number>();
    for (const state of members) {
      const xs = transitions.flatMap((transition) => {
        const other = transition.to === state.id ? transition.from : transition.from === state.id ? transition.to : null;
        return other && depthOf(other) === row - 1 ? [stateOf(other).cx] : [];
      });
      if (xs.length) ideal.set(state.id, xs.reduce((sum, x) => sum + x, 0) / xs.length);
    }
    if (row === 1) {
      for (const bracket of brackets.values()) {
        const center = bracket.sources.reduce((sum, id) => sum + stateOf(id).cx, 0) / bracket.sources.length;
        bracket.targets.forEach((id) => ideal.set(id, center));
      }
    }
    const fallback = Math.max(...mainPath.map((id) => stateOf(id).cx)) + 1;
    const blocks: { members: PlacedState[]; ideal: number; weight: number; order: number }[] = [];
    const grouped = new Set<string>();
    for (const state of members) {
      if (grouped.has(state.id)) continue;
      const bracket = row === 1 ? bracketTargets.get(state.id) : null;
      const list = bracket ? bracket.targets.map((id) => stateOf(id)) : [state];
      list.forEach((member) => grouped.add(member.id));
      blocks.push({ members: list, ideal: ideal.get(state.id) ?? fallback, weight: ideal.has(state.id) ? list.length : 0.05, order: members.indexOf(state) });
    }
    // Neighbours joined by a labelled transition keep room for its label.
    type Block = (typeof blocks)[number];
    const gapBetween = (left: PlacedState, right: PlacedState) => Math.max(rowGap, ...transitions
      .filter((transition) => hasLabel(transition) && ((transition.from === left.id && transition.to === right.id)
        || (transition.from === right.id && transition.to === left.id)))
      .map((transition) => labelBox(transition).width + 32));
    blocks.sort((a, b) => a.ideal - b.ideal || a.order - b.order);
    // Lay a cluster of blocks side by side and return each block's centre offset.
    const arrange = (list: Block[]) => {
      const offsets: number[] = [];
      let x = 0;
      let previous: PlacedState | null = null;
      for (const block of list) {
        const start = x;
        for (const member of block.members) {
          if (previous) x += gapBetween(previous, member);
          member.offset = x;
          x += member.width;
          previous = member;
        }
        offsets.push((start + x) / 2);
      }
      return { width: x, offsets: offsets.map((offset) => offset - x / 2) };
    };
    // A cluster's centre is the weighted mean of (ideal - offset) over its
    // blocks, which minimises their squared drift.
    const centre = (list: Block[]) => {
      const { width, offsets } = arrange(list);
      const weight = list.reduce((sum, block) => sum + block.weight, 0);
      return { width, x: list.reduce((sum, block, index) => sum + block.weight * (block.ideal - offsets[index]), 0) / weight };
    };
    const clusters: Block[][] = [];
    for (const block of blocks) {
      clusters.push([block]);
      while (clusters.length > 1) {
        const last = clusters[clusters.length - 1];
        const previous = clusters[clusters.length - 2];
        const a = centre(previous);
        const b = centre(last);
        if (a.x + a.width / 2 + gapBetween(lastOf(lastOf(previous).members), last[0].members[0]) <= b.x - b.width / 2) break;
        clusters.splice(-2, 2, [...previous, ...last]);
      }
    }
    for (const cluster of clusters) {
      const { x, width } = centre(cluster);
      arrange(cluster);
      for (const block of cluster) {
        for (const member of block.members) {
          member.x = x - width / 2 + member.offset;
          member.cx = member.x + member.width / 2;
        }
      }
    }
  }

  // Arcs nest by span: a shorter arc stays lower; overlapping spans never share a level.
  function assignArcLevels(): Arc[] {
    const arcs = ofKind('arc').map((transition, index): Arc => {
      const a = required(spineIndex, transition.from);
      const b = required(spineIndex, transition.to);
      return { transition, key: `arc${transitions.indexOf(transition)}`, lo: Math.min(a, b), hi: Math.max(a, b), index, level: 0 };
    });
    const sorted = [...arcs].sort((left, right) => (left.hi - left.lo) - (right.hi - right.lo) || left.lo - right.lo || left.index - right.index);
    for (const arc of sorted) {
      const blocking = sorted.filter((other) => other !== arc && other.level
        && ((other.lo < arc.hi && arc.lo < other.hi) || (other.lo === other.hi && arc.lo < other.lo && other.lo < arc.hi)
          || (other.lo === arc.lo && other.hi === arc.hi)));
      arc.level = 1 + Math.max(0, ...blocking.map((other) => other.level));
    }
    return arcs;
  }

  // Port order on one side avoids crossings: connections toward the left use
  // the left part of the side, connections toward the right the right part.
  // Nested arcs put the outer (higher) arc's port furthest out and spread evenly;
  // every other port moves toward its partner so connectors can drop straight.
  function distributePorts(ports: Ports, arcs: Arc[], mode: PortMode): void {
    const arcLevel = new Map<PortKey, number>(arcs.flatMap((arc): [string, number][] => [[`${arc.key}:out`, arc.level], [`${arc.key}:in`, arc.level]]));
    // Lower-row tops follow the upper ports they connect to, so place them last.
    const lowerTop = ([slot]: readonly [string, ...unknown[]]) => slot.endsWith('|top') && !onSpine(slot.split('|')[0]);
    const slots = [...ports].sort((a, b) => Number(lowerTop(a)) - Number(lowerTop(b)));
    for (const [slot, entries] of slots) {
      const id = slot.split('|')[0];
      const state = stateOf(id);
      const list = [...entries.values()];
      if (lowerTop([slot])) {
        for (const port of list) {
          const key = portKind(port.key);
          const upper = key?.kind === 'single' ? ports.get(`${key.upperId}|bottom`)?.get(key) : null;
          if (upper) port.otherX = upper.x;
        }
      }
      list.sort((left, right) => {
        const leftDirection = Math.sign(left.otherX - state.cx);
        const rightDirection = Math.sign(right.otherX - state.cx);
        if (leftDirection !== rightDirection) return leftDirection - rightDirection;
        const leftLevel = arcLevel.get(left.key);
        const rightLevel = arcLevel.get(right.key);
        if (leftLevel !== undefined && rightLevel !== undefined && leftLevel !== rightLevel) {
          // An outer arc's riser must stay outside every inner span it rises past.
          return leftDirection < 0 ? leftLevel - rightLevel : rightLevel - leftLevel;
        }
        return left.otherX - right.otherX || left.order - right.order;
      });
      const usable = state.width - PORT_PAD * 2;
      const step = list.length > 1 ? Math.min(PORT_STEP, usable / (list.length - 1)) : 0;
      const xs = mode === 'even' || (onSpine(id) && slot.endsWith('|top'))
        ? list.map((_, index) => state.cx - (step * (list.length - 1)) / 2 + index * step)
        : fitPorts(list.map((port) => port.otherX), step, state.x + PORT_PAD, state.x + state.width - PORT_PAD);
      list.forEach((port, index) => { port.x = Math.round(xs[index] * 10) / 10; });
    }
    snapPorts(ports, mode);
  }

  // Ordered ports as close to their wanted x as the step and side allow: a pool
  // of adjacent violators (isotonic regression on wanted - index * step).
  function fitPorts(wanted: number[], step: number, low: number, high: number): number[] {
    const n = wanted.length;
    const top = high - step * (n - 1);
    const clamp = (x: number) => Math.min(Math.max(x, low), Math.max(low, top));
    const pools: { sum: number; count: number }[] = [];
    wanted.forEach((x, index) => {
      pools.push({ sum: (Number.isFinite(x) ? x : x > 0 ? high : low) - index * step, count: 1 });
      while (pools.length > 1 && pools[pools.length - 2].sum / pools[pools.length - 2].count > pools[pools.length - 1].sum / pools[pools.length - 1].count) {
        const last = lastOf(pools);
        pools.pop();
        lastOf(pools).sum += last.sum;
        lastOf(pools).count += last.count;
      }
    });
    return pools.flatMap((pool): number[] => Array(pool.count).fill(clamp(pool.sum / pool.count))).map((x, index) => x + index * step);
  }

  // A nearly vertical connector becomes exactly vertical when a port can move
  // without crowding its neighbours; otherwise its jog widens to a readable run.
  function snapPorts(ports: Ports, mode: PortMode): void {
    const fits = (id: string, side: string, moving: Port, x: number) => {
      const state = stateOf(id);
      return x >= state.x + PORT_PAD - 8 && x <= state.x + state.width - PORT_PAD + 8
        && [...required(ports, `${id}|${side}`).values()].every((other) => other === moving || Math.abs(other.x - x) >= 12);
    };
    for (const [slot, entries] of ports) {
      if (!slot.endsWith('|top')) continue;
      const lowerId = slot.split('|')[0];
      if (onSpine(lowerId)) continue;
      // Validate the final group, since neighboring ports may move together.
      const group = [...entries.values()].sort((a, b) => a.x - b.x);
      const state = stateOf(lowerId);
      const targets = group.map((port) => {
        const key = portKind(port.key);
        return key?.kind === 'single' ? ports.get(`${key.upperId}|bottom`)?.get(key)?.x : undefined;
      });
      const snapped = targets.flatMap((x) => (x !== undefined && Number.isFinite(x) ? [x] : []));
      if (snapped.length === targets.length && snapped.every((x, index) => x >= state.x + PORT_PAD - 8 && x <= state.x + state.width - PORT_PAD + 8
        && (index === 0 || x - snapped[index - 1] >= 12))) {
        group.forEach((port, index) => { port.x = snapped[index]; });
        continue;
      }
      for (const port of entries.values()) {
        const connector = portKind(port.key);
        if (connector?.kind === 'single') {
          const upperPort = required(required(ports, `${connector.upperId}|bottom`), connector);
          const delta = Math.abs(upperPort.x - port.x);
          if (delta < 0.5 || (delta >= 16 && mode === 'even')) continue;
          if (fits(lowerId, 'top', port, upperPort.x)) port.x = upperPort.x;
          else if (delta >= 16) continue;
          else if (fits(connector.upperId, 'bottom', upperPort, port.x)) upperPort.x = port.x;
          else {
            const away = Math.sign(port.x - upperPort.x) || 1;
            const pushed = [upperPort.x + away * 16, upperPort.x - away * 16].find((x) => fits(lowerId, 'top', port, x));
            if (pushed !== undefined) port.x = pushed;
          }
        } else if (connector?.kind === 'bracket') {
          // A drop next to a tick would leave a micro run on the shared bus.
          const ticks = connector.bracket.sources.map((id) => required(required(ports, `${id}|bottom`), connector).x);
          const near = ticks.find((x) => Math.abs(x - port.x) >= 0.5 && Math.abs(x - port.x) < 16);
          if (near !== undefined && fits(lowerId, 'top', port, near)) port.x = near;
        }
      }
    }
  }

  // Greedy interval tracks for one gap, trying several orderings and keeping
  // the one with the fewest crossings.
  function assignTracks(runs: Run[]): number {
    const needs = runs.filter((run) => !run.straight);
    if (!needs.length) return 0;
    const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
    const direction = (run: Run) => (run.bottoms.length ? Math.sign(mean(run.bottoms) - mean(run.tops)) : 0);
    const start = (run: Run) => mean(run.tops);
    const byStart = (a: Run, b: Run) => (direction(a) >= 0 ? start(b) - start(a) : start(a) - start(b));
    const loopsFirst = (a: Run, b: Run) => (a.bottoms.length ? 1 : 0) - (b.bottoms.length ? 1 : 0);
    const orderings = [
      [...needs].sort((a, b) => (direction(b) - direction(a)) || byStart(a, b)),
      [...needs].sort((a, b) => (direction(a) - direction(b)) || byStart(a, b)),
      [...needs].sort((a, b) => (a.hi - a.lo) - (b.hi - b.lo)),
      [...needs].sort((a, b) => loopsFirst(a, b) || (a.hi - a.lo) - (b.hi - b.lo)),
      [...needs].sort((a, b) => -loopsFirst(a, b) || (a.hi - a.lo) - (b.hi - b.lo)),
    ];
    let best: { assignment: Map<Run, number>; crossings: number; count: number } | null = null;
    for (const ordering of orderings) {
      const tracks: Run[][] = [];
      const assignment = new Map<Run, number>();
      for (const run of ordering) {
        let track = 0;
        while (tracks[track]?.some((other) => other.lo - 10 < run.hi && run.lo < other.hi + 10)) track += 1;
        (tracks[track] ||= []).push(run);
        assignment.set(run, track);
      }
      const crossings = countCrossings(runs, assignment);
      if (!best || crossings < best.crossings || (crossings === best.crossings && tracks.length < best.count)) {
        best = { assignment, crossings, count: tracks.length };
      }
    }
    if (!best) return 0;
    const chosen = best;
    for (const run of needs) run.track = chosen.assignment.get(run);
    return chosen.count;
  }

  function countCrossings(runs: Run[], assignment: Map<Run, number>): number {
    // Verticals run from the upper row (y 0) to a track, then on to the lower row (y 1000).
    const pieces = runs.map((run): { verticals: [number, number, number][]; horizontals: [number, number, number][] } => {
      const track = assignment.get(run);
      if (track === undefined) return { verticals: [[run.tops[0], 0, 1000]], horizontals: [] };
      const y = 10 + track;
      return {
        verticals: [...run.tops.map((x): [number, number, number] => [x, 0, y]), ...run.bottoms.map((x): [number, number, number] => [x, y, 1000])],
        horizontals: [[y, run.lo, run.hi]],
      };
    });
    let count = 0;
    for (let left = 0; left < pieces.length; left += 1) {
      for (let right = 0; right < pieces.length; right += 1) {
        if (left === right) continue;
        for (const [x, y1, y2] of pieces[left].verticals) {
          for (const [y, x1, x2] of pieces[right].horizontals) {
            if (x > x1 + 0.5 && x < x2 - 0.5 && y > y1 && y < y2) count += 1;
          }
        }
      }
    }
    return count;
  }

  // Labels sit beside the segment that enters the target (or leaves the lower
  // row), above main-path arrows, and on arc and lower-loop runs. Every
  // candidate keeps clear of other routes, states and labels.
  function placeLabels({ routes, contentRight }: { routes: Map<LifecycleTransition, Route>; contentRight: number }): LabelPlacement {
    const placedLabels = new Map<LifecycleTransition, LabelRect>();
    const unplacedLabels: LifecycleTransition[] = [];
    const segmentsOf = (transition: LifecycleTransition): Segment[] => {
      const points = routes.get(transition)?.points || [];
      return points.slice(1).map((end, index) => ({ start: points[index], end }));
    };
    const siblings = (transition: LifecycleTransition) => {
      const bracket = routes.get(transition)?.bracket;
      return bracket ? bracket.transitions.filter((other) => other.to === transition.to) : [transition];
    };
    const others = (transition: LifecycleTransition) => transitions.filter((other) => !siblings(transition).includes(other));
    for (const transition of transitions) {
      const route = routes.get(transition);
      if (!route || route.labelMode === 'none' || !hasLabel(transition)) continue;
      const { width, height } = labelBox(transition);
      const [start, end] = [route.points[route.segment], route.points[route.segment + 1]];
      const candidates: LabelRect[] = [];
      const at = (cx: number, cy: number): LabelRect => ({ x: cx - width / 2, y: cy - height / 2, width, height, cx, cy });
      if (route.labelMode === 'above') {
        const mid = (start[0] + end[0]) / 2;
        candidates.push(at(mid, start[1] - LABEL_GAP - height / 2), at(mid, start[1] + LABEL_GAP + height / 2));
      } else if (route.labelMode === 'on') {
        for (const fraction of [0.5, 0.35, 0.65, 0.2, 0.8]) {
          candidates.push(at(start[0] + (end[0] - start[0]) * fraction, start[1]));
        }
      } else {
        const verticals = route.points.slice(1).map((point, index): [Point, Point] => [route.points[index], point])
          .filter(([a, b]) => Math.abs(a[0] - b[0]) < 0.5);
        const preferred: [Point, Point][] = [[start, end], ...verticals.filter(([a]) => a !== start)];
        const rowState = stateOf(depthOf(transition.to) < depthOf(transition.from) ? transition.from : transition.to);
        for (const [a, b] of preferred) {
          const x = a[0];
          const mid = (a[1] + b[1]) / 2;
          const sides = x <= rowState.cx ? [-1, 1] : [1, -1];
          for (const side of sides) {
            for (const shift of [0, -10, 10]) candidates.push(at(x + side * (LABEL_GAP + width / 2), mid + shift));
          }
        }
        const horizontal = route.points.slice(1).map((point, index): [Point, Point] => [route.points[index], point])
          .find(([a, b]) => Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[0] - b[0]) > width + 8);
        if (horizontal) candidates.push(at((horizontal[0][0] + horizontal[1][0]) / 2, horizontal[0][1]));
      }
      const otherSegments = others(transition).flatMap(segmentsOf);
      const ownSegments = siblings(transition).flatMap(segmentsOf);
      const free = (rect: LabelRect) => rect.x >= 8 && rect.x + rect.width <= contentRight + MARGIN_X - 8 && rect.y >= 4
        && [...states.values()].every((state) => !rectsOverlap(rect, state, 4))
        && [...placedLabels.values()].every((other) => !rectsOverlap(rect, other, 4))
        && otherSegments.every((segment) => (segmentRectClearance(segment, rect) ?? Infinity) >= CLEARANCE)
        && (route.labelMode === 'on' || ownSegments.every((segment) => (segmentRectClearance(segment, rect) ?? Infinity) >= LABEL_GAP - 1));
      const chosen = candidates.find(free);
      if (chosen) placedLabels.set(transition, chosen);
      else {
        unplacedLabels.push(transition);
        placedLabels.set(transition, candidates[0]);
      }
    }
    return { placedLabels, unplacedLabels };
  }

  function structureProblem(code: string, message: string, subject: Record<string, unknown>, supportedFixes: readonly unknown[]) {
    return { code, severity: 'error', message, subject: { diagramType: 'lifecycle', ...subject }, evidence: {}, ...fixFields(supportedFixes) };
  }

  function validateStructure(): void {
    const diagnostics: DiagnosticInput[] = [];
    const problems: string[] = [];
    const add = (...args: Parameters<typeof structureProblem>) => {
      const diagnostic = structureProblem(...args);
      diagnostics.push(diagnostic);
      problems.push(diagnostic.message);
    };
    if (states.size !== asArray(lifecycle.states).length) {
      add('lifecycle/duplicate-state', 'State ids must be unique.', { collection: 'states' }, ['give every state a unique id']);
    }
    const ids = [...states.keys()];
    mainPath.forEach((id, index) => {
      if (!states.has(id)) {
        add('lifecycle/unknown-main-path-state', `mainPath[${index}] "${id}" is not a state.`, { path: `/mainPath/${index}` },
          ids.length ? [chooseFix(ids.slice(0, 3).map((known) => setFix(`/mainPath/${index}`, known, { label: 'state id' })))] : []);
      }
    });
    if (new Set(mainPath).size !== mainPath.length) {
      add('lifecycle/repeated-main-path-state', 'mainPath lists a state more than once; a return to an earlier phase is a transition, not a repeated step.',
        { path: '/mainPath' }, ['list each main-path state once and keep the return as a transition']);
    }
    transitions.forEach((transition, index) => {
      for (const field of ['from', 'to'] as const) {
        if (states.has(transition[field])) continue;
        add('lifecycle/unknown-endpoint', `Transition ${index} references unknown ${field === 'from' ? 'source' : 'target'} "${transition[field]}".`,
          { collection: 'transitions', path: `/transitions/${index}/${field}`, transition: transition.id ?? null },
          ids.length ? [chooseFix(ids.slice(0, 3).map((known) => setFix(`/transitions/${index}/${field}`, known, { label: 'state id' })))] : []);
      }
    });
    for (let index = 0; index + 1 < mainPath.length; index += 1) {
      const [from, to] = [mainPath[index], mainPath[index + 1]];
      if (!transitions.some((transition) => transition.from === from && transition.to === to)) {
        add('lifecycle/main-path-gap', `mainPath step "${from}" -> "${to}" has no transition.`, { path: `/mainPath/${index}` },
          [`add a transition from "${from}" to "${to}"`, 'remove the state from mainPath if it is not on the happy path']);
      }
    }
    asArray(lifecycle.states).forEach((state, index) => {
      const brandRail = brandTopRailProblem(state, preferredWidth(state), TEXT.labelMinimum, 'State');
      if (brandRail) problems.push(brandRail);
      for (const [field, name, minimum] of [['label', 'Label', TEXT.labelMinimum], ['sublabel', 'Sublabel', TEXT.sublabelMinimum], ['tag', 'Tag', TEXT.tagMinimum]] as const) {
        const value = state[field];
        const needed = Math.ceil(minimumNodeTextWidth(value || '', minimum));
        const available = availableNodeTextWidth(STATE_MAX_W) - (field === 'label' && brandMarkFor(state) ? 26 : 0);
        if (value && needed > available) {
          add('lifecycle/state-text-too-long',
            `${name} "${value}" of state "${state.id}" is wider than the widest ${STATE_MAX_W}px state: it needs ~${needed}px at the ${minimum}px legible minimum, but ${available}px fit — shorten the ${field} and move detail into a card.`,
            { collection: 'states', path: `/states/${index}/${field}` }, [`shorten the ${field} and move detail into a card`]);
        }
      }
    });
    if (problems.length) throwDiagnosticProblems('Lifecycle validation failed', problems, { subject: { diagramType: 'lifecycle' }, diagnostics });
  }

  function validateLayout(): void {
    const problems: string[] = [];
    const diagnostics: DiagnosticInput[] = [];
    // The common width factor cancels when comparing the two text lines.
    const widthDriver = (transition: LifecycleTransition) => {
      const label = textUnits(transition.label || '') * LABEL_FONT;
      const note = textUnits(transition.note || '') * NOTE_FONT;
      return label === note ? 'label+note' : label > note ? 'label' : 'note';
    };
    const preserveConditions = 'preserve every condition; shorten wording only, or move complete detail to a card explicitly associated with the same transition; shorter wording may not resolve other layout constraints';
    if (viewBox[0] > readableWidthBudget) {
      // A labelled main-path step widens its gap past the default spacing.
      const wideStepLabels = mainPath.slice(0, -1).flatMap((id, index) => {
        const edge = spineEdges.get(index);
        const excessPx = edge && hasLabel(edge) ? Math.round(labelBox(edge).width + 26 - spacing.spineGap) : 0;
        return edge && excessPx > 0 ? [{ from: edge.from, to: edge.to, label: edge.label || edge.note, excessPx, widthDriver: widthDriver(edge) }] : [];
      }).sort((a, b) => b.excessPx - a.excessPx);
      const widenerLabels = [...spacingWideners].map((transition) => `"${transition.label || transition.note}"`);
      const labelFixes = [
        ...(widenerLabels.length ? [`relieve the routes crowding ${widenerLabels.join(', ')}: those label/note boxes found no clear spot at the base spacing, so lower-row and route spacing grew; main-path gap growth is bounded by the text readability budget. Only equivalent exits with identical labels, notes and variants can share an arrow; keep distinct notes separate, or move a secondary transition elsewhere`] : []),
        ...(wideStepLabels.length ? [`review the width-driving main-path transition text: ${wideStepLabels.map((step) => `"${step.from}" -> "${step.to}" ${step.widthDriver.replace('+', ' and ')} (+${step.excessPx}px)`).join(', ')}; ${preserveConditions}`] : []),
      ];
      const message = `The lifecycle is ${viewBox[0]}px wide; at ${smallestText}px text it stays readable on a desktop only up to ${readableWidthBudget}px.${wideStepLabels.length ? ` Transition labels or notes widen their main-path gaps.` : ''}`;
      diagnostics.push({
        code: 'lifecycle/too-wide', severity: 'error', message,
        subject: { diagramType: 'lifecycle', path: '/mainPath' },
        evidence: { viewBoxWidth: viewBox[0], budgetPx: readableWidthBudget, mainPathStates: mainPath.length, lowerRowStates: offStates.length, wideStepLabels, spacingWideners: [...spacingWideners].map((transition) => ({ from: transition.from, to: transition.to, label: transition.label || transition.note, widthDriver: widthDriver(transition) })) },
        supportedFixes: [...labelFixes, 'shorten state labels and sublabels', 'move secondary phases off mainPath or merge adjacent phases', 'split the lifecycle into two diagrams'],
      });
      problems.push(message);
    }
    for (const transition of geometry.unplacedLabels) {
      const message = `Transition "${transition.from}" -> "${transition.to}" label "${transition.label || transition.note}" cannot be placed clear of nearby routes.${transition.note ? ' Its note contributes to the label box; the box size and nearby geometry both affect placement.' : ''}`;
      diagnostics.push({
        code: 'lifecycle/label-unplaced', severity: 'error', message,
        subject: { diagramType: 'lifecycle', collection: 'transitions', index: transitions.indexOf(transition), from: transition.from, to: transition.to },
        evidence: { widthDriver: widthDriver(transition) },
        supportedFixes: [`review the transition ${transition.note ? transition.label ? 'label and note' : 'note' : 'label'} wording; ${preserveConditions}`, 'only equivalent exits with identical labels, notes and variants can share one arrow; keep distinct notes on separate exits without removing them to force sharing'],
      });
      problems.push(message);
    }
    if (problems.length) throwDiagnosticProblems('Lifecycle layout validation failed', problems, { subject: { diagramType: 'lifecycle' }, diagnostics });
  }

  const LEGEND_CATALOG = ['start', 'active', 'waiting', 'decision', 'success', 'failure', 'neutral', 'external'].map((kind) => ({
    kind,
    label: i18nText(lifecycle.meta.locale, `legend.lifecycle.${kind}`),
    swatchWidth: kind === 'start' ? 26 : undefined,
  }));

  function legendCatalog() {
    const presentKinds = new Set([...states.values()].map((state) => state.type));
    presentKinds.add('start');
    const entries = resolveLegend(lifecycle.meta?.legend, LEGEND_CATALOG, presentKinds);
    if (!entries.length || ![...states.values()].some(isFinal)) return entries;
    return [...entries, { kind: 'final', label: i18nText(lifecycle.meta.locale, 'legend.lifecycle.final'), interactive: false, present: true, swatchWidth: 16 }];
  }
  const legendEntries = legendCatalog();
  const canvasWidth = Math.max(640, Math.ceil(geometry.contentRight + MARGIN_X));
  const legend = legendFootprint(legendEntries, { width: canvasWidth - 80 });
  const viewBox = [canvasWidth, Math.ceil(geometry.contentBottom + (legendEntries.length ? 78 + legend.extraHeight : 32))];
  validateLayout();

  const stateSteps = new Map<string, number>();
  mainPath.forEach((id, index) => stateSteps.set(id, index));
  for (const [index, transition] of transitions.entries()) {
    if (!stateSteps.has(transition.to)) stateSteps.set(transition.to, index + 1);
  }

  function renderState(state: PlacedState): string {
    const fill = typeClass[state.type] || typeClass.neutral;
    const accent = textClass[state.type] || 't-muted';
    const hasSub = state.sublabel != null && state.sublabel !== '';
    const { label: labelFont, sublabel: sublabelFont, tag: tagFont } = fonts(state, state.width);
    // Baselines keep each row's full glyph box (ascent and descent) separate.
    const [labelY, sublabelY, tagY] = hasSub && state.tag ? [23, 40, 55] : hasSub ? [27, 45] : state.tag ? [29, 0, 50] : [37];
    const textOffset = (state.height - STATE_H) / 2;
    const rows = [{ text: state.label, font: labelFont, y: labelY + textOffset }];
    if (hasSub) rows.push({ text: state.sublabel ?? '', font: sublabelFont, y: (sublabelY ?? 0) + textOffset });
    if (state.tag) rows.push({ text: state.tag, font: tagFont, y: (tagY ?? 0) + textOffset });
    const labelLayout = nodeLabelLayout({
      width: state.width, height: state.height, rows,
      brand: Boolean(brandMarkFor(state)), source: Boolean(sourceEvidence?.nodes?.[state.id]?.length), side: 'left', step: state.step,
    });
    const sub = hasSub
      ? `\n          <text data-detail="context" x="${state.cx}" y="${state.y + labelLayout.ys[1]}" class="t-muted" font-size="${sublabelFont}" text-anchor="middle">${esc(state.sublabel)}</text>`
      : '';
    const tag = state.tag
      ? `\n          <text data-detail="fine" x="${state.cx}" y="${state.y + labelLayout.ys[hasSub ? 2 : 1]}" class="${accent}" font-size="${tagFont}" text-anchor="middle">${esc(state.tag)}</text>`
      : '';
    const icon = state.icon ?? (QUIET_TYPES.has(state.type) ? (isFinal(state) ? 'stop' : 'none') : undefined);
    const step = state.step
      ? `\n          <text data-detail="fine" x="${state.x + 23}" y="${state.y + 14}" class="${accent}" font-size="${TEXT.step}" font-weight="700">${esc(state.step)}</text>`
      : '';
    const brand = renderBrandMark(state, { x: state.x + state.width - 22, y: state.y + 6 });
    const initial = state.id === mainPath[0]
      ? `\n          <g aria-hidden="true" data-lifecycle-initial-marker="">${initialMarkerShape(state.x - 26, state.x - 1, state.cy)}</g>`
      : '';
    const finalBorder = isFinal(state)
      ? `\n          <rect x="${state.x + 3}" y="${state.y + 3}" width="${state.width - 6}" height="${state.height - 6}" rx="5" class="${fill}" style="fill: none" stroke-width="1"/>`
      : '';
    const passport = {
      kind: state.type,
      sublabel: state.sublabel,
      tag: state.tag,
      ...brandMetadataFor(state),
    };
    return `        <g ${focusNodeAttrs(state.id, state.label, passport, lifecycle.meta.locale)}>
          ${focusNodeTitle(state.label, passport)}
          <rect x="${state.x}" y="${state.y}" width="${state.width}" height="${state.height}" rx="8" class="c-mask"/>
          <rect x="${state.x}" y="${state.y}" width="${state.width}" height="${state.height}" rx="8" class="${fill}"${animateAttr(lifecycle.meta, 'node', stateSteps.get(state.id))} stroke-width="1.5"/>${finalBorder}${initial}
          ${renderSemanticSigil(state.type, { icon, x: state.x + 6, y: state.y + labelLayout.sigilY, size: labelLayout.sigilSize })}${brand ? `\n          ${brand}` : ''}${step}
          <text data-node-label=""${hasSub ? ' data-detail-anchor=""' : ''} x="${state.x + labelLayout.x}" y="${state.y + labelLayout.ys[0]}" class="t-primary" font-size="${labelFont}" font-weight="600" text-anchor="middle">${esc(state.label)}</text>${sub}${tag}
        </g>`;
  }

  function variantOf(transition: LifecycleTransition): LifecycleVariant {
    if (transition.variant) return transition.variant;
    return kindOf.get(transition) === 'spine' ? 'emphasis' : 'default';
  }

  function renderTransition(transition: LifecycleTransition, index: number): string {
    const route = required(geometry.routes, transition);
    const variant = variantOf(transition);
    const [cls, marker] = arrowClassMap[variant] || arrowClassMap.default;
    const strokeWidth = variant === 'emphasis' ? 1.8 : 1.2;
    const d = roundedPath(route.points, CORNER);
    const junction = route.bracket ? ` data-composition-junction="${esc(route.bracket.key.replaceAll('\u0000', '+'))}"` : '';
    const edge = `          <path ${focusEdgeAttrs(transition.from, transition.to, transition.label || transition.note, index, transition.id)} data-composition-points="${routePointsValue(route.points)}" data-composition-crossover="halo" data-composition-independent="true"${junction} d="${d}" class="${cls}"${animateAttr(lifecycle.meta, 'edge', index)} stroke-width="${strokeWidth}" marker-end="url(#${marker})"/>`;
    const underlay = `          <path data-graph-role="automatic-crossover-underlay" d="${d}" fill="none" stroke="var(--mask)" stroke-width="${strokeWidth + 4}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>`;
    return `        <g data-graph-role="automatic-crossover" style="--step:${index}">\n${underlay}\n${edge}\n        </g>`;
  }

  function renderLabel(transition: LifecycleTransition, index: number): string {
    const rect = geometry.placedLabels.get(transition);
    if (!rect) return '';
    const variant = variantOf(transition);
    const accent = variant === 'default' ? 't-muted' : edgeLabelAccent(variant);
    const baseline = rect.y + (transition.label ? 11.5 : 11);
    const label = transition.label
      ? `\n          <text x="${rect.cx}" y="${baseline}" class="${accent}" font-size="${LABEL_FONT}" text-anchor="middle">${esc(transition.label)}</text>`
      : '';
    const note = transition.note
      ? `\n          <text data-detail="fine" x="${rect.cx}" y="${baseline + (transition.label ? 12 : 0)}" class="t-muted" font-size="${NOTE_FONT}" text-anchor="middle">${esc(transition.note)}</text>`
      : '';
    return `        <g data-detail="${transition.label ? 'context' : 'fine'}" ${focusEdgeAttrs(transition.from, transition.to, transition.label || transition.note, index, transition.id)}>
          <rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" rx="4" class="c-mask"/>${label}${note}
        </g>`;
  }

  function initialMarkerShape(dotX: number, tipX: number, y: number): string {
    return `<circle cx="${dotX}" cy="${y}" r="4.5" style="fill: var(--arrow-emphasis)"/><path d="M ${dotX + 4.5} ${y} L ${tipX - 6} ${y}" class="a-emphasis" stroke-width="1.4"/><path d="M ${tipX - 7} ${y - 3.5} L ${tipX} ${y} L ${tipX - 7} ${y + 3.5} Z" style="fill: var(--arrow-emphasis)"/>`;
  }

  function renderSwatch(entry: PositionedLegendEntry): string {
    if (entry.kind === 'start') return initialMarkerShape(entry.x + 4.5, entry.x + 24, entry.baseline - 3.5);
    if (entry.kind === 'final') {
      return `<rect x="${entry.x}" y="${entry.baseline - 8}" width="14" height="9" rx="2" class="c-external" stroke-width="1"/><rect x="${entry.x + 2.5}" y="${entry.baseline - 5.5}" width="9" height="4" rx="1" class="c-external" style="fill: none" stroke-width="0.8"/>`;
    }
    return `<rect x="${entry.x}" y="${entry.baseline - 8}" width="14" height="9" rx="2" class="${typeClass[entry.kind] || 'c-external'}" stroke-width="1"/>`;
  }

  function renderLegend() {
    return renderResolvedLegend({
      entries: legendEntries,
      locale: lifecycle.meta.locale,
      layout: {
        x: 40,
        baselineY: viewBox[1] - 32,
        width: viewBox[0] - 80,
        minTitleY: geometry.contentBottom + 12,
        unfit: lifecycle.meta?.legend === undefined ? 'hide' : 'error',
        diagramType: 'lifecycle',
      },
      renderSwatch,
    });
  }

  function renderSvg() {
    const junctions = geometry.junctions.map(([x, y]) => `        <circle cx="${x}" cy="${y}" r="2.6" data-lifecycle-junction="" style="fill: var(--arrow)" aria-hidden="true"/>`).join('\n');
    const frames = geometry.frames.map((rect) => `        <rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" rx="14" data-lifecycle-frame="" fill="none" stroke="var(--arrow)" stroke-opacity="0.55" stroke-width="1" stroke-dasharray="1.5 3.5" stroke-linecap="round" aria-hidden="true"/>`).join('\n');
    return `      <svg viewBox="0 0 ${viewBox[0]} ${viewBox[1]}" data-reader-fit="intrinsic-height" data-lifecycle-layout="main-path-v3" ${svgRootAttrs(lifecycle.meta)} data-motion-choreography="walk">
${svgAccessibleText(lifecycle.meta, 'lifecycle')}
${renderDefinitions()}

        <!-- Background Grid -->
        <rect width="100%" height="100%" fill="url(#grid)" />

        <!-- Composite phases -->
${frames}

        <!-- Transition paths -->
${transitions.map(renderTransition).join('\n')}
${junctions}

        <!-- States -->
${[...states.values()].map(renderState).join('\n\n')}

        <!-- Transition labels -->
${transitions.map(renderLabel).filter(Boolean).join('\n')}

        <!-- Legend -->
${renderLegend()}
      </svg>`;
  }

  return { svg: renderSvg() };
}

export async function main(argv: string[]): Promise<void> {
  const { diagram: lifecycle, template, outPath, sourceEvidence } = await loadDiagramWithBrandMarks<LifecycleDiagram>({
    rendererDir: import.meta.dir,
    diagramType: 'lifecycle',
    defaultExample: 'agent-run.lifecycle.json',
    argv,
  });
  const { svg } = compileLifecycle({ lifecycle, sourceEvidence });
  writeDiagram({
    outPath,
    template,
    diagramType: 'lifecycle',
    meta: lifecycle.meta,
    svg,
    cards: lifecycle.cards,
    sourceEvidence,
  });
}

if (import.meta.main) await main(process.argv);
