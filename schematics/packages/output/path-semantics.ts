import fs from 'node:fs';
import path from 'node:path';

const MAX_SYMLINK_DEPTH = 64;
const RECENT_PROBE_NAME_LIMIT = 128;
const recentProbeNames = new Set<string>();
const WINDOWS_SMB_SHARE_FORBIDDEN = /[\u0000-\u001F"\/\\[\]:|<>+=;,?*]/u;

export type SemanticStatus = 'match' | 'different' | 'unknown';

export interface SemanticReason {
  code: string;
  method?: string;
  operation?: string;
  systemCode?: string;
  recoveryPath?: string;
  restoredAtTarget?: boolean;
  [detail: string]: unknown;
}

export interface SemanticResult<S extends SemanticStatus = SemanticStatus> {
  status: S;
  reason: SemanticReason;
}

export type UnknownResult = SemanticResult<'unknown'>;

export type PhysicalLocation =
  | { kind: 'existing'; path: string }
  | { kind: 'future'; ancestorPath: string; unresolved: string[] };

export interface ResolvedPhysicalLocation {
  status: 'resolved';
  location: PhysicalLocation;
  reason: SemanticReason;
}

export interface SidecarNamespaceKey {
  status: 'resolved';
  directoryPath: string;
  componentKey: string;
  reason: SemanticReason;
}

type ReasonDetails = Record<string, unknown>;

export function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

export function errorCode(error: unknown): unknown {
  return readField(error, 'code');
}

export function errorMessage(error: unknown): unknown {
  return readField(error, 'message');
}

interface Failure {
  ok: false;
  failure: UnknownResult;
}

interface KnownEntry {
  realPath: string;
  stat: fs.BigIntStats;
}

interface IdentityEntry {
  realPath: string;
  stat: fs.BigIntStats | undefined;
}

interface PathPlan {
  root: string;
  segments: string[];
}

interface SplitOptions {
  internalRelativeLinkTarget?: boolean;
}

type AbsolutePathResult = Failure | { ok: true; path: string };
type SplitTailResult = Failure | { ok: true; segments: string[] };
type SplitResult = Failure | ({ ok: true } & PathPlan);
type ExistingResolution = { ok: true; existing: true; entry: KnownEntry; unresolved: string[] };
type FutureResolution = { ok: true; existing: false; ancestor: KnownEntry; unresolved: string[] };
type Resolution = Failure | ExistingResolution | FutureResolution;
type ComponentResult = Failure | { ok: true; component: string };
type ParentResult = Failure | { ok: true; entry: KnownEntry };

export function isWindowsIpcShare(share: string): boolean {
  return /^(?:IPC\$|pipe|mailslot)$/iu.test(share);
}

export function isValidWindowsSmbShareName(share: unknown): boolean {
  return typeof share === 'string'
    && share.length > 0
    && share.length <= 80
    && !WINDOWS_SMB_SHARE_FORBIDDEN.test(share)
    && !/[ .]$/u.test(share);
}

function result<S extends SemanticStatus>(status: S, code: string, details: ReasonDetails = {}): SemanticResult<S> {
  return {
    status,
    reason: {
      code,
      ...details,
    },
  };
}

function unknown(code: string, details: ReasonDetails = {}): UnknownResult {
  return result('unknown', code, details);
}

function systemFailure(code: string, error: unknown, details: ReasonDetails = {}): UnknownResult {
  const systemCode = readField(error, 'code');
  const recoveryPath = readField(error, 'recoveryPath');
  const restoredAtTarget = readField(error, 'restoredAtTarget');
  return unknown(code, {
    ...details,
    ...(typeof systemCode === 'string' ? { systemCode } : {}),
    ...(typeof recoveryPath === 'string' ? { recoveryPath } : {}),
    ...(typeof restoredAtTarget === 'boolean'
      ? { restoredAtTarget }
      : {}),
  });
}

function hostPath(): typeof path.posix {
  return process.platform === 'win32' ? path.win32 : path.posix;
}

function absolutePath(input: unknown, side: string, basePath = process.cwd()): AbsolutePathResult {
  if (typeof input !== 'string' || input.length === 0) {
    return {
      ok: false,
      failure: unknown('invalid-path', { side }),
    };
  }

  try {
    const pathApi = hostPath();
    if (pathApi.isAbsolute(input)) return { ok: true, path: input };
    if (pathApi.parse(input).root) {
      return {
        ok: false,
        failure: unknown('drive-relative-path', { side }),
      };
    }
    const separator = basePath.endsWith(pathApi.sep) ? '' : pathApi.sep;
    return { ok: true, path: `${basePath}${separator}${input}` };
  } catch (error) {
    return {
      ok: false,
      failure: systemFailure('invalid-path', error, { side }),
    };
  }
}

function rootFailure(code: string, side: string): Failure {
  return {
    ok: false,
    failure: unknown(code, { side }),
  };
}

function splitWindowsExtendedTail(
  tail: string,
  side: string,
  { internalRelativeLinkTarget = false }: SplitOptions = {},
): SplitTailResult {
  const authoredSegments = tail.split('\\');
  // A single final separator is harmless, while an internal empty segment
  // would require normalizing a raw extended path before it reaches Windows.
  if (!internalRelativeLinkTarget
    && authoredSegments.slice(0, -1).some((component) => component.length === 0)) {
    return rootFailure('windows-root-invalid', side);
  }
  const segments = authoredSegments.filter(Boolean);
  if (!internalRelativeLinkTarget
    && segments.some((component) => component === '.' || component === '..')) {
    return rootFailure('windows-root-invalid', side);
  }
  return { ok: true, segments };
}

function splitWindowsAbsolute(
  absolute: string,
  side: string,
  { internalRelativeLinkTarget = false }: SplitOptions = {},
): SplitResult {
  if (/^[\\/]{2}\.[\\/]/u.test(absolute)) {
    return rootFailure('windows-namespace-unsupported', side);
  }
  if (/^[\\/]{2}\?[\\/]/u.test(absolute) && !absolute.startsWith('\\\\?\\')) {
    return rootFailure('windows-namespace-unsupported', side);
  }

  if (absolute.startsWith('\\\\?\\')) {
    if (absolute.includes('/')) return rootFailure('windows-root-invalid', side);
    if (
      /^\\\\\?\\(?:GLOBALROOT|Device)(?:\\|$)/iu.test(absolute)
      || /^\\\\\?\\Volume\{/iu.test(absolute)
    ) {
      return rootFailure('windows-namespace-unsupported', side);
    }

    const extendedUnc = absolute.match(/^(\\\\\?\\UNC\\([^\\]+)\\([^\\]+))(?:\\(.*))?$/iu);
    if (extendedUnc) {
      if (isWindowsIpcShare(extendedUnc[3])) {
        return rootFailure('windows-namespace-unsupported', side);
      }
      if (!isValidWindowsSmbShareName(extendedUnc[3])) {
        return rootFailure('windows-root-invalid', side);
      }
      if ([extendedUnc[2], extendedUnc[3]].some((component) => component === '.' || component === '..')) {
        return rootFailure('windows-root-invalid', side);
      }
      const tail = splitWindowsExtendedTail(
        extendedUnc[4] || '',
        side,
        { internalRelativeLinkTarget },
      );
      if (!tail.ok) return tail;
      return {
        ok: true,
        root: `${extendedUnc[1]}\\`,
        segments: tail.segments,
      };
    }

    const extendedDrive = absolute.match(/^(\\\\\?\\[A-Za-z]:\\)(.*)$/u);
    if (extendedDrive) {
      const tail = splitWindowsExtendedTail(
        extendedDrive[2],
        side,
        { internalRelativeLinkTarget },
      );
      if (!tail.ok) return tail;
      return {
        ok: true,
        root: extendedDrive[1],
        segments: tail.segments,
      };
    }
    return rootFailure('windows-root-invalid', side);
  }

  const unc = absolute.match(/^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/u);
  if (unc) {
    if (isWindowsIpcShare(unc[2])) {
      return rootFailure('windows-namespace-unsupported', side);
    }
    if (!isValidWindowsSmbShareName(unc[2])) {
      return rootFailure('windows-root-invalid', side);
    }
    if ([unc[1], unc[2]].some((component) => component === '.' || component === '..')) {
      return rootFailure('windows-root-invalid', side);
    }
    return {
      ok: true,
      root: `\\\\${unc[1]}\\${unc[2]}\\`,
      segments: (unc[3] || '').split(/[\\/]+/u).filter(Boolean),
    };
  }

  const drive = absolute.match(/^([A-Za-z]:)[\\/](.*)$/u);
  if (drive) {
    return {
      ok: true,
      root: `${drive[1]}\\`,
      segments: drive[2].split(/[\\/]+/u).filter(Boolean),
    };
  }
  return rootFailure('windows-root-invalid', side);
}

function splitAbsolute(absolute: string, side: string, options?: SplitOptions): SplitResult {
  if (process.platform === 'win32') return splitWindowsAbsolute(absolute, side, options);
  const root = path.posix.parse(absolute).root;
  return {
    ok: true,
    root,
    segments: absolute.slice(root.length).split(/\/+/u).filter(Boolean),
  };
}

function statBigInt(targetPath: string): fs.BigIntStats {
  return fs.statSync(targetPath, { bigint: true });
}

function ordinaryWindowsRoot(extendedRoot: string): string | null {
  const drive = extendedRoot.match(/^\\\\\?\\([A-Za-z]:\\)$/u);
  if (drive) return drive[1];

  const unc = extendedRoot.match(/^\\\\\?\\UNC\\([^\\]+)\\([^\\]+)\\$/iu);
  return unc ? `\\\\${unc[1]}\\${unc[2]}\\` : null;
}

function hasStableIdentity(stat: fs.BigIntStats | undefined): stat is fs.BigIntStats {
  return typeof stat?.dev === 'bigint'
    && typeof stat?.ino === 'bigint'
    && stat.ino !== 0n;
}

function compareKnownEntries(left: IdentityEntry, right: IdentityEntry, operation: string): SemanticResult {
  if (hasStableIdentity(left.stat) && hasStableIdentity(right.stat)) {
    const matches = left.stat.dev === right.stat.dev && left.stat.ino === right.stat.ino;
    return result(matches ? 'match' : 'different', matches ? 'file-identity-match' : 'file-identity-different', {
      operation,
      method: 'bigint-stat',
    });
  }

  // path-contract-allow: lexical-capability -- Canonical paths are compared inside the identity primitive.
  if (left.realPath === right.realPath) {
    return result('match', 'native-realpath-match', {
      operation,
      method: 'native-realpath',
    });
  }

  return unknown('file-identity-unavailable', {
    operation,
    method: 'bigint-stat-and-native-realpath',
  });
}

function rememberProbeName(name: string): void {
  recentProbeNames.add(name);
  if (recentProbeNames.size > RECENT_PROBE_NAME_LIMIT) {
    const oldest = recentProbeNames.values().next().value;
    if (oldest !== undefined) recentProbeNames.delete(oldest);
  }
}

function probeInterference(
  message: string,
  code = 'SCHEMATICS_PROBE_IDENTITY_CHANGED',
  details: ReasonDetails = {},
): Error {
  const error = Object.assign(new Error(message), { code });
  Object.assign(error, details);
  return error;
}

function withRecovery(error: unknown, recoveryPath: string): unknown {
  if (typeof error === 'object' && error !== null) {
    Object.assign(error, { recoveryPath, restoredAtTarget: false });
  }
  return error;
}

function sameStableIdentity(left: fs.BigIntStats | undefined, right: fs.BigIntStats | undefined): boolean {
  return hasStableIdentity(left)
    && hasStableIdentity(right)
    && left.dev === right.dev
    && left.ino === right.ino;
}

function preserveQuarantinedReplacement(quarantinePath: string, targetPath: string): { restoredAtTarget: boolean } {
  try {
    fs.linkSync(quarantinePath, targetPath);
    return { restoredAtTarget: true };
  } catch {
    // Preserve the quarantined entry when the original name was concurrently
    // occupied or the host cannot create a hard link. Never overwrite either.
    return { restoredAtTarget: false };
  }
}

function removeOwnedProbe(targetPath: string, expectedStat: fs.BigIntStats): unknown {
  let currentStat;
  try {
    currentStat = fs.lstatSync(targetPath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return probeInterference('filesystem probe disappeared before cleanup', 'SCHEMATICS_PROBE_MISSING');
    }
    return error;
  }
  if (!sameStableIdentity(expectedStat, currentStat)) {
    return probeInterference('filesystem probe identity changed before cleanup');
  }

  const quarantineName = `.schematics-path-semantics-cleanup-${process.pid}-${Buffer.from(crypto.getRandomValues(new Uint8Array(10))).toString('hex')}`;
  const quarantinePath = path.join(path.dirname(targetPath), quarantineName);
  rememberProbeName(quarantineName);
  try {
    // Move the checked name into a fresh, unpublished quarantine namespace.
    // A replacement introduced after the check is moved rather than deleted.
    fs.renameSync(targetPath, quarantinePath);
  } catch (error) {
    return error;
  }

  let quarantineStat;
  try {
    quarantineStat = fs.lstatSync(quarantinePath, { bigint: true });
  } catch (error) {
    return withRecovery(error, quarantinePath);
  }
  if (!sameStableIdentity(expectedStat, quarantineStat)) {
    const recovery = preserveQuarantinedReplacement(quarantinePath, targetPath);
    return probeInterference(
      'filesystem probe identity changed during cleanup',
      'SCHEMATICS_PROBE_IDENTITY_CHANGED',
      { recoveryPath: quarantinePath, ...recovery },
    );
  }

  try {
    // The quarantine spelling did not exist before the atomic rename and is
    // never returned to callers. Legitimate target-path replacements therefore
    // remain outside the only namespace we unlink.
    fs.unlinkSync(quarantinePath);
    return null;
  } catch (error) {
    return withRecovery(error, quarantinePath);
  }
}

function resolvePlan({ root, segments }: PathPlan, side: string, depth: number): Resolution {
  if (depth > MAX_SYMLINK_DEPTH) {
    return {
      ok: false,
      failure: unknown('symlink-cycle', { side }),
    };
  }

  let current: string;
  let currentStat: fs.BigIntStats;
  try {
    current = fs.realpathSync.native(root);
  } catch (error) {
    // Node on Windows can report EISDIR while resolving a valid extended
    // filesystem root (for example \\?\C:\). The namespace was already
    // validated by splitWindowsAbsolute, so retain its exact spelling for
    // traversal.
    if (process.platform === 'win32'
      && errorCode(error) === 'EISDIR'
      && ordinaryWindowsRoot(root)) {
      current = root;
    } else {
      return {
        ok: false,
        failure: systemFailure('root-resolution-failed', error, { side }),
      };
    }
  }

  try {
    currentStat = statBigInt(current);
  } catch (error) {
    // The same Node/Windows edge can occur during stat after realpath succeeds.
    // A drive or share root is short enough for its ordinary spelling, while
    // `current` remains namespaced so descendants keep long-path semantics.
    const ordinaryRoot = process.platform === 'win32'
      && errorCode(error) === 'EISDIR'
      ? ordinaryWindowsRoot(root)
      : null;
    if (ordinaryRoot && ordinaryRoot !== current) {
      try {
        currentStat = statBigInt(ordinaryRoot);
      } catch (statError) {
        return {
          ok: false,
          failure: systemFailure('root-resolution-failed', statError, { side }),
        };
      }
    } else {
      return {
        ok: false,
        failure: systemFailure('root-resolution-failed', error, { side }),
      };
    }
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === '.') continue;
    if (segment === '..') {
      if (!currentStat.isDirectory()) {
        return {
          ok: false,
          failure: unknown('ancestor-not-directory', { side, segmentIndex: index }),
        };
      }
      try {
        current = fs.realpathSync.native(hostPath().dirname(current));
        currentStat = statBigInt(current);
      } catch (error) {
        return {
          ok: false,
          failure: systemFailure('path-resolution-failed', error, { side, segmentIndex: index }),
        };
      }
      continue;
    }

    const candidate = hostPath().join(current, segment);
    let candidateStat;
    try {
      candidateStat = fs.lstatSync(candidate, { bigint: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        if (!currentStat.isDirectory()) {
          return {
            ok: false,
            failure: unknown('ancestor-not-directory', { side, segmentIndex: index }),
          };
        }
        const unresolved = segments.slice(index).filter((item) => item !== '.');
        if (unresolved.includes('..')) {
          return {
            ok: false,
            failure: unknown('future-parent-traversal-indeterminate', {
              side,
              segmentIndex: index,
            }),
          };
        }
        return {
          ok: true,
          existing: false,
          ancestor: {
            realPath: current,
            stat: currentStat,
          },
          unresolved,
        };
      }
      if (errorCode(error) === 'ENOTDIR') {
        return {
          ok: false,
          failure: systemFailure('ancestor-not-directory', error, { side, segmentIndex: index }),
        };
      }
      return {
        ok: false,
        failure: systemFailure('path-resolution-failed', error, { side, segmentIndex: index }),
      };
    }

    if (candidateStat.isSymbolicLink()) {
      let linkPlan: PathPlan;
      try {
        const authoredTarget = fs.readlinkSync(candidate);
        const pathApi = hostPath();
        const internalRelativeLinkTarget = !pathApi.isAbsolute(authoredTarget)
          && !pathApi.parse(authoredTarget).root;
        const parsedTarget = absolutePath(authoredTarget, side, hostPath().dirname(candidate));
        if (!parsedTarget.ok) return parsedTarget;
        const target = splitAbsolute(parsedTarget.path, side, { internalRelativeLinkTarget });
        if (!target.ok) return target;
        linkPlan = {
          root: target.root,
          segments: [...target.segments, ...segments.slice(index + 1)],
        };
      } catch (error) {
        return {
          ok: false,
          failure: systemFailure('symlink-resolution-failed', error, { side, segmentIndex: index }),
        };
      }
      return resolvePlan(linkPlan, side, depth + 1);
    }

    if (index < segments.length - 1 && !candidateStat.isDirectory()) {
      return {
        ok: false,
        failure: unknown('ancestor-not-directory', { side, segmentIndex: index }),
      };
    }

    try {
      current = fs.realpathSync.native(candidate);
      currentStat = statBigInt(current);
    } catch (error) {
      return {
        ok: false,
        failure: systemFailure('path-resolution-failed', error, { side, segmentIndex: index }),
      };
    }
  }

  return {
    ok: true,
    existing: true,
    entry: {
      realPath: current,
      stat: currentStat,
    },
    unresolved: [],
  };
}

function resolveLocation(input: unknown, side: string): Resolution {
  const parsed = absolutePath(input, side);
  if (!parsed.ok) return parsed;
  const plan = splitAbsolute(parsed.path, side);
  if (!plan.ok) return plan;
  return resolvePlan(plan, side, 0);
}

function semanticNameEnvelope(name: string): Set<string> | null {
  const names = new Set([name]);
  const pending = [name];
  while (pending.length > 0 && names.size <= 64) {
    const current = pending.shift();
    if (current === undefined) break;
    const candidates = [
      current.normalize('NFC'),
      current.normalize('NFD'),
      current.toLocaleLowerCase('en-US'),
      current.toLocaleUpperCase('en-US'),
    ];
    for (const candidate of candidates) {
      if (names.has(candidate)) continue;
      names.add(candidate);
      pending.push(candidate);
    }
  }
  return names.size <= 64 ? names : null;
}

function semanticEnvelopesOverlap(leftName: string, rightName: string): boolean {
  const left = semanticNameEnvelope(leftName);
  const right = semanticNameEnvelope(rightName);
  if (!left || !right) return true;
  for (const spelling of left) {
    if (right.has(spelling)) return true;
  }
  return false;
}

function windowsDeviceName(name: string): boolean {
  const stem = name.split('.')[0].replace(/[ .]+$/u, '').toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(stem);
}

function futureWindowsNameRisk(leftName: string, rightName: string): UnknownResult | null {
  if (process.platform !== 'win32') return null;
  const windowsShortName = /~[1-9][0-9]*(?:\.|$)/iu;
  if (windowsShortName.test(leftName) || windowsShortName.test(rightName)) {
    return unknown('future-short-name-indeterminate', { method: 'windows-8dot3' });
  }
  if (windowsDeviceName(leftName) || windowsDeviceName(rightName)) {
    return unknown('future-device-name-indeterminate', { method: 'windows-device-name' });
  }
  if (/[ .]$/.test(leftName) || /[ .]$/.test(rightName)) {
    return unknown('future-trim-name-indeterminate', { method: 'windows-trim-alias' });
  }
  return null;
}

/**
 * Resolve one existing or future path through the host filesystem without
 * exposing a string key for identity comparisons.
 */
export function resolvePhysicalLocation(targetPath: unknown): UnknownResult | ResolvedPhysicalLocation {
  const resolution = resolveLocation(targetPath, 'target');
  if (!resolution.ok) return resolution.failure;
  if (resolution.existing) {
    return {
      status: 'resolved',
      location: {
        kind: 'existing',
        path: resolution.entry.realPath,
      },
      reason: {
        code: 'existing-native-realpath',
        method: 'native-realpath',
      },
    };
  }
  return {
    status: 'resolved',
    location: {
      kind: 'future',
      ancestorPath: resolution.ancestor.realPath,
      unresolved: [...resolution.unresolved],
    },
    reason: {
      code: 'future-physical-ancestor',
      method: 'native-realpath',
    },
  };
}

function settledComparison(comparison: SemanticResult | undefined): SemanticResult {
  if (!comparison) throw new Error('filesystem probe finished without a comparison');
  return comparison;
}

function probeNameAlias(directoryPath: string, leftName: string, rightName: string): SemanticResult {
  if (leftName === rightName) {
    return result('match', 'future-name-exact', { method: 'lexical-exact' });
  }
  if (recentProbeNames.has(leftName) || recentProbeNames.has(rightName)) {
    return result('different', 'internal-probe-name', { method: 'probe-suppression' });
  }
  const windowsRisk = futureWindowsNameRisk(leftName, rightName);
  if (windowsRisk) return windowsRisk;
  if (!semanticEnvelopesOverlap(leftName, rightName)) {
    return result('different', 'future-name-distinct', { method: 'semantic-envelope' });
  }

  const prefix = `.schematics-path-semantics-${process.pid}-${Buffer.from(crypto.getRandomValues(new Uint8Array(10))).toString('hex')}-`;
  const probeName = `${prefix}${leftName}`;
  const lookupName = `${prefix}${rightName}`;
  const componentLength = (name: string) => process.platform === 'win32'
    ? name.length
    : Buffer.byteLength(name, 'utf8');
  if (componentLength(probeName) > 255 || componentLength(lookupName) > 255) {
    return unknown('future-name-probe-unrepresentable', {
      method: 'direct-filesystem-probe',
      systemCode: 'ENAMETOOLONG',
    });
  }

  let probePath: string | undefined;
  let probeStat: fs.BigIntStats | undefined;
  let descriptor: number | undefined;
  let comparison: SemanticResult | undefined;
  let cleanupError: unknown;
  try {
    // Probe entries must live directly in the directory being queried. On
    // Windows case sensitivity is per-directory and a child may not inherit it.
    rememberProbeName(probeName);
    rememberProbeName(lookupName);
    probePath = path.join(directoryPath, probeName);
    const lookupPath = path.join(directoryPath, lookupName);
    descriptor = fs.openSync(probePath, 'wx', 0o600);
    probeStat = fs.fstatSync(descriptor, { bigint: true });

    let authoredStat: fs.BigIntStats | undefined;
    let lookupStat: fs.BigIntStats | undefined;
    try {
      authoredStat = statBigInt(probePath);
      lookupStat = statBigInt(lookupPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        comparison = result('different', 'future-name-different', { method: 'filesystem-probe' });
      } else {
        comparison = systemFailure('future-name-probe-failed', error, { method: 'filesystem-probe' });
      }
    }

    if (!comparison) {
      const identity = compareKnownEntries(
        { realPath: fs.realpathSync.native(probePath), stat: authoredStat },
        { realPath: fs.realpathSync.native(lookupPath), stat: lookupStat },
        'future-name',
      );
      if (identity.status === 'match') {
        comparison = result('match', 'future-name-alias', { method: 'filesystem-probe' });
      } else if (identity.status === 'different') {
        comparison = result('different', 'future-name-different', { method: 'filesystem-probe' });
      } else {
        comparison = identity;
      }
    }
  } catch (error) {
    comparison = systemFailure('future-name-probe-failed', error, { method: 'filesystem-probe' });
  } finally {
    // Pin the inode until cleanup finishes. Once the final handle is closed,
    // an unlinked probe's inode can be reused by a replacement at the same name.
    if (probeStat && probePath !== undefined) cleanupError = removeOwnedProbe(probePath, probeStat);
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        cleanupError = cleanupError ?? error;
      }
    }
  }

  if (cleanupError) {
    return systemFailure('future-name-probe-cleanup-failed', cleanupError, {
      method: 'filesystem-probe',
      ...(comparison ? { comparison: comparison.reason } : {}),
    });
  }
  return settledComparison(comparison);
}

function sidecarCaseKey(component: string): string {
  // The candidate is accepted only after the containing filesystem confirms
  // that the original grapheme and this spelling name the same entry.
  return component.toLocaleUpperCase('en-US').toLocaleLowerCase('en-US');
}

function transformSidecarComponent(
  directoryPath: string,
  component: string,
  transform: (segment: string) => string,
  phase: string,
): ComponentResult {
  if (typeof Intl.Segmenter !== 'function') {
    return {
      ok: false,
      failure: unknown('sidecar-unicode-segmentation-unavailable', {
        operation: 'sidecar-namespace-key',
      }),
    };
  }
  const segmenter = new Intl.Segmenter('en-US', { granularity: 'grapheme' });
  const comparisons = new Map<string, SemanticResult>();
  const output: string[] = [];
  for (const { segment } of segmenter.segment(component)) {
    const candidate = transform(segment);
    if (candidate === segment) {
      output.push(segment);
      continue;
    }
    const cacheKey = `${segment}\0${candidate}`;
    let comparison = comparisons.get(cacheKey);
    if (!comparison) {
      comparison = probeNameAlias(directoryPath, segment, candidate);
      comparisons.set(cacheKey, comparison);
    }
    if (comparison.status === 'unknown') {
      return {
        ok: false,
        failure: unknown(`sidecar-${phase}-semantics-indeterminate`, {
          operation: 'sidecar-namespace-key',
          cause: comparison.reason,
        }),
      };
    }
    output.push(comparison.status === 'match' ? candidate : segment);
  }
  return {
    ok: true,
    component: output.join(''),
  };
}

/**
 * Produce a stable component for a sidecar namespace in one existing
 * directory. The returned string is a collision-domain key, not a canonical
 * path and must never be used to decide whether two filesystem entries match.
 */
export function sidecarNamespaceComponentKey(
  directoryPath: unknown,
  component: unknown,
): UnknownResult | SidecarNamespaceKey {
  if (typeof component !== 'string' || component.length === 0
    || component === '.' || component === '..'
    || hostPath().basename(component) !== component) {
    return unknown('invalid-sidecar-component', {
      operation: 'sidecar-namespace-key',
    });
  }

  const directory = resolveLocation(directoryPath, 'sidecar-directory');
  if (!directory.ok) return directory.failure;
  if (!directory.existing) {
    return unknown('sidecar-directory-missing', {
      operation: 'sidecar-namespace-key',
    });
  }
  if (!directory.entry.stat.isDirectory()) {
    return unknown('sidecar-parent-not-directory', {
      operation: 'sidecar-namespace-key',
    });
  }

  const normalized = transformSidecarComponent(
    directory.entry.realPath,
    component,
    (segment) => segment.normalize('NFC'),
    'normalization',
  );
  if (!normalized.ok) return normalized.failure;
  const cased = transformSidecarComponent(
    directory.entry.realPath,
    normalized.component,
    sidecarCaseKey,
    'case',
  );
  if (!cased.ok) return cased.failure;
  const renormalized = transformSidecarComponent(
    directory.entry.realPath,
    cased.component,
    (segment) => segment.normalize('NFC'),
    'normalization',
  );
  if (!renormalized.ok) return renormalized.failure;

  return {
    status: 'resolved',
    directoryPath: directory.entry.realPath,
    componentKey: renormalized.component,
    reason: {
      code: 'sidecar-namespace-key',
      method: 'directory-filesystem-probe',
    },
  };
}

function compareUnmaterializedNames(leftName: string, rightName: string): SemanticResult {
  if (leftName === rightName) {
    return result('match', 'future-name-exact', { method: 'lexical-exact' });
  }
  const windowsRisk = futureWindowsNameRisk(leftName, rightName);
  if (windowsRisk) return windowsRisk;
  if (!semanticEnvelopesOverlap(leftName, rightName)) {
    return result('different', 'future-name-distinct', { method: 'semantic-envelope' });
  }
  return unknown('future-descendant-semantics-indeterminate', {
    method: 'unmaterialized-directory',
  });
}

function compareFutureLocations(left: FutureResolution, right: FutureResolution): SemanticResult {
  const ancestor = compareKnownEntries(left.ancestor, right.ancestor, 'future-ancestor');
  if (ancestor.status !== 'match') return ancestor;

  if (left.unresolved.length !== right.unresolved.length) {
    return result('different', 'future-depth-different', {
      operation: 'same-location',
      leftDepth: left.unresolved.length,
      rightDepth: right.unresolved.length,
    });
  }

  let probedSegments = 0;
  for (let index = 0; index < left.unresolved.length; index += 1) {
    const names = index === 0
      ? probeNameAlias(
        left.ancestor.realPath,
        left.unresolved[index],
        right.unresolved[index],
      )
      : compareUnmaterializedNames(left.unresolved[index], right.unresolved[index]);
    if (names.reason.method === 'filesystem-probe') probedSegments += 1;
    if (names.status !== 'match') {
      const { code, ...reasonDetails } = names.reason;
      return result(names.status, code, {
        ...reasonDetails,
        operation: 'same-location',
        segmentIndex: index,
      });
    }
  }

  return result('match', probedSegments > 0 ? 'future-location-alias' : 'future-location-exact', {
    operation: 'same-location',
    method: probedSegments > 0 ? 'filesystem-probe' : 'lexical-exact',
    probedSegments,
  });
}

/**
 * Compare two existing filesystem entries by physical identity.
 * Missing or unidentifiable entries return `unknown`, never `different`.
 */
export function sameEntry(leftPath: unknown, rightPath: unknown): SemanticResult {
  const left = resolveLocation(leftPath, 'left');
  if (!left.ok) return left.failure;
  const right = resolveLocation(rightPath, 'right');
  if (!right.ok) return right.failure;

  if (!left.existing || !right.existing) {
    return unknown('entry-missing', {
      operation: 'same-entry',
      missing: [
        ...(!left.existing ? ['left'] : []),
        ...(!right.existing ? ['right'] : []),
      ],
    });
  }

  return compareKnownEntries(left.entry, right.entry, 'same-entry');
}

/**
 * Compare two existing or future write targets using the containing filesystem's
 * actual name semantics. Existing hard links and resolved symbolic links match.
 */
export function sameLocation(leftPath: unknown, rightPath: unknown): SemanticResult {
  const left = resolveLocation(leftPath, 'left');
  if (!left.ok) return left.failure;
  const right = resolveLocation(rightPath, 'right');
  if (!right.ok) return right.failure;

  if (left.existing && right.existing) {
    return compareKnownEntries(left.entry, right.entry, 'same-location');
  }
  if (left.existing || right.existing) {
    return result('different', 'location-existence-different', {
      operation: 'same-location',
      existing: left.existing ? 'left' : 'right',
    });
  }
  return compareFutureLocations(left, right);
}

/** Compare the physical locations of the two paths' parent directories. */
export function sameParent(leftPath: unknown, rightPath: unknown): SemanticResult {
  const left = absolutePath(leftPath, 'left');
  if (!left.ok) return left.failure;
  const right = absolutePath(rightPath, 'right');
  if (!right.ok) return right.failure;

  return sameLocation(hostPath().dirname(left.path), hostPath().dirname(right.path));
}

function parentEntry(entry: KnownEntry): ParentResult | null {
  const parentPath = hostPath().dirname(entry.realPath);
  // path-contract-allow: lexical-capability -- Both values are canonical paths captured by this primitive.
  if (parentPath === entry.realPath) return null;
  try {
    const realPath = fs.realpathSync.native(parentPath);
    return {
      ok: true,
      entry: {
        realPath,
        stat: statBigInt(realPath),
      },
    };
  } catch (error) {
    return {
      ok: false,
      failure: systemFailure('ancestor-resolution-failed', error, {
        operation: 'contained-by',
      }),
    };
  }
}

/**
 * Determine physical containment in an existing directory. The comparison is
 * inclusive and follows links; the target may exist or name a future location.
 */
export function containedBy(directoryPath: unknown, targetPath: unknown): SemanticResult {
  const directory = resolveLocation(directoryPath, 'directory');
  if (!directory.ok) return directory.failure;
  if (directory.existing && !directory.entry.stat.isDirectory()) {
    return unknown('container-not-directory', { operation: 'contained-by' });
  }

  const target = resolveLocation(targetPath, 'target');
  if (!target.ok) return target.failure;

  if (!directory.existing) {
    if (target.existing) {
      return unknown('container-missing', { operation: 'contained-by' });
    }
    const ancestor = compareKnownEntries(directory.ancestor, target.ancestor, 'contained-by');
    if (ancestor.status !== 'match') return ancestor;
    if (target.unresolved.length < directory.unresolved.length) {
      return result('different', 'future-container-prefix-too-deep', {
        operation: 'contained-by',
      });
    }
    for (let index = 0; index < directory.unresolved.length; index += 1) {
      const segment = index === 0
        ? probeNameAlias(
          directory.ancestor.realPath,
          directory.unresolved[index],
          target.unresolved[index],
        )
        : compareUnmaterializedNames(
          directory.unresolved[index],
          target.unresolved[index],
        );
      if (segment.status === 'match') continue;
      const { code, ...reasonDetails } = segment.reason;
      return result(segment.status, code, {
        ...reasonDetails,
        operation: 'contained-by',
        segmentIndex: index,
      });
    }
    return result('match', 'future-container-prefix-match', {
      operation: 'contained-by',
      target: 'future',
      depth: target.unresolved.length - directory.unresolved.length,
    });
  }

  let current: KnownEntry | undefined;
  if (!target.existing) {
    current = target.ancestor;
  } else if (target.entry.stat.isDirectory()) {
    current = target.entry;
  } else {
    const parent = parentEntry(target.entry);
    if (!parent?.ok) return parent?.failure ?? unknown('ancestor-resolution-failed', {
      operation: 'contained-by',
    });
    current = parent.entry;
  }

  let depth = 0;
  let identityWasUnknown = false;
  while (current) {
    const comparison = compareKnownEntries(directory.entry, current, 'contained-by');
    if (comparison.status === 'match') {
      return result('match', 'physical-ancestor-match', {
        operation: 'contained-by',
        depth,
        target: target.existing ? 'existing' : 'future',
      });
    }
    if (comparison.status === 'unknown') identityWasUnknown = true;

    const parent = parentEntry(current);
    if (parent === null) break;
    if (!parent.ok) return parent.failure;
    current = parent.entry;
    depth += 1;
  }

  if (identityWasUnknown) {
    return unknown('containment-identity-unavailable', {
      operation: 'contained-by',
      target: target.existing ? 'existing' : 'future',
    });
  }
  return result('different', 'physical-ancestor-not-found', {
    operation: 'contained-by',
    target: target.existing ? 'existing' : 'future',
  });
}
