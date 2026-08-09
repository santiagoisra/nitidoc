import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import type { DetectionEvidence } from '@/features/scanner/worker/messages';

export function isDetectionAccepted(evidence: DetectionEvidence | null): boolean {
  if (!evidence || evidence.confidence === 'low') return false;
  if (evidence.edgeSupport.some((support) => support < DETECTION.MIN_EDGE_SUPPORT)) return false;
  const contacts = new Set(evidence.borderContacts);
  return !(contacts.has('top') && contacts.has('bottom')) && !(contacts.has('left') && contacts.has('right'));
}
