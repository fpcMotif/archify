import { detectType, PeleError, parse, register } from './vendor/pele/core.js';
import architectureParser from './vendor/pele/diagrams/architecture.js';
import classParser from './vendor/pele/diagrams/class.js';
import erParser from './vendor/pele/diagrams/er.js';
import flowchartParser from './vendor/pele/diagrams/flowchart.js';
import mindmapParser from './vendor/pele/diagrams/mindmap.js';
import sequenceParser from './vendor/pele/diagrams/sequence.js';
import stateParser from './vendor/pele/diagrams/state.js';
import timelineParser from './vendor/pele/diagrams/timeline.js';

register(flowchartParser, sequenceParser, stateParser, erParser, classParser, timelineParser, mindmapParser, architectureParser);

export type ImportedDiagramType = 'workflow' | 'sequence' | 'lifecycle' | 'erd' | 'class' | 'timeline' | 'tree' | 'architecture';
type ComponentType = 'frontend' | 'backend' | 'database' | 'cloud' | 'security' | 'messagebus' | 'external';
type Json = Record<string, unknown>;

export interface MermaidImport {
  type: ImportedDiagramType;
  diagram: Json;
  notes: string[];
}

export interface ImportOptions {
  title?: string;
  output?: string;
}

export class MermaidImportError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'MermaidImportError';
    this.code = code;
  }
}

interface FlowNode { id: string; text?: string; type?: string }
interface FlowEdge { start: string; end: string; type?: string; text?: string; stroke?: string }
interface FlowSubgraph { id: string; nodes: string[]; title?: string }
interface FlowModel { type: 'flowchart'; direction?: string; title?: string; nodes: Map<string, FlowNode>; edges: FlowEdge[]; subgraphs: FlowSubgraph[] }

interface SequenceActor { name: string; description?: string; type?: string }
interface SequenceMessage { from?: string; to?: string; message?: string; type: number }
interface SequenceModel { type: 'sequence'; title?: string; actors: Map<string, SequenceActor>; messages: SequenceMessage[] }

interface StateRef { stmt: 'state'; id: string; type?: string; description?: string; descriptions?: string[]; start?: boolean; doc?: StateStatement[] }
interface StateRelation { stmt: 'relation'; state1: StateRef; state2: StateRef; description?: string }
type StateStatement = StateRef | StateRelation | { stmt: string };
interface StateModel { type: 'state'; title?: string; rootDoc: StateStatement[]; states: Map<string, StateRef> }

interface ErAttribute { type?: string; name: string; keys?: string[] }
interface ErEntity { id: string; label: string; alias?: string; attributes?: ErAttribute[] }
interface ErRelationship { entityA: string; entityB: string; roleA?: string; relSpec: { cardA: string; cardB: string; relType: string } }
interface ErModel { type: 'er'; title?: string; entities: Map<string, ErEntity>; relationships: ErRelationship[] }

interface ClassMember { id: string; memberType: string; visibility?: string; classifier?: string; parameters?: string; returnType?: string }
interface ClassNode { id: string; label?: string; members?: ClassMember[]; methods?: ClassMember[]; annotations?: string[] }
interface ClassRelation { id1: string; id2: string; title?: string; relation: { type1: number | 'none'; type2: number | 'none'; lineType: number } }
interface ClassModel { type: 'class'; title?: string; classes: Map<string, ClassNode>; relations: ClassRelation[] }

interface TimelinePeriod { text: string; events: string[]; section?: string }
interface TimelineModel { type: 'timeline'; title?: string; periods: TimelinePeriod[] }

interface MindmapNode { nodeId: string; descr?: string; icon?: string; class?: string; children: MindmapNode[] }
interface MindmapModel { type: 'mindmap'; title?: string; nodes: MindmapNode[] }

type ArchitectureSide = 'L' | 'R' | 'T' | 'B';
interface ArchitectureNode { id: string; type: 'service' | 'junction'; icon?: string; iconText?: string; title?: string; in?: string }
interface ArchitectureGroup { id: string; title?: string; in?: string }
interface ArchitectureEdge {
  lhsId: string; lhsDir: ArchitectureSide; lhsInto?: boolean; lhsGroup?: boolean;
  rhsId: string; rhsDir: ArchitectureSide; rhsInto?: boolean; rhsGroup?: boolean;
  title?: string;
}
type Collection<T> = Map<string, T> | Record<string, T>;
interface ArchitectureModel { type: 'architecture'; title?: string; nodes: Collection<ArchitectureNode>; groups: Collection<ArchitectureGroup>; edges: ArchitectureEdge[] }

type MermaidModel = FlowModel | SequenceModel | StateModel | ErModel | ClassModel | TimelineModel | MindmapModel | ArchitectureModel;

const DEFAULT_TITLES: Record<ImportedDiagramType, string> = {
  workflow: 'Imported flowchart',
  sequence: 'Imported sequence',
  lifecycle: 'Imported state machine',
  erd: 'Imported data model',
  class: 'Imported class model',
  timeline: 'Imported timeline',
  tree: 'Imported mind map',
  architecture: 'Imported architecture',
};

const IMPORTABLE_MODELS = new Set(['flowchart', 'sequence', 'state', 'er', 'class', 'timeline', 'mindmap', 'architecture']);

function unsupportedType(type: unknown): MermaidImportError {
  return new MermaidImportError(
    `Mermaid ${String(type)} has no Archify import. Supported: flowchart, sequenceDiagram, stateDiagram, erDiagram, classDiagram, timeline, mindmap, architecture-beta.`,
    'mermaid/unsupported-type',
  );
}

export function importMermaid(text: string, options: ImportOptions = {}): MermaidImport {
  const detected = detectType(text);
  if (typeof detected === 'string' && !IMPORTABLE_MODELS.has(detected)) throw unsupportedType(detected);
  let model: MermaidModel;
  try {
    model = parse(text) as MermaidModel;
  } catch (error) {
    const reason = error instanceof PeleError || error instanceof Error ? error.message : String(error);
    throw new MermaidImportError(`Mermaid could not be parsed: ${reason}`, 'mermaid/parse');
  }
  const notes: string[] = [];
  switch (model.type) {
    case 'flowchart': return finish('workflow', flowchartToWorkflow(model, notes), model.title, options, notes);
    case 'sequence': return finish('sequence', sequenceToArchify(model, notes), model.title, options, notes);
    case 'state': return finish('lifecycle', stateToLifecycle(model, notes), model.title, options, notes);
    case 'er': return finish('erd', erToArchify(model, notes), model.title, options, notes);
    case 'class': return finish('class', classToArchify(model, notes), model.title, options, notes);
    case 'timeline': return finish('timeline', timelineToArchify(model, notes), model.title, options, notes);
    case 'mindmap': return finish('tree', mindmapToTree(model, notes), model.title, options, notes);
    case 'architecture': return finish('architecture', architectureToArchify(model, notes), model.title, options, notes);
    default:
      throw unsupportedType((model as { type?: unknown }).type);
  }
}

function finish(type: ImportedDiagramType, body: Json, modelTitle: string | undefined, options: ImportOptions, notes: string[]): MermaidImport {
  const title = options.title || modelTitle || DEFAULT_TITLES[type];
  const output = options.output || `${slug(title)}.html`;
  const { meta: bodyMeta, ...rest } = body;
  const meta = { title, output, ...(bodyMeta as Json | undefined) };
  const schemaVersion = type === 'workflow' ? 2 : type === 'lifecycle' ? 3 : 1;
  return { type, diagram: { schema_version: schemaVersion, diagram_type: type, meta, ...rest }, notes };
}

function slug(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram';
}

function cleanLabel(value: string | undefined, fallback: string): string {
  const text = (value ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function idAllocator(): (raw: string) => string {
  const byRaw = new Map<string, string>();
  const used = new Set<string>();
  return (raw: string) => {
    const known = byRaw.get(raw);
    if (known) return known;
    let base = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-zA-Z]/.test(base)) base = `n-${base || 'node'}`;
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
    used.add(candidate);
    byRaw.set(raw, candidate);
    return candidate;
  };
}

function uniqueIds(): (base: string) => string {
  const used = new Set<string>();
  return (base: string) => {
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
    used.add(candidate);
    return candidate;
  };
}

function longestPathRanks(nodeIds: string[], edges: Array<{ from: string; to: string }>): Map<string, number> {
  const outgoing = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);
  const state = new Map<string, 'open' | 'done'>();
  const forward = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const next of outgoing.get(id) ?? []) {
      const seen = state.get(next);
      if (seen === 'open') continue;
      forward.get(id)?.push(next);
      if (!seen) visit(next);
    }
    state.set(id, 'done');
  };
  for (const id of nodeIds) if (!state.has(id)) visit(id);
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (const targets of forward.values()) for (const to of targets) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  const rank = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const queue = nodeIds.filter((id) => indegree.get(id) === 0);
  while (queue.length) {
    const id = queue.shift() as string;
    for (const to of forward.get(id) ?? []) {
      rank.set(to, Math.max(rank.get(to) ?? 0, (rank.get(id) ?? 0) + 1));
      indegree.set(to, (indegree.get(to) ?? 0) - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  return rank;
}

const WORKFLOW_MAX_COL = 5;

function flowchartToWorkflow(model: FlowModel, notes: string[]): Json {
  const nodeId = idAllocator();
  const rawNodes = [...model.nodes.values()];
  if (!rawNodes.length) throw new MermaidImportError('The flowchart has no nodes.', 'mermaid/empty');
  const laneId = idAllocator();
  const laneOf = new Map<string, string>();
  const lanes: Json[] = [];
  for (const subgraph of model.subgraphs) {
    const members = subgraph.nodes.filter((member) => model.nodes.has(member) && !laneOf.has(member));
    if (!members.length) continue;
    const id = laneId(`lane-${subgraph.id}`);
    lanes.push({ id, label: cleanLabel(subgraph.title, subgraph.id) });
    for (const member of members) laneOf.set(member, id);
  }
  if (rawNodes.some((node) => !laneOf.has(node.id))) {
    const id = laneId('lane-main');
    lanes.unshift({ id, label: lanes.length ? 'Other steps' : 'Flow' });
    for (const node of rawNodes) if (!laneOf.has(node.id)) laneOf.set(node.id, id);
  }
  const ids = rawNodes.map((node) => node.id);
  const edgeList = model.edges.filter((edge) => {
    const known = model.nodes.has(edge.start) && model.nodes.has(edge.end);
    if (!known) notes.push(`Dropped the edge ${edge.start} -> ${edge.end}: it connects a subgraph, which Archify draws as a lane, not a node.`);
    return known;
  });
  if (edgeList.some((edge) => edge.type === 'double_arrow_point')) notes.push('Two-way arrows were imported as one-way edges in the authored direction.');
  const ranks = longestPathRanks(ids, edgeList.map((edge) => ({ from: edge.start, to: edge.end })));
  const usedCols = new Map<string, Set<number>>();
  const order = [...rawNodes].sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0) || ids.indexOf(a.id) - ids.indexOf(b.id));
  const colOf = new Map<string, number>();
  for (const node of order) {
    const lane = laneOf.get(node.id) as string;
    const taken = usedCols.get(lane) ?? new Set<number>();
    let col = ranks.get(node.id) ?? 0;
    while (taken.has(col)) col += 1;
    taken.add(col);
    usedCols.set(lane, taken);
    colOf.set(node.id, col);
  }
  const widest = Math.max(...colOf.values());
  if (widest > WORKFLOW_MAX_COL) {
    const overflow = rawNodes.filter((node) => (colOf.get(node.id) ?? 0) > WORKFLOW_MAX_COL).map((node) => node.id);
    throw new MermaidImportError(
      `The flowchart needs ${widest + 1} columns, but an Archify workflow holds ${WORKFLOW_MAX_COL + 1}. Steps past column ${WORKFLOW_MAX_COL + 1}: ${overflow.join(', ')}. Merge steps, or split the flow into two diagrams.`,
      'mermaid/workflow-too-wide',
    );
  }
  const nodes = rawNodes.map((node) => ({
    id: nodeId(node.id),
    lane: laneOf.get(node.id),
    col: colOf.get(node.id),
    type: node.type === 'cylinder' ? 'database' : 'backend',
    label: cleanLabel(node.text, node.id),
  }));
  const edgeId = uniqueIds();
  const edges = edgeList.map((edge) => {
    const from = nodeId(edge.start);
    const to = nodeId(edge.end);
    const label = cleanLabel(edge.text, '');
    const variant = edge.stroke === 'dotted' ? 'dashed' : edge.stroke === 'thick' ? 'emphasis' : undefined;
    return { id: edgeId(`${from}-${to}`), from, to, ...(label ? { label } : {}), ...(variant ? { variant } : {}) };
  });
  notes.push('Node types default to backend (cylinders become database). Set each node type to what it is.');
  return { lanes, nodes, edges };
}

const SEQUENCE_LINE = {
  solid: new Set([0, 3, 5, 33]),
  dotted: new Set([1, 4, 6, 25, 34]),
  async: new Set([24]),
  note: 2,
  activeStart: 17,
  activeEnd: 18,
};
const SEQUENCE_BLOCK_START = new Map<number, string>([[10, 'loop'], [12, 'alt'], [15, 'opt'], [19, 'par'], [22, 'group'], [27, 'critical'], [30, 'break'], [32, 'par']]);
const SEQUENCE_BLOCK_END = new Set([11, 14, 16, 21, 23, 29, 31]);
const FIRST_MESSAGE_Y = 170;
const MESSAGE_STEP = 40;

function participantType(actorType: string | undefined): ComponentType {
  switch (actorType) {
    case 'actor': return 'external';
    case 'database':
    case 'collections': return 'database';
    case 'queue': return 'messagebus';
    default: return 'backend';
  }
}

function sequenceToArchify(model: SequenceModel, notes: string[]): Json {
  const participantId = idAllocator();
  const participants = [...model.actors.values()].map((actor) => ({
    id: participantId(actor.name),
    type: participantType(actor.type),
    label: cleanLabel(actor.description, actor.name),
  }));
  if (participants.length < 2) throw new MermaidImportError('The sequence needs at least two participants.', 'mermaid/empty');
  const messageId = uniqueIds();
  const messages: Json[] = [];
  const segments: Json[] = [];
  const activations: Json[] = [];
  const openActivations = new Map<string, number[]>();
  let y = FIRST_MESSAGE_Y - MESSAGE_STEP;
  let depth = 0;
  let block: { label: string; first?: number; last?: number } | null = null;
  let pendingNote: string | null = null;
  let droppedSelf = 0;
  for (const entry of model.messages) {
    const start = SEQUENCE_BLOCK_START.get(entry.type);
    if (start) {
      if (depth === 0) block = { label: cleanLabel(`${start} ${entry.message ?? ''}`, start) };
      depth += 1;
      continue;
    }
    if (SEQUENCE_BLOCK_END.has(entry.type)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && block?.first !== undefined && block.last !== undefined) {
        segments.push({ from: block.first - 15, to: block.last + 15, label: block.label });
      }
      if (depth === 0) block = null;
      continue;
    }
    if (entry.type === SEQUENCE_LINE.note) {
      const text = cleanLabel(entry.message, '');
      const previous = messages.at(-1);
      if (text && previous) previous.note = previous.note ? `${previous.note} ${text}` : text;
      else if (text) pendingNote = text;
      continue;
    }
    if (entry.type === SEQUENCE_LINE.activeStart && entry.from) {
      const stack = openActivations.get(entry.from) ?? [];
      stack.push(Math.max(y, FIRST_MESSAGE_Y));
      openActivations.set(entry.from, stack);
      continue;
    }
    if (entry.type === SEQUENCE_LINE.activeEnd && entry.from) {
      const opened = openActivations.get(entry.from)?.pop();
      if (opened !== undefined && y > opened) {
        const participant = participantId(entry.from);
        const type = participants.find((candidate) => candidate.id === participant)?.type;
        activations.push({ participant, from: opened, to: y, ...(type ? { type } : {}) });
      }
      continue;
    }
    const isMessage = SEQUENCE_LINE.solid.has(entry.type) || SEQUENCE_LINE.dotted.has(entry.type) || SEQUENCE_LINE.async.has(entry.type);
    if (!isMessage || !entry.from || !entry.to) continue;
    if (entry.from === entry.to) {
      droppedSelf += 1;
      continue;
    }
    y += MESSAGE_STEP;
    const from = participantId(entry.from);
    const to = participantId(entry.to);
    const label = cleanLabel(entry.message, `${entry.from} to ${entry.to}`);
    const variant = SEQUENCE_LINE.dotted.has(entry.type) ? 'return' : SEQUENCE_LINE.async.has(entry.type) ? 'dashed' : undefined;
    const labelSlug = slug(label).slice(0, 40);
    const message: Json = { id: messageId(/^[a-z]/.test(labelSlug) ? labelSlug : `message-${labelSlug}`), from, to, y, label, ...(variant ? { variant } : {}) };
    if (pendingNote) {
      message.note = pendingNote;
      pendingNote = null;
    }
    messages.push(message);
    if (block) {
      block.first ??= y;
      block.last = y;
    }
  }
  if (!messages.length) throw new MermaidImportError('The sequence has no messages between two participants.', 'mermaid/empty');
  if (droppedSelf) notes.push(`Dropped ${droppedSelf} self-message(s): an Archify message runs between two participants. Use a note instead.`);
  if (segments.length) notes.push('loop, alt, opt and par blocks became labelled segments. Nested blocks were folded into their outer block.');
  return { participants, messages, ...(segments.length ? { segments } : {}), ...(activations.length ? { activations } : {}) };
}

const FAILURE_WORDS = /fail|error|cancel|reject|abort|expire|timeout|timed.?out|denied|declin|lost/i;

interface LifecycleGraph {
  labels: Map<string, string>;
  types: Map<string, string>;
  edges: Array<{ from: string; to: string; label: string }>;
  entry: Map<string, string>;
  finals: Map<string, Set<string>>;
  children: Map<string, string[]>;
}

function stateToLifecycle(model: StateModel, notes: string[]): Json {
  const graph: LifecycleGraph = { labels: new Map(), types: new Map(), edges: [], entry: new Map(), finals: new Map(), children: new Map() };
  const isPseudo = (ref: StateRef) => ref.start === true || ref.start === false;
  const remember = (ref: StateRef, scope: string) => {
    if (isPseudo(ref)) return;
    const known = model.states.get(ref.id);
    const description = known?.descriptions?.find(Boolean) ?? ref.description ?? '';
    if (!graph.labels.has(ref.id) || description) graph.labels.set(ref.id, cleanLabel(description, ref.id));
    const type = known?.type ?? ref.type;
    if (type) graph.types.set(ref.id, type);
    const siblings = graph.children.get(scope) ?? [];
    if (!siblings.includes(ref.id)) siblings.push(ref.id);
    graph.children.set(scope, siblings);
  };
  const walk = (doc: StateStatement[], scope: string) => {
    for (const statement of doc) {
      if (statement.stmt === 'relation') {
        const relation = statement as StateRelation;
        remember(relation.state1, scope);
        remember(relation.state2, scope);
        if (relation.state1.start === true) graph.entry.set(scope, relation.state2.id);
        else if (relation.state2.start === false) {
          const finals = graph.finals.get(scope) ?? new Set<string>();
          finals.add(relation.state1.id);
          graph.finals.set(scope, finals);
        } else graph.edges.push({ from: relation.state1.id, to: relation.state2.id, label: cleanLabel(relation.description, '') });
      } else if (statement.stmt === 'state') {
        const ref = statement as StateRef;
        remember(ref, scope);
        if (ref.type === 'divider') throw new MermaidImportError('Concurrent regions (--) have no lifecycle form. Draw one lifecycle per region.', 'mermaid/concurrent-state');
        if (ref.doc?.length) walk(ref.doc, ref.id);
      }
    }
  };
  walk(model.rootDoc, 'root');
  const composites = new Set([...graph.children.keys()].filter((scope) => scope !== 'root'));
  if (composites.size) notes.push(`Flattened composite state(s) ${[...composites].join(', ')} into their inner states.`);
  const resolveEntry = (id: string, seen = new Set<string>()): string => {
    if (!composites.has(id) || seen.has(id)) return id;
    seen.add(id);
    const entry = graph.entry.get(id) ?? graph.children.get(id)?.[0];
    return entry ? resolveEntry(entry, seen) : id;
  };
  const leavesOf = (id: string): string[] => (composites.has(id)
    ? (graph.children.get(id) ?? []).flatMap(leavesOf)
    : [id]);
  const stateId = idAllocator();
  const transitionId = uniqueIds();
  const transitions: Json[] = [];
  const seenPairs = new Set<string>();
  const addTransition = (from: string, to: string, label: string) => {
    const key = `${from}\u0000${to}\u0000${label}`;
    if (from === to && !label) return;
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    const fromId = stateId(from);
    const toId = stateId(to);
    transitions.push({ id: transitionId(`${fromId}-${toId}`), from: fromId, to: toId, ...(label ? { label } : {}) });
  };
  for (const edge of graph.edges) {
    const target = resolveEntry(edge.to);
    for (const source of leavesOf(edge.from)) addTransition(source, target, edge.label);
  }
  const rootFinals = new Set<string>([...(graph.finals.get('root') ?? [])].flatMap(leavesOf));
  const leaves = [...graph.labels.keys()].filter((id) => !composites.has(id));
  if (leaves.length < 2) throw new MermaidImportError('The state diagram needs at least two states.', 'mermaid/empty');
  const rootEntry = graph.entry.get('root');
  const start = rootEntry ? resolveEntry(rootEntry) : leaves[0];
  if (!rootEntry) notes.push(`No [*] start was given, so ${start} starts the main path.`);
  const typeOf = (id: string): string => {
    if (graph.types.get(id) === 'choice') return 'decision';
    if (id === start) return 'start';
    if (rootFinals.has(id)) return FAILURE_WORDS.test(`${id} ${graph.labels.get(id) ?? ''}`) ? 'failure' : 'success';
    return 'active';
  };
  const states = leaves.map((id) => ({ id: stateId(id), type: typeOf(id), label: graph.labels.get(id) ?? id }));
  const outgoing = new Map<string, string[]>();
  for (const transition of transitions) {
    const list = outgoing.get(transition.from as string) ?? [];
    list.push(transition.to as string);
    outgoing.set(transition.from as string, list);
  }
  const typeById = new Map(states.map((state) => [state.id, state.type]));
  const pathPreference = (id: string) => ({ failure: 2, success: 1 })[typeById.get(id) as 'failure' | 'success'] ?? 0;
  const mainPath = [stateId(start)];
  while (typeById.get(mainPath.at(-1) as string) !== 'success' && typeById.get(mainPath.at(-1) as string) !== 'failure') {
    const next = (outgoing.get(mainPath.at(-1) as string) ?? [])
      .filter((candidate) => !mainPath.includes(candidate))
      .sort((a, b) => pathPreference(a) - pathPreference(b))[0];
    if (!next) break;
    mainPath.push(next);
  }
  if (mainPath.length < 2) throw new MermaidImportError(`The start state ${start} has no outgoing transition, so there is no main path.`, 'mermaid/no-main-path');
  notes.push('State types follow the authoring contract: [*] --> is the start, --> [*] is an outcome, <<choice>> is a decision. Review outcome types (success, failure, neutral).');
  return { mainPath, states, transitions };
}

const ER_CARDINALITY: Record<string, { cardinality: 'one' | 'many'; optional: boolean }> = {
  ONLY_ONE: { cardinality: 'one', optional: false },
  ZERO_OR_ONE: { cardinality: 'one', optional: true },
  ONE_OR_MORE: { cardinality: 'many', optional: false },
  ZERO_OR_MORE: { cardinality: 'many', optional: true },
  MD_PARENT: { cardinality: 'one', optional: false },
};

function gridPosition(index: number, count: number): { row: number; col: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  return { row: Math.floor(index / columns), col: index % columns };
}

interface ImportedAttribute { name: string; type?: string; key?: string; references?: string }

function foreignKeyTarget(column: string, entities: Array<{ id: string; label: string; attributes?: ImportedAttribute[] }>): string | null {
  const stem = column.replace(/_?id$/i, '').toLowerCase();
  if (!stem || stem === column.toLowerCase()) return null;
  const target = entities.find((entity) => [entity.id, entity.label].some((name) => {
    const lower = name.toLowerCase();
    return lower === stem || lower === `${stem}s` || lower.replace(/[_-]/g, '') === stem.replace(/[_-]/g, '');
  }));
  if (!target) return null;
  const primary = target.attributes?.find((attribute) => attribute.key === 'pk')?.name ?? 'id';
  return `${target.id}.${primary}`;
}

function erToArchify(model: ErModel, notes: string[]): Json {
  const entityId = idAllocator();
  const byInternalId = new Map<string, string>();
  const rawEntities = [...model.entities.entries()];
  if (!rawEntities.length) throw new MermaidImportError('The ER diagram has no entities.', 'mermaid/empty');
  const entities = rawEntities.map(([name, entity], index) => {
    const id = entityId(name);
    byInternalId.set(entity.id, id);
    const attributes = (entity.attributes ?? []).map((attribute) => {
      const key = (attribute.keys ?? []).map((value) => value.toLowerCase()).find((value) => value === 'pk' || value === 'fk' || value === 'uk');
      return { name: attribute.name, ...(attribute.type ? { type: attribute.type } : {}), ...(key ? { key } : {}) };
    });
    return { id, label: cleanLabel(entity.alias, name), ...gridPosition(index, rawEntities.length), ...(attributes.length ? { attributes } : {}) };
  });
  const unresolvedForeignKeys: string[] = [];
  for (const entity of entities) {
    entity.attributes = entity.attributes?.map((attribute) => {
      if (attribute.key !== 'fk') return attribute;
      const target = foreignKeyTarget(attribute.name, entities);
      if (target) return { ...attribute, references: target };
      unresolvedForeignKeys.push(`${entity.id}.${attribute.name}`);
      const { key: _unresolved, ...rest } = attribute;
      return rest;
    });
  }
  if (unresolvedForeignKeys.length) {
    notes.push(`Dropped the FK marker on ${unresolvedForeignKeys.join(', ')}: Mermaid does not say which column it references. Add key "fk" with references "entity.column".`);
  }
  const relationshipId = uniqueIds();
  const relationships = model.relationships.flatMap((relationship) => {
    const from = byInternalId.get(relationship.entityA);
    const to = byInternalId.get(relationship.entityB);
    if (!from || !to) return [];
    const fromSide = ER_CARDINALITY[relationship.relSpec.cardB] ?? ER_CARDINALITY.ONLY_ONE;
    const toSide = ER_CARDINALITY[relationship.relSpec.cardA] ?? ER_CARDINALITY.ONLY_ONE;
    const label = cleanLabel(relationship.roleA, '');
    return [{
      id: relationshipId(`${from}-${to}`),
      from,
      to,
      ...(label ? { label } : {}),
      fromCardinality: fromSide.cardinality,
      ...(fromSide.optional ? { fromOptional: true } : {}),
      toCardinality: toSide.cardinality,
      ...(toSide.optional ? { toOptional: true } : {}),
      identifying: relationship.relSpec.relType === 'IDENTIFYING',
    }];
  });
  notes.push('Entities are placed on a square grid in source order. Move related tables next to each other with row and col.');
  return { layout: { mode: 'grid' }, entities, ...(relationships.length ? { relationships } : {}) };
}

const VISIBILITY: Record<string, string> = { '+': 'public', '-': 'private', '#': 'protected', '~': 'package' };
const CLASS_RELATION = { aggregation: 0, extension: 1, composition: 2, dependency: 3, lollipop: 4, dotted: 1 };

function classKind(annotations: string[] | undefined): string {
  const tags = (annotations ?? []).map((tag) => tag.toLowerCase());
  if (tags.includes('interface')) return 'interface';
  if (tags.includes('abstract')) return 'abstract';
  if (tags.includes('enumeration') || tags.includes('enum')) return 'enum';
  if (tags.includes('record')) return 'record';
  return 'class';
}

function splitAttribute(text: string): { name: string; type?: string } {
  const trimmed = text.trim();
  const colon = trimmed.indexOf(':');
  if (colon > 0) return { name: trimmed.slice(0, colon).trim(), type: trimmed.slice(colon + 1).trim() || undefined };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { name: parts[0] };
  return { name: parts.at(-1) as string, type: parts.slice(0, -1).join(' ') };
}

function classToArchify(model: ClassModel, notes: string[]): Json {
  const typeId = idAllocator();
  const rawTypes = [...model.classes.values()];
  if (!rawTypes.length) throw new MermaidImportError('The class diagram has no types.', 'mermaid/empty');
  const kindById = new Map<string, string>();
  const types = rawTypes.map((node, index) => {
    const id = typeId(node.id);
    const kind = classKind(node.annotations);
    kindById.set(id, kind);
    const attributes = (node.members ?? []).filter((member) => member.memberType === 'attribute').map((member) => {
      const { name, type } = splitAttribute(member.id);
      const visibility = member.visibility ? VISIBILITY[member.visibility] : undefined;
      return { name, ...(type ? { type } : {}), ...(visibility ? { visibility } : {}), ...(member.classifier === '$' ? { static: true } : {}) };
    });
    const methods = (node.methods ?? []).map((method) => {
      const visibility = method.visibility ? VISIBILITY[method.visibility] : undefined;
      return {
        name: method.id,
        ...(method.parameters ? { parameters: method.parameters } : {}),
        ...(method.returnType ? { returns: method.returnType } : {}),
        ...(visibility ? { visibility } : {}),
        ...(method.classifier === '$' ? { static: true } : {}),
        ...(method.classifier === '*' ? { abstract: true } : {}),
      };
    });
    return {
      id,
      label: cleanLabel(node.label, node.id),
      kind,
      ...gridPosition(index, rawTypes.length),
      ...(attributes.length ? { attributes } : {}),
      ...(methods.length ? { methods } : {}),
    };
  });
  const relationshipId = uniqueIds();
  let downgradedRealizations = 0;
  const relationships = model.relations.map((relation) => {
    const left = typeId(relation.id1);
    const right = typeId(relation.id2);
    const marker = relation.relation.type1 !== 'none' ? relation.relation.type1 : relation.relation.type2;
    const markerOnLeft = relation.relation.type1 !== 'none';
    const dotted = relation.relation.lineType === CLASS_RELATION.dotted;
    let kind: string;
    let from = left;
    let to = right;
    if (marker === CLASS_RELATION.composition || marker === CLASS_RELATION.aggregation) {
      kind = marker === CLASS_RELATION.composition ? 'composition' : 'aggregation';
      [from, to] = markerOnLeft ? [left, right] : [right, left];
    } else if (marker === CLASS_RELATION.extension || marker === CLASS_RELATION.dependency) {
      [from, to] = markerOnLeft ? [right, left] : [left, right];
      if (marker === CLASS_RELATION.dependency) kind = dotted ? 'dependency' : 'association';
      else if (dotted && kindById.get(to) === 'interface' && kindById.get(from) !== 'interface') kind = 'realization';
      else {
        if (dotted) downgradedRealizations += 1;
        kind = 'inheritance';
      }
    } else kind = dotted ? 'dependency' : 'association';
    const label = cleanLabel(relation.title, '');
    return { id: relationshipId(`${from}-${to}`), from, to, kind, ...(label ? { label } : {}) };
  });
  if (downgradedRealizations) notes.push(`${downgradedRealizations} dotted triangle(s) do not point at an interface, so they were imported as inheritance.`);
  return { layout: { mode: 'grid' }, types, ...(relationships.length ? { relationships } : {}) };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDay(year: string, month = 1, day = 1): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00Z`;
}

function periodTimestamp(period: string, section: string | undefined): string | null {
  const text = period.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(text)) return `${text}Z`;
  const date = text.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (date) return isoDay(date[1]!, Number(date[2] ?? 1), Number(date[3] ?? 1));
  const quarterFirst = text.match(/^Q([1-4])[\s-]*(\d{4})$/i);
  if (quarterFirst) return isoDay(quarterFirst[2]!, (Number(quarterFirst[1]) - 1) * 3 + 1);
  const yearFirst = text.match(/^(\d{4})[\s-]*Q([1-4])$/i);
  if (yearFirst) return isoDay(yearFirst[1]!, (Number(yearFirst[2]) - 1) * 3 + 1);
  const month = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  const monthIndex = month ? MONTHS.indexOf(month[1]!.slice(0, 3).toLowerCase()) : -1;
  if (month && monthIndex >= 0) return isoDay(month[2]!, monthIndex + 1);
  const sectionYear = section?.trim().match(/^(\d{4})$/)?.[1];
  if (sectionYear) {
    const sectionQuarter = text.match(/^Q([1-4])$/i);
    if (sectionQuarter) return isoDay(sectionYear, (Number(sectionQuarter[1]) - 1) * 3 + 1);
    const sectionMonth = MONTHS.indexOf(text.slice(0, 3).toLowerCase());
    if (/^[A-Za-z]{3,9}\.?$/.test(text) && sectionMonth >= 0) return isoDay(sectionYear, sectionMonth + 1);
  }
  return null;
}

function timelineToArchify(model: TimelineModel, notes: string[]): Json {
  if (!model.periods.length) throw new MermaidImportError('The timeline has no periods.', 'mermaid/empty');
  const undated = model.periods.filter((period) => !periodTimestamp(period.text, period.section)).map((period) => period.text.trim());
  if (undated.length) {
    throw new MermaidImportError(
      `An Archify timeline needs a date for every period. These periods have none: ${undated.join(', ')}. Use a year, YYYY-MM, YYYY-MM-DD, "Q1 2025", "Mar 2025", or a quarter or month inside a year section.`,
      'mermaid/timeline-undated',
    );
  }
  const eventId = uniqueIds();
  const events = model.periods.flatMap((period, periodIndex) => {
    const at = periodTimestamp(period.text, period.section)!;
    const label = cleanLabel(period.text, `Period ${periodIndex + 1}`);
    const detail = period.section ? `${cleanLabel(period.section, '')} · ${label}` : label;
    const titles = period.events.length ? period.events : [period.text];
    return titles.map((title, index) => ({
      id: eventId(`event-${slug(at.slice(0, 10))}-${index + 1}`),
      at,
      title: cleanLabel(title, label),
      detail,
    }));
  });
  notes.push('Each period starts at its first day in UTC. meta.evidence is "illustrative"; set it to "observed" when the dates come from records.');
  return { meta: { evidence: 'illustrative', timezone: 'UTC' }, layout: { scale: 'date' }, events };
}

function mindmapToTree(model: MindmapModel, notes: string[]): Json {
  const root = model.nodes[0];
  if (!root) throw new MermaidImportError('The mind map has no nodes.', 'mermaid/empty');
  const nodeId = idAllocator();
  const nodes: Json[] = [];
  let decorated = 0;
  const visit = (node: MindmapNode, parent: string | undefined) => {
    const id = nodeId(`${node.nodeId}-${nodes.length}`);
    if (node.icon || node.class) decorated += 1;
    nodes.push({ id, label: cleanLabel(node.descr, node.nodeId), ...(parent ? { parent } : {}) });
    for (const child of node.children) visit(child, id);
  };
  visit(root, undefined);
  if (decorated) notes.push(`Dropped icons or classes on ${decorated} node(s): a tree node carries a label and an optional sublabel.`);
  return { layout: { direction: 'right' }, nodes };
}

const ARCHITECTURE_SIDE: Record<ArchitectureSide, { side: string; dx: number; dy: number }> = {
  L: { side: 'left', dx: -1, dy: 0 },
  R: { side: 'right', dx: 1, dy: 0 },
  T: { side: 'top', dx: 0, dy: -1 },
  B: { side: 'bottom', dx: 0, dy: 1 },
};

function architectureComponentType(icon: string | undefined): ComponentType {
  const name = (icon ?? '').toLowerCase();
  if (/database|disk|storage|db\b/.test(name)) return 'database';
  if (/internet|user|client|browser/.test(name)) return 'external';
  if (/cloud/.test(name)) return 'cloud';
  if (/queue|kafka|bus/.test(name)) return 'messagebus';
  return 'backend';
}

function values<T>(collection: Collection<T>): T[] {
  return collection instanceof Map ? [...collection.values()] : Object.values(collection);
}

function architectureToArchify(model: ArchitectureModel, notes: string[]): Json {
  const nodes = values(model.nodes);
  const services = nodes.filter((node) => node.type === 'service');
  if (!services.length) throw new MermaidImportError('The architecture has no services.', 'mermaid/empty');
  const componentId = idAllocator();
  const serviceIds = new Set(services.map((service) => service.id));

  const junctions = new Set(nodes.filter((node) => node.type === 'junction').map((node) => node.id));
  const edges: ArchitectureEdge[] = model.edges.filter((edge) => !junctions.has(edge.lhsId) && !junctions.has(edge.rhsId));
  for (const junction of junctions) {
    const touching = model.edges.filter((edge) => edge.lhsId === junction || edge.rhsId === junction);
    const ends = touching.map((edge) => edge.lhsId === junction
      ? { id: edge.rhsId, dir: edge.rhsDir, into: edge.rhsInto, group: edge.rhsGroup }
      : { id: edge.lhsId, dir: edge.lhsDir, into: edge.lhsInto, group: edge.lhsGroup });
    const [hub, ...spokes] = ends.filter((end) => serviceIds.has(end.id));
    if (!hub) continue;
    for (const spoke of spokes) {
      edges.push({ lhsId: hub.id, lhsDir: hub.dir, lhsInto: hub.into, rhsId: spoke.id, rhsDir: spoke.dir, rhsInto: spoke.into });
    }
  }
  if (junctions.size) notes.push(`Replaced ${junctions.size} junction(s) with direct connections from the first service on each junction.`);

  const position = new Map<string, { row: number; col: number }>();
  const taken = new Set<string>();
  const place = (id: string, row: number, col: number, dx: number, dy: number) => {
    while (taken.has(`${row},${col}`)) {
      row += dy || (dx ? 0 : 1);
      col += dx;
    }
    taken.add(`${row},${col}`);
    position.set(id, { row, col });
  };
  let nextStartCol = 0;
  for (const service of services) {
    if (position.has(service.id)) continue;
    place(service.id, 0, nextStartCol, 1, 0);
    const queue = [service.id];
    while (queue.length) {
      const current = queue.shift()!;
      const at = position.get(current)!;
      for (const edge of edges) {
        const forward = edge.lhsId === current;
        if (!forward && edge.rhsId !== current) continue;
        const other = forward ? edge.rhsId : edge.lhsId;
        if (position.has(other) || !serviceIds.has(other)) continue;
        const mine = ARCHITECTURE_SIDE[forward ? edge.lhsDir : edge.rhsDir];
        const theirs = ARCHITECTURE_SIDE[forward ? edge.rhsDir : edge.lhsDir];
        const dx = Math.sign(mine.dx - theirs.dx);
        const dy = Math.sign(mine.dy - theirs.dy);
        place(other, at.row + dy, at.col + dx, dx, dy);
        queue.push(other);
      }
    }
    nextStartCol = Math.max(...[...position.values()].map((entry) => entry.col)) + 1;
  }
  const minRow = Math.min(...[...position.values()].map((entry) => entry.row));
  const minCol = Math.min(...[...position.values()].map((entry) => entry.col));

  const components = services.map((service) => ({
    id: componentId(service.id),
    type: architectureComponentType(service.icon),
    label: cleanLabel(service.title, service.id),
    row: position.get(service.id)!.row - minRow,
    col: position.get(service.id)!.col - minCol,
  }));

  const groups = values(model.groups);
  const groupOf = (id: string | undefined): string[] => {
    const chain: string[] = [];
    for (let current = id; current; current = groups.find((group) => group.id === current)?.in) chain.push(current);
    return chain;
  };
  const boundaries = groups.flatMap((group) => {
    const wraps = services.filter((service) => groupOf(service.in).includes(group.id)).map((service) => componentId(service.id));
    return wraps.length ? [{ kind: 'region', label: cleanLabel(group.title, group.id), wraps }] : [];
  });

  const connectionId = uniqueIds();
  let groupEdges = 0;
  let twoWay = 0;
  const connections = edges.filter((edge) => serviceIds.has(edge.lhsId) && serviceIds.has(edge.rhsId)).map((edge) => {
    if (edge.lhsGroup || edge.rhsGroup) groupEdges += 1;
    if (edge.lhsInto && edge.rhsInto) twoWay += 1;
    const reverse = Boolean(edge.lhsInto && !edge.rhsInto);
    const [fromId, fromDir, toId, toDir] = reverse
      ? [edge.rhsId, edge.rhsDir, edge.lhsId, edge.lhsDir]
      : [edge.lhsId, edge.lhsDir, edge.rhsId, edge.rhsDir];
    const from = componentId(fromId);
    const to = componentId(toId);
    const label = cleanLabel(edge.title, '');
    return {
      id: connectionId(`${from}-to-${to}`),
      from,
      to,
      fromSide: ARCHITECTURE_SIDE[fromDir].side,
      toSide: ARCHITECTURE_SIDE[toDir].side,
      ...(label ? { label } : {}),
    };
  });
  if (groupEdges) notes.push(`${groupEdges} edge(s) used {group} to attach to a group border; they now attach to the service itself.`);
  if (twoWay) notes.push(`${twoWay} two-way edge(s) were imported as one-way connections in the authored direction.`);
  notes.push('Component types follow the Mermaid icon (database and disk become database, internet becomes external, others become backend). Set each type to what it is.');
  return {
    layout: { mode: 'grid' },
    components,
    ...(boundaries.length ? { boundaries } : {}),
    ...(connections.length ? { connections } : {}),
  };
}
