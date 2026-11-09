#!/usr/bin/env bun

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as simpleIcons from 'simple-icons';
import type { SimpleIcon } from 'simple-icons';

interface CatalogCustomMark {
  viewBox?: number;
  hex?: string;
  path?: string;
  source?: string;
  guidelines?: string;
}

interface CatalogEntry {
  id?: string;
  title?: string;
  category?: string;
  aliases?: unknown;
  domains?: unknown;
  simpleIcon?: string;
  custom?: CatalogCustomMark;
}

interface BrandCatalog {
  schemaVersion?: unknown;
  marks?: unknown;
}

interface GeneratedProvenance {
  provider: string;
  providerVersion?: string;
  source: string | undefined;
  guidelines?: string;
  license?: SimpleIcon['license'];
}

interface GeneratedMark {
  id: string;
  title: string | undefined;
  category: string | undefined;
  aliases: string[];
  domains: string[];
  viewBox: number;
  hex: string;
  path: string;
  provenance: GeneratedProvenance;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const catalogPath = path.join(root, 'brand-marks', 'catalog.json');
const outputPath = path.join(root, 'packages', 'svg', 'generated-brand-marks.ts');
const catalog: BrandCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const simpleIconsVersion: string = JSON.parse(fs.readFileSync(
  path.join(root, 'node_modules', 'simple-icons', 'package.json'),
  'utf8',
)).version;
const simpleBySlug = new Map<string, SimpleIcon>(Object.values(simpleIcons)
  .filter((icon: unknown): icon is SimpleIcon => isSimpleIcon(icon))
  .map((icon) => [icon.slug, icon]));

function isSimpleIcon(icon: unknown): icon is SimpleIcon {
  return Boolean(icon && typeof icon === 'object' && 'slug' in icon && icon.slug && 'path' in icon && icon.path);
}

function normalizedList(value: unknown): string[] {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item: unknown) => String(item).trim())
    .filter(Boolean))];
}

function lookupForms(value: unknown): string[] {
  const raw = String(value ?? '').trim().toLocaleLowerCase('en-US');
  if (!raw) return [];
  return [...new Set([
    raw,
    raw.replace(/[\s_]+/g, '-'),
    raw.replace(/[\s_.-]+/g, ''),
  ])];
}

function fail(message: string): never {
  console.error(`brand catalog: ${message}`);
  process.exit(1);
}

function catalogMarks(value: BrandCatalog): CatalogEntry[] {
  if (value.schemaVersion !== 1 || !Array.isArray(value.marks) || value.marks.length === 0) {
    fail('catalog.json must contain a non-empty schemaVersion 1 marks array');
  }
  return value.marks;
}

const ids = new Set<string>();
const lookupKeys = new Map<string, string>();
const domains = new Map<string, string>();
const generated = catalogMarks(catalog).map((entry, index) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id || '')) fail(`marks[${index}] has an invalid id`);
  const id = entry.id ?? '';
  if (ids.has(id)) fail(`duplicate id ${id}`);
  ids.add(id);

  const aliases = normalizedList(entry.aliases);
  const entryDomains = normalizedList(entry.domains).map((domain) => domain.toLowerCase());
  for (const key of [id, ...aliases]) {
    for (const form of lookupForms(key)) {
      if (lookupKeys.has(form) && lookupKeys.get(form) !== id) {
        fail(`lookup key ${JSON.stringify(key)} is shared by ${lookupKeys.get(form)} and ${id}`);
      }
      lookupKeys.set(form, id);
    }
  }
  for (const domain of entryDomains) {
    if (domains.has(domain) && domains.get(domain) !== id) {
      fail(`domain ${domain} is shared by ${domains.get(domain)} and ${id}`);
    }
    domains.set(domain, id);
  }

  let mark: GeneratedMark;
  if (entry.simpleIcon) {
    const icon = simpleBySlug.get(entry.simpleIcon);
    if (!icon) fail(`${id} references missing Simple Icons slug ${entry.simpleIcon}`);
    mark = {
      id,
      title: entry.title || icon.title,
      category: entry.category,
      aliases,
      domains: entryDomains,
      viewBox: 24,
      hex: icon.hex,
      path: icon.path,
      provenance: {
        provider: 'Simple Icons',
        providerVersion: simpleIconsVersion,
        source: icon.source,
        ...(icon.guidelines ? { guidelines: icon.guidelines } : {}),
        ...(icon.license ? { license: icon.license } : {}),
      },
    };
  } else if (entry.custom) {
    const custom = entry.custom;
    if (!entry.title || !custom.path || !custom.source || !/^[0-9A-F]{6}$/i.test(custom.hex || '')) {
      fail(`${id} custom mark requires title, path, source, and six-digit hex`);
    }
    mark = {
      id,
      title: entry.title,
      category: entry.category,
      aliases,
      domains: entryDomains,
      viewBox: custom.viewBox || 24,
      hex: (custom.hex ?? '').toUpperCase(),
      path: custom.path,
      provenance: {
        provider: 'Official brand asset',
        source: custom.source,
        ...(custom.guidelines ? { guidelines: custom.guidelines } : {}),
      },
    };
  } else {
    fail(`${id} must provide simpleIcon or custom`);
  }
  if (!mark.category || !mark.title) fail(`${id} is missing category or title`);
  for (const form of lookupForms(mark.title)) {
    if (lookupKeys.has(form) && lookupKeys.get(form) !== id) {
      fail(`title ${JSON.stringify(mark.title)} is shared by ${lookupKeys.get(form)} and ${id}`);
    }
    lookupKeys.set(form, id);
  }
  return mark;
}).sort((left, right) => left.id.localeCompare(right.id));

const banner = `// Generated by scripts/generate-brand-marks.ts from brand-marks/catalog.json.\n// Simple Icons ${simpleIconsVersion}. Do not edit by hand.\n`;
const source = `${banner}export interface BrandMarkProvenance {
  provider: string;
  providerVersion?: string;
  source: string;
  guidelines?: string;
  license?: { type: string; url: string };
}

export interface BrandMark {
  id: string;
  title: string;
  category: string;
  aliases: readonly string[];
  domains: readonly string[];
  viewBox: number;
  hex: string;
  path: string;
  provenance: BrandMarkProvenance;
}

export const BRAND_MARKS: readonly BrandMark[] = Object.freeze(${JSON.stringify(generated, null, 2)});\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, 'utf8').replace(/\r\n?/g, '\n')
    : '';
  if (current !== source) {
    console.error('generated brand marks are stale — run bun run generate:brand-marks');
    process.exit(1);
  }
} else {
  const temporary = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, source);
  fs.renameSync(temporary, outputPath);
  console.log(`generated ${path.relative(root, outputPath)} (${generated.length} marks)`);
}
