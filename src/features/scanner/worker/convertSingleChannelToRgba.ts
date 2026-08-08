import type { CvBindings, CvMat } from './cvBindings';

/**
 * Converts a caller-owned single-channel Mat to a helper-owned RGBA destination.
 * The caller retains source ownership on both success and failure. On success
 * destination ownership transfers to the caller; on failure this helper releases it.
 */
export function convertSingleChannelToRgba(cv: CvBindings, source: CvMat): CvMat {
  const destination = new cv.Mat();

  try {
    cv.cvtColor(source, destination, cv.COLOR_GRAY2RGBA);
    return destination;
  } catch (error) {
    try {
      if (!destination.isDeleted()) destination.delete();
    } catch {
      // Cleanup is best-effort: the conversion failure is the caller's error.
    }
    throw error;
  }
}
