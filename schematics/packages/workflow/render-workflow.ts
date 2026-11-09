import { loadDiagramWithBrandMarks, writeDiagram } from '../svg/cli.ts';
import { recordDiagnostic, throwDiagnosticError, withIsolatedDiagnosticRecording } from '../diagnostics/diagnostics.ts';
import { readField } from '../output/path-semantics.ts';
import { compileWorkflow, type WorkflowCompileResult } from './workflow-compiler.ts';
import type { WorkflowDocument } from './workflow-document.ts';

export type { WorkflowDocument } from './workflow-document.ts';
export { compileWorkflow, type WorkflowCompileResult };

export async function main(argv: string[]): Promise<void> {
  const { diagram: workflow, template, outPath, sourceEvidence } = await loadDiagramWithBrandMarks<WorkflowDocument>({
    rendererDir: import.meta.dir,
    diagramType: 'workflow',
    defaultExample: 'agent-tool-call.workflow.json',
    argv,
  });

  let compiled: WorkflowCompileResult;
  try {
    compiled = withIsolatedDiagnosticRecording(() => compileWorkflow({
      workflow,
      qualityProfile: process.env.SCHEMATICS_QUALITY_PROFILE || workflow.meta?.quality_profile,
      sourceEvidence,
    }));
  } catch (error) {
    // The scope has restored the caller's recording. Keep a typed escape visible
    // alongside earlier failures without publishing abandoned compile attempts.
    const diagnostics = readField(error, 'schematicsDiagnostics');
    if (Array.isArray(diagnostics)) {
      for (const diagnostic of diagnostics) recordDiagnostic(diagnostic);
    }
    throw error;
  }

  const layoutJson = argv.includes('--layout-json');

  if (layoutJson) {
    process.stdout.write(`${JSON.stringify(compiled.receipt, null, 2)}\n`);
    if (!compiled.ok) process.exitCode = 1;
  } else if (!compiled.ok) {
    throwDiagnosticError(compiled.error || 'Workflow compilation failed.', compiled.diagnostics);
  } else {
    writeDiagram({
      outPath,
      template,
      diagramType: 'workflow',
      meta: workflow.meta,
      svg: compiled.svg,
      cards: workflow.cards,
      sourceEvidence,
    });
  }
}

if (import.meta.main) await main(process.argv);
