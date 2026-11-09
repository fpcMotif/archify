// 仅分析静态检查器需要的路径子集，不作为通用 SVG 渲染器。
import type { Point, Segment } from './geometry.ts';

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const COMMANDS = /^[MLHVQZACSTmlhvqzacst]$/;
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, Q: 4 };

export interface SvgPathError {
  code: 'artifact/svg-path-unsupported' | 'artifact/svg-path-malformed';
  tokenOffset: number;
  reason: string;
  command?: string;
}

export interface SvgPathFailure {
  ok: false;
  error: SvgPathError;
}

export interface SvgSubpath {
  points: Point[];
  segments: Segment[];
  straightSegments: Segment[];
  closed: boolean;
}

export interface SvgPathAnalysis {
  ok: true;
  subpaths: SvgSubpath[];
}

export type SvgPathResult = SvgPathAnalysis | SvgPathFailure;

interface CommandToken {
  kind: 'command';
  value: string;
  offset: number;
}

interface NumberToken {
  kind: 'number';
  value: number;
  offset: number;
}

type PathToken = CommandToken | NumberToken;

type TokenizeResult = { ok: true; tokens: PathToken[] } | SvgPathFailure;

function failure(tokenOffset: number, reason: string, command?: string | null, unsupported = false): SvgPathFailure {
  return { ok: false, error: {
    code: unsupported ? 'artifact/svg-path-unsupported' : 'artifact/svg-path-malformed',
    tokenOffset, reason, ...(command ? { command } : {}),
  } };
}

function tokenize(source: string): TokenizeResult {
  const tokens: PathToken[] = [];
  let offset = 0;
  let comma: number | null = null;
  while (offset < source.length) {
    const character = source[offset];
    if (/[ \t\r\n]/.test(character)) { offset += 1; continue; }
    if (character === ',') {
      if (comma !== null || tokens.at(-1)?.kind !== 'number') return failure(offset, 'unexpected comma');
      comma = offset++;
      continue;
    }
    if (COMMANDS.test(character)) {
      if (comma !== null) return failure(comma, 'a comma must separate numbers');
      tokens.push({ kind: 'command', value: character, offset: offset++ });
      continue;
    }
    NUMBER.lastIndex = offset;
    const number = NUMBER.exec(source);
    if (!number) return failure(offset, 'expected a number or supported path command');
    const value = Number(number[0]);
    if (!Number.isFinite(value)) return failure(offset, 'coordinate is not finite');
    tokens.push({ kind: 'number', value, offset });
    offset = NUMBER.lastIndex;
    comma = null;
  }
  return comma === null ? { ok: true, tokens } : failure(comma, 'trailing comma');
}

/** 每步消费一个命令或完整参数组；失败不返回部分几何。偏移基于传入的 d 字符串。 */
export function analyzeSvgPath(source: unknown): SvgPathResult {
  if (typeof source !== 'string') return failure(0, 'path data must be a string');
  const lexed = tokenize(source);
  if (!lexed.ok) return lexed;
  const { tokens } = lexed;
  const subpaths: SvgSubpath[] = [];
  let index = 0;
  let command: string | null = null;
  let commandOffset = 0;
  let current: Point = [0, 0];
  let subpath: SvgSubpath | undefined;

  function move(point: Point): void {
    current = point;
    subpath = { points: [point], segments: [], straightSegments: [], closed: false };
    subpaths.push(subpath);
  }
  function line(point: Point): void {
    const segment: Segment = { start: current, end: point };
    (subpath as SvgSubpath).segments.push(segment);
    (subpath as SvgSubpath).straightSegments.push(segment);
    (subpath as SvgSubpath).points.push(point);
    current = point;
  }

  while (index < tokens.length) {
    if (tokens[index].kind === 'command') {
      command = (tokens[index] as CommandToken).value;
      commandOffset = tokens[index++].offset;
    } else if (!command) {
      return failure(tokens[index].offset, 'a command is required after closepath');
    }
    const upper = command.toUpperCase();
    if (!subpath && upper !== 'M') return failure(commandOffset, 'the first command must be moveto', command);
    if (!Object.hasOwn(ARITY, upper) && upper !== 'Z') {
      return failure(commandOffset, 'path command is not supported by artifact analysis', command, true);
    }
    if (upper === 'Z') {
      line((subpath as SvgSubpath).points[0]);
      (subpath as SvgSubpath).closed = true;
      command = null;
      continue;
    }
    const parameters: number[] = [];
    const parameterOffset = tokens[index]?.offset ?? source.length;
    for (let count = 0; count < ARITY[upper]; count += 1) {
      const token = tokens[index];
      if (!token || token.kind !== 'number') {
        return failure(token?.offset ?? source.length, `command ${command} requires ${ARITY[upper]} parameters`, command);
      }
      parameters.push(token.value);
      index += 1;
    }
    const relative: boolean = command !== upper;
    const point = (x: number, y: number): Point => relative ? [current[0] + x, current[1] + y] : [x, y];
    let end: Point;
    let control: Point | undefined;
    if (upper === 'H') end = [relative ? current[0] + parameters[0] : parameters[0], current[1]];
    else if (upper === 'V') end = [current[0], relative ? current[1] + parameters[0] : parameters[0]];
    else if (upper === 'Q') {
      control = point(parameters[0], parameters[1]);
      end = point(parameters[2], parameters[3]);
    } else end = point(parameters[0], parameters[1]);
    if (![...end, ...(control || [])].every(Number.isFinite)) {
      return failure(parameterOffset, 'computed coordinate is not finite', command);
    }
    if (upper === 'M') {
      move(end);
      // moveto 后的额外参数组是 lineto，不能变成额外子路径。
      command = relative ? 'l' : 'L';
      continue;
    }
    if ((subpath as SvgSubpath).closed) move(current);
    if (upper !== 'Q') { line(end); continue; }

    const start = current;
    const cross = ((control as Point)[0] - start[0]) * (end[1] - start[1]) - ((control as Point)[1] - start[1]) * (end[0] - start[0]);
    if (Math.abs(cross) <= 1e-9) (subpath as SvgSubpath).straightSegments.push({ start, end });
    // 保留既有八步 Q 采样；非共线曲线不冒充结构框的直线边界。
    for (let step = 1; step <= 8; step += 1) {
      const amount = step / 8;
      const remaining = 1 - amount;
      const next = [0, 1].map(axis => remaining * remaining * start[axis]
        + 2 * remaining * amount * (control as Point)[axis] + amount * amount * end[axis]) as Point;
      if (!next.every(Number.isFinite)) return failure(parameterOffset, 'sampled coordinate is not finite', command);
      (subpath as SvgSubpath).segments.push({ start: current, end: next });
      (subpath as SvgSubpath).points.push(next);
      current = next;
    }
    current = end;
  }
  return { ok: true, subpaths };
}
