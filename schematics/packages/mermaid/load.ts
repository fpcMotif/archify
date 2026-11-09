import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

type MermaidImporter = typeof import('./import.ts');

const entry = path.join(import.meta.dir, 'import.ts');
const vendorRoot = path.join(import.meta.dir, 'vendor', 'pele');
const require = createRequire(import.meta.url);

export function bytecodeCacheRoot(): string {
  const base = Bun.env.SCHEMATICS_CACHE_DIR || path.join(Bun.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'schematics');
  return path.join(base, 'mermaid-import');
}

function sourceKey(): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(Bun.revision);
  const vendorFiles = fs.readdirSync(vendorRoot, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(vendorRoot, name));
  for (const file of [entry, ...vendorFiles]) hasher.update(file).update(fs.readFileSync(file));
  return hasher.digest('hex').slice(0, 24);
}

export async function loadMermaidImporter(): Promise<MermaidImporter> {
  const root = bytecodeCacheRoot();
  const bundleDir = path.join(root, sourceKey());
  const bundle = path.join(bundleDir, 'import.js');
  if (fs.existsSync(`${bundle}.jsc`)) return require(bundle) as MermaidImporter;
  const importer: MermaidImporter = await import(entry);
  await writeBytecodeCache(root, bundleDir).catch(() => undefined);
  return importer;
}

async function writeBytecodeCache(root: string, bundleDir: string): Promise<void> {
  const staging = `${bundleDir}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const result = await Bun.build({
      entrypoints: [entry],
      target: 'bun',
      format: 'cjs',
      bytecode: true,
      minify: true,
      outdir: staging,
      naming: 'import.js',
    });
    if (!result.success) return;
    fs.renameSync(staging, bundleDir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  for (const name of fs.readdirSync(root)) {
    const stale = path.join(root, name);
    if (stale !== bundleDir && !name.endsWith('.tmp')) fs.rmSync(stale, { recursive: true, force: true });
  }
}
