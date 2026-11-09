import { softwareNoticesHtml } from '../output/software-notices.ts';
import fs from 'node:fs';
import path from 'node:path';
import { applyTemplate, renderCards, esc, type InfoCard } from './utils.ts';
import { validateSchema } from '../validation/validator.ts';
import { verifyRepositoryEvidence, type SourceEvidence } from '../repository/repository-evidence.ts';
import { installRendererDiagnosticBoundary, throwDiagnosticError, throwDiagnosticProblems, recordDiagnostic } from '../diagnostics/diagnostics.ts';
import { validateEngineeringProfile } from './engineering-profiles.ts';
import {
  resolveOutputPath,
  validateAuthoredOutputPath,
  type ResolveOutputPathOptions,
} from '../output/output-path.ts';
import {
  captureAtomicOutput,
  captureRegularFileBinding,
  publishRegularFileBinding,
  releaseRegularFileBinding,
  removeOwnedRegularFile,
  verifyAtomicOutput,
  type FileIdentity,
  type RegularFileBinding,
  type RelationReason,
} from '../output/atomic-output.ts';
import { readField } from '../output/path-semantics.ts';
import { resolveLocale, translateMessage, registerLocale, localeDiagnostics, type LocaleMeta, type Translations } from '../i18n/i18n.ts';
import { prepareDiagramBrandMarks } from './brand-marks.ts';

export interface DiagramMeta {
  title: string;
  subtitle?: string;
  locale?: string;
  translations?: Translations;
  output?: string;
  visual_preset?: string;
  quality_profile?: string;
  engineering_profile?: string;
}

export interface LoadDiagramOptions {
  rendererDir: string;
  diagramType: string;
  defaultExample: string;
  argv?: readonly string[];
}

export interface LoadedDiagram<D> {
  diagram: D;
  template: string;
  outPath: string;
  sourceEvidence: SourceEvidence | null;
}

export interface WriteDiagramOptions {
  outPath: string;
  template: string;
  diagramType: string;
  meta: DiagramMeta;
  svg: string;
  cards?: InfoCard[] | undefined;
  sourceEvidence?: SourceEvidence | null;
}

export interface FocusNodeMetadata {
  kind?: unknown;
  sublabel?: unknown;
  tag?: unknown;
  context?: unknown;
  brand?: unknown;
  brandId?: unknown;
  brandStatus?: unknown;
  brandSource?: unknown;
}

interface FilesystemError {
  code: string;
  syscall: string;
  errno: number;
  message?: unknown;
}

interface AtomicOutputOutcome {
  status: string;
  reason?: RelationReason | null;
}

const outputPathGuards = new Map<string, ResolveOutputPathOptions>();
let renderCandidateSequence = 0;

function isLocaleMeta(value: unknown): value is LocaleMeta {
  const locale = readField(value, 'locale');
  const translations = readField(value, 'translations');
  return (locale === undefined || locale === null || typeof locale === 'string')
    && (translations === undefined || translations === null || typeof translations === 'object');
}

// meta.locale is renderer-owned Viewer UI, not authored content. Each message
// resolves as: valid meta.translations value → bundled catalog enrolled in
// locales/manifest.json → English (see i18n.ts). Every fallback is disclosed
// by human renderers on stderr. Diagnostic JSON mode records warnings without
// mixing text into failure receipts; validate/deliver disclose them publicly.
function applyLocaleTranslations(diagramType: string, diagram: unknown): void {
  const meta = readField(diagram, 'meta');
  if (!isLocaleMeta(meta)) return;
  const locale = meta.locale;
  if (!locale) return;
  registerLocale(locale, meta.translations);
  for (const diagnostic of localeDiagnostics(diagramType, meta)) {
    recordDiagnostic(diagnostic);
    if (process.env.SCHEMATICS_DIAGNOSTIC_FORMAT !== 'json') {
      console.warn(`schematics: ${diagnostic.message}`);
    }
  }
}

// Common CLI head: node render-<type>.mjs [input.json] [output.html]
// Keep this synchronous because callers also use it to establish the guarded
// output path before testing a last-moment filesystem alias change.
export function loadDiagram<D>({ rendererDir, diagramType, defaultExample, argv = process.argv }: LoadDiagramOptions): LoadedDiagram<D> {
  // Compilers also import this module for SVG helpers. Only CLI execution
  // should install a process-level handler, before reading or validating input.
  installRendererDiagnosticBoundary();
  const skillRoot = path.resolve(rendererDir, '../..');
  const inputPath = path.resolve(argv[2] || path.join(skillRoot, 'examples', defaultExample));
  let input: string;
  try {
    input = fs.readFileSync(inputPath, 'utf8');
  } catch (error) {
    if (!isFilesystemError(error)) throw error;
    const message = `Input could not be read: ${error.message}`;
    throwDiagnosticError(message, [{
      code: 'input/read', message,
      subject: { input: inputPath },
      evidence: { systemCode: error.code, reason: error.message },
      supportedFixes: ['provide one readable JSON input file'],
    }]);
  }
  let diagram: D;
  try {
    diagram = JSON.parse(input);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const message = `Input JSON could not be parsed: ${error.message}`;
    throwDiagnosticError(message, [{
      code: 'input/json-parse', message,
      subject: { input: inputPath },
      evidence: { reason: error.message },
      supportedFixes: ['repair the JSON syntax and run validation again'],
    }]);
  }
  const authoredOutput = readField(readField(diagram, 'meta'), 'output');
  if (authoredOutput !== undefined) validateAuthoredOutputPath(authoredOutput);
  validateSchema(diagramType, diagram);
  applyLocaleTranslations(diagramType, diagram);
  validateCrossCollectionContracts(diagramType, diagram);
  validateEngineeringProfile(diagramType, diagram);
  const sourceEvidence = verifyRepositoryEvidence(diagramType, diagram, process.env.SCHEMATICS_REPO_ROOT);
  const template = fs.readFileSync(path.join(skillRoot, 'assets/template.html'), 'utf8').replace('</head>', `${softwareNoticesHtml}\n</head>`);
  const outputRequest = {
    requestedOutput: argv[3],
    authoredOutput: readField(readField(diagram, 'meta'), 'output'),
    defaultOutput: `${diagramType}.html`,
    inputPaths: [inputPath],
    cwd: process.cwd(),
  };
  let outPath: string;
  try {
    ({ outputPath: outPath } = resolveOutputPath(outputRequest));
  } catch (error) {
    throwOutputError(error, path.resolve(outputRequest.requestedOutput || String(outputRequest.authoredOutput || '') || outputRequest.defaultOutput));
  }
  outputPathGuards.set(outPath, outputRequest);
  return { diagram, template, outPath, sourceEvidence };
}

// Brand URL capture is the only asynchronous authoring step. Typed renderers
// opt into it through this wrapper without changing loadDiagram's long-lived
// synchronous safety contract.
export async function loadDiagramWithBrandMarks<D>(options: LoadDiagramOptions): Promise<LoadedDiagram<D>> {
  const loaded = loadDiagram<D>(options);
  await prepareDiagramBrandMarks(options.diagramType, loaded.diagram);
  return loaded;
}

const START_TYPES = new Set(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle', 'erd', 'tree', 'class', 'timeline', 'waterfall']);

function isFilesystemError(error: unknown): error is FilesystemError {
  return typeof readField(error, 'code') === 'string'
    && typeof readField(error, 'syscall') === 'string'
    && typeof readField(error, 'errno') === 'number';
}

function throwOutputError(error: unknown, output: string): never {
  if (readField(error, 'schematicsDiagnostics') || !isFilesystemError(error)) throw error;
  const message = `Output could not be written: ${error.message}`;
  throwDiagnosticError(message, [{
    code: 'output/write', message,
    subject: { output },
    evidence: { systemCode: error.code, reason: error.message },
    supportedFixes: ['choose a writable HTML file path and ensure its parent directories can be created'],
  }]);
}

function throwAtomicOutputFailure(result: AtomicOutputOutcome, output: string): never {
  const reason = result.reason || { code: 'unclassified' };
  const changed = result.status === 'different';
  const candidate = reason.code.startsWith('candidate-');
  const nonRegular = ['target-not-regular-file', 'candidate-not-regular-file'].includes(reason.code);
  const hardlinked = ['target-hardlinked', 'candidate-hardlinked'].includes(reason.code);
  const message = changed
    ? 'Output target changed while the rendered artifact was being prepared.'
    : nonRegular
      ? candidate
        ? 'Temporary output candidate is no longer a regular file.'
        : 'Output already exists and is not a regular file.'
      : hardlinked
        ? candidate
          ? 'Temporary output candidate has multiple hard-link names.'
          : 'Output already exists through multiple hard-link names.'
        : 'Output target stability could not be determined safely before commit.';
  throwDiagnosticError(message, [{
    code: changed
      ? 'output/target-changed'
      : nonRegular
        ? 'output/target-not-regular-file'
        : hardlinked
          ? 'output/target-hardlinked'
          : 'output/target-indeterminate',
    message,
    subject: { output },
    evidence: { relation: reason },
    supportedFixes: [hardlinked
      ? 'choose a non-hardlinked output path; atomic replacement cannot update every hard-link name'
      : 'retry after other processes stop replacing or redirecting the output path'],
  }]);
}

function stageRenderedHtml(outputPath: string, html: string, mode: number | null): { candidatePath: string; identity: FileIdentity } {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    renderCandidateSequence += 1;
    const candidatePath = path.join(
      path.dirname(outputPath),
      `.schematics-render-${process.pid}-${Date.now().toString(36)}-${renderCandidateSequence}.tmp`,
    );
    let descriptor: number | undefined;
    let identity: FileIdentity | undefined;
    try {
      const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
      descriptor = fs.openSync(
        candidatePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        mode ?? 0o666,
      );
      let metadata;
      try {
        metadata = fs.fstatSync(descriptor, { bigint: true });
      } catch (error) {
        // A transient first inspection failure must not strand the exclusive
        // candidate. A successful retry binds cleanup to the still-open file;
        // if both inspections fail, preserving the unknown entry is safer.
        try {
          const retry = fs.fstatSync(descriptor, { bigint: true });
          if (retry.isFile() && retry.ino !== 0n) {
            identity = { device: retry.dev, inode: retry.ino };
          }
        } catch {}
        throw error;
      }
      if (!metadata.isFile() || metadata.ino === 0n) {
        throw new Error('Temporary render candidate identity could not be verified safely.');
      }
      identity = { device: metadata.dev, inode: metadata.ino };
      fs.writeFileSync(descriptor, html);
      // Creation modes are filtered through the process umask. An atomic
      // replacement must retain the exact permissions of an existing target,
      // while a brand-new target should keep normal umask behavior.
      if (mode !== null) fs.fchmodSync(descriptor, mode);
      fs.closeSync(descriptor);
      descriptor = undefined;
      return { candidatePath, identity };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      if (readField(error, 'code') === 'EEXIST') continue;
      if (identity) {
        const cleanup = removeOwnedRegularFile(candidatePath, identity);
        if (!['removed', 'absent', 'preserved'].includes(cleanup.status)) {
          const cleanupError = new Error(`${readField(error, 'message')}; temporary render candidate cleanup also failed.`);
          cleanupError.cause = error;
          throw cleanupError;
        }
      }
      throw error;
    }
  }
  const error = Object.assign(new Error(`Could not reserve a temporary render candidate beside "${outputPath}".`), {
    code: 'EEXIST',
    errno: -17,
    syscall: 'open',
  });
  throw error;
}

// Common CLI tail: fill the template and write the standalone HTML file.
export function writeDiagram({ outPath, template, diagramType, meta, svg, cards, sourceEvidence = null }: WriteDiagramOptions): void {
  if (!START_TYPES.has(diagramType)) throw new Error(`writeDiagram: unknown diagram type ${JSON.stringify(diagramType)}`);
  const outputGuard = outputPathGuards.get(outPath);
  const html = applyTemplate(template, {
    title: meta.title,
    subtitle: meta.subtitle,
    svg,
    cards: renderCards(cards),
    locale: meta.locale,
    visualPreset: visualPreset(meta),
    sourceEvidence,
  });
  let candidatePath: string | undefined;
  let candidateIdentity: FileIdentity | undefined;
  let candidateBinding: RegularFileBinding | undefined;
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const outputCapture = captureAtomicOutput(outPath);
    if (outputCapture.status !== 'captured') throwAtomicOutputFailure(outputCapture, outPath);
    const beforeStage = verifyAtomicOutput(outputCapture.snapshot);
    if (beforeStage.status !== 'match') throwAtomicOutputFailure(beforeStage, outPath);
    ({ candidatePath, identity: candidateIdentity } = stageRenderedHtml(
      outputCapture.commitPath,
      html,
      outputCapture.mode,
    ));

    // The renderer may spend substantial time building HTML after loadDiagram
    // establishes the guard. Re-run it after staging so a last-moment alias
    // cannot redirect the commit onto an input file.
    if (outputGuard) resolveOutputPath(outputGuard);
    const candidateCapture = captureRegularFileBinding(candidatePath, {
      subject: 'candidate',
      expectedSha256: new Bun.CryptoHasher('sha256').update(html).digest('hex'),
      expectedBytes: Buffer.byteLength(html),
      expectedIdentity: candidateIdentity,
      ...(outputCapture.mode === null ? {} : { expectedMode: outputCapture.mode }),
    });
    if (candidateCapture.status !== 'captured') throwAtomicOutputFailure(candidateCapture, outPath);
    candidateBinding = candidateCapture.binding;
    const beforeCommit = verifyAtomicOutput(outputCapture.snapshot);
    if (beforeCommit.status !== 'match') throwAtomicOutputFailure(beforeCommit, outPath);
    const publication = publishRegularFileBinding(
      candidateBinding,
      candidatePath,
      outputCapture.snapshot,
      { subject: 'candidate' },
    );
    if (!['committed', 'committed-with-warning'].includes(publication.status)) {
      throwAtomicOutputFailure(publication, outPath);
    }
    const releasedCandidate = releaseRegularFileBinding(candidateBinding);
    candidateBinding = undefined;
    if (releasedCandidate.status !== 'released') throwAtomicOutputFailure(releasedCandidate, outPath);
    candidatePath = undefined;
    candidateIdentity = undefined;
  } catch (error) {
    throwOutputError(error, outPath);
  } finally {
    outputPathGuards.delete(outPath);
    if (candidateBinding) releaseRegularFileBinding(candidateBinding);
    if (candidatePath && candidateIdentity) {
      const cleanup = removeOwnedRegularFile(candidatePath, candidateIdentity);
      if (!['removed', 'absent', 'preserved'].includes(cleanup.status)) {
        throwAtomicOutputFailure(cleanup, outPath);
      }
    }
  }
  console.log(outPath);
}

const RELATIONSHIP_COLLECTIONS: Readonly<Record<string, string | undefined>> = {
  architecture: 'connections',
  workflow: 'edges',
  sequence: 'messages',
  dataflow: 'flows',
  lifecycle: 'transitions',
  erd: 'relationships',
  class: 'relationships',
};

// Relationship IDs are optional for backwards compatibility, but once an
// author supplies one it becomes the durable identity used by viewer links.
// Keep uniqueness enforcement in the shared zero-install path so every typed
// renderer fails the same way even when development dependencies are absent.
export function validateRelationshipIds(diagramType: string, diagram: unknown): void {
  const collection = RELATIONSHIP_COLLECTIONS[diagramType];
  const collected = collection ? readField(diagram, collection) : undefined;
  const relationships: unknown[] = Array.isArray(collected) ? collected : [];
  const seen = new Set<unknown>();
  const problems: string[] = [];

  relationships.forEach((relationship, index) => {
    const id = readField(relationship, 'id');
    if (id === undefined || id === null || id === '') return;
    if (seen.has(id)) {
      problems.push(`/${collection}/${index}/id duplicates relationship id ${JSON.stringify(id)}`);
    }
    seen.add(id);
  });

  if (problems.length) {
    throwDiagnosticProblems('Relationship identity validation failed', problems, {
      code: 'relationship/duplicate-id',
      subject: { diagramType, collection },
    });
  }
}

// Share relationship-ID semantic checks between the loader
// and workflow compiler without performing filesystem operations (see #429).
export function validateCrossCollectionContracts(diagramType: string, diagram: unknown): void {
  validateRelationshipIds(diagramType, diagram);
}

// Signal Flow was retired once it rendered the same as Classic. The schema
// still accepts it so existing diagram files keep rendering.
export function visualPreset(meta: DiagramMeta | null | undefined): string {
  const preset = meta?.visual_preset || 'classic';
  return preset === 'signal-flow' ? 'classic' : preset;
}

export function svgRootAttrs(meta: DiagramMeta, explicitQualityProfile?: string): string {
  // Motion is a Viewer capability for every diagram; Live/Still controls playback.
  const animation = ' data-animation="trace"';
  const preset = ` data-preset="${esc(visualPreset(meta))}"`;
  const engineeringProfile = meta.engineering_profile
    ? ` data-engineering-profile="${esc(meta.engineering_profile)}"`
    : '';
  const requestedProfile = explicitQualityProfile || process.env.SCHEMATICS_QUALITY_PROFILE || meta.quality_profile;
  const qualityProfile = requestedProfile === 'showcase' ? 'showcase' : 'standard';
  const advisory = requestedProfile ? '' : ' data-quality-gates="advisory"';
  return `role="img" lang="${esc(resolveLocale(meta.locale))}" aria-labelledby="schematics-diagram-title schematics-diagram-description"${animation}${preset}${engineeringProfile} data-quality-profile="${esc(qualityProfile)}"${advisory}`;
}

// Keep the accessible name inside the SVG so it survives standalone SVG
// export and embedding. The fixed IDs are deterministic because an Schematics
// artifact intentionally contains one primary diagram SVG.
export function svgAccessibleText(meta: DiagramMeta, kind: string): string {
  const description = meta.subtitle || translateMessage(meta.locale, `diagram.description.${kind}`);
  return `        <title id="schematics-diagram-title">${esc(meta.title)}</title>\n        <desc id="schematics-diagram-description">${esc(description)}</desc>`;
}

export function animateAttr(meta: DiagramMeta, kind: string, step: unknown): string {
  // Ambient trace must finish within six seconds of load. The
  // cap affects visual delay only; authored order and semantic identity stay
  // untouched in the JSON, DOM, and relationship contracts.
  const safeStep = typeof step === 'number' && Number.isFinite(step) && step >= 0 ? Math.min(12, Math.floor(step)) : 0;
  return ` data-animate="${kind}" style="--step:${safeStep}"`;
}

// Stable semantic hooks for the standalone HTML explorer. IDs already pass
// the schema's conservative identifier pattern; escape again at the markup
// boundary so these helpers remain safe if that contract expands later.
export function focusNodeAttrs(id: unknown, label: unknown, metadata: FocusNodeMetadata = {}, locale?: unknown): string {
  const optional = [
    ['data-node-kind', metadata.kind],
    ['data-node-sublabel', metadata.sublabel],
    ['data-node-tag', metadata.tag],
    ['data-node-context', metadata.context],
    ['data-node-brand', metadata.brand],
    ['data-node-brand-id', metadata.brandId],
    ['data-node-brand-status', metadata.brandStatus],
    ['data-node-brand-source', metadata.brandSource],
  ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([name, value]) => ` ${name}="${esc(String(value))}"`)
    .join('');
  const detail = [metadata.sublabel, metadata.context, metadata.brand]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .join(', ');
  const aria = detail
    ? translateMessage(locale, 'node.focus.detail', { label, detail })
    : translateMessage(locale, 'node.focus', { label });
  return `id="node-${esc(id)}" data-node-id="${esc(id)}" data-node-label="${esc(label)}" tabindex="0" role="button" aria-label="${esc(aria)}" aria-pressed="false"${optional}`;
}

// Native SVG titles preserve a compact details-on-demand fallback when the
// canonical SVG is embedded inline outside the full Schematics viewer.
export function focusNodeTitle(label: unknown, metadata: FocusNodeMetadata = {}): string {
  const parts = [label, metadata.sublabel, metadata.context, metadata.tag, metadata.brand]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '');
  return `<title>${esc(parts.join(' · '))}</title>`;
}

export function focusEdgeAttrs(from: unknown, to: unknown, label?: unknown, key?: unknown, id?: unknown): string {
  const named = label ? ` data-edge-label="${esc(label)}"` : '';
  const keyed = key !== undefined && key !== null ? ` data-edge-key="${esc(String(key))}"` : '';
  const identified = id !== undefined && id !== null && String(id).trim() !== ''
    ? ` data-edge-id="${esc(String(id))}"`
    : '';
  return `data-edge-from="${esc(from)}" data-edge-to="${esc(to)}"${named}${keyed}${identified}`;
}
