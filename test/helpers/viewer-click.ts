import assert from 'node:assert/strict';

declare const Schematics: { viewerChromeLayout: { whenStable(): Promise<void> } };

interface ClickPoint {
  x: number;
  y: number;
}

interface ClickObservation {
  trusted: boolean;
  matches: boolean;
}

export interface ViewerClickSession {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  run(expression: string): Promise<unknown>;
  timeout: number;
}

// Keep native input and assert the actual event target, so a later docking
// update cannot silently turn a missed click into an unrelated state timeout.
function installClickObserver(): void {
  const describe = (el: Element | null) => el ? { tag: el.tagName, id: el.id, node: el.getAttribute('data-node-id') } : null;
  const state = (el: Element | null) => {
    const r = el?.getBoundingClientRect();
    const point = r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    const hit = point && document.elementFromPoint(point.x, point.y);
    return {
      point, rect: r ? [r.x, r.y, r.width, r.height] : null,
      visible: !!el?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      enabled: !!el && !el.matches(':disabled,[aria-disabled="true"]'),
      hit: describe(hit), matches: !!el && (el === hit || el.contains(hit)),
      camera: document.querySelector('.diagram-container')?.getAttribute('data-camera-transaction'),
      dock: document.getElementById('route-probe')?.getAttribute('data-route-dock'),
    };
  };
  let listener: ((event: MouseEvent) => void) | null = null;
  let observation: unknown = null;
  function arm(selector: string): void {
    if (listener) removeEventListener('click', listener, true);
    observation = null;
    listener = event => {
      const el = document.querySelector(selector);
      const target = event.target instanceof Element ? event.target : null;
      observation = { trusted: event.isTrusted, matches: !!el && (el === target || el.contains(target)),
        target: describe(target), state: state(el), x: event.clientX, y: event.clientY };
    };
    addEventListener('click', listener, { capture: true, once: true });
  }
  Object.assign(window, { viewerClick: {
    async ready(selector: string, timeout: number): Promise<ClickPoint | null> {
      document.querySelector(selector)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      await Schematics.viewerChromeLayout.whenStable();
      return new Promise((resolve, reject) => {
        const start = performance.now();
        let previous: number[] | null = null;
        function sample(): void {
          const current = state(document.querySelector(selector));
          const rect = current.rect;
          const stable = rect && previous?.every((value, i) => Math.abs(value - (rect[i] ?? NaN)) < 0.1);
          if (stable && current.visible && current.enabled && current.matches && !current.camera) {
            arm(selector);
            return resolve(current.point);
          }
          if (performance.now() - start > timeout) {
            return reject(new Error('Viewer click target not ready: ' + selector + ' ' + JSON.stringify(current)));
          }
          previous = current.rect;
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      });
    },
    finish(): unknown {
      if (listener) removeEventListener('click', listener, true);
      listener = null;
      return observation;
    },
  } });
}

export function foldedDockTool(selector: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const more = document.getElementById('btn-nav-more'); return Boolean(el && more && el.closest('.diagram-nav') && getComputedStyle(el).display === 'none' && getComputedStyle(more).display !== 'none'); })()`;
}

export async function createViewerClick({ send, run, timeout }: ViewerClickSession): Promise<(selector: string) => Promise<void>> {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installClickObserver.toString()})();` });
  return async function click(selector: string): Promise<void> {
    // Secondary dock tools rest behind the overflow button; open it the way a
    // reader would before clicking a folded tool.
    if (selector !== '#btn-nav-more' && await run(foldedDockTool(selector))) await click('#btn-nav-more');
    const point = await run(`viewerClick.ready(${JSON.stringify(selector)}, ${timeout})`) as ClickPoint;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    const observation = await run('viewerClick.finish()') as ClickObservation | null;
    assert.ok(observation?.trusted && observation.matches,
      `Native click missed ${selector}: ${JSON.stringify({ point, observation })}`);
  };
}
