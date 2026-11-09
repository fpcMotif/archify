import fs from 'node:fs';
import path from 'node:path';

export interface DiagnosticInput {
  code?: string;
  severity?: string;
  message?: string;
  subject?: unknown;
  evidence?: unknown;
  supportedFixes?: readonly unknown[];
  edits?: readonly unknown[];
  suppresses?: readonly unknown[];
}

export interface Diagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  subject: Record<string, unknown>;
  evidence: Record<string, unknown>;
  supportedFixes: string[];
  edits?: readonly unknown[];
  suppresses?: string[];
}

export interface DiagnosticError extends Error {
  schematicsDiagnostics?: Diagnostic[];
}

export interface DiagnosticProblemOptions {
  code?: string;
  subject?: Record<string, unknown>;
  diagnostics?: readonly DiagnosticInput[];
}

export interface RendererFailure {
  schemaVersion: 1;
  ok: false;
  source: 'renderer';
  error: string;
  diagnostics: Diagnostic[];
}

const DIAGNOSTIC_MODE = process.env.SCHEMATICS_DIAGNOSTIC_FORMAT === 'json';
let recorded: Diagnostic[] = [];
let recordedKeys = new Set<string>();
let recordedByMessage = new Map<string, Diagnostic>();
const boundaryKey = Symbol.for('schematics.renderer-diagnostic-boundary');
let recordingSuppressionDepth = 0;

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function normalizedDiagnostic(diagnostic: DiagnosticInput | null | undefined): Diagnostic {
  const message = String(diagnostic?.message || 'Schematics could not classify this failure.').trim();
  return {
    code: String(diagnostic?.code || 'internal/unclassified'),
    severity: diagnostic?.severity === 'warning' ? 'warning' : 'error',
    message,
    subject: plainObject(diagnostic?.subject),
    evidence: plainObject(diagnostic?.evidence),
    supportedFixes: Array.isArray(diagnostic?.supportedFixes)
      ? [...new Set(diagnostic.supportedFixes.map((fix) => String(fix).trim()).filter(Boolean))]
      : [],
    ...(Array.isArray(diagnostic?.edits) && diagnostic.edits.length ? { edits: diagnostic.edits } : {}),
    ...(Array.isArray(diagnostic?.suppresses) ? {
      suppresses: [...new Set(diagnostic.suppresses.map((code) => String(code).trim()).filter(Boolean))],
    } : {}),
  };
}

export function recordDiagnostic(diagnostic: DiagnosticInput | null | undefined): void {
  if (!DIAGNOSTIC_MODE || recordingSuppressionDepth > 0) return;
  const normalized = normalizedDiagnostic(diagnostic);
  // Identical messages can describe different subjects; only exact repeats dedupe.
  const key = `${normalized.code}\u0000${normalized.message}\u0000${JSON.stringify(normalized.subject)}`;
  if (recordedKeys.has(key)) return;
  recordedKeys.add(key);
  recorded.push(normalized);
  if (!recordedByMessage.has(normalized.message)) recordedByMessage.set(normalized.message, normalized);
}

export function withDiagnosticRecordingSuppressed<T>(callback: () => T): T {
  recordingSuppressionDepth += 1;
  try {
    return callback();
  } finally {
    recordingSuppressionDepth -= 1;
  }
}

// Speculative synchronous work needs typed message lookup without publishing
// its discarded diagnostics into the caller's eventual renderer failure.
export function withIsolatedDiagnosticRecording<T>(callback: () => T): T {
  const previousRecorded = recorded;
  const previousKeys = recordedKeys;
  const previousByMessage = recordedByMessage;
  recorded = [];
  recordedKeys = new Set();
  recordedByMessage = new Map();
  try {
    return callback();
  } finally {
    recorded = previousRecorded;
    recordedKeys = previousKeys;
    recordedByMessage = previousByMessage;
  }
}

export function throwDiagnosticError(message: string, diagnostics?: readonly (DiagnosticInput | null | undefined)[] | null): never {
  for (const diagnostic of diagnostics || []) recordDiagnostic(diagnostic);
  const error: DiagnosticError = new Error(message);
  error.schematicsDiagnostics = (diagnostics || []).map(normalizedDiagnostic);
  throw error;
}

export function throwDiagnosticProblems(prefix: string, problems: readonly unknown[] | null | undefined, { code = 'layout/constraint', subject = {}, diagnostics: details = [] }: DiagnosticProblemOptions = {}): never {
  const messages = (problems || []).map((problem) => String(problem));
  // Consume matching details in emission order: repeated messages map to
  // different subjects, so a single lookup would attribute every occurrence to
  // the last detail entry.
  const queuesByMessage = new Map<string | undefined, DiagnosticInput[]>();
  for (const entry of details) {
    const queue = queuesByMessage.get(entry.message);
    if (queue) queue.push(entry);
    else queuesByMessage.set(entry.message, [entry]);
  }
  const diagnostics = messages.map((message) => {
    const queue = queuesByMessage.get(message);
    // Without a queued detail, reuse the structured diagnostic already
    // recorded under this message rather than attaching a bare fallback.
    const entry = queue?.length ? queue.shift() : recordedByMessage.get(message);
    return normalizedDiagnostic(entry || {
      code,
      severity: 'error',
      message,
      subject,
      evidence: {},
      supportedFixes: [],
    });
  });
  throwDiagnosticError(`${prefix}:\n- ${messages.join('\n- ')}`, diagnostics);
}

function fallbackDiagnostic(error: DiagnosticError | null | undefined): Diagnostic {
  const input = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  return normalizedDiagnostic({
    code: 'internal/unclassified',
    severity: 'error',
    message: error?.message || 'Renderer failed without a diagnostic.',
    subject: { input },
    evidence: { errorName: error?.name || 'Error' },
    supportedFixes: [],
  });
}
export function rendererFailure(error: DiagnosticError | null | undefined): RendererFailure {
  const attached = Array.isArray(error?.schematicsDiagnostics)
    ? error.schematicsDiagnostics.map(normalizedDiagnostic)
    : [];
  // Earlier diagnostics do not classify a later, unrelated implementation error.
  const diagnostics = attached.length
    ? (recorded.length ? recorded : attached)
    : [fallbackDiagnostic(error)];
  return {
    schemaVersion: 1,
    ok: false,
    source: 'renderer',
    error: error?.message || 'Renderer failed without a diagnostic.',
    diagnostics,
  };
}

// Match the public CLI's text format without making its standalone doctor
// bootstrap depend on this renderer runtime being present.
function formatDiagnostics(error: string, diagnostics: readonly Diagnostic[] = []): string {
  if (!diagnostics.length) return error;
  return [
    error,
    ...diagnostics.map((entry) => {
      const fix = entry.supportedFixes?.length ? ` Fix: ${entry.supportedFixes.join('; ')}.` : '';
      return `[${entry.code}] ${entry.message}${fix}`;
    }),
  ].join('\n');
}

const readerSignal = new Int32Array(new SharedArrayBuffer(4));

function waitForReader(): void {
  // Sleep instead of spinning on EAGAIN. A retry budget looks like a safeguard
  // and behaves like a truncation gate: a spinning loop burns thousands of
  // attempts in a few milliseconds, so a reader that is merely slow to start
  // exhausts it and loses the tail of the receipt. Waiting costs nothing while
  // the reader catches up, and a reader that goes away raises EPIPE, which the
  // caller already treats as a real write failure.
  Atomics.wait(readerSignal, 0, 0, 1);
}

export function installRendererDiagnosticBoundary(): void {
  if ((globalThis as Record<symbol, unknown>)[boundaryKey]) return;
  (globalThis as Record<symbol, unknown>)[boundaryKey] = true;
  if (!DIAGNOSTIC_MODE) {
    process.once('uncaughtException', (error: DiagnosticError) => {
      // Only errors classified at their operation boundary are author-facing.
      // Preserve Node's debugging information for unexpected implementation errors.
      if (!error?.schematicsDiagnostics?.length) {
        // The once-listener is already removed. Rethrow outside the exception
        // handler so Node retains its normal stack and exit code (not code 7).
        process.nextTick(() => { throw error; });
        return;
      }
      const payload = `${formatDiagnostics(error.message, error.schematicsDiagnostics)}\n`;
      process.stderr.once('error', () => process.exit(1));
      process.stderr.write(payload, () => process.exit(1));
    });
    return;
  }
  process.on('uncaughtException', (error: DiagnosticError) => {
    const payload = `${JSON.stringify(rendererFailure(error))}\n`;
    try {
      // stderr may be a pipe. fs.writeSync performs a PARTIAL write once the
      // payload exceeds the OS pipe buffer (8KB on macOS) and returns the byte
      // count actually written. Ignoring that return value silently truncated
      // large diagnostic payloads mid-JSON, so the parent CLI's JSON.parse
      // failed and the fail-closed boundary reported internal/unclassified
      // instead of the diagnostics we had already computed. Loop until drained.
      // A full pipe also makes writeSync throw EAGAIN; wait for the reader
      // rather than treat it as a stream failure, otherwise the tail is
      // dropped just the same.
      const buffer = Buffer.from(payload, 'utf8');
      let written = 0;
      while (written < buffer.length) {
        try {
          written += fs.writeSync(process.stderr.fd, buffer, written, buffer.length - written);
        } catch (writeError) {
          if ((writeError as { code?: unknown } | null | undefined)?.code === 'EAGAIN') {
            waitForReader();
            continue;
          }
          throw writeError;
        }
      }
    } catch {
      // The renderer is already failing. Avoid replacing its real error with a
      // secondary stream failure; the parent CLI still has the exit status.
    }
    process.exit(1);
  });
}
