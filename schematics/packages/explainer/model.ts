import type { Diagnostic } from '../diagnostics/diagnostics.ts';

export type { Diagnostic };

export interface SourceLocation {
  line: number;
  column: number;
  start: number;
  end: number;
}

export type SourceMap = Record<string, SourceLocation>;

export type SourceMapInput = Readonly<Record<string, Partial<SourceLocation> | undefined>> | ReadonlyMap<string, Partial<SourceLocation> | undefined>;

export function lookupLocation(map: SourceMapInput | null | undefined, pointer: string): Partial<SourceLocation> | undefined {
  if (map instanceof Map) return map.get(pointer);
  return map ? Reflect.get(map, pointer) : undefined;
}

export function errorField(error: unknown, key: string): unknown {
  return error !== null && typeof error === 'object' ? Reflect.get(error, key) : undefined;
}

export function errorDiagnostics(error: unknown, key = 'schematicsDiagnostics'): Diagnostic[] | undefined {
  const value = errorField(error, key);
  return Array.isArray(value) ? value : undefined;
}

export function errorText(error: unknown, key: string): string | undefined {
  const value = errorField(error, key);
  return typeof value === 'string' ? value : undefined;
}

export interface RepositoryMeta {
  url?: string;
  revision?: string;
  provider?: string;
  link_mode?: string;
}

export interface ExplainerMeta {
  id?: string;
  title?: string;
  locale?: string;
  quality_profile?: string;
  style?: string;
  output?: string;
  repository?: RepositoryMeta;
}

export interface ExplainerAnswer {
  summary: string;
  reasons?: string[];
  scope?: string;
}

export interface ExplainerSource {
  id: string;
  title?: string;
  url?: string;
  path?: string;
  lines?: number[];
  revision?: string;
}

export interface DiagramTarget {
  diagram: string;
  node?: string;
  route?: string[];
  edges?: string[];
}

export interface ExplainerStep {
  id: string;
  text: string;
  detail?: string;
  target?: DiagramTarget;
}

export interface FactEntry {
  key: string;
  value: string;
}

export interface ComparisonCell {
  text: string;
  assessment?: string;
  verdict?: string;
}

export interface ComparisonRow {
  id: string;
  label: string;
  cells: ComparisonCell[];
}

export interface DiagramChange {
  target: string;
  change: string;
}

export interface ChartData {
  path: string;
  kind: string;
  x: string;
  y: string[];
  unit?: string;
}

export interface NativeSpec {
  schema_version?: number;
  diagram_type?: string;
  meta?: { title?: string; locale?: string; canvas?: { width?: number } } & Record<string, unknown>;
  lanes?: { id: string }[];
  [key: string]: unknown;
}

interface BlockBase {
  id: string;
}

export interface ProseBlock extends BlockBase { type: 'prose'; text: string }
export interface ListBlock extends BlockBase { type: 'list'; items: string[]; ordered?: boolean; checklist?: boolean }
export interface CalloutBlock extends BlockBase { type: 'callout'; level: string; title?: string; text: string }
export interface FactsBlock extends BlockBase { type: 'facts'; entries: FactEntry[] }
export interface MetricBlock extends BlockBase { type: 'metric'; label?: string; unit?: string; note?: string; value?: number; limit?: number; typical?: boolean }
export interface StepsBlock extends BlockBase { type: 'steps'; items: ExplainerStep[] }
export interface DiagramBlock extends BlockBase {
  type: 'diagram';
  diagramType: string;
  source?: string;
  spec?: NativeSpec;
  title?: string;
  changes?: DiagramChange[];
  nodeSources?: Record<string, string>;
}
export interface CodeBlock extends BlockBase { type: 'code'; source: string; language?: string }
export interface DiffBlock extends BlockBase { type: 'diff'; text: string; caption?: string }
export interface ImageBlock extends BlockBase { type: 'image'; path: string; alt: string; caption?: string }
export interface ChartBlock extends BlockBase { type: 'chart'; title?: string; text?: string; data?: ChartData }
export interface SnippetBlock extends BlockBase { type: 'snippet'; language?: string; title?: string; text: string }
export interface ComparisonBlock extends BlockBase { type: 'comparison'; labelColumn?: string; columns: string[]; rows: ComparisonRow[] }

export type ExplainerBlock = ProseBlock | ListBlock | CalloutBlock | FactsBlock | MetricBlock | StepsBlock | DiagramBlock
  | CodeBlock | DiffBlock | ImageBlock | ChartBlock | SnippetBlock | ComparisonBlock;

export interface ExplainerPanel {
  id: string;
  title: string;
  span?: number;
  blocks: ExplainerBlock[];
}

export interface ExplainerDocument {
  schema_version: number;
  diagram_type: string;
  meta: ExplainerMeta;
  answer: ExplainerAnswer;
  panels: ExplainerPanel[];
  sources: ExplainerSource[];
}

export interface FrozenBytes {
  sha256: string;
  bytes: number;
  contentBase64: string;
}

export interface Dependency {
  kind: string;
  id?: string;
  sha256: string;
  bytes: number;
  contentBase64?: string;
  path?: string | null;
  relativePath?: string;
  revision?: string;
  inline?: boolean;
  retained?: boolean;
  blockId?: string;
}

export interface PreparedSource {
  id: string;
  title?: string;
  url?: string;
  path?: string;
  lines?: readonly number[];
  revision?: string;
  text?: string;
  sha256?: string;
  bytes?: number;
}

export interface PreparedAsset {
  id: string;
  alt?: string;
  path: string;
  mime: string;
  sha256: string;
  bytes: number;
  contentBase64: string;
  dataUrl: string;
}

export interface SemanticNode {
  id: string;
  label: string;
  svgId?: string;
}

export interface SemanticEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  key?: string;
}

export interface DiagramSemantic {
  nodes: SemanticNode[];
  edges: SemanticEdge[];
}

export interface DiagramChecks {
  validate?: { ok: boolean };
  render?: { ok: boolean };
  check?: Record<string, unknown> & { file?: unknown };
  [key: string]: unknown;
}

export interface PreparedDiagram {
  diagramType: string;
  spec?: NativeSpec;
  html: string;
  svg: string;
  sha256?: string;
  bytes?: number;
  specification?: FrozenBytes;
  checks?: DiagramChecks;
  semantic: DiagramSemantic;
  changes?: DiagramChange[];
  styles?: string;
  composition?: unknown;
  specSha256?: string;
}

export interface RepositoryIdentity {
  url: string;
  revision: string;
  [key: string]: unknown;
}

export interface PreparedSources {
  sources: Record<string, PreparedSource | null>;
  assets: Record<string, PreparedAsset>;
  charts?: Record<string, string | undefined>;
  repository?: RepositoryIdentity;
}

export interface PreparedDiagrams {
  diagrams: Record<string, PreparedDiagram>;
  dependencies?: Dependency[];
}

export interface PreparedBundle {
  schemaVersion: number;
  kind: string;
  document: ExplainerDocument;
  sourceMap: SourceMap;
  format: string;
  sourceText: string;
  diagnostics: Diagnostic[];
  sourcePath?: string | null;
  inputPath?: string | null;
  baseDir?: string | null;
  quality?: string;
  writingMode?: string;
  source: { sha256: string; bytes: number };
  preparedSources: PreparedSources;
  preparedDiagrams: PreparedDiagrams;
  dependencies: Dependency[];
  digest?: string;
}
