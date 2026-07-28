/**
 * `etag` browser shim (ESM). Upstream `etag` is CommonJS (`module.exports =
 * etag`) and is default-imported by Vite's send/transformRequest. Served raw
 * to the browser it has no ESM default export, so we provide the same tiny
 * algorithm natively. Supports the string/Buffer/Stats forms the fork uses.
 */

interface StatLike {
  size: number;
  mtime: Date;
}

// FNV-1a 32-bit — a stable content hash for the entity tag. Upstream uses
// SHA-1 base64; any deterministic weak/strong tag satisfies HTTP semantics.
function contentHash(entity: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < entity.length; i++) {
    h ^= entity.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function isStats(e: unknown): e is StatLike {
  return (
    !!e &&
    typeof e === 'object' &&
    typeof (e as StatLike).size === 'number' &&
    (e as StatLike).mtime instanceof Date
  );
}

function stattag(stat: StatLike): string {
  return `"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;
}

function entitytag(entity: string): string {
  if (entity.length === 0) return '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
  return `"${entity.length.toString(16)}-${contentHash(entity)}"`;
}

export default function etag(entity: string | StatLike, options?: { weak?: boolean }): string {
  if (entity == null) throw new TypeError('argument entity is required');
  const stats = isStats(entity);
  const weak = options && typeof options.weak === 'boolean' ? options.weak : stats;
  const tag = stats ? stattag(entity as StatLike) : entitytag(entity as string);
  return weak ? `W/${tag}` : tag;
}
