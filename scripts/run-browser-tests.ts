#!/usr/bin/env bun
// Runs the Chrome-backed suites. Plain `bun test` skips them without SCHEMATICS_CHROME.
import { findChrome } from '../schematics/bin/visual-check.ts';

const browserTestFiles = [
  'finalize-browser.test.ts',
  'desktop-reader-browser.test.ts',
  'reader-readability-maintained-browser.test.ts',
  'reader-layout-browser.test.ts',
  'reader-layout-settle-browser.test.ts',
  'reader-cards-overflow-browser.test.ts',
  'joint-layout-browser.test.ts',
  'sequence-header-clearance.test.ts',
  'sequence-width-default-browser.test.ts',
  'compact-header-clearance.test.ts',
  'architecture-reading-size-browser.test.ts',
  'export-cleanup-browser.test.ts',
  'i18n-browser.test.ts',
  'offline-font-browser.test.ts',
  'viewer-chrome-layout.test.ts',
  'semantic-radar.test.ts',
  'viewer-camera-browser.test.ts',
  'viewer-radar-scroll-browser.test.ts',
  'motion-governor-browser.test.ts',
  'finder-browser.test.ts',
  'intent-trace-browser.test.ts',
  'semantic-lens-browser.test.ts',
  'reading-address-browser.test.ts',
  'route-probe-browser.test.ts',
  'focus-browser.test.ts',
  'crossover-state-browser.test.ts',
  'semantic-passport-move-browser.test.ts',
  'export-browser.test.ts',
  'menu-modifier-browser.test.ts',
  'export-selection-browser.test.ts',
  'sequence-note-export-browser.test.ts',
  'viewer-identifiers-browser.test.ts',
  'repository-evidence-browser.test.ts',
  'repository-evidence-types-browser.test.ts',
  'tree-branches-browser.test.ts',
  'class-motion-browser.test.ts',
  'dataflow-label-visibility-browser.test.ts',
  'workflow-edge-label-contrast-browser.test.ts',
  'lifecycle-note-contrast-browser.test.ts',
  'sequence-segment-contrast-browser.test.ts',
  'bottom-node-index-browser.test.ts',
  'explainer-browser.test.ts',
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
