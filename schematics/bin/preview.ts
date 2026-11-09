import { softwareNoticesHtml } from '../packages/output/software-notices.ts';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { openLoopbackUrl, type LaunchReceipt } from './open-artifact.ts';
import { resolveOutputPath, type ResolveOutputPathOptions } from '../packages/output/output-path.ts';
import { errorCode, errorMessage, readField, sameLocation } from '../packages/output/path-semantics.ts';
import {
  captureAtomicOutput,
  captureRegularFileBinding,
  publishRegularFileBinding,
  releaseRegularFileBinding,
  removeEmptyDirectoryWithRetry,
  removeOwnedRegularFile,
  verifyAtomicOutput,
  type CapturedAtomicOutput,
  type FileIdentity,
  type OutputRelation,
  type RegularFileBinding,
} from '../packages/output/atomic-output.ts';

export interface PreviewOptions {
  type: string;
  input: string;
  output?: string;
  quality?: string;
  cwd?: string;
  repoRoot?: string;
  deliveryCli?: string;
  debounceMs?: number;
  pollMs?: number;
  stopGraceMs?: number;
  stopKillMs?: number;
  open?: boolean;
  watch?: boolean;
}

interface SourceDigest {
  hash: string;
  bytes: Buffer | null;
  missing: boolean;
}

interface PreviewFailure {
  code: string;
  message: string;
  evidence: { relation: unknown };
}

interface DeliveryDiagnostic {
  code?: unknown;
  message?: unknown;
  supportedFixes?: unknown[];
}

interface DeliveryCheck {
  ok?: unknown;
  details?: unknown[];
}

interface DeliveryReceipt {
  ok?: unknown;
  stage?: unknown;
  code?: unknown;
  evidence?: unknown;
  error?: unknown;
  receiptId?: unknown;
  artifact?: { sha256?: string; bytes?: number };
  validation: {
    checksPassed?: unknown;
    checkCount?: unknown;
    compositionProfile?: unknown;
    compositionStatus?: unknown;
  };
  diagnostics?: DeliveryDiagnostic[];
  checker?: { checks?: DeliveryCheck[] };
}

type FailureReceipt = Partial<DeliveryReceipt>;

interface DeliverySidecar {
  schemaVersion?: unknown;
  command?: unknown;
  output?: unknown;
  input?: unknown;
  receiptId?: unknown;
  status?: unknown;
  artifact?: { sha256?: unknown };
}

interface OwnedSidecar {
  path: string;
  identity: FileIdentity;
}

interface VerifiedSummary {
  sha256: string;
  bytes: number;
  checksPassed: unknown;
  checkCount: unknown;
  compositionProfile: unknown;
  compositionStatus: unknown;
}

interface StateFailure {
  stage: unknown;
  code?: unknown;
  evidence?: unknown;
  message: string;
}

export interface PreviewState {
  schemaVersion: 1;
  status: 'checking' | 'verified' | 'needs-fix';
  generation: number;
  revision: number;
  lastVerified: VerifiedSummary | null;
  failure: StateFailure | null;
}

interface CommitOutcome {
  committed: boolean;
  supersededBy: SourceDigest | null;
  candidateIdentity: FileIdentity | undefined;
}

export interface StopOptions {
  force?: boolean;
}

export interface PreviewHandle {
  url: string;
  input: string;
  output: string;
  opener: LaunchReceipt | null;
  state: () => PreviewState;
  stop: (options?: StopOptions) => Promise<void>;
  closed: Promise<void>;
}

type RedactionPath = readonly [absolutePath: string | undefined, replacement: string];
type DeliveryChild = ChildProcessByStdio<null, Readable, Readable>;

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, 'schematics.ts');
const loopbackHost = '127.0.0.1';
const defaultDebounceMs = 400;
const defaultPollMs = 800;
const defaultStopGraceMs = 3000;
const defaultStopKillMs = 750;
const diagramTypes = new Set(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle', 'erd', 'tree', 'class', 'timeline', 'waterfall']);
let previewCommitSequence = 0;

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceDigest(inputPath: string): SourceDigest {
  try {
    const bytes = fs.readFileSync(inputPath);
    return { hash: sha256(bytes), bytes, missing: false };
  } catch (error) {
    return { hash: `unreadable:${errorCode(error) || 'unknown'}`, bytes: null, missing: true };
  }
}

function initialAuthoredOutput(inputPath: string): string | undefined {
  try {
    const source: unknown = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const output = readField(readField(source, 'meta'), 'output');
    if (typeof output === 'string') {
      return output;
    }
  } catch {
    // An invalid initial source still gets a status shell. Its output target is
    // fixed to the same fallback that `deliver` would use after repair.
  }
  return undefined;
}

function previewPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">${softwareNoticesHtml}
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Schematics Live Preview</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #0b111b; }
    body { display: grid; grid-template-rows: auto minmax(0, 1fr); color: #e8edf5; }
    header { position: relative; z-index: 2; display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 7px 12px; border-bottom: 1px solid #253248; background: rgba(11, 17, 27, .96); box-shadow: 0 8px 22px rgba(0,0,0,.18); }
    .brand { font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #9cadc6; }
    #status { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; min-height: 30px; padding: 5px 10px; border: 1px solid #33435d; border-radius: 999px; background: #111b2a; font-size: 12px; white-space: nowrap; }
    #status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #6f819d; }
    body[data-state="checking"] #status::before { background: #f3b44b; box-shadow: 0 0 0 4px rgba(243,180,75,.12); }
    body[data-state="verified"] #status::before { background: #45d6a8; box-shadow: 0 0 0 4px rgba(69,214,168,.12); }
    body[data-state="needs-fix"] #status::before { background: #ff6f78; box-shadow: 0 0 0 4px rgba(255,111,120,.12); }
    details { max-width: min(62vw, 760px); }
    summary { cursor: pointer; color: #ffbdc2; font-size: 12px; }
    .diagnostic { position: absolute; top: 38px; right: 12px; width: min(760px, calc(100vw - 24px)); max-height: min(44vh, 360px); overflow: auto; padding: 14px; border: 1px solid #6a3440; border-radius: 10px; background: #17131b; box-shadow: 0 14px 48px rgba(0,0,0,.42); }
    pre { margin: 0 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: #f2dfe2; }
    button { min-height: 32px; padding: 5px 10px; border: 1px solid #4a5d79; border-radius: 7px; background: #1a273a; color: #eef4ff; cursor: pointer; }
    main { position: relative; min-height: 0; }
    iframe { display: none; width: 100%; height: 100%; border: 0; background: #fff; }
    body[data-has-artifact="true"] iframe { display: block; }
    #empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 32px; color: #91a2bc; text-align: center; background: radial-gradient(circle at 50% 38%, #15233a 0, #0b111b 55%); }
    body[data-has-artifact="true"] #empty { display: none; }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
  </style>
</head>
<body data-state="checking" data-has-artifact="false">
  <header>
    <span class="brand">Schematics Preview</span>
    <details id="failure" hidden>
      <summary role="button" aria-controls="diagnostic-panel">View diagnostic</summary>
      <div class="diagnostic" id="diagnostic-panel"><pre id="diagnostic"></pre><button id="copy" type="button">Copy diagnostic</button></div>
    </details>
    <span id="status" role="status" aria-live="polite">Checking · generation 1</span>
  </header>
  <main>
    <div id="empty">Waiting for the first verified diagram. Invalid input will stay here with an exact diagnostic.</div>
    <iframe id="artifact" title="Verified Schematics diagram"></iframe>
  </main>
  <script>
    (function () {
      'use strict';
      var body = document.body;
      var status = document.getElementById('status');
      var failure = document.getElementById('failure');
      var diagnostic = document.getElementById('diagnostic');
      var artifact = document.getElementById('artifact');
      var lastRevision = 0;

      function render(state) {
        body.dataset.state = state.status;
        if (state.status === 'verified') {
          status.textContent = 'Verified · rev ' + state.revision;
          failure.hidden = true;
          failure.open = false;
          if (state.revision !== lastRevision) {
            lastRevision = state.revision;
            artifact.src = '/artifact.html?revision=' + encodeURIComponent(state.revision) + '&sha=' + encodeURIComponent(state.lastVerified.sha256.slice(0, 12));
            body.dataset.hasArtifact = 'true';
          }
        } else if (state.status === 'needs-fix') {
          status.textContent = 'Needs fix · ' + (state.revision ? 'showing rev ' + state.revision : 'no verified revision');
          diagnostic.textContent = 'Generation ' + state.generation + ' · ' + state.failure.stage + '\\n\\n' + state.failure.message;
          failure.hidden = false;
        } else {
          status.textContent = 'Checking · generation ' + state.generation;
          failure.hidden = true;
        }
      }

      document.getElementById('copy').addEventListener('click', function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(diagnostic.textContent).catch(function () {});
        }
      });

      var events = new EventSource('/events');
      events.addEventListener('state', function (event) {
        try { render(JSON.parse(event.data)); } catch (_) {}
      });
    }());
  </script>
</body>
</html>`;
}

function compactMessage(value: unknown): string {
  let text = String(value || 'Preview build failed without a diagnostic.').trim();
  const lines = text.split(/\r?\n/);
  const errorLine = lines.findIndex((line) => /^Error:\s/.test(line));
  if (errorLine > 0) text = lines.slice(errorLine).join('\n');
  const relevant = text.split(/\r?\n/);
  const stackLine = relevant.findIndex((line, index) => index > 0 && /^\s*at\s/.test(line));
  if (stackLine > 0) text = relevant.slice(0, stackLine).join('\n');
  return text.length > 6000 ? `${text.slice(0, 6000)}\n… diagnostic truncated` : text;
}

function redactDiagnostic(value: unknown, paths: readonly RedactionPath[]): string {
  let text = compactMessage(value);
  for (const [absolutePath, replacement] of paths) {
    if (!absolutePath) continue;
    text = text.split(absolutePath).join(replacement);
  }
  return text;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function responseHeaders(contentType: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
  };
}

function parseReceipt(stdout: string): DeliveryReceipt | null {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function atomicOutputFailure(result: OutputRelation): PreviewFailure {
  const code = result?.reason?.code || 'unclassified';
  let diagnosticCode = 'output/target-indeterminate';
  let message: string;
  if (code === 'target-hardlinked' || code === 'candidate-hardlinked') {
    diagnosticCode = 'output/target-hardlinked';
    message = code === 'candidate-hardlinked'
      ? 'Preview commit candidate has multiple hard-link names and cannot be published safely.'
      : 'Preview output has multiple hard-link names; atomic publication cannot update every name.';
  } else if (code === 'target-not-regular-file' || code === 'candidate-not-regular-file') {
    diagnosticCode = 'output/target-not-regular-file';
    message = code === 'candidate-not-regular-file'
      ? 'Preview commit candidate is no longer a regular file.'
      : 'Preview output already exists and is not a regular file.';
  } else if (result?.status === 'different') {
    diagnosticCode = 'output/target-changed';
    message = `Preview output changed while the verified candidate was being prepared (${code}).`;
  } else {
    message = `Preview output stability could not be determined safely (${code}).`;
  }
  return {
    code: diagnosticCode,
    message,
    evidence: { relation: result?.reason || { code } },
  };
}

function atomicOutputError(result: OutputRelation): Error & { previewFailure: PreviewFailure } {
  const failure = atomicOutputFailure(result);
  return Object.assign(new Error(failure.message), { previewFailure: failure });
}

function previewFailureOf(error: unknown): object {
  const failure = readField(error, 'previewFailure');
  return typeof failure === 'object' && failure !== null ? failure : {};
}

function capturedBuffer(content: { buffer?: Buffer }): Buffer {
  if (!content.buffer) throw new Error('Captured file content is unavailable.');
  return content.buffer;
}

function listeningPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Preview server has no TCP address.');
  return address.port;
}

function stagePreviewCommit(
  commitPath: string,
  artifact: Buffer,
  mode: number | null,
): { candidatePath: string; identity: FileIdentity } {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    previewCommitSequence += 1;
    const candidatePath = path.join(
      path.dirname(commitPath),
      `.schematics-preview-commit-${process.pid}-${Date.now().toString(36)}-${previewCommitSequence}.tmp`,
    );
    let descriptor: number | undefined;
    let identity: FileIdentity | undefined;
    try {
      const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
      descriptor = fs.openSync(
        candidatePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        mode ?? 0o666,
      );
      let metadata: fs.BigIntStats;
      try {
        metadata = fs.fstatSync(descriptor, { bigint: true });
      } catch (error) {
        try {
          const retry = fs.fstatSync(descriptor, { bigint: true });
          if (retry.isFile() && retry.ino !== 0n) {
            identity = { device: retry.dev, inode: retry.ino };
          }
        } catch {}
        throw error;
      }
      if (!metadata.isFile() || metadata.ino === 0n) {
        throw new Error('Preview commit candidate identity could not be verified safely.');
      }
      identity = { device: metadata.dev, inode: metadata.ino };
      fs.writeFileSync(descriptor, artifact);
      if (mode !== null) fs.fchmodSync(descriptor, mode);
      fs.closeSync(descriptor);
      descriptor = undefined;
      return { candidatePath, identity };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      if (errorCode(error) === 'EEXIST') continue;
      if (identity) removeOwnedRegularFile(candidatePath, identity);
      throw error;
    }
  }
  throw Object.assign(new Error('Could not reserve a preview commit candidate beside the output.'), {
    code: 'EEXIST',
    errno: -17,
    syscall: 'open',
  });
}

function captureOwnedDirectory(directoryPath: string): FileIdentity {
  const metadata = fs.lstatSync(directoryPath, { bigint: true });
  if (!metadata.isDirectory() || metadata.ino === 0n) {
    throw new Error('Preview staging directory identity could not be verified safely.');
  }
  return { device: metadata.dev, inode: metadata.ino };
}

function cleanupOwnedDirectory(directoryPath: string, identity: FileIdentity): void {
  let current: fs.BigIntStats;
  try {
    current = fs.lstatSync(directoryPath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return;
    throw error;
  }
  // Preserve a replacement rather than recursively deleting a directory that
  // this preview instance did not create.
  if (!current.isDirectory()
    || current.ino === 0n
    || current.dev !== identity.device
    || current.ino !== identity.inode) return;
  try {
    removeEmptyDirectoryWithRetry(directoryPath);
  } catch (error) {
    // An entry whose identity was never bound to this preview may be an
    // external claimant. Preserve the private directory as recovery material
    // instead of recursively deleting unknown contents.
    if (errorCode(error) !== 'ENOTEMPTY' && errorCode(error) !== 'EEXIST') throw error;
  }
}

function captureOwnedDeliverySidecars(
  candidatePath: string,
  snapshotPath: string,
  receipt: DeliveryReceipt | null,
): OwnedSidecar[] {
  const suffixes = ['.delivery.json', '.delivery-pending.json'];
  const capturedSidecars: OwnedSidecar[] = [];
  for (const suffix of suffixes) {
    const sidecarPath = candidatePath.replace(/\.html$/iu, suffix);
    const captured = captureRegularFileBinding(sidecarPath, {
      subject: 'preview-delivery-sidecar',
      expectedLinks: 1,
      includeContent: true,
    });
    if (captured.status !== 'captured') continue;
    try {
      const sidecar: DeliverySidecar | null = JSON.parse(capturedBuffer(captured.content).toString('utf8'));
      const commonMatches = sidecar?.schemaVersion === 1
        && sidecar.command === 'deliver'
        && sameLocation(sidecar.output, candidatePath).status === 'match'
        && (!receipt?.receiptId || sidecar.receiptId === receipt.receiptId);
      const currentMatches = suffix === '.delivery.json'
        && commonMatches
        && sidecar.status === 'current'
        && receipt?.artifact?.sha256
        && sidecar.artifact?.sha256 === receipt.artifact.sha256;
      const pendingMatches = suffix === '.delivery-pending.json'
        && commonMatches
        && sidecar.status === 'pending'
        && sameLocation(sidecar.input, snapshotPath).status === 'match';
      if (currentMatches || pendingMatches) {
        capturedSidecars.push({ path: sidecarPath, identity: captured.identity });
      }
    } catch {
      // Preserve malformed or claimant-controlled sidecars for recovery.
    } finally {
      releaseRegularFileBinding(captured.binding);
    }
  }
  return capturedSidecars;
}

export async function startPreview(options: PreviewOptions): Promise<PreviewHandle> {
  const type = options.type;
  if (!diagramTypes.has(type)) throw new Error(`Unknown diagram type "${type}".`);
  if (options.quality && !['standard', 'showcase'].includes(options.quality)) {
    throw new Error(`Unknown quality profile "${options.quality}".`);
  }
  const inputPath = path.resolve(options.input);
  const outputRequest: ResolveOutputPathOptions = {
    requestedOutput: options.output,
    authoredOutput: initialAuthoredOutput(inputPath),
    defaultOutput: `${type}.html`,
    inputPaths: [inputPath],
    inputDescription: 'its JSON input',
    cwd: options.cwd || process.cwd(),
  };
  const { outputPath } = resolveOutputPath(outputRequest);
  const outputDirectory = path.dirname(outputPath);
  const debounceMs = finiteOr(options.debounceMs, defaultDebounceMs);
  const pollMs = finiteOr(options.pollMs, defaultPollMs);
  const stopGraceMs = Math.max(0, finiteOr(options.stopGraceMs, defaultStopGraceMs));
  const stopKillMs = Math.max(0, finiteOr(options.stopKillMs, defaultStopKillMs));
  const shouldOpen = options.open !== false;

  fs.mkdirSync(outputDirectory, { recursive: true });
  // Keep cleanup bound to the physical directory selected at startup. A
  // symlink or junction in the requested output parent may be redirected while
  // preview is running and must not redirect recursive cleanup to a claimant.
  const physicalOutputDirectory = fs.realpathSync.native(outputDirectory);
  const stagingDirectory = fs.mkdtempSync(path.toNamespacedPath(
    path.join(physicalOutputDirectory, '.schematics-preview-'),
  ));
  let stagingIdentity: FileIdentity;
  try {
    stagingIdentity = captureOwnedDirectory(stagingDirectory);
  } catch (error) {
    try { fs.rmdirSync(stagingDirectory); } catch {}
    throw error;
  }

  let port = 0;
  let watcher: fs.FSWatcher | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let stopGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let stopKillTimer: ReturnType<typeof setTimeout> | undefined;
  let child: DeliveryChild | null | undefined;
  let stopping = false;
  let forceStopping = false;
  let stopped = false;
  let serverClosing = false;
  let serverClosed = false;
  let queuedHash: string | null = null;
  let activeHash: string | null = null;
  let lastGoodSourceHash: string | null = null;
  let sourceEpoch = 0;
  let activeEpoch = 0;
  let pendingBuild = false;
  let artifactBuffer: Buffer | null = null;
  const clients = new Set<http.ServerResponse>();
  const sockets = new Set<Socket>();
  const state: PreviewState = {
    schemaVersion: 1,
    status: 'checking',
    generation: 0,
    revision: 0,
    lastVerified: null,
    failure: null,
  };

  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  function publicState(): PreviewState {
    return JSON.parse(JSON.stringify(state));
  }

  function sendState(res: http.ServerResponse): void {
    res.write(`event: state\ndata: ${safeJson(publicState())}\n\n`);
  }

  function broadcast(): void {
    for (const res of clients) sendState(res);
  }

  const page = Buffer.from(previewPage());
  const server = http.createServer((req, res) => {
    const expectedHost = `${loopbackHost}:${port}`;
    if (req.headers.host !== expectedHost) {
      res.writeHead(403, responseHeaders('text/plain; charset=utf-8'));
      res.end('Forbidden host');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...responseHeaders('text/plain; charset=utf-8'), Allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }

    let url: URL;
    try {
      url = new URL(String(req.url), `http://${expectedHost}`);
    } catch {
      res.writeHead(400, responseHeaders('text/plain; charset=utf-8'));
      res.end('Bad request');
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, {
        ...responseHeaders('text/html; charset=utf-8'),
        'Content-Security-Policy': "default-src 'none'; frame-src 'self'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        'Content-Length': page.byteLength,
      });
      if (req.method === 'HEAD') res.end();
      else res.end(page);
      return;
    }
    if (url.pathname === '/state') {
      const body = Buffer.from(`${safeJson(publicState())}\n`);
      res.writeHead(200, { ...responseHeaders('application/json; charset=utf-8'), 'Content-Length': body.byteLength });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
      return;
    }
    if (url.pathname === '/artifact.html') {
      if (!artifactBuffer) {
        res.writeHead(404, responseHeaders('text/plain; charset=utf-8'));
        res.end('No verified artifact yet');
        return;
      }
      res.writeHead(200, { ...responseHeaders('text/html; charset=utf-8'), 'Content-Length': artifactBuffer.byteLength });
      if (req.method === 'HEAD') res.end();
      else res.end(artifactBuffer);
      return;
    }
    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        ...responseHeaders('text/event-stream; charset=utf-8'),
        Connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      clients.add(res);
      sendState(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    res.writeHead(404, responseHeaders('text/plain; charset=utf-8'));
    res.end('Not found');
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // A connection event already queued when force-stop begins must not keep
    // server.close() waiting after the current sockets have been destroyed.
    if (forceStopping) socket.destroy();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, loopbackHost, () => {
        server.off('error', reject);
        port = listeningPort(server);
        resolve();
      });
    });
  } catch (error) {
    try { server.close(); } catch {}
    cleanupOwnedDirectory(stagingDirectory, stagingIdentity);
    throw error;
  }

  const url = `http://${loopbackHost}:${port}/`;

  function finishStop(): void {
    if (stopped || child || !serverClosed) return;
    stopped = true;
    clearTimeout(debounceTimer);
    clearInterval(pollTimer);
    clearTimeout(stopGraceTimer);
    clearTimeout(stopKillTimer);
    try {
      cleanupOwnedDirectory(stagingDirectory, stagingIdentity);
    } finally {
      resolveClosed();
    }
  }

  function signalActiveChild(signal: NodeJS.Signals): void {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return;
      try { child.kill(signal); } catch {}
    }
  }

  function closeServer(): void {
    if (serverClosing) return;
    serverClosing = true;
    for (const res of clients) res.end();
    clients.clear();
    server.close(() => {
      serverClosed = true;
      finishStop();
    });
    server.closeIdleConnections?.();
  }

  function startBoundedChildDrain(): void {
    if (!child || stopGraceTimer || stopKillTimer) return;
    stopGraceTimer = setTimeout(() => {
      stopGraceTimer = undefined;
      if (!child) return finishStop();
      signalActiveChild('SIGTERM');
      stopKillTimer = setTimeout(() => {
        stopKillTimer = undefined;
        signalActiveChild('SIGKILL');
      }, stopKillMs);
    }, stopGraceMs);
  }

  async function stop({ force = false }: StopOptions = {}): Promise<void> {
    if (force) forceStopping = true;
    if (!stopping) {
      stopping = true;
      clearTimeout(debounceTimer);
      clearInterval(pollTimer);
      watcher?.close();
      closeServer();
    }
    if (forceStopping) {
      for (const socket of sockets) socket.destroy();
    }
    if (child && force) {
      clearTimeout(stopGraceTimer);
      clearTimeout(stopKillTimer);
      stopGraceTimer = undefined;
      stopKillTimer = undefined;
      signalActiveChild('SIGKILL');
    } else if (child) {
      startBoundedChildDrain();
    } else {
      finishStop();
    }
    return closed;
  }

  function publishFailure(
    receipt: FailureReceipt | null,
    stdout: string,
    stderr: string,
    candidatePath: string,
    snapshotPath?: string,
  ): void {
    const repairDetails = receipt?.diagnostics
      ?.slice(0, 12)
      .map((entry) => {
        const fix = entry.supportedFixes?.length ? `\nFix: ${entry.supportedFixes.join('; ')}` : '';
        return `[${entry.code}] ${entry.message}${fix}`;
      }) || [];
    const checkerDetails = receipt?.checker?.checks
      ?.filter((check) => !check.ok)
      .flatMap((check) => check.details || [])
      .filter(Boolean)
      .slice(0, 12) || [];
    const diagnostic = [
      receipt?.error,
      ...(repairDetails.length ? repairDetails : checkerDetails),
    ].filter(Boolean).join('\n') || stderr || stdout;
    state.status = 'needs-fix';
    state.failure = {
      stage: receipt?.stage || 'render',
      ...(receipt?.code ? { code: receipt.code } : {}),
      ...(receipt?.evidence ? { evidence: receipt.evidence } : {}),
      message: redactDiagnostic(
        diagnostic,
        [
          [inputPath, '<input.json>'],
          [outputPath, '<output.html>'],
          [snapshotPath, '<input.json>'],
          [candidatePath, '<candidate.html>'],
          [stagingDirectory, '<preview-staging>'],
          [path.resolve(here, '..'), '<schematics-skill>'],
          [path.resolve(options.cwd || process.cwd()), '<working-directory>'],
          ...(options.repoRoot ? [[path.resolve(options.repoRoot), '<repo-root>'] as const] : []),
        ],
      ),
    };
    broadcast();
  }

  function commitCandidate(
    candidatePath: string,
    receipt: DeliveryReceipt,
    generationHash: string | null,
    outputCapture: CapturedAtomicOutput,
  ): CommitOutcome {
    let candidate: Buffer;
    let sourceCandidateBinding: RegularFileBinding | undefined;
    let sourceCandidateIdentity: FileIdentity | undefined;
    let commitCandidatePath: string | undefined;
    let commitCandidateIdentity: FileIdentity | undefined;
    let commitCandidateBinding: RegularFileBinding | undefined;
    try {
      const sourceCapture = captureRegularFileBinding(candidatePath, {
        subject: 'candidate',
        expectedSha256: receipt?.artifact?.sha256,
        expectedBytes: receipt?.artifact?.bytes,
        includeContent: true,
      });
      if (sourceCapture.status !== 'captured') throw atomicOutputError(sourceCapture);
      sourceCandidateBinding = sourceCapture.binding;
      sourceCandidateIdentity = sourceCapture.identity;
      candidate = capturedBuffer(sourceCapture.content);
      const digest = sourceCapture.content.sha256;
      const releasedSource = releaseRegularFileBinding(sourceCandidateBinding);
      sourceCandidateBinding = undefined;
      if (releasedSource.status !== 'released') throw atomicOutputError(releasedSource);
      resolveOutputPath(outputRequest);
      const sameArtifact = state.lastVerified?.sha256 === digest;
      const currentSource = sourceDigest(inputPath);
      if (currentSource.hash !== generationHash) {
        return {
          committed: false,
          supersededBy: currentSource,
          candidateIdentity: sourceCandidateIdentity,
        };
      }
      const beforeStage = verifyAtomicOutput(outputCapture.snapshot);
      if (beforeStage.status !== 'match') throw atomicOutputError(beforeStage);
      ({
        candidatePath: commitCandidatePath,
        identity: commitCandidateIdentity,
      } = stagePreviewCommit(outputCapture.commitPath, candidate, outputCapture.mode));
      const stagedCandidatePath = commitCandidatePath;
      const candidateCapture = captureRegularFileBinding(stagedCandidatePath, {
        subject: 'candidate',
        expectedSha256: digest,
        expectedBytes: candidate.byteLength,
        expectedIdentity: commitCandidateIdentity,
        ...(outputCapture.mode === null ? {} : { expectedMode: outputCapture.mode }),
      });
      if (candidateCapture.status !== 'captured') throw atomicOutputError(candidateCapture);
      commitCandidateBinding = candidateCapture.binding;
      const beforeCommit = verifyAtomicOutput(outputCapture.snapshot);
      if (beforeCommit.status !== 'match') throw atomicOutputError(beforeCommit);
      const publication = publishRegularFileBinding(
        commitCandidateBinding,
        stagedCandidatePath,
        outputCapture.snapshot,
        { subject: 'candidate' },
      );
      if (!['committed', 'committed-with-warning'].includes(publication.status)) {
        throw atomicOutputError(publication);
      }
      const releasedCandidate = releaseRegularFileBinding(commitCandidateBinding);
      commitCandidateBinding = undefined;
      if (releasedCandidate.status !== 'released') throw atomicOutputError(releasedCandidate);
      commitCandidatePath = undefined;
      commitCandidateIdentity = undefined;
      artifactBuffer = candidate;
      lastGoodSourceHash = generationHash;
      state.status = 'verified';
      if (!sameArtifact) {
        state.revision += 1;
        state.lastVerified = {
          sha256: digest,
          bytes: candidate.byteLength,
          checksPassed: receipt.validation.checksPassed,
          checkCount: receipt.validation.checkCount,
          compositionProfile: receipt.validation.compositionProfile,
          compositionStatus: receipt.validation.compositionStatus,
        };
      }
      state.failure = null;
      broadcast();
      return { committed: true, supersededBy: null, candidateIdentity: sourceCandidateIdentity };
    } catch (error) {
      publishFailure({
        stage: 'commit',
        error: `Could not publish the verified preview: ${errorMessage(error)}`,
        ...previewFailureOf(error),
      }, '', '', candidatePath);
      return { committed: false, supersededBy: null, candidateIdentity: sourceCandidateIdentity };
    } finally {
      if (sourceCandidateBinding) releaseRegularFileBinding(sourceCandidateBinding);
      if (commitCandidateBinding) releaseRegularFileBinding(commitCandidateBinding);
      if (commitCandidatePath && commitCandidateIdentity) {
        removeOwnedRegularFile(commitCandidatePath, commitCandidateIdentity);
      }
    }
  }

  function beginBuild(digest: SourceDigest, epoch: number): void {
    if (stopping || child) return;
    activeHash = digest.hash;
    activeEpoch = epoch;
    state.generation += 1;
    state.status = 'checking';
    state.failure = null;
    broadcast();

    const candidatePath = path.join(stagingDirectory, `generation-${state.generation}.html`);
    const snapshotPath = path.join(stagingDirectory, `generation-${state.generation}.json`);
    let snapshotIdentity: FileIdentity | undefined;
    const outputCapture = captureAtomicOutput(outputPath);
    if (outputCapture.status !== 'captured') {
      const failure = atomicOutputFailure(outputCapture);
      publishFailure(
        { stage: 'prepare', error: failure.message, ...failure },
        '',
        '',
        candidatePath,
        snapshotPath,
      );
      return;
    }
    const beforeBuild = verifyAtomicOutput(outputCapture.snapshot);
    if (beforeBuild.status !== 'match') {
      const failure = atomicOutputFailure(beforeBuild);
      publishFailure(
        { stage: 'prepare', error: failure.message, ...failure },
        '',
        '',
        candidatePath,
        snapshotPath,
      );
      return;
    }
    if (digest.bytes !== null) {
      try {
        fs.writeFileSync(snapshotPath, digest.bytes, { flag: 'wx', mode: 0o600 });
        const metadata = fs.lstatSync(snapshotPath, { bigint: true });
        if (metadata.isFile() && metadata.ino !== 0n) {
          snapshotIdentity = { device: metadata.dev, inode: metadata.ino };
        }
      } catch (error) {
        publishFailure(
          { stage: 'prepare', error: `Could not snapshot the observed input: ${errorMessage(error)}` },
          '',
          '',
          candidatePath,
          snapshotPath,
        );
        return;
      }
    }
    const args = [options.deliveryCli || cliPath, 'deliver', type, snapshotPath, candidatePath, '--json'];
    if (options.quality) args.push('--quality', options.quality);
    if (options.repoRoot) args.push('--repo-root', path.resolve(options.repoRoot));
    let stdout = '';
    let stderr = '';
    const launched: DeliveryChild = spawn(process.execPath, args, {
      cwd: options.cwd || process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child = launched;
    launched.stdout.setEncoding('utf8');
    launched.stderr.setEncoding('utf8');
    launched.stdout.on('data', (chunk: string) => { stdout += chunk; });
    launched.stderr.on('data', (chunk: string) => { stderr += chunk; });
    launched.on('error', (error) => { stderr += error.message; });
    launched.on('close', (code) => {
      const receipt = parseReceipt(stdout);
      const generationEpoch = activeEpoch;
      const generationHash = activeHash;
      const stale = generationEpoch !== sourceEpoch;
      let supersededBy: SourceDigest | null = null;
      let candidateIdentity: FileIdentity | undefined;
      const deliverySidecars = captureOwnedDeliverySidecars(
        candidatePath,
        snapshotPath,
        receipt,
      );
      child = null;
      clearTimeout(stopGraceTimer);
      clearTimeout(stopKillTimer);
      stopGraceTimer = undefined;
      stopKillTimer = undefined;
      if (!stopping && !stale && code === 0 && receipt?.ok) {
        ({ supersededBy, candidateIdentity } = commitCandidate(
          candidatePath,
          receipt,
          generationHash,
          outputCapture,
        ));
      } else if (code === 0 && receipt?.ok) {
        const abandonedCandidate = captureRegularFileBinding(candidatePath, {
          subject: 'abandoned-preview-candidate',
          expectedSha256: receipt.artifact?.sha256,
          expectedBytes: receipt.artifact?.bytes,
        });
        if (abandonedCandidate.status === 'captured') {
          candidateIdentity = abandonedCandidate.identity;
          releaseRegularFileBinding(abandonedCandidate.binding);
        }
      } else if (!stopping && !stale) {
        publishFailure(receipt, stdout, stderr, candidatePath, snapshotPath);
      }
      if (candidateIdentity) removeOwnedRegularFile(candidatePath, candidateIdentity);
      if (snapshotIdentity) removeOwnedRegularFile(snapshotPath, snapshotIdentity, { subject: 'snapshot' });
      for (const deliverySidecar of deliverySidecars) {
        removeOwnedRegularFile(deliverySidecar.path, deliverySidecar.identity, {
          subject: 'preview-delivery-sidecar',
        });
      }

      if (stopping) {
        finishStop();
      } else if (pendingBuild || stale || supersededBy) {
        pendingBuild = false;
        if (supersededBy && sourceEpoch === generationEpoch) sourceEpoch += 1;
        const digest = supersededBy || sourceDigest(inputPath);
        queueStableBuild(digest.hash, true);
      }
    });
  }

  function queueStableBuild(hash: string, immediate = false): void {
    queuedHash = hash;
    clearTimeout(debounceTimer);
    const launch = () => {
      if (stopping) return;
      const digest = sourceDigest(inputPath);
      if (digest.hash !== queuedHash) {
        queueStableBuild(digest.hash);
        return;
      }
      if (digest.hash === lastGoodSourceHash) {
        if (state.status !== 'verified' && state.lastVerified) {
          state.status = 'verified';
          state.failure = null;
          broadcast();
        }
        return;
      }
      if (child) {
        pendingBuild = true;
        return;
      }
      beginBuild(digest, sourceEpoch);
    };
    debounceTimer = setTimeout(launch, immediate ? 0 : debounceMs);
  }

  function observeSource({ immediate = false }: { immediate?: boolean } = {}): void {
    const digest = sourceDigest(inputPath);
    if (!immediate && digest.hash === queuedHash) return;
    sourceEpoch += 1;
    queueStableBuild(digest.hash, immediate);
  }

  if (options.watch !== false) {
    try {
      // `path.resolve` keeps Windows 8.3 names intact. Canonicalize short names
      // and junctions before libuv opens the directory so its callback path has
      // the same prefix as the watched path.
      const watchedDirectory = fs.realpathSync.native(path.dirname(inputPath));
      watcher = fs.watch(watchedDirectory, (event, filename) => {
        // On Windows the watcher hands us just the basename; on POSIX it can be
        // null. Resolve named events against the directory libuv actually opened
        // so file-level case, 8.3, and hard-link aliases still identify the input.
        if (
          !filename
          || sameLocation(path.join(watchedDirectory, filename.toString()), inputPath).status === 'match'
        ) {
          observeSource();
        }
      });
      watcher.on('error', () => {
        const failedWatcher = watcher;
        watcher = undefined;
        failedWatcher?.close();
      });
    } catch (error) {
      await stop();
      throw new Error(`Could not watch the input directory: ${errorMessage(error)}`);
    }
  }
  pollTimer = setInterval(() => observeSource(), pollMs);

  let opener: LaunchReceipt | null = null;
  if (shouldOpen) {
    try {
      opener = openLoopbackUrl(url);
    } catch {
      opener = { requested: true, status: 'unsupported', target: url, method: null };
    }
  }

  observeSource({ immediate: true });

  return {
    url,
    input: inputPath,
    output: outputPath,
    opener,
    state: publicState,
    stop,
    closed,
  };
}

export async function runPreview(options: PreviewOptions): Promise<void> {
  const preview = await startPreview(options);
  console.log(`preview ${preview.url}`);
  console.log(`watching ${preview.input}`);
  console.log(`output ${preview.output}`);
  if (preview.opener && preview.opener.status !== 'opened') {
    console.error(`Could not open the preview (${preview.opener.status}). ${preview.opener.failure?.reason || 'Open it manually.'} Target: ${preview.url}`);
  }

  let signalCount = 0;
  const stop = () => {
    signalCount += 1;
    if (signalCount === 1) {
      console.log('\nstopping preview…');
      preview.stop();
    } else {
      console.log('\nforcing preview shutdown…');
      preview.stop({ force: true });
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await preview.closed;
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
