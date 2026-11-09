import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import path from 'node:path';

interface Opener {
  command: string;
  method: string;
  timeoutMs: number;
  args: (target: string) => string[];
}

interface LaunchError {
  code?: unknown;
  message?: unknown;
}

export interface LaunchResult {
  error?: unknown;
  signal?: string | null;
  status?: number | null;
}

export type OpenerSpawn = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => LaunchResult;

export interface LaunchOptions {
  platform?: string;
  spawn?: OpenerSpawn;
  timeoutMs?: unknown;
}

export interface LaunchFailure {
  code: string;
  reason: unknown;
  systemCode?: string;
  timeoutMs?: number;
  signal?: string;
  exitCode?: number | null;
}

export interface LaunchReceipt {
  requested: true;
  status: 'opened' | 'unsupported' | 'failed';
  target: string;
  method: string | null;
  failure?: LaunchFailure;
}

const OPENERS: Record<string, Opener> = {
  darwin: {
    command: 'open',
    method: 'open',
    timeoutMs: 5000,
    args: (target) => [target],
  },
  linux: {
    command: 'xdg-open',
    method: 'xdg-open',
    timeoutMs: 5000,
    args: (target) => [target],
  },
  win32: {
    command: 'powershell.exe',
    method: 'powershell',
    // PowerShell cold starts can approach five seconds on hosted Windows
    // runners. Keep the launch bounded without treating normal startup as a
    // timeout.
    timeoutMs: 15000,
    // Keep the command constant and pass the target through a child-only
    // environment variable. Paths are never interpolated into executable source.
    args: () => [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Start-Process -FilePath $env:SCHEMATICS_OPEN_TARGET',
    ],
  },
};

function launchError(value: unknown): LaunchError | undefined {
  return typeof value === 'object' && value !== null ? value : undefined;
}

function failureDetails(result: LaunchResult | undefined, opener: Opener, timeoutMs: number): LaunchFailure | null {
  const error = launchError(result?.error);
  if (error?.code === 'ENOENT') {
    return {
      code: 'opener/unavailable',
      reason: `Could not find ${opener.command}. Install or enable the platform opener, then open the target manually.`,
      systemCode: 'ENOENT',
    };
  }
  if (error?.code === 'ETIMEDOUT') {
    return {
      code: 'opener/timeout',
      reason: `${opener.command} did not finish within ${timeoutMs}ms. Open the target manually or retry when the system is less busy.`,
      systemCode: 'ETIMEDOUT',
      timeoutMs,
    };
  }
  if (error) {
    return {
      code: 'opener/spawn-failed',
      reason: error.message || `${opener.command} could not be started. Open the target manually.`,
      ...(error.code ? { systemCode: String(error.code) } : {}),
    };
  }
  if (result?.signal) {
    return {
      code: 'opener/signaled',
      reason: `${opener.command} was terminated by ${result.signal}. Open the target manually.`,
      signal: result.signal,
    };
  }
  if (result?.status !== 0) {
    return {
      code: 'opener/nonzero-exit',
      reason: `${opener.command} exited with status ${result?.status ?? 'unknown'}. Open the target manually.`,
      exitCode: result?.status ?? null,
    };
  }
  return null;
}

function launchTimeout(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function launchTarget(target: string, options: LaunchOptions = {}): LaunchReceipt {
  const platform = options.platform || process.platform;
  const opener = OPENERS[platform];
  if (!opener) {
    return {
      requested: true,
      status: 'unsupported',
      target,
      method: null,
    };
  }

  const spawn: OpenerSpawn = options.spawn || spawnSync;
  const timeoutMs = launchTimeout(options.timeoutMs, opener.timeoutMs);
  let result: LaunchResult;
  try {
    const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
      encoding: 'utf8',
      shell: false,
      stdio: 'ignore',
      timeout: timeoutMs,
      windowsHide: true,
    };
    if (platform === 'win32') {
      spawnOptions.env = {
        ...process.env,
        SCHEMATICS_OPEN_TARGET: target,
      };
    }
    result = spawn(opener.command, opener.args(target), spawnOptions);
  } catch (error) {
    result = { error };
  }

  const failure = failureDetails(result, opener, timeoutMs);
  let status: LaunchReceipt['status'] = 'opened';
  if (failure?.code === 'opener/unavailable') status = 'unsupported';
  else if (failure) status = 'failed';

  return {
    requested: true,
    status,
    target,
    method: opener.method,
    ...(failure ? { failure } : {}),
  };
}

export function openArtifact(target: string, options: LaunchOptions = {}): LaunchReceipt {
  return launchTarget(path.resolve(target), options);
}

export function openLoopbackUrl(target: string, options: LaunchOptions = {}): LaunchReceipt {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new TypeError('Preview URL must be a valid loopback HTTP URL.');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new TypeError('Preview URL must be a loopback URL using http://127.0.0.1:<port>.');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Preview URL must target the loopback preview root.');
  }
  return launchTarget(url.href, options);
}
