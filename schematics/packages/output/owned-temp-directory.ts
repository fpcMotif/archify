import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { errorCode, errorMessage, sameEntry } from './path-semantics.ts';

// Bun's recursive rmSync reports ENOENT on the root when Chrome deletes a profile file mid-walk.
const retryable = new Set<unknown>(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'ENOENT']);

interface DirectoryIdentity {
  directory: string;
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

export interface OwnedTempDirectory {
  readonly path: string;
  cleanup(): Promise<void>;
}

function directoryIdentity(directory: string): DirectoryIdentity {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) {
    throw new Error(`Temporary directory identity is unavailable or changed: ${directory}`);
  }
  return { directory, dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

function verifyIdentity(expected: DirectoryIdentity): void {
  const current = directoryIdentity(expected.directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino
    || current.birthtimeNs !== expected.birthtimeNs) {
    throw new Error(`Temporary directory identity changed: ${expected.directory}`);
  }
}

// Bind cleanup to this creation, never to a caller-supplied deletion path.
// This detects substitution between creation and cleanup (including junctions)
// and between retries. Path-based Node APIs cannot eliminate a hostile mutation
// racing the final check and rm; this is not a filesystem sandbox.
export function createOwnedTempDirectory(
  prefix: string,
  { parent = os.tmpdir() }: { parent?: string } = {},
): OwnedTempDirectory {
  if (!/^[a-zA-Z0-9-]+-$/.test(prefix)) throw new Error('Invalid temporary directory prefix');
  const canonicalParent = fs.realpathSync.native(path.resolve(parent));
  const ancestors: DirectoryIdentity[] = [];
  for (let current = canonicalParent; ; current = path.dirname(current)) {
    ancestors.push(directoryIdentity(current));
    const parentRelation = sameEntry(current, path.dirname(current));
    if (parentRelation.status === 'match') break;
    if (parentRelation.status !== 'different') {
      throw new Error(`Temporary directory ancestor identity is unavailable: ${current}`);
    }
  }
  const verifyAncestors = () => {
    // Check from the filesystem root down, before traversing a replaced parent.
    for (const ancestor of [...ancestors].reverse()) verifyIdentity(ancestor);
  };
  verifyAncestors();
  const directory = fs.mkdtempSync(path.join(canonicalParent, prefix));
  verifyAncestors();
  const identity = directoryIdentity(directory);

  function remove() {
    verifyAncestors();
    try {
      verifyIdentity(identity);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    // No internal retry: each new attempt must revalidate the entire binding.
    fs.rmSync(directory, { recursive: true, force: false, maxRetries: 0 });
  }

  return Object.freeze({
    path: directory,
    async cleanup() {
      for (let attempt = 0; ; attempt++) {
        try {
          remove();
          return;
        } catch (cause) {
          if (retryable.has(errorCode(cause)) && attempt < 3) {
            await delay(100 * (attempt + 1));
            continue;
          }
          const error = Object.assign(
            new Error(`Temporary directory cleanup failed; retained path "${directory}": ${errorMessage(cause)}`, { cause }),
            { code: 'SCHEMATICS_TEMP_CLEANUP', directory },
          );
          throw error;
        }
      }
    },
  });
}
