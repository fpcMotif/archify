import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDiagramWithBrandMarks, writeDiagram } from '../svg/cli.ts';
import { recordDiagnostic } from '../diagnostics/diagnostics.ts';
import { compileDataflow } from './dataflow-compiler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { diagram: dataflow, template, outPath, sourceEvidence } = await loadDiagramWithBrandMarks({
  rendererDir: __dirname,
  diagramType: 'dataflow',
  defaultExample: 'product-analytics.dataflow.json',
});

let svg;
try {
  svg = compileDataflow({ dataflow, sourceEvidence,
    qualityProfile: process.env.SCHEMATICS_QUALITY_PROFILE || dataflow.meta?.quality_profile });
} catch (error) {
  for (const diagnostic of error?.schematicsDiagnostics || []) recordDiagnostic(diagnostic);
  throw error;
}
writeDiagram({ outPath, template, diagramType: 'dataflow', meta: dataflow.meta,
  svg, cards: dataflow.cards, sourceEvidence });
