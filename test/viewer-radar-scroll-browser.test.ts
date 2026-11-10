import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChromeVisualBrowser, findChrome } from '../schematics/bin/visual-check.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.SCHEMATICS_CHROME ? findChrome() : null;

test('Radar follows page scrolling and navigates long diagrams vertically', {
  skip: chrome ? false : 'Set SCHEMATICS_CHROME to run real-browser radar checks.',
}, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'schematics-radar-scroll-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const data = JSON.parse(fs.readFileSync(path.join(root, 'schematics/examples/cache-miss-request.sequence.json'), 'utf8'));
  data.meta.viewBox = [1600, 6400];
  data.segments = [];
  data.activations = [];
  data.messages = Array.from({ length: 120 }, (_, i) => ({
    id: `row-${i}`, from: 'web', to: 'api', y: 160 + i * 50, label: `Request ${i + 1}`,
  }));
  const input = path.join(scratch, 'sequence.json'), output = path.join(scratch, 'sequence.html');
  fs.writeFileSync(input, JSON.stringify(data));
  execFileSync(process.execPath, [path.join(root, 'schematics/bin/schematics.ts'), 'render', 'sequence', input, output]);
  assert.ok(chrome);
  const browser = new ChromeVisualBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method: string, params: Record<string, unknown> = {}) => browser.cdp.send(method, params, session);
  async function run<T>(expression: string): Promise<T> {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description ?? 'Runtime.evaluate threw');
    return result.result?.value as T;
  }
  interface LogicalViewport { x: number; y: number; width: number; height: number }
  async function stable() {
    await run(`(async () => {
      await document.fonts.ready;
      await Schematics.readerLayout.whenStable();
      await Schematics.viewerChromeLayout.whenStable();
      let previous = '', equal = 0;
      for (let frame = 0; frame < 240; frame++) {
        await new Promise(requestAnimationFrame);
        const svg = document.querySelector('.diagram-container > svg');
        const current = JSON.stringify([getComputedStyle(svg).transform, svg.getBoundingClientRect().toJSON(), scrollY,
          document.documentElement.scrollHeight, document.querySelector('.overview-map-viewport').outerHTML]);
        equal = current === previous ? equal + 1 : 0;
        previous = current;
        if (equal >= 8) return;
      }
      throw new Error('Radar camera did not settle');
    })()`);
  }
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  for (const width of [1280, 540]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(output).href });
    await loaded;
    await stable();
    const geometry = await run(`document.querySelector('.diagram-container > svg').innerHTML`);
    await run('Schematics.radar.open()');
    await stable();
    const top = await run<LogicalViewport>('Schematics.view.logicalViewport()');
    assert.ok(top.height < 3200, 'a multi-screen diagram must not be reported as fully visible');
    await run('window.scrollTo(0, 1000)');
    await stable();
    const middle = await run<{ visible: LogicalViewport; start: number; end: number; frameY: number; frameHeight: number }>(`(() => {
      const visible = Schematics.view.logicalViewport(), s = document.querySelector('.diagram-container > svg');
      const m = s.getScreenCTM(), frame = document.querySelector('.overview-map-viewport');
      return { visible, start: m.d * visible.y + m.f, end: m.d * (visible.y + visible.height) + m.f,
        frameY: Number(frame.getAttribute('y')), frameHeight: Number(frame.getAttribute('height')) };
    })()`);
    assert.ok(middle.visible.y > top.y + 100, JSON.stringify(middle));
    assert.ok(Math.abs(middle.start) < 2 && Math.abs(middle.end - 800) < 2, 'logical viewport matches the actual window');
    assert.ok(Math.abs(middle.frameY - middle.visible.y) < 1);
    assert.ok(Math.abs(middle.frameHeight - middle.visible.height) < 1);

    // A blank-map pointer jump has no node-focus fallback to bring it on screen.
    const point = await run<{ x: number; y: number }>(`(() => {
      const map = document.querySelector('#overview-map-surface > svg'), p = map.createSVGPoint();
      p.x = 800; p.y = 4800;
      const q = p.matrixTransform(map.getScreenCTM()); return { x: q.x, y: q.y };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await stable();
    const jump = await run<{ targetY: number; viewport: LogicalViewport; scrollY: number }>(`(() => { const m = document.querySelector('.diagram-container > svg').getScreenCTM();
      return { targetY: m.d * 4800 + m.f, viewport: Schematics.view.logicalViewport(), scrollY }; })()`);
    assert.ok(jump.targetY > 100 && jump.targetY < 700, `blank-map target must be readable: ${JSON.stringify(jump)}`);
    await run(`document.getElementById('overview-map-surface').focus({preventScroll:true})`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await stable();
    const next = await run<LogicalViewport>('Schematics.view.logicalViewport()');
    assert.ok(next.y > jump.viewport.y + 10, 'down arrow advances the visible part of the timeline');
    assert.equal(await run(`document.querySelector('.diagram-container > svg').innerHTML`), geometry, 'navigation preserves authored geometry and text');

    await run('Schematics.view.reset(); Schematics.view.zoomOut(); Schematics.view.zoomOut()');
    await stable();
    const overview = await run<LogicalViewport>('Schematics.view.logicalViewport()');
    assert.ok(overview.height > next.height, 'zooming out exposes more of the timeline');
    if (width === 1280) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await run(`Schematics.motionGovernor.setMode('live'); document.getElementById('overview-map-surface').focus({preventScroll:true})`);
      await stable();
      assert.notEqual(await run(`getComputedStyle(document.querySelector('.diagram-container > svg')).transitionDuration`), '0s');
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
      await stable();
      const animated = await run<{ scale: number; start: number; end: number; y: number; height: number; frameY: number; frameHeight: number; flow: string; geometry: string }>(`(() => {
        const s = document.querySelector('.diagram-container > svg'), v = Schematics.view.logicalViewport();
        const m = s.getScreenCTM(), frame = document.querySelector('.overview-map-viewport');
        return { scale: Schematics.view.state().scale, start: m.d * v.y + m.f, end: m.d * (v.y + v.height) + m.f,
          y: v.y, height: v.height, frameY: Number(frame.getAttribute('y')), frameHeight: Number(frame.getAttribute('height')),
          flow: s.parentElement.style.height, geometry: s.innerHTML };
      })()`);
      assert.equal(animated.scale, 1.5, 'Map keyboard navigation returns to a readable scale');
      assert.ok(Math.abs(animated.start) < 2 && Math.abs(animated.end - 800) < 2, JSON.stringify(animated));
      assert.ok(Math.abs(animated.frameY - animated.y) < 1 && Math.abs(animated.frameHeight - animated.height) < 1, 'radar catches up after the CSS transform settles');
      assert.equal(animated.flow, '', 'Map page-flow reduction is restored');
      assert.equal(animated.geometry, geometry);
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    }
    await run(`document.documentElement.setAttribute('data-present', 'true'); window.scrollTo(0,0); Schematics.view.reset()`);
    await stable();
    const presentScroll = await run('scrollY');
    await run('Schematics.view.centerAt(800, 4800, { scale: 1.5, instant: true })');
    await stable();
    assert.equal(await run('scrollY'), presentScroll, 'presentation stays in its own stage rather than scrolling the page');
  }
});
