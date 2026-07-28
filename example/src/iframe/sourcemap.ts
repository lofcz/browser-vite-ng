/**
 * Sourcemap support for the preview iframe.
 *
 * The preview executes every module as a blob URL, so V8 reports stack frames
 * as `blob:http://host/9f2e…:14:22` — no file name, and line/column pointing at
 * transformed JS. This module closes both gaps:
 *
 *  1. `//# sourceMappingURL` is inlined into each served module, so the iframe's
 *     own DevTools (and Chobitsu) show original TSX.
 *  2. `Error.prepareStackTrace` is intercepted so `error.stack` itself names
 *     real files at original positions — which means the overlay, the host log,
 *     and any user `console.error(err)` all show the same real trace, with no
 *     per-call-site remapping.
 *
 * The blob rewrite in `linkModule` changes columns on import lines, so maps are
 * re-based through `shiftMappings` before being registered. Without that, every
 * position on a line containing an import would be off by the difference
 * between the original specifier and the blob URL (~50 chars).
 */

import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { decode, encode, type SourceMapSegment } from '@jridgewell/sourcemap-codec';

export interface RawSourceMap {
  version?: number;
  file?: string;
  sources: (string | null)[];
  sourcesContent?: (string | null)[];
  names?: string[];
  mappings: string;
  sourceRoot?: string;
}

/** A single in-place replacement performed on generated code. */
export interface CodeEdit {
  /** Character offset of the replacement start in the pre-edit code. */
  start: number;
  /** Length of the replaced text. */
  removed: number;
  /** Length of the inserted text. */
  inserted: number;
}

export interface OriginalPosition {
  source: string;
  line: number;
  column: number;
  name?: string | null;
}

interface RegisteredModule {
  /** Servable module path, e.g. `/src/App.tsx` or `/@deps/react.js`. */
  path: string;
  map: RawSourceMap | null;
  trace: TraceMap | null;
}

const modulesByUrl = new Map<string, RegisteredModule>();
/** Original source text by source path, harvested from `sourcesContent`. */
const sourceContents = new Map<string, string>();

/**
 * Associate an executable URL (blob: or otherwise) with the module path it was
 * built from, plus its sourcemap. Modules without a map (optimized deps) are
 * still registered so their frames at least show `/@deps/react.js` instead of
 * an opaque blob id.
 */
export function registerModule(url: string, path: string, map: RawSourceMap | null): void {
  let trace: TraceMap | null = null;
  if (map && map.mappings) {
    try {
      trace = new TraceMap(map as never);
    } catch {
      trace = null;
    }
  }
  modulesByUrl.set(url, { path, map, trace });
  if (map?.sourcesContent) {
    map.sources.forEach((source, i) => {
      const content = map.sourcesContent?.[i];
      if (source && typeof content === 'string') sourceContents.set(source, content);
    });
  }
}

/** Original text of a mapped source, if it travelled with the map. */
export function getSourceContent(source: string): string | undefined {
  return sourceContents.get(source);
}

/**
 * Map a generated position (1-based line, 1-based column, as stack traces
 * report them) back to its original source. Falls back to the module path with
 * generated coordinates when there is no map — still far more useful than a
 * blob id.
 */
export function mapPosition(
  url: string,
  line: number,
  column: number,
): OriginalPosition | null {
  const mod = modulesByUrl.get(url);
  if (!mod) return null;
  if (!mod.trace) return { source: mod.path, line, column };
  const found = originalPositionFor(mod.trace, { line, column: Math.max(0, column - 1) });
  if (found.source == null || found.line == null) {
    return { source: mod.path, line, column };
  }
  return {
    source: found.source,
    line: found.line,
    column: (found.column ?? 0) + 1,
    name: found.name,
  };
}

/**
 * Re-base a map after in-place edits to the generated code.
 *
 * Replacements never contain newlines (an import specifier becomes a blob URL),
 * so line numbers are unaffected and only generated columns at or after each
 * edit on the same line move.
 */
export function shiftMappings(
  map: RawSourceMap,
  code: string,
  edits: CodeEdit[],
): RawSourceMap {
  if (!edits.length || !map.mappings) return map;

  // Group edits by line, converting absolute offsets to (line, column).
  const lineStarts = computeLineStarts(code);
  const byLine = new Map<number, Array<{ column: number; removed: number; delta: number }>>();
  for (const edit of edits) {
    const line = lineOfOffset(lineStarts, edit.start);
    const column = edit.start - lineStarts[line];
    const list = byLine.get(line) ?? [];
    list.push({ column, removed: edit.removed, delta: edit.inserted - edit.removed });
    byLine.set(line, list);
  }
  for (const list of byLine.values()) list.sort((a, b) => a.column - b.column);

  const decoded = decode(map.mappings);
  for (const [line, list] of byLine) {
    const segments = decoded[line];
    if (!segments) continue;
    decoded[line] = segments.map((seg) => {
      let shift = 0;
      for (const edit of list) {
        // Positions inside the replaced text itself collapse to its start;
        // positions after it move by the accumulated size difference.
        if (seg[0] >= edit.column + edit.removed) shift += edit.delta;
      }
      if (shift === 0) return seg;
      const next = seg.slice() as SourceMapSegment;
      next[0] = Math.max(0, next[0] + shift);
      return next;
    });
  }
  return { ...map, mappings: encode(decoded) };
}

function computeLineStarts(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** Index of the 0-based line containing `offset` (binary search). */
function lineOfOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** UTF-8 safe base64 — `btoa` throws on any code point above U+00FF. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Append `//# sourceMappingURL=data:…` so iframe DevTools resolves originals. */
export function withInlineSourceMap(code: string, map: RawSourceMap | null): string {
  if (!map || !map.mappings) return code;
  const json = JSON.stringify(map);
  const suffix = code.endsWith('\n') ? '' : '\n';
  return `${code}${suffix}//# sourceMappingURL=data:application/json;base64,${toBase64(json)}\n`;
}

// =============================================================================
// Stack traces
// =============================================================================

/** V8 CallSite — not in lib.dom, and NodeJS types aren't available here. */
interface CallSite {
  getFileName(): string | null;
  getScriptNameOrSourceURL?(): string | null;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
  getFunctionName(): string | null;
  getMethodName(): string | null;
  getTypeName(): string | null;
  isNative(): boolean;
  isConstructor(): boolean;
  isToplevel(): boolean;
  isEval(): boolean;
  getEvalOrigin(): string | undefined;
  toString(): string;
}

type PrepareStackTrace = (error: Error, stack: CallSite[]) => unknown;

let interceptorInstalled = false;

/**
 * Install a V8 `prepareStackTrace` hook that renders frames at original
 * positions. Errors thrown anywhere in the preview then carry a real trace on
 * `.stack`, including ones we never see (user `console.error`, React's own
 * logging, Chobitsu's console).
 *
 * No-op on engines without `prepareStackTrace` (Firefox, Safari) —
 * `remapStackString` covers those.
 */
export function installStackTraceInterceptor(): void {
  if (interceptorInstalled) return;
  const ErrorCtor = Error as unknown as { prepareStackTrace?: PrepareStackTrace };
  ErrorCtor.prepareStackTrace = (error, stack) => {
    const header = `${error.name || 'Error'}${error.message ? `: ${error.message}` : ''}`;
    const frames = stack.map((frame) => {
      // A formatting failure here would replace the whole stack with an
      // unrelated error, so fall back to V8's own rendering per frame.
      try {
        return `\n    at ${formatFrame(frame)}`;
      } catch {
        return `\n    at ${frame.toString()}`;
      }
    });
    return header + frames.join('');
  };
  interceptorInstalled = true;
}

function formatFrame(frame: CallSite): string {
  const file = frame.getFileName() ?? frame.getScriptNameOrSourceURL?.() ?? null;
  const line = frame.getLineNumber();
  const column = frame.getColumnNumber();
  const mapped = file && line != null ? mapPosition(file, line, column ?? 1) : null;

  let location: string;
  if (frame.isNative()) {
    location = 'native';
  } else if (mapped) {
    location = `${mapped.source}:${mapped.line}:${mapped.column}`;
  } else if (file) {
    location = `${file}${line != null ? `:${line}` : ''}${column != null ? `:${column}` : ''}`;
  } else if (frame.isEval()) {
    location = frame.getEvalOrigin() ?? '<anonymous>';
  } else {
    location = '<anonymous>';
  }

  // A mapped `name` recovers identifiers the transform renamed or inlined.
  const fnName = frame.getFunctionName() || mapped?.name;
  if (!fnName) return location;
  const typeName = frame.isToplevel() || frame.isConstructor() ? null : frame.getTypeName();
  const qualified = typeName && !fnName.startsWith(typeName) ? `${typeName}.${fnName}` : fnName;
  return `${frame.isConstructor() ? 'new ' : ''}${qualified} (${location})`;
}

const BLOB_FRAME_RE = /(blob:[^\s):]+):(\d+):(\d+)/g;

/**
 * Rewrite blob-URL positions in an already-stringified stack.
 *
 * Used for stacks that arrive as plain text (postMessage from the host, engines
 * with no `prepareStackTrace`). Idempotent: a remapped stack contains no blob
 * URLs, so re-running it is a no-op.
 */
export function remapStackString(stack: string | undefined): string | undefined {
  if (!stack || !stack.includes('blob:')) return stack;
  return stack.replace(BLOB_FRAME_RE, (match, url: string, line: string, column: string) => {
    const mapped = mapPosition(url, Number(line), Number(column));
    return mapped ? `${mapped.source}:${mapped.line}:${mapped.column}` : match;
  });
}

/**
 * First frame that resolves to a project file — where the overlay should point.
 *
 * Only `at …` lines are considered. An error MESSAGE can itself mention a
 * `file:line:column` (transform errors do), and treating that as a frame would
 * attribute the failure to a position the stack never visited.
 */
export function firstMappedFrame(stack: string | undefined): OriginalPosition | null {
  if (!stack) return null;
  for (const line of stack.split('\n')) {
    if (!/^\s+at\s/.test(line)) continue;
    const blob = /(blob:[^\s):]+):(\d+):(\d+)/.exec(line);
    if (blob) {
      const mapped = mapPosition(blob[1], Number(blob[2]), Number(blob[3]));
      if (mapped && sourceContents.has(mapped.source)) return mapped;
      continue;
    }
    // Already remapped by `prepareStackTrace`.
    const known = /(\/[^\s():]+\.[a-z]+):(\d+):(\d+)/i.exec(line);
    if (known && sourceContents.has(known[1])) {
      return { source: known[1], line: Number(known[2]), column: Number(known[3]) };
    }
  }
  return null;
}

/** Rollup/Vite-style code frame from inlined original source. */
export function codeFrame(
  source: string,
  line: number,
  column: number,
  context = 2,
): string | undefined {
  const content = sourceContents.get(source);
  if (!content) return undefined;
  const lines = content.split('\n');
  if (line < 1 || line > lines.length) return undefined;
  const start = Math.max(1, line - context);
  const end = Math.min(lines.length, line + context);
  const gutter = String(end).length;
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    out.push(`${String(n).padStart(gutter, ' ')} |  ${lines[n - 1] ?? ''}`);
    if (n === line) {
      out.push(`${' '.repeat(gutter)} |  ${' '.repeat(Math.max(0, column - 1))}^`);
    }
  }
  return out.join('\n');
}
