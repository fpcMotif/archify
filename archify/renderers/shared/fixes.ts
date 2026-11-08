export interface SetFix {
  op: 'set';
  pointer: string;
  value: unknown;
  label?: string;
  note?: string;
}

export interface ChooseFix {
  op: 'choose';
  options: SetFix[][];
}

export interface AdviseFix {
  op: 'advise';
  text: string;
}

export type Fix = SetFix | ChooseFix | AdviseFix;

export interface FixLabels {
  label?: string;
  note?: string;
}

export interface SetEdit {
  op: 'set';
  pointer: string;
  value: unknown;
}

export interface ChooseEdit {
  op: 'choose';
  options: SetEdit[][];
}

export type FixEdit = SetEdit | ChooseEdit;

export interface FixFields {
  supportedFixes: string[];
  edits?: FixEdit[];
}

export interface RepairEdit {
  op?: unknown;
  pointer?: unknown;
  value?: unknown;
}

export interface RepairDiagnostic {
  code?: unknown;
  severity?: unknown;
  edits?: unknown;
}

export type RepairResult =
  | { ok: false; reason: string }
  | { ok: true; candidate: unknown };

export interface RepairSummary {
  candidate: unknown;
  applied: { code: unknown; edits: RepairEdit[] }[];
  skipped: { code: unknown; reason: string }[];
}

type JsonContainer = Record<string, unknown> | unknown[];

export function setFix(pointer: string, value: unknown, { label, note }: FixLabels = {}): SetFix {
  return { op: 'set', pointer, value, ...(label ? { label } : {}), ...(note ? { note } : {}) };
}

export function chooseFix(options: readonly (SetFix | SetFix[])[]): ChooseFix {
  return { op: 'choose', options: options.map((option) => (Array.isArray(option) ? option : [option])) };
}

export function adviseFix(text: string): AdviseFix {
  return { op: 'advise', text };
}

function isFix(value: unknown): value is Fix {
  return Boolean(value) && typeof value === 'object' && ['set', 'choose', 'advise'].includes((value as { op: string }).op);
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`;
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

export function describeFix(fix: Fix | string): string[] {
  if (typeof fix === 'string') return [fix];
  if (fix.op === 'set') return [`set ${fix.pointer} to ${fix.label ? `${fix.label} ` : ''}${formatValue(fix.value)}${fix.note ? ` ${fix.note}` : ''}`];
  if (fix.op === 'choose') return fix.options.flatMap((option) => option.flatMap(describeFix));
  return [fix.text];
}

export function fixFields(entries: readonly unknown[] | null | undefined): FixFields {
  const supportedFixes: string[] = [];
  const edits: FixEdit[] = [];
  for (const entry of entries || []) {
    if (!isFix(entry)) {
      supportedFixes.push(String(entry).trim());
      continue;
    }
    supportedFixes.push(...describeFix(entry));
    if (entry.op === 'set') edits.push({ op: 'set', pointer: entry.pointer, value: entry.value });
    if (entry.op === 'choose') {
      edits.push({ op: 'choose', options: entry.options.map((option) => option.map(({ pointer, value }) => ({ op: 'set', pointer, value }))) });
    }
  }
  return { supportedFixes: [...new Set(supportedFixes.filter(Boolean))], ...(edits.length ? { edits } : {}) };
}

function pointerTokens(pointer: unknown): string[] | null {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return null;
  return pointer.slice(1).split('/').map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function setAtPointer(document: unknown, pointer: unknown, value: unknown): string | null {
  const tokens = pointerTokens(pointer);
  if (!tokens || !tokens.length) return `pointer ${JSON.stringify(pointer)} is not a JSON pointer into the candidate`;
  let parent = document as JsonContainer;
  for (const token of tokens.slice(0, -1)) {
    const next = Array.isArray(parent) ? parent[Number(token)] : parent?.[token];
    if (!next || typeof next !== 'object') return `${pointer} has no existing parent in the candidate`;
    parent = next as JsonContainer;
  }
  const last = tokens.at(-1) as string;
  if (Array.isArray(parent)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) return `${pointer} is not an existing array item`;
    parent[index] = structuredClone(value);
  } else {
    parent[last] = structuredClone(value);
  }
  return null;
}

export function applyRepair(candidate: unknown, edits: readonly RepairEdit[] | null | undefined): RepairResult {
  if (!Array.isArray(edits) || !edits.length) return { ok: false, reason: 'no edits' };
  if (edits.some((edit) => edit?.op !== 'set')) return { ok: false, reason: 'offers a choice for the agent' };
  const next = structuredClone(candidate);
  for (const edit of edits) {
    const reason = setAtPointer(next, edit.pointer, edit.value);
    if (reason) return { ok: false, reason };
  }
  return { ok: true, candidate: next };
}

export function applyRepairs(candidate: unknown, diagnostics: readonly RepairDiagnostic[] | null | undefined): RepairSummary {
  let current = candidate;
  const applied: RepairSummary['applied'] = [];
  const skipped: RepairSummary['skipped'] = [];
  const touched = new Set<unknown>();
  for (const diagnostic of diagnostics || []) {
    if (diagnostic?.severity === 'warning') continue;
    const edits = diagnostic?.edits as RepairEdit[] | null | undefined;
    if (!Array.isArray(edits) || !edits.length) {
      skipped.push({ code: diagnostic?.code, reason: 'no edits' });
      continue;
    }
    const pointers = edits.filter((edit) => edit?.op === 'set').map((edit) => edit.pointer);
    if (pointers.some((pointer) => touched.has(pointer))) {
      skipped.push({ code: diagnostic.code, reason: 'edits a location another repair already changed in this pass' });
      continue;
    }
    const result = applyRepair(current, edits);
    if (!result.ok) {
      skipped.push({ code: diagnostic.code, reason: result.reason });
      continue;
    }
    current = result.candidate;
    for (const pointer of pointers) touched.add(pointer);
    applied.push({ code: diagnostic.code, edits });
  }
  return { candidate: current, applied, skipped };
}
