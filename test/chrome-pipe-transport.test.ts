import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { ChromeVisualBrowser, CHROME_STARTUP_TIMEOUT_MS } from '../schematics/bin/visual-check.ts';

class FakeChromeChild extends ChildProcess {
  override pid = 7321;
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;
  override stderr = new PassThrough();
  readonly writePipe = new PassThrough();
  readonly readPipe = new PassThrough();
  override stdio: ChildProcess['stdio'] = [null, null, this.stderr, this.writePipe, this.readPipe];
  override kill(signal?: NodeJS.Signals | number) {
    this.signalCode = typeof signal === 'string' ? signal : null;
    queueMicrotask(() => {
      this.emit('exit', null, signal);
      this.emit('close', null, signal);
    });
    return true;
  }
}

function chromeChild() {
  return new FakeChromeChild();
}

function browserFor(child: FakeChromeChild) {
  return new ChromeVisualBrowser('/fake/chrome', {
    env: {},
    getuid: () => 1001,
    spawnImpl: () => child,
  });
}

test('Chrome first-command timeout reports the running process, pipe progress and stderr', async (t) => {
  const setTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay?: number, ...args: unknown[]) =>
    setTimeout(callback, delay === CHROME_STARTUP_TIMEOUT_MS ? 5 : delay, ...args));
  const child = chromeChild();
  const browser = browserFor(child);
  child.stderr.write('Browser initialization is waiting for a service\n');
  try {
    await assert.rejects(browser.sessionPromise, (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`Target\\.getTargets: timed out after ${CHROME_STARTUP_TIMEOUT_MS}ms`));
      assert.match(error.message, /Chrome process: still running/);
      assert.match(error.message, /pid=7321/);
      assert.match(error.message, /Node v\d+.*libuv/);
      assert.match(error.message, /completedWrites=1/);
      assert.match(error.message, /receivedBytes=0/);
      assert.match(error.message, /Browser initialization is waiting for a service/);
      return true;
    });
  } finally {
    await browser.close();
  }
});

test('Chrome pipe EOF fails the pending first command without waiting for process close', async () => {
  const child = chromeChild();
  const browser = browserFor(child);
  try {
    const result = assert.rejects(browser.sessionPromise, /Chrome DevTools read pipe failed:.*ended/);
    child.readPipe.end();
    await Promise.race([
      result,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('pipe EOF did not reject the pending command')), 100);
        timer.unref();
      }),
    ]);
  } finally {
    await browser.close();
  }
});

test('Chrome close releases inherited process pipes after the main process exits', async () => {
  const child = chromeChild();
  const browser = browserFor(child);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  const session = assert.rejects(browser.sessionPromise, /visual-check finished/);
  const first = browser.close();
  const second = browser.close();
  assert.strictEqual(second, first);
  await first;
  await session;
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.writePipe.destroyed, true);
  assert.equal(child.readPipe.destroyed, true);
});
