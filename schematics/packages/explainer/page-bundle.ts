import { gzipSync, gunzipSync } from 'node:zlib';

const field = (value: unknown, key: string): unknown => value === null || value === undefined ? undefined : Reflect.get(Object(value), key);

// The native Viewer HTML is needed only when a reader opens "Explore", so the page stores it
// gzip-compressed and the reader inflates it on demand. Keys keep their order, so the prepared
// bundle digest is computed and verified over the same unpacked JSON.
const swap = <T>(bundle: T, from: string, to: string, convert: (value: string) => string): T => {
  const preparedDiagrams = field(bundle, 'preparedDiagrams');
  const diagrams = field(preparedDiagrams, 'diagrams');
  if (!diagrams || typeof diagrams !== 'object') return bundle;
  return { ...bundle, preparedDiagrams: { ...Object(preparedDiagrams), diagrams: Object.fromEntries(Object.entries(diagrams).map(([id, child]: [string, unknown]) =>
    [id, child && typeof field(child, from) === 'string' ? Object.fromEntries(Object.entries(Object(child)).map(([key, value]) => key === from ? [to, convert(String(value))] : [key, value])) : child])) } };
};

export const packPageBundle = <T>(bundle: T): T => swap(bundle, 'html', 'htmlGzip', html => gzipSync(html, { level: 9 }).toString('base64'));

/** Accepts packed and older unpacked pages alike. */
export const unpackPageBundle = <T>(bundle: T): T => swap(bundle, 'htmlGzip', 'html', data => gunzipSync(Buffer.from(data, 'base64')).toString('utf8'));
