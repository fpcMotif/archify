import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { installRendererDiagnosticBoundary, throwDiagnosticError } from '../diagnostics/diagnostics.ts';
import { resolveOutputPath } from '../output/output-path.ts';
import { captureAtomicOutput, captureRegularFileBinding, publishRegularFileBinding, releaseRegularFileBinding, removeOwnedRegularFile } from '../output/atomic-output.ts';
import { prepareExplainer, readPreparedBundle, assertPreparedDependencies } from './prepare.mjs';
import { renderExplainer } from './render.mjs';
installRendererDiagnosticBoundary();
const inputPath = path.resolve(process.argv[2]);
const sourceText = fs.readFileSync(inputPath, 'utf8');
const bundle = process.env.SCHEMATICS_EXPLAINER_PREPARED
  ? readPreparedBundle(process.env.SCHEMATICS_EXPLAINER_PREPARED, sourceText, inputPath, { expectedInputPath: process.env.SCHEMATICS_EXPLAINER_SNAPSHOT_INPUT || inputPath })
  : await prepareExplainer(sourceText, { inputPath, repoRoot: process.env.SCHEMATICS_REPO_ROOT, quality: process.env.SCHEMATICS_QUALITY_PROFILE });
const request = { requestedOutput: process.argv[3], authoredOutput: bundle.document.meta.output, defaultOutput: 'explainer.html', inputPaths: [inputPath, bundle.sourcePath] };
const { outputPath } = resolveOutputPath(request);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const capture = captureAtomicOutput(outputPath, { requestedEntryPolicy: 'regular-or-absent' });
if (capture.status !== 'captured') throwDiagnosticError('Could not capture explainer output safely.', [{code:'output/target-indeterminate',message:'Could not capture explainer output safely.',subject:{output:outputPath},evidence:{reason:capture.reason},supportedFixes:[]}]);
let html;
try { html = renderExplainer(bundle.document, { ...bundle, preparedBundle: bundle, pageDirectory: process.env.SCHEMATICS_EXPLAINER_PAGE_DIR || path.dirname(outputPath) }); }
catch (error) { if (error.diagnostics) error.schematicsDiagnostics = error.diagnostics; throw error; }
const bytes = Buffer.from(html);
const candidate = path.join(path.dirname(capture.commitPath), `.schematics-explainer-${randomUUID()}.html`);
let binding;
let owned;
try {
  fs.writeFileSync(candidate, bytes, { flag: 'wx', ...(capture.mode === null ? {} : {mode:capture.mode}) });
  const stat = fs.lstatSync(candidate, {bigint:true});
  owned = {device:stat.dev,inode:stat.ino};
  if (capture.mode !== null) fs.chmodSync(candidate,capture.mode);
  const staged = captureRegularFileBinding(candidate,{expectedIdentity:owned,expectedSha256:createHash('sha256').update(bytes).digest('hex'),expectedBytes:bytes.length});
  if (staged.status !== 'captured') throw new Error('Could not bind explainer candidate.');
  binding = staged.binding;
  assertPreparedDependencies(bundle);
  resolveOutputPath(request);
  const result = publishRegularFileBinding(binding,candidate,capture.snapshot,{subject:'explainer-output'});
  if (!['committed','committed-with-warning'].includes(result.status)) throw new Error(`Could not publish explainer output (${result.reason?.code || result.status}).`);
} finally {
  if(binding) releaseRegularFileBinding(binding);
  if(owned) removeOwnedRegularFile(candidate,owned,{subject:'explainer-output'});
}
