export function setFix(pointer, value, { label, note } = {}) {
  return { op: 'set', pointer, value, ...(label ? { label } : {}), ...(note ? { note } : {}) };
}

export function chooseFix(options) {
  return { op: 'choose', options: options.map((option) => (Array.isArray(option) ? option : [option])) };
}

export function adviseFix(text) {
  return { op: 'advise', text };
}

function isFix(value) {
  return Boolean(value) && typeof value === 'object' && ['set', 'choose', 'advise'].includes(value.op);
}

function formatValue(value) {
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`;
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

export function describeFix(fix) {
  if (typeof fix === 'string') return [fix];
  if (fix.op === 'set') return [`set ${fix.pointer} to ${fix.label ? `${fix.label} ` : ''}${formatValue(fix.value)}${fix.note ? ` ${fix.note}` : ''}`];
  if (fix.op === 'choose') return fix.options.flatMap((option) => option.flatMap(describeFix));
  return [fix.text];
}

export function fixFields(entries) {
  const supportedFixes = [];
  const edits = [];
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

function pointerTokens(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return null;
  return pointer.slice(1).split('/').map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function setAtPointer(document, pointer, value) {
  const tokens = pointerTokens(pointer);
  if (!tokens || !tokens.length) return `pointer ${JSON.stringify(pointer)} is not a JSON pointer into the candidate`;
  let parent = document;
  for (const token of tokens.slice(0, -1)) {
    const next = Array.isArray(parent) ? parent[Number(token)] : parent?.[token];
    if (!next || typeof next !== 'object') return `${pointer} has no existing parent in the candidate`;
    parent = next;
  }
  const last = tokens.at(-1);
  if (Array.isArray(parent)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) return `${pointer} is not an existing array item`;
    parent[index] = structuredClone(value);
  } else {
    parent[last] = structuredClone(value);
  }
  return null;
}

export function applyRepair(candidate, edits) {
  if (!Array.isArray(edits) || !edits.length) return { ok: false, reason: 'no edits' };
  if (edits.some((edit) => edit?.op !== 'set')) return { ok: false, reason: 'offers a choice for the agent' };
  const next = structuredClone(candidate);
  for (const edit of edits) {
    const reason = setAtPointer(next, edit.pointer, edit.value);
    if (reason) return { ok: false, reason };
  }
  return { ok: true, candidate: next };
}

export function applyRepairs(candidate, diagnostics) {
  let current = candidate;
  const applied = [];
  const skipped = [];
  const touched = new Set();
  for (const diagnostic of diagnostics || []) {
    if (diagnostic?.severity === 'warning') continue;
    const edits = diagnostic?.edits;
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
