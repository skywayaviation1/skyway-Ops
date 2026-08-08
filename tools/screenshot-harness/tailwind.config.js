import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../tailwind.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/* Same design tokens as the app; only the content globs change, because the
 * harness compiles from a different root. */
export default {
  ...base,
  content: [
    path.join(repoRoot, 'src/**/*.{js,jsx}'),
    path.join(here, '*.{html,js,jsx}'),
  ],
};
