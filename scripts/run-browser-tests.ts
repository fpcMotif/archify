#!/usr/bin/env bun
// Runs the Chrome-backed suites. Plain `bun test` skips them without SCHEMATICS_CHROME.
import { findChrome } from '../schematics/bin/visual-check.mjs';

const browserTestFiles = [
  'finalize-browser.test.mjs',
  'desktop-reader-browser.test.mjs',
  'reader-readability-maintained-browser.test.mjs',
  'reader-layout-browser.test.mjs',
  'reader-layout-settle-browser.test.mjs',
  'reader-cards-overflow-browser.test.mjs',
  'joint-layout-browser.test.mjs',
  'sequence-header-clearance.test.mjs',
  'sequence-width-default-browser.test.mjs',
  'compact-header-clearance.test.mjs',
  'architecture-reading-size-browser.test.mjs',
  'export-cleanup-browser.test.mjs',
  'i18n-browser.test.mjs',
  'offline-font-browser.test.mjs',
  'viewer-chrome-layout.test.mjs',
  'semantic-radar.test.mjs',
  'viewer-camera-browser.test.mjs',
  'viewer-radar-scroll-browser.test.mjs',
  'motion-governor-browser.test.mjs',
  'finder-browser.test.mjs',
  'intent-trace-browser.test.mjs',
  'semantic-lens-browser.test.mjs',
  'reading-address-browser.test.mjs',
  'route-probe-browser.test.mjs',
  'focus-browser.test.mjs',
  'crossover-state-browser.test.mjs',
  'semantic-passport-move-browser.test.mjs',
  'export-browser.test.mjs',
  'menu-modifier-browser.test.mjs',
  'export-selection-browser.test.mjs',
  'sequence-note-export-browser.test.mjs',
  'viewer-identifiers-browser.test.mjs',
  'repository-evidence-browser.test.mjs',
  'repository-evidence-types-browser.test.mjs',
  'tree-branches-browser.test.mjs',
  'class-motion-browser.test.mjs',
  'dataflow-label-visibility-browser.test.mjs',
  'workflow-edge-label-contrast-browser.test.mjs',
  'lifecycle-note-contrast-browser.test.mjs',
  'sequence-segment-contrast-browser.test.mjs',
  'bottom-node-index-browser.test.mjs',
  'explainer-browser.test.mjs',
];

const chrome = findChrome();
if (!chrome) {
  console.error('Browser tests require Chrome, Chromium or Edge. Set SCHEMATICS_CHROME to its path; this gate does not skip.');
  process.exit(1);
}

const selected = Bun.argv.slice(2);
const files = selected.length > 0 ? selected : browserTestFiles.map((file) => `./test/${file}`);
const child = Bun.spawnSync(['bun', 'test', '--timeout', '120000', ...files], {
  env: { ...process.env, SCHEMATICS_CHROME: chrome },
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.exit(child.exitCode ?? 1);
