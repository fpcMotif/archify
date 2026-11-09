import path from 'node:path';

export function rendererEntry(skillRoot: string, diagramType: string): string {
  return path.join(skillRoot, 'packages', diagramType, `render-${diagramType}.ts`);
}
