#!/usr/bin/env node
/**
 * scripts/archify-autofix.mjs
 * Executes `archify finalize` and automatically applies compiler-suggested
 * `supportedFixes` and deterministic sequence auto-spacing in-place.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const archifyBin = path.resolve(__dirname, "../archify/bin/archify.mjs");
const args = process.argv.slice(2);

if (args.length < 3) {
  console.error("Usage: node scripts/archify-autofix.mjs <type> <candidate.json> <output.html> [finalize-flags...]");
  process.exit(1);
}

const [type, candidatePath, outputPath, ...extraFlags] = args;
const resolvedCandidate = path.resolve(process.cwd(), candidatePath);

function applyPointer(obj, pointer, value) {
  const parts = pointer.replace(/^\//, "").split("/");
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in curr)) curr[key] = {};
    curr = curr[key];
  }
  const lastKey = parts[parts.length - 1];
  curr[lastKey] = typeof curr[lastKey] === "number" || !isNaN(Number(value)) ? Number(value) : value;
}

function autoSpaceSequence(candidate) {
  if (!Array.isArray(candidate.messages) || candidate.messages.length === 0) return false;
  let currentY = 165;
  for (let i = 0; i < candidate.messages.length; i++) {
    const msg = candidate.messages[i];
    msg.y = currentY;
    const hasNote = Boolean(msg.note);
    const noteLines = hasNote ? (msg.note.length > 25 ? 2 : 1) : 0;
    const step = hasNote ? 40 + noteLines * 18 : 38;
    currentY += step;
  }

  if (Array.isArray(candidate.segments) && candidate.segments.length > 0) {
    const totalMsgs = candidate.messages.length;
    const segCount = candidate.segments.length;
    const msgsPerSeg = Math.max(1, Math.round(totalMsgs / segCount));
    for (let s = 0; s < segCount; s++) {
      const startIdx = s * msgsPerSeg;
      const endIdx = s === segCount - 1 ? totalMsgs - 1 : Math.min(totalMsgs - 1, (s + 1) * msgsPerSeg - 1);
      const startY = candidate.messages[startIdx]?.y || 165;
      const endY = candidate.messages[endIdx]?.y || startY + 50;
      candidate.segments[s].from = Math.max(140, startY - 20);
      candidate.segments[s].to = endY + 25;
    }
  }

  if (Array.isArray(candidate.activations)) {
    for (const act of candidate.activations) {
      const msgs = candidate.messages.filter(m => m.from === act.participant || m.to === act.participant);
      if (msgs.length > 0) {
        act.from = msgs[0].y;
        act.to = msgs[msgs.length - 1].y;
      }
    }
  }
  return true;
}

function resolveFlags(candidate) {
  const flags = [...extraFlags];
  if (!flags.includes("--repo-root") && candidate.meta?.repository?.url) {
    const targetUrl = candidate.meta.repository.url.replace(/\.git$/, "").toLowerCase();
    const dirs = fs.readdirSync(process.cwd(), { withFileTypes: true });
    for (const d of dirs) {
      if (d.isDirectory()) {
        try {
          const res = spawnSync("git", ["-C", d.name, "remote", "get-url", "origin"], { encoding: "utf-8" });
          const origin = (res.stdout || "").trim().replace(/\.git$/, "").toLowerCase();
          if (origin && (origin === targetUrl || targetUrl.includes(origin) || origin.endsWith(targetUrl.split("/").slice(-2).join("/")))) {
            flags.push("--repo-root", d.name);
            break;
          }
        } catch {}
      }
    }
  }
  return flags;
}

function runFinalize(flags) {
  const res = spawnSync(
    process.execPath,
    [archifyBin, "finalize", type, candidatePath, outputPath, "--json", ...flags],
    { encoding: "utf-8" }
  );
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { ok: false, error: res.stderr || res.stdout };
  }
}

let candidate = JSON.parse(fs.readFileSync(resolvedCandidate, "utf-8"));
const effectiveFlags = resolveFlags(candidate);

const MAX_PASSES = 4;
for (let pass = 1; pass <= MAX_PASSES; pass++) {
  const result = runFinalize(effectiveFlags);
  if (result.ok) {
    console.log(`[archify-autofix] Pass ${pass}: Finalize succeeded!`);
    process.exit(0);
  }

  const diagnostics = result.diagnostics || [];
  const fixes = [];
  let hasLayoutConstraint = false;

  for (const d of diagnostics) {
    if (Array.isArray(d.supportedFixes)) {
      fixes.push(...d.supportedFixes);
    }
    if (d.code === "layout/constraint" || d.code?.startsWith("sequence/")) {
      hasLayoutConstraint = true;
    }
  }

  console.log(`[archify-autofix] Pass ${pass}: ${diagnostics.length} diagnostic(s) found.`);
  candidate = JSON.parse(fs.readFileSync(resolvedCandidate, "utf-8"));

  let modified = false;
  if (fixes.length > 0) {
    for (const fix of fixes) {
      const m = fix.match(/^set\s+(\S+)\s+to\s+(.+)$/);
      if (m) {
        const [, pointer, rawVal] = m;
        applyPointer(candidate, pointer, rawVal);
        modified = true;
      }
    }
  } else if (hasLayoutConstraint && type === "sequence") {
    console.log(`[archify-autofix] Applying deterministic sequence auto-spacing...`);
    modified = autoSpaceSequence(candidate);
  }

  if (!modified) {
    console.error(`[archify-autofix] Pass ${pass}: Cannot automatically converge. Diagnostics:`, diagnostics);
    process.exit(1);
  }

  fs.writeFileSync(resolvedCandidate, JSON.stringify(candidate, null, 2), "utf-8");
  console.log(`[archify-autofix] Updated ${candidatePath}`);
}

console.error(`[archify-autofix] Exhausted ${MAX_PASSES} repair passes without convergence.`);
process.exit(1);
