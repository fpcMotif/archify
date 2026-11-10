import { parse, parseFragment } from 'parse5';
import { SaxesParser } from 'saxes';

export interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  sourceCodeLocation?: { startOffset: number; endOffset: number } | null;
}

export interface ExtractedSvgs {
  direct: string[];
  embedded: string[];
}

function visit(node: HtmlNode, callback: (node: HtmlNode, insideSvg: boolean) => void, insideSvg = false): void {
  callback(node, insideSvg);
  const childInsideSvg = insideSvg || node.tagName === 'svg';
  for (const child of node.childNodes || []) visit(child, callback, childInsideSvg);
  if (node.content) visit(node.content, callback, childInsideSvg);
}

export function parseXml(source: string): SaxesParser {
  return new SaxesParser({ xmlns: true }).write(source).close();
}

export function extractSvgs(markup: string, fragment = false): ExtractedSvgs {
  const document: HtmlNode = fragment
    ? parseFragment(markup, { sourceCodeLocationInfo: true })
    : parse(markup, { sourceCodeLocationInfo: true });
  const direct: string[] = [];
  const srcdocs: string[] = [];

  visit(document, (node, insideSvg) => {
    if (node.tagName === 'svg' && !insideSvg && node.sourceCodeLocation) {
      direct.push(markup.slice(node.sourceCodeLocation.startOffset, node.sourceCodeLocation.endOffset));
    }
    const srcdoc = node.attrs?.find((attribute) => attribute.name === 'srcdoc');
    if (srcdoc) srcdocs.push(srcdoc.value);
  });

  return {
    direct,
    embedded: srcdocs.flatMap((srcdoc) => {
      const nested = extractSvgs(srcdoc, true);
      return [...nested.direct, ...nested.embedded];
    }),
  };
}
