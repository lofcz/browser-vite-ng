/**
 * Browser `node:stream/promises` — IS `stream.promises`, mirroring Node's
 * `require('stream/promises') === require('stream').promises`.
 */
import { promises } from './stream';

export const { pipeline, finished } = promises;

export default promises;
