#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ratchetPath = "scripts/mjs-ratchet.txt";
const update = process.argv.includes("--update");

const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", "*.mjs"]);
if (listed.exitCode !== 0) {
  console.error(`mjs ratchet: git ls-files failed: ${listed.stderr.toString()}`);
  process.exit(2);
}
const present = listed.stdout
  .toString()
  .split("\n")
  .filter((path) => path !== "" && existsSync(path));
const presentSet = new Set(present);

if (!existsSync(ratchetPath)) {
  if (!update) {
    console.error(`mjs ratchet: ${ratchetPath} is missing. Run \`bun scripts/check-mjs-ratchet.ts --update\` once to create it.`);
    process.exit(1);
  }
  writeFileSync(ratchetPath, `${[...presentSet].sort().join("\n")}\n`);
  console.log(`mjs ratchet: created ${ratchetPath} with ${presentSet.size} paths.`);
  process.exit(0);
}

const allowed = readFileSync(ratchetPath, "utf8").split("\n").filter((path) => path !== "");
const allowedSet = new Set(allowed);
const added = [...presentSet].filter((path) => !allowedSet.has(path)).sort();
const converted = allowed.filter((path) => !presentSet.has(path));

if (update) {
  writeFileSync(ratchetPath, `${allowed.filter((path) => presentSet.has(path)).join("\n")}\n`);
  console.log(`mjs ratchet: removed ${converted.length} converted paths. ${allowed.length - converted.length} .mjs files remain.`);
}

if (added.length > 0) {
  console.error("mjs ratchet: new .mjs files. Write them as Bun TypeScript (.ts) instead (docs/adr/0001-bun-typescript-runtime.md):");
  for (const path of added) console.error(`  ${path}`);
  process.exit(1);
}
if (converted.length > 0 && !update) {
  console.error("mjs ratchet: these .mjs files are gone. Run `bun scripts/check-mjs-ratchet.ts --update` to tighten the ratchet:");
  for (const path of converted) console.error(`  ${path}`);
  process.exit(1);
}
if (!update) console.log(`mjs ratchet: ${allowed.length} .mjs files left to convert to Bun TypeScript.`);
