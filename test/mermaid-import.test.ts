import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importMermaid, MermaidImportError } from '../schematics/packages/mermaid/import.ts';

const cli = path.join(import.meta.dir, '..', 'schematics', 'bin', 'schematics.ts');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schematics-mermaid-import-'));
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

type Diagram = Record<string, any>;

function run(...args: string[]) {
  const child = Bun.spawnSync([process.execPath, cli, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, SCHEMATICS_CACHE_DIR: path.join(workDir, 'cache') },
  });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

function expectValid(type: string, diagram: Diagram) {
  const file = path.join(workDir, `${type}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(diagram));
  const result = run('validate', type, file, '--json');
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
}

function importCode(text: string): string {
  try {
    importMermaid(text);
  } catch (error) {
    if (error instanceof MermaidImportError) return error.code;
    throw error;
  }
  throw new Error('import succeeded');
}

const FLOWCHART = `flowchart LR
  dev[Developer push] --> ci(CI build)
  ci --> tests{Tests pass?}
  tests -- no --> dev
  tests -- yes --> stage[Deploy to staging]
  subgraph prod [Production]
    canary[Canary 5%] ==> full[Full rollout]
  end
  stage --> canary
  canary -.-> metrics[(Metrics store)]`;

const SEQUENCE = `sequenceDiagram
  actor Shopper
  participant API as Checkout API
  participant DB@{ "type": "database" }
  Shopper->>+API: POST /orders
  loop retry
    API->>DB: insert order
    DB-->>API: row
  end
  Note over API: cache
  API-->>-Shopper: 201 Created
  Shopper-)API: async ping
  API->>API: self call`;

const STATE = `stateDiagram-v2
  [*] --> Idle
  Idle --> Run: start
  Run --> Failed: error
  Failed --> Idle: retry
  Run --> Done: finish
  Done --> [*]
  Failed --> [*]
  state Run {
    [*] --> Plan
    Plan --> Execute
  }`;

const ER = `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  CUSTOMER {
    string id PK
    string email UK
  }
  ORDER {
    int id PK
    string customer_id FK
    string warehouse_id FK
  }`;

const CLASS = `classDiagram
  Animal <|-- Dog
  Dog *-- Tail
  Dog ..> Food : eats
  Pet <|.. Dog
  class Pet {
    <<interface>>
  }
  class Animal {
    <<abstract>>
    +String name
    +speak()* void
  }
  class Dog {
    -int age
    +bark(int times) void
  }`;

describe('importMermaid', () => {
  test('flowchart becomes a valid workflow with lanes, ranks and edge styles', () => {
    const { type, diagram, notes } = importMermaid(FLOWCHART, { title: 'Release pipeline' });
    expect(type).toBe('workflow');
    expect(diagram.meta).toEqual({ title: 'Release pipeline', output: 'release-pipeline.html' });
    const node = (id: string) => diagram.nodes.find((entry: Diagram) => entry.id === id);
    expect(node('canary').lane).toBe(node('full').lane);
    expect(node('dev').lane).not.toBe(node('canary').lane);
    expect([node('dev').col, node('ci').col, node('tests').col, node('stage').col]).toEqual([0, 1, 2, 3]);
    expect(node('metrics').type).toBe('database');
    const edge = (from: string, to: string) => diagram.edges.find((entry: Diagram) => entry.from === from && entry.to === to);
    expect(edge('canary', 'metrics').variant).toBe('dashed');
    expect(edge('canary', 'full').variant).toBe('emphasis');
    expect(edge('tests', 'stage').label).toBe('yes');
    expect(Array.isArray(notes)).toBe(true);
    expectValid('workflow', diagram);
  });

  test('sequence keeps participants, returns, async calls, blocks and activations', () => {
    const { type, diagram, notes } = importMermaid(SEQUENCE);
    expect(type).toBe('sequence');
    const kinds = Object.fromEntries(diagram.participants.map((entry: Diagram) => [entry.id, entry.type]));
    expect(kinds).toEqual({ Shopper: 'external', API: 'backend', DB: 'database' });
    const byLabel = (label: string) => diagram.messages.find((entry: Diagram) => entry.label === label);
    expect(byLabel('row').variant).toBe('return');
    expect(byLabel('async ping').variant).toBe('dashed');
    expect(byLabel('row').note).toBe('cache');
    expect(diagram.messages.some((entry: Diagram) => entry.label === 'self call')).toBe(false);
    expect(notes.some((note) => note.startsWith('Dropped 1 self-message'))).toBe(true);
    const ys = diagram.messages.map((entry: Diagram) => entry.y);
    expect(ys).toEqual([...ys].sort((a: number, b: number) => a - b));
    expect(ys[0]).toBeGreaterThanOrEqual(160);
    expect(diagram.segments).toHaveLength(1);
    expect(diagram.activations.length).toBeGreaterThan(0);
    expectValid('sequence', diagram);
  });

  test('state diagram becomes a lifecycle with a success main path and failure outcome', () => {
    const { type, diagram } = importMermaid(STATE);
    expect(type).toBe('lifecycle');
    expect(diagram.mainPath).toEqual(['Idle', 'Plan', 'Execute', 'Done']);
    const kind = (id: string) => diagram.states.find((entry: Diagram) => entry.id === id)?.type;
    expect(kind('Done')).toBe('success');
    expect(kind('Failed')).toBe('failure');
    expectValid('lifecycle', diagram);
  });

  test('ER diagram keeps keys, infers foreign key targets and maps both cardinality sides', () => {
    const { type, diagram, notes } = importMermaid(ER);
    expect(type).toBe('erd');
    const order = diagram.entities.find((entry: Diagram) => entry.id === 'ORDER');
    const column = (name: string) => order.attributes.find((entry: Diagram) => entry.name === name);
    expect(column('id').key).toBe('pk');
    expect(column('customer_id')).toMatchObject({ key: 'fk', references: 'CUSTOMER.id' });
    expect(column('warehouse_id').key).toBeUndefined();
    expect(notes.some((note) => note.includes('warehouse_id'))).toBe(true);
    const places = diagram.relationships.find((entry: Diagram) => entry.label === 'places');
    expect([places.from, places.to]).toEqual(['CUSTOMER', 'ORDER']);
    expect(places.fromCardinality).not.toBe(places.toCardinality);
    expectValid('erd', diagram);
  });

  test('class diagram keeps kinds, members and relationship directions', () => {
    const { type, diagram } = importMermaid(CLASS);
    expect(type).toBe('class');
    const kind = (id: string) => diagram.types.find((entry: Diagram) => entry.id === id)?.kind;
    expect([kind('Animal'), kind('Pet'), kind('Dog')]).toEqual(['abstract', 'interface', 'class']);
    const relation = (kindName: string) => diagram.relationships.find((entry: Diagram) => entry.kind === kindName);
    expect([relation('inheritance').from, relation('inheritance').to]).toEqual(['Dog', 'Animal']);
    expect([relation('realization').from, relation('realization').to]).toEqual(['Dog', 'Pet']);
    expect([relation('composition').from, relation('composition').to]).toEqual(['Dog', 'Tail']);
    expectValid('class', diagram);
  });

  test('timeline periods become dated events and undated periods are refused', () => {
    const { type, diagram } = importMermaid(`timeline
  section 2025
    Q1 : Alpha : Private beta
    Q3 : 1.0 launch
  section 2026
    Mar : Plugins
    2026-05-14 : Cloud sync
    Q4 2026 : Teams`);
    expect(type).toBe('timeline');
    expect(diagram.meta).toMatchObject({ evidence: 'illustrative', timezone: 'UTC' });
    expect(diagram.layout).toEqual({ scale: 'date' });
    expect(diagram.events.map((event: Diagram) => [event.at, event.title])).toEqual([
      ['2025-01-01T00:00Z', 'Alpha'],
      ['2025-01-01T00:00Z', 'Private beta'],
      ['2025-07-01T00:00Z', '1.0 launch'],
      ['2026-03-01T00:00Z', 'Plugins'],
      ['2026-05-14T00:00Z', 'Cloud sync'],
      ['2026-10-01T00:00Z', 'Teams'],
    ]);
    expect(new Set(diagram.events.map((event: Diagram) => event.id)).size).toBe(6);
    expectValid('timeline', diagram);
    expect(importCode('timeline\n  Discovery : Interviews\n  2025 : Launch')).toBe('mermaid/timeline-undated');
  });

  test('mind map becomes a tree with one root', () => {
    const { type, diagram, notes } = importMermaid(`mindmap
  root((Schematics))
    Renderers
      Sequence
      Workflow
    Viewer
      Themes
        ::icon(fa fa-moon)`);
    expect(type).toBe('tree');
    const byLabel = (label: string) => diagram.nodes.find((node: Diagram) => node.label === label);
    expect(byLabel('Schematics').parent).toBeUndefined();
    expect(byLabel('Sequence').parent).toBe(byLabel('Renderers').id);
    expect(byLabel('Themes').parent).toBe(byLabel('Viewer').id);
    expect(diagram.nodes).toHaveLength(6);
    expect(notes.some((note) => note.startsWith('Dropped icons'))).toBe(true);
    expectValid('tree', diagram);
  });

  test('architecture-beta keeps groups, side hints and arrow direction', () => {
    const { type, diagram } = importMermaid(`architecture-beta
  group api(cloud)[API tier]
  service gateway(internet)[Gateway]
  service server(server)[App server] in api
  service db(database)[Postgres] in api
  service disk1(disk)[Object storage] in api
  gateway:R --> L:server
  db:L <-- R:server
  server:B -- T:disk1`);
    expect(type).toBe('architecture');
    const component = (id: string) => diagram.components.find((entry: Diagram) => entry.id === id);
    expect([component('gateway').type, component('server').type, component('db').type]).toEqual(['external', 'backend', 'database']);
    expect([component('gateway').col, component('server').col, component('db').col]).toEqual([0, 1, 2]);
    expect(component('disk1').row).toBe(component('server').row + 1);
    expect(diagram.boundaries).toEqual([{ kind: 'region', label: 'API tier', wraps: ['server', 'db', 'disk1'] }]);
    const link = (from: string, to: string) => diagram.connections.find((entry: Diagram) => entry.from === from && entry.to === to);
    expect(link('gateway', 'server')).toMatchObject({ fromSide: 'right', toSide: 'left' });
    expect(link('server', 'db')).toMatchObject({ fromSide: 'right', toSide: 'left' });
    expectValid('architecture', diagram);
  });

  test('unsupported or unmappable input fails with a stable code', () => {
    expect(importCode('flowchart LR\n  A -->')).toBe('mermaid/parse');
    expect(importCode('pie title Pets\n  "Dogs" : 3\n  "Cats" : 2')).toBe('mermaid/unsupported-type');
    expect(importCode('stateDiagram-v2\n  [*] --> A\n  state A {\n    [*] --> B\n    --\n    [*] --> C\n  }')).toBe('mermaid/concurrent-state');
    expect(importCode('stateDiagram-v2\n  [*] --> A\n  B --> C')).toBe('mermaid/no-main-path');
    expect(importCode('flowchart LR\n  A --> B --> C --> D --> E --> F --> G')).toBe('mermaid/workflow-too-wide');
  });
});

describe('schematics import mermaid', () => {
  test('writes the diagram and prints the finalize step', () => {
    const input = path.join(workDir, 'release.mmd');
    const output = path.join(workDir, 'release.json');
    fs.writeFileSync(input, FLOWCHART);
    const result = run('import', 'mermaid', input, output, '--title', 'Release pipeline');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Next: schematics finalize workflow ${output}`);
    const diagram = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(diagram.meta).toEqual({ title: 'Release pipeline', output: 'release.html' });
  });

  test('reports an import failure as a JSON receipt', () => {
    const input = path.join(workDir, 'pie.mmd');
    fs.writeFileSync(input, 'pie\n  "A" : 1');
    const result = run('import', 'mermaid', input, '--json');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, command: 'import', code: 'mermaid/unsupported-type' });
  });
});
