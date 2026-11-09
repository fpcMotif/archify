import { afterAll, afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as source from '../schematics/packages/mermaid/import.ts';
import { bytecodeCacheRoot, loadMermaidImporter } from '../schematics/packages/mermaid/load.ts';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schematics-mermaid-load-'));
const previousCacheDir = Bun.env.SCHEMATICS_CACHE_DIR;
afterEach(() => {
  if (previousCacheDir === undefined) delete Bun.env.SCHEMATICS_CACHE_DIR;
  else Bun.env.SCHEMATICS_CACHE_DIR = previousCacheDir;
});
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

const FLOWCHART = 'flowchart LR\n  A[Client] --> B(API)\n  B -.-> C[(DB)]';

function useCache(name: string): string {
  Bun.env.SCHEMATICS_CACHE_DIR = path.join(workDir, name);
  return bytecodeCacheRoot();
}

test('the first load builds a bytecode bundle and the next load uses it', async () => {
  const root = useCache('fresh');
  const first = await loadMermaidImporter();
  expect(first.MermaidImportError).toBe(source.MermaidImportError);
  const [key, ...others] = fs.readdirSync(root);
  expect(others).toEqual([]);
  expect(fs.readdirSync(path.join(root, key!)).sort()).toEqual(['import.js', 'import.js.jsc']);

  const cached = await loadMermaidImporter();
  expect(cached.MermaidImportError).not.toBe(source.MermaidImportError);
  expect(cached.importMermaid(FLOWCHART, { output: 'x.html' })).toEqual(source.importMermaid(FLOWCHART, { output: 'x.html' }));
});

test('a new build removes bundles left by other Bun versions or sources', async () => {
  const root = useCache('stale');
  fs.mkdirSync(path.join(root, 'old-bun-build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'old-bun-build', 'import.js'), '');
  await loadMermaidImporter();
  expect(fs.readdirSync(root)).toHaveLength(1);
  expect(fs.existsSync(path.join(root, 'old-bun-build'))).toBe(false);
});

test('an unwritable cache still imports from source', async () => {
  const blocker = path.join(workDir, 'not-a-directory');
  fs.writeFileSync(blocker, '');
  Bun.env.SCHEMATICS_CACHE_DIR = blocker;
  const importer = await loadMermaidImporter();
  expect(importer.importMermaid(FLOWCHART).type).toBe('workflow');
  expect(fs.statSync(blocker).isFile()).toBe(true);
});
