import fs from 'node:fs';
import { filePersistence } from './persistence/file.js';

const target = filePersistence().describe();

try {
  fs.unlinkSync(target);
  console.log(`[reset] deleted ${target} — the next start will re-seed the exchange`);
} catch (err) {
  if (err.code === 'ENOENT') console.log('[reset] nothing to delete, store is already empty');
  else throw err;
}
