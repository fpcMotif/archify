import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseExplainer, type ParsedExplainer } from './parse.ts';
import { isExplainerDocument, validateExplainer } from './validate.ts';
import { resolveExplainerSources } from './sources.ts';
import { parseInline } from './inline.ts';
import { prepareExplainerDiagrams, validateExplainerDiagramTarget } from './diagrams.ts';
import { throwDiagnosticError } from '../diagnostics/diagnostics.ts';
import { errorField, lookupLocation } from './model.ts';
import type { Dependency, ExplainerDocument, PreparedBundle, PreparedDiagram, SourceLocation, SourceMapInput } from './model.ts';

export interface PrepareOptions {
  inputPath?: string | null;
  output?: string;
  writingMode?: string;
  baseDir?: string;
  quality?: string;
  repoRoot?: string;
}

export type ValidatedExplainer = Omit<ParsedExplainer, 'document'> & { document: ExplainerDocument };

export interface ReadBundleOptions {
  checkDependencies?: boolean;
  expectedInputPath?: string;
  quality?: string;
  writingMode?: string;
}

export interface TargetCheckOptions {
  sourceMap?: SourceMapInput;
  sourcePath?: string;
}

export interface DependencyBundle {
  dependencies?: readonly Dependency[];
  sourcePath?: string | null;
}

interface Identity {
  sha256: string;
  bytes: number;
}

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const identity = (bytes: string | Buffer): Identity => ({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes) });
const digest = (bundle: PreparedBundle): string => identity(JSON.stringify({ ...bundle, digest: undefined })).sha256;
function fail(code: string, message: string, input: string | null | undefined, reason: unknown, example = 'Retry from the unchanged original draft and local resources.'): never {
  throwDiagnosticError(message, [{ code: `explainer/${code}`, severity: 'error', message,
    subject: { input, line: 1, component: 'document' }, evidence: { reason, example }, supportedFixes: [example] }]);
}
function requirePath(value: string | null | undefined, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`The ${what} must be a path string.`);
  return value;
}
export function parseValidatedExplainer(sourceText: string, options: PrepareOptions = {}): ValidatedExplainer {
  if (Buffer.byteLength(sourceText) > MAX_SOURCE_BYTES) fail('source-limit', 'Explainer draft exceeds the 16 MiB source budget.', options.inputPath, 'source-byte-limit', 'Reduce the draft below 16 MiB and use relative native diagram sources for large specifications.');
  const parsed = parseExplainer(sourceText, { inputPath: options.inputPath ?? undefined, output: options.output });
  if (!parsed.document || parsed.diagnostics.some(entry => entry.severity !== 'warning')) {
    throwDiagnosticError('Explainer draft could not be parsed.', parsed.diagnostics);
  }
  const { document } = parsed;
  const validated = validateExplainer(document, { sourceMap: parsed.sourceMap, inputPath: options.inputPath ?? undefined, writingMode: options.writingMode });
  if (!validated.ok || !isExplainerDocument(document)) throwDiagnosticError('Explainer draft is invalid.', validated.diagnostics);
  return { ...parsed, document, diagnostics: [...parsed.diagnostics, ...validated.diagnostics] };
}
export async function prepareExplainer(sourceText: string, options: PrepareOptions = {}): Promise<PreparedBundle> {
  const inputPath = path.resolve(requirePath(options.inputPath, 'explainer input path'));
  const parsed = parseValidatedExplainer(sourceText, { ...options, inputPath });
  const baseDir = options.baseDir || path.dirname(inputPath);
  const quality = options.quality || parsed.document.meta?.quality_profile || 'standard';
  const common = { repoRoot: options.repoRoot, baseDir, sourceMap: parsed.sourceMap, sourcePath: inputPath, quality };
  const preparedSources = await resolveExplainerSources(parsed.document, common);
  const preparedDiagrams = await prepareExplainerDiagrams(parsed.document, common);
  validatePreparedTargets(parsed.document, preparedDiagrams.diagrams, common);
  const dependencies = [...(preparedSources.dependencies || []), ...(preparedDiagrams.dependencies || [])].map(entry => ({ ...entry, id: entry.id || entry.blockId,
    ...(entry.kind === 'repository' || entry.inline ? {} : { path: path.resolve(baseDir, requirePath(entry.path, 'dependency path')) }) }));
  const bundle: PreparedBundle = { schemaVersion: 1, kind: 'schematics-explainer-prepared', ...parsed, diagnostics: [...parsed.diagnostics, ...preparedSources.diagnostics], sourcePath: inputPath, baseDir,
    quality, writingMode: options.writingMode || 'warn', source: identity(Buffer.from(sourceText)),
    preparedSources: { sources: preparedSources.sources, assets: preparedSources.assets, ...(Object.keys(preparedSources.charts || {}).length ? { charts: preparedSources.charts } : {}), ...(preparedSources.repository ? { repository: preparedSources.repository } : {}) },
    preparedDiagrams: { diagrams: preparedDiagrams.diagrams }, dependencies };
  bundle.digest = digest(bundle);
  assertPreparedDependencies(bundle);
  return bundle;
}
export function assertPreparedDependencies(bundle: DependencyBundle): void {
  for (const dependency of bundle.dependencies || []) {
    // Repository excerpts were read from the pinned Git object, never the mutable checkout.
    if (dependency.kind === 'repository' || dependency.inline || dependency.retained) {
      if (typeof dependency.contentBase64 === 'string') {
        const frozen = identity(Buffer.from(dependency.contentBase64, 'base64'));
        if (frozen.sha256 !== dependency.sha256 || frozen.bytes !== dependency.bytes) fail('prepared-mismatch', 'Frozen resource bytes do not match their identity.', bundle.sourcePath, 'frozen-resource-byte-mismatch');
      } else if (dependency.retained) fail('prepared-invalid', 'Retained resources require their original frozen bytes.', bundle.sourcePath, 'missing-frozen-resource');
      continue;
    }
    let actual: Identity;
    try { actual = identity(fs.readFileSync(requirePath(dependency.path, 'dependency path'))); } catch (error) {
      fail('dependency-changed', 'A frozen explainer resource is no longer readable.', bundle.sourcePath, errorField(error, 'code') || 'read-failed');
    }
    if (actual.sha256 !== dependency.sha256 || actual.bytes !== dependency.bytes) {
      fail('dependency-changed', 'An explainer resource changed during preparation.', bundle.sourcePath, 'frozen-resource-byte-mismatch');
    }
  }
}
export function writePreparedBundle(directory: string, bundle: PreparedBundle): string {
  const file = path.join(directory, 'explainer.prepared.json');
  const bytes = Buffer.from(JSON.stringify(bundle));
  if (bytes.length > MAX_BUNDLE_BYTES) fail('resource-limit', 'Prepared explainer exceeds the resource budget.', bundle.sourcePath, 'bundle-byte-limit');
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  return file;
}
export function readPreparedBundle(file: string, sourceText: string, inputPath: string, { checkDependencies = true, expectedInputPath = inputPath, quality, writingMode }: ReadBundleOptions = {}): PreparedBundle {
  let bundle: PreparedBundle;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) throw new Error('bundle-byte-limit');
    bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { fail('prepared-invalid', 'Prepared explainer could not be read.', inputPath, errorField(error, 'code') || 'invalid-bundle'); }
  const canonical = (value: string): string => { try { return fs.realpathSync.native(path.resolve(value)); } catch { return path.resolve(value); } };
  const boundPath = bundle.inputPath || bundle.sourcePath;
  if (typeof boundPath !== 'string' || canonical(boundPath) !== canonical(expectedInputPath)) {
    fail('prepared-mismatch', 'Prepared explainer belongs to a different author input path.', inputPath, 'draft-path-mismatch');
  }
  const source = identity(Buffer.from(sourceText));
  if (bundle?.kind !== 'schematics-explainer-prepared' || bundle.schemaVersion !== 1 || bundle.digest !== digest(bundle)
    || source.sha256 !== bundle.source?.sha256 || source.bytes !== bundle.source?.bytes || bundle.sourceText !== sourceText) {
    fail('prepared-mismatch', 'Prepared explainer does not match the original draft bytes.', inputPath, 'draft-or-bundle-digest-mismatch');
  }
  if (quality && quality !== bundle.quality) fail('prepared-mismatch', 'Prepared explainer uses a different quality profile.', inputPath, 'quality-profile-mismatch', 'Prepare the original draft again under the requested quality profile.');
  if (writingMode && writingMode !== (bundle.writingMode || 'warn')) fail('prepared-mismatch', 'Prepared explainer uses a different writing check mode.', inputPath, 'writing-mode-mismatch', 'Prepare the original draft again under the requested writing check mode.');
  const parsed = parseValidatedExplainer(sourceText, { inputPath: bundle.sourcePath, writingMode: bundle.writingMode || 'warn' });
  if (JSON.stringify(parsed.document) !== JSON.stringify(bundle.document)) fail('prepared-mismatch', 'Prepared document differs from the authored draft.', inputPath, 'normalized-document-mismatch');
  if (checkDependencies) assertPreparedDependencies(bundle);
  return bundle;
}
export function rebindPreparedBundle(bundle: PreparedBundle, parsed: ValidatedExplainer): PreparedBundle {
  const next: PreparedBundle = { ...bundle, ...parsed, source: identity(Buffer.from(parsed.sourceText)) };
  next.digest = digest(next);
  return next;
}

export function validatePreparedTargets(document: ExplainerDocument, diagrams: Readonly<Record<string, PreparedDiagram | undefined>>, options: TargetCheckOptions = {}): void {
  const visit = (value: unknown, pointer: string, panelId: string | undefined, component: string): void => {
    if (typeof value === 'string') {
      const location: Partial<SourceLocation> = lookupLocation(options.sourceMap, pointer) || {};
      const inline = parseInline(value, { line: location.line || 1, input: options.sourcePath, panelId, component });
      for (const reference of inline.references) {
        if (reference.kind !== 'node' && reference.kind !== 'route') continue;
        const target = reference.kind === 'node' ? {diagram:reference.diagram,node:reference.node} : {diagram:reference.diagram,route:[reference.from,reference.to]};
        const line = (location.line || 1) + (value.slice(0,reference.offset).match(/\n/g)?.length || 0);
        validateExplainerDiagramTarget(diagrams,target,{...options,pointer,line});
      }
    } else if (Array.isArray(value)) value.forEach((entry,index)=>visit(entry,`${pointer}/${index}`,panelId,component));
    else if (value && typeof value === 'object') for(const [key,entry] of Object.entries(value)) {
      if (['spec','source','path','language','target','changes'].includes(key) || (['diff','snippet'].includes(component) && key==='text')) continue;
      visit(entry,`${pointer}/${key}`,panelId,component);
    }
  };
  visit(document.answer,'/answer',undefined,'answer');
  document.panels.forEach((panel,index)=>{
    visit(panel.title,`/panels/${index}/title`,panel.id,'panel');
    panel.blocks.forEach((block,blockIndex)=>{
      const pointer=`/panels/${index}/blocks/${blockIndex}`;
      visit(block,pointer,panel.id,block.type);
      if(block.type==='steps') block.items.forEach((item,itemIndex)=>{
        if(item.target)validateExplainerDiagramTarget(diagrams,item.target,{...options,pointer:`${pointer}/items/${itemIndex}/target`,line:lookupLocation(options.sourceMap,`${pointer}/items/${itemIndex}`)?.line || lookupLocation(options.sourceMap,pointer)?.line || 1});
      });
    });
  });
}
