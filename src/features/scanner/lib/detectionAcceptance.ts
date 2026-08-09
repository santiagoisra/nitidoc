import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import type { DetectionEvidence } from '@/features/scanner/worker/messages';

export function isDetectionAccepted(evidence: DetectionEvidence | null): boolean {
  if (!evidence || evidence.confidence !== 'high') return false;
  if (evidence.edgeSupport.some((support) => support < DETECTION.MIN_EDGE_SUPPORT)) return false;
  return evidence.borderContacts.length === 0;
}
