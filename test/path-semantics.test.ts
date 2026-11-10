import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  containedBy,
  readField,
  resolvePhysicalLocation,
  sameEntry,
  sameLocation,
  sameParent,
  type SemanticReason,
} from '../schematics/packages/output/path-semantics.ts';

type RestOf<F> = F extends (first: never, ...rest: infer R) => unknown ? R : never;

interface WindowsFilesystemOptions {
  entriesExist?: boolean;
  preserveExtendedRealpaths?: boolean;
  extendedRootRealpathIsDirectory?: boolean;
  extendedRootStatIsDirectory?: boolean;
  symbolicLinks?: { link: string; target: string }[];
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
}

function scratchDirectory(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schematics-path-semantics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function expectResult(value: { status: string; reason: SemanticReason }, expectedStatus: string) {
  assert.equal(value.status, expectedStatus);
  assert.equal(typeof value.reason?.code, 'string');
  assert.ok(value.reason.code.length > 0);
  assert.deepEqual(Object.keys(value).sort(), ['reason', 'status']);
}

function mockWindowsFilesystem(t: TestContext, {
  entriesExist = true,
  preserveExtendedRealpaths = false,
  extendedRootRealpathIsDirectory = false,
  extendedRootStatIsDirectory = false,
  symbolicLinks = [],
}: WindowsFilesystemOptions = {}) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platform);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));

  const realpathCalls: string[] = [];
  const lstatCalls: string[] = [];
  const statCalls: string[] = [];
  const identities = new Map<string, bigint>();
  let nextIdentity = 1n;
  const canonicalPath = (targetPath: string) => {
    const input = String(targetPath);
    let canonical;
    if (/^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?:\\|$)/iu.test(input)) {
      canonical = input.replace(/^\\\\\?\\UNC\\/iu, '\\\\');
    } else if (/^\\\\\?\\[A-Za-z]:\\/u.test(input)) {
      canonical = input.slice(4);
    } else if (/^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(input) || /^[A-Za-z]:\\/u.test(input)) {
      canonical = input;
    } else {
      const error = codedError(`virtual Windows path is not rooted at a drive or share: ${input}`, 'EINVAL');
      throw error;
    }
    return path.win32.normalize(canonical);
  };
  const statFor = (targetPath: string) => {
    statCalls.push(String(targetPath));
    if (extendedRootStatIsDirectory
      && /^\\\\\?\\(?:[A-Za-z]:\\|UNC\\[^\\]+\\[^\\]+\\)$/iu.test(String(targetPath))) {
      const error = codedError(`virtual Windows extended root is a directory: ${targetPath}`, 'EISDIR');
      throw error;
    }
    const key = canonicalPath(targetPath).toLocaleLowerCase('en-US');
    if (!identities.has(key)) {
      identities.set(key, nextIdentity);
      nextIdentity += 1n;
    }
    return {
      dev: 1n,
      ino: identities.get(key),
      isDirectory: () => true,
      isSymbolicLink: () => false,
    };
  };
  const linkTargets = new Map(symbolicLinks.map(({ link, target }) => (
    [canonicalPath(link).toLocaleLowerCase('en-US'), target]
  )));

  t.mock.method(fs.realpathSync, 'native', (targetPath: string) => {
    realpathCalls.push(String(targetPath));
    if (extendedRootRealpathIsDirectory
      && /^\\\\\?\\(?:[A-Za-z]:\\|UNC\\[^\\]+\\[^\\]+\\)$/iu.test(String(targetPath))) {
      const error = codedError(`virtual Windows extended root is a directory: ${targetPath}`, 'EISDIR');
      throw error;
    }
    return preserveExtendedRealpaths
      ? path.win32.normalize(String(targetPath))
      : canonicalPath(targetPath);
  });
  t.mock.method(fs, 'statSync', statFor);
  t.mock.method(fs, 'lstatSync', (targetPath: string) => {
    lstatCalls.push(String(targetPath));
    if (entriesExist) {
      const stat = statFor(targetPath);
      const key = canonicalPath(targetPath).toLocaleLowerCase('en-US');
      if (!linkTargets.has(key)) return stat;
      return {
        ...stat,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      };
    }
    const error = codedError(`virtual Windows entry does not exist: ${targetPath}`, 'ENOENT');
    throw error;
  });
  t.mock.method(fs, 'readlinkSync', (targetPath: string) => {
    const key = canonicalPath(targetPath).toLocaleLowerCase('en-US');
    if (linkTargets.has(key)) return linkTargets.get(key);
    const error = codedError(`virtual Windows entry is not a symbolic link: ${targetPath}`, 'EINVAL');
    throw error;
  });
  return { lstatCalls, realpathCalls, statCalls };
}

test('Windows drive and share roots reach native resolution as complete filesystem roots', (t) => {
  const { realpathCalls } = mockWindowsFilesystem(t);
  const ordinaryUnc = String.raw`\\server\share\reports\diagram.html`;
  const extendedUnc = String.raw`\\?\UNC\server\share\reports\diagram.html`;
  const ordinaryDrive = String.raw`C:\reports\diagram.html`;
  const extendedDrive = String.raw`\\?\C:\reports\diagram.html`;

  expectResult(sameLocation(ordinaryUnc, extendedUnc), 'match');
  expectResult(
    sameLocation(String.raw`\\server\CON\reports`, String.raw`\\?\UNC\server\CON\reports`),
    'match',
  );
  expectResult(
    sameLocation(String.raw`\\CON\share\reports`, String.raw`\\?\UNC\CON\share\reports`),
    'match',
  );
  expectResult(
    sameLocation(String.raw`\\server\share`, String.raw`\\?\UNC\server\share`),
    'match',
  );
  expectResult(sameLocation(ordinaryDrive, extendedDrive), 'match');
  expectResult(sameLocation('C:\\', `${String.raw`\\?\C:`}\\`), 'match');
  assert.ok(realpathCalls.includes(`${String.raw`\\server\share`}\\`));
  assert.ok(realpathCalls.includes(`${String.raw`\\?\UNC\server\share`}\\`));
  assert.ok(realpathCalls.includes('C:\\'));
  assert.ok(realpathCalls.includes(`${String.raw`\\?\C:`}\\`));
});

test('Windows extended drive roots retain stable identity when native realpath reports EISDIR', (t) => {
  const { statCalls } = mockWindowsFilesystem(t, {
    extendedRootRealpathIsDirectory: true,
    extendedRootStatIsDirectory: true,
  });
  expectResult(
    sameLocation(
      String.raw`\\?\C:\reports\diagram.html`,
      String.raw`C:\reports\diagram.html`,
    ),
    'match',
  );
  assert.ok(statCalls.includes('C:\\'));
});

test('Windows extended drive roots retain traversal spelling when root stat reports EISDIR', (t) => {
  const { statCalls } = mockWindowsFilesystem(t, {
    preserveExtendedRealpaths: true,
    extendedRootStatIsDirectory: true,
  });
  expectResult(
    sameLocation(
      String.raw`\\?\C:\reports\diagram.html`,
      String.raw`C:\reports\diagram.html`,
    ),
    'match',
  );
  assert.ok(statCalls.includes('C:\\'));
});

test('Windows extended UNC roots use ordinary share identity when root APIs report EISDIR', (t) => {
  const { statCalls } = mockWindowsFilesystem(t, {
    extendedRootRealpathIsDirectory: true,
    extendedRootStatIsDirectory: true,
  });
  expectResult(
    sameLocation(
      String.raw`\\?\UNC\server\share\reports\diagram.html`,
      String.raw`\\server\share\reports\diagram.html`,
    ),
    'match',
  );
  assert.ok(statCalls.includes(`${String.raw`\\server\share`}\\`));
});

test('Windows device and malformed extended namespaces fail closed before filesystem access', (t) => {
  const { lstatCalls, realpathCalls } = mockWindowsFilesystem(t);
  for (const [targetPath, reason] of [
    [String.raw`\\.\NUL`, 'windows-namespace-unsupported'],
    ['//./NUL', 'windows-namespace-unsupported'],
    [String.raw`\\?\GLOBALROOT\Device\HarddiskVolume1\diagram.html`, 'windows-namespace-unsupported'],
    ['//?/GLOBALROOT/Device/HarddiskVolume1/diagram.html', 'windows-namespace-unsupported'],
    [String.raw`\\?\Volume{01234567-89AB-CDEF-0123-456789ABCDEF}\diagram.html`, 'windows-namespace-unsupported'],
    [String.raw`\\server\IPC$\diagram.html`, 'windows-namespace-unsupported'],
    [String.raw`\\server\pipe\diagram.html`, 'windows-namespace-unsupported'],
    [String.raw`\\server\mailslot\diagram.html`, 'windows-namespace-unsupported'],
    [String.raw`\\?\UNC\server\IPC$\diagram.html`, 'windows-namespace-unsupported'],
    [String.raw`\\?\UNC\server\pipe\diagram.html`, 'windows-namespace-unsupported'],
    [String.raw`\\?\UNC\server\mailslot\diagram.html`, 'windows-namespace-unsupported'],
    [String.raw`\\server\bad+share\diagram.html`, 'windows-root-invalid'],
    [String.raw`\\?\UNC\server\trailing.\diagram.html`, 'windows-root-invalid'],
    [String.raw`\\?\UNC\server`, 'windows-root-invalid'],
    [String.raw`\\?\other\diagram.html`, 'windows-root-invalid'],
    [String.raw`\\server`, 'windows-root-invalid'],
    [String.raw`\reports\diagram.html`, 'windows-root-invalid'],
    [String.raw`C:reports\diagram.html`, 'drive-relative-path'],
  ]) {
    const comparison = sameLocation(targetPath, targetPath);
    expectResult(comparison, 'unknown');
    assert.equal(comparison.reason.code, reason);
  }
  assert.deepEqual(realpathCalls, []);
  assert.deepEqual(lstatCalls, []);
});

test('Windows extended dot segments fail closed before filesystem access', (t) => {
  const { realpathCalls } = mockWindowsFilesystem(t);
  for (const targetPath of [
    String.raw`\\?\C:\reports\.\diagram.html`,
    String.raw`\\?\C:\reports\..\diagram.html`,
    String.raw`\\?\UNC\server\share\reports\.\diagram.html`,
    String.raw`\\?\UNC\server\share\reports\..\diagram.html`,
  ]) {
    const comparison = sameLocation(targetPath, targetPath);
    expectResult(comparison, 'unknown');
    assert.equal(comparison.reason.code, 'windows-root-invalid');
  }
  assert.deepEqual(realpathCalls, []);
});

test('Windows extended repeated separators fail closed before filesystem access', (t) => {
  const { realpathCalls } = mockWindowsFilesystem(t);
  for (const targetPath of [
    String.raw`\\?\C:\reports\\diagram.html`,
    String.raw`\\?\UNC\server\share\reports\\diagram.html`,
  ]) {
    const comparison = sameLocation(targetPath, targetPath);
    expectResult(comparison, 'unknown');
    assert.equal(comparison.reason.code, 'windows-root-invalid');
  }
  assert.deepEqual(realpathCalls, []);
});

test('relative symbolic-link navigation remains physical through an extended path', (t) => {
  const link = String.raw`\\?\C:\container\link.html`;
  mockWindowsFilesystem(t, {
    preserveExtendedRealpaths: true,
    symbolicLinks: [{ link, target: String.raw`..\\target.html` }],
  });

  expectResult(sameEntry(link, String.raw`C:\target.html`), 'match');
});

test('sameEntry uses physical identity for files, symbolic links, and hard links', (t) => {
  const root = scratchDirectory(t);
  const original = path.join(root, 'original.txt');
  const hard = path.join(root, 'hard.txt');
  const other = path.join(root, 'other.txt');
  const realDirectory = path.join(root, 'real-directory');
  const linkedDirectory = path.join(root, 'linked-directory');
  fs.writeFileSync(original, 'original');
  fs.writeFileSync(other, 'other');
  fs.linkSync(original, hard);
  fs.mkdirSync(realDirectory);
  fs.symlinkSync(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');

  expectResult(sameEntry(realDirectory, linkedDirectory), 'match');
  expectResult(sameEntry(original, hard), 'match');
  expectResult(sameEntry(original, other), 'different');
  expectResult(sameEntry(original, path.join(root, 'missing.txt')), 'unknown');
});

test('sameLocation follows directory links for future targets', (t) => {
  const root = scratchDirectory(t);
  const realDirectory = path.join(root, 'real');
  const linkedDirectory = path.join(root, 'linked');
  fs.mkdirSync(realDirectory);
  fs.symlinkSync(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');

  expectResult(
    sameLocation(
      path.join(realDirectory, 'future', 'diagram.html'),
      path.join(linkedDirectory, 'future', 'diagram.html'),
    ),
    'match',
  );
});

test('physical traversal resolves dot-dot after following a directory alias', (t) => {
  const root = scratchDirectory(t);
  const container = path.join(root, 'container');
  const physical = path.join(root, 'physical');
  const nested = path.join(physical, 'nested');
  const escape = path.join(physical, 'escape.html');
  fs.mkdirSync(container);
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(escape, 'physical target');
  fs.symlinkSync(nested, path.join(container, 'jump'), process.platform === 'win32' ? 'junction' : 'dir');

  const authored = `${container}${path.sep}jump${path.sep}..${path.sep}escape.html`;
  expectResult(sameEntry(authored, escape), 'match');
  expectResult(containedBy(container, authored), 'different');
  const resolved = resolvePhysicalLocation(authored);
  assert.equal(resolved.status, 'resolved');
  assert.deepEqual(resolved.location, {
    kind: 'existing',
    path: fs.realpathSync.native(escape),
  });
});

test('a missing segment before dot-dot is not lexically collapsed into an existing entry', (t) => {
  const root = scratchDirectory(t);
  const target = path.join(root, 'target.html');
  fs.writeFileSync(target, 'target');

  const authored = `${root}${path.sep}missing${path.sep}..${path.sep}target.html`;
  const comparison = sameEntry(authored, target);
  expectResult(comparison, 'unknown');
  assert.equal(comparison.reason.code, 'future-parent-traversal-indeterminate');
});

test('physical resolution preserves dot-dot inside a symbolic-link target', (t) => {
  const root = scratchDirectory(t);
  const container = path.join(root, 'container');
  const authoredParent = path.join(root, 'authored');
  const physical = path.join(root, 'physical');
  const nested = path.join(physical, 'nested');
  const target = path.join(physical, 'target.html');
  fs.mkdirSync(container);
  fs.mkdirSync(authoredParent);
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(target, 'physical target');
  fs.symlinkSync(nested, path.join(authoredParent, 'jump'), process.platform === 'win32' ? 'junction' : 'dir');
  const authoredTarget = `..${path.sep}authored${path.sep}jump${path.sep}..${path.sep}target.html`;
  const link = path.join(container, 'link.html');
  try {
    fs.symlinkSync(authoredTarget, link, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(errorCode(error))) {
      t.skip('file symbolic links are unavailable');
      return;
    }
    throw error;
  }

  const resolved = resolvePhysicalLocation(link);
  assert.equal(resolved.status, 'resolved');
  assert.deepEqual(resolved.location, {
    kind: 'existing',
    path: fs.realpathSync.native(target),
  });
  expectResult(sameEntry(link, target), 'match');
});

test('symbolic-link targets cannot erase a missing segment or a cycle with dot-dot', (t) => {
  const root = scratchDirectory(t);
  const target = path.join(root, 'target.html');
  const missingLink = path.join(root, 'missing-link.html');
  const loop = path.join(root, 'loop');
  fs.writeFileSync(target, 'target');
  try {
    fs.symlinkSync(`missing${path.sep}..${path.sep}target.html`, missingLink, 'file');
    fs.symlinkSync(`loop${path.sep}..`, loop, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(errorCode(error))) {
      t.skip('file symbolic links are unavailable');
      return;
    }
    throw error;
  }

  const missing = sameEntry(missingLink, target);
  expectResult(missing, 'unknown');
  assert.equal(missing.reason.code, 'future-parent-traversal-indeterminate');
  const cyclic = sameEntry(loop, root);
  expectResult(cyclic, 'unknown');
  assert.equal(cyclic.reason.code, 'symlink-cycle');
});

test('physical resolution returns a real ancestor and unresolved future segments', (t) => {
  const root = scratchDirectory(t);
  const physical = path.join(root, 'physical');
  const nested = path.join(physical, 'nested');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(nested, { recursive: true });
  fs.symlinkSync(nested, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const authored = `${alias}${path.sep}..${path.sep}future${path.sep}diagram.html`;

  const resolved = resolvePhysicalLocation(authored);
  assert.equal(resolved.status, 'resolved');
  assert.deepEqual(resolved.location, {
    kind: 'future',
    ancestorPath: fs.realpathSync.native(physical),
    unresolved: ['future', 'diagram.html'],
  });
});

test('sameLocation asks the containing filesystem about case-only future names', (t) => {
  const root = scratchDirectory(t);
  const authoredProbe = path.join(root, 'SchematicsCaseProbe');
  const lookupProbe = path.join(root, 'schematicscaseprobe');
  fs.writeFileSync(authoredProbe, 'probe');
  const aliasesCase = fs.existsSync(lookupProbe)
    && fs.statSync(authoredProbe, { bigint: true }).ino === fs.statSync(lookupProbe, { bigint: true }).ino;
  fs.unlinkSync(authoredProbe);

  const comparison = sameLocation(
    path.join(root, 'Future.HTML'),
    path.join(root, 'future.html'),
  );
  expectResult(comparison, aliasesCase ? 'match' : 'different');
});

test('sameLocation does not project ancestor semantics through a future directory', (t) => {
  const root = scratchDirectory(t);
  const openSync = fs.openSync.bind(fs);
  let probeCount = 0;
  t.mock.method(fs, 'openSync', (targetPath: string, ...args: RestOf<typeof fs.openSync>) => {
    if (path.basename(targetPath).startsWith('.schematics-path-semantics-')) probeCount += 1;
    return openSync(targetPath, ...args);
  });

  const caseOverlap = sameLocation(
    path.join(root, 'future-parent', 'Diagram.HTML'),
    path.join(root, 'future-parent', 'diagram.html'),
  );
  const normalizationOverlap = sameLocation(
    path.join(root, 'future-parent', 'Caf\u00e9.html'),
    path.join(root, 'future-parent', 'Cafe\u0301.html'),
  );
  const distinct = sameLocation(
    path.join(root, 'future-parent', 'diagram.html'),
    path.join(root, 'future-parent', 'receipt.json'),
  );
  t.mock.restoreAll();

  for (const comparison of [caseOverlap, normalizationOverlap]) {
    expectResult(comparison, 'unknown');
    assert.equal(comparison.reason.code, 'future-descendant-semantics-indeterminate');
    assert.equal(comparison.reason.segmentIndex, 1);
  }
  expectResult(distinct, 'different');
  assert.equal(distinct.reason.code, 'future-name-distinct');
  assert.equal(probeCount, 0);
});

test('sameLocation probes an existing intermediate directory using its own semantics', (t) => {
  const root = scratchDirectory(t);
  const intermediate = path.join(root, 'existing-parent');
  fs.mkdirSync(intermediate);
  const authoredProbe = path.join(intermediate, 'SchematicsCaseProbe');
  const lookupProbe = path.join(intermediate, 'schematicscaseprobe');
  fs.writeFileSync(authoredProbe, 'probe');
  const aliasesCase = fs.existsSync(lookupProbe)
    && fs.statSync(authoredProbe, { bigint: true }).ino === fs.statSync(lookupProbe, { bigint: true }).ino;
  fs.unlinkSync(authoredProbe);

  const comparison = sameLocation(
    path.join(intermediate, 'Diagram.HTML'),
    path.join(intermediate, 'diagram.html'),
  );
  expectResult(comparison, aliasesCase ? 'match' : 'different');
});

test('sameLocation distinguishes different existing entries and future depths', (t) => {
  const root = scratchDirectory(t);
  const left = path.join(root, 'left.txt');
  const right = path.join(root, 'right.txt');
  fs.writeFileSync(left, 'left');
  fs.writeFileSync(right, 'right');

  expectResult(sameLocation(left, right), 'different');
  expectResult(
    sameLocation(path.join(root, 'future.txt'), path.join(root, 'nested', 'future.txt')),
    'different',
  );
  const invalidDescendant = sameLocation(
    path.join(left, 'future.txt'),
    path.join(left, 'future.txt'),
  );
  expectResult(invalidDescendant, 'unknown');
  assert.equal(invalidDescendant.reason.code, 'ancestor-not-directory');
});

test('sameLocation reports probe cleanup failures as unknown', (t) => {
  const root = scratchDirectory(t);
  const unlinkSync = fs.unlinkSync.bind(fs);
  t.mock.method(fs, 'unlinkSync', (targetPath: string, ...args: RestOf<typeof fs.unlinkSync>) => {
    if (path.basename(targetPath).startsWith('.schematics-path-semantics-cleanup-')) {
      unlinkSync(targetPath, ...args);
      const error = codedError('simulated probe cleanup failure', 'EIO');
      throw error;
    }
    return unlinkSync(targetPath, ...args);
  });

  const comparison = sameLocation(
    path.join(root, 'Future.HTML'),
    path.join(root, 'future.html'),
  );
  t.mock.restoreAll();

  expectResult(comparison, 'unknown');
  assert.equal(comparison.reason.code, 'future-name-probe-cleanup-failed');
  assert.equal(comparison.reason.systemCode, 'EIO');
  assert.equal(typeof readField(comparison.reason.comparison, 'code'), 'string');
});

test('sameLocation does not recursively probe its own watcher events', (t) => {
  const root = scratchDirectory(t);
  const openSync = fs.openSync.bind(fs);
  let probeName: string | undefined;
  t.mock.method(fs, 'openSync', (targetPath: string, ...args: RestOf<typeof fs.openSync>) => {
    if (path.basename(targetPath).startsWith('.schematics-path-semantics-')) {
      probeName = path.basename(targetPath);
    }
    return openSync(targetPath, ...args);
  });

  sameLocation(path.join(root, 'Future.HTML'), path.join(root, 'future.html'));
  t.mock.restoreAll();
  assert.equal(typeof probeName, 'string');

  const watcherComparison = sameLocation(
    path.join(root, String(probeName)),
    path.join(root, 'future.html'),
  );
  expectResult(watcherComparison, 'different');
  assert.equal(watcherComparison.reason.code, 'internal-probe-name');
});

test('sameLocation proves distinct safe-ASCII names without writing to the directory', (t) => {
  const root = scratchDirectory(t);
  t.mock.method(fs, 'openSync', () => {
    const error = codedError('the directory is read-only', 'EACCES');
    throw error;
  });

  const comparison = sameLocation(
    path.join(root, 'diagram.workflow.json'),
    path.join(root, 'diagram.html'),
  );
  t.mock.restoreAll();

  expectResult(comparison, 'different');
  assert.equal(comparison.reason.code, 'future-name-distinct');
  assert.equal(comparison.reason.method, 'semantic-envelope');
});

test('sameLocation proves a long Unicode artifact distinct from a bounded hash sidecar', (t) => {
  const root = scratchDirectory(t);
  // Valid on byte-limited filesystems, but too long to prepend a probe name.
  const longNfd = `${'e\u0301'.repeat(76)}-architecture.html`;
  const hashSidecar = '.schematics-delivery-a3f5712c9e19.json';
  t.mock.method(fs, 'openSync', () => {
    throw new Error('a distinct-name proof must not write a probe');
  });

  const comparison = sameLocation(
    path.join(root, longNfd),
    path.join(root, hashSidecar),
  );
  t.mock.restoreAll();

  expectResult(comparison, 'different');
  assert.equal(comparison.reason.code, 'future-name-distinct');
  assert.equal(comparison.reason.method, 'semantic-envelope');
});

test('sameLocation never unlinks a probe path it did not create', (t) => {
  const root = scratchDirectory(t);
  let unlinkCalls = 0;
  t.mock.method(fs, 'openSync', () => {
    const error = codedError('probe creation denied', 'EACCES');
    throw error;
  });
  t.mock.method(fs, 'unlinkSync', () => {
    unlinkCalls += 1;
  });

  const comparison = sameLocation(
    path.join(root, 'Future.HTML'),
    path.join(root, 'future.html'),
  );
  t.mock.restoreAll();

  expectResult(comparison, 'unknown');
  assert.equal(comparison.reason.code, 'future-name-probe-failed');
  assert.equal(comparison.reason.systemCode, 'EACCES');
  assert.equal(unlinkCalls, 0);
});

test('sameLocation fails closed when a direct probe would exceed the component limit', (t) => {
  const root = scratchDirectory(t);
  const upper = `${'a'.repeat(220)}A.html`;
  const lower = upper.toLowerCase();
  const shortUpper = path.join(root, 'CaseProbeA');
  const shortLower = path.join(root, 'caseprobea');
  fs.writeFileSync(shortUpper, 'probe');
  const aliasesCase = fs.existsSync(shortLower)
    && fs.statSync(shortUpper, { bigint: true }).ino === fs.statSync(shortLower, { bigint: true }).ino;
  fs.unlinkSync(shortUpper);

  const comparison = sameLocation(path.join(root, upper), path.join(root, lower));
  if (aliasesCase) {
    expectResult(comparison, 'unknown');
    assert.equal(comparison.reason.code, 'future-name-probe-unrepresentable');
  } else {
    // A case-sensitive directory can prove the names different without
    // manufacturing either long target name.
    assert.ok(['different', 'unknown'].includes(comparison.status));
  }
});

test('probe cleanup never deletes a replacement entry even when released inodes are reused', (t) => {
  const root = scratchDirectory(t);
  const openSync = fs.openSync.bind(fs);
  const closeSync = fs.closeSync.bind(fs);
  const fstatSync = fs.fstatSync.bind(fs);
  const statSync = fs.statSync.bind(fs);
  const lstatSync = fs.lstatSync.bind(fs);
  let probePath: string | undefined;
  let probeDescriptor: number | undefined;
  let probeIdentity: fs.Stats | fs.BigIntStats | undefined;
  let replacementIdentity: fs.BigIntStats | undefined;
  let descriptorOpen = false;
  let replaced = false;
  t.mock.method(fs, 'openSync', (targetPath: string, ...args: RestOf<typeof fs.openSync>) => {
    const descriptor = openSync(targetPath, ...args);
    if (args[0] === 'wx' && path.basename(targetPath).startsWith('.schematics-path-semantics-')) {
      probePath = targetPath;
      probeDescriptor = descriptor;
      descriptorOpen = true;
    }
    return descriptor;
  });
  t.mock.method(fs, 'fstatSync', (descriptor: number, ...args: RestOf<typeof fs.fstatSync>) => {
    const stat = fstatSync(descriptor, ...args);
    if (descriptor === probeDescriptor) probeIdentity = stat;
    return stat;
  });
  t.mock.method(fs, 'closeSync', (descriptor: number) => {
    closeSync(descriptor);
    if (descriptor === probeDescriptor) descriptorOpen = false;
  });
  // Linux may immediately reuse an unlinked inode once its final handle closes.
  // Emulate that allocation policy so the safety assertion is portable.
  const reuseReleasedInode = (stat: fs.Stats | fs.BigIntStats | undefined) => {
    if (!descriptorOpen && replacementIdentity && stat
      && stat.dev === replacementIdentity.dev && stat.ino === replacementIdentity.ino) {
      assert.ok(probeIdentity);
      Object.assign(stat, { dev: probeIdentity.dev, ino: probeIdentity.ino });
    }
    return stat;
  };
  t.mock.method(fs, 'statSync', (targetPath: string, ...args: RestOf<typeof fs.statSync>) => {
    if (targetPath === probePath && !replaced) {
      replaced = true;
      fs.unlinkSync(targetPath);
      fs.writeFileSync(targetPath, 'replacement sentinel');
      replacementIdentity = statSync(targetPath, { bigint: true });
    }
    return reuseReleasedInode(statSync(targetPath, ...args));
  });
  t.mock.method(fs, 'lstatSync', (targetPath: string, ...args: RestOf<typeof fs.lstatSync>) =>
    reuseReleasedInode(lstatSync(targetPath, ...args)));

  const comparison = sameLocation(
    path.join(root, 'Future.HTML'),
    path.join(root, 'future.html'),
  );
  t.mock.restoreAll();

  expectResult(comparison, 'unknown');
  assert.equal(comparison.reason.code, 'future-name-probe-cleanup-failed');
  assert.equal(comparison.reason.systemCode, 'SCHEMATICS_PROBE_IDENTITY_CHANGED');
  assert.equal(fs.readFileSync(String(probePath), 'utf8'), 'replacement sentinel');
});

test('probe cleanup preserves a replacement introduced after its identity check', (t) => {
  const root = scratchDirectory(t);
  const lstatSync = fs.lstatSync.bind(fs);
  const unlinkSync = fs.unlinkSync.bind(fs);
  let probePath: string | undefined;
  let replaced = false;
  t.mock.method(fs, 'lstatSync', (targetPath: string, ...args: RestOf<typeof fs.lstatSync>) => {
    const stat = lstatSync(targetPath, ...args);
    if (
      !replaced
      && (
        path.basename(targetPath).startsWith('.schematics-path-semantics-')
        || path.basename(path.dirname(targetPath)).startsWith('.schematics-path-semantics-')
      )
      && stat !== undefined
      && !stat.isDirectory()
    ) {
      probePath = targetPath;
      replaced = true;
      unlinkSync(targetPath);
      fs.writeFileSync(targetPath, 'replacement after identity check');
    }
    return stat;
  });

  const comparison = sameLocation(
    path.join(root, 'Future.HTML'),
    path.join(root, 'future.html'),
  );
  t.mock.restoreAll();

  expectResult(comparison, 'unknown');
  assert.equal(comparison.reason.code, 'future-name-probe-cleanup-failed');
  assert.equal(comparison.reason.systemCode, 'SCHEMATICS_PROBE_IDENTITY_CHANGED');
  assert.equal(comparison.reason.restoredAtTarget, true);
  assert.equal(typeof comparison.reason.recoveryPath, 'string');
  assert.equal(fs.readFileSync(String(probePath), 'utf8'), 'replacement after identity check');
  assert.equal(
    fs.readFileSync(String(comparison.reason.recoveryPath), 'utf8'),
    'replacement after identity check',
  );
  assert.equal(
    fs.statSync(String(probePath), { bigint: true }).ino,
    fs.statSync(String(comparison.reason.recoveryPath), { bigint: true }).ino,
  );
});

test('probe cleanup exposes the quarantine path when target restoration fails', (t) => {
  const root = scratchDirectory(t);
  const lstatSync = fs.lstatSync.bind(fs);
  const unlinkSync = fs.unlinkSync.bind(fs);
  let probePath: string | undefined;
  let replaced = false;
  t.mock.method(fs, 'lstatSync', (targetPath: string, ...args: RestOf<typeof fs.lstatSync>) => {
    const stat = lstatSync(targetPath, ...args);
    if (
      !replaced
      && path.basename(targetPath).startsWith('.schematics-path-semantics-')
      && stat !== undefined
      && !stat.isDirectory()
    ) {
      probePath = targetPath;
      replaced = true;
      unlinkSync(targetPath);
      fs.writeFileSync(targetPath, 'quarantined replacement');
    }
    return stat;
  });
  t.mock.method(fs, 'linkSync', () => {
    const error = codedError('simulated target restoration failure', 'EACCES');
    throw error;
  });

  const comparison = sameLocation(
    path.join(root, 'Future.HTML'),
    path.join(root, 'future.html'),
  );
  t.mock.restoreAll();

  expectResult(comparison, 'unknown');
  assert.equal(comparison.reason.code, 'future-name-probe-cleanup-failed');
  assert.equal(comparison.reason.systemCode, 'SCHEMATICS_PROBE_IDENTITY_CHANGED');
  assert.equal(comparison.reason.restoredAtTarget, false);
  assert.equal(typeof comparison.reason.recoveryPath, 'string');
  assert.equal(fs.existsSync(String(probePath)), false);
  assert.equal(
    fs.readFileSync(String(comparison.reason.recoveryPath), 'utf8'),
    'quarantined replacement',
  );
});

test('successful probe cleanup leaves no quarantine entry', (t) => {
  const root = scratchDirectory(t);
  sameLocation(path.join(root, 'Future.HTML'), path.join(root, 'future.html'));
  assert.deepEqual(
    fs.readdirSync(root).filter((entry) => entry.startsWith('.schematics-path-semantics-')),
    [],
  );
});

test('future name probes run in the directory whose semantics are being queried', (t) => {
  const root = scratchDirectory(t);
  const openSync = fs.openSync.bind(fs);
  let probeParent: string | undefined;
  t.mock.method(fs, 'openSync', (targetPath: string, ...args: RestOf<typeof fs.openSync>) => {
    if (
      path.basename(targetPath).startsWith('.schematics-path-semantics-')
      || path.basename(path.dirname(targetPath)).startsWith('.schematics-path-semantics-')
    ) {
      probeParent = path.dirname(targetPath);
    }
    return openSync(targetPath, ...args);
  });

  sameLocation(path.join(root, 'Future.HTML'), path.join(root, 'future.html'));
  t.mock.restoreAll();
  assert.equal(probeParent, fs.realpathSync.native(root));
});

test('future Windows short-name shapes fail closed before creation', (t) => {
  const root = scratchDirectory(t);
  const comparison = sameLocation(
    path.join(root, 'PROGRA~1', 'diagram.html'),
    path.join(root, 'Program Files', 'diagram.html'),
  );
  expectResult(comparison, process.platform === 'win32' ? 'unknown' : 'different');
  if (process.platform === 'win32') {
    assert.equal(comparison.reason.code, 'future-short-name-indeterminate');
  }
});

test('future Windows device names fail closed across the portable reserved set', (t) => {
  mockWindowsFilesystem(t, { entriesExist: false });
  for (const reserved of ['CONIN$.txt', 'CONOUT$.json', 'COM¹.html', 'COM²', 'LPT³.log']) {
    const comparison = sameLocation(
      `C:\\${reserved}`,
      String.raw`C:\ordinary-output.html`,
    );
    expectResult(comparison, 'unknown');
    assert.equal(comparison.reason.code, 'future-device-name-indeterminate');
  }
});

test('sameParent compares the parent location through directory aliases', (t) => {
  const root = scratchDirectory(t);
  const realDirectory = path.join(root, 'real');
  const linkedDirectory = path.join(root, 'linked');
  const otherDirectory = path.join(root, 'other');
  fs.mkdirSync(realDirectory);
  fs.mkdirSync(otherDirectory);
  fs.symlinkSync(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');

  expectResult(
    sameParent(path.join(realDirectory, 'left.html'), path.join(linkedDirectory, 'right.json')),
    'match',
  );
  expectResult(
    sameParent(path.join(realDirectory, 'left.html'), path.join(otherDirectory, 'right.json')),
    'different',
  );
});

test('containedBy handles existing and future descendants and rejects link escapes', (t) => {
  const root = scratchDirectory(t);
  const container = path.join(root, 'container');
  const nested = path.join(container, 'nested');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(outside);
  const file = path.join(nested, 'diagram.html');
  fs.writeFileSync(file, 'diagram');
  const escape = path.join(container, 'escape');
  fs.symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');

  expectResult(containedBy(container, container), 'match');
  expectResult(containedBy(container, file), 'match');
  expectResult(containedBy(container, path.join(nested, 'future.html')), 'match');
  expectResult(containedBy(container, path.join(escape, 'future.html')), 'different');
  expectResult(containedBy(container, path.join(outside, 'future.html')), 'different');
  expectResult(containedBy(path.join(root, 'missing'), file), 'unknown');
});

test('containedBy does not fold case-distinct sibling directories', (t) => {
  const root = scratchDirectory(t);
  const upper = path.join(root, 'CaseRoot');
  const lower = path.join(root, 'caseroot');
  fs.mkdirSync(upper);

  let sibling = lower;
  try {
    fs.mkdirSync(lower);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    sibling = path.join(root, 'different-root');
    fs.mkdirSync(sibling);
  }

  const upperStat = fs.statSync(upper, { bigint: true });
  const siblingStat = fs.statSync(sibling, { bigint: true });
  assert.notEqual(`${upperStat.dev}:${upperStat.ino}`, `${siblingStat.dev}:${siblingStat.ino}`);
  expectResult(containedBy(upper, path.join(sibling, 'future.html')), 'different');
});

test('containedBy resolves physical aliases for a future container prefix', (t) => {
  const root = scratchDirectory(t);
  const physical = path.join(root, 'physical');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(physical);
  try {
    fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(errorCode(error))) {
      t.skip('directory aliases are unavailable');
      return;
    }
    throw error;
  }

  const relation = containedBy(
    path.join(alias, 'future-stage'),
    path.join(physical, 'future-stage', 'modes.json'),
  );
  expectResult(relation, 'match');
  assert.equal(relation.reason.code, 'future-container-prefix-match');
  expectResult(
    containedBy(
      path.join(alias, 'other-stage'),
      path.join(physical, 'future-stage', 'modes.json'),
    ),
    'different',
  );
});

test('containedBy does not project ancestor semantics through a future container', (t) => {
  const root = scratchDirectory(t);
  const comparison = containedBy(
    path.join(root, 'future-parent', 'Diagram'),
    path.join(root, 'future-parent', 'diagram', 'artifact.html'),
  );
  expectResult(comparison, 'unknown');
  assert.equal(comparison.reason.code, 'future-descendant-semantics-indeterminate');
  assert.equal(comparison.reason.segmentIndex, 1);
});
