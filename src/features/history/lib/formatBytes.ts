/**
 * Human-readable byte sizes for the history's storage-usage line.
 *
 * Uses binary units (MiB-sized steps) with the familiar decimal labels, which
 * is what browsers themselves report for storage quotas — matching them avoids
 * the app claiming a different number than the browser's own settings page for
 * the same data.
 */
const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  // Whole numbers below the MB mark; one decimal above, where the difference
  // between 412.3 MB and 412 MB is information the user can act on.
  const decimals = unitIndex >= 2 && value < 100 ? 1 : 0;
  return `${value.toFixed(decimals)} ${UNITS[unitIndex] as string}`;
}
