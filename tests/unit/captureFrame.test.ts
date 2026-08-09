import * as captureFrame from '@/features/scanner/lib/captureFrame';
import { describe, expect, it } from 'vitest';

describe('captureFrame source ownership', () => {
  it('does not expose a preview-destructive crop API', () => {
    expect('cropToVisibleRect' in captureFrame).toBe(false);
  });
});
