import { config } from '../config.js';
import * as mock from './mock.js';
import * as tycoon from './tycoon.js';

const sources = { mock, tycoon };

export const source = sources[config.source] ?? mock;

if (!sources[config.source]) {
  console.warn(`[source] unknown DATA_SOURCE "${config.source}" — falling back to mock`);
}

export function discoveredKeys() {
  return typeof source.discoveredKeys === 'function' ? source.discoveredKeys() : [];
}
