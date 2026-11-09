#!/usr/bin/env bun

import fs from 'node:fs';
import path from 'node:path';
import { checkDiagramArtifact } from '../packages/artifact-check/check-diagram.mjs';
import { isExplainerHtml, checkExplainerHtml } from '../packages/explainer/check.mjs';

export function checkArtifact(bytes, { file } = {}) {
  const html = Buffer.from(bytes).toString('utf8');
  if (isExplainerHtml(html)) return checkExplainerHtml(html, { file });
  return checkDiagramArtifact(bytes, { file });
}

function runCli(input) {
  if (!input || input === '-h' || input === '--help') {
    console.error('Usage: node scripts/check-render-output.mjs <diagram.html>');
    process.exit(input ? 0 : 2);
  }
  const htmlPath = path.resolve(input);
  let bytes;
  try {
    bytes = fs.readFileSync(htmlPath);
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      file: htmlPath,
      checks: [{ name: 'file_readable', ok: false, details: [err.message] }],
    }, null, 2));
    process.exit(1);
  }
  const receipt = checkArtifact(bytes, { file: htmlPath });
  console.log(JSON.stringify(receipt, null, 2));
  // Let pending stdout writes drain: large receipts are asynchronous when piped.
  process.exitCode = receipt.ok ? 0 : 1;
}

if (import.meta.main) runCli(process.argv[2]);
