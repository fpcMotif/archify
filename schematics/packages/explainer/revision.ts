import { createHash } from 'node:crypto';
import type { Dependency, PreparedAsset, PreparedDiagram, PreparedSource } from './model.ts';
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

export type SourceRecord = Readonly<Record<string, Partial<PreparedSource> | null | undefined>>;
export type AssetRecord = Readonly<Record<string, Partial<PreparedAsset> | null | undefined>>;
export type DiagramRecord = Readonly<Record<string, Partial<PreparedDiagram> | null | undefined>>;

export interface PreparedSourcesInput {
  sources?: SourceRecord;
  assets?: AssetRecord;
  charts?: Readonly<Record<string, string | undefined>>;
  dependencies?: readonly Dependency[];
}

export interface PreparedDiagramsInput {
  diagrams?: DiagramRecord;
  dependencies?: readonly Dependency[];
}

export type SourcesInput = PreparedSourcesInput | SourceRecord;
export type DiagramsInput = PreparedDiagramsInput | DiagramRecord;

export interface RevisionInput {
  document?: unknown;
  sourceText?: string;
  preparedSources?: SourcesInput;
  preparedDiagrams?: DiagramsInput;
  dependencies?: readonly Dependency[];
}

function flatSources(input: SourcesInput): input is SourceRecord {
  return !Reflect.get(input, 'sources');
}

function flatDiagrams(input: DiagramsInput): input is DiagramRecord {
  return !Reflect.get(input, 'diagrams');
}

export function preparedSourceRecord(input: SourcesInput): SourceRecord {
  return flatSources(input) ? input : input.sources || {};
}

function isAssetRecord(value: unknown): value is AssetRecord {
  return Boolean(value) && typeof value === 'object';
}

export function preparedAssetRecord(input: SourcesInput): AssetRecord {
  const assets: unknown = Reflect.get(input, 'assets');
  return isAssetRecord(assets) ? assets : {};
}

export function preparedDiagramRecord(input: DiagramsInput): DiagramRecord {
  return flatDiagrams(input) ? input : input.diagrams || {};
}

export function preparedDependencies(input: SourcesInput | DiagramsInput): readonly Dependency[] | undefined {
  const dependencies: unknown = Reflect.get(input, 'dependencies');
  if (!dependencies) return undefined;
  if (!Array.isArray(dependencies)) throw new TypeError('Prepared dependencies must be an array.');
  return dependencies;
}

function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new TypeError(`Missing prepared ${what}.`);
  return value;
}

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([,entry])=>entry !== undefined).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0).map(([key,entry])=>[key,stable(entry)])) : value;

function hashText(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Prepared text must be a string.');
  return hash(value);
}

/** Stable authored-content identity; excludes filesystem relocation and outer reader presentation. */
export function computeExplainerRevision({document,sourceText=JSON.stringify(document),preparedSources={},preparedDiagrams={},dependencies}: RevisionInput): string {
  const sourceSha256 = hash(sourceText);
  const sources = preparedSourceRecord(preparedSources);
  const assets = preparedAssetRecord(preparedSources);
  const diagrams = preparedDiagramRecord(preparedDiagrams);
  const ordered = (entries: readonly unknown[]): unknown[] => entries.map(stable).sort((a,b)=>JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  const resourceIdentity = {
    version:1,sourceSha256,documentSha256:hash(JSON.stringify(stable(document))),
    dependencies:ordered((dependencies || [...(preparedDependencies(preparedSources) || []),...(preparedDependencies(preparedDiagrams) || [])]).map(({kind,id,sha256,bytes})=>({kind,id,sha256,bytes}))),
    sources:Object.fromEntries(Object.entries(sources).map(([id,entry])=>{const source=present(entry,'source');return [id,{title:source.title,url:source.url,path:source.path,lines:source.lines,revision:source.revision,textSha256:typeof source.text === 'string' ? hash(source.text) : undefined}];})),
    children:Object.fromEntries(Object.entries(diagrams).map(([id,entry])=>{const child=present(entry,'diagram');return [id,{htmlSha256:hashText(child.html),specSha256:hash(JSON.stringify(stable(child.spec || {})))}];})),
    assets:Object.fromEntries(Object.entries(assets).map(([id,entry])=>{const asset=present(entry,'asset');return [id,{sha256:asset.sha256,dataSha256:hashText(asset.dataUrl || ''),mime:asset.mime,bytes:asset.bytes}];}))
  };
  return hash(JSON.stringify(stable(resourceIdentity)));
}
