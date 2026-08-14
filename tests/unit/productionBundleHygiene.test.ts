// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const hygieneScript = resolve(process.cwd(), 'scripts/assert-production-bundle-hygiene.mjs');
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('production bundle hygiene', () => {
  it('rejects a forbidden token even when NITIDOC_E2E is ambient', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nitidoc-hygiene-'));
    temporaryDirs.push(directory);
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'dist', 'forbidden.js'), 'ManualGuideBatchRasterHarness');

    await expect(execFileAsync(process.execPath, [hygieneScript], {
      cwd: directory,
      env: { ...process.env, NITIDOC_E2E: '1' },
    })).rejects.toThrow('Production bundle exposes E2E-only manual-guide harness');
  });
});
