import { create } from 'zustand';
import type { Quad, QualityMetrics } from '@/shared/types/geometry';
import type { CapturedFrame, EditRecipe } from '@/shared/types/scanner';

/**
 * Scanner store — Zustand, 4 typed slices (design section 5.1).
 *
 * SCOPE NOTE (Group 1 / Slice A): this file defines state shape and initial
 * values ONLY. Business-logic actions (setCorners, beginCapture, setWarped,
 * etc.) are implemented incrementally in Groups 2-5 as their owning
 * capability lands. Adding an action here before its capability exists would
 * mean shipping unimplemented behavior, which is out of scope for this slice.
 */

export type CameraPermission = 'idle' | 'prompt' | 'granted' | 'denied';

export interface CameraSlice {
  readonly stream: MediaStream | null;
  readonly devices: readonly MediaDeviceInfo[];
  readonly activeDeviceId: string | null;
  /** Resolution actually negotiated by the browser, read via track.getSettings(). */
  readonly realResolution: { width: number; height: number } | null;
  readonly torchSupported: boolean;
  readonly torchOn: boolean;
  readonly permission: CameraPermission;
  readonly imageCaptureSupported: boolean;
  /** Determines worker-internal OffscreenCanvas path vs. main-thread ImageData path. */
  readonly offscreenSupported: boolean;
}

export interface DetectionSlice {
  /** Interpolated corners in the downscaled detection frame's coordinate space. */
  readonly corners: Quad | null;
  /** Last raw (non-interpolated) corners from the worker, used for stability calc. */
  readonly rawCorners: Quad | null;
  readonly quality: QualityMetrics | null;
  /** 0..1, where 1 means fully stable. */
  readonly stability: number;
  readonly autoCaptureEnabled: boolean;
  readonly countdown: 0 | 1 | 2 | 3;
  /** Timestamp since detection last produced null corners; drives the 5s hint. */
  readonly noDetectionSince: number | null;
}

export type CapturePhase = 'idle' | 'capturing' | 'editing-corners' | 'warping' | 'done';

export interface CaptureSlice {
  /** Original captured frame at full resolution. Immutable — never mutated in place. */
  readonly originalFrame: CapturedFrame | null;
  /** Latest warped result, derived from originalFrame + recipe. */
  readonly warpedImage: ImageBitmap | null;
  readonly recipe: EditRecipe | null;
  readonly phase: CapturePhase;
}

export type OpenCvStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface OpenCvState {
  readonly status: OpenCvStatus;
  /** 0..1, best-effort. */
  readonly progress: number;
  readonly progressIndeterminate: boolean;
  readonly retryCount: number;
  readonly lastError: string | null;
}

export interface OpenCvSlice {
  readonly opencv: OpenCvState;
}

export type ScannerStore = CameraSlice & DetectionSlice & CaptureSlice & OpenCvSlice;

const initialCameraSlice: CameraSlice = {
  stream: null,
  devices: [],
  activeDeviceId: null,
  realResolution: null,
  torchSupported: false,
  torchOn: false,
  permission: 'idle',
  imageCaptureSupported: false,
  offscreenSupported: false,
};

const initialDetectionSlice: DetectionSlice = {
  corners: null,
  rawCorners: null,
  quality: null,
  stability: 0,
  autoCaptureEnabled: true,
  countdown: 0,
  noDetectionSince: null,
};

const initialCaptureSlice: CaptureSlice = {
  originalFrame: null,
  warpedImage: null,
  recipe: null,
  phase: 'idle',
};

const initialOpenCvState: OpenCvState = {
  status: 'idle',
  progress: 0,
  progressIndeterminate: false,
  retryCount: 0,
  lastError: null,
};

const initialOpenCvSlice: OpenCvSlice = {
  opencv: initialOpenCvState,
};

/**
 * Re-export for reuse by future actions/tests without re-typing the initial
 * shape (Groups 2-5 will spread these into their own reset logic).
 */
export const scannerStoreInitialState: ScannerStore = {
  ...initialCameraSlice,
  ...initialDetectionSlice,
  ...initialCaptureSlice,
  ...initialOpenCvSlice,
};

export const useScannerStore = create<ScannerStore>(() => scannerStoreInitialState);
