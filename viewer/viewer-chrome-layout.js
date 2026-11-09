    /* ============================================================
       Viewer Chrome Layout — keep HTML controls clear of the canonical SVG
       stage without changing authored geometry. The dock keeps its floating
       appearance while a small bottom stage rail becomes part of the reader
       budget whenever its zero-reserve position would enter the stage.
       ============================================================ */
    Schematics.viewerChromeLayout = (function () {
      var html = document.documentElement;
      var container = document.querySelector('.diagram-container');
      var svg = container && container.querySelector(':scope > svg');
      var nav = container && container.querySelector('.diagram-nav');
      var legend = svg && svg.querySelector('[data-legend]');
      var frame = 0;
      var settleFrame = 0;
      var reserve = 0;
      var railLatched = false;
      var probingBaseline = false;
      var probePromise = null;
      var baselineIntersectionArea = 0;
      var baselineStageGap = null;
      var restorableReserve = 0;
      var probeFallbackReserve = 0;
      var lastReceipt = null;
      var SAFE_GAP = 10;

      function visible(element) {
        if (!element || element.hidden) return false;
        var style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }
      function usable(rect) {
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      }
      function intersectionArea(a, b) {
        var width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        var height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        return width * height;
      }
      function protectedStageRect() {
        if (!svg) return null;
        var rect = svg.getBoundingClientRect();
        var transform = '';
        try { transform = window.getComputedStyle(svg).transform || ''; } catch (_) {}
        var scaleX = 1;
        var scaleY = 1;
        var translateX = 0;
        var translateY = 0;
        var matrix = transform.match(/^matrix\(([^)]+)\)$/);
        var matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
        if (matrix) {
          var values = matrix[1].split(',').map(Number);
          if (values.length === 6 && values.every(Number.isFinite)) {
            scaleX = Math.abs(values[0]) || 1;
            scaleY = Math.abs(values[3]) || 1;
            translateX = values[4];
            translateY = values[5];
          }
        } else if (matrix3d) {
          var values3d = matrix3d[1].split(',').map(Number);
          if (values3d.length === 16 && values3d.every(Number.isFinite)) {
            scaleX = Math.abs(values3d[0]) || 1;
            scaleY = Math.abs(values3d[5]) || 1;
            translateX = values3d[12];
            translateY = values3d[13];
          }
        }
        var width = rect.width / scaleX;
        // A negative bottom margin tucks a declared empty band under the
        // canvas edge; that band holds no paint for the dock to clear.
        var emptyBottom = 0;
        try { emptyBottom = Math.max(0, -parseFloat(window.getComputedStyle(svg).marginBottom) || 0); } catch (_) {}
        var height = Math.max(0, rect.height / scaleY - emptyBottom);
        var left = rect.left - translateX;
        var top = rect.top - translateY;
        return {
          x: left,
          y: top,
          left: left,
          top: top,
          right: left + width,
          bottom: top + height,
          width: width,
          height: height
        };
      }
      function eligible() {
        return Boolean(
          container && svg && nav &&
          window.innerWidth > 720 &&
          html.getAttribute('data-embed') !== 'true' &&
          (!window.matchMedia || !window.matchMedia('print').matches) &&
          visible(nav)
        );
      }
      function cameraAtBaseline() {
        var scale = Number(svg && svg.getAttribute('data-view-scale'));
        return !Number.isFinite(scale) || Math.abs(scale - 1) < 0.001;
      }
      function writeReserve(next, options) {
        options = options || {};
        next = Math.max(0, Math.ceil(next));
        if (Math.abs(next - reserve) < 1) return false;
        reserve = next;
        if (reserve) {
          if (options.remember !== false) restorableReserve = reserve;
          container.style.setProperty('--schematics-nav-reserve', reserve + 'px');
          container.setAttribute('data-nav-stage-rail', 'true');
          html.setAttribute('data-nav-stage-rail', 'true');
        } else {
          container.style.removeProperty('--schematics-nav-reserve');
          container.removeAttribute('data-nav-stage-rail');
          html.removeAttribute('data-nav-stage-rail');
        }
        if (Schematics.readerLayout && typeof Schematics.readerLayout.schedule === 'function') {
          Schematics.readerLayout.schedule();
        }
        if (options.quiet !== true) {
          if (settleFrame) cancelAnimationFrame(settleFrame);
          settleFrame = requestAnimationFrame(function () {
            settleFrame = 0;
            schedule();
          });
        }
        return true;
      }
      function clear(options) {
        options = options || {};
        railLatched = false;
        if (options.preserveBaseline !== true) {
          baselineIntersectionArea = 0;
          baselineStageGap = null;
          restorableReserve = 0;
        }
        writeReserve(0, { quiet: probingBaseline });
        lastReceipt = {
          eligible: false,
          active: false,
          reserve: 0,
          gap: SAFE_GAP,
          baselineStageGap: null,
          stageGap: null,
          stageIntersectionArea: 0,
          baselineIntersectionArea: 0,
          intersectionArea: 0
        };
        return lastReceipt;
      }
      /* When the stage runs below the viewport, the dock lifts to the viewport
         floor so its controls stay reachable while reading. Stage-rail
         decisions and receipts use its resting position, so the lift never
         feeds back into layout. */
      var lift = 0;
      var liftFrame = 0;
      function restingNavRect() {
        var rect = nav.getBoundingClientRect();
        if (!lift) return rect;
        return { x: rect.x, y: rect.y + lift, left: rect.left, right: rect.right, top: rect.top + lift, bottom: rect.bottom + lift, width: rect.width, height: rect.height };
      }
      function updateLift() {
        liftFrame = 0;
        var next = 0;
        if (eligible()) {
          var rest = restingNavRect();
          var box = container.getBoundingClientRect();
          next = Math.round(Math.max(0, Math.min(rest.bottom - (window.innerHeight - 16), rest.top - box.top - 16)));
        }
        if (next === lift) return;
        lift = next;
        if (lift) container.style.setProperty('--schematics-dock-lift', lift + 'px');
        else container.style.removeProperty('--schematics-dock-lift');
      }
      function scheduleLift() {
        if (!liftFrame) liftFrame = requestAnimationFrame(updateLift);
      }
      function measure() {
        frame = 0;
        updateDockLegend();
        scheduleLift();
        if (probingBaseline) return null;
        if (!eligible()) return clear({ preserveBaseline: !cameraAtBaseline() });

        /* Camera transforms enlarge and translate authored paint inside the
           fixed, clipped root SVG viewport. They must not redefine the
           reader's baseline rail.
           Restore that baseline after temporary mobile/embed/print states.
           Camera Reset preserves the established rail while viewport, mode,
           and content changes remain responsible for baseline reprobes. */
        if (!cameraAtBaseline()) {
          if (reserve === 0 && restorableReserve > 0) {
            if (writeReserve(restorableReserve)) return null;
          }
          var cameraNavRect = restingNavRect();
          var cameraLegendRect = visible(legend) ? legend.getBoundingClientRect() : null;
          var cameraStageRect = protectedStageRect();
          var cameraIntersectionArea = usable(cameraLegendRect) && intersectionArea(cameraNavRect, cameraStageRect) > 0
            ? intersectionArea(cameraNavRect, cameraLegendRect)
            : 0;
          lastReceipt = {
            eligible: true,
            active: reserve > 0,
            reserve: reserve,
            gap: SAFE_GAP,
            baselineStageGap: baselineStageGap == null ? null : Math.round(baselineStageGap * 100) / 100,
            stageGap: Math.round((cameraNavRect.top - cameraStageRect.bottom) * 100) / 100,
            stageIntersectionArea: Math.round(intersectionArea(cameraNavRect, cameraStageRect) * 100) / 100,
            baselineIntersectionArea: Math.round(baselineIntersectionArea * 100) / 100,
            intersectionArea: Math.round(cameraIntersectionArea * 100) / 100
          };
          return lastReceipt;
        }

        var navRect = restingNavRect();
        var legendRect = visible(legend) ? legend.getBoundingClientRect() : null;
        var stageRect = protectedStageRect();
        if (!usable(navRect) || !usable(stageRect)) return clear();

        var actualIntersectionArea = usable(legendRect) ? intersectionArea(navRect, legendRect) : 0;
        var stageGap = navRect.top - stageRect.bottom;
        if (!railLatched && reserve === 0) {
          baselineIntersectionArea = actualIntersectionArea;
          baselineStageGap = stageGap;
          if (stageGap < SAFE_GAP) {
            railLatched = true;
            if (writeReserve(Math.max(0, SAFE_GAP - stageGap))) return null;
          }
        } else if (railLatched && reserve > 0 && stageGap < SAFE_GAP) {
          /* Keep the decision latched while Adaptive Reader incorporates the
             rail. Presentation and rounded layout values can require one
             bounded follow-up before the full stage gap is established. */
          var remaining = Math.max(1, SAFE_GAP - stageGap);
          if (writeReserve(reserve + remaining)) return null;
        }

        navRect = restingNavRect();
        legendRect = visible(legend) ? legend.getBoundingClientRect() : null;
        stageRect = protectedStageRect();
        stageGap = navRect.top - stageRect.bottom;
        lastReceipt = {
          eligible: true,
          active: reserve > 0,
          reserve: reserve,
          gap: SAFE_GAP,
          baselineStageGap: baselineStageGap == null ? null : Math.round(baselineStageGap * 100) / 100,
          stageGap: Math.round(stageGap * 100) / 100,
          stageIntersectionArea: Math.round(intersectionArea(navRect, stageRect) * 100) / 100,
          baselineIntersectionArea: Math.round(baselineIntersectionArea * 100) / 100,
          intersectionArea: Math.round((usable(legendRect) ? intersectionArea(navRect, legendRect) : 0) * 100) / 100
        };
        return lastReceipt;
      }
      function reprobe() {
        if (probingBaseline) return probePromise || Promise.resolve(false);
        if (!cameraAtBaseline()) {
          schedule();
          return Promise.resolve(false);
        }
        if (!reserve && !railLatched && !restorableReserve) {
          schedule();
          return Promise.resolve(false);
        }
        probeFallbackReserve = restorableReserve || reserve;
        probingBaseline = true;
        railLatched = false;
        baselineIntersectionArea = 0;
        baselineStageGap = null;
        restorableReserve = 0;
        writeReserve(0, { quiet: true });
        var readerReady = Schematics.readerLayout && typeof Schematics.readerLayout.whenStable === 'function'
          ? Schematics.readerLayout.whenStable().catch(function () {})
          : Promise.resolve();
        probePromise = readerReady.then(function () {
          probingBaseline = false;
          probePromise = null;
          if (!cameraAtBaseline() && probeFallbackReserve > 0) {
            restorableReserve = probeFallbackReserve;
          }
          probeFallbackReserve = 0;
          schedule();
          return true;
        });
        return probePromise;
      }
      function schedule() {
        if (frame) return;
        frame = requestAnimationFrame(measure);
      }
      function stableSnapshot() {
        var containerRect = container ? container.getBoundingClientRect() : { width: 0, height: 0 };
        var navRect = nav ? restingNavRect() : { top: 0, left: 0 };
        var legendRect = legend ? legend.getBoundingClientRect() : { top: 0, left: 0 };
        return [
          reserve,
          lift,
          Math.round(containerRect.width * 100) / 100,
          Math.round(containerRect.height * 100) / 100,
          Math.round(navRect.left * 100) / 100,
          Math.round(navRect.top * 100) / 100,
          Math.round(legendRect.left * 100) / 100,
          Math.round(legendRect.top * 100) / 100,
          railLatched ? 'latched' : 'clear',
          lastReceipt ? lastReceipt.stageGap : ''
        ].join('|');
      }
      function layoutPending() { return Boolean(frame || settleFrame || liftFrame || probingBaseline); }
      function whenStable() {
        return Schematics.waitForStableLayout({
          schedule: schedule,
          pending: layoutPending,
          snapshot: stableSnapshot,
          timeoutMessage: 'Viewer chrome layout did not reach stable dimensions.'
        });
      }
      schematicsLayoutOwners.viewerChrome = { schedule: schedule, pending: layoutPending, snapshot: stableSnapshot };

      window.addEventListener('resize', reprobe, { passive: true });
      window.addEventListener('scroll', scheduleLift, { passive: true });
      window.addEventListener('load', schedule, { once: true });
      window.addEventListener('beforeprint', schedule);
      window.addEventListener('afterprint', reprobe);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(reprobe).catch(function () {});
      if (typeof ResizeObserver === 'function') {
        var resizeObserver = new ResizeObserver(schedule);
        [nav, svg, legend].forEach(function (element) { if (element) resizeObserver.observe(element); });
        // Camera zoom changes outer page flow without changing intrinsic SVG
        // size. Follow that box for dock placement, independently of scrolling
        // and the baseline stage-rail measurement.
        new ResizeObserver(scheduleLift).observe(container);
      }
      if (typeof MutationObserver === 'function') {
        var contentObserver = new MutationObserver(function (records) {
          // A theme switch changes paint, not the stage geometry. Reprobing
          // drops the bottom rail for several frames and makes the diagram jump.
          var viewerModeChanged = records.some(function (record) {
            return record.target === html && record.attributeName !== 'data-theme';
          });
          if (viewerModeChanged) reprobe();
          else schedule();
        });
        if (legend) contentObserver.observe(legend, { attributes: true, childList: true, subtree: true });
        contentObserver.observe(html, {
          attributes: true,
          attributeFilter: ['data-embed', 'data-present', 'data-preset', 'data-theme']
        });
      }
      // A phone keeps a wide diagram at its natural width, so its SVG legend
      // scrolls out of view. Mirror the same entries as a wrapping list below
      // the stage; CSS shows one or the other.
      // Copies leave the stage's preset scope, so each one carries the stroke
      // geometry its source resolved to; colors stay theme tokens in CSS.
      var PAINT = ['stroke-width', 'stroke-dasharray', 'stroke-linecap'];
      function paintedClone(source) {
        var copy = source.cloneNode(true);
        var sources = [source].concat(Array.prototype.slice.call(source.querySelectorAll('*')));
        var copies = [copy].concat(Array.prototype.slice.call(copy.querySelectorAll('*')));
        sources.forEach(function (element, index) {
          var computed = window.getComputedStyle(element);
          PAINT.forEach(function (name) { copies[index].style.setProperty(name, computed.getPropertyValue(name)); });
        });
        return copy;
      }
      function buildLegendList(className) {
        var entries = Array.prototype.slice.call(legend.querySelectorAll(':scope > [data-legend-semantic-kind]'));
        if (!entries.length) return null;
        var title = legend.querySelector(':scope > text');
        var list = document.createElement('ul');
        list.className = className + ' no-print';
        if (title) list.setAttribute('aria-label', title.textContent);
        var NS = 'http://www.w3.org/2000/svg';
        var rendererScopes = Array.prototype.filter.call(svg.attributes, function (attribute) {
          return /^data-[a-z]+-ui$/.test(attribute.name);
        });
        entries.forEach(function (entry) {
          var labels = entry.querySelectorAll(':scope > text');
          var label = labels[labels.length - 1];
          if (!label) return;
          var divider = entry.querySelector(':scope > [data-legend-divider]');
          if (divider) {
            var rule = document.createElement('li');
            rule.className = 'phone-legend-rule';
            rule.setAttribute('aria-hidden', 'true');
            list.appendChild(rule);
          }
          var x = Number(entry.getAttribute('data-legend-x'));
          var baseline = Number(entry.getAttribute('data-legend-baseline'));
          var swatchLeft = divider ? x + 34 : x;
          var swatchRight = Number(label.getAttribute('x')) - 4;
          var item = document.createElement('li');
          var icon = document.createElementNS(NS, 'svg');
          var swatchWidth = Math.max(1, swatchRight - swatchLeft);
          icon.setAttribute('viewBox', swatchLeft + ' ' + (baseline - 13) + ' ' + swatchWidth + ' 18');
          icon.style.width = (swatchWidth / 18 * 0.875) + 'rem';
          icon.setAttribute('aria-hidden', 'true');
          rendererScopes.forEach(function (attribute) { icon.setAttribute(attribute.name, attribute.value); });
          Array.prototype.forEach.call(entry.children, function (child) {
            if (child === label || child === divider || child.hasAttribute('tabindex')) return;
            icon.appendChild(paintedClone(child));
          });
          var text = document.createElement('span');
          text.textContent = label.textContent;
          item.appendChild(icon);
          item.appendChild(text);
          list.appendChild(item);
        });
        return list;
      }
      var dockLegend = null;
      if (legend && container.parentNode) {
        var phoneLegend = buildLegendList('phone-legend');
        if (phoneLegend) container.insertAdjacentElement('afterend', phoneLegend);
        dockLegend = buildLegendList('dock-legend');
        var legendBox = null;
        try { legendBox = legend.getBBox(); } catch (_) {}
        var stageBox = svg.viewBox && svg.viewBox.baseVal;
        // Only a key that closes the canvas can leave with its band.
        if (dockLegend && legendBox && stageBox && stageBox.width > 0 &&
            legendBox.y + legendBox.height >= stageBox.height - 72) {
          var band = (stageBox.height - legendBox.y + 4) / stageBox.width * 100;
          svg.style.setProperty('--schematics-legend-band', (Math.round(band * 100) / 100) + '%');
          container.appendChild(dockLegend);
        } else {
          dockLegend = null;
        }
      }
      function updateDockLegend() {
        if (!dockLegend || !nav) return;
        container.setAttribute('data-dock-legend', '');
        if (window.innerWidth <= 720) return;
        var navLeft = nav.getBoundingClientRect().left;
        var legendRight = dockLegend.getBoundingClientRect().right;
        if (legendRight > navLeft - 24) container.removeAttribute('data-dock-legend');
      }
      updateDockLegend();

      // Secondary tools fold behind one overflow button so the resting dock
      // shows only zoom. Keyboard shortcuts reach the folded tools directly.
      var moreButton = nav && nav.querySelector('#btn-nav-more');
      function setNavOpen(open) {
        if (!moreButton) return;
        nav.toggleAttribute('data-nav-open', open);
        moreButton.setAttribute('aria-expanded', open ? 'true' : 'false');
        schedule();
      }
      if (moreButton) {
        moreButton.addEventListener('click', function () {
          setNavOpen(moreButton.getAttribute('aria-expanded') !== 'true');
        });
        document.addEventListener('pointerdown', function (event) {
          if (nav.hasAttribute('data-nav-open') && !nav.contains(event.target)) setNavOpen(false);
        });
        nav.addEventListener('keydown', function (event) {
          if (event.key === 'Escape' && nav.hasAttribute('data-nav-open')) { setNavOpen(false); moreButton.focus(); }
        });
      }
      schedule();

      return {
        measure: measure,
        setNavOpen: setNavOpen,
        schedule: schedule,
        reprobe: reprobe,
        whenStable: whenStable,
        stageRect: protectedStageRect,
        dockRect: function () { return nav ? restingNavRect() : null; },
        active: function () { return reserve > 0; },
        receipt: function () { return lastReceipt || measure(); }
      };
    })();
