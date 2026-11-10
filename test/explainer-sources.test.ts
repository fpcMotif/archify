import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveExplainerSources, type ResolvedSources, type ResolveSourcesOptions } from '../schematics/packages/explainer/sources.ts';
import type { ExplainerDocument } from '../schematics/packages/explainer/model.ts';

interface Repository { url: string; revision: string }
interface LooseSource { id: string; title: string; path?: string; lines?: number[]; url?: string; text?: string; revision?: string }
interface LooseBlock { id?: string; type: string; source?: string; path?: string; alt?: string }
interface LooseDocument { meta?: { repository?: Repository }; sources: LooseSource[]; panels: [{ id: string; blocks: LooseBlock[] }] }
interface DiagnosedError {
  message: string;
  schematicsDiagnostics?: { code?: string; subject: { component?: unknown; path?: unknown; line?: unknown }; evidence: { reason?: unknown; example?: unknown }; supportedFixes: unknown[] }[];
}

const isResolvable = (document: LooseDocument): document is LooseDocument & ExplainerDocument =>
  Array.isArray(document.sources) && Array.isArray(document.panels);
function resolve(document: LooseDocument, options?: ResolveSourcesOptions) {
  assert.ok(isResolvable(document));
  return resolveExplainerSources(document, options);
}
function router(result: ResolvedSources) {
  const source = result.sources.router;
  assert.ok(source);
  return source;
}
function frozen(result: ResolvedSources) {
  const content = result.dependencies[0]?.contentBase64;
  assert.ok(typeof content === 'string');
  return Buffer.from(content, 'base64');
}

function fixture(t: TestContext, files: Record<string, string | Buffer> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explainer-sources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init');
  git('config', 'user.name', 'Schematics Tests');
  git('config', 'user.email', 'schematics@example.test');
  git('remote', 'add', 'origin', 'https://github.com/example/explainer');
  for (const [name, content] of Object.entries({ 'src/router.js': 'export function route(input) {\n  return input.kind;\n}\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  git('add', '.');
  git('commit', '-m', 'Source fixture');
  const revision = git('rev-parse', 'HEAD');
  return { root, git, revision, repository: { url: 'https://github.com/example/explainer', revision } };
}

function document(repository: Repository | undefined, source: Partial<LooseSource> = {}): LooseDocument {
  return { meta: repository ? { repository } : {}, sources: [{ id: 'router', title: 'Router', path: 'src/router.js', lines: [1, 3], ...source }],
    panels: [{ id: 'main', blocks: [{ id: 'code', type: 'code', source: 'router' }] }] };
}

async function rejects(document: LooseDocument, options: ResolveSourcesOptions, code: string, forbidden?: string) {
  await assert.rejects(resolve(document, options), (error: DiagnosedError) => {
    const diagnostic = error.schematicsDiagnostics?.[0];
    assert.equal(diagnostic?.code, `explainer/${code}`);
    assert.ok(diagnostic);
    assert.ok(diagnostic.subject.component);
    assert.ok(diagnostic.subject.path);
    assert.ok(Number.isInteger(diagnostic.subject.line) && Number(diagnostic.subject.line) > 0);
    assert.ok(diagnostic.evidence.reason);
    assert.ok(diagnostic.evidence.example);
    assert.ok(diagnostic.supportedFixes.length);
    if (forbidden) assert.ok(!JSON.stringify({ message: error.message, diagnostics: error.schematicsDiagnostics }).includes(forbidden));
    return true;
  });
}

test('explainer sources bind real pinned Git lines and freeze bytes without mutating authorship', async t => {
  const data = fixture(t);
  const doc = document(data.repository);
  const original = JSON.stringify(doc);
  fs.writeFileSync(path.join(data.root, 'src/router.js'), 'changed working tree\n');
  const result = await resolve(doc, { repoRoot: data.root });
  assert.equal(Reflect.get(router(result), 'status'), undefined);
  assert.equal(router(result).revision, data.revision);
  assert.equal(router(result).text, 'export function route(input) {\n  return input.kind;\n}');
  assert.equal(router(result).url, `https://github.com/example/explainer/blob/${data.revision}/src/router.js#L1-L3`);
  const bytes = frozen(result);
  assert.equal(result.dependencies[0]?.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(JSON.stringify(doc), original);
  assert.ok(Object.isFrozen(result.sources.router));
  fs.writeFileSync(path.join(data.root, 'src/router.js'), 'another update');
  assert.equal(frozen(result).toString(), bytes.toString());
});

test('explainer derives a credential-free origin and HEAD; private credentials never reach source links', async t => {
  const data = fixture(t);
  data.git('remote', 'set-url', 'origin', 'https://user:privatecredential@github.com/example/explainer.git');
  const doc = document(undefined);
  doc.sources.push({ id: 'web', title: 'Web', url: 'https://example.com/article' },
    { id: 'example', title: 'Example', text: 'illustration' });
  const result = await resolve(doc, { repoRoot: data.root });
  assert.equal(result.repository?.url, 'https://github.com/example/explainer');
  assert.equal(result.repository?.revision, data.revision);
  const web = result.sources.web, example = result.sources.example;
  assert.ok(web && example);
  assert.equal(Reflect.get(web, 'status'), undefined);
  assert.equal(Reflect.get(example, 'status'), undefined);
  assert.ok(!JSON.stringify(result).includes('privatecredential'));
  const first = doc.sources[0];
  assert.ok(first);
  first.path = 'src/missing.js';
  await rejects(doc, { repoRoot: data.root }, 'repository-location');
});

test('secret and escaping paths reject before Git can read any declared sources', async t => {
  for (const sourcePath of ['.env', '.env.production', 'config/credentials.json', 'private.pem', '.git/config']) {
    // No repository is supplied: a failure from the path guard rather than Git proves preflight ordering.
    const doc = document(undefined, { path: sourcePath });
    await rejects(doc, { repoRoot: '/nonexistent' }, sourcePath === '.git/config' ? 'source-path' : 'secret-path');
  }
  for (const sourcePath of ['../outside.js', '/tmp/outside.js', 'src\\router.js', 'src/./router.js', 'src/../router.js']) {
    await rejects(document(undefined, { path: sourcePath }), {}, 'source-path');
  }
});

test('repository verification rejects wrong ranges, origin and source revisions', async t => {
  const data = fixture(t);
  await rejects(document(data.repository, { lines: [2, 1] }), { repoRoot: data.root }, 'source-lines');
  await rejects(document(data.repository, { lines: [1, 99] }), { repoRoot: data.root }, 'repository-location');
  await rejects(document({ ...data.repository, url: 'https://github.com/example/other' }), { repoRoot: data.root }, 'repository-location');
  await rejects(document(data.repository, { revision: 'f'.repeat(40) }), { repoRoot: data.root }, 'source-revision');
  await rejects(document({ ...data.repository, revision: 'f'.repeat(40) }), { repoRoot: data.root }, 'repository-location');
  await assert.rejects(resolve(document(data.repository)), (error: DiagnosedError) => {
    assert.equal(error.schematicsDiagnostics?.[0]?.evidence.example, '--repo-root /absolute/path/to/repository');
    return true;
  });
});

test('secret-like code never appears in results or diagnostics', async t => {
  const sensitive = 'ghp_123456789012345678901234567890';
  const data = fixture(t, { 'src/token.js': `export const token = '${sensitive}';\n`,
    'src/config.js': "const password = 'dont-display-this';\n" });
  await rejects(document(data.repository, { path: 'src/token.js', lines: [1, 1] }), { repoRoot: data.root }, 'secret-content', sensitive);
  await rejects(document(data.repository, { path: 'src/config.js', lines: [1, 1] }), { repoRoot: data.root }, 'secret-content', 'dont-display-this');
});

test('unquoted config credentials are blocked while environment and code references remain usable', async t => {
  const sensitive = 'synthetic-review-secret';
  const environment = 'password: ${PASSWORD}\napi_key: "$API_KEY"\nsecret: null\n';
  const references = 'const password = process.env.PASSWORD;\nconst secret = options.secret;\nconst api_key = readKey();\n';
  const data = fixture(t, { 'config.yaml': `password: ${sensitive}\n`, 'config.ini': `api_key=${sensitive}\n`,
    'config-block.yaml': `password: |\n  ${sensitive}\n`,
    'environment.yaml': environment, 'src/references.js': references });
  for (const file of ['config.yaml', 'config.ini', 'config-block.yaml']) {
    await rejects(document(data.repository, { path: file, lines: [1, 1] }), { repoRoot: data.root }, 'secret-content', sensitive);
  }
  for (const [file, expected] of [['environment.yaml', environment], ['src/references.js', references]] as const) {
    const result = await resolve(document(data.repository, { path: file, lines: [1, 3] }), { repoRoot: data.root });
    assert.equal(Reflect.get(router(result), 'status'), undefined);
    assert.equal(router(result).text, expected.trimEnd());
  }
});

test('cited repository locations carry their pinned lines, unverifiable ones stay plain, and code blocks cannot trust web/example sources', async t => {
  const data = fixture(t);
  const doc = document(data.repository);
  doc.panels[0].blocks = [];
  const result = await resolve(doc, { repoRoot: data.root });
  assert.equal(typeof router(result).text, 'string', 'a cited location shows its lines on the page');
  assert.equal(result.dependencies.length, 1, 'and freezes the file it was read from');
  const absent = document(data.repository, { path: 'src/absent.js', lines: [1, 3] }); absent.panels[0].blocks = [];
  const missing = await resolve(absent, { repoRoot: data.root });
  assert.ok(!Object.hasOwn(router(missing), 'text'), 'an unverifiable citation stays a plain reference');
  assert.deepEqual(missing.diagnostics.map(entry => [entry.code, entry.severity, entry.subject.path, entry.evidence.reason]),
    [['explainer/citation-unverified', 'warning', '/sources/0', 'repository-evidence/file-missing']], 'and says why it has no excerpt');
  assert.deepEqual(result.diagnostics, [], 'a verified citation adds no warning');
  const secretData = fixture(t, { 'src/token.js': "export const token = 'ghp_123456789012345678901234567890';\n" });
  const secret = document(secretData.repository, { path: 'src/token.js', lines: [1, 1] }); secret.panels[0].blocks = [];
  const hidden = await resolve(secret, { repoRoot: secretData.root });
  assert.ok(!Object.hasOwn(router(hidden), 'text'), 'a secret-bearing citation shows no excerpt');
  assert.deepEqual(hidden.diagnostics.map(entry => entry.evidence.reason), ['explainer/secret-content']);
  assert.ok(!JSON.stringify(hidden.diagnostics).includes('ghp_'), 'the warning never repeats the secret');
  assert.ok(!Object.hasOwn(router(await resolve(doc, {})), 'text'), 'without a repository root nothing is read');
  doc.sources = [{ id: 'router', title: 'Example', text: 'code' }];
  doc.panels[0].blocks = [{ id: 'code', type: 'code', source: 'router' }];
  await rejects(doc, {}, 'code-source');
  doc.sources = [{ id: 'router', title: 'Unsafe', url: 'https://user:password@example.com/' }];
  await rejects(doc, {}, 'source-url', 'password');
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1EAAAAASUVORK5CYII=', 'base64');
function imageDocument(imagePath = 'images/tiny.png'): LooseDocument {
  return { sources: [], panels: [{ id: 'images', blocks: [{ id: 'picture', type: 'image', path: imagePath, alt: 'A pixel' }] }] };
}

test('local image bytes are embedded, digest-bound and preserved after the original changes', async t => {
  const data = fixture(t, { 'images/tiny.png': PNG });
  const doc = imageDocument();
  const result = await resolve(doc, { baseDir: data.root });
  assert.equal(result.assets.picture?.mime, 'image/png');
  assert.equal(result.assets.picture?.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(result.dependencies[0]?.sha256, createHash('sha256').update(PNG).digest('hex'));
  fs.writeFileSync(path.join(data.root, 'images/tiny.png'), 'changed');
  assert.deepEqual(frozen(result), PNG);
  assert.equal(doc.panels[0].blocks[0]?.path, 'images/tiny.png');
});

test('image containment rejects symlink files and directories, traversal, unsupported formats and oversize files', async t => {
  const data = fixture(t, { 'images/tiny.png': PNG });
  fs.symlinkSync(path.join(data.root, 'images/tiny.png'), path.join(data.root, 'link.png'));
  fs.symlinkSync(path.join(data.root, 'images'), path.join(data.root, 'linked'));
  await rejects(imageDocument('link.png'), { baseDir: data.root }, 'asset-symlink');
  await rejects(imageDocument('linked/tiny.png'), { baseDir: data.root }, 'asset-symlink');
  await rejects(imageDocument('../outside.png'), { baseDir: data.root }, 'source-path');
  await rejects(imageDocument('https://example.com/tiny.png'), { baseDir: data.root }, 'source-path');
  await rejects(imageDocument('images/tiny.svg'), { baseDir: data.root }, 'asset-format');
  fs.writeFileSync(path.join(data.root, 'fake.png'), '<svg>not png</svg>');
  await rejects(imageDocument('fake.png'), { baseDir: data.root }, 'asset-format');
  fs.writeFileSync(path.join(data.root, 'large.png'), Buffer.alloc(8 * 1024 * 1024 + 1));
  await rejects(imageDocument('large.png'), { baseDir: data.root }, 'asset-size');
});

test('resource ids are required and diagnostics use caller source positions without content leaks', async () => {
  const doc = imageDocument();
  const picture = doc.panels[0].blocks[0];
  assert.ok(picture);
  delete picture.id;
  await rejects(doc, {}, 'resource-id');
  await assert.rejects(resolve(imageDocument('../secret.png'), { baseDir: '/nonexistent', sourcePath: '/input/doc.json',
    sourceMap: { '/panels/0/blocks/0/path': { line: 12, column: 6 } } }), (error: DiagnosedError) => {
    assert.deepEqual(error.schematicsDiagnostics?.[0]?.subject, { path: '/panels/0/blocks/0/path', component: 'image', input: '/input/doc.json', line: 12, column: 6 });
    return true;
  });
});
