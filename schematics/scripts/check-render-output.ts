#!/usr/bin/env bun

import fs from 'node:fs';
import path from 'node:path';
import { checkDiagramArtifact, type CheckDiagramResult } from '../packages/artifact-check/check-diagram.ts';
import { isExplainerHtml, checkExplainerHtml } from '../packages/explainer/check.ts';

export interface CheckArtifactOptions {
  file?: string;
}

export type ArtifactReceipt = CheckDiagramResult | ReturnType<typeof checkExplainerHtml>;

export function checkArtifact(bytes: Uint8Array | string, { file }: CheckArtifactOptions = {}): ArtifactReceipt {
  const buffer = Buffer.from(bytes);
  const html = buffer.toString('utf8');
  if (isExplainerHtml(html)) return checkExplainerHtml(html, { file });
  return checkDiagramArtifact(buffer, { file });
}

function errorMessage(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined;
}

function runCli(input: string | undefined): void {
  if (!input || input === '-h' || input === '--help') {
    console.error('Usage: node scripts/check-render-output.ts <diagram.html>');
    process.exit(input ? 0 : 2);
  }
  const htmlPath = path.resolve(input);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(htmlPath);
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      file: htmlPath,
      checks: [{ name: 'file_readable', ok: false, details: [errorMessage(err)] }],
    }, null, 2));
    process.exit(1);
  }
  const receipt = checkArtifact(bytes, { file: htmlPath });
  console.log(JSON.stringify(receipt, null, 2));
  // Let pending stdout writes drain: large receipts are asynchronous when piped.
  process.exitCode = receipt.ok ? 0 : 1;
}

if (import.meta.main) runCli(process.argv[2]);
