// Shared by the tuning scripts: diagram shapes, benchmark preparation and the
// tuning home that keeps rounds and the benchmark outside the repository.
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DIAGRAM_TYPES = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle', 'erd', 'class', 'tree', 'timeline', 'waterfall'];

// Prompt names per type, as a user would ask for the diagram.
export const TYPE_NAMES_ZH: Record<string, string> = {
  architecture: '架构图', workflow: '工作流图', sequence: '时序图', dataflow: '数据流图', lifecycle: '生命周期图',
  erd: 'ER 图', class: '类图', tree: '树图', timeline: '时间线图', waterfall: '瀑布图',
};

export interface DiagramItem {
  id?: string;
  from?: string;
  to?: string;
  label?: string;
  parent?: string;
  lane?: string;
  col?: number;
  fromCol?: number;
  toCol?: number;
  stage?: number;
  tag?: string;
  kind?: string;
  wraps?: unknown;
  [field: string]: unknown;
}
export type DiagramDocument = Record<string, unknown>;
interface Shape {
  elements: string;
  relations?: string;
}
export interface ContentLoss {
  elements: (string | undefined)[];
  relations: string[];
  containers: string[];
  membershipChanges: { container: string; element: unknown }[];
  firstCounts: [number, number];
  finalCounts: [number, number];
}

export function tuningHome(env = process.env) {
  return path.resolve(env.SCHEMATICS_TUNING_HOME || path.join(os.homedir(), '.local/share/schematics-tuning'));
}

const SHAPE: Record<string, Shape> = {
  architecture: { elements: 'components', relations: 'connections' },
  workflow: { elements: 'nodes', relations: 'edges' },
  sequence: { elements: 'participants', relations: 'messages' },
  dataflow: { elements: 'nodes', relations: 'flows' },
  lifecycle: { elements: 'states', relations: 'transitions' },
  erd: { elements: 'entities', relations: 'relationships' },
  class: { elements: 'types', relations: 'relationships' },
  tree: { elements: 'nodes' },
  timeline: { elements: 'events' },
  waterfall: { elements: 'spans' },
};

// Fields by which an author overrides automatic routing or label placement.
const ROUTE_CONTROLS = ['via', 'route', 'fromSide', 'toSide', 'channelX', 'channelY', 'bias', 'labelAt', 'labelDx', 'labelDy', 'labelSegment'];

const list = (value: unknown): DiagramItem[] => (Array.isArray(value) ? value : []);
const relationKey = (relation: DiagramItem) => relation.id || `${relation.from}>${relation.to}>${relation.label || ''}`;

// Compare semantic identities, endpoints and container membership, not layout.
// Renaming is reported too: this is a review signal, not an accuracy verdict.
function relations(type: string, document: DiagramDocument, shape: Shape): DiagramItem[] {
  if (type === 'tree' || type === 'waterfall') {
    return list(document[shape.elements]).filter((element) => element.parent !== undefined)
      .map((element) => ({ from: element.parent, to: element.id }));
  }
  return list(shape.relations === undefined ? undefined : document[shape.relations]);
}
const relationIdentity = (relation: DiagramItem) => JSON.stringify([relationKey(relation), relation.from, relation.to, relation.label || '']);

function containers(type: string, document: DiagramDocument) {
  const result = new Map<string, Set<unknown>>();
  const add = (key: string, members: unknown[]) => result.set(key, new Set(members));
  if (type === 'architecture') {
    for (const boundary of list(document.boundaries)) add(`boundary:${boundary.kind}:${boundary.label}`, list(boundary.wraps));
  }
  if (type === 'workflow' || type === 'timeline') {
    const elements = list(document[SHAPE[type].elements]);
    for (const lane of list(document.lanes)) add(`lane:${lane.id}`, elements.filter((element) => element.lane === lane.id).map((element) => element.id));
    if (type === 'workflow') {
      for (const group of list(document.groups)) add(`group:${group.id}`, elements.filter((element) => element.lane === group.lane && Number(element.col) >= Number(group.fromCol) && Number(element.col) <= Number(group.toCol)).map((element) => element.id));
      for (const phase of list(document.phases)) add(`phase:${phase.id}`, elements.filter((element) => Number(element.col) >= Number(phase.fromCol) && Number(element.col) <= Number(phase.toCol)).map((element) => element.id));
    }
  }
  if (type === 'dataflow') list(document.stages).forEach((stage, index) => add(`stage:${stage.label}`, list(document.nodes).filter((node) => node.stage === index).map((node) => node.id)));
  if (type === 'erd') {
    const entities = list(document.entities);
    for (const tag of new Set(entities.map((entity) => entity.tag).filter(Boolean))) add(`domain:${tag}`, entities.filter((entity) => entity.tag === tag).map((entity) => entity.id));
  }
  return result;
}

export function contentLost(type: string, first: DiagramDocument | null | undefined, final: DiagramDocument | null | undefined): ContentLoss | null {
  const shape = SHAPE[type];
  if (!shape || !first || !final) return null;
  const finalElements = new Set<unknown>(list(final[shape.elements]).map((element) => element.id));
  const firstRelations = relations(type, first, shape);
  const finalRelations = relations(type, final, shape);
  const remaining = new Map<string, number>();
  for (const relation of finalRelations) {
    const key = relationIdentity(relation);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  const missing: string[] = [];
  for (const relation of firstRelations) {
    const key = relationIdentity(relation);
    const count = remaining.get(key);
    if (count) remaining.set(key, count - 1);
    else missing.push(relationKey(relation));
  }
  const before = containers(type, first);
  const after = containers(type, final);
  const membershipChanges: ContentLoss['membershipChanges'] = [];
  for (const [container, members] of before) {
    const kept = after.get(container);
    if (!kept) continue;
    for (const element of members) if (finalElements.has(element) && !kept.has(element)) membershipChanges.push({ container, element });
  }
  return {
    elements: list(first[shape.elements]).map((element) => element.id).filter((id) => !finalElements.has(id)),
    relations: missing,
    containers: [...before.keys()].filter((key) => !after.has(key)),
    membershipChanges,
    firstCounts: [list(first[shape.elements]).length, firstRelations.length],
    finalCounts: [list(final[shape.elements]).length, finalRelations.length],
  };
}

// Zero means automatic routes; node positions, sizing and grouping remain authored.
export function authoredControls(type: string, document: DiagramDocument | null | undefined) {
  const relations = SHAPE[type]?.relations;
  const counts: Record<string, number> = {};
  for (const relation of list(relations === undefined ? undefined : document?.[relations])) {
    for (const field of ROUTE_CONTROLS) {
      if (relation[field] !== undefined && relation[field] !== 'auto') counts[field] = (counts[field] || 0) + 1;
    }
  }
  return counts;
}

// A benchmark entry must render without the source checkout: drop repository
// evidence and give it a stable output name.
export function benchmarkDocument(document: DiagramDocument, name: string): DiagramDocument {
  const copy = JSON.parse(JSON.stringify(document));
  const strip = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(strip);
    else if (value && typeof value === 'object') {
      Reflect.deleteProperty(value, 'sources');
      Object.values(value).forEach(strip);
    }
  };
  strip(copy);
  if (copy.meta) {
    delete copy.meta.repository;
    copy.meta.output = `${name}.html`;
  }
  return copy;
}

// Agents often pipe finalize through jq, so the exit code is not evidence.
export function finalizeStatus(result: string) {
  if (/"ok":\s*false|"status":\s*"fail"|"(?:validate|deliver|check|browser-check)":\s*"fail"/.test(result)) return 'fail';
  if (/"ok":\s*true|"status":\s*"pass"/.test(result)
    || /"validate":\s*"pass"[^}]*"browser-check":\s*"pass"/.test(result)) return 'pass';
  const exit = result.match(/Exit code: (\d+)/);
  return exit ? (exit[1] === '0' ? 'unknown' : 'fail') : 'unknown';
}

// Include every rendered SVG attribute/text node and the styles that affect it.
// Normalize line endings, comments and newline indentation only; label spaces stay meaningful.
export function renderedSvgFingerprint(html: string) {
  const start = /<svg\b[^>]*\brole=["']img["'][^>]*>/i.exec(html);
  if (!start) throw new Error('Rendered diagram SVG (role="img") is missing');
  const tags = /<\/?svg\b[^>]*>/gi;
  tags.lastIndex = start.index;
  let depth = 0;
  let end: number | undefined;
  for (let tag; (tag = tags.exec(html));) {
    depth += tag[0].startsWith('</') ? -1 : tag[0].endsWith('/>') ? 0 : 1;
    if (depth === 0) { end = tags.lastIndex; break; }
  }
  if (end === undefined) throw new Error('Rendered diagram SVG is incomplete');
  const styles = html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || [];
  const normalized = [html.slice(start.index, end), ...styles].join('\n')
    .replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s*\n\s*</g, '><');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
