
const SIDECAR_STEM_NAMESPACE = /\.~schematics-[0-9a-f]{64}$/iu;

export interface BoundedSidecarStemOptions {
  force?: boolean;
  hashDomain?: string;
}

export function sidecarStemNeedsBounding(stem: string, suffixes: readonly string[]): boolean {
  const fits = (value: string) => value.length <= 255 && Buffer.byteLength(value, 'utf8') <= 255;
  return !suffixes.every((suffix) => fits(`${stem}${suffix}`));
}

export function boundedSidecarStem(
  stem: string,
  suffixes: readonly string[],
  { force = false, hashDomain }: BoundedSidecarStemOptions = {},
): string {
  if (!force && !sidecarStemNeedsBounding(stem, suffixes)
    && !SIDECAR_STEM_NAMESPACE.test(stem)) return stem;
  const hashInput = hashDomain ? `${hashDomain}\0${stem}` : stem;
  const marker = `.~schematics-${new Bun.CryptoHasher('sha256').update(hashInput).digest('hex')}`;
  const codePoints = [...stem];
  while (codePoints.length
    && sidecarStemNeedsBounding(`${codePoints.join('')}${marker}`, suffixes)) {
    codePoints.pop();
  }
  return `${codePoints.join('')}${marker}`;
}

export function sidecarStemFromComponent(component: string): {
  stem: string;
  options: BoundedSidecarStemOptions | undefined;
} {
  if (component.endsWith('.html')) {
    return {
      stem: component.slice(0, -'.html'.length),
      options: undefined,
    };
  }
  return {
    stem: component,
    options: { force: true, hashDomain: 'full-component' },
  };
}

export function isBoundedSidecarStem(stem: string): boolean {
  return SIDECAR_STEM_NAMESPACE.test(stem);
}
