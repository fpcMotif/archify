#!/usr/bin/env bun

import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as AtomicOutput from '../packages/output/atomic-output.ts';
import type * as PathSemantics from '../packages/output/path-semantics.ts';
import type * as SidecarPath from '../packages/output/sidecar-path.ts';
import type { LaunchReceipt } from './open-artifact.ts';
import type * as VisualCheck from './visual-check.ts';
import type { WorkflowMigrationResult } from '../packages/migrations/workflow-v2.ts';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');

const TYPES = new Set(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle', 'erd', 'tree', 'class', 'timeline', 'waterfall', 'explainer']);
const DELIVERY_SIDECAR_SUFFIXES = Object.freeze([
  '.delivery.json',
  '.delivery-pending.json',
  '.delivery-lock.json',
]);
const COMPARE_SIDECAR_SUFFIXES = Object.freeze(['.receipt.json']);
const DELIVERY_DIRECTORY_LOCK = '.schematics-delivery-lock.json';

type JsonRecord = Record<string, unknown>;

interface Diagnostic {
  code: string;
  severity?: string;
  message?: string;
  subject?: { path?: string; [detail: string]: unknown };
  evidence?: JsonRecord;
  supportedFixes?: string[];
  edits?: unknown[];
  [detail: string]: unknown;
}

interface ReasonLike {
  code?: string;
  [detail: string]: unknown;
}

interface RelationLike {
  status?: string;
  reason?: ReasonLike;
  recoveryFile?: string;
  recoveryDirectory?: string;
}

interface RecoveryFile {
  label?: string;
  path?: unknown;
  target?: unknown;
  [detail: string]: unknown;
}

interface RecoveryInfo {
  recoveryRequired?: boolean;
  recoveryDirectory?: string;
  recoveryFiles?: RecoveryFile[];
  rollbackErrors?: Array<string | undefined>;
  [detail: string]: unknown;
}

interface CommitDetails {
  reason?: string;
  recoveryRequired?: boolean;
  recoveryDirectory?: string;
  recoverableBackups?: unknown[];
  rollbackErrors?: Array<string | undefined>;
  [detail: string]: unknown;
}

interface DiagnosticInput {
  code: string;
  message?: string;
  subject?: Diagnostic['subject'];
  evidence?: JsonRecord;
  supportedFixes?: string[];
  edits?: unknown;
  severity?: string;
}

type PathsAlias = (left: string, right: string) => boolean;

type PathIdentityRuntime = FileBindingRuntime & {
  sameEntry?: typeof PathSemantics.sameEntry;
  error?: unknown;
};

interface SidecarBinding {
  path: string;
  identity: { device: bigint; inode: bigint };
  content: { sha256: string; bytes: number };
  mode: number;
}

interface ProvenanceInspection {
  sidecar?: SidecarBinding;
}

interface RunNodeOptions {
  cwd?: string;
  stdio?: childProcess.StdioOptions;
  maxBuffer?: number;
  env?: Record<string, string | undefined>;
}

type NodeRunResult = childProcess.SpawnSyncReturns<string> & { schematicsRawStatus?: number | null };

interface CheckerIssue {
  code: string;
  severity?: string;
  relationship?: unknown;
  nodeId?: unknown;
  detail?: unknown;
  sourceFontPx?: unknown;
  availableDiagramWidth?: unknown;
  minimumProjectedFontPx?: unknown;
  viewBoxWidth?: unknown;
  budgetBasis?: unknown;
  budgetLimit?: unknown;
}

interface CheckerReceipt {
  ok?: boolean;
  family?: string;
  diagnostics?: readonly DiagnosticInput[];
  composition?: { issues?: readonly CheckerIssue[] };
  checks?: ReadonlyArray<{ name: string; ok?: boolean; details?: string[] }>;
}

interface CompareFailureDetails {
  side?: string;
  path?: string;
  supportedFixes?: string[];
  recoveryFiles?: CompareRecoveryFile[];
  [detail: string]: unknown;
}

interface CompareFailure {
  stage: string;
  code: string;
  message: string;
  details: CompareFailureDetails;
}

interface CompareTarget {
  label: string;
  capture: AtomicOutput.CapturedAtomicOutput;
  candidate: string;
  content: DeliveryContent;
  backup: string;
  candidateBinding?: AtomicOutput.RegularFileBinding;
  candidatePresent?: boolean;
  candidateIdentity?: { dev: bigint; ino: bigint };
  candidateMode?: number;
  previousBinding?: AtomicOutput.RegularFileBinding;
  backupPresent?: boolean;
  backupVerified?: boolean;
  backupRecovery?: string;
  committedIdentity?: { dev: bigint; ino: bigint };
}

interface CompareRecoveryFile {
  backup: string | undefined;
  target: string;
  verifiedPrevious?: boolean;
}

interface ExplainerInputOptions {
  quality?: string;
  writingMode?: string;
  repoRoot?: string;
}

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError('The regular-file binding runtime is unavailable.');
  return value;
}

function contentBuffer(capture: AtomicOutput.CapturedRegularFile): Buffer {
  const buffer = capture.content.buffer;
  if (!buffer) throw new TypeError('The captured file content is unavailable.');
  return buffer;
}

function truthy<T>(value: T): value is Exclude<T, null | undefined | false | 0 | ''> {
  return Boolean(value);
}

type RequestedCapture = ReturnType<typeof AtomicOutput.captureAtomicOutput> & { requestedPath: string };

interface DeliveryFailureOptions {
  output?: string;
  stage?: string;
  input: string;
  error?: unknown;
  receiptId: string;
  pathsAlias: PathsAlias;
  ownership?: DeliveryOwnership;
  releaseOwnership?: boolean;
  legacyOutputPaths?: Array<string | undefined>;
  captureAtomicOutput?: typeof AtomicOutput.captureAtomicOutput;
  verifyAtomicOutput?: typeof AtomicOutput.verifyAtomicOutput;
  fileBindingRuntime?: FileBindingRuntime;
  recoveryDirectory?: string;
}

interface DeliveryRecord {
  ok?: boolean;
  status?: string;
  diagnostic?: Diagnostic;
  journalRecovery?: unknown;
  provenanceRecovery?: unknown;
  ownershipError?: unknown;
  lockError?: unknown;
  [detail: string]: unknown;
}

interface SchematicsFault {
  message?: string;
  cause?: unknown;
  code?: string;
  checker?: unknown;
  compareCode?: string;
  compareDetails?: CompareFailureDetails;
  compareFailure?: CompareFailure;
  compareStage?: string;
  compareStatus?: number;
  deliveryCommitDetails?: CommitDetails;
  deliveryLockOwner?: JsonRecord;
  deliveryFailureRecord?: DeliveryRecord;
  deliveryJournalRecovery?: RecoveryInfo;
  deliveryJournalRemovalState?: unknown;
  deliveryJournalState?: RelationLike;
  deliveryLockCode?: string;
  deliveryLockPath?: string;
  deliveryOwnershipCode?: string;
  deliveryOwnershipDetails?: JsonRecord;
  deliveryProvenance?: DeliveryProvenanceResult;
  deliveryProvenanceRecovery?: RecoveryInfo;
  deliveryTargetState?: RelationLike;
  details?: JsonRecord;
  diagnostics?: Diagnostic[];
  finalizeCode?: string;
  finalizeEvidence?: unknown;
  lockCleanupError?: unknown;
  schematicsArgument?: CliArgumentDetails;
  schematicsDiagnostics?: Diagnostic[];
  sidecarNamespaceReason?: ReasonLike;
  stagingCapture?: unknown;
}

type SchematicsError = Error & SchematicsFault;

interface CliArgumentDetails {
  code?: string;
  subject?: JsonRecord;
  evidence?: JsonRecord;
  supportedFixes?: string[];
}

interface ArtifactFailureReport {
  command: string;
  json?: boolean;
  stage?: string;
  type?: string;
  input?: string;
  output?: string;
  error?: unknown;
  diagnostics?: unknown[];
  status?: number;
  checker?: unknown;
  receiptId?: string;
  provenance?: unknown;
}

type DeliveryFailureReport = Omit<ArtifactFailureReport, 'command' | 'receiptId'>
  & Omit<DeliveryFailureOptions, 'receiptId'>
  & { receiptId?: string };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function isFault(value: unknown): value is SchematicsFault {
  return typeof value === 'object' && value !== null;
}

function fault(value: unknown): SchematicsFault {
  return isFault(value) ? value : {};
}

function recordOrEmpty(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

interface DeliveryContent {
  sha256: string;
  bytes: number;
}

interface OwnedDeliveryLock {
  path: string;
  identity: { dev: bigint; ino: bigint; mode: bigint };
  content?: DeliveryContent;
  descriptor?: number;
}

interface DeliveryOwnershipState {
  output: string;
  lockPath: string;
  pendingPath: string;
  provenancePath: string;
  receiptId: string;
  pid: number;
  ownedLocks: OwnedDeliveryLock[];
  fileBindingRuntime?: FileBindingRuntime;
  phase: string;
  pendingIdentity?: { dev: bigint; ino: bigint; mode: number };
  pendingContent?: DeliveryContent;
  verifyAtomicOutput?: typeof AtomicOutput.verifyAtomicOutput;
  deliveryTargets?: { artifact: DeliveryTargetCapture; provenance: DeliveryTargetCapture };
}

type DeliveryTargetCapture = AtomicOutput.CapturedAtomicOutput & { requestedPath: string };

interface DeliveryPairTarget {
  label: string;
  target: string;
  candidate: string;
  content: DeliveryContent;
  backup: string;
  capture: DeliveryTargetCapture;
  candidateBinding?: AtomicOutput.RegularFileBinding;
  candidatePresent?: boolean;
  candidateIdentity?: { dev: bigint; ino: bigint };
  candidateMode?: number;
  previousBinding?: AtomicOutput.RegularFileBinding;
  backupPresent?: boolean;
  backupVerified?: boolean;
  committedIdentity?: { dev: bigint; ino: bigint };
}

type DeliveryOwnership = object;

type CaptureResult = ReturnType<typeof AtomicOutput.captureRegularFileBinding>;

interface PublishedRegularFile {
  identity: AtomicOutput.CapturedRegularFile['identity'];
  content: AtomicOutput.CapturedRegularFile['content'];
}

const UNBOUND_FILE: AtomicOutput.RegularFileBinding = Object.freeze({});

const INVALID_FILE_IDENTITY = Object.freeze({ device: 0n, inode: 0n });

function bindingOf(capture: CaptureResult | undefined): AtomicOutput.RegularFileBinding {
  return capture?.status === 'captured' ? capture.binding : UNBOUND_FILE;
}

function requiredPath(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('A recovery path is unavailable.');
  return value;
}

interface StagingEntry {
  filePath: string;
  binding: AtomicOutput.RegularFileBinding;
  subject: string;
  expectedLinks: number;
}

interface StagingIdentity {
  device: bigint;
  inode: bigint;
}

interface OwnedEntryIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint | number;
}
type FileBindingRuntime = Partial<typeof AtomicOutput>;

let sidecarNamespaceComponentKeyRuntime: typeof PathSemantics.sidecarNamespaceComponentKey | undefined;
let boundedSidecarStem: typeof SidecarPath.boundedSidecarStem;
let isBoundedSidecarStem: typeof SidecarPath.isBoundedSidecarStem;
let sidecarStemFromComponent: typeof SidecarPath.sidecarStemFromComponent;
let sidecarStemNeedsBounding: typeof SidecarPath.sidecarStemNeedsBounding;

async function loadSidecarPathRuntime(): Promise<void> {
  ({
    boundedSidecarStem,
    isBoundedSidecarStem,
    sidecarStemFromComponent,
    sidecarStemNeedsBounding,
  } = await import('../packages/output/sidecar-path.ts'));
}

function deliverySidecarNamespace(artifactPath: string) {
  let artifact = path.resolve(artifactPath);
  try {
    artifact = fs.realpathSync.native(artifact);
  } catch (error) {
    if (fault(error).code !== 'ENOENT' && fault(error).code !== 'ENOTDIR') throw error;
  }
  if (typeof sidecarNamespaceComponentKeyRuntime !== 'function') {
    throw new Error('The sidecar namespace runtime is unavailable.');
  }
  const namespace = sidecarNamespaceComponentKeyRuntime(
    path.dirname(artifact),
    path.basename(artifact),
  );
  if (namespace.status !== 'resolved') {
    const error: SchematicsError = new Error(
      `Could not establish a stable sidecar namespace (${namespace.reason?.code || 'unknown'}).`,
    );
    error.code = 'SCHEMATICS_SIDECAR_NAMESPACE_INDETERMINATE';
    error.sidecarNamespaceReason = namespace.reason;
    throw error;
  }
  return { directory: namespace.directoryPath, ...sidecarStemFromComponent(namespace.componentKey) };
}

function deliverySidecarPath(artifactPath: string, suffix: string): string {
  const { directory, stem, options } = deliverySidecarNamespace(artifactPath);
  return path.join(
    directory,
    `${boundedSidecarStem(stem, DELIVERY_SIDECAR_SUFFIXES, options)}${suffix}`,
  );
}

function deliveryProvenancePath(artifactPath: string): string {
  return deliverySidecarPath(artifactPath, '.delivery.json');
}

function deliveryPendingPath(artifactPath: string): string {
  return deliverySidecarPath(artifactPath, '.delivery-pending.json');
}

function rawHeadDeliverySidecarPath(artifactPath: string, suffix: string): string | undefined {
  const { directory, stem, options } = deliverySidecarNamespace(artifactPath);
  if (options?.force) return undefined;
  if (sidecarStemNeedsBounding(stem, DELIVERY_SIDECAR_SUFFIXES)
    || !isBoundedSidecarStem(stem)) return undefined;
  return path.join(directory, `${stem}${suffix}`);
}

function rawHeadDeliveryProvenancePath(artifactPath: string): string | undefined {
  return rawHeadDeliverySidecarPath(artifactPath, '.delivery.json');
}

function rawHeadDeliveryPendingPath(artifactPath: string): string | undefined {
  return rawHeadDeliverySidecarPath(artifactPath, '.delivery-pending.json');
}

function legacyExtensionDeliverySidecarPath(artifactPath: string, suffix: string): string | undefined {
  let artifact = path.resolve(artifactPath);
  try {
    artifact = fs.realpathSync.native(artifact);
  } catch (error) {
    if (fault(error).code !== 'ENOENT' && fault(error).code !== 'ENOTDIR') throw error;
  }
  const component = path.basename(artifact);
  if (!/\.html$/iu.test(component) || component.endsWith('.html')) return undefined;
  const legacyComponent = `${component.slice(0, -'.html'.length)}${suffix}`;
  if (legacyComponent.length > 255 || Buffer.byteLength(legacyComponent, 'utf8') > 255) {
    return undefined;
  }
  return path.join(path.dirname(artifact), legacyComponent);
}

function canonicalExistingDeliveryOutput(outputPath: string): string {
  const output = path.resolve(outputPath);
  try {
    return fs.realpathSync.native(output);
  } catch (error) {
    if (fault(error).code === 'ENOENT' || fault(error).code === 'ENOTDIR') return output;
    throw error;
  }
}

function legacyDeliveryLockPath(artifactPath: string): string {
  const artifact = path.resolve(artifactPath);
  return `${artifact.replace(/\.html?$/i, '')}.delivery-lock.json`;
}

function legacyDeliveryLockPaths(artifactPaths: readonly string[]): string[] {
  const paths: string[] = [];
  for (const artifactPath of artifactPaths) {
    const lockPath = legacyDeliveryLockPath(artifactPath);
    const name = path.basename(lockPath);
    const canExist = process.platform === 'win32'
      ? name.length <= 255
      : Buffer.byteLength(name, 'utf8') <= 255;
    if (canExist && !paths.includes(lockPath)) paths.push(lockPath);
  }
  return paths;
}

function deliveryLockPath(artifactPath: string): string {
  // A directory-wide mutex is deliberately conservative. Future 8.3, case,
  // and Unicode aliases cannot be assigned a sound canonical filename before
  // the artifact exists, so a per-artifact lock can split one delivery into
  // multiple owners. Provenance and pending journals remain artifact-specific.
  const artifact = path.resolve(artifactPath);
  let directory;
  try {
    directory = path.dirname(fs.realpathSync.native(artifact));
  } catch (error) {
    if (fault(error).code !== 'ENOENT' && fault(error).code !== 'ENOTDIR') throw error;
    const authoredDirectory = path.dirname(artifact);
    try {
      directory = fs.realpathSync.native(authoredDirectory);
    } catch (directoryError) {
      if (fault(directoryError).code !== 'ENOENT' && fault(directoryError).code !== 'ENOTDIR') throw directoryError;
      directory = authoredDirectory;
    }
  }
  return path.join(directory, DELIVERY_DIRECTORY_LOCK);
}

function deliveryLockInvalid(lockPath: string): Error {
  return Object.assign(new Error(`Unrecognized delivery lock at "${lockPath}"; inspect the existing entry before retrying.`), {
    deliveryLockCode: 'delivery/lock-invalid',
    deliveryLockPath: lockPath,
  });
}

function regularDeliveryLockExists(lockPath: string): boolean {
  try {
    if (!fs.lstatSync(lockPath).isFile()) throw deliveryLockInvalid(lockPath);
    return true;
  } catch (error) {
    if (fault(error).deliveryLockCode) throw error;
    if (fault(error).code === 'ENOENT' || fault(error).code === 'ENOTDIR') return false;
    throw deliveryLockInvalid(lockPath);
  }
}

function rejectExistingDeliveryLock(lockPath: string, output: string, fileBindingRuntime: FileBindingRuntime | undefined): never {
  const {
    captureRegularFileBinding,
    releaseRegularFileBinding,
  } = fileBindingRuntime || {};
  let lock: { schemaVersion?: unknown; pid: number; receiptId: string };
  let captured: ReturnType<typeof AtomicOutput.captureRegularFileBinding> | undefined;
  try {
    if (typeof captureRegularFileBinding !== 'function'
      || typeof releaseRegularFileBinding !== 'function') {
      throw new Error('The regular-file binding runtime is unavailable.');
    }
    captured = captureRegularFileBinding(lockPath, {
      subject: 'delivery-lock',
      expectedLinks: 1,
      includeContent: true,
    });
    if (captured.status !== 'captured') throw new Error('Not a stable regular lock file.');
    lock = JSON.parse(String(captured.content.buffer?.toString('utf8')));
    if (lock?.schemaVersion !== 1 || !Number.isSafeInteger(lock.pid) || lock.pid <= 0
      || typeof lock.receiptId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lock.receiptId)) {
      throw new Error('Unrecognized delivery lock.');
    }
  } catch {
    throw deliveryLockInvalid(lockPath);
  } finally {
    if (captured?.status === 'captured') releaseRegularFileBinding?.(captured.binding);
  }
  if (processIsRunning(lock.pid)) {
    throw Object.assign(new Error(`Another delivery attempt owns "${output}" through lock "${lockPath}".`), {
      deliveryLockCode: 'delivery/concurrent-attempt',
      deliveryLockPath: lockPath,
    });
  }
  throw Object.assign(new Error(`A stale delivery lock remains at "${lockPath}"; recover it serially before retrying.`), {
    deliveryLockCode: 'delivery/lock-stale',
    deliveryLockPath: lockPath,
    deliveryLockOwner: { pid: lock.pid, receiptId: lock.receiptId },
  });
}

function processIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fault(error).code !== 'ESRCH';
  }
}

const deliveryOwnershipStates = new WeakMap<DeliveryOwnership, DeliveryOwnershipState>();

function deliveryOwnershipFailure(state: DeliveryOwnershipState | undefined, operation: string, reason: string, evidence: JsonRecord = {}): SchematicsError {
  const error: SchematicsError = new Error(`Delivery ownership was lost while attempting to ${operation}: ${reason}`);
  error.deliveryOwnershipCode = 'delivery/ownership-lost';
  error.deliveryOwnershipDetails = {
    operation,
    lock: state?.lockPath,
    expectedReceiptId: state?.receiptId,
    reason,
    ...evidence,
  };
  if (state && state.phase !== 'released') state.phase = 'lost';
  return error;
}

function deliveryOwnershipState(ownership: DeliveryOwnership, operation: string): DeliveryOwnershipState {
  const state = deliveryOwnershipStates.get(ownership);
  if (!state) throw deliveryOwnershipFailure(undefined, operation, 'the ownership capability is invalid');
  if (state.phase === 'lost' || state.phase === 'released') {
    throw deliveryOwnershipFailure(state, operation, `the capability is already ${state.phase}`);
  }
  return state;
}

interface ComparableIdentity {
  dev: bigint | number;
  ino: bigint | number;
}

function sameFileIdentity(actual: ComparableIdentity | undefined, expected: ComparableIdentity | undefined): boolean {
  const hasIdentity = (entry: ComparableIdentity | undefined): entry is ComparableIdentity => entry?.ino !== undefined && entry.ino !== 0 && entry.ino !== 0n;
  return hasIdentity(actual)
    && hasIdentity(expected)
    && actual.dev === expected.dev
    && actual.ino === expected.ino;
}

function assertOwnedDeliveryLock(
  state: DeliveryOwnershipState,
  ownedLock: OwnedDeliveryLock,
  operation: string,
  { verifyReceipt = true }: { verifyReceipt?: boolean } = {},
): void {
  const {
    captureRegularFileBinding,
    releaseRegularFileBinding,
  } = state?.fileBindingRuntime || {};
  let captured: ReturnType<typeof AtomicOutput.captureRegularFileBinding>;
  try {
    if (typeof captureRegularFileBinding !== 'function'
      || typeof releaseRegularFileBinding !== 'function') {
      throw new Error('The regular-file binding runtime is unavailable.');
    }
    captured = captureRegularFileBinding(ownedLock.path, {
      subject: 'owned-delivery-lock',
      ...(ownedLock.content ? {
        expectedSha256: ownedLock.content.sha256,
        expectedBytes: ownedLock.content.bytes,
      } : {}),
      expectedMode: Number(ownedLock.identity.mode & 0o777n),
      expectedLinks: 1,
      includeContent: verifyReceipt,
    });
  } catch (error) {
    throw deliveryOwnershipFailure(state, operation, 'an owned lock entry can no longer be inspected', {
      lock: ownedLock.path,
      ...(fault(error).code ? { systemCode: fault(error).code } : {}),
    });
  }
  if (captured.status !== 'captured'
    || captured.identity.device !== ownedLock.identity.dev
    || captured.identity.inode !== ownedLock.identity.ino) {
    if (captured.status === 'captured') releaseRegularFileBinding?.(captured.binding);
    throw deliveryOwnershipFailure(state, operation, 'an owned lock path no longer names the entry created by this attempt', {
      lock: ownedLock.path,
      ...(captured.status !== 'captured' && captured.reason ? { lockState: captured.reason } : {}),
    });
  }
  try {
    if (!verifyReceipt) return;
    let lock;
    try {
      lock = JSON.parse(String(captured.content.buffer?.toString('utf8')));
    } catch (error) {
      throw deliveryOwnershipFailure(state, operation, 'an owned lock receipt can no longer be verified', {
        lock: ownedLock.path,
        ...(fault(error).code ? { systemCode: fault(error).code } : {}),
      });
    }
    if (lock?.schemaVersion !== 1 || lock.receiptId !== state.receiptId || lock.pid !== state.pid) {
      throw deliveryOwnershipFailure(state, operation, 'an owned lock receipt no longer matches this attempt', {
        lock: ownedLock.path,
        ...(typeof lock?.receiptId === 'string' ? { observedReceiptId: lock.receiptId } : {}),
      });
    }
  } catch (error) {
    throw error;
  } finally {
    releaseRegularFileBinding?.(captured.binding);
  }
}

function assertDeliveryOwnership(
  ownership: DeliveryOwnership,
  operation: string,
  { allowInitializing = false, pending = 'ignore' }: { allowInitializing?: boolean; pending?: string } = {},
): DeliveryOwnershipState {
  const state = deliveryOwnershipState(ownership, operation);
  const verifyReceipt = !allowInitializing || !['acquiring', 'initializing'].includes(state.phase);
  for (const ownedLock of state.ownedLocks) {
    assertOwnedDeliveryLock(state, ownedLock, operation, { verifyReceipt });
  }
  if (pending !== 'ignore') {
    const pendingPath = state.pendingPath;
    if (pending === 'absent') {
      try {
        fs.lstatSync(pendingPath);
      } catch (error) {
        if (fault(error).code === 'ENOENT') return state;
        throw deliveryOwnershipFailure(state, operation, 'the finalized delivery journal can no longer be inspected', {
          journal: pendingPath,
          ...(fault(error).code ? { systemCode: fault(error).code } : {}),
        });
      }
      throw deliveryOwnershipFailure(state, operation, 'the finalized delivery journal was recreated', { journal: pendingPath });
    }
    const {
      captureRegularFileBinding,
      releaseRegularFileBinding,
    } = state.fileBindingRuntime || {};
    let captured: ReturnType<typeof AtomicOutput.captureRegularFileBinding>;
    try {
      if (typeof captureRegularFileBinding !== 'function'
        || typeof releaseRegularFileBinding !== 'function') {
        throw new Error('The regular-file binding runtime is unavailable.');
      }
      captured = captureRegularFileBinding(pendingPath, {
        subject: 'owned-delivery-journal',
        expectedSha256: state.pendingContent?.sha256,
        expectedBytes: state.pendingContent?.bytes,
        expectedMode: state.pendingIdentity?.mode,
        expectedLinks: 1,
        includeContent: pending === 'owned',
      });
    } catch (error) {
      throw deliveryOwnershipFailure(state, operation, 'the owned delivery journal can no longer be inspected', {
        journal: pendingPath,
        ...(fault(error).code ? { systemCode: fault(error).code } : {}),
      });
    }
    if (captured.status !== 'captured'
      || !state.pendingIdentity
      || captured.identity.device !== state.pendingIdentity.dev
      || captured.identity.inode !== state.pendingIdentity.ino) {
      if (captured.status === 'captured') releaseRegularFileBinding?.(captured.binding);
      throw deliveryOwnershipFailure(state, operation, 'the delivery journal no longer names the entry created by this attempt', {
        journal: pendingPath,
        ...(captured.status !== 'captured' && captured.reason ? { journalState: captured.reason } : {}),
      });
    }
    try {
      if (pending === 'owned') {
        let journal;
        try {
          journal = JSON.parse(String(captured.content.buffer?.toString('utf8')));
        } catch {
          throw deliveryOwnershipFailure(state, operation, 'the delivery journal receipt is malformed', {
            journal: pendingPath,
          });
        }
        if (journal?.receiptId !== state.receiptId) {
          throw deliveryOwnershipFailure(state, operation, 'the delivery journal receipt belongs to another attempt', {
            journal: pendingPath,
            ...(typeof journal?.receiptId === 'string' ? { observedReceiptId: journal.receiptId } : {}),
          });
        }
      }
    } finally {
      releaseRegularFileBinding?.(captured.binding);
    }
  }
  return state;
}

function quarantineRemoveOwnedDeliveryEntry(state: DeliveryOwnershipState, {
  filePath,
  identity,
  content,
  subject,
  operation,
  evidenceKey,
}: {
  filePath: string;
  identity: OwnedEntryIdentity | undefined;
  content: DeliveryContent | undefined;
  subject: string;
  operation: string;
  evidenceKey: string;
}): void {
  const {
    captureRegularFileBinding,
    quarantineRemoveRegularFileBinding,
    releaseRegularFileBinding,
  } = state?.fileBindingRuntime || {};
  let captured: ReturnType<typeof AtomicOutput.captureRegularFileBinding>;
  try {
    if (typeof captureRegularFileBinding !== 'function'
      || typeof quarantineRemoveRegularFileBinding !== 'function'
      || typeof releaseRegularFileBinding !== 'function') {
      throw new Error('The regular-file binding runtime is unavailable.');
    }
    captured = captureRegularFileBinding(filePath, {
      subject,
      ...(content ? {
        expectedSha256: content.sha256,
        expectedBytes: content.bytes,
      } : {}),
      expectedMode: typeof identity?.mode === 'bigint'
        ? Number(identity.mode & 0o777n)
        : identity?.mode,
      expectedIdentity: identity ? {
        device: identity.dev,
        inode: identity.ino,
      } : INVALID_FILE_IDENTITY,
      expectedLinks: 1,
    });
  } catch (error) {
    throw deliveryOwnershipFailure(state, operation, `the owned ${subject} can no longer be captured for removal`, {
      [evidenceKey]: filePath,
      ...(fault(error).code ? { systemCode: fault(error).code } : {}),
    });
  }
  if (captured.status !== 'captured') {
    throw deliveryOwnershipFailure(state, operation, `the owned ${subject} changed before removal`, {
      [evidenceKey]: filePath,
      entryState: captured.reason,
    });
  }
  try {
    if (!quarantineRemoveRegularFileBinding) throw new Error('The regular-file binding runtime is unavailable.');
    const removed = quarantineRemoveRegularFileBinding(captured.binding, filePath, {
      subject,
      expectedLinks: 1,
    });
    if (removed.status === 'removed') return;
    const removalCode = removed.reason?.code;
    if (removed.status === 'unknown'
      && ['removal-quarantine-create-failed', `${subject}-quarantine-move-failed`]
        .includes(removalCode)) {
      const detail = removed.reason?.message ? `: ${removed.reason.message}` : '';
      const error: SchematicsError = new Error(`The owned ${subject} could not be moved into its private removal quarantine (${removalCode})${detail}.`);
      if (removed.reason?.systemCode) error.code = String(removed.reason.systemCode);
      if (subject === 'delivery-lock') {
        error.deliveryOwnershipCode = 'delivery/lock-release';
        error.deliveryOwnershipDetails = {
          operation,
          lock: filePath,
          reason: error.message,
          entryState: removed.reason,
        };
      } else {
        error.deliveryJournalRemovalState = removed;
      }
      throw error;
    }
    throw deliveryOwnershipFailure(
      state,
      operation,
      removed.status === 'recovery-required'
        ? `a replacement ${subject} could not be restored from quarantine`
        : `the public ${subject} changed during removal and was preserved`,
      {
        [evidenceKey]: filePath,
        entryState: removed.reason,
        ...(removed.status === 'recovery-required' ? {
          recoveryRequired: true,
          recoveryDirectory: removed.recoveryDirectory,
          recoveryFiles: [{
            label: `preserved replacement ${subject}`,
            path: removed.recoveryFile,
            target: filePath,
          }],
        } : {}),
      },
    );
  } finally {
    releaseRegularFileBinding?.(captured.binding);
  }
}

function releaseDeliveryOwnership(ownership: DeliveryOwnership, { allowInitializing = false }: { allowInitializing?: boolean } = {}): void {
  const current = deliveryOwnershipState(ownership, 'release the delivery lock');
  const pending = current.phase === 'finalized'
    ? 'absent'
    : current.pendingIdentity
      ? 'identity'
      : 'ignore';
  const state = assertDeliveryOwnership(ownership, 'release the delivery lock', { allowInitializing, pending });
  const verifyReceipt = !allowInitializing || !['acquiring', 'initializing'].includes(state.phase);
  for (const ownedLock of state.ownedLocks) {
    assertOwnedDeliveryLock(state, ownedLock, 'release the delivery lock', { verifyReceipt });
    quarantineRemoveOwnedDeliveryEntry(state, {
      filePath: ownedLock.path,
      identity: ownedLock.identity,
      content: ownedLock.content,
      subject: 'delivery-lock',
      operation: 'release the delivery lock',
      evidenceKey: 'lock',
    });
  }
  state.phase = 'released';
}

function acquireDeliveryLock(
  output: string,
  receiptId: string,
  inputPath: string,
  pathsAlias: (left: string, right: string) => boolean,
  recordInitializationFailure: ((error: unknown, ownership: DeliveryOwnership) => DeliveryRecord | undefined) | undefined,
  legacyOutputPaths: ReadonlyArray<string | undefined> = [],
  fileBindingRuntime?: FileBindingRuntime,
): DeliveryOwnership {
  const stableOutput = canonicalExistingDeliveryOutput(output);
  const lockPath = deliveryLockPath(stableOutput);
  const comparableLockPath = (candidate: string) => {
    const absolute = path.resolve(candidate);
    try {
      return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
    } catch (error) {
      if (fault(error).code !== 'ENOENT' && fault(error).code !== 'ENOTDIR') throw error;
      return absolute;
    }
  };
  const lockPathsAlias = (left: string, right: string) => {
    const comparableLeft = comparableLockPath(left);
    const comparableRight = comparableLockPath(right);
    if (!pathsAlias(path.dirname(comparableLeft), path.dirname(comparableRight))) return false;
    return pathsAlias(comparableLeft, comparableRight);
  };
  const legacyFencePathsAlias = (left: string, right: string) => {
    const comparableLeft = comparableLockPath(left);
    const comparableRight = comparableLockPath(right);
    if (comparableLeft === comparableRight) return true;
    try {
      return lockPathsAlias(comparableLeft, comparableRight);
    } catch {
      // An indeterminate future-name relation is not evidence of aliasing.
      // Keep both candidates; an EEXIST below is accepted only when dev/ino
      // proves that it names a lock already created by this attempt.
      return false;
    }
  };
  const legacyLockPaths: string[] = [];
  for (const candidate of legacyDeliveryLockPaths([
    ...legacyOutputPaths.filter((candidate): candidate is string => Boolean(candidate)),
    output,
    stableOutput,
  ])) {
    if (!legacyLockPaths.some((existing) => legacyFencePathsAlias(candidate, existing))) {
      legacyLockPaths.push(candidate);
    }
  }
  const pendingPath = deliveryPendingPath(stableOutput);
  const provenancePath = deliveryProvenancePath(stableOutput);
  const rawHeadPendingPath = rawHeadDeliveryPendingPath(stableOutput);
  const existingLegacyLocks = legacyLockPaths.filter((candidate) => regularDeliveryLockExists(candidate));
  regularDeliveryLockExists(lockPath);
  const conflictingLockPath = [lockPath, ...legacyLockPaths]
    .find((candidate) => lockPathsAlias(candidate, inputPath));
  if (conflictingLockPath) {
    throw Object.assign(new Error('Delivery lock path aliases the input specification; choose another output path.'), {
      deliveryLockCode: 'delivery/lock-path-conflict',
      deliveryLockPath: conflictingLockPath,
    });
  }
  const [existingLegacyLock] = existingLegacyLocks;
  if (existingLegacyLock !== undefined) {
    rejectExistingDeliveryLock(existingLegacyLock, output, fileBindingRuntime);
  }
  const openedLocks: OwnedDeliveryLock[] = [];
  const ownership = Object.freeze({});
  const acquiredState: DeliveryOwnershipState = {
    output: stableOutput,
    lockPath,
    pendingPath,
    provenancePath,
    receiptId,
    pid: process.pid,
    ownedLocks: openedLocks,
    fileBindingRuntime,
    phase: 'acquiring',
  };
  deliveryOwnershipStates.set(ownership, acquiredState);
  let collisionPath: string | undefined;
  try {
    const openOwnedLock = (ownedLockPath: string, { allowOwnedAlias = false }: { allowOwnedAlias?: boolean } = {}) => {
      let descriptor: number;
      try {
        descriptor = fs.openSync(ownedLockPath, 'wx', 0o600);
      } catch (error) {
        if (fault(error).code === 'EEXIST' && allowOwnedAlias) {
          try {
            const existingEntry = fs.lstatSync(ownedLockPath, { bigint: true });
            if (existingEntry.isFile()
              && openedLocks.some((ownedLock) => sameFileIdentity(existingEntry, ownedLock.identity))) {
              return undefined;
            }
          } catch {
            // Preserve the original EEXIST classification below.
          }
        }
        if (fault(error).code === 'EEXIST') collisionPath = ownedLockPath;
        throw error;
      }
      let handleIdentity: fs.BigIntStats;
      let handleIdentityError: unknown;
      try {
        handleIdentity = fs.fstatSync(descriptor, { bigint: true });
      } catch (error) {
        // A transient first inspection failure must not strand the public
        // lock. Bind ownership from the still-open handle before cleanup.
        try {
          handleIdentity = fs.fstatSync(descriptor, { bigint: true });
        } catch {
          // Both handle metadata reads failed. Stamp the still-open inode with
          // this attempt's unpredictable receipt before consulting the public
          // path. A replacement claimant cannot be mistaken for our empty
          // lock, while a successful content-bound capture gives cleanup the
          // identity it needs after the original descriptor is closed.
          const recoveryReceipt = `${JSON.stringify({ schemaVersion: 1, receiptId, pid: process.pid })}\n`;
          const recoveryContent = artifactIdentity(Buffer.from(recoveryReceipt));
          let captured: ReturnType<typeof AtomicOutput.captureRegularFileBinding> | undefined;
          try {
            fs.writeFileSync(descriptor, recoveryReceipt);
            captured = fileBindingRuntime?.captureRegularFileBinding?.(ownedLockPath, {
              subject: 'owned-delivery-lock',
              expectedSha256: recoveryContent.sha256,
              expectedBytes: recoveryContent.bytes,
              expectedLinks: 1,
            });
          } catch {}
          if (captured?.status === 'captured') {
            fileBindingRuntime?.releaseRegularFileBinding?.(captured.binding);
            openedLocks.push({
              path: ownedLockPath,
              identity: {
                dev: captured.identity.device,
                ino: captured.identity.inode,
                mode: BigInt(captured.mode),
              },
              content: recoveryContent,
              descriptor,
            });
          } else {
            try {
              fs.closeSync(descriptor);
            } catch (closeError) {
              fault(error).lockCleanupError = fault(closeError).message;
            }
          }
          throw error;
        }
        handleIdentityError = error;
      }
      const ownedLock: OwnedDeliveryLock = {
        path: ownedLockPath,
        identity: handleIdentity,
        descriptor,
      };
      openedLocks.push(ownedLock);
      const pathIdentity = fs.lstatSync(ownedLockPath, { bigint: true });
      if (!handleIdentity.isFile()
        || handleIdentity.ino === 0n
        || !pathIdentity.isFile()
        || pathIdentity.isSymbolicLink()
        || pathIdentity.ino === 0n
        || !sameFileIdentity(pathIdentity, handleIdentity)) {
        throw new Error('Delivery lock path identity could not be verified safely.');
      }
      if (handleIdentityError) throw handleIdentityError;
      return ownedLock;
    };

    openOwnedLock(lockPath);
    for (const legacyLockPath of legacyLockPaths) {
      openOwnedLock(legacyLockPath, { allowOwnedAlias: true });
    }
    const state = acquiredState;
    if (rawHeadPendingPath && pathEntryExists(rawHeadPendingPath)) {
      throw Object.assign(new Error(`A pre-namespace delivery journal remains at "${rawHeadPendingPath}"; recover it before retrying.`), {
        deliveryLockCode: 'delivery/legacy-pending',
        deliveryLockPath: rawHeadPendingPath,
      });
    }
    state.phase = 'initializing';
    const lockReceipt = `${JSON.stringify({ schemaVersion: 1, receiptId, pid: process.pid })}\n`;
    const lockContent = artifactIdentity(Buffer.from(lockReceipt));
    for (const ownedLock of openedLocks) {
      fs.writeFileSync(ownedDescriptor(ownedLock), lockReceipt);
      ownedLock.content = lockContent;
    }
    for (const ownedLock of openedLocks) {
      fs.closeSync(ownedDescriptor(ownedLock));
      ownedLock.descriptor = undefined;
    }
    state.phase = 'owned';
    return ownership;
  } catch (error) {
    for (const ownedLock of openedLocks) {
      if (ownedLock.descriptor === undefined) continue;
      try {
        fs.closeSync(ownedLock.descriptor);
        ownedLock.descriptor = undefined;
      } catch (closeError) {
        fault(error).lockCleanupError = fault(closeError).message;
      }
    }
    const state = acquiredState;
    let preserveOwnership = false;
    try {
      if (state.phase === 'initializing') {
        assertDeliveryOwnership(ownership, 'record a lock initialization failure', { allowInitializing: true });
        fault(error).deliveryFailureRecord = recordInitializationFailure?.(error, ownership);
        const journalRecovery = fault(error).deliveryFailureRecord?.journalRecovery;
        if (journalRecovery) {
          fault(error).deliveryJournalRecovery = fault(journalRecovery).deliveryJournalRecovery;
          preserveOwnership = true;
        }
        const provenanceRecovery = fault(error).deliveryFailureRecord?.provenanceRecovery;
        if (provenanceRecovery) {
          fault(error).deliveryProvenanceRecovery = fault(provenanceRecovery).deliveryProvenanceRecovery;
          preserveOwnership = true;
        }
      }
      if (!preserveOwnership) {
        releaseDeliveryOwnership(ownership, { allowInitializing: true });
      }
    } catch (cleanupError) {
      if (fault(cleanupError).deliveryOwnershipCode) {
        fault(cleanupError).deliveryOwnershipDetails = {
          ...recordOrEmpty(fault(cleanupError).deliveryOwnershipDetails),
          initializationError: fault(error).message,
          ...(fault(error).code ? { initializationSystemCode: fault(error).code } : {}),
        };
        if (fault(cleanupError).deliveryOwnershipCode === 'delivery/lock-release' && fault(error).deliveryFailureRecord) {
          fault(cleanupError).deliveryFailureRecord = fault(error).deliveryFailureRecord;
        }
        throw cleanupError;
      }
      fault(error).lockCleanupError = fault(cleanupError).message;
    }
    if (collisionPath) rejectExistingDeliveryLock(collisionPath, output, fileBindingRuntime);
    throw error;
  }
}

function ownedDescriptor(ownedLock: OwnedDeliveryLock): number {
  if (ownedLock.descriptor === undefined) throw new Error('Delivery lock descriptor is already closed.');
  return ownedLock.descriptor;
}

function pathEntryExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (fault(error).code === 'ENOENT' || fault(error).code === 'ENOTDIR') return false;
    throw error;
  }
}

function captureOwnedStagingFile(registry: StagingEntry[], filePath: string, fileBindingRuntime: FileBindingRuntime | undefined, {
  subject = 'private-staging-entry',
  content,
  expectedLinks = 1,
}: { subject?: string; content?: DeliveryContent; expectedLinks?: number } = {}): AtomicOutput.CapturedRegularFile {
  const { captureRegularFileBinding } = fileBindingRuntime || {};
  if (typeof captureRegularFileBinding !== 'function') {
    throw new Error('The regular-file binding runtime is unavailable.');
  }
  let captured = captureRegularFileBinding(filePath, {
    subject,
    ...(content ? {
      expectedSha256: content.sha256,
      expectedBytes: content.bytes,
    } : {}),
    expectedLinks,
  });
  if (captured.status === 'unsupported'
    && String(captured.reason?.code || '').endsWith('-hardlinked')
    && content) {
    const observedLinks = Number(captured.reason.links);
    if (Number.isSafeInteger(observedLinks) && observedLinks > expectedLinks) {
      captured = captureRegularFileBinding(filePath, {
        subject,
        expectedSha256: content.sha256,
        expectedBytes: content.bytes,
        expectedLinks: observedLinks,
      });
      expectedLinks = observedLinks;
    }
  }
  if (captured.status !== 'captured') {
    const error: SchematicsError = new Error(`Could not bind the owned staging entry "${filePath}" (${captured.reason?.code || 'unknown state'}).`);
    error.stagingCapture = captured;
    throw error;
  }
  registry.push({ filePath, binding: captured.binding, subject, expectedLinks });
  return captured;
}

function cleanupOwnedStagingDirectory(
  directory: string,
  identity: StagingIdentity,
  registry: StagingEntry[],
  fileBindingRuntime: FileBindingRuntime | undefined,
): void {
  const {
    quarantineRemoveRegularFileBinding,
    releaseRegularFileBinding,
  } = fileBindingRuntime || {};
  if (typeof quarantineRemoveRegularFileBinding !== 'function'
    || typeof releaseRegularFileBinding !== 'function') {
    throw new Error('The regular-file binding runtime is unavailable.');
  }
  const failures: string[] = [];
  for (const entry of [...registry].reverse()) {
    try {
      const removed = quarantineRemoveRegularFileBinding(entry.binding, entry.filePath, {
        subject: entry.subject,
        expectedLinks: entry.expectedLinks,
      });
      // A missing path means the transaction already moved or finalized this
      // owned inode. Every other non-removal result is deliberately preserved:
      // it may be a concurrent claimant rather than an entry we created.
      if (removed.status !== 'removed'
        && !['ENOENT', 'ENOTDIR'].includes(String(removed.reason?.systemCode))) {
        failures.push(`${entry.filePath}: ${removed.reason?.code || removed.status}`);
      }
    } catch (error) {
      failures.push(`${entry.filePath}: ${fault(error).message}`);
    } finally {
      const released = releaseRegularFileBinding(entry.binding);
      if (released.status !== 'released') {
        failures.push(`${entry.filePath}: ${released.reason?.code || released.status}`);
      }
    }
  }
  registry.length = 0;
  try {
    if (!removeOwnedEmptyStagingDirectory(directory, identity, { throwOnFailure: true })) {
      failures.push(`${directory}: staging directory was retained because its identity changed`);
    }
  } catch (error) {
    failures.push(`${directory}: ${fault(error).message}`);
  }
  if (failures.length) throw new Error(failures.join('; '));
}

function createOwnedEmptyStagingDirectory(prefix: string): { directory: string; identity: StagingIdentity } {
  // Node's Windows mkdtemp binding does not consistently promote an ordinary
  // UNC prefix past MAX_PATH. Use the equivalent namespaced spelling for the
  // syscall while preserving the same physical directory identity.
  const directory = fs.mkdtempSync(path.toNamespacedPath(prefix));
  const metadata = fs.lstatSync(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.ino === 0n) {
    throw new Error(`Private staging directory identity is unavailable: ${directory}`);
  }
  return {
    directory,
    identity: { device: metadata.dev, inode: metadata.ino },
  };
}

function createStagingRetirementQuarantine(parent: string): string | undefined {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const directory = path.join(parent, `.schematics-staging-remove-${crypto.randomUUID()}`);
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      return directory;
    } catch (error) {
      if (fault(error).code !== 'EEXIST') return undefined;
    }
  }
  return undefined;
}

const stagingRemovalSignal = new Int32Array(new SharedArrayBuffer(4));
const stagingRemovalAttempts = 10;

function removeEmptyStagingDirectoryWithRetry(directory: string): void {
  let failure: unknown;
  for (let attempt = 0; attempt < stagingRemovalAttempts; attempt += 1) {
    try {
      fs.rmdirSync(directory);
      return;
    } catch (error) {
      failure = error;
      // SMB can acknowledge the last file removal before the directory view
      // catches up. Retrying an empty-directory removal is claimant-safe: any
      // real entry keeps returning ENOTEMPTY and is never removed recursively.
      if (fault(error).code !== 'ENOTEMPTY' || attempt === stagingRemovalAttempts - 1) break;
      Atomics.wait(
        stagingRemovalSignal,
        0,
        0,
        Math.min(5 * (2 ** attempt), 250),
      );
    }
  }
  throw failure;
}

function stagingDirectoryAppearsEmpty(directory: string): boolean {
  for (let attempt = 0; attempt < stagingRemovalAttempts; attempt += 1) {
    try {
      if (fs.readdirSync(directory).length === 0) return true;
    } catch {
      return false;
    }
    if (attempt === stagingRemovalAttempts - 1) break;
    Atomics.wait(
      stagingRemovalSignal,
      0,
      0,
      Math.min(5 * (2 ** attempt), 250),
    );
  }
  return false;
}

function removeOwnedEmptyStagingDirectory(
  directory: string,
  identity: StagingIdentity,
  { throwOnFailure = false }: { throwOnFailure?: boolean } = {},
): boolean {
  let current: fs.BigIntStats;
  try {
    current = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    if (fault(error).code === 'ENOENT' || fault(error).code === 'ENOTDIR') return false;
    throw error;
  }
  if (!current.isDirectory()
    || current.isSymbolicLink()
    || current.ino === 0n
    || current.dev !== identity.device
    || current.ino !== identity.inode) return false;
  if (!stagingDirectoryAppearsEmpty(directory)) return false;
  const quarantine = createStagingRetirementQuarantine(path.dirname(directory));
  if (!quarantine) return false;
  const movedPath = path.join(quarantine, path.basename(directory));
  try {
    fs.renameSync(directory, movedPath);
  } catch (error) {
    if (throwOnFailure) throw error;
    return false;
  }
  let moved: fs.BigIntStats;
  try {
    moved = fs.lstatSync(movedPath, { bigint: true });
  } catch {
    return false;
  }
  if (!moved.isDirectory()
    || moved.isSymbolicLink()
    || moved.ino === 0n
    || moved.dev !== identity.device
    || moved.ino !== identity.inode) {
    // A claimant won the public move boundary. Preserve it under the private
    // quarantine name; directories have no portable no-clobber restore link.
    return false;
  }
  try {
    // The unpredictable 0700 quarantine closes the public replacement race.
    // Never recurse: unexpected contents remain available for recovery.
    removeEmptyStagingDirectoryWithRetry(movedPath);
    removeEmptyStagingDirectoryWithRetry(quarantine);
    return true;
  } catch (error) {
    if (throwOnFailure) throw error;
    return false;
  }
}

function releaseOwnedStagingBindings(registry: StagingEntry[], fileBindingRuntime: FileBindingRuntime | undefined): void {
  const { releaseRegularFileBinding } = fileBindingRuntime || {};
  if (typeof releaseRegularFileBinding !== 'function') return;
  for (const entry of registry) releaseRegularFileBinding(entry.binding);
  registry.length = 0;
}

function artifactIdentity(artifact: Buffer | Uint8Array): DeliveryContent {
  return { sha256: new Bun.CryptoHasher('sha256').update(artifact).digest('hex'), bytes: artifact.byteLength };
}

function beginDeliveryAttempt({ ownership, input, pathsAlias, fileBindingRuntime }: {
  ownership: DeliveryOwnership;
  input: string;
  pathsAlias: (left: string, right: string) => boolean;
  fileBindingRuntime?: FileBindingRuntime;
}): void {
  const state = assertDeliveryOwnership(ownership, 'begin the delivery journal', { allowInitializing: true });
  const {
    output, pendingPath: journal, provenancePath, receiptId,
  } = state;
  for (const protectedPath of [input, output, provenancePath].filter((entry): entry is string => Boolean(entry))) {
    if (pathsAlias(journal, protectedPath)) throw new Error('Delivery journal aliases an input or output.');
  }
  const published = writeDeliveryProvenance(journal, {
    schemaVersion: 1, command: 'deliver', status: 'pending', receiptId,
    input, output: path.resolve(output),
  }, {
    beforeReplace: () => assertDeliveryOwnership(ownership, 'create the delivery journal', { allowInitializing: true }),
    fileBindingRuntime,
  });
  state.pendingIdentity = {
    dev: published.identity.device,
    ino: published.identity.inode,
    mode: published.identity.mode,
  };
  state.pendingContent = published.content;
  assertDeliveryOwnership(ownership, 'finish creating the delivery journal', { allowInitializing: true });
}

function writeDeliveryProvenance(file: string, value: unknown, { beforeReplace, fileBindingRuntime }: {
  beforeReplace?: () => unknown;
  fileBindingRuntime?: FileBindingRuntime;
} = {}): PublishedRegularFile {
  const {
    backupPublicRegularFileBinding,
    captureRegularFileBinding,
    quarantineRemoveRegularFileBinding,
    verifyRegularFileBinding,
    releaseRegularFileBinding,
  } = fileBindingRuntime || {};
  if (typeof captureRegularFileBinding !== 'function'
    || typeof backupPublicRegularFileBinding !== 'function'
    || typeof quarantineRemoveRegularFileBinding !== 'function'
    || typeof verifyRegularFileBinding !== 'function'
    || typeof releaseRegularFileBinding !== 'function') {
    const error: SchematicsError = new Error('The regular-file binding runtime is unavailable.');
    error.deliveryJournalState = {
      status: 'unknown',
      reason: { code: 'atomic-output-runtime-unavailable' },
    };
    throw error;
  }
  const staging = createOwnedEmptyStagingDirectory(
    path.join(path.dirname(file), '.schematics-provenance-'),
  );
  const stagingDirectory = staging.directory;
  const temporary = path.join(stagingDirectory, path.basename(file));
  const backup = path.join(stagingDirectory, '.previous-journal');
  const serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const expectedContent = artifactIdentity(serialized);
  let candidateCapture: ReturnType<typeof AtomicOutput.captureRegularFileBinding> | undefined;
  let previousCapture: ReturnType<typeof AtomicOutput.captureRegularFileBinding> | undefined;
  let candidatePresent = false;
  let backupPresent = false;
  let backupVerified = false;
  let published = false;
  let retainStaging = false;
  const bindingError = (result: RelationLike, action: string) => {
    const error: SchematicsError = new Error(`Could not ${action} delivery journal "${file}" safely (${result.reason?.code || 'unknown target state'}).`);
    error.deliveryJournalState = result;
    return error;
  };
  try {
    fs.writeFileSync(temporary, serialized, { flag: 'wx' });
    candidatePresent = true;
    candidateCapture = captureRegularFileBinding(temporary, {
      subject: 'delivery-journal-candidate',
      expectedSha256: expectedContent.sha256,
      expectedBytes: expectedContent.bytes,
      expectedLinks: 1,
    });
    if (candidateCapture.status !== 'captured') throw bindingError(candidateCapture, 'prepare the');

    let existing = false;
    try {
      fs.lstatSync(file);
      existing = true;
    } catch (error) {
      if (fault(error).code !== 'ENOENT' && fault(error).code !== 'ENOTDIR') throw error;
    }
    if (existing) {
      previousCapture = captureRegularFileBinding(file, {
        subject: 'previous-delivery-journal',
        expectedLinks: 1,
      });
      if (previousCapture.status !== 'captured') {
        throw bindingError(previousCapture, 'snapshot the existing');
      }
    }
    beforeReplace?.();
    if (previousCapture) {
      const moved = backupPublicRegularFileBinding(bindingOf(previousCapture), file, backup, {
        subject: 'previous-delivery-journal',
      });
      backupPresent = moved.backupCreated === true;
      backupVerified = moved.backupVerified === true;
      if (moved.status !== 'backed-up') throw bindingError(moved, 'back up the existing');
    }

    const ready = verifyRegularFileBinding(candidateCapture.binding, {
      filePath: temporary,
      expectedLinks: 1,
    });
    if (ready.status !== 'match') throw bindingError(ready, 'verify the staged');
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if (fault(error).code === 'EEXIST') {
        throw bindingError({
          status: 'different',
          reason: { code: 'target-claimed-during-publish', phase: 'journal-publish' },
        }, 'publish the');
      }
      throw error;
    }
    published = true;
    for (const target of [temporary, file]) {
      const linked = verifyRegularFileBinding(candidateCapture.binding, {
        filePath: target,
        expectedLinks: 2,
      });
      if (linked.status !== 'match') throw bindingError(linked, 'verify the published');
    }
    const retiredCandidate = quarantineRemoveRegularFileBinding(
      candidateCapture.binding,
      temporary,
      { subject: 'delivery-journal-candidate', expectedLinks: 2 },
    );
    if (retiredCandidate.status !== 'removed') {
      retainStaging = true;
      throw bindingError(retiredCandidate, 'retire the staged');
    }
    candidatePresent = false;
    const finalized = verifyRegularFileBinding(candidateCapture.binding, {
      filePath: file,
      expectedLinks: 1,
    });
    if (finalized.status !== 'match') throw bindingError(finalized, 'finalize the');
    if (backupPresent) {
      const previous = verifyRegularFileBinding(bindingOf(previousCapture), {
        filePath: backup,
        expectedLinks: 1,
      });
      if (previous.status !== 'match') throw bindingError(previous, 'verify the previous');
      const retiredBackup = quarantineRemoveRegularFileBinding(
        bindingOf(previousCapture),
        backup,
        { subject: 'previous-delivery-journal', expectedLinks: 1 },
      );
      if (retiredBackup.status !== 'removed') {
        retainStaging = true;
        throw bindingError(retiredBackup, 'retire the previous');
      }
      backupPresent = false;
    }
    return {
      identity: candidateCapture.identity,
      content: candidateCapture.content,
    };
  } catch (cause) {
    const rollbackErrors: Array<string | undefined> = [];
    const publicRecoveryFiles: Array<{ label: string; path: unknown; target: string }> = [];
    const journalState = fault(cause).deliveryJournalState;
    if (field(journalState, 'status') === 'recovery-required'
      && field(journalState, 'recoveryFile')) {
      publicRecoveryFiles.push({
        label: 'preserved journal replacement',
        path: field(journalState, 'recoveryFile'),
        target: file,
      });
    }
    if (published) {
      try {
        const removed = quarantineRemoveRegularFileBinding(bindingOf(candidateCapture), file, {
          subject: 'published-delivery-journal',
          expectedLinks: candidatePresent ? 2 : 1,
        });
        if (removed.status === 'removed') {
          published = false;
        } else {
          rollbackErrors.push(`the published journal could not be removed safely (${removed.reason?.code || 'unknown target state'})`);
          if (removed.status === 'recovery-required') {
            publicRecoveryFiles.push({
              label: 'preserved journal replacement',
              path: removed.recoveryFile,
              target: file,
            });
          }
        }
      } catch (error) {
        if (fault(error).code !== 'ENOENT') rollbackErrors.push(`published journal cleanup failed (${fault(error).message})`);
      }
    }
    if (candidatePresent) {
      try {
        const current = verifyRegularFileBinding(bindingOf(candidateCapture), {
          filePath: temporary,
          expectedLinks: published ? 2 : 1,
        });
        if (current.status === 'match') {
          const retiredCandidate = quarantineRemoveRegularFileBinding(
            bindingOf(candidateCapture),
            temporary,
            {
              subject: 'delivery-journal-candidate',
              expectedLinks: published ? 2 : 1,
            },
          );
          if (retiredCandidate.status !== 'removed') {
            throw bindingError(retiredCandidate, 'retire the staged');
          }
          candidatePresent = false;
        } else {
          rollbackErrors.push('the staged journal candidate was replaced before cleanup');
          retainStaging = true;
        }
      } catch (error) {
        if (fault(error).code !== 'ENOENT') rollbackErrors.push(`staged journal cleanup failed (${fault(error).message})`);
      }
    }
    if (backupPresent) {
      try {
        if (!backupVerified) {
          throw new Error('the backup entry was never verified as the previous journal');
        }
        if (pathEntryExists(file)) throw new Error('a new journal claimant prevents restoring the previous journal');
        const previous = verifyRegularFileBinding(bindingOf(previousCapture), {
          filePath: backup,
          expectedLinks: 1,
        });
        if (previous.status !== 'match') {
          backupVerified = false;
          throw bindingError(previous, 'verify the previous');
        }
        try {
          fs.linkSync(backup, file);
        } catch (error) {
          if (fault(error).code === 'EEXIST') {
            throw new Error('a new journal claimant prevents restoring the previous journal');
          }
          throw error;
        }
        for (const target of [backup, file]) {
          const restored = verifyRegularFileBinding(bindingOf(previousCapture), {
            filePath: target,
            expectedLinks: 2,
          });
          if (restored.status !== 'match') throw bindingError(restored, 'verify the restored');
        }
        const retiredBackup = quarantineRemoveRegularFileBinding(
          bindingOf(previousCapture),
          backup,
          { subject: 'previous-delivery-journal', expectedLinks: 2 },
        );
        if (retiredBackup.status !== 'removed') {
          throw bindingError(retiredBackup, 'retire the restored backup');
        }
        backupPresent = false;
        const restored = verifyRegularFileBinding(bindingOf(previousCapture), {
          filePath: file,
          expectedLinks: 1,
        });
        if (restored.status !== 'match') throw bindingError(restored, 'finalize the restored');
      } catch (error) {
        rollbackErrors.push(`previous journal restore failed (${fault(error).message})`);
        retainStaging = backupPresent || candidatePresent;
      }
    }
    const claimantConflict = field(field(journalState, 'reason'), 'code') === 'target-claimed-during-publish';
    if (rollbackErrors.length || claimantConflict) {
      fault(cause).deliveryJournalRecovery = {
        recoveryRequired: true,
        journal: file,
        ...(claimantConflict ? { claimantConflict: true } : {}),
        rollbackErrors,
        ...(retainStaging ? {
          recoveryDirectory: stagingDirectory,
        } : publicRecoveryFiles.length ? {
          recoveryDirectory: path.dirname(requiredPath(publicRecoveryFiles[0]?.path)),
        } : {}),
        ...(backupPresent || (candidatePresent && retainStaging) || publicRecoveryFiles.length ? {
          recoveryFiles: [
            ...(backupPresent ? [{
              label: backupVerified
                ? 'previous delivery journal'
                : 'unverified preserved journal backup entry',
              path: backup,
              target: file,
              verifiedPrevious: backupVerified,
            }] : []),
            ...(candidatePresent && retainStaging ? [{ label: 'preserved staged journal entry', path: temporary }] : []),
            ...publicRecoveryFiles,
          ],
        } : {}),
      };
    }
    throw cause;
  } finally {
    if (candidateCapture?.status === 'captured') releaseRegularFileBinding(candidateCapture.binding);
    if (previousCapture?.status === 'captured') releaseRegularFileBinding(previousCapture.binding);
    if (!retainStaging) removeOwnedEmptyStagingDirectory(stagingDirectory, staging.identity);
  }
}

function writeCapturedDeliveryProvenance(file: string, value: unknown, {
  beforeCommit,
  capture,
  verifyAtomicOutput,
  fileBindingRuntime,
}: {
  beforeCommit?: () => unknown;
  capture?: AtomicOutput.CapturedAtomicOutput;
  verifyAtomicOutput?: typeof AtomicOutput.verifyAtomicOutput;
  fileBindingRuntime?: FileBindingRuntime;
} = {}): void {
  const {
    backupPublicRegularFileBinding,
    captureRegularFileBinding,
    quarantineRemoveRegularFileBinding,
    verifyRegularFileBinding,
    releaseRegularFileBinding,
  } = fileBindingRuntime || {};
  if (!capture
    || typeof verifyAtomicOutput !== 'function'
    || typeof backupPublicRegularFileBinding !== 'function'
    || typeof captureRegularFileBinding !== 'function'
    || typeof quarantineRemoveRegularFileBinding !== 'function'
    || typeof verifyRegularFileBinding !== 'function'
    || typeof releaseRegularFileBinding !== 'function') {
    throw deliveryTargetStateError(file, 'delivery provenance', {
      status: 'unknown',
      reason: { code: 'atomic-output-runtime-unavailable' },
    });
  }
  const staging = createOwnedEmptyStagingDirectory(
    path.join(path.dirname(file), '.schematics-provenance-'),
  );
  const stagingDirectory = staging.directory;
  const candidate = path.join(stagingDirectory, path.basename(file));
  const backup = path.join(stagingDirectory, '.previous-provenance');
  let candidateBinding: AtomicOutput.RegularFileBinding | undefined;
  let previousBinding: AtomicOutput.RegularFileBinding | undefined;
  let candidatePresent = false;
  let backupPresent = false;
  let backupVerified = false;
  let published = false;
  let retainStaging = false;
  try {
    const serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    const expectedContent = artifactIdentity(serialized);
    fs.writeFileSync(candidate, serialized, { flag: 'wx' });
    candidatePresent = true;
    if (capture.mode !== null) fs.chmodSync(candidate, capture.mode);
    const candidateCapture = captureRegularFileBinding(candidate, {
      subject: 'delivery-provenance-candidate',
      expectedSha256: expectedContent.sha256,
      expectedBytes: expectedContent.bytes,
      ...(capture.mode === null ? {} : { expectedMode: capture.mode }),
      expectedLinks: 1,
    });
    if (candidateCapture.status !== 'captured') {
      throw deliveryTargetStateError(file, 'delivery provenance', candidateCapture);
    }
    candidateBinding = candidateCapture.binding;
    beforeCommit?.();
    const verification = verifyAtomicOutput(capture.snapshot);
    if (verification.status !== 'match') {
      throw deliveryTargetStateError(file, 'delivery provenance', verification);
    }
    if (capture.snapshot.target.kind === 'file') {
      const expected = capture.snapshot.target;
      const previous = captureRegularFileBinding(capture.commitPath, {
        subject: 'previous-delivery-provenance',
        expectedIdentity: { device: expected.device, inode: expected.inode },
        expectedMode: expected.mode,
        expectedLinks: 1,
      });
      if (previous.status !== 'captured') {
        throw deliveryTargetStateError(file, 'delivery provenance', previous);
      }
      previousBinding = previous.binding;
      const moved = backupPublicRegularFileBinding(
        previousBinding,
        capture.commitPath,
        backup,
        { subject: 'previous-delivery-provenance' },
      );
      backupPresent = moved.backupCreated === true;
      backupVerified = moved.backupVerified === true;
      if (moved.status !== 'backed-up') {
        throw deliveryTargetStateError(file, 'delivery provenance', moved);
      }
    }
    const currentCandidate = verifyRegularFileBinding(candidateBinding, {
      filePath: candidate,
      expectedLinks: 1,
    });
    if (currentCandidate.status !== 'match') {
      throw deliveryTargetStateError(file, 'delivery provenance', currentCandidate);
    }
    try {
      fs.linkSync(candidate, capture.commitPath);
    } catch (error) {
      if (fault(error).code === 'EEXIST') {
        throw deliveryTargetStateError(file, 'delivery provenance', {
          status: 'different',
          reason: { code: 'target-claimed-during-publish' },
        });
      }
      throw error;
    }
    published = true;
    for (const target of [candidate, capture.commitPath]) {
      const linked = verifyRegularFileBinding(candidateBinding, {
        filePath: target,
        expectedLinks: 2,
      });
      if (linked.status !== 'match') {
        throw deliveryTargetStateError(file, 'delivery provenance', linked);
      }
    }
    const retiredCandidate = quarantineRemoveRegularFileBinding(
      candidateBinding,
      candidate,
      { subject: 'delivery-provenance-candidate', expectedLinks: 2 },
    );
    if (retiredCandidate.status !== 'removed') {
      retainStaging = true;
      throw deliveryTargetStateError(file, 'delivery provenance', retiredCandidate);
    }
    candidatePresent = false;
    const finalized = verifyRegularFileBinding(candidateBinding, {
      filePath: capture.commitPath,
      expectedLinks: 1,
    });
    if (finalized.status !== 'match') {
      throw deliveryTargetStateError(file, 'delivery provenance', finalized);
    }
    if (backupPresent) {
      const currentBackup = verifyRegularFileBinding(previousBinding ?? UNBOUND_FILE, {
        filePath: backup,
        expectedLinks: 1,
      });
      if (currentBackup.status !== 'match') {
        backupVerified = false;
        throw deliveryTargetStateError(file, 'delivery provenance', {
          status: 'different',
          reason: { code: 'backup-identity-changed-before-finalize' },
        });
      }
      const retiredBackup = quarantineRemoveRegularFileBinding(
        previousBinding ?? UNBOUND_FILE,
        backup,
        { subject: 'previous-delivery-provenance', expectedLinks: 1 },
      );
      if (retiredBackup.status !== 'removed') {
        retainStaging = true;
        throw deliveryTargetStateError(file, 'delivery provenance', retiredBackup);
      }
      backupPresent = false;
    }
  } catch (cause) {
    const rollbackErrors = [];
    const publicRecoveryFiles = [];
    if (fault(cause).deliveryTargetState?.status === 'recovery-required'
      && fault(cause).deliveryTargetState?.recoveryFile) {
      publicRecoveryFiles.push({
        label: 'preserved provenance replacement',
        path: fault(cause).deliveryTargetState?.recoveryFile,
        target: capture.commitPath,
      });
    }
    if (published) {
      try {
        const removed = quarantineRemoveRegularFileBinding(candidateBinding ?? UNBOUND_FILE, capture.commitPath, {
          subject: 'published-delivery-provenance',
          expectedLinks: candidatePresent ? 2 : 1,
        });
        if (removed.status === 'removed') {
          published = false;
        } else {
          rollbackErrors.push(`the published provenance could not be removed safely (${removed.reason?.code || 'unknown target state'})`);
          if (removed.status === 'recovery-required') {
            publicRecoveryFiles.push({
              label: 'preserved provenance replacement',
              path: removed.recoveryFile,
              target: capture.commitPath,
            });
          }
        }
      } catch (error) {
        if (fault(error).code !== 'ENOENT') rollbackErrors.push(`published provenance cleanup failed (${fault(error).message})`);
      }
    }
    if (candidatePresent) {
      try {
        const current = verifyRegularFileBinding(candidateBinding ?? UNBOUND_FILE, {
          filePath: candidate,
          expectedLinks: published ? 2 : 1,
        });
        if (current.status === 'match') {
          const retiredCandidate = quarantineRemoveRegularFileBinding(
            candidateBinding ?? UNBOUND_FILE,
            candidate,
            {
              subject: 'delivery-provenance-candidate',
              expectedLinks: published ? 2 : 1,
            },
          );
          if (retiredCandidate.status !== 'removed') {
            throw deliveryTargetStateError(
              file,
              'delivery provenance',
              retiredCandidate,
            );
          }
          candidatePresent = false;
        } else {
          rollbackErrors.push('the staged provenance candidate was replaced before cleanup');
          retainStaging = true;
        }
      } catch (error) {
        if (fault(error).code !== 'ENOENT') {
          rollbackErrors.push(`staged provenance cleanup failed (${fault(error).message})`);
          retainStaging = true;
        }
      }
    }
    if (backupPresent) {
      try {
        if (!backupVerified) {
          throw new Error('the backup entry was never verified as the previous provenance');
        }
        if (pathEntryExists(capture.commitPath)) {
          throw new Error('a new target claimant prevents restoring the previous provenance');
        }
        const currentBackup = verifyRegularFileBinding(previousBinding ?? UNBOUND_FILE, {
          filePath: backup,
          expectedLinks: 1,
        });
        if (currentBackup.status !== 'match') {
          backupVerified = false;
          throw new Error('the previous provenance backup identity changed');
        }
        fs.linkSync(backup, capture.commitPath);
        for (const target of [backup, capture.commitPath]) {
          const restored = verifyRegularFileBinding(previousBinding ?? UNBOUND_FILE, {
            filePath: target,
            expectedLinks: 2,
          });
          if (restored.status !== 'match') {
            throw new Error('the restored provenance identity could not be verified');
          }
        }
        const retiredBackup = quarantineRemoveRegularFileBinding(
          previousBinding ?? UNBOUND_FILE,
          backup,
          { subject: 'previous-delivery-provenance', expectedLinks: 2 },
        );
        if (retiredBackup.status !== 'removed') {
          throw deliveryTargetStateError(file, 'delivery provenance', retiredBackup);
        }
        backupPresent = false;
        const restoredFinal = verifyRegularFileBinding(previousBinding ?? UNBOUND_FILE, {
          filePath: capture.commitPath,
          expectedLinks: 1,
        });
        if (restoredFinal.status !== 'match') {
          throw new Error('the restored provenance link count could not be verified');
        }
      } catch (error) {
        rollbackErrors.push(`previous provenance restore failed (${fault(error).message})`);
        retainStaging = true;
      }
    }
    const recoveryFiles = [
      ...(backupPresent ? [{
        label: backupVerified
          ? 'preserved delivery provenance backup entry'
          : 'unverified preserved delivery provenance backup entry',
        path: backup,
        target: capture.commitPath,
        verifiedPrevious: backupVerified,
      }] : []),
      ...(candidatePresent && retainStaging ? [{ label: 'preserved staged provenance entry', path: candidate }] : []),
      ...publicRecoveryFiles,
    ];
    if (rollbackErrors.length) {
      fault(cause).deliveryProvenanceRecovery = {
        recoveryRequired: true,
        rollbackErrors,
        ...(recoveryFiles.length ? {
          recoveryDirectory: retainStaging
            ? stagingDirectory
            : path.dirname(requiredPath(recoveryFiles[0]?.path)),
          recoveryFiles,
        } : {}),
      };
    }
    const [issue] = fault(cause).schematicsDiagnostics ?? [];
    if (rollbackErrors.length && issue) {
      issue.evidence = {
        ...(issue.evidence || {}),
        rollbackErrors,
        ...(recoveryFiles.length ? {
          recoveryDirectory: retainStaging
            ? stagingDirectory
            : path.dirname(requiredPath(recoveryFiles[0]?.path)),
          recoveryFile: recoveryFiles[0]?.path,
          recoveryFiles,
        } : {}),
      };
    }
    throw cause;
  } finally {
    if (candidateBinding) releaseRegularFileBinding(candidateBinding);
    if (previousBinding) releaseRegularFileBinding(previousBinding);
    if (!retainStaging) removeOwnedEmptyStagingDirectory(stagingDirectory, staging.identity);
  }
}

function recordDeliveryFailure(options: DeliveryFailureOptions): DeliveryRecord | undefined {
  const {
    output, stage, input, error, receiptId, pathsAlias, ownership: suppliedOwnership,
    releaseOwnership: shouldReleaseSuppliedOwnership = false, legacyOutputPaths = [],
    captureAtomicOutput, verifyAtomicOutput, fileBindingRuntime,
  } = options;
  if (!output || !/\.html?$/i.test(output)) return { ok: true, status: 'not-applicable' };
  let ownership = suppliedOwnership;
  let acquiredHere = false;
  if (!ownership) {
    try {
      ownership = acquireDeliveryLock(
        output,
        receiptId,
        input,
        pathsAlias,
        (lockError, initializingOwnership) => recordDeliveryFailure({
          ...options,
          error: `Could not start delivery for "${output}": ${fault(lockError).message}`,
          ownership: initializingOwnership,
          releaseOwnership: false,
        }),
        legacyOutputPaths,
        fileBindingRuntime,
      );
      acquiredHere = true;
    } catch (lockError) {
      const reportedLockError = fault(lockError).code === 'SCHEMATICS_SIDECAR_NAMESPACE_INDETERMINATE'
        && fault(lockError).sidecarNamespaceReason?.code === 'sidecar-directory-missing'
        ? Object.assign(
          new Error(`Delivery lock parent directory does not exist for "${output}".`),
          { code: 'ENOENT', cause: lockError },
        )
        : lockError;
      return {
        ...(fault(lockError).deliveryFailureRecord || { ok: false, status: 'unrecorded' }),
        lockError: reportedLockError,
      };
    }
  }
  const state = deliveryOwnershipStates.get(ownership);
  let recorded: DeliveryRecord | undefined;
  if (!state?.deliveryTargets) {
    try {
      captureDeliveryTargetState({
        state,
        requestedOutput: legacyOutputPaths[0] || output,
        pathsAlias,
        captureAtomicOutput,
        verifyAtomicOutput,
      });
    } catch (captureError) {
      recorded = {
        ok: false,
        status: 'unrecorded',
        diagnostic: fault(captureError).schematicsDiagnostics?.[0] || diagnostic({
          code: 'output/target-indeterminate',
          message: fault(captureError).message,
          subject: { output },
          evidence: { ...(fault(captureError).code ? { systemCode: fault(captureError).code } : {}) },
          supportedFixes: ['use ordinary absent or regular-file delivery targets, then retry'],
        }),
      };
    }
  }
  const stableOutput = state?.output || canonicalExistingDeliveryOutput(output);
  // Keep independent evidence even when the artifact is unreadable or the
  // provenance target is locked, aliases the input, or cannot be replaced.
  let journalError: unknown;
  if (!recorded && !state?.pendingIdentity) {
    try {
      beginDeliveryAttempt({ ownership, input, pathsAlias, fileBindingRuntime });
    } catch (cause) {
      if (fault(cause).deliveryOwnershipCode === 'delivery/ownership-lost') {
        recorded = { ok: false, status: 'unrecorded', ownershipError: cause };
      } else if (fault(cause).deliveryJournalRecovery?.recoveryRequired) {
        recorded = {
          ok: false,
          status: 'unrecorded',
          journalRecovery: cause,
          diagnostic: deliveryJournalRecoveryDiagnostic(stableOutput, cause),
        };
      }
      journalError = cause;
    }
  }
  if (!recorded) {
    let artifact: Buffer | undefined;
    let artifactBinding: AtomicOutput.RegularFileBinding | undefined;
    const {
      captureRegularFileBinding,
      verifyRegularFileBinding,
      releaseRegularFileBinding,
    } = fileBindingRuntime || {};
    try {
      if (typeof captureRegularFileBinding === 'function') {
        const artifactCapture = captureRegularFileBinding(stableOutput, {
          subject: 'failed-delivery-artifact',
          expectedLinks: 1,
          includeContent: true,
        });
        if (artifactCapture.status === 'captured') {
          artifact = artifactCapture.content.buffer;
          artifactBinding = artifactCapture.binding;
        } else if (['ENOENT', 'ENOTDIR'].includes(String(artifactCapture.reason?.systemCode))) {
          recorded = { ok: true, status: 'absent' };
        }
        // A failed marker does not need an artifact hash to invalidate old
        // evidence. Non-regular or changing paths are never followed.
      }
      if (!recorded) {
      const provenancePath = state?.provenancePath || deliveryProvenancePath(stableOutput);
      let aliasesProtectedPath;
      try {
        aliasesProtectedPath = (input && pathsAlias(provenancePath, input))
          || pathsAlias(provenancePath, stableOutput);
      } catch (aliasError) {
        recorded = {
          ok: false,
          status: 'unrecorded',
          diagnostic: diagnostic({
            code: 'delivery/provenance-path-resolution',
            message: 'Delivery failure provenance could not resolve its target safely.',
            subject: { output: stableOutput, provenance: provenancePath },
            evidence: {
              reason: fault(aliasError).message,
              ...(fault(aliasError).code ? { systemCode: fault(aliasError).code } : {}),
            },
            supportedFixes: ['remove the sidecar path conflict or symbolic-link cycle, then rerun deliver'],
          }),
        };
      }
      if (!recorded && aliasesProtectedPath) {
        recorded = {
          ok: false,
          status: 'unrecorded',
          diagnostic: diagnostic({
            code: 'delivery/provenance-target-alias',
            message: 'Delivery failure provenance could not be recorded without replacing an input or the artifact.',
            subject: { output: stableOutput, provenance: provenancePath },
            evidence: { ...(input ? { input: path.resolve(input) } : {}) },
            supportedFixes: ['choose an output whose .delivery.json sidecar is distinct from every input and the HTML artifact'],
          }),
        };
      }
      if (!recorded) {
        try {
          writeCapturedDeliveryProvenance(provenancePath, {
            schemaVersion: 1,
            receiptId,
            status: 'failed',
            command: 'deliver',
            stage,
            input,
            output: stableOutput,
            ...(artifact ? { artifact: artifactIdentity(artifact) } : {}),
            error,
          }, {
            beforeCommit: () => {
              assertDeliveryOwnership(ownership, 'record failed delivery provenance', {
                allowInitializing: true,
                pending: state?.pendingIdentity ? 'owned' : 'ignore',
              });
              if (artifactBinding && verifyRegularFileBinding) {
                const verification = verifyRegularFileBinding(artifactBinding, {
                  filePath: stableOutput,
                  expectedLinks: 1,
                });
                if (verification.status !== 'match') {
                  throw deliveryTargetStateError(
                    stableOutput,
                    'failed delivery artifact',
                    verification,
                  );
                }
              }
            },
            capture: state?.deliveryTargets?.provenance,
            verifyAtomicOutput,
            fileBindingRuntime,
          });
          recorded = { ok: true, status: 'failed' };
        } catch (writeError) {
          if (fault(writeError).deliveryOwnershipCode === 'delivery/ownership-lost') {
            recorded = { ok: false, status: 'unrecorded', ownershipError: writeError };
          } else if (fault(writeError).deliveryProvenanceRecovery?.recoveryRequired) {
            const recovery: RecoveryInfo = fault(writeError).deliveryProvenanceRecovery ?? {};
            recorded = {
              ok: false,
              status: 'unrecorded',
              provenanceRecovery: writeError,
              diagnostic: diagnostic({
                code: 'delivery/provenance-recovery-required',
                message: 'Failed-delivery provenance could not be rolled back safely.',
                subject: { output: stableOutput, provenance: provenancePath },
                evidence: {
                  reason: fault(writeError).message,
                  recoveryRequired: true,
                  ...(recovery.recoveryDirectory ? { recoveryDirectory: recovery.recoveryDirectory } : {}),
                  ...(recovery.recoveryFiles?.length ? { recoveryFiles: recovery.recoveryFiles } : {}),
                  ...(recovery.rollbackErrors?.length ? { rollbackErrors: recovery.rollbackErrors } : {}),
                },
                supportedFixes: ['leave the delivery lock and journal untouched, inspect the retained recovery files, then recover serially'],
              }),
            };
          } else if (fault(writeError).deliveryTargetState) {
            recorded = {
              ok: false,
              status: 'unrecorded',
              diagnostic: fault(writeError).schematicsDiagnostics?.[0],
            };
          } else {
            recorded = {
              ok: false,
              status: 'unrecorded',
              diagnostic: diagnostic({
                code: 'delivery/provenance-write',
                message: 'The failed delivery could not persist its stale-artifact marker.',
                subject: { output: stableOutput, provenance: provenancePath },
                evidence: {
                  reason: fault(writeError).message,
                  ...(fault(writeError).code ? { systemCode: fault(writeError).code } : {}),
                  failureJournalRecorded: !journalError,
                  ...(journalError ? { journalError: fault(journalError).message } : {}),
                },
                supportedFixes: ['restore write access to the output directory, then rerun deliver before trusting the artifact'],
              }),
            };
          }
        }
      }
      }
    } finally {
      if (artifactBinding && typeof releaseRegularFileBinding === 'function') {
        releaseRegularFileBinding(artifactBinding);
      }
    }
  }
  if (recorded?.journalRecovery || recorded?.provenanceRecovery) return recorded;
  if (acquiredHere || shouldReleaseSuppliedOwnership) {
    try {
      releaseDeliveryOwnership(ownership, { allowInitializing: true });
    } catch (lockError) {
      if (fault(lockError).deliveryOwnershipCode === 'delivery/ownership-lost') {
        const ownershipError = recorded?.ownershipError || lockError;
        if (options.recoveryDirectory) {
          fault(ownershipError).deliveryCommitDetails = {
            ...(fault(ownershipError).deliveryCommitDetails || {}),
            recoveryRequired: true,
            recoveryDirectory: options.recoveryDirectory,
            recoverableBackups: [],
          };
        }
        return {
          ...recorded,
          ok: false,
          status: 'unrecorded',
          ownershipError,
          lockError,
        };
      }
      return { ...recorded, lockError: recorded?.ownershipError || lockError };
    }
  }
  return recorded;
}

// Locale warnings for a successfully rendered candidate. Diagnostic renderers
// record them without printing text; validate/deliver disclose them before
// checking the artifact and reuse the same diagnostics in successful receipts.
async function specificationLocaleDiagnostics(type: string, specification: unknown) {
  let meta;
  try {
    meta = JSON.parse(String(specification)).meta;
  } catch {
    return [];
  }
  if (!meta?.locale) return [];
  const { localeDiagnostics } = await import('../packages/i18n/i18n.ts');
  return localeDiagnostics(type, meta);
}

function deliverySuccessProvenance(receipt: JsonRecord) {
  return {
    schemaVersion: 1,
    receiptId: receipt.receiptId,
    status: 'current',
    command: 'deliver',
    type: receipt.type,
    input: receipt.input,
    output: receipt.output,
    specification: receipt.specification,
    artifact: receipt.artifact,
    ...(receipt.explainer ? { explainer: receipt.explainer } : {}),
  };
}

function inspectDeliveryProvenance(artifactPath: string, artifact: Buffer | undefined, {
  requireProvenance = false,
  pathIdentityRuntime,
  expectedSidecar,
  inspection,
}: {
  requireProvenance?: boolean;
  pathIdentityRuntime?: PathIdentityRuntime;
  expectedSidecar?: SidecarBinding;
  inspection?: ProvenanceInspection;
} = {}) {
  let sidecar = deliveryProvenancePath(artifactPath);
  const rawHeadSidecar = rawHeadDeliveryProvenancePath(artifactPath);
  const pending = deliveryPendingPath(artifactPath);
  const rawHeadPending = rawHeadDeliveryPendingPath(artifactPath);
  const legacyExtensionPending = legacyExtensionDeliverySidecarPath(
    artifactPath,
    '.delivery-pending.json',
  );
  const legacyExtensionSidecar = legacyExtensionDeliverySidecarPath(
    artifactPath,
    '.delivery.json',
  );
  const stableOutput = canonicalExistingDeliveryOutput(artifactPath);
  const locks = [
    deliveryLockPath(stableOutput),
    ...legacyDeliveryLockPaths([artifactPath, stableOutput]),
  ];
  let foundPending;
  try {
    for (const candidate of [...new Set([
      pending,
      rawHeadPending,
      legacyExtensionPending,
    ].filter(truthy))]) {
      if (pathEntryExists(candidate)) {
        foundPending = candidate;
        break;
      }
    }
    if (foundPending) {
      return {
        ok: false, status: 'failed',
        diagnostics: [diagnostic({
          code: 'delivery/provenance-failed',
          message: 'A delivery attempt is unfinished or failed; complete a successful deliver before trusting this artifact.',
          subject: { artifact: path.resolve(artifactPath), provenance: sidecar },
          evidence: { pendingJournal: foundPending, found: true },
          supportedFixes: ['finish any active delivery, then rerun deliver successfully; retain the pending journal until recovery succeeds'],
        })],
      };
    }
  } catch (error) {
    return invalidProvenance(artifactPath, foundPending || pending, fault(error).message);
  }
  for (const lock of locks) {
    try {
      if (pathEntryExists(lock)) {
        return {
          ok: false, status: 'locked',
          diagnostics: [diagnostic({
            code: 'delivery/provenance-locked',
            message: 'Delivery ownership is unresolved while the output lock remains; complete or recover delivery before trusting this artifact.',
            subject: { artifact: path.resolve(artifactPath), lock },
            evidence: { deliveryLock: lock, found: true },
            supportedFixes: ['finish the active delivery or inspect and recover the preserved lock, then rerun deliver successfully'],
          })],
        };
      }
    } catch (error) {
      return invalidProvenance(artifactPath, lock, fault(error).message);
    }
  }
  let found;
  try {
    found = pathEntryExists(sidecar);
  } catch (error) {
    return invalidProvenance(artifactPath, sidecar, fault(error).message);
  }
  if (!found && rawHeadSidecar) {
    try {
      found = pathEntryExists(rawHeadSidecar);
      if (found) sidecar = rawHeadSidecar;
    } catch (error) {
      return invalidProvenance(artifactPath, rawHeadSidecar, fault(error).message);
    }
  }
  if (!found && legacyExtensionSidecar) {
    try {
      found = pathEntryExists(legacyExtensionSidecar);
      if (found) sidecar = legacyExtensionSidecar;
    } catch (error) {
      return invalidProvenance(artifactPath, legacyExtensionSidecar, fault(error).message);
    }
  }
  if (!found) {
    if (!requireProvenance) return { ok: true, status: 'unknown' };
    const message = 'Delivery provenance is required, but the artifact has no .delivery.json sidecar.';
    return {
      ok: false,
      status: 'unknown',
      diagnostics: [diagnostic({
        code: 'delivery/provenance-required',
        message,
        subject: { artifact: path.resolve(artifactPath), provenance: sidecar },
        evidence: { required: true, found: false },
        supportedFixes: ['rerun deliver for the current specification, then retry with --require-provenance'],
      })],
    };
  }
  let receipt;
  let sidecarCapture;
  try {
    const {
      captureRegularFileBinding,
      releaseRegularFileBinding,
    } = pathIdentityRuntime || {};
    if (typeof captureRegularFileBinding !== 'function'
      || typeof releaseRegularFileBinding !== 'function') {
      throw new Error('The regular-file binding runtime is unavailable.');
    }
    sidecarCapture = captureRegularFileBinding(sidecar, {
      subject: 'delivery-provenance',
      ...(expectedSidecar ? {
        expectedIdentity: expectedSidecar.identity,
        expectedSha256: expectedSidecar.content.sha256,
        expectedBytes: expectedSidecar.content.bytes,
        expectedMode: expectedSidecar.mode,
      } : {}),
      expectedLinks: 1,
      includeContent: true,
    });
    if (sidecarCapture.status !== 'captured') {
      if (sidecarCapture.reason?.code === 'delivery-provenance-hardlinked') {
      return {
        ok: false,
        status: 'unsupported',
        diagnostics: [diagnostic({
          code: 'delivery/provenance-hardlink-unsupported',
          message: 'Delivery provenance is hard-linked and cannot prove that every linked name was updated atomically.',
          subject: { artifact: path.resolve(artifactPath), provenance: sidecar },
          evidence: { links: sidecarCapture.reason.links },
          supportedFixes: ['remove extra hard links to the provenance sidecar, then rerun deliver'],
        })],
      };
      }
      throw new Error(`Delivery provenance is not a stable regular file (${sidecarCapture.reason?.code || 'unknown target state'}).`);
    }
    receipt = JSON.parse(contentBuffer(sidecarCapture).toString('utf8'));
    const identityValid = (value: { sha256?: unknown; bytes?: unknown } | null | undefined) => value && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)
      && Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || receipt.schemaVersion !== 1 || receipt.command !== 'deliver'
      || typeof receipt.receiptId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.receiptId)
      || typeof receipt.output !== 'string' || !path.isAbsolute(receipt.output)
      || typeof receipt.input !== 'string' || !path.isAbsolute(receipt.input)
      || !['current', 'failed'].includes(receipt.status)
      || (receipt.status === 'current' && (!TYPES.has(receipt.type)
        || !identityValid(receipt.specification) || !identityValid(receipt.artifact)))
      || (receipt.status === 'failed' && typeof receipt.stage !== 'string')) {
      throw new Error('Delivery provenance does not conform to the supported receipt schema.');
    }
    if (inspection) {
      inspection.sidecar = {
        path: sidecar,
        identity: {
          device: sidecarCapture.identity.device,
          inode: sidecarCapture.identity.inode,
        },
        content: {
          sha256: sidecarCapture.content.sha256,
          bytes: sidecarCapture.content.bytes,
        },
        mode: sidecarCapture.mode,
      };
    }
  } catch (error) {
    const message = `Could not read delivery provenance: ${fault(error).message}`;
    return {
      ok: false,
      status: 'invalid',
      diagnostics: [diagnostic({
        code: 'delivery/provenance-invalid',
        message,
        subject: { artifact: path.resolve(artifactPath), provenance: sidecar },
        evidence: { reason: fault(error).message },
        supportedFixes: ['rerun deliver to replace the invalid provenance sidecar'],
      })],
    };
  } finally {
    if (sidecarCapture?.status === 'captured') {
      pathIdentityRuntime?.releaseRegularFileBinding?.(sidecarCapture.binding);
    }
  }
  let outputIdentity;
  if (typeof pathIdentityRuntime?.sameEntry !== 'function') {
    const error = pathIdentityRuntime?.error;
    outputIdentity = {
      status: 'unknown',
      reason: {
        code: 'path-semantics-runtime-unavailable',
        ...(typeof fault(error).code === 'string' ? { systemCode: fault(error).code } : {}),
      },
    };
  } else {
    try {
      outputIdentity = pathIdentityRuntime.sameEntry(receipt.output, artifactPath);
    } catch (error) {
      outputIdentity = {
        status: 'unknown',
        reason: {
          code: 'path-identity-check-failed',
          ...(typeof fault(error).code === 'string' ? { systemCode: fault(error).code } : {}),
        },
      };
    }
  }
  if (outputIdentity.status === 'unknown') {
    return {
      ok: false,
      status: 'invalid',
      diagnostics: [diagnostic({
        code: 'delivery/provenance-output-indeterminate',
        message: 'Delivery provenance could not determine whether its recorded output identifies the inspected artifact.',
        subject: {
          artifact: path.resolve(artifactPath),
          provenance: sidecar,
          recordedOutput: receipt.output,
        },
        evidence: { pathIdentity: outputIdentity.reason },
        supportedFixes: ['restore access to both the artifact and its recorded output path, then rerun deliver successfully'],
      })],
    };
  }
  if (outputIdentity.status !== 'match') {
    return invalidProvenance(
      artifactPath,
      sidecar,
      'The recorded delivery output does not identify this artifact.',
      { recordedOutput: receipt.output, pathIdentity: outputIdentity.reason },
    );
  }
  if (!artifact) throw new TypeError('The artifact bytes are unavailable.');
  const actualSha256 = new Bun.CryptoHasher('sha256').update(artifact).digest('hex');
  if (receipt.status === 'failed') {
    const message = 'The artifact is stale because the latest delivery attempt failed.';
    return {
      ok: false,
      status: 'failed',
      receiptId: receipt.receiptId,
      diagnostics: [diagnostic({
        code: 'delivery/provenance-failed',
        message,
        subject: { artifact: path.resolve(artifactPath), provenance: sidecar },
        evidence: { stage: receipt.stage, deliveryReceiptId: receipt.receiptId },
        supportedFixes: ['repair the specification and complete a successful deliver before checking this artifact'],
      })],
    };
  }
  if (receipt.artifact?.sha256 !== actualSha256 || receipt.artifact?.bytes !== artifact.byteLength) {
    const message = 'The artifact bytes do not match their delivery provenance.';
    return {
      ok: false,
      status: 'mismatch',
      receiptId: receipt.receiptId,
      diagnostics: [diagnostic({
        code: 'delivery/provenance-mismatch',
        message,
        subject: { artifact: path.resolve(artifactPath), provenance: sidecar },
        evidence: {
          expectedSha256: receipt.artifact?.sha256,
          actualSha256,
          expectedBytes: receipt.artifact?.bytes,
          actualBytes: artifact.byteLength,
        },
        supportedFixes: ['restore the delivered artifact or rerun deliver to create a matching artifact and provenance pair'],
      })],
    };
  }
  return { ok: true, status: 'current', receiptId: receipt.receiptId, artifact: receipt.artifact, type: receipt.type };
}

function invalidProvenance(artifactPath: string, sidecar: string | undefined, reason: unknown, evidence: JsonRecord = {}) {
  return {
    ok: false, status: 'invalid',
    diagnostics: [diagnostic({
      code: 'delivery/provenance-invalid', message: 'Delivery provenance could not be verified.',
      subject: { artifact: artifactPath, provenance: sidecar }, evidence: { reason, ...evidence },
      supportedFixes: ['restore access to the delivery records, then rerun deliver successfully'],
    })],
  };
}

const COMMAND_USAGE = {
  render: '<type> <input.json> [output.html] [--quality standard|showcase] [--repo-root path]',
  compare: 'architecture <base.json> <head.json> [output.html] [--receipt path] [--json] [--quality standard|showcase] [--repo-root path]',
  deliver: '<type> <input.json> [output.html] [--json] [--open] [--quality standard|showcase] [--repo-root path]',
  patch: 'explainer <artifact.html> <panel-id> <replacement-file> <output.html> [--json] [--quality standard|showcase] [--repo-root path]',
  autofix: '<type> <input.json> <output.html> [--json] [--browser-check] [--quality standard|showcase] [--repo-root path]',
  chart: '<input.mmd|text> [output.svg]',
  import: 'mermaid <input.mmd> [output.json] [--title text] [--json]',
  finalize: '<type> <input.json> <output.html> [--json] [--browser-check] [--receipt path] [--out-dir <dir>] [--quality standard|showcase] [--repo-root path] [--candidate-sha256 hex]',
  preview: '<diagram-type (excludes explainer)> <input.json> [output.html] [--no-open] [--quality standard|showcase] [--repo-root path]',
  validate: '<type> <input.json> [--json] [--layout-json] [--quality standard|showcase] [--repo-root path]',
  migrate: 'workflow <old.json> <new.json> --to-schema 2 [--output portable.html] [--json] [--repo-root path]',
  inspect: '<type> <input.json>',
  check: '<output.html> [--json] [--require-provenance]',
  'browser-check': '<output.html> [--json|--summary] [--require-provenance] [--out-dir <dir>]',
  'visual-check': '<output.html> [--json|--summary] [--require-provenance] [--out-dir <dir>]',
  guide: '[scenario or question] [--json] [--lang en|zh]',
  brands: ['[name, alias, domain, or category] [--json]', 'capture <url> [--json]'],
  examples: '',
  doctor: '',
  demo: '[output-directory]',
};

function usage() {
  const commands = Object.entries(COMMAND_USAGE).flatMap(([command, forms]) =>
    (Array.isArray(forms) ? forms : [forms]).map(form => `  schematics ${command}${form ? ` ${form}` : ''}`));
  return `Usage:
${commands.join('\n')}
  (finalize --out-dir relocates browser-check and default finalize receipts; HTML and its delivery receipt stay at the requested output path)

Types:
  architecture, workflow, sequence, dataflow, lifecycle, erd, tree, class, timeline, waterfall, explainer

Explainer writing checks (validate, deliver, finalize, patch):
  --writing warn|strict|off (default: warn)
`;
}

function fail(message: string | undefined, code = 2): never {
  console.error(message);
  process.exit(code);
}

function rejectCliArgument(message: string, details: CliArgumentDetails = {}): never {
  const error: SchematicsError = new Error(message);
  error.schematicsArgument = {
    code: details.code || 'cli/invalid-arguments',
    subject: details.subject || {},
    evidence: details.evidence || {},
    supportedFixes: details.supportedFixes || ['correct the command arguments and retry'],
  };
  throw error;
}

function rendererPath(type: string): string {
  if (!TYPES.has(type)) {
    rejectCliArgument(`Unknown diagram type "${type}". Expected one of: ${[...TYPES].join(', ')}`, {
      code: 'cli/unknown-diagram-type',
      subject: { type },
      evidence: { supportedTypes: [...TYPES] },
      supportedFixes: [`use one of: ${[...TYPES].join(', ')}`],
    });
  }
  return type === 'explainer'
    ? path.join(skillRoot, 'packages', 'explainer', 'render-explainer.ts')
    : path.join(skillRoot, 'packages', type, `render-${type}.ts`);
}

// Default capture ceiling for piped child output. spawnSync's own default
// is 1 MiB, which is below what a dense diagram's checker receipt reaches.
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

function runNode(args: string[], options: RunNodeOptions = {}): NodeRunResult {
  const result: NodeRunResult = childProcess.spawnSync(process.execPath, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    stdio: options.stdio || 'inherit',
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  // spawnSync can report a system failure after a child has exited zero. A
  // truncated renderer result is never a successful invocation.
  if (result.error && result.status === 0) {
    result.schematicsRawStatus = result.status;
    result.status = 1;
  }
  return result;
}

type ArtifactCheckReceipt = ReturnType<typeof import('../scripts/check-render-output.ts').checkArtifact>;

async function runArtifactCheck(file: string): Promise<{ receipt: ArtifactCheckReceipt; error?: undefined } | { receipt?: undefined; error: unknown }> {
  try {
    const { checkArtifact } = await import('../scripts/check-render-output.ts');
    const resolved = path.resolve(file);
    return { receipt: checkArtifact(fs.readFileSync(resolved), { file: resolved }) };
  } catch (error) {
    return { error };
  }
}

function extractQualityArgs(args: string[]): { rest: string[]; quality: string | undefined } {
  const rest: string[] = [];
  let quality: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--quality') {
      quality = args[index + 1];
      if (!quality || quality.startsWith('--')) rejectCliArgument('--quality requires standard or showcase.', {
        code: 'cli/missing-option-value',
        subject: { option: '--quality' },
        supportedFixes: ['provide --quality standard or --quality showcase'],
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--quality=')) {
      quality = arg.slice('--quality='.length);
      if (!quality) rejectCliArgument('--quality requires standard or showcase.', {
        code: 'cli/missing-option-value',
        subject: { option: '--quality' },
        supportedFixes: ['provide --quality standard or --quality showcase'],
      });
      continue;
    }
    rest.push(arg);
  }
  if (quality !== undefined && !['standard', 'showcase'].includes(quality)) {
    rejectCliArgument(`Unknown quality profile "${quality}". Expected standard or showcase.`, {
      code: 'cli/invalid-option-value',
      subject: { option: '--quality' },
      evidence: { value: quality, supportedValues: ['standard', 'showcase'] },
      supportedFixes: ['use --quality standard or --quality showcase'],
    });
  }
  return { rest, quality };
}

function extractRepoRootArgs(args: string[]): { rest: string[]; repoRoot: string | undefined } {
  const rest: string[] = [];
  let repoRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--repo-root') {
      repoRoot = args[index + 1];
      if (!repoRoot || repoRoot.startsWith('--')) rejectCliArgument('--repo-root requires a repository path.', {
        code: 'cli/missing-option-value',
        subject: { option: '--repo-root' },
        supportedFixes: ['provide one repository path after --repo-root'],
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--repo-root=')) {
      repoRoot = arg.slice('--repo-root='.length);
      if (!repoRoot) rejectCliArgument('--repo-root requires a repository path.', {
        code: 'cli/missing-option-value',
        subject: { option: '--repo-root' },
        supportedFixes: ['provide one repository path after --repo-root'],
      });
      continue;
    }
    rest.push(arg);
  }
  return { rest, repoRoot: repoRoot ? path.resolve(repoRoot) : undefined };
}

function extractOutDirArgs(args: string[]): { rest: string[]; outDir: string | undefined } {
  const rest: string[] = [];
  let outDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--out-dir') {
      outDir = args[index + 1];
      if (!outDir || outDir.startsWith('--')) fail('--out-dir requires a directory path.');
      index += 1;
      continue;
    }
    if (arg.startsWith('--out-dir=')) {
      outDir = arg.slice('--out-dir='.length);
      if (!outDir) fail('--out-dir requires a directory path.');
      continue;
    }
    rest.push(arg);
  }
  return { rest, outDir };
}

function extractExplainerWritingArgs(args: string[]): { rest: string[]; writingMode: string | undefined } {
  const rest: string[]=[];
  let writingMode: string | undefined;
  for(let index=0;index<args.length;index++) {
    const argument=String(args[index]);
    if(argument==='--writing' || argument.startsWith('--writing=')) {
      const value=argument==='--writing' ? args[++index] : argument.slice('--writing='.length);
      if(writingMode!==undefined || value===undefined || !['warn','strict','off'].includes(value)) rejectCliArgument('--writing requires one of warn, strict or off.', {
        code:'cli/invalid-arguments',subject:{option:'--writing'},supportedFixes:['Use --writing warn, --writing strict or --writing off once.'],
      });
      writingMode=value;
    } else rest.push(argument);
  }
  if(writingMode!==undefined && rest.find(argument=>!argument.startsWith('--'))!=='explainer') rejectCliArgument('--writing is supported for explainer documents only.', {
    code:'cli/unsupported-option',subject:{option:'--writing'},supportedFixes:['Remove --writing or use an explainer document.'],
  });
  return {rest,writingMode};
}

async function prepareExplainerInput(specification: Buffer, inputPath: string, options: ExplainerInputOptions = {}) {
  const runtime = await import('../packages/explainer/prepare.ts');
  const text = specification.toString('utf8');
  if (!Buffer.from(text).equals(specification)) {
    const message='Explainer draft must contain valid UTF-8 bytes.';
    throw Object.assign(new Error(message),{schematicsDiagnostics:[diagnostic({code:'explainer/source-encoding',message,subject:{input:inputPath,line:1,component:'document'},evidence:{reason:'invalid-utf8',example:'Save the original draft as UTF-8 text.'},supportedFixes:['Save the original draft as UTF-8 text.']})]});
  }
  const bundleOptions = { checkDependencies: true, quality: options.quality, writingMode: options.writingMode || 'warn' };
  return process.env.SCHEMATICS_EXPLAINER_PREPARED
    ? runtime.readPreparedBundle(process.env.SCHEMATICS_EXPLAINER_PREPARED, text, inputPath, bundleOptions)
    : runtime.prepareExplainer(text, { ...options, inputPath });
}

function rendererEnv(quality: string | undefined, repoRoot: string | undefined, diagnosticJson = false): Record<string, string> {
  return {
    ...(quality ? { SCHEMATICS_QUALITY_PROFILE: quality } : {}),
    ...(repoRoot ? { SCHEMATICS_REPO_ROOT: repoRoot } : {}),
    ...(diagnosticJson ? { SCHEMATICS_DIAGNOSTIC_FORMAT: 'json' } : {}),
  };
}

function diagnostic({ code, message, subject = {}, evidence = {}, supportedFixes = [], edits, severity = 'error' }: DiagnosticInput): Diagnostic {
  return {
    code,
    severity,
    message,
    subject,
    evidence,
    supportedFixes,
    ...(Array.isArray(edits) && edits.length ? { edits } : {}),
  };
}

function deliveryLockFailureDiagnostic(output: string | undefined, error: unknown): Diagnostic {
  const code = fault(error).deliveryOwnershipCode || fault(error).deliveryLockCode || 'delivery/lock-acquire';
  if (code === 'delivery/legacy-pending') {
    return diagnostic({
      code,
      message: `A pre-namespace delivery journal blocks delivery for "${output}".`,
      subject: { output, journal: fault(error).deliveryLockPath },
      evidence: { pendingJournal: fault(error).deliveryLockPath, found: true },
      supportedFixes: ['recover the unfinished delivery and remove only its journal after recovery succeeds'],
    });
  }
  const lock = fault(error).deliveryOwnershipDetails?.lock
    || fault(error).deliveryLockPath
    || deliveryLockPath(requiredPath(output));
  return diagnostic({
    code,
    message: code === 'delivery/lock-release'
      ? `Delivery lock could not be released for "${output}": ${fault(error).message}`
      : code === 'delivery/ownership-lost'
        ? `Delivery ownership was lost for "${output}": ${fault(error).message}`
        : `Could not start delivery for "${output}": ${fault(error).message}`,
    subject: { output, lock },
    evidence: {
      reason: fault(error).message,
      ...(fault(error).code ? { systemCode: fault(error).code } : {}),
      ...(fault(error).lockCleanupError ? { cleanupError: fault(error).lockCleanupError } : {}),
      ...(fault(error).deliveryLockOwner || {}),
      ...(fault(error).deliveryOwnershipDetails || {}),
      ...(fault(error).deliveryCommitDetails || {}),
    },
    supportedFixes: code === 'delivery/concurrent-attempt'
        ? ['wait for the active delivery to finish, then retry']
      : code === 'delivery/lock-stale'
        ? [
          'confirm no delivery attempt is active for this output',
          `remove only the preserved lock "${lock}", then rerun deliver successfully`,
        ]
      : code === 'delivery/lock-path-conflict'
        ? ['choose an output whose lock path is distinct from the input specification']
        : code === 'delivery/lock-invalid'
          ? ['inspect and preserve the unrecognized lock entry, or choose another output path']
          : code === 'delivery/ownership-lost'
            ? ['leave the replacement lock and journal untouched, inspect the reported owner, then retry only after that attempt finishes or is recovered']
            : code === 'delivery/lock-release'
              ? ['preserve the reported lock, restore permission to remove that exact entry, then recover serially before retrying']
          : ['resolve the reported filesystem error and any lock cleanup error, then retry'],
  });
}

function deliveryJournalRecoveryDiagnostic(output: string, error: unknown): Diagnostic {
  const recovery: RecoveryInfo = fault(error).deliveryJournalRecovery || {};
  const location = recovery.recoveryDirectory
    ? ` Recovery material was retained at "${recovery.recoveryDirectory}".`
    : '';
  return diagnostic({
    code: 'delivery/journal-recovery-required',
    message: `Delivery journal publication could not be rolled back safely.${location}`,
    subject: { output, journal: recovery.journal || deliveryPendingPath(output) },
    evidence: {
      reason: fault(error).message,
      recoveryRequired: true,
      ...(recovery.recoveryDirectory ? { recoveryDirectory: recovery.recoveryDirectory } : {}),
      ...(recovery.recoveryFiles?.length ? { recoveryFiles: recovery.recoveryFiles } : {}),
      ...(recovery.rollbackErrors?.length ? { rollbackErrors: recovery.rollbackErrors } : {}),
    },
    supportedFixes: recovery.recoveryDirectory
      ? [
        'leave the delivery lock and current journal claimant untouched',
        `inspect every recovery file in ${JSON.stringify(recovery.recoveryDirectory)} and restore the previous journal only after the claimant is resolved`,
      ]
      : ['leave the delivery lock and journal untouched, inspect their current owners, then recover serially'],
  });
}

function deliveryCommitRecoveryDiagnostic(output: string, error: unknown): Diagnostic {
  const recovery: CommitDetails = fault(error).deliveryCommitDetails || {};
  return diagnostic({
    code: 'delivery/commit-recovery-required',
    message: `Delivery rollback could not safely restore the previous output pair for "${output}".`,
    subject: { output },
    evidence: {
      reason: recovery.reason || fault(error).message,
      recoveryRequired: true,
      ...(recovery.recoveryDirectory ? { recoveryDirectory: recovery.recoveryDirectory } : {}),
      ...(recovery.recoverableBackups?.length
        ? { recoverableBackups: recovery.recoverableBackups }
        : {}),
      ...(recovery.rollbackErrors?.length ? { rollbackErrors: recovery.rollbackErrors } : {}),
    },
    supportedFixes: [
      'leave the delivery lock, journal, current claimants, and retained backups untouched',
      'inspect the reported files and restore the previous pair only after resolving every claimant',
    ],
  });
}

function deliveryTargetStateDiagnostic(output: string, role: string, result: RelationLike | undefined): Diagnostic {
  const reason: ReasonLike = result?.reason || { code: 'target-state-unavailable' };
  const hardlinked = typeof reason.code === 'string' && reason.code.endsWith('-hardlinked');
  const provenanceTarget = /provenance/iu.test(role);
  const code = hardlinked
    ? provenanceTarget ? 'delivery/provenance-hardlink-unsupported' : 'output/target-hardlinked'
    : ['target-not-regular-file', 'requested-entry-symbolic-link', 'requested-entry-not-regular-file'].includes(String(reason.code))
      ? 'output/target-not-regular-file'
      : result?.status === 'different'
        ? 'output/target-changed'
        : 'output/target-indeterminate';
  const message = hardlinked
    ? `The ${role} target is hard-linked and cannot be replaced atomically.`
    : code === 'output/target-not-regular-file'
      ? `The ${role} target is not a regular file.`
      : code === 'output/target-changed'
        ? `The ${role} target changed while the verified delivery pair was being prepared.`
        : `The ${role} target identity could not be determined safely.`;
  return diagnostic({
    code,
    message,
    subject: { output: path.resolve(output), role },
    evidence: { targetState: reason },
    supportedFixes: hardlinked
      ? ['remove extra hard links or choose a new output path, then rerun deliver']
      : code === 'output/target-not-regular-file'
        ? ['choose an absent or regular-file target, then rerun deliver']
        : code === 'output/target-changed'
          ? ['retry only after other processes stop creating, replacing, retargeting, or changing the output pair']
          : ['use an ordinary local filesystem path with stable file identity, then retry'],
  });
}

function deliveryTargetStateError(output: string, role: string, result: RelationLike | undefined): SchematicsError {
  const issue = deliveryTargetStateDiagnostic(output, role, result);
  const error: SchematicsError = new Error(issue.message);
  error.schematicsDiagnostics = [issue];
  error.deliveryTargetState = result;
  return error;
}

function captureDeliveryTargetState({
  state,
  requestedOutput,
  pathsAlias,
  captureAtomicOutput,
  verifyAtomicOutput,
  preparedTargets,
}: {
  state: DeliveryOwnershipState | undefined;
  requestedOutput: string;
  pathsAlias: PathsAlias;
  captureAtomicOutput?: typeof AtomicOutput.captureAtomicOutput;
  verifyAtomicOutput?: typeof AtomicOutput.verifyAtomicOutput;
  preparedTargets?: { artifact?: RequestedCapture; provenance?: RequestedCapture };
}): { artifact: AtomicOutput.CapturedAtomicOutput & { requestedPath: string }; provenance: AtomicOutput.CapturedAtomicOutput & { requestedPath: string } } {
  if (typeof captureAtomicOutput !== 'function' || typeof verifyAtomicOutput !== 'function') {
    throw deliveryTargetStateError(requestedOutput, 'delivery pair', {
      status: 'unknown',
      reason: { code: 'atomic-output-runtime-unavailable' },
    });
  }
  const artifactTarget = preparedTargets?.artifact || {
    requestedPath: requestedOutput,
    ...captureAtomicOutput(requestedOutput),
  };
  if (artifactTarget.status !== 'captured') {
    throw deliveryTargetStateError(requestedOutput, 'HTML artifact', artifactTarget);
  }
  if (!state) throw new TypeError('The delivery ownership state is unavailable.');
  if (!pathsAlias(artifactTarget.commitPath, state.output)) {
    throw deliveryTargetStateError(requestedOutput, 'HTML artifact', {
      status: 'different',
      reason: {
        code: 'write-slot-changed-before-snapshot',
        plannedCommitPath: state.output,
        currentCommitPath: artifactTarget.commitPath,
      },
    });
  }
  const requestedProvenancePath = preparedTargets?.provenance?.requestedPath
    || deliveryProvenancePath(artifactTarget.commitPath);
  const provenanceTarget = preparedTargets?.provenance || {
    requestedPath: requestedProvenancePath,
    ...captureAtomicOutput(requestedProvenancePath, {
      requestedEntryPolicy: 'regular-or-absent',
    }),
  };
  if (provenanceTarget.status !== 'captured') {
    throw deliveryTargetStateError(requestedProvenancePath, 'delivery provenance', provenanceTarget);
  }
  for (const [role, target] of [
    ['HTML artifact', artifactTarget],
    ['delivery provenance', provenanceTarget],
  ] as const) {
    const verification = verifyAtomicOutput(target.snapshot);
    if (verification.status !== 'match') {
      throw deliveryTargetStateError(target.requestedPath, role, verification);
    }
  }
  state.output = artifactTarget.commitPath;
  state.provenancePath = provenanceTarget.commitPath;
  state.pendingPath = deliveryPendingPath(artifactTarget.commitPath);
  state.verifyAtomicOutput = verifyAtomicOutput;
  const deliveryTargets = {
    artifact: artifactTarget,
    provenance: provenanceTarget,
  };
  state.deliveryTargets = deliveryTargets;
  return deliveryTargets;
}

function inputDiagnostic(error: unknown, inputPath: string): Diagnostic {
  const isSyntax = error instanceof SyntaxError;
  return diagnostic({
    code: isSyntax ? 'input/json-parse' : 'input/read',
    message: isSyntax
      ? `Input JSON could not be parsed: ${fault(error).message}`
      : `Input could not be read: ${fault(error).message}`,
    subject: { input: inputPath },
    evidence: {
      ...(fault(error).code ? { systemCode: fault(error).code } : {}),
      reason: fault(error).message,
    },
    supportedFixes: [isSyntax
      ? 'repair the JSON syntax and run validation again'
      : 'provide one readable JSON input file'],
  });
}

function rendererFailure(result: NodeRunResult): { error: string; diagnostics: Diagnostic[] } {
  if (result.error) {
    return {
      error: 'Renderer process could not start.',
      diagnostics: [diagnostic({
        code: 'internal/renderer-process',
        message: 'Renderer process could not start.',
        evidence: { reason: result.error.message },
      })],
    };
  }
  try {
    const payload = JSON.parse((result.stderr || '').trim());
    if (payload?.ok === false && Array.isArray(payload.diagnostics) && payload.diagnostics.length) {
      return {
        error: payload.error || payload.diagnostics[0].message,
        diagnostics: payload.diagnostics,
      };
    }
  } catch {
    // The diagnostic boundary is intentionally fail-closed. Never copy a raw
    // Node stack into a machine receipt when a renderer exits unexpectedly.
  }
  return {
    error: 'Renderer failed before emitting a structured diagnostic.',
    diagnostics: [diagnostic({
      code: 'internal/unclassified',
      message: 'Renderer failed before emitting a structured diagnostic.',
      evidence: { exitCode: result.status ?? 1 },
    })],
  };
}

const COMPOSITION_CHECKS = new Set([
  'label_route_clearance',
  'relationship_crossings',
  'relationship_corridors',
  'container_border_runs',
  'route_rhythm',
]);

const CHECK_FIXES: Record<string, string[]> = {
  single_svg: ['remove additional SVG roots so the artifact contains exactly one diagram SVG'],
  finite_svg: ['replace non-finite coordinates before rendering again'],
  orthogonal_arrows: ['use renderer-supported orthogonal routing controls'],
  legend_clearance: ['move the route or enlarge the viewBox so relationships do not enter the legend'],
};

const COMPOSITION_FIXES: Record<string, string[]> = {
  'composition/proper-crossing': ['if authored via/route/channelX/channelY controls exist and are not required by the user, remove them to let the renderer re-plan; otherwise preserve that intent and adjust route/via or channel coordinates so unrelated relationships use separate corridors'],
  'composition/ambiguous-corridor': ['if authored via/route/channelX/channelY controls exist and are not required by the user, remove them to let the renderer re-plan; otherwise preserve that intent and adjust route/via or channel coordinates so unrelated relationships do not visually merge'],
  'composition/container-border-run': ['if authored via/route/channelX/channelY controls exist and are not required by the user, remove them to let the renderer re-plan; otherwise preserve that intent and route across the frame perpendicularly through a clear opening'],
  'composition/label-route-clearance': ['if authored labelAt/labelDx/labelDy/labelSegment controls exist and are not required by the user, remove them to let the renderer re-plan; otherwise preserve that intent and adjust labelAt, labelDx, labelDy, labelSegment, message y, or the other relationship route'],
  'composition/label-canvas-containment': ['if authored labelAt/labelDx/labelDy/labelSegment controls exist and are not required by the user, remove them to let the renderer re-plan; otherwise preserve that intent and adjust labelAt, labelDx, labelDy, or labelSegment so the label rect stays inside the viewBox, or enlarge meta.viewBox'],
  'composition/micro-segment': ['if authored via/route/channelX/channelY controls exist and are not required by the user, remove them to let the renderer re-plan; otherwise preserve that intent and move the route/channel/via point so every visible segment is at least 8px'],
  'composition/short-interior-segment': ['if authored via/route/channelX/channelY controls exist and are not required by the user, remove them to let the renderer re-plan; otherwise preserve that intent and move the route/channel/via point so every interior turn has at least 16px'],
};

function checkerDiagnostics(checker: CheckerReceipt | null | undefined): Diagnostic[] {
  if (checker?.family === 'explainer' && checker.diagnostics?.some(entry => entry.severity === 'error')) return checker.diagnostics.filter(entry => entry.severity === 'error').map(entry => diagnostic(entry));
  const diagnostics: Diagnostic[] = [];
  for (const issue of checker?.composition?.issues || []) {
    if (issue.severity !== 'error') continue;
    const { severity, code, relationship, nodeId, ...evidence } = issue;
    diagnostics.push(diagnostic({
      code,
      severity,
      message: `Final artifact failed ${code}.`,
      subject: relationship ? { relationship } : { check: 'composition', ...(nodeId ? { nodeId } : {}) },
      evidence,
      supportedFixes: compositionFixes(issue),
    }));
  }
  for (const check of checker?.checks || []) {
    if (check.ok || COMPOSITION_CHECKS.has(check.name)) continue;
    if (check.name === 'svg_path_data') {
      const pathDiagnostics = (checker?.diagnostics || []).filter(item => (
        item?.severity === 'error'
        && ['artifact/svg-path-malformed', 'artifact/svg-path-unsupported'].includes(item.code)
      ));
      if (pathDiagnostics.length) {
        diagnostics.push(...pathDiagnostics.map(item => diagnostic(item)));
        continue;
      }
    }
    diagnostics.push(diagnostic({
      code: `artifact/${check.name.replaceAll('_', '-')}`,
      message: (check.details || []).find(Boolean) || `Final artifact failed ${check.name}.`,
      subject: { check: check.name },
      evidence: { details: check.details || [] },
      supportedFixes: CHECK_FIXES[check.name] || [],
    }));
  }
  return diagnostics.length ? diagnostics : [diagnostic({
    code: 'artifact/check-failed',
    message: 'Final artifact check failed without a classified diagnostic.',
    subject: { check: 'unknown' },
    evidence: {},
  })];
}

function compositionFixes(issue: CheckerIssue): string[] {
  if (issue.code === 'composition/viewport-height') return [String(issue.detail || '').replace(/^\[[^\]]+\]\s*/, '')];
  if (issue.code !== 'composition/desktop-readability') return COMPOSITION_FIXES[issue.code] || [];
  const sourceFontPx = Number(issue.sourceFontPx);
  const actualBudgetPx = Number(issue.availableDiagramWidth);
  const hardFloorPx = Number(issue.minimumProjectedFontPx);
  const viewBoxWidth = Number(issue.viewBoxWidth);
  const preserveIntent = 'Preserve the semantic text and any supplied coordinates, routes, sides, channels, and labels.';
  const readerCap = issue.budgetBasis === 'recognized-declared-wide'
    ? ` The declared Reader reports a ${issue.budgetLimit} limit and ${actualBudgetPx}px actual diagram budget; do not assume an uncapped viewport.`
    : '';
  if (![sourceFontPx, actualBudgetPx, hardFloorPx, viewBoxWidth].every(Number.isFinite)
    || actualBudgetPx <= 0 || hardFloorPx <= 0 || viewBoxWidth <= 0) {
    return [`${preserveIntent} Repair the measured source font, desktop budget, or complete viewBox width; position-only label controls do not change projected text size.`];
  }
  if (sourceFontPx < hardFloorPx) {
    return [`${preserveIntent} The diagnosed ${sourceFontPx}px source text is below the ${hardFloorPx}px hard floor even at scale 1, so use a renderer-supported semantic text-size setting or renderer-level fix. Position-only label controls cannot repair its projection.${readerCap}`];
  }
  const maximumViewBoxWidth = Math.floor((sourceFontPx * actualBudgetPx) / hardFloorPx);
  return [`${preserveIntent} Compactly reflow automatic spacing and empty corridors so the complete viewBox width is at most ${maximumViewBoxWidth}px (current ${viewBoxWidth}px; ${sourceFontPx}px source text at ${actualBudgetPx}px desktop budget). If supplied geometry fixes that width, use a renderer-supported semantic text-size setting or renderer-level fix instead. Position-only label controls cannot repair its projection.${readerCap}`];
}

interface FormattedDiagnostic {
  code?: unknown;
  message?: unknown;
  supportedFixes?: unknown;
}

function formatDiagnostics(error: unknown, diagnostics: readonly unknown[] = []): unknown {
  if (!diagnostics.length) return error;
  return [
    error,
    ...diagnostics.map((value) => {
      const entry: FormattedDiagnostic = typeof value === 'object' && value !== null ? value : {};
      const fixes = entry.supportedFixes;
      const fix = Array.isArray(fixes) && fixes.length ? ` Fix: ${fixes.join('; ')}.` : '';
      return `[${entry.code}] ${entry.message}${fix}`;
    }),
  ].join('\n');
}

function exitFrom(result: { error?: Error; status: number | null }): never {
  if (result.error) fail(result.error.message, 1);
  process.exit(result.status ?? 1);
}

function reportCompareFailure({ json, stage, error, code = 'delta/internal', details = {}, status = 1 }: {
  json?: boolean;
  stage: string | undefined;
  error: string | undefined;
  code?: string | undefined;
  details?: CompareFailureDetails | undefined;
  status?: number;
}): void {
  const receipt = {
    schemaVersion: 1,
    ok: false,
    command: 'compare',
    type: 'architecture',
    stage,
    error,
    diagnostics: [{
      code,
      severity: 'error',
      message: error,
      subject: details.side ? { side: details.side, ...(details.path ? { path: details.path } : {}) } : {},
      evidence: Object.fromEntries(Object.entries(details).filter(([key]) => !['side', 'path', 'supportedFixes'].includes(key))),
      supportedFixes: details.supportedFixes || [],
    }],
  };
  if (json) console.log(JSON.stringify(receipt, null, 2));
  else console.error(formatDiagnostics(error, receipt.diagnostics));
  process.exitCode = status;
}

function extractCompareOptions(args: string[]): { positional: string[]; receipt: string | undefined; json: boolean } {
  const positional: string[] = [];
  let receipt: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--receipt') {
      receipt = args[index + 1];
      if (!receipt || receipt.startsWith('--')) fail('--receipt requires a JSON output path.');
      index += 1;
      continue;
    }
    if (arg.startsWith('--receipt=')) {
      receipt = arg.slice('--receipt='.length);
      if (!receipt) fail('--receipt requires a JSON output path.');
      continue;
    }
    if (arg.startsWith('--')) fail(`Unknown compare option "${arg}".`);
    positional.push(arg);
  }
  return { positional, receipt, json };
}

function compareReceiptPath(outputPath: string): string {
  const { directory, stem, options } = deliverySidecarNamespace(outputPath);
  return path.join(
    directory,
    `${boundedSidecarStem(stem, COMPARE_SIDECAR_SUFFIXES, options)}.receipt.json`,
  );
}

function compareCommitError(message: string | undefined, code: string, details: CompareFailureDetails = {}): SchematicsError {
  const error: SchematicsError = new Error(message);
  error.compareStage = 'commit';
  error.compareCode = code;
  error.compareDetails = details;
  return error;
}

function compareAtomicOutputFailure(result: RelationLike, label: string, requestedPath: string, stage: string): CompareFailure {
  const reason: ReasonLike = result.reason || { code: 'atomic-output-unknown' };
  let code = 'output/target-indeterminate';
  let message = `The compare ${label} target identity could not be verified safely.`;
  let supportedFixes = ['use an ordinary local filesystem path with stable file identity, then retry'];
  if (typeof reason.code === 'string' && reason.code.endsWith('-hardlinked')) {
    code = 'output/target-hardlinked';
    message = `The compare ${label} target has multiple hard links and cannot be replaced atomically.`;
    supportedFixes = [`choose a ${label} path that is absent or names a regular file with one link`];
  } else if (reason.code === 'target-not-regular-file') {
    code = 'output/target-not-regular-file';
    message = `The compare ${label} target is not a regular file.`;
    supportedFixes = [`choose an absent or regular-file path for the ${label}`];
  } else if (result.status === 'different') {
    code = 'output/target-changed';
    message = `The compare ${label} target changed while the artifact pair was being prepared.`;
    supportedFixes = ['retry after other processes stop creating, replacing, or redirecting compare outputs'];
  }
  return {
    stage,
    code,
    message,
    details: {
      side: label,
      path: requestedPath,
      atomicOutput: reason,
      supportedFixes,
    },
  };
}

function commitComparePair({
  htmlCandidate,
  htmlContent,
  receiptCandidate,
  receiptContent,
  outputCapture,
  receiptCapture,
  stagingDirectory,
  verifyAtomicOutput,
  fileBindingRuntime,
}: {
  htmlCandidate: string;
  htmlContent: DeliveryContent;
  receiptCandidate: string;
  receiptContent: DeliveryContent;
  outputCapture: AtomicOutput.CapturedAtomicOutput;
  receiptCapture: AtomicOutput.CapturedAtomicOutput;
  stagingDirectory: string;
  verifyAtomicOutput: typeof AtomicOutput.verifyAtomicOutput;
  fileBindingRuntime?: FileBindingRuntime;
}): { ownedBackupEntries: StagingEntry[] } {
  const {
    backupPublicRegularFileBinding,
    captureRegularFileBinding,
    quarantineRemoveRegularFileBinding,
    verifyRegularFileBinding,
    releaseRegularFileBinding,
  } = fileBindingRuntime || {};
  const targets: [CompareTarget, CompareTarget] = [
    {
      label: 'HTML artifact', capture: outputCapture, candidate: htmlCandidate, content: htmlContent, backup: path.join(stagingDirectory, '.previous-output'),
    },
    {
      label: 'receipt', capture: receiptCapture, candidate: receiptCandidate, content: receiptContent, backup: path.join(stagingDirectory, '.previous-receipt'),
    },
  ];
  const targetChanged = (item: CompareTarget, result: RelationLike | string) => {
    const normalized: RelationLike = typeof result === 'string'
      ? { status: 'different', reason: { code: result } }
      : result;
    const failure = compareAtomicOutputFailure(
      normalized,
      item.label,
      item.capture.snapshot.requestedPath,
      'commit',
    );
    const error = compareCommitError(failure.message, failure.code, failure.details);
    error.compareFailure = failure;
    return error;
  };

  const backedUp: CompareTarget[] = [];
  const committed: CompareTarget[] = [];
  let retainSuccessfulBackupBindings = false;
  try {
    if (typeof backupPublicRegularFileBinding !== 'function'
      || typeof captureRegularFileBinding !== 'function'
      || typeof quarantineRemoveRegularFileBinding !== 'function'
      || typeof verifyRegularFileBinding !== 'function'
      || typeof releaseRegularFileBinding !== 'function') {
      throw targetChanged(targets[0], {
        status: 'unknown',
        reason: { code: 'atomic-output-runtime-unavailable' },
      });
    }
    // Re-resolve and bind both requested write slots and candidate inodes
    // before moving either target. The held handles keep bytes, mode and
    // identity authoritative across every publish/finalize transition.
    for (const item of targets) {
      const verification = verifyAtomicOutput(item.capture.snapshot);
      if (verification.status !== 'match') throw targetChanged(item, verification);
      if (item.capture.mode !== null) fs.chmodSync(item.candidate, item.capture.mode);
      const candidate = captureRegularFileBinding(item.candidate, {
        subject: 'compare-candidate',
        expectedSha256: item.content.sha256,
        expectedBytes: item.content.bytes,
        ...(item.capture.mode === null ? {} : { expectedMode: item.capture.mode }),
        expectedLinks: 1,
      });
      if (candidate.status !== 'captured') throw targetChanged(item, candidate);
      item.candidateBinding = candidate.binding;
      item.candidatePresent = true;
      item.candidateIdentity = {
        dev: candidate.identity.device,
        ino: candidate.identity.inode,
      };
      item.candidateMode = candidate.mode;
      if (item.capture.snapshot.target.kind === 'file') {
        const expected = item.capture.snapshot.target;
        const previous = captureRegularFileBinding(item.capture.commitPath, {
          subject: 'previous-compare-target',
          expectedIdentity: { device: expected.device, inode: expected.inode },
          expectedMode: expected.mode,
          expectedLinks: 1,
        });
        if (previous.status !== 'captured') throw targetChanged(item, previous);
        item.previousBinding = previous.binding;
      }
    }
    for (const item of targets) {
      if (item.capture.snapshot.target.kind !== 'file') continue;
      const moved = backupPublicRegularFileBinding(
        item.previousBinding ?? UNBOUND_FILE,
        item.capture.commitPath,
        item.backup,
        { subject: 'previous-compare-target' },
      );
      item.backupPresent = moved.backupCreated === true;
      item.backupVerified = moved.backupVerified === true;
      if (item.backupPresent) backedUp.push(item);
      if (moved.status === 'recovery-required' && moved.recoveryFile) {
        item.backupRecovery = moved.recoveryFile;
      }
      if (moved.status !== 'backed-up') throw targetChanged(item, moved);
    }
    for (const item of targets) {
      const candidate = verifyRegularFileBinding(item.candidateBinding ?? UNBOUND_FILE, {
        filePath: item.candidate,
        expectedLinks: 1,
      });
      if (candidate.status !== 'match') throw targetChanged(item, candidate);
      try {
        // linkSync is the no-clobber publish primitive: unlike renameSync, it
        // fails with EEXIST if another writer claims an absent slot after the
        // final snapshot verification.
        fs.linkSync(item.candidate, item.capture.commitPath);
      } catch (error) {
        if (fault(error).code === 'EEXIST') {
          throw targetChanged(
            item,
            'target-claimed-during-publish',
          );
        }
        throw error;
      }
      item.committedIdentity = item.candidateIdentity;
      committed.push(item);
      const linked = verifyRegularFileBinding(item.candidateBinding ?? UNBOUND_FILE, {
        filePath: item.capture.commitPath,
        expectedLinks: 2,
      });
      if (linked.status !== 'match') throw targetChanged(item, linked);
    }
    for (const item of committed) {
      const current = verifyRegularFileBinding(item.candidateBinding ?? UNBOUND_FILE, {
        filePath: item.capture.commitPath,
        expectedLinks: 2,
      });
      if (current.status !== 'match') throw targetChanged(item, current);
    }
    // The target remains the durable link. Removing the staging links inside
    // the transaction keeps successful outputs at nlink=1 even if the outer
    // best-effort staging-directory cleanup later fails.
    for (const item of committed) {
      const staged = verifyRegularFileBinding(item.candidateBinding ?? UNBOUND_FILE, {
        filePath: item.candidate,
        expectedLinks: 2,
      });
      if (staged.status !== 'match') throw targetChanged(item, staged);
      const retired = quarantineRemoveRegularFileBinding(
        item.candidateBinding ?? UNBOUND_FILE,
        item.candidate,
        { subject: 'compare-candidate', expectedLinks: 2 },
      );
      if (retired.status !== 'removed') throw targetChanged(item, retired);
      item.candidatePresent = false;
    }
    for (const item of committed) {
      const finalized = verifyRegularFileBinding(item.candidateBinding ?? UNBOUND_FILE, {
        filePath: item.capture.commitPath,
        expectedLinks: 1,
      });
      if (finalized.status !== 'match') throw targetChanged(item, finalized);
    }
    retainSuccessfulBackupBindings = true;
    return {
      ownedBackupEntries: backedUp
        .filter((item) => item.backupPresent)
        .map((item) => ({
          filePath: item.backup,
          binding: item.previousBinding ?? UNBOUND_FILE,
          subject: 'previous-compare-backup',
          expectedLinks: 1,
        })),
    };
  } catch (cause) {
    const rollbackErrors: Array<string | undefined> = [];
    const recoveryFiles: CompareRecoveryFile[] = targets
      .filter((item) => item.backupRecovery)
      .map((item) => ({
        backup: item.backupRecovery,
        target: item.capture.commitPath,
        verifiedPrevious: false,
      }));
    for (const item of [...committed].reverse()) {
      try {
        const removed = present(quarantineRemoveRegularFileBinding)(
          item.candidateBinding ?? UNBOUND_FILE,
          item.capture.commitPath,
          {
            subject: 'published-compare-target',
            expectedLinks: item.candidatePresent ? 2 : 1,
          },
        );
        if (removed.status !== 'removed') {
          if (removed.status === 'recovery-required') {
            recoveryFiles.push({
              backup: removed.recoveryFile,
              target: item.capture.commitPath,
            });
          }
          throw new Error(`the committed target could not be removed safely (${removed.reason?.code || 'unknown target state'})`);
        }
      } catch (error) {
        rollbackErrors.push(`${item.label}: remove failed (${fault(error).message})`);
      }
    }
    for (const item of [...backedUp].reverse()) {
      try {
        if (pathEntryExists(item.capture.commitPath)) {
          const current: RelationLike = item.candidateBinding
            ? present(verifyRegularFileBinding)(item.candidateBinding, {
              filePath: item.capture.commitPath,
              expectedLinks: item.candidatePresent ? 2 : 1,
            })
            : { status: 'different' };
          if (current.status !== 'match') {
            throw new Error(`a changed target claimant prevents restoring the previous file (${current.reason?.code || 'unknown target state'})`);
          }
          const removed = present(quarantineRemoveRegularFileBinding)(
            item.candidateBinding ?? UNBOUND_FILE,
            item.capture.commitPath,
            {
              subject: 'published-compare-target',
              expectedLinks: item.candidatePresent ? 2 : 1,
            },
          );
          if (removed.status !== 'removed') {
            if (removed.status === 'recovery-required') {
              recoveryFiles.push({
                backup: removed.recoveryFile,
                target: item.capture.commitPath,
              });
            }
            throw new Error(`the committed target could not be removed safely (${removed.reason?.code || 'unknown target state'})`);
          }
        }
        if (item.backupVerified !== true) {
          throw new Error('the backup entry was never verified as the previous file');
        }
        const currentBackup = present(verifyRegularFileBinding)(item.previousBinding ?? UNBOUND_FILE, {
          filePath: item.backup,
          expectedLinks: 1,
        });
        if (currentBackup.status !== 'match') {
          item.backupVerified = false;
          throw new Error('the recoverable backup was replaced before rollback');
        }
        // Publish the previous file without clobbering a claimant that appears
        // after the absence check. The backup remains the recovery source until
        // the restored hard link has been identity-verified.
        fs.linkSync(item.backup, item.capture.commitPath);
        for (const restoredPath of [item.capture.commitPath, item.backup]) {
          const restored = present(verifyRegularFileBinding)(item.previousBinding ?? UNBOUND_FILE, {
            filePath: restoredPath,
            expectedLinks: 2,
          });
          if (restored.status !== 'match') {
            throw new Error('the restored target identity could not be verified');
          }
        }
        const retired = present(quarantineRemoveRegularFileBinding)(
          item.previousBinding ?? UNBOUND_FILE,
          item.backup,
          { subject: 'previous-compare-target', expectedLinks: 2 },
        );
        if (retired.status !== 'removed') {
          throw new Error(`the restored backup could not be retired safely (${retired.reason?.code || 'unknown target state'})`);
        }
        item.backupPresent = false;
        const finalized = present(verifyRegularFileBinding)(item.previousBinding ?? UNBOUND_FILE, {
          filePath: item.capture.commitPath,
          expectedLinks: 1,
        });
        if (finalized.status !== 'match') {
          throw new Error('the restored target changed before rollback finalized');
        }
      } catch (error) {
        rollbackErrors.push(`${item.label}: restore failed (${fault(error).message})`);
        // Track failed restoration rather than probing existence: a permission
        // error must not make cleanup discard a potentially recoverable backup.
        if (item.backupPresent !== false) {
          recoveryFiles.push({
            backup: item.backup,
            target: item.capture.commitPath,
            verifiedPrevious: item.backupVerified === true,
          });
        }
      }
    }
    const compareFailure = fault(cause).compareFailure;
    if (!rollbackErrors.length && compareFailure) {
      throw compareCommitError(
        fault(cause).message,
        compareFailure.code,
        {
          ...compareFailure.details,
          reason: fault(cause).message,
        },
      );
    }
    throw compareCommitError(
      (rollbackErrors.length
        ? 'Architecture Delta pair commit failed and its previous files could not be fully restored.'
        : 'Architecture Delta pair commit failed; the previous files were restored.')
        + (recoveryFiles.length
          ? ` Recovery directory retained at ${path.dirname(requiredPath(recoveryFiles[0]?.backup))}.`
          : ''),
      rollbackErrors.length ? 'delta/commit-rollback-failed' : 'delta/commit-failed',
      {
        reason: fault(cause).message,
        ...(rollbackErrors.length ? { rollbackErrors } : {}),
        ...(recoveryFiles.length ? {
          recoveryDirectory: path.dirname(requiredPath(recoveryFiles[0]?.backup)),
          recoveryDirectories: [...new Set(recoveryFiles.map(({ backup }) => path.dirname(requiredPath(backup))))],
          recoveryFiles,
        } : {}),
        supportedFixes: recoveryFiles.length
          ? [
            ...recoveryFiles.map(({ backup, target, verifiedPrevious }) => verifiedPrevious
              ? `resolve the filesystem error, inspect the current target, then restore ${JSON.stringify(backup)} to ${JSON.stringify(target)} before retrying`
              : `preserve and inspect the unverified entry at ${JSON.stringify(backup)}; do not treat it as the previous file for ${JSON.stringify(target)}`),
            'remove the recovery directory only after the previous files have been recovered and verified',
          ]
          : ['check that both output paths are writable regular files, then retry'],
      },
    );
  } finally {
    for (const item of targets) {
      if (item.candidateBinding) present(releaseRegularFileBinding)(item.candidateBinding);
      if (item.previousBinding
        && !(retainSuccessfulBackupBindings && item.backupPresent)) {
        present(releaseRegularFileBinding)(item.previousBinding);
      }
    }
  }
}

function commitDeliveryPair({
  htmlCandidate,
  htmlContent,
  provenanceCandidate,
  provenanceContent,
  stagingDirectory,
  ownership,
  verifyAtomicOutput,
  fileBindingRuntime,
}: {
  htmlCandidate: string;
  htmlContent: DeliveryContent;
  provenanceCandidate: string;
  provenanceContent: DeliveryContent;
  stagingDirectory: string;
  ownership: DeliveryOwnership;
  verifyAtomicOutput: typeof AtomicOutput.verifyAtomicOutput;
  fileBindingRuntime?: FileBindingRuntime;
}): { recoverableBackups: RecoveryFile[]; ownedBackupEntries: StagingEntry[] } {
  const {
    backupPublicRegularFileBinding,
    captureRegularFileBinding,
    quarantineRemoveRegularFileBinding,
    verifyRegularFileBinding,
    releaseRegularFileBinding,
  } = fileBindingRuntime || {};
  const state = assertDeliveryOwnership(ownership, 'start the delivery pair commit', { pending: 'owned' });
  const snapshots = state.deliveryTargets;
  if (!snapshots?.artifact || !snapshots?.provenance) {
    throw deliveryTargetStateError(state.output, 'delivery pair', {
      status: 'unknown',
      reason: { code: 'target-snapshot-missing' },
    });
  }
  const targets: [DeliveryPairTarget, DeliveryPairTarget] = [
    {
      label: 'HTML artifact',
      target: snapshots.artifact.commitPath,
      candidate: htmlCandidate,
      content: htmlContent,
      backup: path.join(stagingDirectory, '.previous-output'),
      capture: snapshots.artifact,
    },
    {
      label: 'delivery provenance',
      target: snapshots.provenance.commitPath,
      candidate: provenanceCandidate,
      content: provenanceContent,
      backup: path.join(stagingDirectory, '.previous-provenance'),
      capture: snapshots.provenance,
    },
  ];
  const backedUp: DeliveryPairTarget[] = [];
  const retainedBackups = new Set<DeliveryPairTarget>();
  const publicRecoveryBackups: RecoveryFile[] = [];
  let retainSuccessfulBackupBindings = false;
  const committed: DeliveryPairTarget[] = [];
  try {
    if (typeof backupPublicRegularFileBinding !== 'function'
      || typeof captureRegularFileBinding !== 'function'
      || typeof quarantineRemoveRegularFileBinding !== 'function'
      || typeof verifyRegularFileBinding !== 'function'
      || typeof releaseRegularFileBinding !== 'function') {
      throw deliveryTargetStateError(state.output, 'delivery pair', {
        status: 'unknown',
        reason: { code: 'atomic-output-runtime-unavailable' },
      });
    }
    for (const item of targets) {
      const verification = verifyAtomicOutput(item.capture.snapshot);
      if (verification.status !== 'match') {
        throw deliveryTargetStateError(item.capture.requestedPath, item.label, verification);
      }
      if (item.capture.mode !== null) fs.chmodSync(item.candidate, item.capture.mode);
      const candidate = captureRegularFileBinding(item.candidate, {
        subject: 'delivery-candidate',
        expectedSha256: item.content.sha256,
        expectedBytes: item.content.bytes,
        ...(item.capture.mode === null ? {} : { expectedMode: item.capture.mode }),
        expectedLinks: 1,
      });
      if (candidate.status !== 'captured') {
        throw deliveryTargetStateError(item.capture.requestedPath, item.label, candidate);
      }
      item.candidateBinding = candidate.binding;
      item.candidatePresent = true;
      item.candidateIdentity = {
        dev: candidate.identity.device,
        ino: candidate.identity.inode,
      };
      item.candidateMode = candidate.mode;
      if (item.capture.snapshot.target.kind === 'file') {
        const expected = item.capture.snapshot.target;
        const previous = captureRegularFileBinding(item.target, {
          subject: 'previous-delivery-target',
          expectedIdentity: { device: expected.device, inode: expected.inode },
          expectedMode: expected.mode,
          expectedLinks: 1,
        });
        if (previous.status !== 'captured') {
          throw deliveryTargetStateError(item.capture.requestedPath, item.label, previous);
        }
        item.previousBinding = previous.binding;
      }
    }
    for (const item of targets) {
      if (item.capture.snapshot.target.kind !== 'file') continue;
      assertDeliveryOwnership(ownership, `back up the ${item.label}`, { pending: 'owned' });
      const moved = backupPublicRegularFileBinding(
        item.previousBinding ?? UNBOUND_FILE,
        item.target,
        item.backup,
        { subject: 'previous-delivery-target' },
      );
      item.backupPresent = moved.backupCreated === true;
      item.backupVerified = moved.backupVerified === true;
      if (item.backupPresent) backedUp.push(item);
      if (moved.status === 'recovery-required' && moved.recoveryFile) {
        publicRecoveryBackups.push({
          label: `preserved replacement for ${item.label}`,
          path: moved.recoveryFile,
          target: item.target,
        });
      }
      if (moved.status !== 'backed-up') {
        throw deliveryTargetStateError(item.capture.requestedPath, item.label, moved);
      }
      retainedBackups.add(item);
    }
    for (const item of targets) {
      assertDeliveryOwnership(ownership, `commit the ${item.label}`, { pending: 'owned' });
      const candidate = verifyRegularFileBinding(item.candidateBinding ?? UNBOUND_FILE, {
        filePath: item.candidate,
        expectedLinks: 1,
      });
      if (candidate.status !== 'match') {
        throw deliveryTargetStateError(item.capture.requestedPath, item.label, candidate);
      }
      try {
        fs.linkSync(item.candidate, item.target);
      } catch (error) {
        if (fault(error).code === 'EEXIST') {
          throw deliveryTargetStateError(item.capture.requestedPath, item.label, {
            status: 'different',
            reason: { code: 'target-claimed-during-publish' },
          });
        }
        throw error;
      }
      item.committedIdentity = item.candidateIdentity;
      committed.push(item);
      const linked = verifyRegularFileBinding(item.candidateBinding ?? UNBOUND_FILE, {
        filePath: item.target,
        expectedLinks: 2,
      });
      if (linked.status !== 'match') {
        throw deliveryTargetStateError(item.capture.requestedPath, item.label, linked);
      }
    }
    for (const item of committed) {
      assertDeliveryOwnership(ownership, `verify the committed ${item.label}`, { pending: 'owned' });
      const current = verifyRegularFileBinding(item.candidateBinding ?? UNBOUND_FILE, {
        filePath: item.target,
        expectedLinks: 2,
      });
      if (current.status !== 'match') {
        throw deliveryTargetStateError(item.capture.requestedPath, item.label, current);
      }
    }
    for (const item of committed) {
      const staged = verifyRegularFileBinding(item.candidateBinding ?? UNBOUND_FILE, {
        filePath: item.candidate,
        expectedLinks: 2,
      });
      if (staged.status !== 'match') {
        throw deliveryTargetStateError(item.capture.requestedPath, item.label, staged);
      }
      const retired = quarantineRemoveRegularFileBinding(
        item.candidateBinding ?? UNBOUND_FILE,
        item.candidate,
        { subject: 'delivery-candidate', expectedLinks: 2 },
      );
      if (retired.status !== 'removed') {
        throw deliveryTargetStateError(item.capture.requestedPath, item.label, retired);
      }
      item.candidatePresent = false;
    }
    for (const item of committed) {
      const finalized = verifyRegularFileBinding(item.candidateBinding ?? UNBOUND_FILE, {
        filePath: item.target,
        expectedLinks: 1,
      });
      if (finalized.status !== 'match') {
        throw deliveryTargetStateError(item.capture.requestedPath, item.label, finalized);
      }
    }
    // Finalization is part of the commit: keep the old files recoverable until
    // the journal has been removed and checkers can accept the new artifact.
    assertDeliveryOwnership(ownership, 'finalize the delivery journal', { pending: 'owned' });
    quarantineRemoveOwnedDeliveryEntry(state, {
      filePath: state.pendingPath,
      identity: state.pendingIdentity,
      content: state.pendingContent,
      subject: 'delivery-journal',
      operation: 'finalize the delivery journal',
      evidenceKey: 'journal',
    });
    assertDeliveryOwnership(ownership, 'finish finalizing the delivery journal', { pending: 'absent' });
    state.pendingIdentity = undefined;
    state.pendingContent = undefined;
    state.phase = 'finalized';
    retainSuccessfulBackupBindings = true;
    return {
      recoverableBackups: [
        ...[...retainedBackups].map((item) => ({ label: item.label, path: item.backup })),
        ...publicRecoveryBackups,
      ],
      ownedBackupEntries: backedUp
        .filter((item) => item.backupPresent)
        .map((item) => ({
          filePath: item.backup,
          binding: item.previousBinding ?? UNBOUND_FILE,
          subject: 'previous-delivery-backup',
          expectedLinks: 1,
        })),
    };
  } catch (cause) {
    const recoveryDetails = () => ({
      recoveryRequired: true,
      recoveryDirectory: stagingDirectory,
      recoverableBackups: [
        ...[...retainedBackups].map((item) => ({ label: item.label, path: item.backup })),
        ...publicRecoveryBackups,
      ],
    });
    if (fault(cause).deliveryOwnershipCode === 'delivery/ownership-lost') {
      fault(cause).deliveryCommitDetails = { ...(fault(cause).deliveryCommitDetails || {}), ...recoveryDetails() };
      throw cause;
    }
    const rollbackErrors: Array<string | undefined> = [];
    const recoverableBackups: RecoveryFile[] = [];
    try {
      for (const item of [...committed].reverse()) {
        try {
          assertDeliveryOwnership(ownership, `roll back the ${item.label}`, { pending: 'identity' });
          const removed = present(quarantineRemoveRegularFileBinding)(item.candidateBinding ?? UNBOUND_FILE, item.target, {
            subject: 'published-delivery-target',
            expectedLinks: item.candidatePresent ? 2 : 1,
          });
          if (removed.status !== 'removed') {
            if (removed.status === 'recovery-required') {
              publicRecoveryBackups.push({
                label: `preserved replacement for ${item.label}`,
                path: removed.recoveryFile,
                target: item.target,
              });
            }
            throw new Error(`the committed target could not be removed safely (${removed.reason?.code || 'unknown target state'})`);
          }
        } catch (error) {
          if (fault(error).deliveryOwnershipCode === 'delivery/ownership-lost') throw error;
          rollbackErrors.push(`${item.label}: remove failed (${fault(error).message})`);
        }
      }
      for (const item of [...backedUp].reverse()) {
        try {
          assertDeliveryOwnership(ownership, `restore the previous ${item.label}`, { pending: 'identity' });
          if (pathEntryExists(item.target)) {
            const current: RelationLike = item.candidateBinding
              ? present(verifyRegularFileBinding)(item.candidateBinding, {
                filePath: item.target,
                expectedLinks: item.candidatePresent ? 2 : 1,
              })
              : { status: 'different' };
            if (current.status !== 'match') {
              throw new Error(`a changed target claimant prevents restoring the previous file (${current.reason?.code || 'unknown target state'})`);
            }
            const removed = present(quarantineRemoveRegularFileBinding)(item.candidateBinding ?? UNBOUND_FILE, item.target, {
              subject: 'published-delivery-target',
              expectedLinks: item.candidatePresent ? 2 : 1,
            });
            if (removed.status !== 'removed') {
              if (removed.status === 'recovery-required') {
                publicRecoveryBackups.push({
                  label: `preserved replacement for ${item.label}`,
                  path: removed.recoveryFile,
                  target: item.target,
                });
              }
              throw new Error(`the committed target could not be removed safely (${removed.reason?.code || 'unknown target state'})`);
            }
          }
          assertDeliveryOwnership(ownership, `restore the previous ${item.label}`, { pending: 'identity' });
          if (item.backupVerified !== true) {
            throw new Error('the backup entry was never verified as the previous delivery file');
          }
          const currentBackup = present(verifyRegularFileBinding)(item.previousBinding ?? UNBOUND_FILE, {
            filePath: item.backup,
            expectedLinks: 1,
          });
          if (currentBackup.status !== 'match') {
            item.backupVerified = false;
            retainedBackups.delete(item);
            throw new Error('the previous delivery backup identity changed');
          }
          try {
            fs.linkSync(item.backup, item.target);
          } catch (error) {
            if (fault(error).code === 'EEXIST') {
              throw new Error('a new target claimant prevents restoring the previous file');
            }
            throw error;
          }
          for (const restoredPath of [item.target, item.backup]) {
            const restored = present(verifyRegularFileBinding)(item.previousBinding ?? UNBOUND_FILE, {
              filePath: restoredPath,
              expectedLinks: 2,
            });
            if (restored.status !== 'match') {
              throw new Error('the restored delivery target identity could not be verified');
            }
          }
          const retired = present(quarantineRemoveRegularFileBinding)(
            item.previousBinding ?? UNBOUND_FILE,
            item.backup,
            { subject: 'previous-delivery-target', expectedLinks: 2 },
          );
          if (retired.status !== 'removed') {
            throw new Error(`the restored delivery backup could not be retired safely (${retired.reason?.code || 'unknown target state'})`);
          }
          item.backupPresent = false;
          const restoredFinal = present(verifyRegularFileBinding)(item.previousBinding ?? UNBOUND_FILE, {
            filePath: item.target,
            expectedLinks: 1,
          });
          if (restoredFinal.status !== 'match') {
            throw new Error('the restored delivery target link count could not be verified');
          }
          retainedBackups.delete(item);
        } catch (error) {
          if (fault(error).deliveryOwnershipCode === 'delivery/ownership-lost') throw error;
          rollbackErrors.push(`${item.label}: restore failed (${fault(error).message})`);
          // A failed restoration leaves this exact backup at its source path.
          // Record it without probing the failing recovery path again.
          if (item.backupPresent !== false) {
            recoverableBackups.push({
              label: item.backupVerified === true
                ? item.label
                : `unverified preserved backup entry for ${item.label}`,
              path: item.backup,
              target: item.target,
              verifiedPrevious: item.backupVerified === true,
            });
          }
        }
      }
      assertDeliveryOwnership(ownership, 'finish the delivery rollback', { pending: 'identity' });
    } catch (rollbackError) {
      if (fault(rollbackError).deliveryOwnershipCode === 'delivery/ownership-lost') {
        fault(rollbackError).deliveryCommitDetails = {
          ...(fault(rollbackError).deliveryCommitDetails || {}),
          commitError: {
            reason: fault(cause).message,
            ...(fault(cause).code ? { systemCode: fault(cause).code } : {}),
          },
          ...recoveryDetails(),
        };
        throw rollbackError;
      }
      rollbackErrors.push(fault(rollbackError).message);
    }
    const error: SchematicsError = new Error(rollbackErrors.length
      ? 'Delivery pair commit failed and its previous files could not be fully restored.'
      : 'Delivery pair commit failed; the previous files were restored.');
    error.deliveryCommitDetails = {
      reason: fault(cause).message,
      ...(rollbackErrors.length ? {
        rollbackErrors,
        recoveryRequired: true,
        recoveryDirectory: stagingDirectory,
        recoverableBackups: [...recoverableBackups, ...publicRecoveryBackups],
      } : {}),
    };
    if (fault(cause).deliveryTargetState) {
      error.deliveryTargetState = fault(cause).deliveryTargetState;
      error.schematicsDiagnostics = fault(cause).schematicsDiagnostics;
    }
    throw error;
  } finally {
    for (const item of targets) {
      if (item.candidateBinding) present(releaseRegularFileBinding)(item.candidateBinding);
      if (item.previousBinding
        && !(retainSuccessfulBackupBindings && item.backupPresent)) {
        present(releaseRegularFileBinding)(item.previousBinding);
      }
    }
  }
}

async function renderValidatedArchitecture(
  inputPath: string,
  outputPath: string,
  quality: string | undefined,
  repoRoot: string | undefined,
  captureStagingFile?: (filePath: string, content: DeliveryContent) => void,
): Promise<{ artifact: Buffer; html: string; checks: ArtifactCheckReceipt; sourceEvidence: SourceEvidence | null }> {
  const render = runNode([rendererPath('architecture'), inputPath, outputPath], {
    stdio: 'pipe',
    env: rendererEnv(quality, repoRoot, true),
  });
  if (render.status !== 0) {
    const failure = rendererFailure(render);
    const error: SchematicsError = new Error(failure.error);
    error.compareStage = 'input';
    error.compareStatus = render.status ?? 1;
    error.diagnostics = failure.diagnostics;
    throw error;
  }
  let artifact: Buffer | undefined;
  if (captureStagingFile) {
    artifact = fs.readFileSync(outputPath);
    captureStagingFile(outputPath, artifactIdentity(artifact));
  }
  const check = await runArtifactCheck(outputPath);
  if (!check.receipt?.ok) {
    const error: SchematicsError = new Error('Validated snapshot failed final artifact checks.');
    error.compareStage = 'check';
    error.compareStatus = 1;
    if (check.receipt) {
      error.checker = check.receipt;
      error.diagnostics = checkerDiagnostics(check.receipt);
    } else {
      error.diagnostics = [];
    }
    throw error;
  }
  artifact ||= fs.readFileSync(outputPath);
  return {
    artifact,
    html: artifact.toString('utf8'),
    checks: check.receipt,
    sourceEvidence: sourceEvidenceFromArtifact(artifact),
  };
}

interface ArchitectureCheckReceipt {
  checks: ReadonlyArray<{ ok?: boolean }>;
  composition: { status?: unknown; [detail: string]: unknown };
}

function architectureCheckReceipt(receipt: ArtifactCheckReceipt): ArchitectureCheckReceipt {
  const { checks, composition } = receipt;
  if (!Array.isArray(checks) || !isRecord(composition)) throw new TypeError('The architecture check receipt is incomplete.');
  return { checks, composition };
}

async function commandCompare(args: string[]): Promise<void> {
  await loadSidecarPathRuntime();
  const {
    canonicalFuturePath,
    resolveOutputPath,
    validateAuthoredOutputPath,
  } = await import('../packages/output/output-path.ts');
  const {
    captureAtomicOutput,
    verifyAtomicOutput,
    backupPublicRegularFileBinding,
    captureRegularFileBinding,
    quarantineRemoveRegularFileBinding,
    verifyRegularFileBinding,
    releaseRegularFileBinding,
  } = await import('../packages/output/atomic-output.ts');
  const fileBindingRuntime = {
    backupPublicRegularFileBinding,
    captureRegularFileBinding,
    quarantineRemoveRegularFileBinding,
    verifyRegularFileBinding,
    releaseRegularFileBinding,
  };
  const {
    sameParent,
    sidecarNamespaceComponentKey,
  } = await import('../packages/output/path-semantics.ts');
  sidecarNamespaceComponentKeyRuntime = sidecarNamespaceComponentKey;
  const qualityArgs = extractQualityArgs(args);
  const repoArgs = extractRepoRootArgs(qualityArgs.rest);
  const options = extractCompareOptions(repoArgs.rest);
  const [type, baseInput, headInput, requestedOutput] = options.positional;
  if (type !== 'architecture' || !baseInput || !headInput || options.positional.length > 4) fail(usage());
  let deltaRuntime;
  try {
    deltaRuntime = await import(pathToFileURL(path.join(skillRoot, 'packages/delta/architecture-delta.ts')).href);
  } catch (error) {
    reportCompareFailure({ json: options.json, stage: 'prepare', error: 'Architecture compare runtime is unavailable.', code: 'delta/runtime-missing', details: { reason: fault(error).message, supportedFixes: ['install the complete Schematics skill package'] } });
    return;
  }
  const {
    ArchitectureDeltaError,
    annotateArchitectureSideSvg,
    buildDeltaSvg,
    canonicalArchitecture,
    canonicalArchitectureJson,
    compareArchitecture,
    extractArchitectureSvg,
    extractArtifactCss,
    renderArchitectureDeltaHtml,
    validateArchitectureDeltaHtml,
  } = deltaRuntime;

  const basePath = path.resolve(baseInput);
  const headPath = path.resolve(headInput);
  const explicitReceiptTarget = options.receipt ? path.resolve(options.receipt) : undefined;
  const rawOutputTarget = requestedOutput || 'architecture-delta.html';
  const rawOutputExtension = path.extname(rawOutputTarget);
  // Preserve the established alias-first diagnostic for an already-invalid
  // CLI extension without letting this legacy spelling select the real
  // sidecar namespace for any valid compare output.
  const invalidOutputAliasPreflight = !explicitReceiptTarget
    && rawOutputExtension.toLowerCase() !== '.html'
    ? path.resolve(rawOutputExtension
      ? `${rawOutputTarget.slice(0, -rawOutputExtension.length)}.receipt.json`
      : `${rawOutputTarget}.receipt.json`)
    : undefined;
  let outputPath;
  try {
    ({ outputPath } = resolveOutputPath({
      requestedOutput,
      defaultOutput: 'architecture-delta.html',
      inputPaths: [basePath, headPath],
      otherOutputPaths: explicitReceiptTarget
        ? [explicitReceiptTarget]
        : (invalidOutputAliasPreflight ? [invalidOutputAliasPreflight] : []),
    }));
  } catch (error) {
    const outputDiagnostic = fault(error).schematicsDiagnostics?.[0];
    reportCompareFailure({
      json: options.json,
      stage: 'prepare',
      error: fault(error).message,
      code: outputDiagnostic?.code || 'output/path-resolution',
      details: {
        ...(outputDiagnostic?.subject || {}),
        ...(outputDiagnostic?.evidence || {}),
        supportedFixes: outputDiagnostic?.supportedFixes || ['choose a safe output path and retry'],
      },
    });
    return;
  }
  const requestedOutputPath = outputPath;
  let receiptPath;
  let requestedReceiptPath;
  if (explicitReceiptTarget) {
    try {
      ({ outputPath: receiptPath } = resolveOutputPath({
        requestedOutput: options.receipt,
        defaultOutput: options.receipt,
        requiredExtension: '.json',
        inputPaths: [basePath, headPath],
        otherOutputPaths: [outputPath],
      }));
      requestedReceiptPath = receiptPath;
    } catch (error) {
      const outputDiagnostic = fault(error).schematicsDiagnostics?.[0];
      reportCompareFailure({
        json: options.json,
        stage: 'prepare',
        error: fault(error).message,
        code: outputDiagnostic?.code || 'output/path-resolution',
        details: {
          ...(outputDiagnostic?.subject || {}),
          ...(outputDiagnostic?.evidence || {}),
          supportedFixes: outputDiagnostic?.supportedFixes || ['choose a safe receipt path and retry'],
        },
      });
      return;
    }
  }
  try {
    outputPath = canonicalFuturePath(requestedOutputPath);
    if (requestedReceiptPath) receiptPath = canonicalFuturePath(requestedReceiptPath);
  } catch (error) {
    const outputDiagnostic = fault(error).schematicsDiagnostics?.[0];
    reportCompareFailure({
      json: options.json,
      stage: 'prepare',
      error: fault(error).message,
      code: outputDiagnostic?.code || 'output/path-resolution',
      details: {
        ...(outputDiagnostic?.subject || {}),
        ...(outputDiagnostic?.evidence || {}),
        supportedFixes: outputDiagnostic?.supportedFixes || ['choose safe compare output paths and retry'],
      },
    });
    return;
  }
  let baseBuffer;
  let headBuffer;
  let base;
  let head;
  try {
    baseBuffer = fs.readFileSync(basePath);
    base = JSON.parse(baseBuffer.toString('utf8'));
  } catch (error) {
    reportCompareFailure({ json: options.json, stage: 'input', error: `Could not read base input: ${fault(error).message}`, code: 'delta/base-input', details: { side: 'base', reason: fault(error).message } });
    return;
  }
  try {
    headBuffer = fs.readFileSync(headPath);
    head = JSON.parse(headBuffer.toString('utf8'));
  } catch (error) {
    reportCompareFailure({ json: options.json, stage: 'input', error: `Could not read head input: ${fault(error).message}`, code: 'delta/head-input', details: { side: 'head', reason: fault(error).message } });
    return;
  }

  for (const [side, document] of [['base', base], ['head', head]]) {
    try {
      validateAuthoredOutputPath(document?.meta?.output);
    } catch (error) {
      const diagnosticEntry = fault(error).schematicsDiagnostics?.[0];
      reportCompareFailure({
        json: options.json,
        stage: 'input',
        error: `${side === 'base' ? 'Base' : 'Head'} snapshot failed validation: ${fault(error).message}`,
        code: diagnosticEntry?.code || `delta/${side}-validation`,
        details: {
          side,
          ...(diagnosticEntry?.subject?.path ? { path: diagnosticEntry.subject.path } : {}),
          ...(diagnosticEntry?.evidence || {}),
          supportedFixes: diagnosticEntry?.supportedFixes || [],
        },
      });
      return;
    }
  }

  let outputDirectory = path.dirname(outputPath);
  if (receiptPath) {
    const explicitReceiptDirectoryIdentity = sameParent(outputPath, receiptPath);
    if (explicitReceiptDirectoryIdentity.status === 'unknown') {
      reportCompareFailure({
        json: options.json,
        stage: 'prepare',
        error: 'The compare receipt directory identity could not be verified.',
        code: 'delta/receipt-directory-identity-indeterminate',
        details: {
          artifactDirectory: outputDirectory,
          receiptDirectory: path.dirname(receiptPath),
          pathIdentity: explicitReceiptDirectoryIdentity.reason,
          supportedFixes: ['restore access to both output directories or choose paths in one verifiable directory'],
        },
      });
      return;
    }
    if (explicitReceiptDirectoryIdentity.status !== 'match') {
      reportCompareFailure({
        json: options.json,
        stage: 'prepare',
        error: 'The compare receipt must be written beside the HTML artifact.',
        code: 'delta/receipt-directory',
        details: {
          artifactDirectory: outputDirectory,
          receiptDirectory: path.dirname(receiptPath),
          pathIdentity: explicitReceiptDirectoryIdentity.reason,
          supportedFixes: ['choose a --receipt path in the same directory as output.html'],
        },
      });
      return;
    }
  }
  try {
    fs.mkdirSync(outputDirectory, { recursive: true });
  } catch (error) {
    reportCompareFailure({ json: options.json, stage: 'prepare', error: `Could not create compare output directory: ${fault(error).message}`, code: 'delta/output-directory', details: { reason: fault(error).message } });
    return;
  }

  if (!receiptPath) {
    try {
      const defaultReceiptPath = compareReceiptPath(outputPath);
      ({ outputPath: receiptPath } = resolveOutputPath({
        requestedOutput: defaultReceiptPath,
        defaultOutput: defaultReceiptPath,
        requiredExtension: '.json',
        inputPaths: [basePath, headPath],
        otherOutputPaths: [outputPath],
      }));
      requestedReceiptPath = receiptPath;
      receiptPath = canonicalFuturePath(requestedReceiptPath);
    } catch (error) {
      const outputDiagnostic = fault(error).schematicsDiagnostics?.[0];
      const namespaceIndeterminate = fault(error).code === 'SCHEMATICS_SIDECAR_NAMESPACE_INDETERMINATE';
      reportCompareFailure({
        json: options.json,
        stage: 'prepare',
        error: fault(error).message,
        code: namespaceIndeterminate
          ? 'delta/receipt-namespace-indeterminate'
          : outputDiagnostic?.code || 'output/path-resolution',
        details: {
          ...(outputDiagnostic?.subject || {}),
          ...(outputDiagnostic?.evidence || {}),
          ...(namespaceIndeterminate ? { pathIdentity: fault(error).sidecarNamespaceReason } : {}),
          supportedFixes: outputDiagnostic?.supportedFixes
            || ['choose a safe receipt path beside the compare artifact and retry'],
        },
      });
      return;
    }
  }

  const receiptDirectoryIdentity = sameParent(outputPath, receiptPath);
  if (receiptDirectoryIdentity.status === 'unknown') {
    reportCompareFailure({
      json: options.json,
      stage: 'prepare',
      error: 'The compare receipt directory identity could not be verified.',
      code: 'delta/receipt-directory-identity-indeterminate',
      details: {
        artifactDirectory: outputDirectory,
        receiptDirectory: path.dirname(receiptPath),
        pathIdentity: receiptDirectoryIdentity.reason,
        supportedFixes: ['restore access to both output directories or choose paths in one verifiable directory'],
      },
    });
    return;
  }
  if (receiptDirectoryIdentity.status !== 'match') {
    reportCompareFailure({
      json: options.json,
      stage: 'prepare',
      error: 'The compare receipt must be written beside the HTML artifact.',
      code: 'delta/receipt-directory',
      details: {
        artifactDirectory: outputDirectory,
        receiptDirectory: path.dirname(receiptPath),
        pathIdentity: receiptDirectoryIdentity.reason,
        supportedFixes: ['choose a --receipt path in the same directory as output.html'],
      },
    });
    return;
  }

  const outputCapture = captureAtomicOutput(requestedOutputPath);
  const receiptCapture = captureAtomicOutput(requiredPath(requestedReceiptPath));
  for (const [capture, label, requestedPath] of [
    [outputCapture, 'HTML artifact', requestedOutputPath],
    [receiptCapture, 'receipt', requiredPath(requestedReceiptPath)],
  ] as const) {
    if (capture.status === 'captured') continue;
    const failure = compareAtomicOutputFailure(capture, label, requestedPath, 'prepare');
    reportCompareFailure({
      json: options.json,
      stage: failure.stage,
      error: failure.message,
      code: failure.code,
      details: failure.details,
    });
    return;
  }
  if (outputCapture.status !== 'captured' || receiptCapture.status !== 'captured') return;
  const outputParent = outputCapture.snapshot.slot;
  const receiptParent = receiptCapture.snapshot.slot;
  if (outputParent.parentDevice !== receiptParent.parentDevice
    || outputParent.parentInode !== receiptParent.parentInode) {
    reportCompareFailure({
      json: options.json,
      stage: 'prepare',
      error: 'The compare receipt must be written beside the HTML artifact.',
      code: 'delta/receipt-directory',
      details: {
        artifactDirectory: outputParent.parentPath,
        receiptDirectory: receiptParent.parentPath,
        supportedFixes: ['choose a --receipt path in the same physical directory as output.html'],
      },
    });
    return;
  }
  outputPath = outputCapture.commitPath;
  receiptPath = receiptCapture.commitPath;
  outputDirectory = path.dirname(outputPath);

  let stagingDirectory;
  let stagingIdentity;
  try {
    const staging = createOwnedEmptyStagingDirectory(
      path.join(outputDirectory, '.schematics-compare-'),
    );
    stagingDirectory = staging.directory;
    stagingIdentity = staging.identity;
  } catch (error) {
    reportCompareFailure({ json: options.json, stage: 'prepare', error: `Could not create compare candidate: ${fault(error).message}`, code: 'delta/candidate-directory', details: { reason: fault(error).message } });
    return;
  }

  const baseCandidate = path.join(stagingDirectory, 'base.html');
  const headCandidate = path.join(stagingDirectory, 'head.html');
  const rawBaseCandidate = path.join(stagingDirectory, 'base.raw.html');
  const rawHeadCandidate = path.join(stagingDirectory, 'head.raw.html');
  const rawBaseInput = path.join(stagingDirectory, 'base.snapshot.json');
  const rawHeadInput = path.join(stagingDirectory, 'head.snapshot.json');
  const canonicalBaseInput = path.join(stagingDirectory, 'base.architecture.json');
  const canonicalHeadInput = path.join(stagingDirectory, 'head.architecture.json');
  const htmlCandidate = path.join(stagingDirectory, path.basename(outputPath));
  const receiptCandidate = path.join(stagingDirectory, path.basename(receiptPath));
  let preserveRecoveryDirectory = false;
  const stagingOwnership: StagingEntry[] = [];
  const captureCompareStagingFile = (filePath: string, content: DeliveryContent) => captureOwnedStagingFile(
    stagingOwnership,
    filePath,
    fileBindingRuntime,
    { subject: 'compare-staging-entry', content },
  );

  try {
    let baseResult;
    let headResult;
    for (const { side, snapshotPath, buffer } of [
      { side: 'base', snapshotPath: rawBaseInput, buffer: baseBuffer },
      { side: 'head', snapshotPath: rawHeadInput, buffer: headBuffer },
    ]) {
      try {
        fs.writeFileSync(snapshotPath, buffer, { flag: 'wx' });
        captureCompareStagingFile(snapshotPath, artifactIdentity(buffer));
      } catch (error) {
        const message = `Could not freeze ${side} compare snapshot: ${fault(error).message}`;
        reportCompareFailure({
          json: options.json,
          stage: 'prepare',
          error: message,
          code: 'delta/freeze-snapshot',
          details: {
            side,
            ...(fault(error).code ? { systemCode: fault(error).code } : {}),
            reason: fault(error).message,
            supportedFixes: ['choose a writable compare output directory on the target filesystem'],
          },
        });
        return;
      }
    }
    try {
      await renderValidatedArchitecture(
        rawBaseInput,
        rawBaseCandidate,
        qualityArgs.quality,
        repoArgs.repoRoot,
        captureCompareStagingFile,
      );
    } catch (error) {
      const diagnosticEntry = fault(error).diagnostics?.[0];
      reportCompareFailure({
        json: options.json,
        stage: fault(error).compareStage || 'validate',
        error: `Base snapshot failed validation: ${fault(error).message}`,
        code: diagnosticEntry?.code || 'delta/base-validation',
        details: { side: 'base', ...(diagnosticEntry?.subject?.path ? { path: diagnosticEntry.subject.path } : {}), ...(diagnosticEntry?.evidence || {}), supportedFixes: diagnosticEntry?.supportedFixes || [] },
        status: fault(error).compareStatus || 1,
      });
      return;
    }
    try {
      await renderValidatedArchitecture(
        rawHeadInput,
        rawHeadCandidate,
        qualityArgs.quality,
        repoArgs.repoRoot,
        captureCompareStagingFile,
      );
    } catch (error) {
      const diagnosticEntry = fault(error).diagnostics?.[0];
      reportCompareFailure({
        json: options.json,
        stage: fault(error).compareStage || 'validate',
        error: `Head snapshot failed validation: ${fault(error).message}`,
        code: diagnosticEntry?.code || 'delta/head-validation',
        details: { side: 'head', ...(diagnosticEntry?.subject?.path ? { path: diagnosticEntry.subject.path } : {}), ...(diagnosticEntry?.evidence || {}), supportedFixes: diagnosticEntry?.supportedFixes || [] },
        status: fault(error).compareStatus || 1,
      });
      return;
    }

    // Validation must see the exact authored inputs. Only after both sides
    // pass do we canonicalize their collection order for deterministic SVG
    // geometry and stable artifact bytes.
    const canonicalBase = canonicalArchitecture(base);
    const canonicalHead = canonicalArchitecture(head);
    canonicalBase.meta.output = base.meta.output;
    canonicalHead.meta.output = head.meta.output;
    const canonicalBaseBytes = Buffer.from(JSON.stringify(canonicalBase));
    const canonicalHeadBytes = Buffer.from(JSON.stringify(canonicalHead));
    fs.writeFileSync(canonicalBaseInput, canonicalBaseBytes);
    captureCompareStagingFile(canonicalBaseInput, artifactIdentity(canonicalBaseBytes));
    fs.writeFileSync(canonicalHeadInput, canonicalHeadBytes);
    captureCompareStagingFile(canonicalHeadInput, artifactIdentity(canonicalHeadBytes));
    baseResult = await renderValidatedArchitecture(
      canonicalBaseInput,
      baseCandidate,
      qualityArgs.quality,
      repoArgs.repoRoot,
      captureCompareStagingFile,
    );
    headResult = await renderValidatedArchitecture(
      canonicalHeadInput,
      headCandidate,
      qualityArgs.quality,
      repoArgs.repoRoot,
      captureCompareStagingFile,
    );

    const semanticHash = (diagram: unknown) => new Bun.CryptoHasher('sha256').update(canonicalArchitectureJson(diagram)).digest('hex');
    let compareIr;
    try {
      compareIr = compareArchitecture(base, head, {
        baseRawSha256: new Bun.CryptoHasher('sha256').update(baseBuffer).digest('hex'),
        headRawSha256: new Bun.CryptoHasher('sha256').update(headBuffer).digest('hex'),
        baseSemanticSha256: semanticHash(base),
        headSemanticSha256: semanticHash(head),
        baseBytes: baseBuffer.byteLength,
        headBytes: headBuffer.byteLength,
        baseVerified: Boolean(baseResult.sourceEvidence),
        headVerified: Boolean(headResult.sourceEvidence),
      });
    } catch (error) {
      if (!(error instanceof ArchitectureDeltaError)) throw error;
      reportCompareFailure({ json: options.json, stage: 'compare', error: fault(error).message, code: fault(error).code, details: fault(error).details });
      return;
    }

    const baseSourceSvg = extractArchitectureSvg(baseResult.html);
    const headSourceSvg = extractArchitectureSvg(headResult.html);
    const baseSvg = annotateArchitectureSideSvg(baseSourceSvg, compareIr, 'base');
    const headSvg = annotateArchitectureSideSvg(headSourceSvg, compareIr, 'head');
    const deltaSvg = buildDeltaSvg(baseSourceSvg, headSourceSvg, compareIr);
    // Raw input hashes and byte counts belong in the sidecar receipt, not the
    // artifact. Keeping them out makes formatting-only input rewrites produce
    // the exact same canonical review HTML and artifact hash.
    const artifactIr = {
      ...compareIr,
      base: Object.fromEntries(Object.entries(compareIr.base).filter(([key]) => !['rawSha256', 'bytes'].includes(key))),
      head: Object.fromEntries(Object.entries(compareIr.head).filter(([key]) => !['rawSha256', 'bytes'].includes(key))),
    };
    const html = renderArchitectureDeltaHtml({
      receipt: artifactIr,
      baseSvg,
      deltaSvg,
      headSvg,
      baseHtml: baseResult.html,
      headHtml: headResult.html,
      artifactCss: extractArtifactCss(headResult.html),
    });
    const deltaValidation = validateArchitectureDeltaHtml(html, artifactIr);
    fs.writeFileSync(htmlCandidate, html);
    if (outputCapture.mode !== null) fs.chmodSync(htmlCandidate, outputCapture.mode);
    const artifact = fs.readFileSync(htmlCandidate);
    captureCompareStagingFile(htmlCandidate, artifactIdentity(artifact));
    const baseReceipt = architectureCheckReceipt(baseResult.checks);
    const headReceipt = architectureCheckReceipt(headResult.checks);
    const baseChecks = baseReceipt.checks.filter((check) => check.ok).length;
    const headChecks = headReceipt.checks.filter((check) => check.ok).length;
    const finalReceipt = {
      ...compareIr,
      artifact: artifactIdentity(artifact),
      validation: {
        checksPassed: baseChecks + headChecks + deltaValidation.checksPassed,
        checkCount: baseReceipt.checks.length + headReceipt.checks.length + deltaValidation.checkCount,
        baseComposition: baseReceipt.composition.status,
        headComposition: headReceipt.composition.status,
      },
    };
    const receiptBytes = Buffer.from(`${JSON.stringify(finalReceipt, null, 2)}\n`);
    fs.writeFileSync(receiptCandidate, receiptBytes);
    if (receiptCapture.mode !== null) fs.chmodSync(receiptCandidate, receiptCapture.mode);
    captureCompareStagingFile(receiptCandidate, artifactIdentity(receiptBytes));

    try {
      const currentOutput = resolveOutputPath({
        requestedOutput,
        defaultOutput: 'architecture-delta.html',
        inputPaths: [basePath, headPath],
        otherOutputPaths: [requiredPath(requestedReceiptPath)],
      }).outputPath;
      resolveOutputPath({
        requestedOutput: options.receipt || compareReceiptPath(currentOutput),
        defaultOutput: compareReceiptPath(currentOutput),
        requiredExtension: '.json',
        inputPaths: [basePath, headPath],
        otherOutputPaths: [currentOutput],
      });
    } catch (error) {
      const outputDiagnostic = fault(error).schematicsDiagnostics?.[0];
      reportCompareFailure({
        json: options.json,
        stage: 'commit',
        error: fault(error).message,
        code: outputDiagnostic?.code || 'output/path-resolution',
        details: {
          ...(outputDiagnostic?.subject || {}),
          ...(outputDiagnostic?.evidence || {}),
          supportedFixes: outputDiagnostic?.supportedFixes || ['restore safe output paths and retry'],
        },
      });
      return;
    }

    const committed = commitComparePair({
      htmlCandidate,
      htmlContent: finalReceipt.artifact,
      receiptCandidate,
      receiptContent: artifactIdentity(receiptBytes),
      outputCapture,
      receiptCapture,
      stagingDirectory,
      verifyAtomicOutput,
      fileBindingRuntime,
    });
    stagingOwnership.push(...committed.ownedBackupEntries);
    if (options.json) console.log(JSON.stringify(finalReceipt, null, 2));
    else {
      console.log(`compared architecture ${requestedOutputPath}`);
      console.log(`${finalReceipt.validation.checksPassed}/${finalReceipt.validation.checkCount} checks; completeness ${finalReceipt.completeness}; ${finalReceipt.proofLevel}; sha256 ${finalReceipt.artifact.sha256.slice(0, 12)}`);
      console.log(`receipt ${requestedReceiptPath}`);
    }
  } catch (error) {
    if (error instanceof ArchitectureDeltaError) {
      reportCompareFailure({ json: options.json, stage: 'artifact', error: fault(error).message, code: fault(error).code, details: fault(error).details });
    } else if (fault(error).compareStage === 'commit') {
      preserveRecoveryDirectory = Boolean(fault(error).compareDetails?.recoveryFiles?.length);
      reportCompareFailure({
        json: options.json,
        stage: fault(error).compareStage,
        error: fault(error).message,
        code: fault(error).compareCode,
        details: fault(error).compareDetails,
      });
    } else {
      reportCompareFailure({ json: options.json, stage: 'internal', error: 'Architecture compare failed before commit.', code: 'delta/internal', details: { reason: fault(error).message } });
    }
  } finally {
    try {
      if (!preserveRecoveryDirectory) {
        cleanupOwnedStagingDirectory(
          stagingDirectory,
          stagingIdentity,
          stagingOwnership,
          fileBindingRuntime,
        );
      } else {
        releaseOwnedStagingBindings(stagingOwnership, fileBindingRuntime);
      }
    } catch (error) {
      console.error(`Warning: could not remove compare staging directory: ${fault(error).message}`);
    }
  }
}

async function commandRender(args: string[]): Promise<void> {
  const qualityArgs = extractQualityArgs(args);
  const repoArgs = extractRepoRootArgs(qualityArgs.rest);
  // render takes no options of its own once --quality and --repo-root are
  // stripped, so anything left starting with -- is a typo. Without this a
  // mistyped flag was taken as the output path: `render architecture spec.json
  // --json out.html` wrote a file literally named `--json` and never wrote
  // out.html, exiting 0.
  const unknown = repoArgs.rest.filter((arg) => arg.startsWith('--'));
  if (unknown.length) fail(`Unknown render option "${unknown[0]}".`);
  const [type, input, output] = repoArgs.rest;
  if (!type || !input || repoArgs.rest.length > 3) fail(usage());
  const renderer = rendererPath(type);
  Object.assign(process.env, rendererEnv(qualityArgs.quality, repoArgs.repoRoot));
  process.argv = [process.execPath, renderer, input, ...(output ? [output] : [])];
  try {
    const rendererModule = await import(pathToFileURL(renderer).href);
    if (typeof rendererModule.main === 'function') await rendererModule.main(process.argv);
  } catch (error) {
    process.nextTick(() => { throw error; });
  }
}

function reportArtifactFailure({ command, json, stage, type, input, output, error, diagnostics = [], status = 1, checker, receiptId, provenance }: ArtifactFailureReport): void {
  const receipt = {
    schemaVersion: 1,
    ok: false,
    command,
    ...(receiptId ? { receiptId } : {}),
    stage,
    type,
    input,
    ...(output === undefined ? {} : { output }),
    error,
    diagnostics,
    ...(provenance ? { provenance } : {}),
    ...(checker ? { checker } : {}),
  };
  if (json) console.log(JSON.stringify(receipt, null, 2));
  else console.error(formatDiagnostics(error, diagnostics));
  process.exitCode = status;
}

function writeDeliveryFailureReceipt(options: DeliveryFailureReport): DeliveryRecord {
  const receiptId = options.receiptId || crypto.randomUUID();
  const recorded = recordDeliveryFailure({ ...options, receiptId });
  if (!recorded) throw new TypeError('The delivery failure record is unavailable.');
  const ownershipOrLockError = recorded.ownershipError || recorded.lockError;
  if (ownershipOrLockError) {
    const failureWasRecorded = recorded.status && recorded.status !== 'unrecorded';
    const lockOrOwnershipFailure = Boolean(
      fault(ownershipOrLockError).deliveryLockCode
      || fault(ownershipOrLockError).deliveryOwnershipCode,
    );
    reportArtifactFailure({
      ...options,
      command: 'deliver',
      receiptId,
      status: 1,
      error: lockOrOwnershipFailure
        ? `Could not safely continue delivery for "${options.output}": ${fault(ownershipOrLockError).message}`
        : options.error,
      ...(failureWasRecorded ? { provenance: recorded.status } : {}),
      diagnostics: lockOrOwnershipFailure
        ? [
          deliveryLockFailureDiagnostic(options.output, ownershipOrLockError),
          ...(options.diagnostics || []),
          ...(recorded.diagnostic ? [recorded.diagnostic] : []),
        ]
        : [
          ...(options.diagnostics || []),
          deliveryLockFailureDiagnostic(options.output, ownershipOrLockError),
          ...(recorded.diagnostic ? [recorded.diagnostic] : []),
        ],
    });
    return recorded;
  }
  const recoveryDiagnosticFirst = Boolean(recorded.journalRecovery || recorded.provenanceRecovery);
  const diagnostics = recoveryDiagnosticFirst
    ? [
      ...(recorded.diagnostic ? [recorded.diagnostic] : []),
      ...(options.diagnostics || []),
    ]
    : [
      ...(options.diagnostics || []),
      ...(recorded.diagnostic ? [recorded.diagnostic] : []),
    ];
  reportArtifactFailure({
    ...options,
    command: 'deliver',
    receiptId,
    provenance: recorded.status,
    diagnostics,
  });
  return recorded;
}

function reportArtifactArgumentFailure(command: string, error: unknown): void {
  const details = fault(error).schematicsArgument || {};
  reportArtifactFailure({
    command,
    json: true,
    stage: 'arguments',
    error: fault(error).message,
    diagnostics: [diagnostic({
      code: details.code || 'cli/invalid-arguments',
      message: fault(error).message,
      subject: { command, ...(details.subject || {}) },
      evidence: details.evidence || {},
      supportedFixes: details.supportedFixes || ['correct the command arguments and retry'],
    })],
    status: 2,
  });
}

interface SourceEvidence {
  verified: true;
  repository: { url: string; revision: string; [detail: string]: unknown };
  referenceCount: number;
  [detail: string]: unknown;
}

function sourceEvidenceFromArtifact(artifact: Buffer): SourceEvidence | null {
  const html = artifact.toString('utf8');
  const match = html.match(/<script id="schematics-source-evidence-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  const evidence = JSON.parse(String(match[1]));
  if (evidence?.verified !== true || !evidence.repository?.url || !evidence.repository?.revision || !Number.isInteger(evidence.referenceCount)) {
    throw new Error('Rendered source evidence receipt is incomplete.');
  }
  return evidence;
}

function engineeringProfileFromArtifact(artifact: Buffer): string | null {
  const match = artifact.toString('utf8').match(/<svg[^>]*\sdata-engineering-profile="([^"]+)"/);
  return match ? match[1] : null;
}

interface DiagramCheckReceipt {
  checks: ReadonlyArray<{ ok?: boolean }>;
  composition: {
    profile?: unknown;
    status?: unknown;
    summary: { errors?: unknown; warnings?: unknown; [detail: string]: unknown };
    issues?: unknown;
    [detail: string]: unknown;
  };
}

function diagramCheckReceipt(receipt: ArtifactCheckReceipt): DiagramCheckReceipt {
  const { checks, composition } = receipt;
  if (!Array.isArray(checks) || !isRecord(composition) || !isRecord(composition.summary)) {
    throw new TypeError('The artifact check receipt is incomplete.');
  }
  return { checks, composition: { ...composition, summary: composition.summary } };
}

function requiredList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('The artifact check receipt is incomplete.');
  return value;
}

function requiredRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new TypeError('The artifact check receipt is incomplete.');
  return value;
}

async function commandDeliver(args: string[]): Promise<void> {
  await loadSidecarPathRuntime();
  const qualityArgs = extractQualityArgs(args);
  const repoArgs = extractRepoRootArgs(qualityArgs.rest);
  const writingArgs = extractExplainerWritingArgs(repoArgs.rest);
  repoArgs.rest = writingArgs.rest;
  const json = repoArgs.rest.includes('--json');
  const open = repoArgs.rest.includes('--open');
  const knownOptions = new Set(['--json', '--open']);
  const unknown = repoArgs.rest.filter((arg) => arg.startsWith('--') && !knownOptions.has(arg));
  if (unknown.length) rejectCliArgument(`Unknown deliver option "${unknown[0]}".`, {
    code: 'cli/unknown-option',
    subject: { option: unknown[0] },
    supportedFixes: ['remove the unknown option and retry'],
  });
  const positional = repoArgs.rest.filter((arg) => !knownOptions.has(arg));
  const [type, input, requestedOutput] = positional;
  if (!type || !input || positional.length > 3) rejectCliArgument(usage(), {
    code: 'cli/usage',
    supportedFixes: ['use: schematics deliver <type> <input.json> [output.html] [options]'],
  });
  const renderer = rendererPath(type);
  const {
    canonicalFuturePath,
    pathsAlias,
    resolveOutputPath,
    validateAuthoredOutputPath,
  } = await import('../packages/output/output-path.ts');
  const {
    captureAtomicOutput,
    verifyAtomicOutput,
    backupPublicRegularFileBinding,
    captureRegularFileBinding,
    quarantineRemoveRegularFileBinding,
    verifyRegularFileBinding,
    releaseRegularFileBinding,
  } = await import('../packages/output/atomic-output.ts');
  ({ sidecarNamespaceComponentKey: sidecarNamespaceComponentKeyRuntime }
    = await import('../packages/output/path-semantics.ts'));
  const fileBindingRuntime = {
    backupPublicRegularFileBinding,
    captureRegularFileBinding,
    quarantineRemoveRegularFileBinding,
    verifyRegularFileBinding,
    releaseRegularFileBinding,
  };
  const receiptId = crypto.randomUUID();
  let deliveryOwnership: DeliveryOwnership | undefined;
  let recoveryRequired = false;
  let stagingDirectory: string | undefined;
  let stagingIdentity: StagingIdentity | undefined;
  let deliveryAliasOutput: string | undefined;
  const reportDeliveryFailure = async (options: Omit<DeliveryFailureReport, 'pathsAlias'>) => {
    const ownership = deliveryOwnership;
    deliveryOwnership = undefined;
    const recorded = writeDeliveryFailureReceipt({
      ...options,
      pathsAlias,
      receiptId,
      ownership,
      releaseOwnership: Boolean(ownership),
      recoveryDirectory: stagingDirectory,
      legacyOutputPaths: deliveryAliasOutput ? [deliveryAliasOutput] : [],
      captureAtomicOutput,
      verifyAtomicOutput,
      fileBindingRuntime,
    });
    if (ownership && fault(recorded?.ownershipError || recorded?.lockError).deliveryOwnershipCode === 'delivery/ownership-lost') {
      recoveryRequired = true;
    }
  };
  const reportPreparedArtifactFailure = async (options: ArtifactFailureReport) => reportArtifactFailure(options);
  const inputPath = path.resolve(input);
  let specification;
  let diagram;
  let explainerBundle;
  try {
    specification = fs.readFileSync(inputPath);
    if (type === 'explainer') {
      explainerBundle = await prepareExplainerInput(specification, inputPath, { repoRoot: repoArgs.repoRoot, quality: qualityArgs.quality, writingMode: writingArgs.writingMode });
      diagram = explainerBundle.document;
    } else diagram = JSON.parse(specification.toString('utf8'));
  } catch (error) {
    const repair = inputDiagnostic(error, inputPath);
    await reportDeliveryFailure({
      json,
      stage: 'input',
      type,
      input: inputPath,
      output: path.resolve(requestedOutput || `${type}.html`),
      error: `Could not read delivery input "${inputPath}": ${fault(error).message}`,
      diagnostics: fault(error).schematicsDiagnostics || [repair],
    });
    return;
  }

  const authoredOutput = diagram?.meta?.output;
  let outputPath: string | undefined;
  let provenancePath;
  let preparedDeliveryTargets;
  try {
    if (type !== 'explainer' || authoredOutput !== undefined) validateAuthoredOutputPath(authoredOutput);
    ({ outputPath } = resolveOutputPath({
      requestedOutput,
      authoredOutput,
      defaultOutput: `${type}.html`,
      inputPaths: [inputPath],
    }));
    deliveryAliasOutput = outputPath;
    // Redelivery through a case, normalization, 8.3, or file-symlink alias
    // must replace the existing physical artifact without changing its stored
    // spelling. That keeps its realpath-derived sidecars discoverable.
    outputPath = canonicalFuturePath(outputPath);
  } catch (error) {
    const attemptedOutput = path.resolve(
      requestedOutput
      || (typeof authoredOutput === 'string' && authoredOutput)
      || `${type}.html`,
    );
    const failure = {
      json,
      stage: 'prepare',
      type,
      input: inputPath,
      output: attemptedOutput,
      error: fault(error).message,
      diagnostics: fault(error).schematicsDiagnostics || [diagnostic({
        code: 'output/path-resolution',
        message: fault(error).message,
        subject: { output: attemptedOutput },
        evidence: { ...(fault(error).code ? { systemCode: fault(error).code } : {}) },
        supportedFixes: ['choose a safe output path and retry'],
      })],
    };
    if (outputPath) {
      await reportDeliveryFailure(failure);
    } else {
      await reportPreparedArtifactFailure({ ...failure, command: 'deliver', receiptId });
    }
    return;
  }
  let outputDirectory = path.dirname(outputPath);
  try {
    fs.mkdirSync(outputDirectory, { recursive: true });
  } catch (error) {
    const message = `Could not create delivery directory "${outputDirectory}": ${fault(error).message}`;
    await reportDeliveryFailure({
      json,
      stage: 'prepare',
      type,
      input: inputPath,
      output: outputPath,
      error: message,
      diagnostics: [diagnostic({
        code: 'delivery/prepare-directory',
        message,
        subject: { outputDirectory },
        evidence: { ...(fault(error).code ? { systemCode: fault(error).code } : {}), reason: fault(error).message },
        supportedFixes: ['choose a writable output directory'],
      })],
    });
    return;
  }

  // Name semantics such as NTFS per-directory case sensitivity cannot be
  // projected through an unmaterialized directory. Creating the requested
  // physical parent is directory preparation, not artifact/sidecar
  // publication; all input, portable-path and native-resolution contracts
  // above have already passed. Only now may sidecar naming probe the actual
  // directory. A later target snapshot still rejects any authored alias that
  // was retargeted across this boundary.
  try {
    const defaultProvenancePath = deliveryProvenancePath(outputPath);
    ({ outputPath: provenancePath } = resolveOutputPath({
      requestedOutput: defaultProvenancePath,
      defaultOutput: defaultProvenancePath,
      requiredExtension: '.json',
      inputPaths: [inputPath],
      inputDescription: 'the delivery input',
      otherOutputPaths: [outputPath],
    }));
  } catch (error) {
    const attemptedOutput = path.resolve(requestedOutput || authoredOutput || `${type}.html`);
    const failure = {
      json,
      stage: 'prepare',
      type,
      input: inputPath,
      output: attemptedOutput,
      error: fault(error).message,
      diagnostics: fault(error).schematicsDiagnostics || [diagnostic({
        code: 'output/path-resolution',
        message: fault(error).message,
        subject: { output: attemptedOutput },
        evidence: { ...(fault(error).code ? { systemCode: fault(error).code } : {}) },
        supportedFixes: ['choose a safe output path and retry'],
      })],
    };
    if (fault(error).code === 'SCHEMATICS_SIDECAR_NAMESPACE_INDETERMINATE') {
      await reportPreparedArtifactFailure({ ...failure, command: 'deliver', receiptId });
    } else {
      await reportDeliveryFailure(failure);
    }
    return;
  }

  try {
    const plannedOutputPath = outputPath;
    const artifactCapture = {
      requestedPath: deliveryAliasOutput || outputPath,
      ...captureAtomicOutput(deliveryAliasOutput || outputPath),
    };
    if (artifactCapture.status !== 'captured') {
      throw deliveryTargetStateError(artifactCapture.requestedPath, 'HTML artifact', artifactCapture);
    }
    if (!pathsAlias(artifactCapture.commitPath, plannedOutputPath)) {
      throw deliveryTargetStateError(artifactCapture.requestedPath, 'HTML artifact', {
        status: 'different',
        reason: {
          code: 'write-slot-changed-before-snapshot',
          plannedCommitPath: plannedOutputPath,
          currentCommitPath: artifactCapture.commitPath,
        },
      });
    }
    const requestedProvenancePath = deliveryProvenancePath(artifactCapture.commitPath);
    const provenanceCapture = {
      requestedPath: requestedProvenancePath,
      ...captureAtomicOutput(requestedProvenancePath, {
        requestedEntryPolicy: 'regular-or-absent',
      }),
    };
    if (provenanceCapture.status !== 'captured') {
      throw deliveryTargetStateError(requestedProvenancePath, 'delivery provenance', provenanceCapture);
    }
    preparedDeliveryTargets = { artifact: artifactCapture, provenance: provenanceCapture };
    outputPath = artifactCapture.commitPath;
    provenancePath = provenanceCapture.commitPath;
    outputDirectory = path.dirname(outputPath);
  } catch (error) {
    await reportPreparedArtifactFailure({
      command: 'deliver', json, stage: 'prepare', type, input: inputPath, output: outputPath, receiptId,
      error: fault(error).message,
      diagnostics: fault(error).schematicsDiagnostics || [diagnostic({
        code: 'output/target-indeterminate',
        message: fault(error).message,
        subject: { output: outputPath },
        evidence: { ...(fault(error).code ? { systemCode: fault(error).code } : {}) },
        supportedFixes: ['retry only after the output path and its parent directories stop changing'],
      })],
    });
    return;
  }

  // Keep the candidate beside the target so the final rename is one
  // same-filesystem commit. A render or artifact-check failure never touches
  // an existing trusted output.
  try {
    const staging = createOwnedEmptyStagingDirectory(
      path.join(outputDirectory, '.schematics-delivery-'),
    );
    stagingDirectory = staging.directory;
    stagingIdentity = staging.identity;
  } catch (error) {
    const message = `Could not create a delivery candidate beside "${outputPath}": ${fault(error).message}`;
    await reportDeliveryFailure({
      json,
      stage: 'prepare',
      type,
      input: inputPath,
      output: outputPath,
      error: message,
      diagnostics: [diagnostic({
        code: 'delivery/prepare-candidate',
        message,
        subject: { output: outputPath },
        evidence: { ...(fault(error).code ? { systemCode: fault(error).code } : {}), reason: fault(error).message },
        supportedFixes: ['choose a writable output directory on the target filesystem'],
      })],
    });
    return;
  }
  const candidatePath = path.join(stagingDirectory, path.basename(outputPath));
  const specificationSnapshotPath = path.join(stagingDirectory, 'specification.snapshot.json');
  const provenanceCandidatePath = path.join(stagingDirectory, 'delivery-provenance.json');
  let commitRecoveryBackups: RecoveryFile[] = [];
  const stagingOwnership: StagingEntry[] = [];
  const captureDeliveryStagingFile = (filePath: string, content: DeliveryContent) => captureOwnedStagingFile(
    stagingOwnership,
    filePath,
    fileBindingRuntime,
    { subject: 'delivery-staging-entry', content },
  );

  try {
    try {
      deliveryOwnership = acquireDeliveryLock(
        outputPath,
        receiptId,
        inputPath,
        pathsAlias,
        (lockError, initializingOwnership) => recordDeliveryFailure({
          output: outputPath,
          stage: 'prepare',
          input: inputPath,
          error: `Could not start delivery for "${outputPath}": ${fault(lockError).message}`,
          receiptId,
          pathsAlias,
          ownership: initializingOwnership,
          captureAtomicOutput,
          verifyAtomicOutput,
          fileBindingRuntime,
        }),
        deliveryAliasOutput ? [deliveryAliasOutput] : [],
        fileBindingRuntime,
      );
    } catch (error) {
      const message = `Could not start delivery for "${outputPath}": ${fault(error).message}`;
      const recorded = fault(error).deliveryFailureRecord;
      await reportPreparedArtifactFailure({
        command: 'deliver', json, stage: 'prepare', type, input: inputPath, output: outputPath, receiptId,
        error: message,
        ...(recorded ? { provenance: recorded.status } : {}),
        diagnostics: fault(error).deliveryJournalRecovery?.recoveryRequired
          ? [deliveryJournalRecoveryDiagnostic(outputPath, error)]
          : fault(error).deliveryProvenanceRecovery?.recoveryRequired
            ? [
              ...(recorded?.diagnostic ? [recorded.diagnostic] : []),
              deliveryLockFailureDiagnostic(outputPath, error),
            ]
            : [
              deliveryLockFailureDiagnostic(outputPath, error),
              ...(recorded?.diagnostic ? [recorded.diagnostic] : []),
            ],
      });
      return;
    }

    try {
      const state = deliveryOwnershipStates.get(deliveryOwnership);
      const targets = captureDeliveryTargetState({
        state,
        requestedOutput: deliveryAliasOutput || outputPath,
        pathsAlias,
        captureAtomicOutput,
        verifyAtomicOutput,
        preparedTargets: preparedDeliveryTargets,
      });
      outputPath = targets.artifact.commitPath;
      provenancePath = targets.provenance.commitPath;
    } catch (error) {
      let releaseError;
      try {
        releaseDeliveryOwnership(deliveryOwnership);
      } catch (cause) {
        releaseError = cause;
      }
      deliveryOwnership = undefined;
      await reportPreparedArtifactFailure({
        command: 'deliver', json, stage: 'prepare', type, input: inputPath, output: outputPath, receiptId,
        error: fault(error).message,
        diagnostics: [
          ...(releaseError ? [deliveryLockFailureDiagnostic(outputPath, releaseError)] : []),
          ...(fault(error).schematicsDiagnostics || [diagnostic({
            code: 'output/target-indeterminate',
            message: fault(error).message,
            subject: { output: outputPath },
            evidence: { ...(fault(error).code ? { systemCode: fault(error).code } : {}) },
          })]),
        ],
      });
      return;
    }

    try {
      beginDeliveryAttempt({
        ownership: deliveryOwnership,
        input: inputPath,
        pathsAlias,
        fileBindingRuntime,
      });
    } catch (error) {
      if (fault(error).deliveryJournalRecovery?.recoveryRequired) {
        // The lock is the remaining fail-closed barrier. Do not write failure
        // provenance or release it after journal rollback itself became unsafe.
        deliveryOwnership = undefined;
        await reportPreparedArtifactFailure({
          command: 'deliver', json, stage: 'prepare', type, input: inputPath, output: outputPath, receiptId,
          error: `Could not persist the delivery attempt before rendering: ${fault(error).message}`,
          diagnostics: [deliveryJournalRecoveryDiagnostic(outputPath, error)],
        });
        return;
      }
      if (fault(error).deliveryOwnershipCode === 'delivery/ownership-lost') {
        deliveryOwnership = undefined;
        recoveryRequired = true;
        fault(error).deliveryCommitDetails = {
          recoveryRequired: true,
          recoveryDirectory: stagingDirectory,
          recoverableBackups: [],
        };
        await reportPreparedArtifactFailure({
          command: 'deliver', json, stage: 'prepare', type, input: inputPath, output: outputPath, receiptId,
          error: `Could not persist the delivery attempt before rendering: ${fault(error).message}`,
          diagnostics: [deliveryLockFailureDiagnostic(outputPath, error)],
        });
        return;
      }
      await reportDeliveryFailure({
        json, stage: 'prepare', type, input: inputPath, output: outputPath,
        error: 'Could not persist the delivery attempt before rendering.',
        diagnostics: [diagnostic({
          code: 'delivery/journal-write', message: 'Could not persist the delivery attempt before rendering.',
          subject: {
            output: outputPath,
            journal: deliveryOwnershipStates.get(deliveryOwnership)?.pendingPath
              || deliveryPendingPath(outputPath),
          },
          evidence: { reason: fault(error).message },
          supportedFixes: ['choose a writable output directory with a journal path distinct from the input'],
        })],
      });
      return;
    }

    try {
      fs.writeFileSync(specificationSnapshotPath, specification, { flag: 'wx' });
      captureDeliveryStagingFile(
        specificationSnapshotPath,
        artifactIdentity(Buffer.from(specification)),
      );
    } catch (error) {
      const message = `Could not freeze the delivery specification: ${fault(error).message}`;
      await reportDeliveryFailure({
        json,
        stage: 'prepare',
        type,
        input: inputPath,
        output: outputPath,
        error: message,
        diagnostics: [diagnostic({
          code: 'delivery/freeze-specification',
          message,
          subject: { input: inputPath },
          evidence: { ...(fault(error).code ? { systemCode: fault(error).code } : {}), reason: fault(error).message },
          supportedFixes: ['choose a writable output directory on the target filesystem'],
        })],
      });
      return;
    }

    let preparedBundlePath;
    if (explainerBundle) {
      try {
        const { writePreparedBundle } = await import('../packages/explainer/prepare.ts');
        preparedBundlePath = writePreparedBundle(stagingDirectory, explainerBundle);
        captureDeliveryStagingFile(preparedBundlePath, artifactIdentity(fs.readFileSync(preparedBundlePath)));
      } catch (error) {
        await reportDeliveryFailure({json,stage:'prepare',type,input:inputPath,output:outputPath,error:fault(error).message,
          diagnostics:fault(error).schematicsDiagnostics || [diagnostic({code:'explainer/freeze-resource-bundle',message:fault(error).message,subject:{input:inputPath,line:1,component:'document'},evidence:{reason:fault(error).code || 'bundle-write-failed',example:'Use a writable delivery directory and a document within the resource budget.'},supportedFixes:['Use a writable delivery directory and a document within the resource budget.']})]});
        return;
      }
    }
    const render = runNode([renderer, specificationSnapshotPath, candidatePath], {
      stdio: 'pipe',
      // The page is rendered in staging; paths inside it are written relative to where it is delivered.
      env: { ...rendererEnv(qualityArgs.quality, repoArgs.repoRoot, true), ...(preparedBundlePath ? { SCHEMATICS_EXPLAINER_PREPARED: preparedBundlePath, SCHEMATICS_EXPLAINER_SNAPSHOT_INPUT: inputPath, SCHEMATICS_EXPLAINER_PAGE_DIR: path.dirname(outputPath) } : {}) },
    });
    if (render.status !== 0) {
      const failure = rendererFailure(render);
      await reportDeliveryFailure({
        json,
        stage: 'render',
        type,
        input: inputPath,
        output: outputPath,
        error: failure.error,
        diagnostics: failure.diagnostics,
        status: render.status ?? 1,
      });
      return;
    }
    if (render.stderr) process.stderr.write(render.stderr);
    const localeWarnings = [...await specificationLocaleDiagnostics(type, specification), ...(explainerBundle?.diagnostics.filter((entry) => entry.severity === 'warning') || [])];
    for (const warning of localeWarnings) process.stderr.write(`schematics: ${warning.message}\n`);
    try {
      const renderedCandidate = fs.readFileSync(candidatePath);
      if (preparedDeliveryTargets.artifact.mode !== null) {
        fs.chmodSync(candidatePath, preparedDeliveryTargets.artifact.mode);
      }
      captureDeliveryStagingFile(candidatePath, artifactIdentity(renderedCandidate));
    } catch {
      // The commit path performs the authoritative candidate classification.
      // Leave an unbound entry untouched during private-directory cleanup.
    }

    const check = await runArtifactCheck(candidatePath);
    if (!check.receipt?.ok) {
      const checker = check.receipt
        ? { ...check.receipt, file: outputPath }
        : { ok: false, file: outputPath, diagnostic: fault(check.error).message };
      await reportDeliveryFailure({
        json,
        stage: 'check',
        type,
        input: inputPath,
        output: outputPath,
        error: 'Final artifact check failed; the previous artifact was preserved.',
        diagnostics: checkerDiagnostics(checker),
        status: 1,
        checker,
      });
      return;
    }

    const result = check.receipt;
    let artifact;
    try {
      artifact = fs.readFileSync(candidatePath);
    } catch (error) {
      const message = `Could not read the verified delivery candidate: ${fault(error).message}`;
      await reportDeliveryFailure({
        json,
        stage: 'receipt',
        type,
        input: inputPath,
        output: outputPath,
        error: message,
        diagnostics: [diagnostic({
          code: 'delivery/candidate-unreadable',
          message,
          subject: { output: outputPath },
          evidence: { ...(fault(error).code ? { systemCode: fault(error).code } : {}), reason: fault(error).message },
        })],
      });
      return;
    }
    let sourceEvidence;
    try {
      sourceEvidence = sourceEvidenceFromArtifact(artifact);
    } catch (error) {
      const message = `Could not read the repository evidence receipt: ${fault(error).message}`;
      await reportDeliveryFailure({
        json,
        stage: 'receipt',
        type,
        input: inputPath,
        output: outputPath,
        error: message,
        diagnostics: [diagnostic({
          code: 'delivery/evidence-receipt-invalid',
          message,
          subject: { output: outputPath },
          evidence: { reason: fault(error).message },
        })],
      });
      return;
    }
    const engineeringProfile = engineeringProfileFromArtifact(artifact);
    const checked = diagramCheckReceipt(result);
    const receipt = {
      schemaVersion: 1,
      receiptId,
      ok: true,
      command: 'deliver',
      type,
      input: inputPath,
      output: outputPath,
      ...(explainerBundle ? { explainer: { preparedSha256: explainerBundle.digest, dependencies: explainerBundle.dependencies.map(({contentBase64, ...entry}) => entry) } } : {}),
      specification: {
        sha256: new Bun.CryptoHasher('sha256').update(specification).digest('hex'),
        bytes: specification.byteLength,
      },
      artifact: {
        sha256: new Bun.CryptoHasher('sha256').update(artifact).digest('hex'),
        bytes: artifact.byteLength,
      },
      validation: {
        checksPassed: checked.checks.filter((checkItem) => checkItem.ok).length,
        checkCount: checked.checks.length,
        compositionProfile: checked.composition.profile,
        compositionStatus: checked.composition.status,
        ...(engineeringProfile ? { engineeringProfile } : {}),
        errors: checked.composition.summary.errors,
        warnings: checked.composition.summary.warnings,
        ...(checked.composition.summary.warnings ? {
          compositionIssues: requiredList(checked.composition.issues).filter((issue) => field(issue, 'severity') === 'warning'),
        } : {}),
      },
      ...(sourceEvidence ? {
        evidence: {
          verified: true,
          repository: sourceEvidence.repository.url,
          revision: sourceEvidence.repository.revision,
          references: sourceEvidence.referenceCount,
          ...(sourceEvidence.repository.linkMode ? { linkMode: sourceEvidence.repository.linkMode } : {}),
        },
      } : {}),
      ...(localeWarnings.length ? { diagnostics: localeWarnings } : {}),
    };

    const provenanceBytes = Buffer.from(`${JSON.stringify(deliverySuccessProvenance(receipt), null, 2)}\n`);
    try {
      fs.writeFileSync(provenanceCandidatePath, provenanceBytes, { flag: 'wx' });
      if (preparedDeliveryTargets.provenance.mode !== null) {
        fs.chmodSync(provenanceCandidatePath, preparedDeliveryTargets.provenance.mode);
      }
      try {
        captureDeliveryStagingFile(
          provenanceCandidatePath,
          artifactIdentity(provenanceBytes),
        );
      } catch {
        // commitDeliveryPair classifies this path against the expected bytes;
        // cleanup must not claim a candidate that could not be bound here.
      }
    } catch (error) {
      await reportDeliveryFailure({
        json,
        stage: 'commit',
        type,
        input: inputPath,
        output: outputPath,
        error: `Could not prepare delivery provenance for "${outputPath}": ${fault(error).message}`,
        diagnostics: [diagnostic({
          code: 'delivery/provenance-prepare',
          message: 'Could not prepare the artifact-bound delivery provenance.',
          subject: { output: outputPath },
          evidence: { reason: fault(error).message },
          supportedFixes: ['choose a writable output directory and rerun deliver'],
        })],
      });
      return;
    }

    try {
      const currentOutputPath = canonicalFuturePath(resolveOutputPath({
        requestedOutput,
        authoredOutput,
        defaultOutput: `${type}.html`,
        inputPaths: [inputPath],
        otherOutputPaths: [provenancePath],
      }).outputPath);
      resolveOutputPath({
        requestedOutput: deliveryProvenancePath(currentOutputPath),
        defaultOutput: deliveryProvenancePath(currentOutputPath),
        requiredExtension: '.json',
        inputPaths: [inputPath],
        inputDescription: 'the delivery input',
        otherOutputPaths: [currentOutputPath],
      });
    } catch (error) {
      await reportDeliveryFailure({
        json,
        stage: 'commit',
        type,
        input: inputPath,
        output: outputPath,
        error: fault(error).message,
        diagnostics: fault(error).schematicsDiagnostics || [diagnostic({
          code: 'output/path-resolution',
          message: fault(error).message,
          subject: { output: outputPath },
          evidence: { ...(fault(error).code ? { systemCode: fault(error).code } : {}) },
          supportedFixes: ['restore a safe output path and retry'],
        })],
      });
      return;
    }

    try {
      if (explainerBundle) {
        const { assertPreparedDependencies } = await import('../packages/explainer/prepare.ts');
        assertPreparedDependencies(explainerBundle);
      }
      const committed = commitDeliveryPair({
        htmlCandidate: candidatePath,
        htmlContent: receipt.artifact,
        provenanceCandidate: provenanceCandidatePath,
        provenanceContent: artifactIdentity(provenanceBytes),
        stagingDirectory,
        ownership: deliveryOwnership,
        verifyAtomicOutput,
        fileBindingRuntime,
      });
      commitRecoveryBackups = committed.recoverableBackups;
      stagingOwnership.push(...committed.ownedBackupEntries);
    } catch (error) {
      if (fault(error).deliveryOwnershipCode === 'delivery/ownership-lost' && !fault(error).deliveryCommitDetails) {
        fault(error).deliveryCommitDetails = {
          recoveryRequired: true,
          recoveryDirectory: stagingDirectory,
          recoverableBackups: [],
        };
      }
      recoveryRequired = fault(error).deliveryCommitDetails?.recoveryRequired === true;
      const message = `Could not commit verified delivery "${outputPath}": ${fault(error).message}`;
      if (recoveryRequired) {
        // The owned lock and pending journal are the remaining fail-closed
        // barrier around retained backups and any claimant we did not create.
        // Do not write failure provenance or release ownership here.
        deliveryOwnership = undefined;
        await reportPreparedArtifactFailure({
          command: 'deliver', json, stage: 'commit', type, input: inputPath, output: outputPath, receiptId,
          error: message,
          diagnostics: [
            ...(fault(error).deliveryOwnershipCode === 'delivery/ownership-lost'
              ? [deliveryLockFailureDiagnostic(outputPath, error)]
              : []),
            ...(fault(error).schematicsDiagnostics || []),
            deliveryCommitRecoveryDiagnostic(outputPath, error),
          ],
        });
        return;
      }
      if (fault(error).deliveryTargetState) {
        let releaseError;
        try {
          releaseDeliveryOwnership(deliveryOwnership);
        } catch (cause) {
          releaseError = cause;
        }
        deliveryOwnership = undefined;
        await reportPreparedArtifactFailure({
          command: 'deliver', json, stage: 'commit', type, input: inputPath, output: outputPath, receiptId,
          error: message,
          diagnostics: [
            ...(releaseError ? [deliveryLockFailureDiagnostic(outputPath, releaseError)] : []),
            ...(fault(error).schematicsDiagnostics || []),
          ],
        });
        return;
      }
      if (fault(error).deliveryOwnershipCode === 'delivery/ownership-lost') {
        deliveryOwnership = undefined;
        await reportPreparedArtifactFailure({
          command: 'deliver', json, stage: 'commit', type, input: inputPath, output: outputPath, receiptId,
          error: message,
          diagnostics: [deliveryLockFailureDiagnostic(outputPath, error)],
        });
        return;
      }
      await reportDeliveryFailure({
        json,
        stage: 'commit',
        type,
        input: inputPath,
        output: outputPath,
        error: message,
        diagnostics: fault(error).schematicsDiagnostics || [diagnostic({
          code: 'delivery/commit',
          message,
          subject: { output: outputPath },
          evidence: {
            ...(fault(error).code ? { systemCode: fault(error).code } : {}),
            reason: fault(error).message,
            ...(fault(error).deliveryCommitDetails || {}),
          },
          supportedFixes: ['choose replaceable regular-file artifact and provenance targets on the same writable filesystem'],
        })],
      });
      return;
    }

    try {
      releaseDeliveryOwnership(deliveryOwnership);
      deliveryOwnership = undefined;
    } catch (error) {
      deliveryOwnership = undefined;
      if (fault(error).deliveryOwnershipCode === 'delivery/ownership-lost') {
        recoveryRequired = true;
        fault(error).deliveryCommitDetails = {
          recoveryRequired: true,
          recoveryDirectory: stagingDirectory,
          recoverableBackups: commitRecoveryBackups,
        };
      }
      const message = `Delivery committed, but its lock could not be released for "${outputPath}": ${fault(error).message}`;
      await reportPreparedArtifactFailure({
        command: 'deliver', json, stage: 'release', type, input: inputPath, output: outputPath, receiptId,
        error: message,
        diagnostics: [deliveryLockFailureDiagnostic(outputPath, error)],
      });
      return;
    }

    let openReceipt: LaunchReceipt | undefined;
    if (open) {
      try {
        const { openArtifact } = await import('./open-artifact.ts');
        openReceipt = openArtifact(outputPath);
      } catch {
        openReceipt = {
          requested: true,
          status: 'unsupported',
          target: outputPath,
          method: null,
        };
      }
      Object.assign(receipt, { open: openReceipt });
      if (openReceipt.status !== 'opened') {
        console.error(`Could not open the verified artifact (${openReceipt.status}). ${openReceipt.failure?.reason || 'Open it manually.'} Target: ${outputPath}`);
      }
    }

    if (json) {
      console.log(JSON.stringify(receipt, null, 2));
    } else {
      console.log(`delivered ${type} ${outputPath}`);
      const engineering = receipt.validation.engineeringProfile
        ? `; engineering ${receipt.validation.engineeringProfile}: pass`
        : '';
      console.log(`${receipt.validation.checksPassed}/${receipt.validation.checkCount} artifact checks; composition ${receipt.validation.compositionProfile}: ${receipt.validation.compositionStatus}${engineering}; sha256 ${receipt.artifact.sha256.slice(0, 12)}`);
      if (openReceipt?.status === 'opened') console.log(`opened ${outputPath}`);
    }
  } finally {
    if (deliveryOwnership) {
      try {
        releaseDeliveryOwnership(deliveryOwnership, { allowInitializing: true });
      } catch (error) {
        if (fault(error).deliveryOwnershipCode === 'delivery/ownership-lost') {
          recoveryRequired = true;
          fault(error).deliveryCommitDetails = {
            ...(fault(error).deliveryCommitDetails || {}),
            recoveryRequired: true,
            recoveryDirectory: stagingDirectory,
            recoverableBackups: commitRecoveryBackups,
          };
        }
        console.error(formatDiagnostics(
          `Delivery cleanup could not release its lock for "${outputPath}".`,
          [deliveryLockFailureDiagnostic(outputPath, error)],
        ));
        process.exitCode = 1;
      }
    }
    if (recoveryRequired) {
      releaseOwnedStagingBindings(stagingOwnership, fileBindingRuntime);
      console.error(`Recovery required: delivery backups were retained at "${stagingDirectory}".`);
    } else {
      try {
        cleanupOwnedStagingDirectory(
          stagingDirectory,
          stagingIdentity,
          stagingOwnership,
          fileBindingRuntime,
        );
      } catch (error) {
        console.error(`Warning: could not remove delivery staging directory "${stagingDirectory}": ${fault(error).message}`);
      }
    }
  }
}

async function commandPatch(rawArgs: string[]): Promise<void> {
  const qualityArgs = extractQualityArgs(rawArgs);
  const repoArgs = extractRepoRootArgs(qualityArgs.rest);
  const writingArgs = extractExplainerWritingArgs(repoArgs.rest);
  repoArgs.rest = writingArgs.rest;
  const json = repoArgs.rest.includes('--json');
  const positional = repoArgs.rest.filter(arg => arg !== '--json');
  const [type, artifact, panelId, replacement, output] = positional;
  if (type !== 'explainer' || !artifact || !panelId || !replacement || !output || positional.length !== 5 || positional.some(arg => arg.startsWith('--'))) {
    rejectCliArgument('Use: schematics patch explainer <artifact.html> <panel-id> <replacement-file> <output.html> [--json]', {
      code:'cli/usage',supportedFixes:['Provide an explainer artifact, stable panel id, replacement file and output HTML path.'],
    });
  }
  let temporary;
  try {
    const checked = await runArtifactCheck(artifact);
    if(!checked.receipt?.ok) {
      const receipt=checked.receipt;
      throw Object.assign(new Error('The original explainer artifact failed validation.'), {schematicsDiagnostics:receipt?.diagnostics || [{code:'explainer/patch-artifact',severity:'error',message:'The original explainer artifact failed validation.',subject:{input:path.resolve(artifact),line:1,component:'document'},evidence:{reason:'invalid-original-artifact',example:'Use an unchanged formal explainer artifact.'},supportedFixes:['Rebuild the original artifact.']}]});
    }
    const originalCheck=checked.receipt;
    const { preparePanelPatch } = await import('../packages/explainer/patch.ts');
    const prepared = await preparePanelPatch({artifactPath:path.resolve(artifact),panelId,replacementPath:path.resolve(replacement),repoRoot:repoArgs.repoRoot,quality:qualityArgs.quality,writingMode:writingArgs.writingMode,expectedArtifact:originalCheck.artifact});
    const { resolveOutputPath } = await import('../packages/output/output-path.ts');
    resolveOutputPath({requestedOutput:output,inputPaths:[path.resolve(replacement),prepared.sourcePath]});
    const { createOwnedTempDirectory } = await import('../packages/output/owned-temp-directory.ts');
    const { writePreparedBundle } = await import('../packages/explainer/prepare.ts');
    temporary=createOwnedTempDirectory('schematics-explainer-patch-');
    const input=path.join(temporary.path,'patched-draft.json');
    fs.writeFileSync(input,prepared.sourceText,{flag:'wx'});
    const { rebindPreparedBundle } = await import('../packages/explainer/prepare.ts');
    prepared.bundle=rebindPreparedBundle({...prepared.bundle,inputPath:input},{sourceText:prepared.bundle.sourceText,document:prepared.bundle.document,sourceMap:prepared.bundle.sourceMap,format:prepared.bundle.format,diagnostics:prepared.bundle.diagnostics});
    const preparedFile=writePreparedBundle(temporary.path,prepared.bundle);
    const delivery=runNode([fileURLToPath(import.meta.url),'deliver','explainer',input,output,'--quality',qualityArgs.quality || prepared.bundle.quality || 'standard','--writing',prepared.bundle.writingMode || 'warn',...(repoArgs.repoRoot?['--repo-root',repoArgs.repoRoot]:[]),'--json'],{stdio:'pipe',env:{SCHEMATICS_EXPLAINER_PREPARED:preparedFile}});
    let receipt;
    try {receipt=JSON.parse(delivery.stdout);} catch {throw new Error('Patch delivery did not return a structured receipt.');}
    const { computeExplainerRevision } = await import('../packages/explainer/revision.ts');
    const result={...receipt,command:'patch',panelId,original:{path:path.resolve(artifact),revision:prepared.previousRevision,sourceSha256:prepared.previousSourceSha256},replacement:{path:path.resolve(replacement)},revision:computeExplainerRevision(prepared.bundle),sourceSha256:prepared.bundle.source.sha256};
    if(json)console.log(JSON.stringify(result,null,2));
    else if(result.ok)console.log(`patched ${panelId} ${result.output}`);
    else console.error(formatDiagnostics(result.error,result.diagnostics));
    if(delivery.stderr)process.stderr.write(delivery.stderr);
    process.exitCode=delivery.status ?? 1;
  } catch(error) {
    reportArtifactFailure({command:'patch',json,stage:'prepare',type:'explainer',input:path.resolve(artifact),output:path.resolve(output),error:fault(error).message,diagnostics:fault(error).schematicsDiagnostics || [diagnostic({code:'explainer/patch-runtime',message:fault(error).message,subject:{input:path.resolve(artifact),line:1,component:'panel',panelId},evidence:{reason:fault(error).code || 'patch-failure',example:'Use a complete replacement panel with the same stable id.'},supportedFixes:['Repair the replacement panel and retry.']})]});
  } finally {if(temporary)await temporary.cleanup();}
}

async function commandPreview(args: string[]): Promise<void> {
  const qualityArgs = extractQualityArgs(args);
  const repoArgs = extractRepoRootArgs(qualityArgs.rest);
  const noOpen = repoArgs.rest.includes('--no-open');
  const knownOptions = new Set(['--no-open']);
  const unknown = repoArgs.rest.filter((arg) => arg.startsWith('--') && !knownOptions.has(arg));
  if (unknown.length) fail(`Unknown preview option "${unknown[0]}".`);
  const positional = repoArgs.rest.filter((arg) => !knownOptions.has(arg));
  const [type, input, output] = positional;
  if (!type || !input || positional.length > 3) fail(usage());
  if (type === 'explainer') fail('Live preview supports the ten diagram types only. For explainer, run finalize explainer <draft.md> <output.html>, then open the HTML in your browser.');
  rendererPath(type);

  try {
    const source = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
    const { validateAuthoredOutputPath } = await import('../packages/output/output-path.ts');
    validateAuthoredOutputPath(source?.meta?.output);
  } catch (error) {
    // Preserve live repair for unreadable or malformed JSON. A parsed document,
    // however, must already carry the durable output contract before preview
    // allocates a server, watcher, or staging directory.
    if (fault(error).schematicsDiagnostics) fail(`Could not start live preview: ${fault(error).message}`, 1);
  }

  let runPreview;
  try {
    ({ runPreview } = await import('./preview.ts'));
  } catch (error) {
    fail(`Could not load live preview: ${fault(error).message}`, 1);
  }
  try {
    await runPreview({
      type,
      input,
      output,
      quality: qualityArgs.quality,
      repoRoot: repoArgs.repoRoot,
      open: !noOpen,
    });
  } catch (error) {
    fail(`Could not start live preview: ${fault(error).message}`, 1);
  }
}

async function loadPathIdentityRuntime() {
  try {
    await loadSidecarPathRuntime();
    const {
      sameEntry,
      sidecarNamespaceComponentKey,
    } = await import('../packages/output/path-semantics.ts');
    sidecarNamespaceComponentKeyRuntime = sidecarNamespaceComponentKey;
    const {
      captureRegularFileBinding,
      verifyRegularFileBinding,
      releaseRegularFileBinding,
    } = await import('../packages/output/atomic-output.ts');
    return {
      sameEntry,
      captureRegularFileBinding,
      verifyRegularFileBinding,
      releaseRegularFileBinding,
    };
  } catch (error) {
    return { error };
  }
}

type ArtifactFileBinding = Omit<SidecarBinding, 'path'>;

interface DeliveryFileBindings {
  artifact?: ArtifactFileBinding;
  sidecar?: SidecarBinding;
}

interface DeliveryProvenanceResult {
  ok: boolean;
  status: string;
  diagnostics?: Diagnostic[];
  receiptId?: unknown;
  type?: unknown;
  artifact?: DeliveryContent;
  fileBindings?: DeliveryFileBindings;
  [detail: string]: unknown;
}

function firstDiagnostic<T>(diagnostics: readonly T[] | undefined): T {
  const first = diagnostics?.[0];
  if (!first) throw new TypeError('The provenance diagnostics are unavailable.');
  return first;
}

function definedContent(content: DeliveryContent | undefined): DeliveryContent {
  if (!content) throw new TypeError('The provenance artifact identity is unavailable.');
  return content;
}

function inspectArtifactDeliveryProvenance(
  artifactPath: string,
  requireProvenance: boolean,
  pathIdentityRuntime: PathIdentityRuntime | undefined,
  expectedBindings?: DeliveryFileBindings,
): DeliveryProvenanceResult {
  const {
    captureRegularFileBinding,
    verifyRegularFileBinding,
    releaseRegularFileBinding,
  } = pathIdentityRuntime || {};
  const stableArtifactPath = canonicalExistingDeliveryOutput(artifactPath);
  let artifactCapture: CaptureResult;
  try {
    if (typeof captureRegularFileBinding !== 'function'
      || typeof verifyRegularFileBinding !== 'function'
      || typeof releaseRegularFileBinding !== 'function') {
      throw new Error('The regular-file binding runtime is unavailable.');
    }
    artifactCapture = captureRegularFileBinding(stableArtifactPath, {
      subject: 'delivery-artifact',
      ...(expectedBindings?.artifact ? {
        expectedIdentity: expectedBindings.artifact.identity,
        expectedSha256: expectedBindings.artifact.content.sha256,
        expectedBytes: expectedBindings.artifact.content.bytes,
        expectedMode: expectedBindings.artifact.mode,
      } : {}),
      expectedLinks: 1,
      includeContent: true,
    });
    if (artifactCapture.status !== 'captured') {
      if (artifactCapture.reason?.code === 'delivery-artifact-hardlinked') {
        const message = 'Delivery provenance is unsupported for a hard-linked artifact because one receipt cannot prove every linked name was updated atomically.';
        return {
          ok: false,
          status: 'unsupported',
          diagnostics: [diagnostic({
            code: 'output/target-hardlinked',
            message,
            subject: { artifact: path.resolve(artifactPath) },
            evidence: { links: artifactCapture.reason.links },
            supportedFixes: ['remove the extra hard links, then rerun deliver and strict check on the remaining artifact path'],
          })],
        };
      }
      throw new Error(`The artifact is not a stable regular file (${artifactCapture.reason?.code || 'unknown target state'}).`);
    }
  } catch (error) {
    return {
      ok: false, status: 'unknown',
      diagnostics: [diagnostic({
        code: 'input/artifact-unreadable', message: `Could not read the HTML artifact: ${fault(error).message}`,
        subject: { artifact: artifactPath },
        evidence: { reason: fault(error).message, ...(fault(error).code ? { systemCode: fault(error).code } : {}) },
        supportedFixes: ['provide an existing readable .html artifact, then rerun the checker'],
      })],
    };
  }
  try {
    const inspection: ProvenanceInspection = {};
    const provenance = inspectDeliveryProvenance(
      artifactPath,
      artifactCapture.content.buffer,
      {
        requireProvenance,
        pathIdentityRuntime,
        expectedSidecar: expectedBindings?.sidecar,
        inspection,
      },
    );
    const verification = verifyRegularFileBinding(artifactCapture.binding, {
      filePath: stableArtifactPath,
      expectedLinks: 1,
    });
    if (verification.status !== 'match') {
      return {
        ok: false,
        status: 'mismatch',
        diagnostics: [diagnostic({
          code: 'delivery/provenance-mismatch',
          message: 'The artifact changed while delivery provenance was being inspected.',
          subject: { artifact: artifactPath },
          evidence: { artifactState: verification.reason },
          supportedFixes: ['finish delivery and other writes before rerunning the checker'],
        })],
      };
    }
    const result = {
      ...provenance,
      artifact: {
        sha256: artifactCapture.content.sha256,
        bytes: artifactCapture.content.bytes,
      },
    };
    Object.defineProperty(result, 'fileBindings', {
      enumerable: false,
      value: {
        artifact: {
          identity: {
            device: artifactCapture.identity.device,
            inode: artifactCapture.identity.inode,
          },
          content: {
            sha256: artifactCapture.content.sha256,
            bytes: artifactCapture.content.bytes,
          },
          mode: artifactCapture.mode,
        },
        ...(inspection.sidecar ? { sidecar: inspection.sidecar } : {}),
      },
    });
    return result;
  } finally {
    releaseRegularFileBinding(artifactCapture.binding);
  }
}

function verifyDeliveryUnchanged(
  artifactPath: string,
  expected: DeliveryProvenanceResult | undefined,
  checkedArtifact: { sha256?: unknown; bytes?: unknown },
  pathIdentityRuntime: PathIdentityRuntime | undefined,
): DeliveryProvenanceResult {
  const current = inspectArtifactDeliveryProvenance(
    artifactPath,
    false,
    pathIdentityRuntime,
    expected?.fileBindings,
  );
  if (current && !current.ok) return current;
  if (!current || !expected || current.status !== expected.status || current.receiptId !== expected.receiptId
    || definedContent(current.artifact).sha256 !== definedContent(expected.artifact).sha256
    || definedContent(current.artifact).bytes !== definedContent(expected.artifact).bytes
    || checkedArtifact.sha256 !== definedContent(expected.artifact).sha256
    || checkedArtifact.bytes !== definedContent(expected.artifact).bytes) {
    return {
      ok: false, status: 'mismatch',
      diagnostics: [diagnostic({
        code: 'delivery/provenance-mismatch', message: 'The artifact or delivery record changed during inspection.',
        subject: { artifact: artifactPath },
        evidence: { expected: expected?.artifact, checked: checkedArtifact, current: current?.artifact },
        supportedFixes: ['finish delivery and other writes before rerunning the checker'],
      })],
    };
  }
  return current;
}

function provenanceFailureReceipt({ command, artifactPath, provenance }: {
  command: string;
  artifactPath: string;
  provenance: DeliveryProvenanceResult;
}) {
  const error = firstDiagnostic(provenance.diagnostics).message;
  return {
    schemaVersion: 1,
    ok: false,
    command,
    ...(['visual-check', 'browser-check'].includes(command) ? {
      evidenceKind: 'automated-browser',
      status: 'fail',
      visualReview: command === 'visual-check' ? 'pending' : 'not-requested',
    } : {}),
    provenance: provenance.status,
    ...(provenance.receiptId ? { deliveryReceiptId: provenance.receiptId } : {}),
    artifact: { path: artifactPath },
    error,
    ...(command === 'check' ? { file: artifactPath, diagnostic: error } : {}),
    diagnostics: provenance.diagnostics,
  };
}

async function commandCheck(args: string[]): Promise<void> {
  const knownOptions = new Set(['--json', '--require-provenance']);
  const unknown = args.find((arg) => arg.startsWith('--') && !knownOptions.has(arg));
  if (unknown) fail(`Unknown check option "${unknown}".`);
  const requireProvenance = args.includes('--require-provenance');
  const positional = args.filter((arg) => !knownOptions.has(arg));
  const [html] = positional;
  if (!html || positional.length !== 1) fail(usage());
  const checked = await checkDelivery(html, { requireProvenance });
  if (checked.receipt) console.log(JSON.stringify(checked.receipt, null, 2));
  if (checked.stderr) console.error(checked.stderr);
  process.exitCode = checked.exitCode;
}

interface DeliveryCheckReceipt {
  ok: boolean;
  family?: string;
  artifact: unknown;
  diagnostics?: unknown[];
  provenance?: unknown;
  deliveryReceiptId?: unknown;
}

async function checkDelivery(html: string, { requireProvenance = false }: { requireProvenance?: boolean } = {}) {
  const artifactPath = path.resolve(html);
  const pathIdentityRuntime = await loadPathIdentityRuntime();
  const provenance = inspectArtifactDeliveryProvenance(
    artifactPath,
    requireProvenance,
    pathIdentityRuntime,
  );
  if (provenance && !provenance.ok) {
    return { exitCode: 1, receipt: provenanceFailureReceipt({ command: 'check', artifactPath, provenance }) };
  }
  const check = await runArtifactCheck(html);
  if (check.error) return { exitCode: 1, stderr: fault(check.error).message };
  if (!check.receipt) throw new TypeError('The artifact check receipt is unavailable.');
  const receipt: DeliveryCheckReceipt = check.receipt;
  if (provenance?.status === 'current' && ((provenance.type === 'explainer') !== (receipt.family === 'explainer'))) {
    receipt.ok = false;
    receipt.diagnostics = [...requiredList(receipt.diagnostics || []), diagnostic({code:'delivery/artifact-family-mismatch',message:'The checked artifact family differs from its delivery provenance.',subject:{artifact:artifactPath},evidence:{expectedType:provenance.type,actualFamily:receipt.family},supportedFixes:['Rebuild the artifact from its original specification.']})];
  }
  if (provenance) {
    const verified = verifyDeliveryUnchanged(
      artifactPath,
      provenance,
      recordOrEmpty(receipt.artifact),
      pathIdentityRuntime,
    );
    if (!verified.ok) {
      return { exitCode: 1, receipt: provenanceFailureReceipt({ command: 'check', artifactPath, provenance: verified }) };
    }
    receipt.provenance = provenance.status;
    if (provenance.receiptId) receipt.deliveryReceiptId = provenance.receiptId;
  }
  return { exitCode: receipt.ok ? 0 : 1, receipt };
}

async function executeBrowserEvidence({
  artifactPath, outDir, requireProvenance, command, capture, ...browserOptions
}: VisualCheck.BrowserEvidenceOptions & {
  artifactPath: string;
  outDir?: string | undefined;
  requireProvenance: boolean;
  command: string;
  capture: boolean;
}): Promise<{ exitCode: number; receipt: VisualCheck.BrowserReceipt | VisualCheck.BrowserFailureReceipt; inputFailure?: boolean }> {
  const pathIdentityRuntime = await loadPathIdentityRuntime();
  const provenance = inspectArtifactDeliveryProvenance(artifactPath, requireProvenance, pathIdentityRuntime);
  let runEvidence: typeof VisualCheck.runVisualCheck;
  let persistFailure: typeof VisualCheck.persistVisualCheckFailure;
  try {
    const evidence = await import('./visual-check.ts');
    runEvidence = command === 'browser-check' ? evidence.runBrowserCheck : evidence.runVisualCheck;
    persistFailure = command === 'browser-check'
      ? evidence.persistBrowserCheckFailure
      : evidence.persistVisualCheckFailure;
  } catch (error) {
    fail(`Could not load ${command}: ${fault(error).message}`, 1);
  }
  if (provenance && !provenance.ok) {
    const receipt = persistFailure(artifactPath,
      provenanceFailureReceipt({ command, artifactPath, provenance }),
      { outDir });
    return { exitCode: 1, receipt, inputFailure: true };
  }

  let result;
  try {
    result = await runEvidence({
      ...browserOptions,
      artifactPath,
      outDir,
      ...(provenance ? { deliveryProvenance: provenance } : {}),
      verifyArtifact: (bytes: Buffer) => {
        const verified = verifyDeliveryUnchanged(
          artifactPath,
          provenance,
          artifactIdentity(bytes),
          pathIdentityRuntime,
        );
        if (!verified.ok) {
          const error: SchematicsError = new Error(firstDiagnostic(verified.diagnostics).message);
          error.deliveryProvenance = verified;
          error.schematicsDiagnostics = verified.diagnostics;
          throw error;
        }
      },
    });
  } catch (error) {
    const failure = persistFailure(artifactPath, {
        schemaVersion: 1,
        ok: false,
        command,
        evidenceKind: 'automated-browser',
        status: 'fail',
        visualReview: capture ? 'pending' : 'not-requested',
        ...(provenance ? {
          provenance: provenance.status,
          ...(provenance.receiptId ? { deliveryReceiptId: provenance.receiptId } : {}),
        } : {}),
        artifact: { path: artifactPath },
        error: fault(error).message,
        diagnostics: [diagnostic({
          code: `viewer/${command}-input`,
          message: `${command} could not read a valid HTML input or prepare its evidence files.`,
          subject: { artifact: artifactPath },
          evidence: { reason: fault(error).message, ...(fault(error).code ? { systemCode: fault(error).code } : {}) },
          supportedFixes: ['provide an existing readable .html artifact and a writable directory for evidence files'],
        })],
      }, { outDir });
    return { exitCode: 1, receipt: failure, inputFailure: true };
  }

  return result;
}

async function commandBrowserEvidence(rawArgs: string[], { command, capture }: { command: string; capture: boolean }): Promise<void> {
  const { rest: args, outDir: rawOutDir } = extractOutDirArgs(rawArgs);
  const summary = args.includes('--summary');
  const json = args.includes('--json') || summary;
  const printJson = async (receipt: VisualCheck.BrowserFailureInput) => {
    const value = summary
      ? (await import('./visual-check.ts')).summarizeBrowserEvidence(receipt)
      : receipt;
    console.log(JSON.stringify(value, null, summary ? undefined : 2));
  };
  const requireProvenance = args.includes('--require-provenance');
  const knownOptions = new Set(['--json', '--summary', '--require-provenance']);
  const unknown = args.filter((arg) => arg.startsWith('--') && !knownOptions.has(arg));
  if (unknown.length) fail(`Unknown ${command} option "${unknown[0]}".`, 1);
  const positional = args.filter((arg) => !knownOptions.has(arg));
  if (positional.length !== 1) fail(usage(), 1);

  const artifactPath = path.resolve(positional[0]);
  let outDir;
  if (rawOutDir !== undefined) {
    const { resolveNativeOutputDirectory } = await import('../packages/output/output-path.ts');
    try {
      outDir = resolveNativeOutputDirectory(rawOutDir);
    } catch (error) {
      const outputDiagnostic = fault(error).schematicsDiagnostics?.[0] || diagnostic({
        code: 'output/native-path-syntax',
        message: fault(error).message,
        subject: { output: rawOutDir },
        evidence: { ...(fault(error).code ? { systemCode: fault(error).code } : {}) },
        supportedFixes: ['choose an ordinary native filesystem directory and retry'],
      });
      const failure = {
        schemaVersion: 1,
        ok: false,
        command,
        evidenceKind: 'automated-browser',
        status: 'fail',
        visualReview: capture ? 'pending' : 'not-requested',
        artifact: { path: artifactPath },
        error: fault(error).message,
        diagnostics: [outputDiagnostic],
      };
      if (json) await printJson(failure);
      else {
        console.error(formatDiagnostics(`automated browser evidence failed: ${failure.error}`, failure.diagnostics));
        console.error('perceptual visual review pending');
      }
      process.exitCode = 1;
      return;
    }
  }
  const result = await executeBrowserEvidence({ artifactPath, outDir, requireProvenance, command, capture });

  if (result.inputFailure) {
    if (json) await printJson(result.receipt);
    else {
      console.error(formatDiagnostics(`automated browser evidence failed: ${result.receipt.error}`, result.receipt.diagnostics));
      console.error(capture ? 'perceptual visual review pending' : 'perceptual visual review not requested');
    }
    process.exitCode = result.exitCode;
    return;
  }

  if (json) {
    await printJson(result.receipt);
  } else {
    const sidecarDirectory = outDir || path.dirname(requiredPath(result.receipt.artifact?.path));
    console.log(`automated browser evidence ${result.receipt.status}: ${requiredPath(result.receipt.artifact?.path)}`);
    console.log(`${command} containment ${result.receipt.containment.status}; captures ${result.receipt.captures.status}; perceptual visual review ${result.receipt.visualReview}`);
    console.log(`receipt ${path.join(sidecarDirectory, result.receipt.sidecars.receipt)}`);
    if (result.receipt.captures.contactSheet) {
      console.log(`contact sheet ${path.join(sidecarDirectory, result.receipt.captures.contactSheet)}`);
    }
    if (result.receipt.error) console.error(result.receipt.error);
  }
  process.exitCode = result.exitCode;
}

async function commandVisualCheck(rawArgs: string[]): Promise<void> {
  return commandBrowserEvidence(rawArgs, { command: 'visual-check', capture: true });
}

async function commandBrowserCheck(rawArgs: string[]): Promise<void> {
  return commandBrowserEvidence(rawArgs, { command: 'browser-check', capture: false });
}

function extractFinalizeReceiptArgs(args: string[]): { rest: string[]; receiptPath: string | undefined } {
  const rest: string[] = [];
  let receiptPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--receipt') {
      receiptPath = args[index + 1];
      if (!receiptPath || receiptPath.startsWith('--')) rejectCliArgument('--receipt requires a JSON output path.', {
        code: 'cli/missing-option-value',
        subject: { option: '--receipt' },
        supportedFixes: ['provide one .json path after --receipt'],
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--receipt=')) {
      receiptPath = arg.slice('--receipt='.length);
      if (!receiptPath) rejectCliArgument('--receipt requires a JSON output path.', {
        code: 'cli/missing-option-value',
        subject: { option: '--receipt' },
        supportedFixes: ['provide one .json path after --receipt'],
      });
      continue;
    }
    rest.push(arg);
  }
  return { rest, receiptPath };
}

function extractCandidateSha256Args(args: string[]): { rest: string[]; candidateSha256: string | undefined } {
  const rest: string[] = [];
  let candidateSha256: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--candidate-sha256') {
      candidateSha256 = args[index + 1];
      if (!candidateSha256 || candidateSha256.startsWith('--')) rejectCliArgument('--candidate-sha256 requires a SHA-256 digest.', {
        code: 'cli/missing-option-value',
        subject: { option: '--candidate-sha256' },
        supportedFixes: ['provide the candidate sha256 from the passing validate receipt'],
      });
      index += 1;
      continue;
    }
    if (arg.startsWith('--candidate-sha256=')) {
      candidateSha256 = arg.slice('--candidate-sha256='.length);
      if (!candidateSha256) rejectCliArgument('--candidate-sha256 requires a SHA-256 digest.', {
        code: 'cli/missing-option-value',
        subject: { option: '--candidate-sha256' },
        supportedFixes: ['provide the candidate sha256 from the passing validate receipt'],
      });
      continue;
    }
    rest.push(arg);
  }
  if (candidateSha256 !== undefined && !/^[0-9a-f]{64}$/.test(candidateSha256)) {
    rejectCliArgument('--candidate-sha256 must be 64 lowercase hexadecimal characters.', {
      code: 'cli/invalid-option-value',
      subject: { option: '--candidate-sha256' },
      evidence: { value: candidateSha256 },
      supportedFixes: ['copy candidate.sha256 from the passing validate receipt without modification'],
    });
  }
  return { rest, candidateSha256 };
}

async function finalizeAttempt(rawArgs: string[]) {
  const qualityArgs = extractQualityArgs(rawArgs);
  const repoArgs = extractRepoRootArgs(qualityArgs.rest);
  const outDirArgs = extractOutDirArgs(repoArgs.rest);
  const receiptArgs = extractFinalizeReceiptArgs(outDirArgs.rest);
  const candidateArgs = extractCandidateSha256Args(receiptArgs.rest);
  const writingArgs = extractExplainerWritingArgs(candidateArgs.rest);
  candidateArgs.rest = writingArgs.rest;
  const json = candidateArgs.rest.includes('--json');
  const knownOptions = new Set(['--json','--browser-check']);
  const unknown = candidateArgs.rest.filter((arg) => arg.startsWith('--') && !knownOptions.has(arg));
  if (unknown.length) rejectCliArgument(`Unknown finalize option "${unknown[0]}".`, {
    code: 'cli/unknown-option',
    subject: { option: unknown[0] },
    supportedFixes: ['remove the unknown option and retry'],
  });
  const positional = candidateArgs.rest.filter((arg) => !knownOptions.has(arg));
  const [type, input, output] = positional;
  if (!type || !input || !output || positional.length !== 3) rejectCliArgument(usage(), {
    code: 'cli/usage',
    supportedFixes: ['use: schematics finalize <type> <input.json> <output.html> [options]'],
  });
  rendererPath(type);

  let runFinalize;
  try {
    ({ runFinalize } = await import('./finalize.ts'));
  } catch (error) {
    fail(`Could not load finalize: ${fault(error).message}`, 1);
  }

  let result;
  let explainerTemporary;
  try {
    let preparedExplainer;
    let preparedBundlePath;
    if (type === 'explainer') {
      preparedExplainer = await prepareExplainerInput(fs.readFileSync(path.resolve(input)), path.resolve(input), { repoRoot: repoArgs.repoRoot, quality: qualityArgs.quality || 'showcase', writingMode: writingArgs.writingMode });
      const { createOwnedTempDirectory } = await import('../packages/output/owned-temp-directory.ts');
      const { writePreparedBundle } = await import('../packages/explainer/prepare.ts');
      explainerTemporary = createOwnedTempDirectory('schematics-explainer-finalize-');
      preparedBundlePath = writePreparedBundle(explainerTemporary.path, preparedExplainer);
    }
    const pathIdentityRuntime = await loadPathIdentityRuntime();
    result = await runFinalize({
      ...(preparedExplainer ? { preparedExplainer, env: { ...process.env, SCHEMATICS_EXPLAINER_PREPARED: preparedBundlePath } } : {}),
      cliPath: fileURLToPath(import.meta.url),
      type,
      input,
      output,
      quality: qualityArgs.quality || 'showcase',
      repoRoot: repoArgs.repoRoot,
      writingMode: writingArgs.writingMode,
      browserCheck: candidateArgs.rest.includes('--browser-check'),
      candidateSha256: candidateArgs.candidateSha256,
      outDir: outDirArgs.outDir,
      receiptPath: receiptArgs.receiptPath,
      inspectDelivery: artifact => inspectArtifactDeliveryProvenance(artifact, true, pathIdentityRuntime),
      deliveryPaths: artifact => ({
        provenance: deliveryProvenancePath(artifact),
        pending: deliveryPendingPath(artifact),
        lock: deliverySidecarPath(artifact, '.delivery-lock.json'),
        directoryLock: path.join(path.dirname(deliveryProvenancePath(artifact)), DELIVERY_DIRECTORY_LOCK),
      }),
      runCheck: ({ artifactPath }) => checkDelivery(artifactPath, { requireProvenance: true }),
      runBrowserCheck: options => executeBrowserEvidence({
        ...options, command: 'browser-check', capture: false, requireProvenance: true,
      }),
    });
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      ok: false,
      command: 'finalize',
      status: 'fail',
      type,
      quality: qualityArgs.quality || 'showcase',
      specification: { path: path.resolve(input) },
      artifact: { path: path.resolve(output) },
      gates: Object.fromEntries(['validate', 'deliver', 'check', 'browser-check'].map((stage) => [stage, 'not-run'])),
      browserCheck: {requested:type !== 'explainer' || candidateArgs.rest.includes('--browser-check'),ran:false},
      diagnostics: fault(error).schematicsDiagnostics || [{
        code: fault(error).finalizeCode || 'finalize/runtime',
        severity: 'error',
        message: fault(error).message,
        ...(fault(error).finalizeEvidence ? { evidence: fault(error).finalizeEvidence } : {}),
      }],
      visualReview: 'not-requested',
    };
    return { json, type, input, exitCode: 1, started: false, summary: failure, receipt: failure };
  } finally {
    if (explainerTemporary) await explainerTemporary.cleanup();
  }
  return { json, type, input, exitCode: result.exitCode, started: true, summary: result.summary, receipt: result.receipt };
}

async function commandFinalize(rawArgs: string[]): Promise<void> {
  const { json, exitCode, started, summary } = await finalizeAttempt(rawArgs);
  if (!started) {
    if (json) console.log(JSON.stringify(summary));
    else console.error(formatDiagnostics('finalize could not start', summary.diagnostics));
    process.exitCode = exitCode;
    return;
  }
  if (json) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(`finalize ${summary.status}: ${summary.artifact.path}`);
    console.log(`gates ${Object.entries(summary.gates).map(([stage, status]) => `${stage}:${status}`).join(' ')}`);
    console.log(`receipt ${'evidence' in summary ? summary.evidence.receipt : undefined}`);
    console.log(`perceptual visual review ${summary.visualReview}`);
    for (const entry of summary.diagnostics || []) {
      if (entry.severity === 'warning') console.error(`warning [${entry.code}] ${entry.message}`);
    }
  }
  process.exitCode = exitCode;
}

const AUTOFIX_MAX_PASSES = 4;

async function commandAutofix(rawArgs: string[]): Promise<void> {
  const json = rawArgs.includes('--json');
  if (rawArgs[0] === 'explainer') rejectCliArgument('autofix repairs JSON diagram candidates; explainer is not supported.', {
    code: 'cli/unsupported-type',
    subject: { type: 'explainer' },
    supportedFixes: ['run schematics finalize explainer and apply its diagnostics by hand'],
  });
  const { applyRepairs } = await import('../packages/diagnostics/fixes.ts');
  const passes: Array<{ pass: number; applied: unknown; skipped: unknown }> = [];
  let attempt = await finalizeAttempt(rawArgs);
  for (let pass = 1; pass <= AUTOFIX_MAX_PASSES; pass += 1) {
    if (pass > 1) attempt = await finalizeAttempt(rawArgs);
    if (attempt.exitCode === 0) break;
    const candidatePath = path.resolve(attempt.input);
    const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
    const { candidate: repaired, applied, skipped } = applyRepairs(candidate, attempt.receipt.diagnostics);
    passes.push({ pass, applied, skipped });
    if (!json) {
      for (const entry of applied) console.log(`pass ${pass}: applied ${entry.code}: ${entry.edits.map((edit) => `${edit.pointer} = ${JSON.stringify(edit.value)}`).join(', ')}`);
      for (const entry of skipped) console.error(`pass ${pass}: left for the agent ${entry.code}: ${entry.reason}`);
    }
    if (!applied.length) break;
    fs.writeFileSync(candidatePath, `${JSON.stringify(repaired, null, 2)}\n`);
    if (pass === AUTOFIX_MAX_PASSES) attempt = await finalizeAttempt(rawArgs);
  }
  const passed = attempt.exitCode === 0;
  if (json) console.log(JSON.stringify({ ok: passed, passes, summary: attempt.summary }));
  else if (passed) console.log(`autofix passed: ${attempt.summary.artifact.path}`);
  else console.error(formatDiagnostics('autofix stopped with diagnostics left for the agent', attempt.summary.diagnostics || []));
  process.exitCode = passed ? 0 : 1;
}

async function commandChart(rawArgs: string[]): Promise<void> {
  const [inputPath, outputPath] = rawArgs;
  if (!inputPath) fail('Usage: schematics chart <input.mmd|text> [output.svg]');
  const text = fs.existsSync(inputPath) ? fs.readFileSync(inputPath, 'utf-8') : inputPath;
  const { compileExplainerChart } = await import('../packages/explainer/charts.ts');
  const result = compileExplainerChart(text);
  if (result.error !== undefined) {
    fail(`Chart compilation failed: ${result.error}`);
  }
  if (outputPath) {
    fs.writeFileSync(outputPath, result.svg, 'utf-8');
    console.log(`Rendered chart to ${outputPath} (${result.width}x${result.height})`);
  } else {
    console.log(result.svg);
  }
}

async function commandImport(rawArgs: string[]): Promise<void> {
  const rest: string[] = [];
  let json = false;
  let title: string | undefined;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = String(rawArgs[index]);
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--title') {
      title = rawArgs[index + 1];
      if (!title || title.startsWith('--')) fail('--title requires a value.');
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) fail(`Unknown import option "${arg}".`);
    rest.push(arg);
  }
  const [format, inputPath, outputPath] = rest;
  if (format !== 'mermaid' || !inputPath || rest.length > 3) fail(`Usage: schematics import ${COMMAND_USAGE.import}`);
  let text;
  try {
    text = fs.readFileSync(inputPath, 'utf8');
  } catch (error) {
    fail(`Mermaid input could not be read: ${fault(error).message}`, 1);
  }
  const { loadMermaidImporter } = await import(pathToFileURL(path.join(skillRoot, 'packages/mermaid/load.ts')).href);
  const { importMermaid, MermaidImportError } = await loadMermaidImporter();
  const htmlName = outputPath ? `${path.basename(outputPath).replace(/\.json$/i, '')}.html` : undefined;
  let result;
  try {
    result = importMermaid(text, { title, output: htmlName });
  } catch (error) {
    if (!(error instanceof MermaidImportError)) throw error;
    if (json) console.log(JSON.stringify({ schemaVersion: 1, ok: false, command: 'import', code: fault(error).code, error: fault(error).message }, null, 2));
    else console.error(`Mermaid import failed: ${fault(error).message}`);
    process.exit(1);
  }
  const serialized = `${JSON.stringify(result.diagram, null, 2)}\n`;
  if (outputPath) fs.writeFileSync(outputPath, serialized);
  if (json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: 'import',
      type: result.type,
      output: outputPath ?? null,
      notes: result.notes,
      ...(outputPath ? {} : { diagram: result.diagram }),
    }, null, 2));
    return;
  }
  if (!outputPath) {
    process.stdout.write(serialized);
    for (const note of result.notes) console.error(`note: ${note}`);
    return;
  }
  console.log(`Imported Mermaid as ${result.type}: ${outputPath}`);
  for (const note of result.notes) console.log(`  note: ${note}`);
  console.log(`Next: schematics finalize ${result.type} ${outputPath} ${outputPath.replace(/\.json$/i, '')}.html`);
}

function commandExamples(args: string[]): void {
  const unknown = args.find((arg) => arg.startsWith('--'));
  if (unknown) fail(`Unknown examples option "${unknown}".`);
  if (args.length) fail(usage());
  const result = runNode([path.join(skillRoot, 'scripts/render-examples.ts')], { cwd: skillRoot });
  if (result.status !== 0) exitFrom(result);
}

async function commandDoctor(args: string[]): Promise<void> {
  const unknown = args.find((arg) => arg.startsWith('--'));
  if (unknown) fail(`Unknown doctor option "${unknown}".`);
  if (args.length) fail(usage());
  const checks = [];
  const [bunMajor = 0, bunMinor = 0] = (process.versions.bun ?? '0.0').split('.').map(Number);
  checks.push({
    label: `Bun ${process.versions.bun ? `v${process.versions.bun}` : 'not detected'} (requires >=1.4)`,
    ok: bunMajor > 1 || (bunMajor === 1 && bunMinor >= 4),
    missing: 0,
    failureLabel: 'unsupported',
  });

  const template = path.join(skillRoot, 'assets/template.html');
  checks.push({
    label: 'Core template',
    ok: fs.existsSync(template),
    missing: fs.existsSync(template) ? 0 : 1,
  });

  const examplesRenderer = path.join(skillRoot, 'scripts/render-examples.ts');
  checks.push({
    label: 'Example renderer',
    ok: fs.existsSync(examplesRenderer),
    missing: fs.existsSync(examplesRenderer) ? 0 : 1,
  });

  const previewRuntime = path.join(skillRoot, 'bin/preview.ts');
  checks.push({
    label: 'Live preview runtime',
    ok: fs.existsSync(previewRuntime),
    missing: fs.existsSync(previewRuntime) ? 0 : 1,
  });

  const visualCheckRuntime = path.join(skillRoot, 'bin/visual-check.ts');
  checks.push({
    label: 'Visual-check runtime',
    ok: fs.existsSync(visualCheckRuntime),
    missing: fs.existsSync(visualCheckRuntime) ? 0 : 1,
  });

  const finalizeRuntime = path.join(skillRoot, 'bin/finalize.ts');
  checks.push({
    label: 'Finalize runtime',
    ok: fs.existsSync(finalizeRuntime),
    missing: fs.existsSync(finalizeRuntime) ? 0 : 1,
  });

  const outputPathRuntime = path.join(skillRoot, 'packages/output/output-path.ts');
  checks.push({
    label: 'Output path safety runtime',
    ok: fs.existsSync(outputPathRuntime),
    missing: fs.existsSync(outputPathRuntime) ? 0 : 1,
  });

  const atomicOutputRuntime = path.join(skillRoot, 'packages/output/atomic-output.ts');
  checks.push({
    label: 'Atomic output safety runtime',
    ok: fs.existsSync(atomicOutputRuntime),
    missing: fs.existsSync(atomicOutputRuntime) ? 0 : 1,
  });

  const pathSemanticsRuntime = path.join(skillRoot, 'packages/output/path-semantics.ts');
  checks.push({
    label: 'Physical path semantics runtime',
    ok: fs.existsSync(pathSemanticsRuntime),
    missing: fs.existsSync(pathSemanticsRuntime) ? 0 : 1,
  });

  const sidecarPathRuntime = path.join(skillRoot, 'packages/output/sidecar-path.ts');
  checks.push({
    label: 'Sidecar path naming runtime',
    ok: fs.existsSync(sidecarPathRuntime),
    missing: fs.existsSync(sidecarPathRuntime) ? 0 : 1,
  });

  const portablePathRuntime = path.join(skillRoot, 'packages/output/portable-path.ts');
  checks.push({
    label: 'Portable path contract runtime',
    ok: fs.existsSync(portablePathRuntime),
    missing: fs.existsSync(portablePathRuntime) ? 0 : 1,
  });

  const scenarioGuide = path.join(skillRoot, 'recipes/scenarios.ts');
  checks.push({
    label: 'Scenario recipe guide',
    ok: fs.existsSync(scenarioGuide),
    missing: fs.existsSync(scenarioGuide) ? 0 : 1,
  });

  const authoringReferences = [
    path.join(skillRoot, 'references', 'authoring-contract.md'),
    path.join(skillRoot, 'references', 'viewer-runtime.md'),
    path.join(skillRoot, 'references', 'delivery-contract.md'),
  ];
  const authoringReferencesMissing = authoringReferences.filter((file) => !fs.existsSync(file)).length;
  checks.push({
    label: 'Progressive authoring references',
    ok: authoringReferencesMissing === 0,
    missing: authoringReferencesMissing,
  });

  const compareRuntime = path.join(skillRoot, 'packages/delta/architecture-delta.ts');
  const compareFixtures = [
    path.join(skillRoot, 'examples/checkout-platform.base.architecture.json'),
    path.join(skillRoot, 'examples/checkout-platform.head.architecture.json'),
  ];
  const compareMissing = [compareRuntime, ...compareFixtures].filter((file) => !fs.existsSync(file)).length;
  checks.push({
    label: 'Architecture compare runtime and proof fixtures',
    ok: compareMissing === 0,
    missing: compareMissing,
  });

  const validators = path.join(skillRoot, 'packages/validation/generated-validators.ts');
  const validatorsExist = fs.existsSync(validators);
  let validatorsValid = false;
  if (validatorsExist) {
    try {
      const module = await import(`${pathToFileURL(validators).href}?doctor=${Date.now()}`);
      validatorsValid = [...TYPES].every((type) => typeof module[type] === 'function');
    } catch {
      validatorsValid = false;
    }
  }
  checks.push({
    label: 'Standalone schema validators',
    ok: validatorsValid,
    missing: validatorsExist ? 0 : 1,
    invalid: validatorsExist && !validatorsValid ? 1 : 0,
    failureLabel: validatorsExist ? 'invalid' : 'missing',
  });

  const examples: Record<string, string> = {
    architecture: 'web-app.architecture.json',
    workflow: 'agent-tool-call.workflow.json',
    sequence: 'cache-miss-request.sequence.json',
    dataflow: 'product-analytics.dataflow.json',
    lifecycle: 'agent-run.lifecycle.json',
    erd: 'orders.erd.json',
    tree: 'payment-platform.tree.json',
    class: 'payments.class.json',
    timeline: 'payment-incident.timeline.json',
    waterfall: 'checkout-request.waterfall.json',
    explainer: 'delivery.explainer.json',
  };

  for (const type of TYPES) {
    const required = [
      rendererPath(type),
      path.join(skillRoot, 'schemas', `${type}.schema.json`),
      path.join(skillRoot, 'examples', examples[type]),
    ];
    const missing = required.filter((file) => !fs.existsSync(file)).length;
    checks.push({
      label: `${type} renderer, schema, and example`,
      ok: missing === 0,
      missing,
    });
  }

  const explainerRuntime = ['parse.ts', 'validate.ts', 'inline.ts', 'sources.ts', 'writing.ts', 'diagrams.ts', 'prepare.ts', 'patch.ts', 'diff.ts', 'revision.ts', 'layout.ts', 'render.ts', 'check.ts', 'browser-check.ts', 'charts.ts', 'page-bundle.ts', 'vendor/pele/core.js', 'reader.css', 'reader.js'];
  const missingExplainerRuntime = explainerRuntime.filter(file => !fs.existsSync(path.join(skillRoot, 'packages', 'explainer', file))).length;
  checks.push({label:'Explainer runtime and reader assets',ok:missingExplainerRuntime===0,missing:missingExplainerRuntime});

  console.log('Schematics doctor\n');
  for (const check of checks) {
    console.log(`[${check.ok ? 'ok' : (check.failureLabel || 'missing')}] ${check.label}`);
  }

  const runtimeFailed = checks[0].ok ? 0 : 1;
  const missingFiles = checks.reduce((count, check) => count + check.missing, 0);
  const invalidRuntime = checks.reduce((count, check) => count + (check.invalid || 0), 0);
  if (runtimeFailed === 0 && missingFiles === 0 && invalidRuntime === 0) {
    console.log('\nSchematics is ready.');
    return;
  }

  const problems = [];
  if (runtimeFailed) problems.push('Bun 1.4 or newer is required');
  if (missingFiles) problems.push(`${missingFiles} required file${missingFiles === 1 ? '' : 's'} missing`);
  if (invalidRuntime) problems.push(`${invalidRuntime} runtime check${invalidRuntime === 1 ? '' : 's'} failed`);
  console.error(`\nSchematics is not ready: ${problems.join('; ')}.`);
  process.exitCode = 1;
}

async function commandGuide(args: string[]): Promise<void> {
  let lang: 'en' | 'zh' | undefined;
  let json = false;
  const queryParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--json') {
      json = true;
    } else if (arg === '--lang') {
      const value = args[index + 1];
      if (value !== 'en' && value !== 'zh') fail('--lang must be "en" or "zh".');
      lang = value;
      index += 1;
    } else if (arg.startsWith('--lang=')) {
      const value = arg.slice('--lang='.length);
      if (value !== 'en' && value !== 'zh') fail('--lang must be "en" or "zh".');
      lang = value;
    } else if (arg.startsWith('--')) {
      fail(`Unknown guide option "${arg}".`);
    } else {
      queryParts.push(arg);
    }
  }

  const guidePath = path.join(skillRoot, 'recipes/scenarios.ts');
  let guide;
  try {
    guide = await import(pathToFileURL(guidePath).href);
  } catch (error) {
    fail(`Could not load the scenario recipe guide: ${fault(error).message}`, 1);
  }

  const query = queryParts.join(' ').trim();
  if (!query) {
    const selectedLang = lang || 'en';
    if (json) {
      console.log(JSON.stringify({
        ok: true,
        mode: 'list',
        lang: selectedLang,
        recipes: guide.listScenarioRecipes(selectedLang),
      }, null, 2));
    } else {
      console.log(guide.formatScenarioList(selectedLang));
    }
    return;
  }

  const result = guide.recommendScenario(query, lang ? { lang } : {});
  console.log(json ? JSON.stringify(result, null, 2) : guide.formatScenarioRecommendation(result));
}

async function commandBrands(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const unknown = args.filter((arg) => arg.startsWith('--') && arg !== '--json');
  if (unknown.length) fail(`Unknown brands option "${unknown[0]}".`);
  const positional = args.filter((arg) => arg !== '--json');
  if (positional[0] === 'capture') {
    if (positional.length !== 2) fail('Usage: schematics brands capture <url> [--json]');
    const { captureBrandReference } = await import('../packages/svg/brand-marks.ts');
    let capture;
    try {
      capture = await captureBrandReference(String(positional[1]));
    } catch (error) {
      fail(fault(error).message);
    }
    const result = {
      schemaVersion: 1,
      ok: true,
      command: 'brands capture',
      brand: capture.brand,
      evidence: {
        status: capture.resolved.status,
        source: capture.resolved.sourceUrl,
        ...(field(capture.resolved, 'sha256') ? { sha256: field(capture.resolved, 'sha256') } : {}),
        ...(field(capture.resolved, 'contentType') ? { contentType: field(capture.resolved, 'contentType') } : {}),
      },
    };
    console.log(json ? JSON.stringify(result, null, 2) : JSON.stringify(result.brand));
    return;
  }
  const query = positional.join(' ').trim();
  const { listBrandMarks } = await import('../packages/svg/brand-marks.ts');
  const marks = listBrandMarks(query);
  if (json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: 'brands',
      query,
      count: marks.length,
      marks,
      fallback: 'Run "schematics brands capture <url> --json", then use the returned digest-pinned brand value.',
    }, null, 2));
    return;
  }
  if (!marks.length) {
    console.log(`No built-in brand matched "${query}". Run "schematics brands capture <url> --json", then use the returned digest-pinned brand value.`);
    return;
  }
  const groupBy: ((items: typeof marks, key: (mark: (typeof marks)[number]) => string) => Map<string, typeof marks>) | undefined = Reflect.get(Map, 'groupBy');
  const grouped = groupBy
    ? groupBy.call(Map, marks, (mark) => mark.category)
    : marks.reduce((map, mark) => map.set(mark.category, [...(map.get(mark.category) || []), mark]), new Map<string, typeof marks>());
  for (const [category, entries] of grouped) {
    console.log(`${category}: ${entries.map((mark) => mark.id).join(', ')}`);
  }
}

function commandDemo(args: string[]): void {
  const unknown = args.find((arg) => arg.startsWith('--'));
  if (unknown) fail(`Unknown demo option "${unknown}".`);
  if (args.length > 1) fail(usage());

  const outputDirectory = path.resolve(args[0] || process.cwd());
  const output = path.join(outputDirectory, 'schematics-demo.html');
  const input = path.join(skillRoot, 'examples/web-app.architecture.json');

  try {
    fs.mkdirSync(outputDirectory, { recursive: true });
  } catch (error) {
    fail(`Could not create demo directory "${outputDirectory}": ${fault(error).message}`, 1);
  }

  const result = runNode([rendererPath('architecture'), input, output]);
  if (result.status !== 0) exitFrom(result);

  console.log(`\nDemo ready: ${output}`);
  console.log('Next: open the HTML in your browser, then render your own diagram:');
  console.log('  schematics render architecture <input.json> <output.html>');
}

function migrationPathDiagnostics(error: unknown, sourcePath: string, destinationPath: string): Diagnostic[] {
  const pathDiagnostics = fault(error).schematicsDiagnostics;
  if (Array.isArray(pathDiagnostics) && pathDiagnostics.length) {
    return pathDiagnostics.map((entry) => ({
      ...entry,
      subject: { ...(entry.subject || {}) },
      evidence: { ...(entry.evidence || {}) },
      supportedFixes: [...(entry.supportedFixes || [])],
    }));
  }
  return [diagnostic({
    code: 'migration/path-preflight',
    message: 'Could not verify that the workflow migration paths are distinct.',
    subject: { source: sourcePath, destination: destinationPath },
    evidence: {
      ...(fault(error).code ? { systemCode: fault(error).code } : {}),
      reason: fault(error).message || String(error),
    },
    supportedFixes: ['remove unsafe path aliases or choose a different destination path'],
  })];
}

type MigrationEntry = Diagnostic
  | WorkflowMigrationResult['preExistingDiagnostics'][number]
  | WorkflowMigrationResult['migrationDiagnostics'][number];

interface MigrationReportInput {
  ok: boolean;
  sourcePath: string;
  destinationPath: string;
  sourceBytes?: Buffer | undefined;
  destinationBytes?: Buffer | undefined;
  fromSchemaVersion?: unknown;
  preExistingDiagnostics?: readonly MigrationEntry[];
  migrationDiagnostics?: readonly MigrationEntry[];
  newSchemaDiagnostics?: readonly MigrationEntry[];
  changedCoordinates?: unknown[];
  oldRequiredViewBox?: unknown;
  newRequiredViewBox?: unknown;
}

interface MigrationFileReport {
  path: string;
  sha256?: string;
  bytes?: number;
}

interface MigrationReport {
  ok: boolean;
  command: string;
  type: string;
  source: MigrationFileReport;
  destination: MigrationFileReport;
  fromSchemaVersion: unknown;
  toSchemaVersion: number;
  preExistingDiagnostics: readonly MigrationEntry[];
  migrationDiagnostics: readonly MigrationEntry[];
  newSchemaDiagnostics: readonly MigrationEntry[];
  changedCoordinates: unknown[];
  oldRequiredViewBox: unknown;
  newRequiredViewBox: unknown;
  diagnostics?: MigrationEntry[];
  error?: string | undefined;
}

interface MigrationSourceDocument {
  schema_version?: unknown;
  meta?: { output?: unknown; quality_profile?: string; [detail: string]: unknown };
  [detail: string]: unknown;
}

function migrationReport({
  ok,
  sourcePath,
  destinationPath,
  sourceBytes,
  destinationBytes,
  fromSchemaVersion,
  preExistingDiagnostics = [],
  migrationDiagnostics = [],
  newSchemaDiagnostics = [],
  changedCoordinates = [],
  oldRequiredViewBox = null,
  newRequiredViewBox = null,
}: MigrationReportInput): MigrationReport {
  const report: MigrationReport = {
    ok,
    command: 'migrate',
    type: 'workflow',
    source: {
      path: sourcePath,
      ...(sourceBytes ? {
        sha256: new Bun.CryptoHasher('sha256').update(sourceBytes).digest('hex'),
        bytes: sourceBytes.length,
      } : {}),
    },
    destination: {
      path: destinationPath,
      ...(destinationBytes ? {
        sha256: new Bun.CryptoHasher('sha256').update(destinationBytes).digest('hex'),
        bytes: destinationBytes.length,
      } : {}),
    },
    fromSchemaVersion: fromSchemaVersion ?? null,
    toSchemaVersion: 2,
    preExistingDiagnostics,
    migrationDiagnostics,
    newSchemaDiagnostics,
    changedCoordinates,
    oldRequiredViewBox,
    newRequiredViewBox,
  };
  if (!ok) {
    report.diagnostics = [
      ...migrationDiagnostics,
      ...newSchemaDiagnostics,
      ...preExistingDiagnostics,
    ];
    if (!report.diagnostics.length) {
      report.diagnostics.push(diagnostic({
        code: 'migration/internal',
        message: 'Workflow migration failed without a classified diagnostic.',
      }));
    }
    report.error = firstDiagnostic(report.diagnostics).message;
  }
  return report;
}

function extractMigrationOptions(args: string[]): { positional: string[]; json: boolean; toSchema: string | undefined; output: string | undefined } {
  const positional: string[] = [];
  let json = false;
  let toSchema: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--to-schema') {
      toSchema = args[index + 1];
      if (!toSchema || toSchema.startsWith('--')) fail('--to-schema requires a schema version.');
      index += 1;
      continue;
    }
    if (arg.startsWith('--to-schema=')) {
      toSchema = arg.slice('--to-schema='.length);
      if (!toSchema) fail('--to-schema requires a schema version.');
      continue;
    }
    if (arg === '--output') {
      output = args[index + 1];
      if (!output || output.startsWith('--')) fail('--output requires a portable HTML path.');
      index += 1;
      continue;
    }
    if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length);
      if (!output) fail('--output requires a portable HTML path.');
      continue;
    }
    if (arg.startsWith('--')) fail(`Unknown migrate option "${arg}".`);
    positional.push(arg);
  }
  return { positional, json, toSchema, output };
}

async function commandMigrate(args: string[]): Promise<void> {
  const repoArgs = extractRepoRootArgs(args);
  const options = extractMigrationOptions(repoArgs.rest);
  const [type, sourceArgument, destinationArgument] = options.positional;
  if (
    type !== 'workflow'
    || !sourceArgument
    || !destinationArgument
    || options.positional.length !== 3
    || options.toSchema !== '2'
  ) {
    fail('Usage: schematics migrate workflow <old.json> <new.json> --to-schema 2 [--output portable.html] [--json] [--repo-root path]');
  }

  const sourcePath = path.resolve(sourceArgument);
  const destinationPath = path.resolve(destinationArgument);
  let sourceBytes: Buffer | undefined;
  let sourceDocument: MigrationSourceDocument | undefined;
  const reportMigrationFailure = ({ status = 1, ...details }: Omit<MigrationReportInput, 'ok' | 'sourcePath' | 'destinationPath'> & { ok?: boolean; status?: number }) => {
    const report = migrationReport({
      ...details,
      ok: false,
      sourcePath,
      destinationPath,
      sourceBytes,
      fromSchemaVersion: sourceDocument?.schema_version,
    });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.error(formatDiagnostics(report.error, report.diagnostics));
    process.exitCode = status;
  };
  try {
    sourceBytes = fs.readFileSync(sourcePath);
    sourceDocument = JSON.parse(sourceBytes.toString('utf8'));
  } catch (error) {
    reportMigrationFailure({
      preExistingDiagnostics: [inputDiagnostic(error, sourcePath)],
    });
    return;
  }
  const { pathsAlias, validateAuthoredOutputPath } = await import('../packages/output/output-path.ts');
  const {
    backupPublicRegularFileBinding,
    captureAtomicOutput,
    captureRegularFileBinding,
    quarantineRemoveRegularFileBinding,
    releaseRegularFileBinding,
    verifyAtomicOutput,
    verifyRegularFileBinding,
  } = await import('../packages/output/atomic-output.ts');
  // `--output` repairs only the durable output field in the migration
  // candidate. It never writes the source and deliberately leaves every
  // other schema and compiler failure visible to the normal migration path.
  let migrationSourceDocument = sourceDocument;
  if (options.output !== undefined) {
    try {
      validateAuthoredOutputPath(options.output);
    } catch (error) {
      reportMigrationFailure({
        preExistingDiagnostics: migrationPathDiagnostics(error, sourcePath, destinationPath),
      });
      return;
    }
    if (sourceDocument?.meta && typeof sourceDocument.meta === 'object' && !Array.isArray(sourceDocument.meta)) {
      migrationSourceDocument = {
        ...sourceDocument,
        meta: { ...sourceDocument.meta, output: options.output },
      };
    }
  }
  if (migrationSourceDocument?.meta?.output !== undefined) {
    try {
      validateAuthoredOutputPath(migrationSourceDocument.meta.output);
    } catch (error) {
      reportMigrationFailure({
        preExistingDiagnostics: migrationPathDiagnostics(error, sourcePath, destinationPath),
      });
      return;
    }
  }
  // Unlike render/validate, migrate has no --quality override. Pin every stage
  // to the document's durable policy and scrub any ambient profile from the
  // staged renderer by passing this value explicitly.
  const activeQualityProfile = migrationSourceDocument?.meta?.quality_profile || 'standard';

  let sourceDestinationAlias;
  try {
    sourceDestinationAlias = pathsAlias(sourcePath, destinationPath);
  } catch (error) {
    reportMigrationFailure({
      migrationDiagnostics: migrationPathDiagnostics(error, sourcePath, destinationPath),
    });
    return;
  }
  if (sourceDestinationAlias) {
    reportMigrationFailure({
      migrationDiagnostics: [diagnostic({
        code: 'migration/source-destination',
        message: 'Workflow migration source and destination must be different files.',
        subject: { source: sourcePath, destination: destinationPath },
        supportedFixes: ['choose a different destination path and keep the source unchanged'],
      })],
    });
    return;
  }

  const { migrateWorkflowDocument, serializeMigratedWorkflow } = await import('../packages/migrations/workflow-v2.ts');
  let migration;
  try {
    migration = migrateWorkflowDocument(migrationSourceDocument);
  } catch (error) {
    migration = {
      ok: false,
      migrationDiagnostics: [diagnostic({
        code: 'migration/internal',
        message: 'Workflow migration failed unexpectedly.',
        evidence: { reason: fault(error).message },
        supportedFixes: ['report the source workflow and this diagnostic to the Schematics maintainers'],
      })],
      newSchemaDiagnostics: [],
    };
  }

  if (!migration.ok) {
    reportMigrationFailure(migration);
    return;
  }

  const destinationDirectory = path.dirname(destinationPath);
  let stagingDirectory;
  let stagingIdentity;
  let destinationCapture;
  try {
    fs.mkdirSync(destinationDirectory, { recursive: true });
    destinationCapture = captureAtomicOutput(destinationPath, {
      requestedEntryPolicy: 'regular-or-absent',
    });
    if (destinationCapture.status !== 'captured') {
      reportMigrationFailure({
        ...migration,
        migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
          code: 'migration/destination-type',
          message: 'Workflow migration destination must be an absent or stable regular file path.',
          subject: { destination: destinationPath },
          evidence: { targetState: destinationCapture.reason },
          supportedFixes: ['choose a destination path that is absent or names one non-hardlinked regular file'],
        })],
      });
      return;
    }
    const staging = createOwnedEmptyStagingDirectory(
      path.join(destinationDirectory, '.schematics-migration-'),
    );
    stagingDirectory = staging.directory;
    stagingIdentity = staging.identity;
  } catch (error) {
    reportMigrationFailure({
      ...migration,
      migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
        code: 'migration/prepare-destination',
        message: 'Could not prepare the workflow migration destination.',
        subject: { destination: destinationPath },
        evidence: { ...(fault(error).code ? { systemCode: fault(error).code } : {}), reason: fault(error).message },
        supportedFixes: ['choose a writable destination directory'],
      })],
    });
    return;
  }

  const candidatePath = path.join(stagingDirectory, 'candidate.workflow.json');
  const artifactPath = path.join(stagingDirectory, 'migration-check.html');
  const destinationBytes = Buffer.from(serializeMigratedWorkflow(migration.document));
  let candidateBinding: AtomicOutput.RegularFileBinding | null = null;
  let previousDestinationBinding: AtomicOutput.RegularFileBinding | null = null;
  let preserveRecoveryDirectory = false;
  const fileBindingRuntime = {
    captureRegularFileBinding,
    quarantineRemoveRegularFileBinding,
    releaseRegularFileBinding,
  };
  const stagingOwnership: StagingEntry[] = [];
  try {
    fs.writeFileSync(candidatePath, destinationBytes, { flag: 'wx' });
    if (destinationCapture.mode !== null) fs.chmodSync(candidatePath, destinationCapture.mode);
    const candidateCapture = captureOwnedStagingFile(
      stagingOwnership,
      candidatePath,
      fileBindingRuntime,
      {
        subject: 'migration-candidate',
        content: artifactIdentity(destinationBytes),
      },
    );
    candidateBinding = candidateCapture.binding;
    const render = runNode([rendererPath('workflow'), candidatePath, artifactPath], {
      stdio: 'pipe',
      env: rendererEnv(activeQualityProfile, repoArgs.repoRoot, true),
    });
    if (render.status !== 0) {
      const failure = rendererFailure(render);
      reportMigrationFailure({
        ...migration,
        newSchemaDiagnostics: [...migration.newSchemaDiagnostics, ...failure.diagnostics],
        status: render.status ?? 1,
      });
      return;
    }
    const migrationArtifact = fs.readFileSync(artifactPath);
    captureOwnedStagingFile(stagingOwnership, artifactPath, fileBindingRuntime, {
      subject: 'migration-check-artifact',
      content: artifactIdentity(migrationArtifact),
    });

    const check = await runArtifactCheck(artifactPath);
    if (!check.receipt?.ok) {
      reportMigrationFailure({
        ...migration,
        newSchemaDiagnostics: [
          ...migration.newSchemaDiagnostics,
          ...checkerDiagnostics(check.receipt || null),
        ],
        status: 1,
      });
      return;
    }

    if (pathsAlias(sourcePath, destinationPath)) {
      reportMigrationFailure({
        ...migration,
        migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
          code: 'migration/source-destination',
          message: 'Workflow migration source and destination resolved to the same file before commit.',
          subject: { source: sourcePath, destination: destinationPath },
          supportedFixes: ['choose a different destination path and retry'],
        })],
      });
      return;
    }
    const currentSourceBytes = fs.readFileSync(sourcePath);
    if (!currentSourceBytes.equals(sourceBytes)) {
      reportMigrationFailure({
        ...migration,
        migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
          code: 'migration/source-changed',
          message: 'Workflow migration source changed while the destination was being verified.',
          subject: { source: sourcePath },
          supportedFixes: ['retry the migration from a stable workflow source file'],
        })],
      });
      return;
    }

    const candidateVerification = verifyRegularFileBinding(candidateBinding, { expectedLinks: 1 });
    if (candidateVerification.status !== 'match') {
      reportMigrationFailure({
        ...migration,
        migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
          code: 'migration/candidate-changed',
          message: 'Workflow migration candidate changed before the destination commit.',
          subject: { destination: destinationPath },
          evidence: { candidateState: candidateVerification.reason },
          supportedFixes: ['retry the migration from a stable workflow source and destination'],
        })],
      });
      return;
    }

    const destinationVerification = verifyAtomicOutput(destinationCapture.snapshot);
    if (destinationVerification.status !== 'match') {
      reportMigrationFailure({
        ...migration,
        migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
          code: 'migration/destination-changed',
          message: 'Workflow migration destination changed while the candidate was being verified.',
          subject: { destination: destinationPath },
          evidence: { targetState: destinationVerification.reason },
          supportedFixes: ['retry only after other processes stop creating, replacing, or redirecting the destination'],
        })],
      });
      return;
    }
    const backupPath = path.join(stagingDirectory, '.previous-destination');
    let backupPresent = false;
    if (destinationCapture.snapshot.target.kind === 'file') {
      const expected = destinationCapture.snapshot.target;
      const previousCapture = captureRegularFileBinding(destinationCapture.commitPath, {
        subject: 'previous-migration-destination',
        expectedIdentity: { device: expected.device, inode: expected.inode },
        expectedMode: expected.mode,
        expectedLinks: 1,
      });
      if (previousCapture.status !== 'captured') {
        reportMigrationFailure({
          ...migration,
          migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
            code: 'migration/destination-changed',
            message: 'Workflow migration destination changed before publication.',
            subject: { destination: destinationPath },
            evidence: { targetState: previousCapture.reason },
            supportedFixes: ['retry only after other processes stop changing the destination'],
          })],
        });
        return;
      }
      previousDestinationBinding = previousCapture.binding;
      const backedUp = backupPublicRegularFileBinding(
        previousDestinationBinding,
        destinationCapture.commitPath,
        backupPath,
        { subject: 'previous-migration-destination' },
      );
      backupPresent = backedUp.backupCreated === true;
      if (backedUp.status !== 'backed-up') {
        preserveRecoveryDirectory = backupPresent || backedUp.status === 'recovery-required';
        reportMigrationFailure({
          ...migration,
          migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
            code: 'migration/destination-changed',
            message: 'Workflow migration destination changed while its previous value was being preserved.',
            subject: { destination: destinationPath },
            evidence: {
              targetState: backedUp.reason,
              ...(backedUp.recoveryFile ? { recoveryFile: backedUp.recoveryFile } : {}),
            },
            supportedFixes: ['inspect the retained recovery entry before retrying'],
          })],
        });
        return;
      }
    }

    const candidateBeforePublish = verifyRegularFileBinding(candidateBinding, {
      filePath: candidatePath,
      expectedLinks: 1,
    });
    if (candidateBeforePublish.status !== 'match') {
      preserveRecoveryDirectory = backupPresent;
      reportMigrationFailure({
        ...migration,
        migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
          code: 'migration/candidate-changed',
          message: 'Workflow migration candidate changed before publication.',
          subject: { destination: destinationPath },
          evidence: { candidateState: candidateBeforePublish.reason },
          supportedFixes: ['inspect any retained previous destination, then retry'],
        })],
      });
      return;
    }
    try {
      fs.linkSync(candidatePath, destinationCapture.commitPath);
    } catch (error) {
      preserveRecoveryDirectory = backupPresent;
      reportMigrationFailure({
        ...migration,
        migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
          code: 'migration/destination-changed',
          message: 'Workflow migration destination was claimed during publication.',
          subject: { destination: destinationPath },
          evidence: {
            ...(fault(error).code ? { systemCode: fault(error).code } : {}),
            ...(backupPresent ? { recoveryFile: backupPath } : {}),
          },
          supportedFixes: backupPresent
            ? ['preserve the claimant and inspect the retained previous destination before retrying']
            : ['preserve the claimant and retry with a different destination'],
        })],
      });
      return;
    }
    const published = verifyRegularFileBinding(candidateBinding, {
      filePath: destinationCapture.commitPath,
      expectedLinks: 2,
    });
    if (published.status !== 'match') {
      preserveRecoveryDirectory = backupPresent;
      reportMigrationFailure({
        ...migration,
        migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
          code: 'migration/destination-changed',
          message: 'Workflow migration destination changed during publication.',
          subject: { destination: destinationPath },
          evidence: { targetState: published.reason },
          supportedFixes: ['preserve the current claimant and inspect any retained recovery entry'],
        })],
      });
      return;
    }
    const removedCandidate = quarantineRemoveRegularFileBinding(candidateBinding, candidatePath, {
      subject: 'migration-candidate',
      expectedLinks: 2,
    });
    if (removedCandidate.status !== 'removed') {
      preserveRecoveryDirectory = backupPresent || removedCandidate.status === 'recovery-required';
      reportMigrationFailure({
        ...migration,
        migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
          code: 'migration/candidate-changed',
          message: 'Workflow migration candidate changed while publication was finalized.',
          subject: { destination: destinationPath },
          evidence: { candidateState: removedCandidate.reason },
          supportedFixes: ['preserve the candidate claimant and inspect the published destination'],
        })],
      });
      return;
    }
    const finalized = verifyRegularFileBinding(candidateBinding, {
      filePath: destinationCapture.commitPath,
      expectedLinks: 1,
    });
    if (finalized.status !== 'match') {
      preserveRecoveryDirectory = backupPresent;
      reportMigrationFailure({
        ...migration,
        migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
          code: 'migration/destination-changed',
          message: 'Published workflow migration changed before final verification.',
          subject: { destination: destinationPath },
          evidence: { targetState: finalized.reason },
          supportedFixes: ['preserve the current claimant and inspect any retained recovery entry'],
        })],
      });
      return;
    }
    if (backupPresent) {
      const removedBackup = quarantineRemoveRegularFileBinding(
        previousDestinationBinding ?? UNBOUND_FILE,
        backupPath,
        { subject: 'previous-migration-destination', expectedLinks: 1 },
      );
      if (removedBackup.status === 'removed') backupPresent = false;
    }
    const finalPublishedState = verifyRegularFileBinding(candidateBinding, {
      filePath: destinationCapture.commitPath,
      expectedLinks: 1,
    });
    if (finalPublishedState.status !== 'match') {
      preserveRecoveryDirectory = backupPresent;
      reportMigrationFailure({
        ...migration,
        migrationDiagnostics: [...migration.migrationDiagnostics, diagnostic({
          code: 'migration/destination-changed',
          message: 'Published workflow migration did not remain stable through finalization.',
          subject: { destination: destinationPath },
          evidence: { targetState: finalPublishedState.reason },
          supportedFixes: ['preserve the current destination and inspect any retained recovery entry'],
        })],
      });
      return;
    }
    const report = migrationReport({
      ...migration,
      sourcePath,
      destinationPath,
      sourceBytes,
      destinationBytes,
      fromSchemaVersion: sourceDocument?.schema_version,
    });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else if (sourceDocument?.schema_version === 1) {
      console.log(`migrated workflow schema v1→v2: ${sourcePath} → ${destinationPath}`);
    } else {
      console.log(`verified workflow schema v2 migration: ${sourcePath} → ${destinationPath}`);
    }
  } catch (error) {
    const migrationDiagnostics = Array.isArray(fault(error).schematicsDiagnostics)
      ? migrationPathDiagnostics(error, sourcePath, destinationPath)
      : [diagnostic({
        code: 'migration/commit',
        message: 'Could not commit the verified workflow migration.',
        subject: { destination: destinationPath },
        evidence: { ...(fault(error).code ? { systemCode: fault(error).code } : {}), reason: fault(error).message },
        supportedFixes: ['choose a writable regular-file destination and retry'],
      })];
    reportMigrationFailure({
      ...migration,
      migrationDiagnostics: [...migration.migrationDiagnostics, ...migrationDiagnostics],
    });
  } finally {
    if (previousDestinationBinding) releaseRegularFileBinding(previousDestinationBinding);
    try {
      if (preserveRecoveryDirectory) {
        releaseOwnedStagingBindings(stagingOwnership, fileBindingRuntime);
      } else {
        cleanupOwnedStagingDirectory(
          stagingDirectory,
          stagingIdentity,
          stagingOwnership,
          fileBindingRuntime,
        );
      }
    } catch (error) {
      console.error(`Warning: could not remove workflow migration staging directory "${stagingDirectory}": ${fault(error).message}`);
    }
  }
}

// `inspect` delegates here in layout-JSON mode, so argument failures must be
// attributed to the command the caller actually invoked.
async function commandValidate(args: string[], invocation: { command?: string } = {}): Promise<void> {
  const invokingCommand = invocation.command || 'validate';
  const reportFailure = (options: Omit<ArtifactFailureReport, 'command'>) => reportArtifactFailure({ ...options, command: invokingCommand });
  const qualityArgs = extractQualityArgs(args);
  const repoArgs = extractRepoRootArgs(qualityArgs.rest);
  const writingArgs = extractExplainerWritingArgs(repoArgs.rest);
  repoArgs.rest = writingArgs.rest;
  args = repoArgs.rest;
  const quality = qualityArgs.quality;
  const repoRoot = repoArgs.repoRoot;
  const knownOptions = new Set(['--json', '--layout-json']);
  const unknown = args.filter((arg) => arg.startsWith('--') && !knownOptions.has(arg));
  if (unknown.length) rejectCliArgument(`Unknown ${invokingCommand} option "${unknown[0]}".`, {
    code: 'cli/unknown-option',
    subject: { option: unknown[0] },
    supportedFixes: ['remove the unknown option and retry'],
  });
  const json = args.includes('--json');
  const layoutJson = args.includes('--layout-json');
  const rest = args.filter((arg) => !knownOptions.has(arg));
  const [type, input] = rest;
  if (!type || !input || rest.length !== 2) rejectCliArgument(usage(), {
    code: 'cli/usage',
    supportedFixes: [`use: schematics ${invokingCommand} <type> <input.json> [options]`],
  });
  const renderer = rendererPath(type);

  if (layoutJson && !['architecture', 'workflow'].includes(type)) {
    rejectCliArgument('--layout-json is currently supported for architecture and workflow diagrams only.', {
      code: 'cli/unsupported-option',
      subject: { option: '--layout-json', type },
      supportedFixes: ['remove --layout-json or use an architecture or workflow diagram'],
    });
  }

  const inputPath = path.resolve(input);
  let specification;
  let explainerBundle;
  try {
    specification = fs.readFileSync(inputPath);
    if (type === 'explainer') explainerBundle = await prepareExplainerInput(specification, inputPath, { repoRoot, quality, writingMode: writingArgs.writingMode });
    const document = explainerBundle?.document || JSON.parse(specification.toString('utf8'));
    const [{ validateAuthoredOutputPath }, { validateSchema }] = await Promise.all([
      import('../packages/output/output-path.ts'),
      import('../packages/validation/validator.ts'),
    ]);
    if (document?.meta?.output !== undefined) validateAuthoredOutputPath(document.meta.output);
    else if (type !== 'explainer') validateSchema(type, document);
  } catch (error) {
    const diagnostics = fault(error).schematicsDiagnostics || [inputDiagnostic(error, inputPath)];
    reportFailure({
      json,
      stage: diagnostics.some((entry) => entry.code.startsWith('input/')) ? 'input' : 'render',
      type,
      input: inputPath,
      error: fault(error).message,
      diagnostics,
      status: 1,
    });
    return;
  }

  if (layoutJson) {
    // Layout mode emits JSON without writing HTML; keep its unused target typed.
    const layoutOutput = path.join(os.tmpdir(), `schematics-layout-${process.pid}-${type}.html`);
    const result = runNode([renderer, input, layoutOutput, '--layout-json'], {
      stdio: 'pipe',
      env: rendererEnv(quality, repoRoot, true),
    });
    if (result.status !== 0) {
      if (!result.error) {
        try {
          const receipt = JSON.parse(result.stdout);
          if (receipt?.contract && Array.isArray(receipt.diagnostics)) {
            process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
            process.exitCode = result.status ?? 1;
            return;
          }
        } catch {
          // Fall through to the renderer failure contract when no compiler
          // receipt was produced (for example, input JSON could not be read).
        }
      }
      const failure = rendererFailure(result);
      reportFailure({
        json,
        stage: failure.diagnostics.some((entry) => entry.code.startsWith('input/')) ? 'input' : 'render',
        type,
        input: path.resolve(input),
        error: failure.error,
        diagnostics: failure.diagnostics,
        status: result.status ?? 1,
      });
      return;
    }
    process.stdout.write(result.stdout);
    return;
  }

  const { createOwnedTempDirectory } = await import('../packages/output/owned-temp-directory.ts');
  const temporary = createOwnedTempDirectory('schematics-validate-');
  const tmp = temporary.path;
  const out = path.join(tmp, `${type}.html`);
  let exitCode = 0;
  let report = () => {};

  try {
    const snapshot = path.join(tmp, 'specification.snapshot.json');
    fs.writeFileSync(snapshot, specification, { flag: 'wx' });
    let preparedBundlePath;
    if (explainerBundle) {
      const { writePreparedBundle } = await import('../packages/explainer/prepare.ts');
      preparedBundlePath = writePreparedBundle(tmp, explainerBundle);
    }
    const render = runNode([renderer, snapshot, out], {
      stdio: 'pipe',
      env: { ...rendererEnv(quality, repoRoot, true), ...(preparedBundlePath ? { SCHEMATICS_EXPLAINER_PREPARED: preparedBundlePath, SCHEMATICS_EXPLAINER_SNAPSHOT_INPUT: inputPath } : {}) },
    });
    if (render.status !== 0) {
      const failure = rendererFailure(render);
      report = () => reportFailure({
        json,
        stage: failure.diagnostics.some((entry) => entry.code.startsWith('input/')) ? 'input' : 'render',
        type,
        input: path.resolve(input),
        error: failure.error,
        diagnostics: failure.diagnostics,
        status: render.status ?? 1,
      });
      exitCode = render.status ?? 1;
    } else {
      if (render.stderr) process.stderr.write(render.stderr);
      const localeWarnings = [...await specificationLocaleDiagnostics(type, specification), ...(explainerBundle?.diagnostics.filter((entry) => entry.severity === 'warning') || [])];
      for (const warning of localeWarnings) process.stderr.write(`schematics: ${warning.message}\n`);
      const check = await runArtifactCheck(out);
      if (!check.receipt?.ok) {
        exitCode = 1;
        const checker = check.receipt
          ? { ...check.receipt, file: path.resolve(input) }
          : { ok: false, diagnostic: 'Artifact checker failed without a parseable receipt.' };
        report = () => reportFailure({
          json,
          stage: 'check',
          type,
          input: path.resolve(input),
          error: 'Final artifact check failed.',
          diagnostics: checkerDiagnostics(checker),
          checker,
          status: 1,
        });
      } else {
        const result = check.receipt;
        const engineeringProfile = engineeringProfileFromArtifact(fs.readFileSync(out));
        if (json) {
          const candidate = {
            path: path.resolve(input),
            ...artifactIdentity(specification),
          };
          const resolvedQuality = quality || requiredRecord(result.composition).profile || 'standard';
          const receipt = {
            schemaVersion: 1,
            ok: true,
            command: 'validate',
            type,
            input: candidate.path,
            candidate,
            candidateFrozen: true,
            nextAction: {
              command: 'finalize',
              arguments: [
                type,
                candidate.path,
                '<output.html>',
                '--quality',
                resolvedQuality,
                ...(repoRoot ? ['--repo-root', repoRoot] : []),
                '--candidate-sha256',
                candidate.sha256,
                '--json',
              ],
            },
            checks: result.checks,
            composition: result.composition,
            ...(engineeringProfile ? { engineeringProfile } : {}),
            ...(localeWarnings.length ? { diagnostics: localeWarnings } : {}),
          };
          report = () => console.log(JSON.stringify(receipt, null, 2));
        } else {
          const engineering = engineeringProfile
            ? `; engineering ${engineeringProfile}: pass`
            : '';
          report = () => {
            const checkCount = requiredList(result.checks).length;
            const composition = requiredRecord(result.composition);
            const summary = requiredRecord(composition.summary);
            console.log(`ok ${type} ${path.resolve(input)} (${checkCount} artifact checks; composition ${composition.profile}: ${summary.errors} errors, ${summary.warnings} warnings${engineering})`);
          };
        }
      }
    }
  } finally {
    try {
      await temporary.cleanup();
    } catch (error) {
      exitCode = 1;
      report = () => reportFailure({
        json,
        stage: 'cleanup',
        type,
        input: path.resolve(input),
        error: fault(error).message,
        diagnostics: [{
          code: 'validate/temp-cleanup-incomplete',
          severity: 'error',
          message: fault(error).message,
          subject: { directory: tmp },
          evidence: { reason: fault(fault(error).cause).code || fault(error).code },
          supportedFixes: ['resolve the reported filesystem error and inspect the retained temporary directory before retrying'],
        }],
        status: 1,
      });
    }
  }

  report();
  if (exitCode !== 0) process.exitCode = exitCode;
}

const [command, ...args] = process.argv.slice(2);
// Reuse the canonical help metadata rather than a separate help registry.
// Only the sole --help form bypasses command argument parsing and operations.
const soleCommandHelp = args.length === 1 && args[0] === '--help'
  && Object.hasOwn(COMMAND_USAGE, command);

try {
  switch (soleCommandHelp ? '--help' : command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(usage());
      break;
    case 'render':
      await commandRender(args);
      break;
    case 'compare':
      await commandCompare(args);
      break;
    case 'deliver':
      await commandDeliver(args);
      break;
    case 'patch':
      await commandPatch(args);
      break;
    case 'finalize':
      await commandFinalize(args);
      break;
    case 'autofix':
      await commandAutofix(args);
      break;
    case 'import':
      await commandImport(args);
      break;
    case 'chart':
      await commandChart(args);
      break;
    case 'preview':
      await commandPreview(args);
      break;
    case 'validate':
      await commandValidate(args);
      break;
    case 'migrate':
      await commandMigrate(args);
      break;
    case 'inspect':
      if (args[0] !== 'architecture') {
        rejectCliArgument('inspect is currently supported for architecture diagrams only.', {
          code: 'cli/unsupported-option',
          subject: { command: 'inspect', type: args[0] },
          supportedFixes: ['use an architecture diagram', 'use validate <type> <input.json> --layout-json for workflow diagrams'],
        });
      }
      await commandValidate([...args, '--layout-json'], { command: 'inspect' });
      break;
    case 'check':
      await commandCheck(args);
      break;
    case 'visual-check':
      await commandVisualCheck(args);
      break;
    case 'browser-check':
      await commandBrowserCheck(args);
      break;
    case 'guide':
      await commandGuide(args);
      break;
    case 'brands':
      await commandBrands(args);
      break;
    case 'examples':
      commandExamples(args);
      break;
    case 'doctor':
      await commandDoctor(args);
      break;
    case 'demo':
      commandDemo(args);
      break;
    default:
      fail(`Unknown command "${command}".\n\n${usage()}`);
  }
} catch (error) {
  if (!fault(error).schematicsArgument) throw error;
  if (['validate', 'deliver', 'finalize', 'inspect', 'patch'].includes(command) && args.includes('--json')) {
    reportArtifactArgumentFailure(String(command), error);
  } else {
    fail(fault(error).message);
  }
}
