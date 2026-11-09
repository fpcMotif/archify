import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from './diagnostics.ts';

export type Translations = Readonly<Record<string, unknown>>;
export type MessageCatalog = Readonly<Record<string, string>>;
export type MessageValues = Readonly<Record<string, unknown>>;

interface CatalogEntry {
  locale: string;
  file: string;
}

interface BundledCatalog {
  usable: Map<string, string>;
  messages: MessageCatalog;
}

interface DocumentCatalog {
  locale: string;
  messages: MessageCatalog;
}

export interface PlaceholderMismatch {
  key: string;
  expected: string[];
  actual: string[] | null;
}

interface ClassifiedTranslations {
  supplied: string[];
  usable: Map<string, string>;
  unknownKeys: string[];
  placeholderMismatches: PlaceholderMismatch[];
}

export interface TranslationValidation {
  totalKeys: number;
  coveredKeys: number;
  coverage: number;
  missingKeys: string[];
  unknownKeys: string[];
  placeholderMismatches: PlaceholderMismatch[];
}

export interface LocaleReport {
  locale: string | null;
  resolvedLocale: string;
  bundledLocale: string | null;
  fallback: boolean;
  totalKeys: number;
  translatedKeys: number;
  coverage: number;
  fallbackKeys: string[];
  override: {
    suppliedKeys: number;
    appliedKeys: number;
    unknownKeys: string[];
    placeholderMismatches: PlaceholderMismatch[];
  };
}

export interface ResolvedCatalog {
  messages: MessageCatalog;
  report: LocaleReport;
}

export interface LocaleMeta {
  locale?: string | null;
  translations?: Translations | null;
}

export const DEFAULT_LOCALE = 'en';

const ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPE_MAP[character]);
}

// Bundled catalogs are package data, not renderer code. locales/manifest.json
// enrolls the catalogs meta.locale selects automatically; only listed files
// are read, relative to this installed package and never from the working
// directory, home, environment, or network. Adding a language changes data
// only. en.json defines the canonical keys and the final fallback.
const LOCALES_DIR = new URL('../../locales/', import.meta.url);
// Mirrors common.schema.json#/$defs/locale.
const LOCALE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const CATALOG_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

function readLocaleData(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(fileURLToPath(new URL(file, LOCALES_DIR)), 'utf8'));
  } catch (error) {
    throw new Error(`Schematics locale data ${JSON.stringify(file)} could not be loaded: ${(error as Error).message}`);
  }
}

function loadManifest(): Map<string, CatalogEntry> {
  const catalogs = (readLocaleData('manifest.json') as { catalogs?: unknown } | null | undefined)?.catalogs;
  if (!Array.isArray(catalogs)) throw new Error('Schematics locale manifest must list catalogs');
  const byKey = new Map<string, CatalogEntry>();
  for (const entry of catalogs as unknown[]) {
    const { locale, file } = (entry || {}) as { locale?: unknown; file?: unknown };
    if (typeof locale !== 'string' || locale.length > 35 || !LOCALE_TAG.test(locale)) {
      throw new Error(`Schematics locale manifest has an invalid locale tag ${JSON.stringify(locale)}`);
    }
    if (typeof file !== 'string' || !CATALOG_FILE.test(file)) {
      throw new Error(`Schematics locale manifest has an invalid catalog file for ${locale}`);
    }
    // Tags match case-insensitively, so two entries differing only in case
    // would make selection ambiguous.
    const key = locale.toLowerCase();
    if (byKey.has(key)) throw new Error(`Schematics locale manifest lists ${locale} more than once`);
    byKey.set(key, { locale, file });
  }
  if (byKey.get(DEFAULT_LOCALE)?.locale !== DEFAULT_LOCALE) {
    throw new Error(`Schematics locale manifest must enroll the ${DEFAULT_LOCALE} source catalog`);
  }
  return byKey;
}

const MANIFEST = loadManifest();

export const SUPPORTED_LOCALES = Object.freeze([...MANIFEST.values()].map(({ locale }) => locale));

const EN: MessageCatalog = Object.freeze(readLocaleData(MANIFEST.get(DEFAULT_LOCALE)!.file) as Record<string, string>);
for (const [key, message] of Object.entries(EN)) {
  if (typeof message !== 'string' || message.length === 0) {
    throw new Error(`Schematics source message ${JSON.stringify(key)} must be a non-empty string`);
  }
}

const CANONICAL_KEYS = Object.keys(EN);
const PLACEHOLDER_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;

function extractPlaceholders(message: unknown): Set<string> {
  return new Set([...String(message).matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]));
}

const CANONICAL_PLACEHOLDERS = Object.fromEntries(
  CANONICAL_KEYS.map((key) => [key, extractPlaceholders(EN[key])]),
);

function placeholdersMatch(expected: Set<string>, actual: Set<string>): boolean {
  if (expected.size !== actual.size) return false;
  for (const token of expected) if (!actual.has(token)) return false;
  return true;
}

// Splits translation data into the entries that can replace a canonical
// message and the ones that cannot. Rejected entries never replace a valid
// lower-priority message.
function classifyTranslations(translations: Translations | null | undefined): ClassifiedTranslations {
  const supplied = Object.keys(translations || {});
  const usable = new Map<string, string>();
  const unknownKeys: string[] = [];
  const placeholderMismatches: PlaceholderMismatch[] = [];
  for (const key of supplied) {
    if (!Object.hasOwn(CANONICAL_PLACEHOLDERS, key)) {
      unknownKeys.push(key);
      continue;
    }
    const value = translations![key];
    const expected = [...CANONICAL_PLACEHOLDERS[key]].sort();
    if (typeof value !== 'string' || value.length === 0) {
      placeholderMismatches.push({ key, expected, actual: null });
      continue;
    }
    const actual = extractPlaceholders(value);
    if (placeholdersMatch(CANONICAL_PLACEHOLDERS[key], actual)) {
      usable.set(key, value);
    } else {
      placeholderMismatches.push({ key, expected, actual: [...actual].sort() });
    }
  }
  return { supplied, usable, unknownKeys, placeholderMismatches };
}

// Validates caller-supplied translation data against the canonical (English)
// message-key set. Pure and side-effect free; coverage here describes only the
// supplied data. resolveCatalog() reports the final resolved coverage.
export function validateTranslations(translations: Translations | null | undefined = {}): TranslationValidation {
  const { usable, unknownKeys, placeholderMismatches } = classifyTranslations(translations);
  return {
    totalKeys: CANONICAL_KEYS.length,
    coveredKeys: usable.size,
    coverage: CANONICAL_KEYS.length ? usable.size / CANONICAL_KEYS.length : 1,
    missingKeys: CANONICAL_KEYS.filter((key) => !Object.hasOwn(translations || {}, key)),
    unknownKeys,
    placeholderMismatches,
  };
}

export function bundledLocaleFor(locale: unknown): string | null {
  if (typeof locale !== 'string') return null;
  return MANIFEST.get(locale.toLowerCase())?.locale || null;
}

function isEnglishTag(locale: string): boolean {
  const key = locale.toLowerCase();
  return key === DEFAULT_LOCALE || key.startsWith(`${DEFAULT_LOCALE}-`);
}

// Bundled catalogs load on first use and stay immutable; a diagram's
// overrides are layered onto a copy.
const BUNDLED_CATALOGS = new Map<string, BundledCatalog>([[DEFAULT_LOCALE, { usable: new Map(Object.entries(EN)), messages: EN }]]);

function bundledCatalog(locale: string): BundledCatalog {
  if (!BUNDLED_CATALOGS.has(locale)) {
    const { usable } = classifyTranslations(readLocaleData(MANIFEST.get(locale.toLowerCase())!.file) as Translations);
    const messages = Object.freeze(Object.fromEntries(
      CANONICAL_KEYS.map((key) => [key, usable.get(key) ?? EN[key]]),
    ));
    BUNDLED_CATALOGS.set(locale, { usable, messages });
  }
  return BUNDLED_CATALOGS.get(locale)!;
}

// Resolves each canonical message as: valid meta.translations value →
// selected bundled-catalog value → English source. Pure; returns the resolved
// catalog with a report that separates rejected overrides from real English
// fallback gaps. Omitted or empty translations mean no override. A tag with
// neither a bundled catalog nor a usable override falls back to English UI
// and language metadata.
export function resolveCatalog(locale: string | null | undefined, translations: Translations | null | undefined = undefined): ResolvedCatalog {
  const override = classifyTranslations(translations);
  const bundledLocale = bundledLocaleFor(locale);
  const fallback = Boolean(locale) && !bundledLocale && override.usable.size === 0;
  const resolvedLocale = !locale || fallback ? DEFAULT_LOCALE : bundledLocale || locale;
  const bundled = bundledLocale ? bundledCatalog(bundledLocale) : null;
  const english = isEnglishTag(resolvedLocale);
  const messages: Record<string, string> = {};
  const fallbackKeys: string[] = [];
  for (const key of CANONICAL_KEYS) {
    if (override.usable.has(key)) {
      messages[key] = override.usable.get(key)!;
    } else if (bundled?.usable.has(key)) {
      messages[key] = bundled.usable.get(key)!;
    } else {
      messages[key] = EN[key];
      if (!english) fallbackKeys.push(key);
    }
  }
  const translatedKeys = english ? CANONICAL_KEYS.length : CANONICAL_KEYS.length - fallbackKeys.length;
  return {
    messages: Object.freeze(messages),
    report: {
      locale: locale || null,
      resolvedLocale,
      bundledLocale,
      fallback,
      totalKeys: CANONICAL_KEYS.length,
      translatedKeys,
      coverage: CANONICAL_KEYS.length ? translatedKeys / CANONICAL_KEYS.length : 1,
      fallbackKeys,
      override: {
        suppliedKeys: override.supplied.length,
        appliedKeys: override.usable.size,
        unknownKeys: override.unknownKeys,
        placeholderMismatches: override.placeholderMismatches,
      },
    },
  };
}

// Per-document catalogs installed by registerLocale(). Tags are
// case-insensitive, so the key is lowercased: renderers may pass the authored
// meta.locale (zh-cn) or its resolved tag (zh-CN) and reach the same document
// catalog. They never mutate a bundled catalog.
const DOCUMENT_CATALOGS = new Map<unknown, DocumentCatalog>();

function documentKey(locale: unknown): unknown {
  return typeof locale === 'string' ? locale.toLowerCase() : locale;
}

function catalogFor(locale: unknown): DocumentCatalog | null {
  const key = documentKey(locale);
  if (DOCUMENT_CATALOGS.has(key)) return DOCUMENT_CATALOGS.get(key)!;
  const bundledLocale = bundledLocaleFor(locale);
  return bundledLocale ? { locale: bundledLocale, messages: bundledCatalog(bundledLocale).messages } : null;
}

// Installs the resolved catalog for one authored locale and returns its
// report. Re-registering the same tag replaces the previous document's
// overrides; a fallback clears them.
export function registerLocale(locale: string | null | undefined, translations: Translations | null | undefined = undefined): LocaleReport {
  const { messages, report } = resolveCatalog(locale, translations);
  if (report.fallback || !locale) {
    DOCUMENT_CATALOGS.delete(documentKey(locale));
  } else {
    DOCUMENT_CATALOGS.set(documentKey(locale), { locale: report.resolvedLocale, messages });
  }
  return report;
}

// Agent-facing warnings for one document's meta.locale/meta.translations.
// Pure, so the renderer and the CLI receipts (validate/deliver/finalize)
// report the same diagnostics from the same input.
export function localeDiagnostics(diagramType: unknown, meta: LocaleMeta | null | undefined): Diagnostic[] {
  const locale = meta?.locale;
  if (!locale) return [];
  const report = resolveCatalog(locale, meta!.translations).report;
  const diagnostics: Diagnostic[] = [];
  const { unknownKeys, placeholderMismatches, appliedKeys } = report.override;
  const rejected = unknownKeys.length + placeholderMismatches.length;
  if (rejected) {
    const kept = report.bundledLocale ? `bundled ${report.bundledLocale} message` : 'English message';
    diagnostics.push({
      code: 'i18n/invalid-translation',
      severity: 'warning',
      message: `meta.translations for locale ${JSON.stringify(locale)} has ${rejected} unusable ${rejected === 1 ? 'entry' : 'entries'} (${unknownKeys.length} unknown, ${placeholderMismatches.length} placeholder mismatch); each keeps its ${kept}.`,
      subject: { diagramType, path: '/meta/translations' },
      evidence: {
        locale,
        unknownKeys: unknownKeys.slice(0, 10),
        unknownKeysTotal: unknownKeys.length,
        placeholderMismatches: placeholderMismatches.slice(0, 10),
        placeholderMismatchesTotal: placeholderMismatches.length,
      },
      supportedFixes: ['Remove each unknown key or rename it to a canonical message key.', 'Use exactly the {placeholders} of the English source string for each mismatched key.'],
    });
  }
  if (report.fallback) {
    diagnostics.push({
      code: 'i18n/locale-fallback',
      severity: 'warning',
      message: `meta.locale ${JSON.stringify(locale)} has no bundled catalog and no usable meta.translations; the Viewer chrome and <html lang> fall back to English.`,
      subject: { diagramType, path: '/meta/locale' },
      evidence: { locale, bundledLocales: SUPPORTED_LOCALES },
      supportedFixes: ['Supply meta.translations for this locale.', `Use a bundled locale: ${SUPPORTED_LOCALES.join(', ')}.`],
    });
  } else if (report.fallbackKeys.length) {
    const source = [
      report.bundledLocale && `the bundled ${report.bundledLocale} catalog`,
      appliedKeys && `${appliedKeys} meta.translations ${appliedKeys === 1 ? 'entry' : 'entries'}`,
    ].filter(Boolean).join(' and ');
    const missingKeys = report.fallbackKeys.slice(0, 10);
    diagnostics.push({
      code: 'i18n/translation-coverage',
      severity: 'warning',
      message: `meta.locale ${JSON.stringify(locale)} resolves ${report.translatedKeys}/${report.totalKeys} renderer-owned messages (${Math.floor(report.coverage * 100)}%) from ${source}; ${report.fallbackKeys.length} fall back to English.`,
      subject: { diagramType, path: '/meta/translations' },
      evidence: {
        locale,
        resolvedLocale: report.resolvedLocale,
        bundledLocale: report.bundledLocale,
        translatedKeys: report.translatedKeys,
        totalKeys: report.totalKeys,
        appliedOverrideKeys: appliedKeys,
        missingKeys,
        missingKeysTotal: report.fallbackKeys.length,
        // English source for the listed gaps, so a caller can translate
        // exactly those keys without re-reading the whole catalog.
        englishSource: Object.fromEntries(missingKeys.map((key) => [key, EN[key]])),
      },
      supportedFixes: ['Add each missing key to meta.translations, translating its English source string and keeping its {placeholders}.'],
    });
  }
  return diagnostics;
}

export function resolveLocale(locale: unknown): string {
  return catalogFor(locale)?.locale || DEFAULT_LOCALE;
}

export function formatMessage(template: unknown, values: MessageValues = {}): string {
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match: string, key: string) => (
    Object.hasOwn(values, key) ? String(values[key]) : match
  ));
}

export function translateMessage(locale: unknown, key: string, values: MessageValues = {}): string {
  const catalog = catalogFor(locale)?.messages || EN;
  if (!Object.hasOwn(catalog, key)) {
    throw new Error(`Missing Schematics i18n message ${JSON.stringify(key)} for ${resolveLocale(locale)}`);
  }
  return formatMessage(catalog[key], values);
}

export function translateCount(locale: unknown, key: string, count: number, values: MessageValues = {}): string {
  const suffix = count === 1 ? 'one' : 'other';
  return translateMessage(locale, `${key}.${suffix}`, { ...values, count });
}

export function viewerCatalog(locale: unknown): Record<string, string> {
  const messages = catalogFor(locale)?.messages || EN;
  return Object.fromEntries(Object.entries(messages).filter(([key]) => key.startsWith('viewer.')));
}

export function localizeTemplate(template: string, locale: unknown): string {
  return template.replace(/\{\{i18n:([a-zA-Z0-9_.-]+)\}\}/g, (_match, key) => escapeHtml(translateMessage(locale, key)));
}

export function catalogKeys(): string[] {
  return [...CANONICAL_KEYS];
}
