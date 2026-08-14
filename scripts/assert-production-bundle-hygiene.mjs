import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { glob } from 'node:fs/promises';

const forbidden = ['__e2e_manual_guide_raster__', 'ManualGuideBatchRasterHarness'];
const files = await Array.fromAsync(glob('**/*', { cwd: resolve('dist'), withFileTypes: true }));
const violations = [];

for (const file of files) {
  if (!file.isFile()) continue;
  const path = resolve('dist', file.parentPath, file.name);
  const contents = await readFile(path, 'utf8');
  for (const token of forbidden) {
    if (contents.includes(token)) violations.push(`${path}: ${token}`);
  }
}

if (violations.length > 0) {
  throw new Error(`Production bundle exposes E2E-only manual-guide harness:\n${violations.join('\n')}`);
}
