/**
 * Browser npm installer — the host-side analogue of `npm install`.
 *
 * Reads the demo project's `/package.json` from the VFS, resolves each
 * dependency against the npm registry, downloads the tarballs, and unpacks
 * them into the VFS at `/node_modules/<pkg>/...` so the dep bundler
 * (esbuild-wasm) can optimize them for the preview iframe.
 *
 * No external deps: gzip via `DecompressionStream`, and a small hand-rolled
 * ustar parser (npm tarballs are plain ustar).
 */

import { setVirtualFile, withVirtualFileBatch } from 'browser-vite';

export interface ResolvedDep {
  name: string;
  version: string;
  tarball: string;
  dependencies: Record<string, string>;
}

export type InstallLogger = (message: string) => void;

/**
 * Progress reporter for a single package's install. Unlike the line-appending
 * InstallLogger, `update` rewrites the *current* status line in place (like a
 * real package manager's spinner), so download/untar progress streams live.
 */
export type ProgressReporter = (message: string) => void;

import { maxSatisfying, valid, validRange } from 'semver';

const REGISTRY = 'https://registry.npmjs.org';

// ---------------------------------------------------------------------------
// Registry metadata + version resolution
// ---------------------------------------------------------------------------

interface Packument {
  'dist-tags'?: Record<string, string>;
  versions?: Record<
    string,
    {
      dist?: { tarball?: string };
      dependencies?: Record<string, string>;
    }
  >;
}

const packumentCache = new Map<string, Promise<Packument>>();

function fetchPackument(name: string): Promise<Packument> {
  let p = packumentCache.get(name);
  if (!p) {
    p = fetch(`${REGISTRY}/${encodeURIComponent(name).replace(/^%40/, '@')}`).then(
      (res) => {
        if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
        return res.json() as Promise<Packument>;
      },
    );
    packumentCache.set(name, p);
  }
  return p;
}

export async function resolveDep(name: string, range: string): Promise<ResolvedDep> {
  const doc = await fetchPackument(name);
  const versions = Object.keys(doc.versions ?? {});
  const tags = doc['dist-tags'] ?? {};
  const r = range.trim();

  // Non-semver specifiers: dist-tags ("latest", "next") and bare "*"/"".
  // `maxSatisfying` (with includePrerelease:false, the default) already
  // excludes prereleases from non-prerelease ranges, which is exactly the
  // behaviour that previously had to be hand-rolled.
  let version: string | undefined;
  if (r === '' || r === '*') {
    version = maxSatisfying(versions, '*') ?? tags.latest;
  } else if (tags[r]) {
    version = tags[r];
  } else if (validRange(r) || valid(r)) {
    version = maxSatisfying(versions, r) ?? undefined;
  } else {
    // Unknown specifier (e.g. a dist-tag not present, or a URL) — try latest.
    version = tags.latest;
  }

  version = version ?? tags.latest ?? versions[versions.length - 1];
  if (!version) throw new Error(`No version of ${name} satisfies ${range}`);
  const meta = doc.versions?.[version];
  const tarball = meta?.dist?.tarball;
  if (!tarball) throw new Error(`No tarball for ${name}@${version}`);
  return { name, version, tarball, dependencies: meta?.dependencies ?? {} };
}

// ---------------------------------------------------------------------------
// Tarball fetch + gunzip + untar
// ---------------------------------------------------------------------------

async function gunzip(buffer: ArrayBuffer): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buffer]).stream().pipeThrough(ds);
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}

const textDecoder = new TextDecoder('utf-8');

function parseTarString(view: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && view[end] !== 0) end++;
  return textDecoder.decode(view.subarray(offset, end));
}

/** Parse a ustar archive into path -> bytes. npm tarballs prefix `package/`. */
function untar(data: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= data.length) {
    // End-of-archive: two zero blocks.
    if (data[offset] === 0 && data[offset + 1] === 0) break;
    const name = parseTarString(data, offset + 0, 100);
    const prefix = parseTarString(data, offset + 345, 155);
    const sizeOctal = parseTarString(data, offset + 124, 12).trim();
    const typeflag = data[offset + 156];
    const size = parseInt(sizeOctal, 8) || 0;
    const full = prefix ? `${prefix}/${name}` : name;
    offset += 512;
    if (typeflag === 48 || typeflag === 0) {
      // '0' or '\0' = regular file
      files.set(full, data.slice(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

const KEEP_EXT = /\.(m?js|cjs|json|ts|tsx|jsx|mts|cts|css|d\.ts)$/i;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Download a tarball, streaming byte progress via `onProgress`. */
async function fetchTarballBytes(
  url: string,
  onProgress: (received: number, total: number | null) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tarball ${res.status}`);
  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : null;
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress(buf.byteLength, total);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/**
 * Download + unpack one package into the VFS at /node_modules/<name>/,
 * streaming live progress (download bytes → unpack file count) via `progress`.
 * npm tarballs store entries under `package/`; we strip that prefix.
 */
async function unpackIntoVfs(
  dep: ResolvedDep,
  log: InstallLogger,
  progress: ProgressReporter,
): Promise<void> {
  const label = `${dep.name}@${dep.version}`;
  const gz = await fetchTarballBytes(dep.tarball, (received, total) => {
    progress(
      total
        ? `${label}  downloading ${formatBytes(received)} / ${formatBytes(total)}`
        : `${label}  downloading ${formatBytes(received)}`,
    );
  });
  progress(`${label}  unpacking…`);
  const tar = await gunzip(gz);
  const entries = untar(tar);
  let count = 0;
  // Bulk mode: suppress per-file HMR 'add' events (node_modules aren't app
  // modules), which is what made untarring thousands of files feel slow.
  withVirtualFileBatch(() => {
    for (const [path, bytes] of entries) {
      const rel = path.replace(/^package\//, '');
      if (!rel || !KEEP_EXT.test(rel)) continue;
      const text = textDecoder.decode(bytes);
      setVirtualFile(`/node_modules/${dep.name}/${rel}`, text);
      count++;
      if (count % 200 === 0) progress(`${label}  unpacking… ${count} files`);
    }
  });
  log(`${label}: ${count} files`);
}

// ---------------------------------------------------------------------------
// Public: install all deps from /package.json (recursive)
// ---------------------------------------------------------------------------

export interface InstallResult {
  installed: ResolvedDep[];
  /** Names of the direct dependencies declared in /package.json. */
  direct: string[];
}

export async function installDependencies(
  packageJsonContent: string,
  log: InstallLogger,
  progress?: ProgressReporter,
): Promise<InstallResult> {
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(packageJsonContent);
  } catch {
    throw new Error('Invalid /package.json (not valid JSON)');
  }
  const direct = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  const installed = new Map<string, ResolvedDep>();
  const report: ProgressReporter = progress ?? (() => {});

  // Resolve + unpack packages concurrently (bounded). Each package's registry
  // fetch / tarball download / gunzip / untar is independent, so overlapping
  // them collapses total install time vs. the previous serial queue. The
  // queue grows as transitive deps are discovered; workers drain it.
  const queue: Array<[string, string]> = [];
  // Names ever enqueued — prevents the same transitive dep being queued twice
  // when reached from two parents before either resolution completes.
  const seen = new Set<string>();
  const CONCURRENCY = 6;

  async function processOne(name: string, range: string): Promise<void> {
    report(`Resolving ${name}@${range}…`);
    const dep = await resolveDep(name, range);
    installed.set(name, dep);
    await unpackIntoVfs(dep, log, report);
    // Recurse into transitive deps (first-seen wins, like a flat install).
    for (const [dn, dr] of Object.entries(dep.dependencies)) {
      if (!installed.has(dn) && !seen.has(dn)) {
        seen.add(dn);
        enqueue(dn, dr);
      }
    }
  }

  // Scheduler: keep up to CONCURRENCY packages resolving/unpacking at once.
  // Returns a promise that resolves when the queue is drained AND nothing is
  // in flight (so transitively-discovered deps are always processed).
  const running = new Set<Promise<void>>();
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let scheduled = false;

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      while (queue.length && running.size < CONCURRENCY) {
        const [name, range] = queue.shift()!;
        if (installed.has(name)) continue;
        const p = processOne(name, range).finally(() => {
          running.delete(p);
          schedule();
        });
        running.add(p);
      }
      if (running.size === 0 && queue.length === 0) resolveDone();
    });
  }

  function enqueue(name: string, range: string): void {
    queue.push([name, range]);
    schedule();
  }

  for (const [name, range] of Object.entries(direct)) {
    if (!seen.has(name)) {
      seen.add(name);
      queue.push([name, range]);
    }
  }
  schedule();
  await done;

  return { installed: [...installed.values()], direct: Object.keys(direct) };
}
