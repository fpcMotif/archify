#!/usr/bin/env bun
// Usage: bun replay.ts --base <schematics-dir> [--head <schematics-dir>] [--type <type>] [--bench <dir>] [--out <dir>]
//
// Renders every benchmark first draft with two Schematics trees (each the
// directory holding bin/schematics.ts; head defaults to this repository) and
// reports, per type, how many drafts pass on each side, which flipped and
// which passing drafts changed their rendered SVG or styles. Renders and replay.json go to
// <tuning-home>/replays/<timestamp> unless --out. Exits 1 when a draft that
// passes on base fails on head. Rendering skips finalize's browser gate.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIAGRAM_TYPES, tuningHome, renderedSvgFingerprint } from './lib.ts';

const args = process.argv.slice(2);
function option(name: string): string | undefined;
function option(name: string, fallback: string): string;
function option(name: string, fallback?: string) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const here = path.dirname(fileURLToPath(import.meta.url));
const baseOption = option('--base');
const base = baseOption ? path.resolve(baseOption) : null;
const head = path.resolve(option('--head', path.join(here, '../../../../schematics')));
const bench = path.resolve(option('--bench', path.join(tuningHome(), 'bench')));
const out = path.resolve(option('--out', path.join(tuningHome(), 'replays', new Date().toISOString().replace(/[:.]/g, '-'))));
const onlyType = option('--type');
if (!base || !fs.existsSync(path.join(base, 'bin/schematics.ts')) || !fs.existsSync(path.join(head, 'bin/schematics.ts'))) {
  console.error('Usage: bun replay.ts --base <schematics-dir> [--head <schematics-dir>] [--type <type>] [--bench <dir>] [--out <dir>]');
  process.exit(2);
}

const entries = DIAGRAM_TYPES.filter((type) => !onlyType || type === onlyType).flatMap((type) => {
  const folder = path.join(bench, type);
  return fs.existsSync(folder)
    ? fs.readdirSync(folder).filter((file) => file.endsWith('.json')).sort().map((file) => ({ type, name: file.slice(0, -5), file: path.join(folder, file) }))
    : [];
});

if (!entries.length) {
  console.error('No benchmark drafts selected; collect drafts first or choose a populated --bench/--type.');
  process.exit(2);
}
function treeIdentity(tree: string) {
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', tree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { path: tree, revision: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').split('\n').filter(Boolean) };
  } catch { return { path: tree, revision: null, dirty: null }; }
}
const inventory = entries.map(({ type, name, file }) => ({ type, name, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const provenance = {
  base: treeIdentity(base), head: treeIdentity(head),
  benchmark: { inventory, sha256: crypto.createHash('sha256').update(JSON.stringify(inventory)).digest('hex') },
};

type Entry = (typeof entries)[number];
interface Rendered {
  ok: boolean;
  problems: number;
  codes: string[];
  first: string;
  geometry: string | null;
}
interface ReplayResult extends Entry {
  base: Rendered;
  head: Rendered;
  note?: string;
}

function render(tree: string, side: 'base' | 'head', entry: Entry) {
  const document = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  const output = path.join(out, side, entry.type, `${entry.name}.html`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.rmSync(output, { force: true });
  const quality = document.meta?.quality_profile || 'showcase';
  return new Promise<Rendered>((resolve) => {
    const child = spawn(process.execPath, [path.join(tree, 'bin/schematics.ts'), 'render', entry.type, entry.file, output, '--quality', quality], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (chunk) => { log += chunk; });
    child.stderr.on('data', (chunk) => { log += chunk; });
    child.on('close', (code) => {
      let ok = code === 0 && fs.existsSync(output);
      let geometry: string | null = null;
      const problems = log.split('\n').filter((line) => line.startsWith('- '));
      if (ok) {
        try { geometry = renderedSvgFingerprint(fs.readFileSync(output, 'utf8')); }
        catch (error) {
          ok = false;
          problems.push(`- [artifact/rendered-svg-invalid] ${error instanceof Error ? error.message : error}`);
        }
      }
      resolve({
        ok,
        problems: problems.length,
        codes: [...new Set(problems.map((line) => (line.match(/^- \[([^\]]+)\]/) || [])[1] || 'other'))],
        first: ok ? '' : (problems[0] || log.trim().split('\n')[0] || '').slice(0, 160),
        geometry,
      });
    });
  });
}

const results: ReplayResult[] = [];
const queue = [...entries];
await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
  for (let entry = queue.shift(); entry; entry = queue.shift()) {
    const [before, after] = [await render(base, 'base', entry), await render(head, 'head', entry)];
    results.push({ ...entry, base: before, head: after });
  }
}));
results.sort((a, b) => DIAGRAM_TYPES.indexOf(a.type) - DIAGRAM_TYPES.indexOf(b.type) || a.name.localeCompare(b.name));

const tag = (result: Rendered) => (result.ok ? 'pass' : `fail(${result.problems})`);
for (const result of results) {
  const note = !result.base.ok && result.head.ok ? 'FIXED'
    : result.base.ok && !result.head.ok ? 'REGRESSED'
      : result.base.ok && result.base.geometry !== result.head.geometry ? 'changed' : '';
  result.note = note;
  console.log(`${`${result.type}/${result.name}`.padEnd(32)} base ${tag(result.base).padEnd(10)} head ${tag(result.head).padEnd(10)} ${note.padEnd(9)} ${result.head.ok ? '' : result.head.codes.join(',')}`);
}
console.log('\nfirst-draft render pass rate by type (base -> head; browser gate not run)');
for (const type of DIAGRAM_TYPES) {
  const own = results.filter((result) => result.type === type);
  if (!own.length) continue;
  const count = (side: 'base' | 'head') => own.filter((result) => result[side].ok).length;
  console.log(`  ${type.padEnd(13)} ${count('base')}/${own.length} -> ${count('head')}/${own.length}`);
}
const regressed = results.filter((result) => result.base.ok && !result.head.ok);
console.log(`total ${results.filter((result) => result.base.ok).length}/${results.length} -> ${results.filter((result) => result.head.ok).length}/${results.length}; regressed ${regressed.length}; renders in ${out}`);
fs.writeFileSync(path.join(out, 'replay.json'), `${JSON.stringify({ schemaVersion: 1, base, head, bench, provenance, results }, null, 2)}\n`);
process.exit(regressed.length ? 1 : 0);
