/**
 * Runs a Gradle task in `android/` from an npm script.
 *
 * Exists because neither spelling of the wrapper works everywhere from a
 * package.json script: `./gradlew` is meaningless to cmd.exe (which is what
 * npm uses on Windows), and a bare `gradlew.bat` fails on any Windows box
 * where `NoDefaultCurrentDirectoryInExePath` is set — cmd then refuses to
 * resolve an executable from the current directory, which is exactly how the
 * first version of `android:apk` broke here.
 *
 * Resolving the wrapper by absolute path sidesteps both. Mirrors the existing
 * `scripts/copy-opencv.mjs` convention of doing platform work in Node rather
 * than in a shell one-liner.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const androidDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'android');
const wrapper = path.join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');

const task = process.argv[2];
if (!task) {
  console.error('[gradle] usage: node scripts/gradle.mjs <task>');
  process.exit(1);
}

/**
 * `shell: true` is REQUIRED for the Windows wrapper: since the fix for
 * CVE-2024-27980, Node refuses to spawn a `.bat`/`.cmd` file directly and
 * fails with EINVAL. With a shell the path has to be quoted, because it can
 * contain spaces once the repo lives anywhere normal.
 */
const isWindows = process.platform === 'win32';
const command = isWindows ? `"${wrapper}"` : wrapper;

const result = spawnSync(command, [task], {
  cwd: androidDir,
  stdio: 'inherit',
  shell: isWindows,
});

if (result.error) {
  console.error(`[gradle] could not run ${wrapper}:`, result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
