import type { WorkflowDocument, WorkflowNode } from './workflow-document.ts';

export interface PlacementComponent {
  ids: string[];
  cyclic: boolean;
}

export interface PlacementChange {
  op: 'replace' | 'add';
  path: string;
  value: number | undefined;
}

export type PlacementProposal =
  | { eligible: false; reason: string }
  | {
    eligible: true;
    proposed: WorkflowDocument;
    changes: PlacementChange[];
    components: PlacementComponent[];
    rails: { left: boolean; right: boolean };
  };

function required<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new TypeError(`Workflow placement has no entry for ${JSON.stringify(key)}.`);
  return value;
}

// One optional placement proposal for a failed readable workflow.
// Never applied to the authored input; the compiler verifies the complete result.
export function proposeWorkflowPlacement(input: WorkflowDocument): PlacementProposal {
  if (input.schema_version !== 2 || input.meta?.viewBox
    || input.groups?.length || input.phases?.length
    || !input.mainPath?.length || input.nodes.length > 64
    || input.edges.some(e => (['via', 'channelX', 'channelY', 'labelAt'] as const).some(k => e[k] !== undefined))) {
    return { eligible: false, reason: 'Needs unpinned v2, complete mainPath, no authored regions, <=64 nodes.' };
  }
  const main = input.mainPath;
  const mainIndex = new Map(main.map((id, i) => [id, i]));
  const nodes = new Map(input.nodes.map(n => [n.id, n]));
  const laneIndex = new Map(input.lanes.map((l, i) => [l.id, i]));
  if (main.some(id => !nodes.has(id)) || new Set(main).size !== main.length)
    return { eligible: false, reason: 'Invalid mainPath.' };
  const out = new Map(input.nodes.map(n => [n.id, input.edges.filter(e => e.from === n.id).map(e => e.to)]));
  function reachable(id: string): Set<string> {
    const found = new Set<string>(), todo = [...required(out, id)];
    while (todo.length) {
      const next = todo.pop();
      if (next === undefined || found.has(next) || !nodes.has(next)) continue;
      found.add(next); todo.push(...required(out, next));
    }
    return found;
  }
  const reach = new Map(input.nodes.map(n => [n.id, reachable(n.id)]));
  const offMain = input.nodes.filter(n => !mainIndex.has(n.id));
  const offIds = new Set(offMain.map(n => n.id));
  const components: PlacementComponent[] = [], assigned = new Set<string>();
  for (const n of offMain) {
    if (assigned.has(n.id)) continue;
    const component: string[] = [], todo = [n.id];
    while (todo.length) {
      const id = todo.pop();
      if (id === undefined || assigned.has(id)) continue;
      assigned.add(id); component.push(id);
      for (const e of input.edges) {
        if (e.from === id && offIds.has(e.to)) todo.push(e.to);
        if (e.to === id && offIds.has(e.from)) todo.push(e.from);
      }
    }
    const cyclic = component.some(id => main.some(m => required(reach, id).has(m) && required(reach, m).has(id)));
    components.push({ ids: component, cyclic });
  }
  const leftRail = components.some(c => c.cyclic);
  if (!leftRail) return { eligible: false, reason: 'No return cycle connected to the main path.' };
  const rightRail = components.some(c => !c.cyclic && c.ids.length > 1);
  const start = leftRail ? 1 : 0, end = rightRail ? 4 : 5;
  const proposed = structuredClone(input), moved = new Map(proposed.nodes.map(n => [n.id, n]));
  let col = start;
  for (let i = 0; i < main.length; i++) {
    const current = required(moved, main[i]), previous = moved.get(main[i - 1]);
    if (previous && (laneIndex.get(current.lane) ?? NaN) <= (laneIndex.get(previous.lane) ?? NaN)) col = Math.min(col + 1, end);
    current.col = col;
  }
  for (const component of components) {
    for (const id of component.ids) {
      const n = required(moved, id);
      const parents = input.edges.filter(e => e.to === id && mainIndex.has(e.from)).map(e => required(moved, e.from));
      n.col = component.cyclic ? 0 : component.ids.length > 1 ? 5
        : Math.min(end, Math.max(start, ...parents.map(p => p.col + 1)));
      // Place same-lane failure branches below their main-path source row.
      if (component.cyclic && parents.some(p => p.lane === n.lane)) {
        const sameLane = main.map(m => required(moved, m)).filter(m => m.lane === n.lane);
        n.yOffset = Math.max(...sameLane.map(m => (m.yOffset || 0) + (m.height || 52) / 2)) + (n.height || 52) / 2 + 40;
      }
    }
  }
  const groups = new Map<string, WorkflowNode[]>();
  for (const n of proposed.nodes) {
    const key = n.lane + ':' + n.col;
    groups.set(key, [...groups.get(key) || [], n]);
  }
  function order(n: WorkflowNode): number {
    const index = mainIndex.get(n.id);
    if (index !== undefined) return index;
    const incoming = input.edges.filter(e => e.to === n.id && mainIndex.has(e.from)).map(e => required(mainIndex, e.from));
    return incoming.length ? Math.min(...incoming) + 0.5 : main.length;
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
    const total = group.reduce((sum, n) => sum + (n.height || 52), 0) + 40 * (group.length - 1);
    let top = -total / 2;
    for (const n of group) {
      n.yOffset = top + (n.height || 52) / 2;
      top += (n.height || 52) + 40;
    }
  }
  const changes: PlacementChange[] = [];
  for (let i = 0; i < input.nodes.length; i++) for (const field of ['col', 'yOffset'] as const) {
    if (input.nodes[i][field] !== proposed.nodes[i][field]) changes.push({op: field in input.nodes[i] ? 'replace' : 'add', path: `/nodes/${i}/${field}`, value: proposed.nodes[i][field]});
  }
  return {eligible: true, proposed, changes, components, rails: {left: leftRail, right: rightRail}};
}
