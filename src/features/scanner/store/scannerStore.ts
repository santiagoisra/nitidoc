import { create } from 'zustand';
import type { Quad, QualityMetrics } from '@/shared/types/geometry';
import type { DocumentActions, DocumentSlice } from './documentSlice';
import { createDocumentActions, initialDocumentSlice } from './documentSlice';

/**
 * Scanner store — Zustand, slices pattern (design section 5.1).
 *
 * SCOPE NOTE (Group 1 / Slice A): this file defines state shape and initial
 * values ONLY. Business-logic actions (setCorners, beginCapture, setWarped,
 * etc.) are implemented incrementally in Groups 2-5 as their owning
 * capability lands. Adding an action here before its capability exists would
 * mean shipping unimplemented behavior, which is out of scope for this slice.
 *
 * SCOPE NOTE (Group 3 / Slice C): camera-owning actions are implemented here
 * (setStream, setDevices, setActiveDeviceId, setRealResolution,
 * setTorchSupported, setTorchOn, setPermission, setCaptureCapabilities,
 * resetCamera).
 *
 * SCOPE NOTE (Group 4 / Slice D): detection-owning actions are implemented
 * here (setCorners, setQuality, setStability, setCountdown,
 * toggleAutoCapture, setNoDetectionSince).
 *
 * SCOPE NOTE (Group 6 / Slice F): `setOpenCvStatus` is implemented here so
 * `useDocumentDetection` can surface the OpenCV load state machine (design
 * section 4.1) to the UI.
 *
 * SCOPE NOTE (Fase 2, Group 1c / PR3 — ADR-010): F1's legacy single-page
 * capture slice (`originalFrame`/`warpedImage`/`recipe`/`phase` and its
 * actions `setOriginalFrame`/`setWarpedImage`/`setRecipe`/its own reset
 * action) is REMOVED. `DocumentSlice` (`documentSlice.ts`,
 * design section 1.2-1.5) is now the SOLE owner of the multipage document
 * model, INCLUDING `phase`/`setPhase` — the transitional `Omit<DocumentSlice,
 * 'phase'>` adapter Group 1b used to coexist with the legacy slice's own
 * `phase` field is gone. `ScannerScreen`/`CornerEditor` are rewired to the
 * active-page model (see those files' own doc comments). `OpenCvSlice`/
 * `CameraSlice`/`DetectionSlice` are untouched by this migration.
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
  /**
   * Human-readable message for camera failures that are neither "permission
   * denied" nor "no device" (e.g. `NotReadableError`, `OverconstrainedError`).
   * Surfaced by the UI instead of letting `openCamera`'s rejection go
   * unhandled (M1 fix — see useCamera.ts openCamera catch block).
   */
  readonly lastCameraError: string | null;
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

export interface OpenCvActions {
  /** Patches the OpenCV load state machine (design section 4.1). Merges onto the existing state. */
  readonly setOpenCvStatus: (patch: Partial<OpenCvState>) => void;
}

export interface DetectionActions {
  /** Writes both the interpolated and raw corners from the latest DETECT result (design section 5.1). */
  readonly setCorners: (interpolated: Quad | null, raw: Quad | null) => void;
  readonly setQuality: (quality: QualityMetrics | null) => void;
  /** 0..1, where 1 means fully stable (task 4.3.1 stability buffer). */
  readonly setStability: (stability: number) => void;
  readonly setCountdown: (countdown: 0 | 1 | 2 | 3) => void;
  readonly setAutoCaptureEnabled: (enabled: boolean) => void;
  /** Timestamp (ms) since detection last failed to produce corners, or null when currently detecting. */
  readonly setNoDetectionSince: (timestamp: number | null) => void;
  /** Resets the detection slice to its initial values (e.g. on unmount / camera close). */
  readonly resetDetection: () => void;
}

export interface CameraActions {
  /** Replaces the active MediaStream (does NOT stop the previous one — callers own that). */
  readonly setStream: (stream: MediaStream | null) => void;
  readonly setDevices: (devices: readonly MediaDeviceInfo[]) => void;
  readonly setActiveDeviceId: (deviceId: string | null) => void;
  readonly setRealResolution: (resolution: { width: number; height: number } | null) => void;
  readonly setTorchSupported: (supported: boolean) => void;
  readonly setTorchOn: (on: boolean) => void;
  readonly setPermission: (permission: CameraPermission) => void;
  readonly setCaptureCapabilities: (caps: {
    readonly imageCaptureSupported: boolean;
    readonly offscreenSupported: boolean;
  }) => void;
  readonly setLastCameraError: (message: string | null) => void;
  /** Resets the camera slice to its initial values (does NOT stop tracks — callers own that). */
  readonly resetCamera: () => void;
}

export type ScannerStore = CameraSlice &
  DetectionSlice &
  OpenCvSlice &
  DocumentSlice &
  CameraActions &
  DetectionActions &
  OpenCvActions &
  DocumentActions;

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
  lastCameraError: null,
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

export type ScannerStateShape = CameraSlice & DetectionSlice & OpenCvSlice & DocumentSlice;

/**
 * Re-export for reuse by future actions/tests without re-typing the initial
 * shape.
 */
export const scannerStoreInitialState: ScannerStateShape = {
  ...initialDocumentSlice,
  ...initialCameraSlice,
  ...initialDetectionSlice,
  ...initialOpenCvSlice,
};

export const useScannerStore = create<ScannerStore>((set, get) => ({
  ...scannerStoreInitialState,

  setStream: (stream) => set({ stream }),
  setDevices: (devices) => set({ devices }),
  setActiveDeviceId: (activeDeviceId) => set({ activeDeviceId }),
  setRealResolution: (realResolution) => set({ realResolution }),
  setTorchSupported: (torchSupported) => set({ torchSupported }),
  setTorchOn: (torchOn) => set({ torchOn }),
  setPermission: (permission) => set({ permission }),
  setCaptureCapabilities: ({ imageCaptureSupported, offscreenSupported }) =>
    set({ imageCaptureSupported, offscreenSupported }),
  setLastCameraError: (lastCameraError) => set({ lastCameraError }),
  resetCamera: () => set({ ...initialCameraSlice }),

  setCorners: (corners, rawCorners) => set({ corners, rawCorners }),
  setQuality: (quality) => set({ quality }),
  setStability: (stability) => set({ stability }),
  setCountdown: (countdown) => set({ countdown }),
  setAutoCaptureEnabled: (autoCaptureEnabled) => set({ autoCaptureEnabled }),
  setNoDetectionSince: (noDetectionSince) => set({ noDetectionSince }),
  resetDetection: () => set({ ...initialDetectionSlice }),

  setOpenCvStatus: (patch) => set((state) => ({ opencv: { ...state.opencv, ...patch } })),

  ...createDocumentActions(
    (partial) => set(partial as Partial<ScannerStore> | ((state: ScannerStore) => Partial<ScannerStore>)),
    () => get(),
  ),
}));
