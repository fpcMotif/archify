import { explainer as validateGenerated } from '../validation/generated-validators.ts';
import { validateSchema } from '../validation/validator.ts';
import { parseInline, type InlineToken } from './inline.ts';
import { lintExplainerWriting, type WritingEntry } from './writing.ts';
import { parseExplainerDiff } from './diff.ts';
import { compileExplainerChart } from './charts.ts';
import { errorDiagnostics, errorField, lookupLocation } from './model.ts';
import type { DiagramBlock, DiagramTarget, Diagnostic, ExplainerDocument, SourceMapInput } from './model.ts';

export interface ValidateOptions {
  sourceMap?: SourceMapInput;
  inputPath?: string;
  writingMode?: string;
}

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

interface Registered {
  pointer: string;
  component: string;
  panelId?: string;
}

interface TargetInput {
  diagram: string;
  node?: string;
  route?: readonly string[];
  edges?: readonly string[];
}

const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const READER_IDS = new Set(['board','diagram-dialog','diagram-dialog-title','toast']);
const NODE_KEYS: Readonly<Record<string, string | undefined>> = {architecture:'components',sequence:'participants',lifecycle:'states',erd:'entities',class:'types',timeline:'events',waterfall:'spans',workflow:'nodes',dataflow:'nodes',tree:'nodes'};
const EDGE_KEYS: Readonly<Record<string, string | undefined>> = {architecture:'connections',sequence:'messages',lifecycle:'transitions',erd:'relationships',class:'relationships',workflow:'edges',dataflow:'edges'};
const at = (document: unknown, pointer: string): unknown => pointer.split('/').slice(1).reduce((value: unknown,key)=>errorField(value,key.replaceAll('~1','/').replaceAll('~0','~')),document);

export function isExplainerDocument(document: unknown): document is ExplainerDocument {
  return validateGenerated(document);
}

/** Structural and semantic author validation; resource preparation owns byte and Git verification.
 * Deferred references into external native files are checked after prepareExplainerDiagrams.
 */
export function validateExplainer(document: unknown, {sourceMap = {}, inputPath, writingMode = 'warn'}: ValidateOptions = {}): ValidationResult {
  const diagnostics: Diagnostic[] = [], entries: WritingEntry[] = [];
  function location(pointer: string,component: string,panelId?: string): Record<string, unknown> & { line: number } {
    let key=pointer, value;
    while(value===undefined) { value=lookupLocation(sourceMap,key); if(!key)break;key=key.slice(0,key.lastIndexOf('/')); }
    return {line:value?.line || 1,column:value?.column || 1,component,path:pointer,...(panelId?{panelId}:{}),...(inputPath?{input:inputPath}:{})};
  }
  function fail(code: string,pointer: string,component: string,reason: string,example: string,panelId?: string): void {
    diagnostics.push({code:`explainer/${code}`,severity:'error',message:reason,subject:location(pointer,component,panelId),
      evidence:{reason,example},supportedFixes:[`Use a valid form, for example: ${example}`]});
  }
  if(!isExplainerDocument(document)) {
    const seen=new Set<string>();
    for(const error of validateGenerated.errors||[]) {
      if(error.keyword==='if')continue;
      let pointer=error.instancePath||'';
      if(error.keyword==='required')pointer+=`/${error.params.missingProperty}`;
      if(error.keyword==='additionalProperties')pointer+=`/${error.params.additionalProperty}`;
      const blockPath=pointer.match(/^\/panels\/\d+\/blocks\/\d+/u)?.[0];
      const component=blockPath?String(errorField(at(document,blockPath),'type')||'block'):pointer.startsWith('/sources/')?'source':pointer.startsWith('/panels/')?'panel':'document';
      const reason=`${pointer||'/'} ${error.message}`;
      const key=`${error.keyword}\0${pointer}\0${JSON.stringify(error.params)}`;if(seen.has(key))continue;seen.add(key);
      const allowedValues=error.params.allowedValues;
      let example;
      if(error.keyword==='required')example=`Add ${error.params.missingProperty} to the ${component}.`;
      else if(error.keyword==='additionalProperties')example=`Remove unsupported ${error.params.additionalProperty}.`;
      else if(pointer==='/meta/output')example='"output":"answer.html"';
      else if(error.keyword==='type')example=error.params.type==='number'?'value=12.5':error.params.type==='boolean'?'multiple=true':error.params.type==='array'?'"items":["First item","Second item"]':error.params.type==='object'?'"meta":{"id":"answer-page","title":"Answer"}':'"text":"A direct explanation."';
      else if(error.keyword==='const')example=`Use ${JSON.stringify(error.params.allowedValue)}.`;
      else if(error.keyword==='enum')example=`Choose ${(Array.isArray(allowedValues)?allowedValues:[]).map(value=>JSON.stringify(value)).join(', ')}.`;
      else if(error.keyword==='oneOf'&&component==='diagram')example='@diagram sequence source=request.sequence.json';
      else if(error.keyword==='minimum'||error.keyword==='exclusiveMinimum'||error.keyword==='maximum')example=`Use a finite value satisfying the stated bound, such as ${Number(error.params.limit) + (error.keyword==='exclusiveMinimum'?1:0)}.`;
      else if(error.keyword==='pattern')example=pointer.endsWith('/revision')?'revision=0123456789abcdef0123456789abcdef01234567':'id=request-path';
      else if(error.keyword==='minItems')example='| a | First option |\n| b | Second option |';
      else if(error.keyword==='minLength')example='text="A direct explanation."';
      else example=component==='panel'?'## Why does this happen? {#reasoning}\nA direct explanation.':component==='source'?'@source facts example title="Stated facts"':`@${component} id=example`;
      fail(`schema-${error.keyword}`,pointer||'/',component,reason,example);
    }
    return {ok:false,diagnostics};
  }
  const targets=new Map<string, Registered>([['answer',{pointer:'/answer',component:'answer'}]]), sourceIds=new Map<string, Registered>(), diagrams=new Map<string, { block: DiagramBlock; pointer: string; panelId: string }>();
  function id(value: string,pointer: string,component: string,panelId?: string,registry=targets): void {
    if(!ID.test(value)||value.length>100)fail('id',pointer,component,'IDs require an ASCII letter followed by letters, digits, hyphens or underscores.','id=request-path',panelId);
    if(registry.has(value))fail('duplicate-id',pointer,component,'This identity is already used. Use an explicit distinct ID.','id=request-path-branch',panelId);
    registry.set(value,{pointer,component,panelId});
    if(registry===targets&&(value.startsWith('explainer-')||READER_IDS.has(value)))fail('reserved-id',pointer,component,'This identity is reserved for reader controls or generated footnotes.','id=request-path',panelId);
  }
  for(const [si,source]of document.sources.entries())id(source.id,`/sources/${si}/id`,'source',undefined,sourceIds);
  for(const [pi,panel]of document.panels.entries()) {
    const pp=`/panels/${pi}`;id(panel.id,`${pp}/id`,'panel',panel.id);
    for(const [bi,block]of panel.blocks.entries()) {
      const bp=`${pp}/blocks/${bi}`;id(block.id,`${bp}/id`,block.type,panel.id);
      if(block.type==='diagram')diagrams.set(block.id,{block,pointer:bp,panelId:panel.id});
      if(block.type==='comparison'||block.type==='steps')for(const [ii,item]of (block.type==='comparison'?block.rows:block.items).entries()) {
        const ip=`${bp}/${block.type==='comparison'?'rows':'items'}/${ii}`;id(item.id,`${ip}/id`,block.type,panel.id);
      }
    }
  }
  for(const sourceId of sourceIds.keys()){const collision=targets.get(`source-${sourceId}`);if(collision)fail('reserved-id',collision.pointer,'source','This identity collides with a generated source anchor.','id=reader-section');}
  function reference(value: unknown,pointer: string,component: string,panelId: string | undefined,registry: ReadonlyMap<unknown, unknown>,example: string): void {
    if(!registry.has(value))fail('unresolved-reference',pointer,component,'The referenced identity does not exist or has the wrong component type.',example,panelId);
  }
  function references(values: readonly unknown[] | undefined,pointer: string,component: string,panelId: string | undefined,registry: ReadonlyMap<unknown, unknown>,example: string): void {
    const seen=new Set<unknown>();for(const [i,value]of (values||[]).entries()) {reference(value,`${pointer}/${i}`,component,panelId,registry,example);if(seen.has(value))fail('duplicate-reference',`${pointer}/${i}`,component,'Each reference may occur only once.','Use each ID once.',panelId);seen.add(value);}
  }
  function diagramTarget(target: TargetInput | DiagramTarget,pointer: string,component: string,panelId?: string): void {
    if (target.node !== undefined && target.route !== undefined) fail('diagram-target-exclusive',pointer,component,'A diagram target cannot select a node and a route at the same time.','{"diagram":"request-path","node":"api"} or {"diagram":"request-path","route":["api","redis"]}',panelId);
    reference(target.diagram,`${pointer}/diagram`,component,panelId,diagrams,'Use the ID of a diagram block, such as request-path.');
    const diagram=diagrams.get(target.diagram);if(!diagram?.block.spec)return;
    const spec=diagram.block.spec;
    const nodeList=spec[String(NODE_KEYS[diagram.block.diagramType])]||[], edgeList=spec[String(EDGE_KEYS[diagram.block.diagramType])]||[];
    const nodes=new Set((Array.isArray(nodeList)?nodeList:[]).map((node: unknown)=>errorField(node,'id')));
    const edges: unknown[]=Array.isArray(edgeList)?edgeList:[];
    if(target.node!==undefined&&!nodes.has(target.node))fail('diagram-node',`${pointer}/node`,component,'The node does not exist in the authored native diagram.','node=api',panelId);
    for(const node of target.route||[])if(!nodes.has(node))fail('diagram-route',`${pointer}/route`,component,'A route endpoint does not exist in the authored native diagram.','route=api~redis',panelId);
    if(target.edges)references(target.edges,`${pointer}/edges`,component,panelId,new Map(edges.filter(edge=>errorField(edge,'id')).map(edge=>[errorField(edge,'id'),edge])),'Use an edge ID from the native diagram.');
  }
  function text(value: unknown,pointer: string,component: string,panelId?: string): void {
    if(typeof value!=='string')return;
    const where=location(pointer,component,panelId);
    const parsed=parseInline(value,{...where,input:inputPath});diagnostics.push(...parsed.diagnostics.map(entry=>({...entry,subject:{...entry.subject,path:pointer}})));
    const prose=(tokens: readonly InlineToken[]): string=>tokens.map(token=>token.type==='code'?'':'children' in token?prose(token.children):token.type==='link'?token.label:token.value||'').join('');
    if(component!=='source')entries.push({text:prose(parsed.tokens),raw:value,pointer,line:where.line,component,...(panelId?{panelId}:{})});
    for(const ref of parsed.references) {
      if(ref.kind==='source')reference(ref.id,pointer,component,panelId,sourceIds,'[Evidence](source:known-source)');
      if(ref.kind==='block')reference(ref.id,pointer,component,panelId,targets,'[Read explanation](block:known-block)');
      if(ref.kind==='node')diagramTarget({diagram:ref.diagram,node:ref.node},pointer,component,panelId);
      if(ref.kind==='route')diagramTarget({diagram:ref.diagram,route:[ref.from,ref.to]},pointer,component,panelId);
      if(ref.kind==='typical'&&!['source','scope'].includes(component))entries.push({text:ref.text,line:where.line,component:'typical',...(panelId?{panelId}:{})});
    }
  }
  text(document.meta.title,'/meta/title','title');text(document.answer.summary,'/answer/summary','answer');(document.answer.reasons||[]).forEach((reason,i)=>text(reason,`/answer/reasons/${i}`,'answer'));
  text(document.answer.scope,'/answer/scope','scope');
  for(const [si,source]of document.sources.entries()) {
    const pointer=`/sources/${si}`;text(source.title,`${pointer}/title`,'source');
    if(source.lines&&source.lines[1]<source.lines[0])fail('source-lines',`${pointer}/lines`,'source','The repository line range must be ordered.','lines=10:20');
    if(source.url) {let url;try{url=new URL(source.url);}catch{}if(!url||!['http:','https:'].includes(url.protocol)||url.username||url.password||/[\u0000-\u0020\u007f]/u.test(source.url))fail('source-url',`${pointer}/url`,'source','Source URLs must be credential-free HTTP(S) links.','url=https://example.com/docs');}
  }
  for(const [pi,panel]of document.panels.entries()) {
    const pp=`/panels/${pi}`;text(panel.title,`${pp}/title`,'panel',panel.id);
    for(const [bi,block]of panel.blocks.entries()) {
      const bp=`${pp}/blocks/${bi}`, component=block.type;
      if(block.type==='diff')diagnostics.push(...parseExplainerDiff(block.text,{...location(`${bp}/text`,component,panel.id),input:inputPath}).diagnostics);
      if(block.type==='chart'&&(block.text===undefined)===(block.data===undefined))fail('chart',`${bp}`,component,'A chart has either fence text or a data file, not both or neither.','@chart type=bar data=latency.csv x=day y=p99',panel.id);
      if(block.type==='chart'&&block.text!==undefined){const chart=compileExplainerChart(block.text);if(chart.error){const before=diagnostics.length;fail('chart',`${bp}/text`,component,chart.error,chart.example,panel.id);if((chart.line ?? 0)>0){const subject=diagnostics[before].subject;subject.line=Number(subject.line)+(chart.line ?? 0)-1;}}}
      for(const key of ['text','title','label','note','caption','alt'])if(!['diff','snippet','chart'].includes(component)||key!=='text')text(errorField(block,key),`${bp}/${key}`,component,panel.id);
      if(block.type==='list')block.items.forEach((item,i)=>text(item,`${bp}/items/${i}`,component,panel.id));
      if(block.type==='facts')block.entries.forEach((item,i)=>{text(item.key,`${bp}/entries/${i}/key`,component,panel.id);text(item.value,`${bp}/entries/${i}/value`,component,panel.id);});
      if(block.type==='comparison') {
        const columns=block.columns;
        columns.forEach((column,i)=>text(column,`${bp}/columns/${i}`,component,panel.id));text(block.labelColumn,`${bp}/labelColumn`,component,panel.id);
        block.rows.forEach((row,i)=>{const rp=`${bp}/rows/${i}`;text(row.label,`${rp}/label`,component,panel.id);if(row.cells.length!==columns.length)fail('table-width',`${rp}/cells`,component,'Each row must have one cell for every comparison column.','| Criterion | Option A | Option B |',panel.id);row.cells.forEach((cell,j)=>{text(cell.text,`${rp}/cells/${j}/text`,component,panel.id);text(cell.verdict,`${rp}/cells/${j}/verdict`,component,panel.id);});});
      }
      if(block.type==='steps')block.items.forEach((item,i)=>{text(item.text,`${bp}/items/${i}/text`,component,panel.id);text(item.detail,`${bp}/items/${i}/detail`,component,panel.id);if(item.target)diagramTarget(item.target,`${bp}/items/${i}/target`,component,panel.id);});
      if(block.type==='code') {const codeSource=block.source;reference(codeSource,`${bp}/source`,component,panel.id,sourceIds,'source=repository-snippet');if(sourceIds.has(codeSource)&&document.sources.find(source=>source.id===codeSource)?.path===undefined)fail('code-source-kind',`${bp}/source`,component,'Code blocks require a repository source whose commit and lines can be checked.','@source snippet title="Code" path=src/router.js lines=1:10',panel.id);}
      if(block.type==='diagram'&&block.nodeSources)for(const [node,source] of Object.entries(block.nodeSources))reference(source,`${bp}/nodeSources/${node}`,component,panel.id,sourceIds,`| ${node} | Label | backend | source:router |`);
      if(block.type==='diagram'&&block.spec) {
        const diagramType=block.diagramType;
        if(block.spec.diagram_type!==diagramType)fail('diagram-type',`${bp}/spec/diagram_type`,component,'The native specification must match the declared diagram type.','@sequence source=request.sequence.json',panel.id);
        try{validateSchema(diagramType,block.spec);}catch(error){for(const entry of errorDiagnostics(error)||[])diagnostics.push({...entry,code:`explainer/native-${entry.code}`,subject:location(`${bp}/spec${entry.subject?.path==='/'?'':entry.subject?.path||''}`,component,panel.id),evidence:{...entry.evidence,reason:entry.message,example:`Use valid native ${diagramType} JSON.`}});}
      }
    }
  }
  diagnostics.push(...lintExplainerWriting(entries,{mode:writingMode,locale:document.meta.locale||'auto'}).map(entry=>({...entry,subject:{...entry.subject,...(inputPath?{input:inputPath}:{})}})));
  return {ok:!diagnostics.some(entry=>entry.severity==='error'),diagnostics};
}
