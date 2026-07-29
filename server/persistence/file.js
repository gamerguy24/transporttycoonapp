import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

/** Node persistence: one JSON file, written atomically. Not used on Workers. */
export function filePersistence() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dataPath = path.isAbsolute(config.dataFile) ? config.dataFile : path.join(root, config.dataFile);

  return {
    describe: () => dataPath,

    async load() {
      try {
        return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null; // first run
        throw err;
      }
    },

    async save(state) {
      fs.mkdirSync(path.dirname(dataPath), { recursive: true });
      const tmp = `${dataPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, dataPath); // atomic — a crash mid-write can't corrupt the store
    },
  };
}
