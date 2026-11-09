import { loadDiagramWithBrandMarks, writeDiagram } from '../svg/cli.ts';
import { recordDiagnostic, type DiagnosticError } from '../diagnostics/diagnostics.ts';
import { compileDataflow, type DataflowDiagram } from './dataflow-compiler.ts';

function isDiagnosticError(value: unknown): value is DiagnosticError {
  return value instanceof Error;
}

export async function main(argv: string[]): Promise<void> {
  const { diagram: dataflow, template, outPath, sourceEvidence } = await loadDiagramWithBrandMarks<DataflowDiagram>({
    rendererDir: import.meta.dir,
    diagramType: 'dataflow',
    defaultExample: 'product-analytics.dataflow.json',
    argv,
  });

  let svg: string;
  try {
    svg = compileDataflow({ dataflow, sourceEvidence,
      qualityProfile: process.env.SCHEMATICS_QUALITY_PROFILE || dataflow.meta?.quality_profile });
  } catch (error) {
    for (const diagnostic of (isDiagnosticError(error) && error.schematicsDiagnostics) || []) recordDiagnostic(diagnostic);
    throw error;
  }
  writeDiagram({ outPath, template, diagramType: 'dataflow', meta: dataflow.meta,
    svg, cards: dataflow.cards, sourceEvidence });
}

if (import.meta.main) await main(process.argv);
