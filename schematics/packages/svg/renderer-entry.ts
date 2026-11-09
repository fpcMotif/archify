import { existsSync } from 'node:fs';
import path from 'node:path';

export function rendererEntry(skillRoot: string, diagramType: string): string {
  const typed = path.join(skillRoot, 'packages', diagramType, `render-${diagramType}.ts`);
  return existsSync(typed) ? typed : path.join(skillRoot, 'packages', diagramType, `render-${diagramType}.mjs`);
}
