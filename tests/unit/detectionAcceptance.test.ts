import { describe, expect, it } from 'vitest';
import { isDetectionAccepted } from '@/features/scanner/lib/detectionAcceptance';
import type { DetectionEvidence } from '@/features/scanner/worker/messages';

const safeEvidence: DetectionEvidence = {
  confidence: 'high',
  areaRatio: 0.4,
  edgeSupport: [0.7, 0.7, 0.7, 0.7],
  borderContacts: [],
};

describe('isDetectionAccepted', () => {
  it('accepts a confident full-page candidate', () => {
    expect(isDetectionAccepted(safeEvidence)).toBe(true);
  });

  it('degrades uncertain and incomplete-edge candidates', () => {
    expect(isDetectionAccepted({ ...safeEvidence, confidence: 'low' })).toBe(false);
    expect(isDetectionAccepted({ ...safeEvidence, confidence: 'medium' })).toBe(false);
    expect(isDetectionAccepted({ ...safeEvidence, edgeSupport: [0.7, 0.2, 0.7, 0.7] })).toBe(false);
  });

  it('degrades a cropped candidate touching opposite borders', () => {
    expect(isDetectionAccepted({ ...safeEvidence, borderContacts: ['left', 'right'] })).toBe(false);
  });

  it('degrades any candidate touching the frame border', () => {
    expect(isDetectionAccepted({ ...safeEvidence, borderContacts: ['top'] })).toBe(false);
  });
});
