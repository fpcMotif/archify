#!/usr/bin/env bun
/**
 * scripts/archify-autofix.ts
 * Pure Bun-native TypeScript compiler and deterministic layout solver for Archify.
 * Powered by Bun, typed with TypeScript, using Effect-style functional pipelines.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const archifyBin = path.resolve(__dirname, "../archify/bin/archify.mjs");

interface Message {
  id: string;
  from: string;
  to: string;
  y?: number;
  label: string;
  variant?: string;
  note?: string;
}

interface Segment {
  from?: number;
  to?: number;
  label: string;
}

interface Activation {
  participant: string;
  from?: number;
  to?: number;
  type?: string;
}

interface SequenceCandidate {
  schema_version: number;
  diagram_type: string;
  meta: {
    title: string;
    output: string;
    quality_profile?: string;
    repository?: { url?: string };
    [key: string]: unknown;
  };
  participants: Array<{ id: string; type: string; label: string; [key: string]: unknown }>;
  messages: Message[];
  segments?: Segment[];
  activations?: Activation[];
}

interface FinalizeDiagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  supportedFixes?: string[];
  [key: string]: unknown;
}

interface FinalizeResult {
  ok: boolean;
  status: string;
  diagnostics?: FinalizeDiagnostic[];
  error?: string;
  [key: string]: unknown;
}

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error("Usage: bun scripts/archify-autofix.ts <type> <candidate.json> <output.html> [finalize-flags...]");
  process.exit(1);
}

const [type, candidatePath, outputPath, ...extraFlags] = args;
const resolvedCandidate = path.resolve(process.cwd(), candidatePath);

function applyJsonPointer(target: Record<string, unknown>, pointer: string, value: string): void {
  const parts = pointer.replace(/^\//, "").split("/");
  let current: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1];
  const numVal = Number(value);
  current[lastKey] = !isNaN(numVal) ? numVal : value;
}

/**
 * Functional deterministic sequence auto-spacing pipeline.
 * Computes exact clearances for labels, multi-line notes, segments, and activations.
 */
function autoSpaceSequence(candidate: SequenceCandidate): boolean {
  if (!Array.isArray(candidate.messages) || candidate.messages.length === 0) return false;

  let currentY = 165;
  for (const msg of candidate.messages) {
    msg.y = currentY;
    const note = msg.note;
    const noteLines = note ? (note.length > 25 ? 2 : 1) : 0;
    const step = note ? 40 + noteLines * 18 : 38;
    currentY += step;
  }

  if (Array.isArray(candidate.segments) && candidate.segments.length > 0) {
    const totalMsgs = candidate.messages.length;
    const segCount = candidate.segments.length;
    const msgsPerSeg = Math.max(1, Math.round(totalMsgs / segCount));

    for (let s = 0; s < segCount; s++) {
      const startIdx = s * msgsPerSeg;
      const endIdx = s === segCount - 1 ? totalMsgs - 1 : Math.min(totalMsgs - 1, (s + 1) * msgsPerSeg - 1);
      const startY = candidate.messages[startIdx]?.y ?? 165;
      const endY = candidate.messages[endIdx]?.y ?? startY + 50;

      candidate.segments[s].from = Math.max(140, startY - 20);
      candidate.segments[s].to = endY + 25;
    }
  }

  if (Array.isArray(candidate.activations)) {
    for (const act of candidate.activations) {
      const related = candidate.messages.filter(m => m.from === act.participant || m.to === act.participant);
      if (related.length > 0) {
        act.from = related[0].y;
        act.to = related[related.length - 1].y;
      }
    }
  }

  return true;
}

function resolveRepoFlags(candidate: SequenceCandidate): string[] {
  const flags = [...extraFlags];
  if (!flags.includes("--repo-root") && candidate.meta?.repository?.url) {
    const targetUrl = candidate.meta.repository.url.replace(/\.git$/, "").toLowerCase();
    try {
      const entries = fs.readdirSync(process.cwd(), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            const gitRes = Bun.spawnSync(["git", "-C", entry.name, "remote", "get-url", "origin"]);
            const origin = gitRes.stdout.toString().trim().replace(/\.git$/, "").toLowerCase();
            if (origin && (origin === targetUrl || targetUrl.includes(origin) || origin.endsWith(targetUrl.split("/").slice(-2).join("/")))) {
              flags.push("--repo-root", entry.name);
              break;
            }
          } catch {}
        }
      }
    } catch {}
  }
  return flags;
}

async function runFinalize(flags: string[]): Promise<FinalizeResult> {
  const proc = Bun.spawnSync([
    "bun",
    archifyBin,
    "finalize",
    type,
    candidatePath,
    outputPath,
    "--json",
    ...flags,
  ]);

  const stdout = proc.stdout.toString();
  try {
    return JSON.parse(stdout) as FinalizeResult;
  } catch {
    return { ok: false, status: "error", error: proc.stderr.toString() || stdout };
  }
}

async function main(): Promise<void> {
  const rawJson = await Bun.file(resolvedCandidate).text();
  let candidate: SequenceCandidate = JSON.parse(rawJson);
  const effectiveFlags = resolveRepoFlags(candidate);

  const MAX_PASSES = 4;
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const result = await runFinalize(effectiveFlags);
    if (result.ok) {
      console.log(`⚡ [archify-autofix] Pass ${pass}: Finalize converged successfully via Bun!`);
      process.exit(0);
    }

    const diagnostics = result.diagnostics ?? [];
    const fixes: string[] = [];
    let hasLayoutConstraint = false;

    for (const d of diagnostics) {
      if (Array.isArray(d.supportedFixes)) {
        fixes.push(...d.supportedFixes);
      }
      if (
        d.code === "layout/constraint" ||
        d.code?.startsWith("sequence/") ||
        d.code?.includes("clearance") ||
        d.code?.includes("collision") ||
        d.code?.includes("overlap")
      ) {
        hasLayoutConstraint = true;
      }
    }

    const currentCandidateText = await Bun.file(resolvedCandidate).text();
    candidate = JSON.parse(currentCandidateText);
    let modified = false;

    const setFixes = fixes.filter(f => f.startsWith("set "));
    if (setFixes.length > 0) {
      for (const fix of setFixes) {
        const m = fix.match(/^set\s+(\S+)\s+to\s+(.+)$/);
        if (m) {
          const [, pointer, rawVal] = m;
          applyJsonPointer(candidate as unknown as Record<string, unknown>, pointer, rawVal);
          modified = true;
        }
      }
    }

    if (!modified && hasLayoutConstraint && type === "sequence") {
      console.log(`⚡ [archify-autofix] Applying Bun-native sequence auto-spacing...`);
      modified = autoSpaceSequence(candidate);
    }

    if (!modified) {
      console.error(`[archify-autofix] Pass ${pass}: Cannot automatically converge. Diagnostics:`, diagnostics);
      process.exit(1);
    }

    await Bun.write(resolvedCandidate, JSON.stringify(candidate, null, 2) + "\n");
    console.log(`⚡ [archify-autofix] Updated ${candidatePath}`);
  }

  console.error(`[archify-autofix] Exhausted ${MAX_PASSES} repair passes without convergence.`);
  process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
