/**
 * Browser `node:fs/promises` — IS `fs.promises`, mirroring almostnode's
 * `require('fs/promises') === fsShim.promises`.
 */
import { promises, constants } from './fs.js';

export const {
  readFile,
  writeFile,
  stat,
  lstat,
  readdir,
  mkdir,
  access,
  realpath,
  copyFile,
  unlink,
  rm,
  rmdir,
  rename,
  open,
} = promises;

// `node:fs/promises` re-exports constants and a `watch` async-iterator too.
export { constants };
export const watch = async function* watch(): AsyncIterableIterator<never> {
  // No persistent watching in the browser VFS shim.
  // Yield nothing; callers that iterate will simply complete.
};

export default { ...promises, constants, watch };
