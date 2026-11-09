import { createHash } from 'node:crypto';
import { compileExplainerDiagram } from './diagrams.ts';
import { errorDiagnostics, errorField } from './model.ts';
import type { ComparisonCell, Diagnostic, SourceLocation, SourceMap } from './model.ts';

export interface ParseOptions {
  inputPath?: string;
  output?: string;
}

export interface ParsedExplainer {
  document: unknown;
  sourceMap: SourceMap;
  format: 'json' | 'markdown';
  sourceText: string;
  diagnostics: Diagnostic[];
}

interface DraftRow { cells: string[]; line: number }
interface DraftComparisonRow { label: string; id?: string; cells: ComparisonCell[] }
interface DraftBlock {
  type: string;
  id?: string;
  diagramType?: string;
  rows?: DraftComparisonRow[];
  nodeSources?: Record<string, string>;
  [key: string]: unknown;
}
interface DraftPanel { id: string; title: string; span?: number; blocks: DraftBlock[] }
interface DraftSource { id: string; lines?: number[]; [key: string]: unknown }
interface DraftMeta {
  title?: string;
  id?: string;
  output?: string;
  quality_profile?: string;
  repository?: { url?: string; revision?: string; provider?: string; link_mode?: string };
  [key: string]: unknown;
}
interface DraftDocument {
  schema_version: number;
  diagram_type: string;
  meta: DraftMeta;
  answer: { summary: string; scope?: string; reasons?: string[] };
  panels: DraftPanel[];
  sources: DraftSource[];
}

const TYPES = new Set(['architecture','workflow','sequence','dataflow','lifecycle','erd','class','tree','timeline','waterfall']);
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const stable = (kind: string, value: string): string => `${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
const pointerKey = (value: unknown): string => String(value).replaceAll('~','~0').replaceAll('/','~1');
const csv = (value: string | undefined): string[] => value ? value.split(',').map(part => part.trim()).filter(Boolean) : [];
const rowLabel = (value: string): { label: string; id?: string } => {
  const match = value.match(/^(.*?)\s+\{#([^}\s]+)\}$/u);
  return match ? {label:match[1].trim(),id:match[2]} : {label:value};
};
const ROW_PROPERTIES: Readonly<Record<string, string | undefined>> = {facts:'entries',comparison:'rows',steps:'items',list:'items'};

/** Restricted author syntax; canonical JSON uses the same model and source locations.
 * Failures return document:null and repairable diagnostics; no partial document is delivered.
 * Source-map start/end values are offsets in the original JS string, not byte offsets.
 */
export function parseExplainer(sourceInput: unknown, { inputPath, output }: ParseOptions = {}): ParsedExplainer {
  if (typeof sourceInput !== 'string') throw new TypeError('Explainer input must be a string');
  const sourceText = sourceInput;
  // The CLI owns the destination directory. Authored meta.output stays portable.
  if (typeof output === 'string') output = output.split(/[\\/]/u).at(-1);
  const sourceMap: SourceMap = Object.create(null);
  const diagnostics: Diagnostic[] = [];
  const format = sourceText.trimStart().startsWith('{') || sourceText.trimStart().startsWith('[') ? 'json' : 'markdown';
  const starts = [0];
  for (let i = 0; i < sourceText.length; i++) if (sourceText[i] === '\n') starts.push(i + 1);
  const lines = sourceText.split('\n').map(line => line.replace(/\r$/, ''));
  function locate(start: number, end = start): SourceLocation {
    let lo = 0, hi = starts.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= start) lo = mid; else hi = mid; }
    return {line:lo + 1,column:start - starts[lo] + 1,start,end};
  }
  function map(pointer: string, value: unknown, descriptor: SourceLocation): void {
    sourceMap[pointer] = {...descriptor};
    if (Array.isArray(value)) value.forEach((entry,index) => map(`${pointer}/${index}`,entry,descriptor));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key,entry]) => map(`${pointer}/${pointerKey(key)}`,entry,descriptor));
  }
  function fail(line: number, component: string, reason: string, example: string, path = '/'): void {
    diagnostics.push({code:`explainer/parse-${component}`,severity:'error',message:reason,
      subject:{line,column:1,component,path,...(inputPath ? {input:inputPath} : {})},
      evidence:{reason,example},supportedFixes:[`Use the documented syntax, for example: ${example}`]});
  }
  function unsupported(text: string, line: number, component: string): void {
    if (/^\s*(?:>{1,}|#{3,}\s|(?:---|\*\*\*|___)\s*$|```|~~~|[-*+]\s+\[[ xX]\])/u.test(text)) fail(line,component,'This Markdown block is outside the restricted author grammar.','## What happens?\nA short paragraph.');
  }
  let parsedDocument: unknown;
  if (format === 'json') {
    try {
      parsedDocument = JSON.parse(sourceText);
      // Scan the already parsed JSON to preserve exact nested value locations and detect
      // duplicate keys, which JSON.parse silently overwrites. No eval or JSON rewriting.
      let pos = 0;
      const skip = (): void => { while (/\s/u.test(sourceText[pos] || '') && pos < sourceText.length) pos++; };
      const stringEnd = (): unknown => { const start = pos++; while (pos < sourceText.length) { const c = sourceText[pos++]; if (c === '\\') pos++; else if (c === '"') break; } return JSON.parse(sourceText.slice(start,pos)); };
      const scan = (pointer: string): void => {
        skip(); const start = pos;
        if (sourceText[pos] === '{') {
          pos++; skip(); const keys = new Set<unknown>();
          while (sourceText[pos] !== '}') {
            skip(); const keyStart = pos; const key = stringEnd();
            if (keys.has(key)) fail(locate(keyStart).line,'json','Duplicate JSON keys would discard authored content.','Use each object key once.',`${pointer}/${pointerKey(key)}`);
            keys.add(key); skip(); pos++; scan(`${pointer}/${pointerKey(key)}`); skip(); if (sourceText[pos] === ',') pos++; else break;
          }
          pos++;
        } else if (sourceText[pos] === '[') {
          pos++; skip(); let index = 0;
          while (sourceText[pos] !== ']') { scan(`${pointer}/${index++}`); skip(); if (sourceText[pos] === ',') pos++; else break; }
          pos++;
        } else if (sourceText[pos] === '"') stringEnd();
        else { while (pos < sourceText.length && !/[\s,\]}]/u.test(sourceText[pos])) pos++; }
        sourceMap[pointer] = locate(start,pos);
      };
      scan('');
      if (parsedDocument && !Array.isArray(parsedDocument) && typeof parsedDocument === 'object') {
        const meta = errorField(parsedDocument, 'meta');
        if (meta && typeof meta === 'object' && output) Reflect.set(meta, 'output', output);
      }
    } catch (error) {
      const match = String(errorField(error, 'message')).match(/position (\d+)/u);
      const lineMatch = String(errorField(error, 'message')).match(/line (\d+)/u);
      fail(match ? locate(Number(match[1])).line : Number(lineMatch?.[1] || 1),'json','Input is not valid JSON.','{"schema_version":1,"diagram_type":"explainer",...}');
    }
  } else {
    const document: DraftDocument = {schema_version:1,diagram_type:'explainer',meta:{},answer:{summary:''},panels:[],sources:[]};
    parsedDocument = document;
    let panel: DraftPanel | null = null, panelIndex = -1, titleSeen = false, answerSeen = false, reasonsAllowed = false, cursor = 0;
    const descriptor = (line: number, endLine = line + 1): SourceLocation => locate(starts[line] ?? sourceText.length, starts[endLine] ?? sourceText.length);
    const closePanel = (end: number): void => { if (panelIndex >= 0) sourceMap[`/panels/${panelIndex}`].end = end; };
    function heading(line: string, prefix: string): { title: string; id?: string; span?: number } {
      const match = line.slice(prefix.length).trim().match(/^(.*?)(?:\s+\{(?:#([^}\s]+))?(?:\s*span=(\d+))?\})?$/u);
      if (!match) throw new TypeError('Heading syntax did not match.');
      return {title:match[1].trim(),id:match[2],...(match[3]?{span:Number(match[3])}:{})};
    }
    function addBlock(block: DraftBlock, at: number, until: number, rows: readonly DraftRow[] = []): void {
      if (!panel) { fail(at + 1,block.type,'Blocks must follow a question panel heading.','## What should I know?'); return; }
      // A block named after its own panel points at the same place; keep both reachable instead of failing.
      // Diagrams keep their ID because node and route links name it.
      if (block.id && block.id === panel.id && block.type !== 'diagram') block.id = `${panel.id}-${block.type}`;
      block.id ||= stable(block.type,`${panel.id}\0${JSON.stringify(block)}`);
      if (block.type === 'comparison') for (const row of block.rows ?? []) row.id ||= stable('row', `${block.id}\0${row.label}`);
      const pointer = `/panels/${panelIndex}/blocks/${panel.blocks.length}`;
      panel.blocks.push(block); map(pointer,block,descriptor(at,until));
      const property = ROW_PROPERTIES[block.type];
      if (property) rows.forEach((row,index) => { const list = block[property]; if (Array.isArray(list) && list[index] !== undefined) map(`${pointer}/${property}/${index}`,list[index],descriptor(row.line,row.line+1)); });
    }
    function cells(raw: string, line: number): string[] {
      const trimmed = raw.trim();
      let value = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
      if (value.endsWith('|') && !/(^|[^\\])(\\\\)*\\\|$/u.test(value)) value = value.slice(0,-1);
      const result: string[] = []; let cell = '', code = false;
      for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (char === '\\' && ['|','\\'].includes(value[i+1])) { cell += value[++i]; continue; }
        if (char === '`') code = !code;
        if (char === '|' && !code) { result.push(cell.trim()); cell = ''; } else cell += char;
      }
      result.push(cell.trim());
      if (code) fail(line + 1,'rows','Unclosed inline code in a table row.','| label | `literal` |');
      return result;
    }
    function attributes(raw: string, line: number): { attrs: Record<string, string>; positional: string[] } {
      const attrs: Record<string, string> = Object.create(null), positional: string[] = []; let pos = 0;
      while (pos < raw.length) {
        while (/\s/u.test(raw[pos] || '') && pos < raw.length) pos++;
        if (pos >= raw.length) break;
        const token = raw.slice(pos).match(/^([^\s=]+)(=)?/u);
        if (!token) { fail(line + 1,'directive','Malformed directive arguments.','@metric label="Latency" value=12 unit=ms'); break; }
        const key = token[1]; pos += token[0].length;
        if (!token[2]) { positional.push(key); continue; }
        let value = '';
        if (raw[pos] === '"' || raw[pos] === "'") {
          const quote = raw[pos++]; let closed = false;
          while (pos < raw.length) { const c = raw[pos++]; if (c === quote) { closed = true; break; } if (c === '\\' && [quote,'\\'].includes(raw[pos])) value += raw[pos++]; else value += c; }
          if (!closed) fail(line + 1,'directive','Quoted directive value is not closed.','title="A short title"');
          if (pos < raw.length && !/\s/u.test(raw[pos])) fail(line+1,'directive','Arguments must be separated by whitespace.','label="Latency" value=12');
        } else { const start = pos; while (pos < raw.length && !/\s/u.test(raw[pos])) pos++; value = raw.slice(start,pos); }
        if (Object.hasOwn(attrs,key)) fail(line+1,'directive','Duplicate arguments would discard authored content.','Use each key once.');
        attrs[key] = value;
      }
      return {attrs,positional};
    }
    function rowWidth(rows: readonly DraftRow[], min: number, max: number, component: string): void {
      for (const row of rows) if (row.cells.length < min || row.cells.length > max) fail(row.line+1,component,`Expected ${min === max ? min : `${min}–${max}`} cells in this directive row.`,`| ${Array.from({length:min},(_,i)=>`field${i+1}`).join(' | ')} |`);
    }
    function boolean(value: string | undefined, at: number, component: string): boolean | undefined {
      if (value === undefined) return undefined;
      if (!['true','false'].includes(value)) fail(at+1,component,'Boolean arguments require true or false.','multiple=true');
      return value === 'true';
    }
    function number(value: string | undefined, at: number, component: string): number | undefined {
      if (value === undefined) return undefined;
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) || !Number.isFinite(Number(value))) fail(at+1,component,'Numeric arguments require a finite number.','value=12.5');
      return Number(value);
    }
    function select(attrs: Record<string, string>, keys: readonly string[]): Record<string, string> { return Object.fromEntries(keys.filter(key => attrs[key] !== undefined).map(key=>[key,attrs[key]])); }
    function directive(at: number): void {
      const match = lines[at].trim().match(/^@([a-z][a-z-]*)(?:\s+(.*))?$/u);
      if (!match) { fail(at+1,'directive','Malformed type directive.','@facts\n| key | value |'); cursor++; return; }
      let type = match[1]; const {attrs:a,positional} = attributes(match[2] || '',at);
      if (TYPES.has(type)) { positional.unshift(type); type='diagram'; }
      cursor = at + 1; const rows: DraftRow[]=[]; let literal: string | undefined;
      let literalStart: number | undefined;
      if (type === 'diff' && /^```diff\s*$/u.test(lines[cursor]?.trim() || '')) {
        cursor++; const begin=cursor; literalStart=begin; while (cursor<lines.length && lines[cursor].trim()!=='```') cursor++;
        if (cursor===lines.length) fail(at+1,'diff','The diff fence is not closed.','@diff\n```diff\n-old\n+new\n```');
        const end=starts[cursor] ?? sourceText.length;
        literal=sourceText.slice(starts[begin] ?? sourceText.length,end).replace(/\r?\n$/u,''); if (cursor<lines.length) cursor++;
      } else {
        // A directive row never starts with an empty cell; "|| id |" is a line-number prefix copied from a file viewer.
        while (cursor<lines.length && lines[cursor].trim() && !/^(?:#{1,2}\s|@)/u.test(lines[cursor].trim())) { rows.push({cells:cells(lines[cursor].replace(/^(\s*)\|\|(?=\s)/u,'$1|'),cursor),line:cursor}); cursor++; }
        // A callout with no rows takes the plain paragraph that follows it as its text.
        if (type==='callout' && !rows.length && a.text===undefined) {
          let next=cursor; while (next<lines.length && !lines[next].trim()) next++;
          const paragraph: DraftRow[]=[]; while (next<lines.length && lines[next].trim() && !/^(?:#{1,2}\s|@|\||[-*+]\s|\d+\.\s|```|~~~)/u.test(lines[next].trim())) { paragraph.push({cells:[lines[next].trim()],line:next}); next++; }
          if (paragraph.length) { rows.push(...paragraph); cursor=next; }
        }
      }
      const allowedByType: Readonly<Record<string, readonly string[] | undefined>> = {
        source:['title','url','path','lines','revision'],meta:['locale','quality_profile','style','repo_url','repo_revision','repo_provider','repo_link_mode'],answer:['scope'],
        prose:['id','text'],list:['id','ordered'],callout:['id','level','title','text'],facts:['id'],metric:['id','label','value','limit','unit','note','typical'],steps:['id'],diagram:['id','source','spec','title','changes'],code:['id','source','language'],diff:['id','caption'],image:['id','path','alt','caption'],comparison:['id','columns','label'],chart:['id','title','type','data','x','y','unit']
      };
      const allowed = allowedByType[type];
      if (!allowed) { fail(at+1,'directive',`Unsupported component @${type}.`,'@facts\n| key | value |'); return; }
      for (const key of Object.keys(a)) if (!allowed.includes(key)) fail(at+1,type,`Unsupported argument ${key}.`,`@${type} ${allowed.map(key=>`${key}=...`).join(' ')}`);
      if (!['source','diagram'].includes(type) && positional.length) fail(at+1,type,'This directive accepts key=value arguments only.',`@${type} id=stable-id`);
      if (['meta','answer'].includes(type) && rows.length) fail(rows[0].line+1,type,'This directive accepts header arguments only.','@meta locale=en quality_profile=showcase');
      if (type==='source') {
        if (positional.length!==1) fail(at+1,type,'Source declarations require an ID.','@source docs title="Documentation" url=https://example.com/docs');
        const source: DraftSource={id:positional[0],...select(a,['title','url','path','revision'])};
        if (a.lines!==undefined) { const range=a.lines.match(/^(\d+):(\d+)$/u); if (!range) fail(at+1,type,'Repository lines require start:end.','lines=10:20'); source.lines=range?[Number(range[1]),Number(range[2])]:[]; }
        if(rows.length) fail(at+1,type,'Source declarations do not accept rows.','@source demo title="Timing model"');
        const pointer=`/sources/${document.sources.length}`;document.sources.push(source);map(pointer,source,descriptor(at,cursor));return;
      }
      if (type==='meta') { Object.assign(document.meta,select(a,['locale','quality_profile','style'])); if(a.repo_url || a.repo_revision) document.meta.repository={url:a.repo_url,revision:a.repo_revision,...(a.repo_provider?{provider:a.repo_provider}:{}),...(a.repo_link_mode?{link_mode:a.repo_link_mode}:{})}; for(const key of ['locale','quality_profile','style','repository'])if(document.meta[key]!==undefined)map(`/meta/${key}`,document.meta[key],descriptor(at,cursor));return; }
      if (type==='answer') { if(a.scope!==undefined){document.answer.scope=a.scope;sourceMap['/answer/scope']=descriptor(at,cursor);}return; }
      let block: DraftBlock={type,...(a.id?{id:a.id}:{})};
      switch(type) {
        case 'prose': rowWidth(rows,1,1,type);block.text=a.text??rows.map(r=>r.cells[0]).join('\n');break;
        case 'list': rowWidth(rows,1,1,type);block.items=rows.map(r=>r.cells[0]);if(a.ordered!==undefined)block.ordered=boolean(a.ordered,at,type);break;
        case 'callout': rowWidth(rows,1,1,type);Object.assign(block,{level:a.level||'note',...select(a,['title']),text:a.text??rows.map(r=>r.cells[0]).join('\n')});break;
        case 'facts':rowWidth(rows,2,2,type);block.entries=rows.map(r=>({key:r.cells[0],value:r.cells[1]}));break;
        case 'metric':Object.assign(block,select(a,['label','unit','note']));for(const key of ['value','limit'])if(a[key]!==undefined)block[key]=number(a[key],at,type);if(a.typical!==undefined)block.typical=boolean(a.typical,at,type);break;
        case 'steps':rowWidth(rows,2,7,type);block.items=rows.map(r=>{let [id,text,detail,diagram,node,route,edges]=r.cells;if(node?.includes('~')&&!route){route=node;node='';}const target=diagram?{diagram,...(node?{node}:{}),...(route?{route:route.split('~')}:{}),...(edges?{edges:csv(edges)}:{})}:undefined;if(!diagram&&(node||route||edges))fail(r.line+1,type,'A step node, route or edge reference needs its diagram ID.','| step | Read cache | | cache-flow | redis | | |');return{id,text,...(detail?{detail}:{}),...(target?{target}:{})};});break;
        case 'diagram': {
          if(positional.length!==1)fail(at+1,type,'A diagram requires exactly one native type.','@diagram sequence source=cache.sequence.json');
          const diagramType=positional[0];
          block.diagramType=diagramType;
          if(a.source!==undefined)block.source=a.source;
          if(a.spec!==undefined) { try{block.spec=JSON.parse(a.spec);}catch{fail(at+1,type,'Inline diagram spec must be valid JSON.','@diagram sequence spec=\'{"schema_version":1,...}\'');} }
          if(rows.length&&(a.spec!==undefined||a.source!==undefined))fail(at+1,type,'Choose shorthand rows, spec or source, not several.','@diagram sequence source=cache.sequence.json');
          // A "source:<id>" cell ties that row's node to a declared source; the reader shows it on hover.
          for(const r of rows){const index=r.cells.findIndex(cell=>/^source:[A-Za-z][\w-]*$/u.test(cell));if(index<0)continue;const node=r.cells[0].replace(/^(?:actor|entity)\s+/u,'').trim();if(index>0&&!r.cells[0].includes('>'))(block.nodeSources||={})[node]=r.cells[index].slice(7);r.cells=r.cells.filter((_,i)=>i!==index);}
          if(rows.length&&a.spec===undefined&&a.source===undefined)try{block.spec=compileExplainerDiagram(diagramType,rows.map(r=>({cells:r.cells,line:r.line+1})),{id:a.id||stable('diagram',`${panel?.id}\0${JSON.stringify(rows.map(r=>r.cells))}`),title:a.title||panel?.title||document.meta.title,line:at+1,quality:document.meta.quality_profile});}catch(error){const found=errorDiagnostics(error)||errorDiagnostics(error,'diagnostics');if(found?.length)diagnostics.push(...found);else fail(at+1,type,'The diagram shorthand could not compile.','@diagram sequence source=cache.sequence.json');}
          if(a.changes!==undefined)block.changes=csv(a.changes).map(value=>{const [target,change]=value.split(':');return{target,change};});break;
        }
        case 'code':Object.assign(block,select(a,['source','language']));break;
        case 'diff':block.text=literal??rows.map(r=>r.cells.join(' | ')).join('\n');Object.assign(block,select(a,['caption']));break;
        case 'image':Object.assign(block,select(a,['path','alt','caption']));break;
        case 'chart':{if(!a.data||!a.x||!a.y)fail(at+1,type,'A data chart names its file, label column and value columns.','@chart type=bar data=latency.csv x=day y=p50,p99');if(a.type!==undefined&&!['bar','line','pie'].includes(a.type))fail(at+1,type,'A data chart is a bar, line or pie chart.','@chart type=line data=latency.csv x=day y=p99');Object.assign(block,select(a,['title']),{data:{path:a.data,kind:a.type||'bar',x:a.x,y:csv(a.y),...(a.unit?{unit:a.unit}:{})}});break;}
        case 'comparison':rowWidth(rows,2,500,type);if(a.label)block.labelColumn=a.label;block.columns=csv(a.columns);block.rows=rows.map(r=>({...rowLabel(r.cells[0]),cells:r.cells.slice(1).map(assessment)}));break;
      }
      if (['metric','code','image','chart'].includes(type)&&rows.length)fail(at+1,type,'This component accepts header arguments only.',`@${type} ${allowed.filter(k=>k!=='id').map(k=>`${k}=...`).join(' ')}`);
      if(type!=='diff')for(const row of rows)for(const text of row.cells)unsupported(text,row.line+1,type);
      addBlock(block,at,cursor,rows);
      if(type==='diff'&&panel) {
        const pointer=`/panels/${panelIndex}/blocks/${panel.blocks.length-1}/text`;
        sourceMap[pointer]=literalStart!==undefined?locate(starts[literalStart]??sourceText.length,(starts[literalStart]??sourceText.length)+(literal??'').length):descriptor(rows[0]?.line??at,cursor);
      }
    }
    function assessment(text: string): ComparisonCell {
      // Citations may follow the assessment; they stay with the cell text.
      const match = text.match(/^(.*?)\s*\{(good|caution|bad)(?::([^}]+))?\}((?:\s*\[[^\]]*\]\([^)\s]*\))*)\s*$/u);
      // A cell holding only a badge ({bad:Drop}) shows the badge; its label doubles as the cell text.
      return match?{text:`${match[1].trim()}${match[4].trim()}`||match[3]?.trim()||'',assessment:match[2],...(match[3]?{verdict:match[3].trim()}:{})}:{text};
    }
    while(cursor<lines.length) {
      const at=cursor, trimmed=lines[at].trim();
      if(!trimmed){cursor++;continue;}
      if(trimmed.startsWith('# ')) {
        if(titleSeen||panel)fail(at+1,'heading','Use one document title before all panels.','# What should we choose? {#choice}');
        const h=heading(trimmed,'# ');document.meta.title=h.title;document.meta.id=h.id||stable('explainer',h.title);titleSeen=true;map('/meta',document.meta,descriptor(at));cursor++;continue;
      }
      if(trimmed.startsWith('## ')) {
        closePanel(starts[at]);const h=heading(trimmed,'## ');panel={id:h.id||stable('panel',h.title),title:h.title,...(h.span!==undefined?{span:h.span}:{}),blocks:[]};panelIndex=document.panels.length;document.panels.push(panel);map(`/panels/${panelIndex}`,panel,descriptor(at,lines.length));cursor++;continue;
      }
      if(trimmed.startsWith('@')){reasonsAllowed=false;directive(at);continue;}
      const fence=trimmed.match(/^(```+|~~~+)\s*([A-Za-z0-9_+.#-]*)\s*(.*)$/u);
      if(fence) {
        reasonsAllowed=false;
        const {attrs:fa,positional:fp}=attributes(fence[3]||'',at);
        if(fp.length||Object.keys(fa).some(key=>key!=='title'))fail(at+1,'snippet','A code fence accepts a language and an optional title only.','```bash title="Run the tests"');
        cursor=at+1;const begin=cursor;while(cursor<lines.length&&lines[cursor].trim()!==fence[1])cursor++;
        if(cursor===lines.length)fail(at+1,'snippet','The code fence is not closed.','```bash\nnpm test\n```');
        const from=starts[begin]??sourceText.length,literal=sourceText.slice(from,starts[cursor]??sourceText.length).replace(/\r?\n$/u,'');
        if(cursor<lines.length)cursor++;
        if(!literal.trim()){fail(at+1,'snippet','A code fence needs content.','```bash\nnpm test\n```');continue;}
        const language=fence[2];
        addBlock(language==='diff'?{type:'diff',text:literal,...(fa.title?{caption:fa.title}:{})}:language==='mermaid'?{type:'chart',...(fa.title?{title:fa.title}:{}),text:literal}:{type:'snippet',...(language?{language}:{}),...(fa.title?{title:fa.title}:{}),text:literal},at,cursor);
        if(panel)sourceMap[`/panels/${panelIndex}/blocks/${panel.blocks.length-1}/text`]=locate(from,from+literal.length);
        continue;
      }
      if(trimmed.startsWith('|')) {
        const rows: DraftRow[]=[];while(cursor<lines.length&&lines[cursor].trim().startsWith('|')){rows.push({cells:cells(lines[cursor],cursor),line:cursor});cursor++;}
        if(rows.length<3||!rows[1].cells.every(cell=>/^:?-{3,}:?$/u.test(cell)))fail(at+1,'comparison','A Markdown table needs a header, separator and data rows.','| Criterion | A | B |\n| --- | --- | --- |\n| Cost | Low {good} | High {bad} |');
        const columns=rows[0]?.cells.slice(1)||[];const data=rows.slice(2);for(const r of data)if(r.cells.length!==columns.length+1)fail(r.line+1,'comparison','All table rows must match the header width.','| Cost | Low {good} | High {bad} |');
        addBlock({type:'comparison',...(rows[0]?.cells[0]?{labelColumn:rows[0].cells[0]}:{}),columns,rows:data.map(r=>({...rowLabel(r.cells[0]),cells:r.cells.slice(1).map(assessment)}))},at,cursor,data);continue;
      }
      const list=trimmed.match(/^(?:([-*+])|(\d+)\.)\s+(.+)$/u);
      if(list) {
        const rows: DraftRow[]=[];const ordered=Boolean(list[2]);while(cursor<lines.length){const found=lines[cursor].trim().match(/^(?:([-*+])|(\d+)\.)\s+(.+)$/u);if(!found||Boolean(found[2])!==ordered)break;if(/^\s{2,}/u.test(lines[cursor]))fail(cursor+1,'list','Nested lists are unsupported.','- One flat item');unsupported(found[3],cursor+1,'list');rows.push({cells:[found[3]],line:cursor});cursor++;}
        if(!panel){if(!reasonsAllowed||ordered||document.answer.reasons)fail(at+1,'answer','Use one flat unordered reason list after the conclusion.','A conclusion.\n\n- First reason\n- Second reason');document.answer.reasons=rows.map(r=>r.cells[0]);map('/answer/reasons',document.answer.reasons,descriptor(at,cursor));rows.forEach((r,i)=>map(`/answer/reasons/${i}`,r.cells[0],descriptor(r.line)));}else{const task=/^\[[ xX]\]\s+/u,tasks=rows.filter(r=>task.test(r.cells[0])).length;if(tasks&&(ordered||tasks<rows.length))fail(at+1,'list','Write every checklist item as "- [ ] item" in one unordered list.','- [ ] Check the deposit terms\n- [ ] Photograph the meter readings');addBlock({type:'list',ordered,...(tasks?{checklist:true}:{}),items:rows.map(r=>tasks?r.cells[0].replace(task,''):r.cells[0])},at,cursor,rows);}continue;
      }
      const chunks: string[]=[];while(cursor<lines.length&&lines[cursor].trim()&&!/^(?:#{1,2}\s|@|\||[-*+]\s|\d+\.\s|```|~~~)/u.test(lines[cursor].trim())){unsupported(lines[cursor],cursor+1,'prose');chunks.push(lines[cursor].trim());cursor++;}
      if(cursor===at){unsupported(trimmed,at+1,'prose');cursor++;continue;}
      const text=chunks.join('\n');
      if(!panel) {
        if(!titleSeen)fail(at+1,'answer','The document title must precede the short answer.','# A title\n\nA direct answer.');
        if(answerSeen)fail(at+1,'answer','The short answer is one paragraph before the panels.','A direct answer in one paragraph.\n\n## Why?');
        document.answer.summary=text;answerSeen=true;reasonsAllowed=true;map('/answer',document.answer,descriptor(at,cursor));
      } else addBlock({type:'prose',text},at,cursor);
    }
    closePanel(sourceText.length);
    if(!titleSeen)fail(1,'title','A document requires one # title.','# What should we choose?');
    if(!answerSeen)fail(1,'answer','A short answer is required before question panels.','# A title\n\nA direct answer.\n\n## Why?');
    if(!document.panels.length)fail(1,'panel','At least one question panel is required.','## Why does this happen?');
    if(output)document.meta.output=output;
  }
  const identities=new Map<string, { pointer: string; component: string; line: number }>();
  function identity(value: unknown, pointer: string, component: string): void {
    if(typeof value!=='string')return;
    const line=sourceMap[pointer]?.line||sourceMap[pointer.replace(/\/id$/u,'')]?.line||1;
    if(!ID.test(value)||value.length>100)fail(line,component,'IDs must begin with an ASCII letter and contain letters, numbers, hyphens or underscores.','id=cache-flow',pointer);
    const previous=identities.get(value);
    if(previous)fail(line,component,`Duplicate ID "${value}": the ${previous.component} on line ${previous.line} already uses it. Panels, blocks, diagrams and steps share one ID namespace.`,component==='panel'?`## Another question? {#${value}-2}`:`omit id=, or use id=${value}-${component}`,pointer);
    identities.set(value,{pointer,component,line});
  }
  if(parsedDocument&&typeof parsedDocument==='object'&&!Array.isArray(parsedDocument)) {
    identity(errorField(errorField(parsedDocument,'meta'),'id'),'/meta/id','document');
    const panels=errorField(parsedDocument,'panels');
    for(const [pi,p]of (Array.isArray(panels)?panels:[]).entries()) {
      identity(errorField(p,'id'),`/panels/${pi}/id`,'panel');
      const blocks=errorField(p,'blocks');
      for(const [bi,b]of (Array.isArray(blocks)?blocks:[]).entries())identity(errorField(b,'id'),`/panels/${pi}/blocks/${bi}/id`,String(errorField(b,'type')||'block'));
    }
  }
  return {document:diagnostics.some(d=>d.severity==='error')?null:parsedDocument,sourceMap,format,sourceText,diagnostics};
}
