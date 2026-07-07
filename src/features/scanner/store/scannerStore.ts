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
 *
 * SCOPE NOTE (Group 3 / Slice C): camera-owning actions are implemented here
 * (setStream, setDevices, setActiveDeviceId, setRealResolution,
 * setTorchSupported, setTorchOn, setPermission, setCaptureCapabilities,
 * resetCamera).
 *
 * SCOPE NOTE (Group 4 / Slice D): detection-owning actions are implemented
 * here (setCorners, setQuality, setStability, setCountdown,
 * toggleAutoCapture, setNoDetectionSince) plus the minimal capture-phase
 * actions the capture sequence needs to hand a frame off to the (not yet
 * built) corner editor (setOriginalFrame, setPhase). OpenCV actions remain
 * deferred to Group 2 (already implemented as part of Slice B).
 *
 * SCOPE NOTE (Group 5 / Slice E): the remaining capture-phase actions are
 * implemented here (setWarpedImage, setRecipe) so `CornerEditor` can store
 * the warp result and the non-destructive edit recipe (design section 5.2).
 *
 * SCOPE NOTE (Group 6 / Slice F): `setOpenCvStatus` is implemented here so
 * `useDocumentDetection` can surface the OpenCV load state machine (design
 * section 4.1) to the UI — this was previously tracked ONLY in a local ref
 * inside the hook (never written to the store), which meant no component
 * could render a degraded-mode banner when OpenCV failed to load (task
 * 6.6.1). `setCaptureCapabilities`/`setDevices([])` already existed from
 * Slice C for the permission-denied (6.1) and no-camera (6.2) cases.
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

export interface CaptureActions {
  /** Stores the immutable full-res captured frame and moves the phase to 'editing-corners'. */
  readonly setOriginalFrame: (frame: CapturedFrame) => void;
  readonly setPhase: (phase: CapturePhase) => void;
  /**
   * Stores the latest warp result. Closes the previously retained
   * `warpedImage` bitmap (if any, and if it isn't the same object) BEFORE
   * assigning the new one (design section 7 memory hygiene — same close-
   * before-overwrite pattern as `setOriginalFrame`).
   */
  readonly setWarpedImage: (bitmap: ImageBitmap | null) => void;
  /** Replaces the non-destructive edit recipe (task 5.2.3 / 5.4). JSON-serializable, no binaries. */
  readonly setRecipe: (recipe: EditRecipe | null) => void;
  /** Resets the capture slice. Does NOT close any retained ImageBitmap — callers own that (design section 7). */
  readonly resetCaptureSlice: () => void;
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
  CaptureSlice &
  OpenCvSlice &
  CameraActions &
  DetectionActions &
  CaptureActions &
  OpenCvActions;

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

export type ScannerStateShape = CameraSlice & DetectionSlice & CaptureSlice & OpenCvSlice;

/**
 * Re-export for reuse by future actions/tests without re-typing the initial
 * shape (Groups 2-5 will spread these into their own reset logic).
 */
export const scannerStoreInitialState: ScannerStateShape = {
  ...initialCameraSlice,
  ...initialDetectionSlice,
  ...initialCaptureSlice,
  ...initialOpenCvSlice,
};

export const useScannerStore = create<ScannerStore>((set) => ({
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

  setOriginalFrame: (originalFrame) =>
    set((state) => {
      // Slice D review fix H1 (design section 7 memory hygiene): closing a
      // previously retained full-res ImageBitmap before overwriting it. If a
      // second capture ever races the first (auto + manual), the earlier
      // frame's bitmap would otherwise leak. `close()` on an already-consumed
      // or fake bitmap is a no-op / guarded here.
      const previous = state.originalFrame;
      if (previous && previous.source !== originalFrame.source) {
        previous.source.close();
      }
      return { originalFrame, phase: 'editing-corners' };
    }),
  setPhase: (phase) => set({ phase }),
  setWarpedImage: (bitmap) =>
    set((state) => {
      // Slice E: same close-before-overwrite hygiene as setOriginalFrame
      // (design section 7) — a stale warpedImage bitmap must never be
      // silently dropped without releasing it first.
      const previous = state.warpedImage;
      if (previous && previous !== bitmap) {
        previous.close();
      }
      return { warpedImage: bitmap };
    }),
  setRecipe: (recipe) => set({ recipe }),

  setOpenCvStatus: (patch) => set((state) => ({ opencv: { ...state.opencv, ...patch } })),

  resetCaptureSlice: () =>
    set((state) => {
      // Design section 7: resetting the capture slice discards the page /
      // starts a new capture cycle, which is exactly when the retained
      // originalFrame + warpedImage bitmaps must be released (never left
      // for the GC to eventually reclaim — a full-res ImageBitmap can be
      // tens of MB).
      state.originalFrame?.source.close();
      if (state.warpedImage) {
        state.warpedImage.close();
      }
      return { ...initialCaptureSlice };
    }),
}));
