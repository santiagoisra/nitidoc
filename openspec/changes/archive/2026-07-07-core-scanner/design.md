# Design — core-scanner (Fase 1: Core Scanner)

> Change name: `core-scanner` · Artifact store: openspec · Estado: **GREENFIELD**
> Alcance: SOLO Fase 1. Este documento es el DISEÑO TECNICO que habilita a `sdd-tasks` a cortar tareas accionables.
> La propuesta ya resolvio las decisiones de alto nivel (OpenCV.js puro en worker, single-thread, OffscreenCanvas + transferables, scaffold feature-sliced). Aca se baja a contratos, tipos, diagramas y ADRs.

---

## 0. Arquitectura de referencia (mapa de componentes)

```
                          ┌─────────────────────────── HILO PRINCIPAL (UI) ────────────────────────────┐
                          │                                                                            │
  <video> (MediaStream)   │   ┌──────────────┐   ┌────────────────────────┐   ┌───────────────────┐    │
  ──────────────────────► │   │  useCamera   │   │ useDocumentDetection   │   │   scannerStore    │    │
                          │   │  (getUM,     │──►│ (rVFC loop, downscale, │──►│   (Zustand)       │    │
                          │   │   torch,     │   │  interpolacion overlay)│   │  slices: camera,  │    │
                          │   │   settings)  │   └───────────┬────────────┘   │  detection,       │    │
                          │   └──────────────┘               │                │  capture, opencv) │    │
                          │                                   │                └───────────────────┘    │
                          │   ┌──────────────────────────┐    │  postMessage(ImageBitmap, transfer)     │
                          │   │ CameraView / Overlay      │    ▼                                         │
                          │   │ CaptureButton / Quality   │  ┌──────────────────────┐                    │
                          │   │ CornerEditor (magnifier)  │  │  WorkerClient (RPC)   │                    │
                          │   │ CameraSelector            │  │  id->Promise map      │                    │
                          │   └──────────────────────────┘  └──────────┬───────────┘                    │
                          │                                            │                                 │
                          └────────────────────────────────────────────┼─────────────────────────────────┘
                                                                       │ MessageChannel
                          ┌────────────────────────────────────────────▼─────────────────────────────────┐
                          │                        WEB WORKER (opencv.worker.ts)                          │
                          │                                                                              │
                          │   INIT ──► opencvLoader (import WASM, report progress)                        │
                          │   DETECT ─► bitmap→OffscreenCanvas→ImageData→cv.Mat→pipeline→corners+quality  │
                          │   WARP ──► ImageData+corners→getPerspectiveTransform→warpPerspective→bitmap   │
                          │   QUALITY ► (reusa Mat gris del DETECT si viene en el mismo mensaje)           │
                          │                                                                              │
                          │   geometry (DOM-free): orderCorners, isConvex, inferAspectRatio               │
                          └──────────────────────────────────────────────────────────────────────────────┘
```

**Capas / boundaries:**
- **UI (React components)** — solo presentacion + gestos. No conocen OpenCV ni el worker directamente; leen del store.
- **Hooks (`useCamera`, `useDocumentDetection`)** — orquestan MediaStream y el loop; escriben al store; hablan con el worker via `WorkerClient`.
- **`WorkerClient` (lib)** — abstrae el protocolo RPC request/response sobre `postMessage`. Un unico punto que serializa `transfer`.
- **Worker (`opencv.worker.ts`)** — 100% DOM-free. Owner de todos los `cv.Mat`. Nunca toca `document`/`window`.
- **`scannerStore` (Zustand)** — unica fuente de verdad del estado del scanner. El frame original capturado es INMUTABLE; las ediciones son una "receta".

Regla de dependencia: UI → hooks/store → WorkerClient → worker. Nunca al reves. El worker no importa nada de React ni del DOM.

---

## 1. Contrato de mensajes del Web Worker

Patron: **RPC request/response con `id` de correlacion**. Cada request lleva un `id` (monotonico) y el worker responde con el mismo `id`. Excepcion: `INIT` emite eventos de progreso intermedios (`type: 'PROGRESS'`) antes del `INIT_DONE`. El `WorkerClient` mantiene un `Map<number, {resolve, reject}>`.

### 1.1 `messages.ts` — tipos del contrato (TS strict, sin `any`)

```ts
// src/features/scanner/worker/messages.ts

/** Punto en pixeles dentro del espacio de la imagen que se envio al worker. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 4 esquinas ordenadas: [topLeft, topRight, bottomRight, bottomLeft]. */
export type Quad = readonly [Point, Point, Point, Point];

/** Metricas de calidad calculadas sobre el frame reducido. */
export interface QualityMetrics {
  /** Varianza del Laplaciano. Mayor = mas nitido. Umbral R1: calibrar en apply. */
  readonly laplacianVariance: number;
  /** Media de intensidad en gris [0..255]. Bajo = oscuro. */
  readonly meanIntensity: number;
  /** true si laplacianVariance < BLUR_THRESHOLD (valor de partida, ver §6.4). */
  readonly isBlurry: boolean;
  /** true si meanIntensity < DARK_THRESHOLD (valor de partida, ver §6.4). */
  readonly isDark: boolean;
}

/** Aspect ratios reconocidos para inferencia. */
export type AspectRatioName = 'a4' | 'letter' | 'ticket' | 'unknown';

export interface AspectRatio {
  readonly name: AspectRatioName;
  /** ancho/alto normalizado (siempre <= 1 para portrait). */
  readonly ratio: number;
}

// ─────────────── Requests (main → worker) ───────────────

export interface InitRequest {
  readonly id: number;
  readonly type: 'INIT';
}

export interface DetectRequest {
  readonly id: number;
  readonly type: 'DETECT';
  /** Frame reducido (~640px ancho). Se transfiere (zero-copy). */
  readonly bitmap: ImageBitmap;
  /** Si true, ademas de esquinas devuelve QualityMetrics reusando el Mat gris. */
  readonly withQuality: boolean;
}

export interface WarpRequest {
  readonly id: number;
  readonly type: 'WARP';
  /**
   * Frame full-res ya extraido como ImageData en el hilo principal.
   * Se transfiere su .data.buffer (ArrayBuffer, zero-copy).
   */
  readonly image: ImageDataLike;
  /** Esquinas en el espacio de coordenadas de `image` (full-res). */
  readonly corners: Quad;
  /** Aspect ratio elegido (auto inferido u override manual). */
  readonly aspectRatio: AspectRatioName;
}

/** ImageData plano, seguro para postMessage con transfer del buffer. */
export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export type WorkerRequest = InitRequest | DetectRequest | WarpRequest;

// ─────────────── Responses (worker → main) ───────────────

export interface ProgressEvent {
  readonly id: number;
  readonly type: 'PROGRESS';
  /** 0..1. Best-effort; ver §4 sobre por que puede ser indeterminado. */
  readonly progress: number;
}

export interface InitDoneResponse {
  readonly id: number;
  readonly type: 'INIT_DONE';
}

export interface DetectResponse {
  readonly id: number;
  readonly type: 'DETECT_RESULT';
  /**
   * Esquinas en el espacio del bitmap enviado (reducido), o null si no se
   * hallo cuadrilatero convexo de 4 lados con area suficiente.
   */
  readonly corners: Quad | null;
  /** Presente solo si el request pidio withQuality. */
  readonly quality: QualityMetrics | null;
}

export interface WarpResponse {
  readonly id: number;
  readonly type: 'WARP_RESULT';
  /** Imagen deswarpeada. Se transfiere de vuelta (zero-copy). */
  readonly bitmap: ImageBitmap;
  /** Dimensiones de salida elegidas por el warp. */
  readonly outWidth: number;
  readonly outHeight: number;
}

export interface ErrorResponse {
  readonly id: number;
  readonly type: 'ERROR';
  readonly code: WorkerErrorCode;
  readonly message: string;
}

export type WorkerErrorCode =
  | 'OPENCV_LOAD_FAILED'
  | 'NOT_INITIALIZED'
  | 'DETECT_FAILED'
  | 'WARP_FAILED'
  | 'INVALID_INPUT';

export type WorkerResponse =
  | ProgressEvent
  | InitDoneResponse
  | DetectResponse
  | WarpResponse
  | ErrorResponse;
```

### 1.2 Que se transfiere vs que se clona

| Mensaje | Payload pesado | Mecanismo | Nota |
|---|---|---|---|
| `DETECT` (→worker) | `ImageBitmap` | **transfer** `[bitmap]` | zero-copy. El worker lo dibuja en un `OffscreenCanvas` interno y hace `getImageData`. |
| `DETECT_RESULT` (→main) | `Quad` + `QualityMetrics` | clon (structured clone) | Son objetos chicos (< 200 bytes); clonar es correcto. |
| `WARP` (→worker) | `ImageDataLike` (full-res) | **transfer** `[image.data.buffer]` | El `Uint8ClampedArray` se reconstruye en el worker con `new ImageData`. |
| `WARP_RESULT` (→main) | `ImageBitmap` deswarpeado | **transfer** `[bitmap]` | El main lo pinta o lo guarda como frame de la "receta". |
| `INIT` / `PROGRESS` / `INIT_DONE` | — | clon | payload trivial. |

**Por que `DETECT` transfiere `ImageBitmap` pero `WARP` transfiere `ImageData`:**
- En DETECT el frame reducido se genera en el main con `createImageBitmap(video, {resizeWidth})` — `ImageBitmap` es la salida natural y transferible de esa API, y no hay necesidad de pixeles en el main.
- En WARP el main YA tiene el frame full-res como pixeles (extraidos para el editor de esquinas / previsualizacion). Reenviar `ImageData` evita un roundtrip extra a `ImageBitmap`. Su `.data.buffer` es transferible.

> Contrato de propiedad de memoria: **transferir invalida el objeto en el emisor**. El emisor NO debe volver a leer un bitmap/buffer transferido. El `WorkerClient` lo documenta y el emisor descarta la referencia inmediatamente tras `postMessage`.

### 1.3 `WorkerClient` (RPC) — forma

```ts
// src/features/scanner/lib/workerClient.ts (contrato, no implementacion completa)
export interface WorkerClient {
  init(onProgress: (p: number) => void): Promise<void>;
  detect(bitmap: ImageBitmap, withQuality: boolean): Promise<DetectResponse>;
  warp(image: ImageDataLike, corners: Quad, aspectRatio: AspectRatioName): Promise<WarpResponse>;
  terminate(): void;
}
```
- `init` resuelve en `INIT_DONE`, propaga `PROGRESS` por callback.
- `detect`/`warp` resuelven/rechazan por `id`. `ERROR` con el mismo `id` → `reject(new WorkerError(code, message))`.
- **Backpressure de DETECT:** el loop de deteccion NO encola. Si hay un DETECT en vuelo, el frame nuevo se descarta (drop-latest). Ver §2.

---

## 2. Diagramas de secuencia (Mermaid)

### 2.1 Loop de deteccion en vivo

```mermaid
sequenceDiagram
    participant V as <video> (MediaStream)
    participant H as useDocumentDetection
    participant WC as WorkerClient
    participant W as opencv.worker
    participant S as scannerStore
    participant O as Overlay (UI)

    Note over H: rVFC (o rAF fallback) loop mientras !document.hidden
    loop cada frame (con drop si worker ocupado)
        H->>H: ¿worker ocupado? si → drop frame
        H->>V: createImageBitmap(video, {resizeWidth: 640})
        V-->>H: ImageBitmap (reducido)
        H->>WC: detect(bitmap, withQuality=true)
        WC->>W: postMessage(DETECT, transfer:[bitmap])
        W->>W: bitmap→OffscreenCanvas→getImageData→cv.Mat
        W->>W: gray→blur→Canny→findContours→approxPolyDP(4)
        W->>W: orderCorners + isConvex; Laplacian+mean (reusa gray)
        W-->>WC: DETECT_RESULT {corners|null, quality}
        WC-->>H: resolve(DETECT_RESULT)
        H->>H: interpolar esquinas (lerp con las previas, anti-jitter)
        H->>S: set detection.corners, detection.quality, detection.stability
        S-->>O: overlay re-render (contorno teal interpolado)
        H->>H: actualizar buffer de estabilidad (varianza < umbral ~800ms?)
        alt estable y auto-captura ON
            H->>S: set capture.countdown = 3..2..1
            H->>H: disparar captura (ver 2.2)
        end
    end
    Note over W: cada cv.Mat se libera con .delete() en finally
```

Notas de diseño del loop:
- **Fuente de frames:** `HTMLVideoElement.requestVideoFrameCallback` (rVFC) donde exista; fallback `requestAnimationFrame`. rVFC evita procesar el mismo frame dos veces.
- **Drop-latest:** una sola inferencia en vuelo. Evita crecer una cola de bitmaps (cada uno consume memoria en iOS). El frame nuevo que llega con el worker ocupado se descarta sin crear bitmap.
- **Interpolacion anti-jitter:** las esquinas mostradas son `lerp(prev, nuevo, α)` con α ~0.35 (valor de partida). Suaviza sin agregar latencia perceptible. Si `corners == null`, se hace fade-out del overlay, no salto brusco.
- **Estabilidad:** buffer circular de las ultimas N esquinas; se computa varianza de cada punto. Si toda varianza < umbral por ~800ms → estable. Umbral y ventana son valores de partida (calibrar en apply).

### 2.2 Captura → warp

```mermaid
sequenceDiagram
    participant U as Usuario / Auto-captura
    participant H as useCamera / useDocumentDetection
    participant V as <video> / ImageCapture
    participant CE as CornerEditor (UI)
    participant WC as WorkerClient
    participant W as opencv.worker
    participant S as scannerStore

    U->>H: capturar (FAB manual o auto por estabilidad)
    H->>H: pausar loop de deteccion
    alt ImageCapture disponible
        H->>V: ImageCapture.takePhoto() / grabFrame()
        V-->>H: Blob / ImageBitmap full-res
    else fallback
        H->>V: drawImage(video) sobre canvas al tamaño real
        V-->>H: ImageData full-res
    end
    H->>H: aplicar cap 16MP (downscale si w*h > 16_777_216)
    H->>S: set capture.originalFrame = <inmutable> (ImageBitmap/ImageData)
    H->>H: escalar esquinas detectadas del espacio 640px → full-res
    H->>CE: abrir editor con esquinas iniciales (o esquinas del frame si null)
    Note over CE: usuario arrastra handles (lupa magnificadora); valida convexidad
    CE->>CE: isConvex(quad)? habilita "Confirmar"
    U->>CE: Confirmar (o al soltar handle: preview)
    CE->>H: corners finales (full-res)
    H->>H: extraer ImageData full-res del originalFrame
    H->>WC: warp(imageData, corners, aspectRatio)
    WC->>W: postMessage(WARP, transfer:[data.buffer])
    W->>W: new ImageData→cv.Mat(src); calcular outW/outH por aspectRatio+lados
    W->>W: getPerspectiveTransform(src,dst) + warpPerspective
    W->>W: mat.data→ImageData→OffscreenCanvas.putImageData→transferToImageBitmap
    W-->>WC: WARP_RESULT {bitmap, outW, outH}  (transfer:[bitmap])
    WC-->>H: resolve
    H->>S: set capture.warpedImage + receta {corners, aspectRatio, rotation:0, flip:false}
    H->>H: originalFrame.close() diferido? NO — se retiene para re-warp no destructivo
    Note over H: liberar ImageData intermedias; revokeObjectURL de cualquier blob temporal
```

Puntos clave:
- **Re-warp no destructivo:** el `originalFrame` se retiene mientras la pagina este en edicion, para poder re-warpear si el usuario cambia esquinas/aspect ratio o rota. Se libera al descartar la pagina o salir del flujo (ver §7).
- **Rotacion/volteo post-warp** NO re-invocan el worker: son transformaciones baratas que van en la "receta" y se aplican al pintar/exportar (CSS transform en preview; canvas al exportar en fases futuras). Fase 1 solo necesita mostrarlas.

---

## 3. ADR-001 — Build de OpenCV.js: prebuilt oficial single-thread vs build custom recortado

**Estado:** Aceptada. **Contexto R3/R7** (delegado por la propuesta).

### Contexto
El build generico de OpenCV.js pesa ~8–10 MB (WASM + glue JS). Fase 1 solo usa un subconjunto de `imgproc`: `cvtColor`, `GaussianBlur`, `Canny`, `findContours`, `approxPolyDP`, `getPerspectiveTransform`, `warpPerspective`, `Laplacian`, y utilidades de `core` (`Mat`, `MatVector`, `minMaxLoc`/`meanStdDev`). Un build recortado con Emscripten (`opencv_js.config.py` limitando white-list a `imgproc` + `core`) puede bajar el WASM a un rango estimado de ~2–4 MB. Pero requiere toolchain Emscripten + Docker + tiempo de setup (R7).

### Decision
**Fase 1 usa el prebuilt oficial single-thread de OpenCV.js** (release `opencv.js` sin threads/SIMD-threads), servido como asset lazy. **NO** se construye un build custom en Fase 1.

Se deja el build custom recortado como **optimizacion diferida y documentada** (candidata natural para Fase 4, junto con el cache `CacheFirst` de Workbox que amortiza el peso).

### Rationale
1. **Time-to-value:** el prebuilt desbloquea todo el pipeline hoy, sin friccion de toolchain. La Fase 1 es la mas riesgosa del roadmap; agregarle una dependencia de build de Emscripten multiplica el riesgo sin beneficio para el criterio de aceptacion ("warp correcto"), que no depende del peso.
2. **El peso NO esta en el bundle inicial:** OpenCV sale 100% por `import()` lazy al entrar al escaner. El presupuesto < 200KB gzip se cumple igual con el prebuilt. El costo es una descarga unica al primer uso del escaner.
3. **Riesgo de correctitud del custom build:** un white-list mal recortado rompe en runtime (simbolo faltante) de formas dificiles de diagnosticar. El prebuilt esta probado por la comunidad.
4. **Amortizacion futura:** en Fase 4 (PWA) el WASM se cachea con `CacheFirst`; la segunda carga es instantanea y offline. Eso reduce el incentivo de pagar la friccion del custom build ahora.

### Consecuencias
- (+) Arranque de Fase 1 sin dependencia de Emscripten; menos superficie de fallo.
- (+) `opencvLoader` es simple: `fetch`/`import` del asset oficial.
- (−) Primera carga del escaner descarga ~8 MB (mitigado: solo la primera vez por sesion; Fase 4 lo cachea).
- (−) Se paga el costo de transferencia hasta Fase 4.

### Fallback / camino de optimizacion
Si en apply se mide que la descarga del prebuilt es prohibitiva en 4G para el testing prioritario, el fallback es construir el custom recortado con este pin de config (white-list `core` + `imgproc` + las funciones listadas arriba) y sustituir el asset sin cambiar `opencvLoader` (mismo contrato). Marcado como **verificacion empirica opcional** — no bloquea Fase 1.

---

## 4. Estrategia de lazy-load + progreso de OpenCV.js

### 4.1 Maquina de estados de carga (slice `opencv` del store)

```
        enterScanner()
 idle ──────────────► loading ──(INIT_DONE)──► ready
   ▲                    │                         │
   │                    │(fetch/instantiate fail) │(usable para DETECT/WARP)
   │                    ▼                         │
   └──── reset ──── error ◄──────────────────────┘
              (backoff retry)   (modo degradado manual disponible en cualquier error)
```

Tipos:
```ts
export type OpenCvStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface OpenCvState {
  readonly status: OpenCvStatus;
  readonly progress: number;        // 0..1, best-effort
  readonly progressIndeterminate: boolean;
  readonly retryCount: number;
  readonly lastError: string | null;
}
```

### 4.2 Como se dispara
- **Trigger:** al montar la ruta del escaner (o al primer intento de abrir camara / importar imagen), `useDocumentDetection` llama `workerClient.init(onProgress)` una sola vez (idempotente; si ya esta `ready`/`loading`, no re-dispara).
- **No preload en Home:** respeta la regla 2.1.1 (OpenCV jamas en el arranque de la app).

### 4.3 Como se reporta progreso
- El worker carga el WASM. Dos caminos segun disponibilidad de bytes:
  1. **Con progreso real:** `fetch(wasmUrl)` + `response.body.getReader()` para leer `Content-Length` y bytes acumulados → emite `PROGRESS {progress}` incremental; luego instancia el modulo. `progressIndeterminate = false`.
  2. **Sin `Content-Length` o carga via loader oficial que no expone bytes:** emite un `PROGRESS` inicial y marca `progressIndeterminate = true`; la UI muestra spinner indeterminado en vez de barra. Es lo que se asume por defecto si el asset no da longitud.
- Cuando el runtime esta listo (`cv` operativo, `cv.onRuntimeInitialized` resuelto) → `INIT_DONE`.

> No se inventa una API de progreso de OpenCV: el progreso proviene del stream de descarga del `.wasm` (Fetch Streams API, estandar), no de OpenCV. Si no hay `Content-Length`, degradamos a indeterminado.

### 4.4 Manejo de fallo (backoff + degradado)
- `INIT` falla (`OPENCV_LOAD_FAILED`) → estado `error`, `lastError` seteado.
- **Backoff:** reintento manual desde UI ("Reintentar") y/o automatico con backoff exponencial acotado: delays de partida `1s, 2s, 4s`, maximo 3 reintentos, luego solo manual. `retryCount` en el store.
- **Modo degradado manual:** en `error` (o si el usuario lo elige), el flujo cae a **captura + editor manual de esquinas con frame completo**. En degradado:
  - No hay DETECT (sin overlay en vivo, sin auto-captura, sin quality hints por Laplaciano).
  - El WARP tambien requiere OpenCV; por lo tanto en degradado TOTAL (OpenCV nunca carga) el warp no esta disponible. La red de seguridad de producto es: capturar el frame completo y permitir recorte por esquinas con **warp diferido** — si OpenCV se recupera en un reintento, se warpea; si no, se entrega el frame recortado sin correccion de perspectiva como ultimo recurso.
  - Este matiz se marca como **decision de producto a confirmar en apply**: cuan lejos llega el degradado sin OpenCV. Diseño recomienda: degradado = permitir capturar y editar esquinas, y warpear en cuanto OpenCV este disponible; nunca bloquear la captura por la carga de WASM.

---

## 5. Modelo de estado (Zustand)

### 5.1 Forma del store (slices)

```ts
// src/features/scanner/store/scannerStore.ts (forma; TS strict, sin any)

export interface CameraSlice {
  readonly stream: MediaStream | null;
  readonly devices: readonly MediaDeviceInfo[];
  readonly activeDeviceId: string | null;
  readonly realResolution: { width: number; height: number } | null; // getSettings()
  readonly torchSupported: boolean;
  readonly torchOn: boolean;
  readonly permission: 'idle' | 'prompt' | 'granted' | 'denied';
  readonly imageCaptureSupported: boolean;
  readonly offscreenSupported: boolean; // determina camino worker vs ImageData en main
}

export interface DetectionSlice {
  readonly corners: Quad | null;          // interpoladas (espacio 640px)
  readonly rawCorners: Quad | null;       // ultima cruda del worker (para estabilidad)
  readonly quality: QualityMetrics | null;
  readonly stability: number;             // 0..1 (1 = totalmente estable)
  readonly autoCaptureEnabled: boolean;
  readonly countdown: 0 | 1 | 2 | 3;      // 0 = inactivo
  readonly noDetectionSince: number | null; // timestamp; dispara hint a los 5s
}

export interface CaptureSlice {
  /** Frame original INMUTABLE. Nunca se muta. */
  readonly originalFrame: CapturedFrame | null;
  /** Resultado warpeado actual (derivado de originalFrame + recipe). */
  readonly warpedImage: ImageBitmap | null;
  /** Receta de ediciones no destructivas. */
  readonly recipe: EditRecipe | null;
  readonly phase: 'idle' | 'capturing' | 'editing-corners' | 'warping' | 'done';
}

export interface OpenCvSlice {
  readonly opencv: OpenCvState; // ver §4.1
}

export type ScannerStore = CameraSlice & DetectionSlice & CaptureSlice & OpenCvSlice & {
  // actions (nombres indicativos; el corte de tareas los detalla)
  readonly setCorners: (interpolated: Quad | null, raw: Quad | null) => void;
  readonly setQuality: (q: QualityMetrics | null) => void;
  readonly beginCapture: () => void;
  readonly setOriginalFrame: (frame: CapturedFrame) => void;
  readonly setRecipe: (recipe: EditRecipe) => void;
  readonly setWarped: (bitmap: ImageBitmap, out: { width: number; height: number }) => void;
  readonly setOpenCvStatus: (patch: Partial<OpenCvState>) => void;
  readonly resetCapture: () => void; // libera recursos (§7)
};
```

### 5.2 Frame inmutable + "receta" JSON no destructiva

```ts
/** El frame capturado a full-res. Contenedor inmutable. */
export interface CapturedFrame {
  readonly source: ImageBitmap;        // full-res, retenido para re-warp
  readonly width: number;
  readonly height: number;
  readonly capturedAt: number;
}

/** Receta de ediciones. Se aplica sobre CapturedFrame para derivar warpedImage. */
export interface EditRecipe {
  readonly corners: Quad;              // en coordenadas de CapturedFrame (full-res)
  readonly aspectRatio: AspectRatioName;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly flipH: boolean;
  readonly flipV: boolean;
}
```

**Patron no destructivo (clave arquitectonica que reusan Fases 2–6):**
- `CapturedFrame.source` es la unica materia prima. Nunca se muta ni se pisa.
- Toda edicion (mover esquinas, cambiar aspect ratio, rotar, voltear) muta SOLO `recipe` (un objeto plano JSON-serializable).
- `warpedImage` es un **derivado cacheado**: se recomputa invocando el worker `WARP` cuando cambian `corners`/`aspectRatio`; `rotation`/`flipH`/`flipV` se aplican en la capa de presentacion (CSS transform) sin re-warpear.
- Ventaja: undo trivial (restaurar receta previa), re-export en otra calidad (Fases futuras), y el original queda intacto. En Fase 1 hay una sola pagina, pero el patron ya queda establecido.
- **Serializable:** `EditRecipe` no contiene handles a `ImageBitmap`/`Mat`; es JSON puro. Los binarios viven fuera de la receta (en `CapturedFrame`).

> Nota Zustand: guardar `ImageBitmap`/`MediaStream` en el store es aceptable (no se serializa el store en Fase 1; el `persist` middleware es de Fase 4 y solo persistira la receta + blobs en IndexedDB, no los objetos vivos).

---

## 6. Geometria (algoritmos concretos, DOM-free)

Vive en `src/features/scanner/lib/geometry.ts`. Sin dependencias del DOM ni de OpenCV para poder testear con Vitest en Node. (El worker puede importarlo o reimplementar equivalentes sobre `cv.Point`; el diseño recomienda una unica implementacion pura reutilizada.)

### 6.1 Orden de esquinas con normalizacion para documentos rotados (riesgo R5)

El heuristico clasico (TL=min(x+y), BR=max(x+y), TR=min(y−x), BL=max(y−x)) **falla cuando el documento esta rotado ~45° o mas**, porque las sumas/restas dejan de discriminar. Diseño: **normalizar por el centroide y el angulo dominante antes de etiquetar**.

```
function orderCorners(points: Point[4]): Quad
  c = centroid(points)
  // 1. Ordenar por angulo polar alrededor del centroide (sentido horario).
  sorted = sortBy(points, p => atan2(p.y - c.y, p.x - c.x))   // -π..π
  // sorted queda en orden angular consistente (un ciclo del cuadrilatero)

  // 2. Elegir el vertice inicial = el mas cercano a la esquina superior-izquierda
  //    del bounding box rotado. Estrategia robusta a rotacion:
  //    tomar como TL el punto con menor (x+y) SOLO tras rotar los puntos
  //    para alinear el lado mas largo con el eje horizontal.
  angle = dominantEdgeAngle(sorted)          // angulo del lado mas largo
  rotated = rotatePoints(sorted, -angle, c)  // desrota alrededor del centroide
  tlIndex = argmin(rotated, p => p.x + p.y)  // en espacio desrotado, el heuristico SI vale

  // 3. Reordenar el ciclo para empezar en tlIndex, y garantizar sentido:
  ordered = rotateArray(sorted, tlIndex)     // [TL, ?, ?, ?] en orden angular
  // Forzar orden CW: [TL, TR, BR, BL]
  if signedArea(ordered) < 0: ordered = [ordered[0], ordered[3], ordered[2], ordered[1]]
  return ordered as Quad
```

Sub-rutinas:
- `dominantEdgeAngle(quad)`: angulo (`atan2`) del lado de mayor longitud. Da el "arriba" real del documento aunque este rotado.
- `signedArea(quad)`: shoelace; el signo define orientacion (CW vs CCW).

> **Verificacion empirica requerida (R5):** validar con fixtures de documentos rotados a 0°, 30°, 45°, 90° y casi-vertical invertido. Si `dominantEdgeAngle` produce ambiguedad en cuadrados perfectos (lados iguales), caer al heuristico de sumas como desempate. Marcado para apply.

### 6.2 Test de convexidad

```
function isConvex(quad: Quad): boolean
  // El cuadrilatero es convexo sii los 4 productos cruzados consecutivos
  // tienen el MISMO signo (todos > 0 o todos < 0). Cero => colineal (degenerado).
  signs = []
  for i in 0..3:
    a = quad[i]; b = quad[(i+1)%4]; c = quad[(i+2)%4]
    cross = (b.x - a.x)*(c.y - b.y) - (b.y - a.y)*(c.x - b.x)
    if cross == 0: return false        // colineal: degenerado
    signs.push(sign(cross))
  return allEqual(signs)
```
- Se usa en `CornerEditor` para habilitar "Confirmar" solo con cuadrilatero valido, y en el worker para descartar contornos no convexos (→ `corners: null` → fallback frame completo).

### 6.3 Inferencia de aspect ratio (A4 / carta / ticket con tolerancias)

```
const RATIOS = [
  { name: 'a4',     ratio: 210/297 },   // ≈ 0.7071
  { name: 'letter', ratio: 8.5/11 },    // ≈ 0.7727
  // 'ticket': angosto, alto/ancho grande; se detecta por umbral, no por match exacto
]
const TOLERANCE = 0.06   // valor de partida (calibrar en apply)

function inferAspectRatio(quad: Quad): AspectRatio
  wTop    = dist(quad[0], quad[1]); wBottom = dist(quad[3], quad[2])
  hLeft   = dist(quad[0], quad[3]); hRight  = dist(quad[1], quad[2])
  w = (wTop + wBottom) / 2
  h = (hLeft + hRight) / 2
  r = min(w, h) / max(w, h)          // normalizado a portrait (<= 1)

  if (max(w,h) / min(w,h)) >= 2.4:   // muy alargado
    return { name: 'ticket', ratio: r }
  best = argmin(RATIOS, k => abs(k.ratio - r))
  if abs(best.ratio - r) <= TOLERANCE:
    return { name: best.name, ratio: best.ratio }
  return { name: 'unknown', ratio: r }   // usar dimensiones medidas tal cual
```

### 6.4 Calculo de dimensiones de salida del warp (en el worker)

```
function outputSize(corners: Quad, aspect: AspectRatioName): {outW, outH}
  wMeasured = avg(dist(TL,TR), dist(BL,BR))
  hMeasured = avg(dist(TL,BL), dist(TR,BR))
  portrait  = hMeasured >= wMeasured
  switch aspect:
    'a4':     ratio = 210/297
    'letter': ratio = 8.5/11
    'ticket': ratio = wMeasured/hMeasured   // preservar lo medido
    'unknown':return {outW: round(wMeasured), outH: round(hMeasured)}
  // fijar el lado mayor a lo medido y derivar el otro con el ratio conocido
  if portrait: outH = round(hMeasured); outW = round(outH * ratio)
  else:        outW = round(wMeasured); outH = round(outW * ratio)
  // dst corners = [[0,0],[outW,0],[outW,outH],[0,outH]]
```

Constantes calibrables (centralizadas en un modulo de constantes, expuestas para tuning en apply):
```ts
export const DETECTION = {
  DOWNSCALE_WIDTH: 640,        // R: resolucion de deteccion en vivo
  BLUR_THRESHOLD: 100,         // R1: varianza laplaciana a 640px — VALOR DE PARTIDA
  DARK_THRESHOLD: 60,          // media de intensidad; oscuro por debajo — partida
  STABILITY_MS: 800,           // ventana de estabilidad
  STABILITY_VARIANCE_PX: 4,    // varianza de esquina bajo la cual es "estable" — partida
  INTERP_ALPHA: 0.35,          // suavizado de overlay
  NO_DETECTION_MS: 5000,       // hint "capturar igual"
  ASPECT_TOLERANCE: 0.06,
  MAX_CAPTURE_PIXELS: 16_777_216, // cap iOS (16MP exactos)
} as const;
```

---

## 7. Manejo de recursos / memoria (reglas duras)

Estas reglas son NORMATIVAS. Cada tarea que cree uno de estos recursos DEBE cerrar el ciclo.

| Recurso | Regla de liberacion |
|---|---|
| `cv.Mat`, `cv.MatVector` | SIEMPRE `.delete()` en un bloque `finally`. Ni un `Mat` sale de su funcion sin due-o de liberacion. En el worker, patron: crear todos los Mats al inicio del try, `delete()` de cada uno en finally (guardas `if (mat && !mat.isDeleted())`). |
| `ImageBitmap` | `.close()` en cuanto deja de usarse. Frames de DETECT: el worker cierra el bitmap tras `getImageData`. En el main, el bitmap transferido ya no es propiedad del main (no cerrar lo transferido). El `warpedImage` previo se `close()` antes de asignar uno nuevo. |
| Cap de 16MP | Antes de crear cualquier canvas/OffscreenCanvas de captura: si `width*height > MAX_CAPTURE_PIXELS`, downscale proporcional para que `w*h <= 16_777_216`. Se aplica en el MAIN antes de transferir (el worker asume input ya capado). |
| `URL.createObjectURL` | Todo `createObjectURL` tiene su `revokeObjectURL` emparejado. Blobs de `takePhoto()` se revocan tras convertir a bitmap/ImageData. |
| `MediaStream` | Al salir del escaner / permiso perdido / `resetCapture`: `stream.getTracks().forEach(t => t.stop())`. |
| `OffscreenCanvas` interno del worker | Reutilizar un unico OffscreenCanvas por tipo de operacion (no crear uno por frame) para no presionar el GC. Redimensionar via `.width/.height` cuando cambie el tamaño. |
| `Worker` | `terminate()` al desmontar el escaner definitivamente (no en cada captura). |

**Ciclo de vida de `CapturedFrame.source` (no destructivo):**
- Se retiene mientras la pagina este en edicion (permite re-warp).
- Se `close()` en `resetCapture()` (descartar pagina, nueva captura, o salir del flujo).
- Al asignar un nuevo `originalFrame`, el anterior se `close()` primero.

> Regla de oro iOS: en el path de captura, liberar agresivo. Un `ImageBitmap` full-res de 12MP ocupa ~48MB; retener dos simultaneos en un iPhone de gama media puede matar la pestaña.

---

## 8. Fallbacks (matriz de degradacion)

| Condicion | Deteccion | Camino de diseño |
|---|---|---|
| **Sin `OffscreenCanvas`** (Safari < 16.4) | `typeof OffscreenCanvas === 'undefined'` o falla `transferControlToOffscreen`. Se refleja en `camera.offscreenSupported=false`. | El worker NO usa OffscreenCanvas interno para extraer pixeles. En su lugar, el MAIN extrae `ImageData` (dibuja el bitmap/video en un `<canvas>` del hilo principal) y envia `ImageDataLike` tanto para DETECT como para WARP (transfiriendo el buffer). El worker opera solo con `cv.matFromImageData`. Para la salida del WARP sin OffscreenCanvas, el worker devuelve `ImageDataLike` (no `ImageBitmap`) y el main lo pinta. **Contrato flexible:** `WARP_RESULT` puede devolver `ImageBitmap` (con OffscreenCanvas) o `ImageDataLike` (sin) — la union se resuelve por `offscreenSupported`. Se añade a `messages.ts` una variante `WarpResponseImageData` para este camino. |
| **Sin camara** (desktop sin `videoinput`) | `enumerateDevices()` sin `videoinput`, o `getUserMedia` rechaza con `NotFoundError`. | Ocultar viewfinder; mostrar fallback `captureFallback.ts`: `<input type="file" accept="image/*">` (single, sin drag&drop/HEIC — eso es Fase 6). La imagen elegida se decodifica a `ImageBitmap`, se aplica cap 16MP, y entra al MISMO pipeline: se puede correr DETECT una vez sobre ella (frame reducido) para pre-poblar esquinas, luego editor + WARP. |
| **`ImageCapture` ausente** (iOS Safari) | `typeof ImageCapture === 'undefined'`. `camera.imageCaptureSupported=false`. | Capturar via `ctx.drawImage(video, 0, 0, realW, realH)` sobre canvas al tamaño real del track (`getSettings()`), luego `getImageData`/`transferToImageBitmap`. Aplica cap 16MP. |
| **Permiso denegado** | `getUserMedia` rechaza con `NotAllowedError`. `camera.permission='denied'`. | Pantalla con instrucciones por navegador (Safari/Chrome/Firefox) para rehabilitar + boton al fallback de import. |
| **OpenCV load fail** | `ERROR OPENCV_LOAD_FAILED`. `opencv.status='error'`. | Backoff (§4.4) + modo degradado manual: captura + editor de esquinas con frame completo; warp diferido cuando OpenCV se recupere. |
| **No deteccion en 5s** | `noDetectionSince` supera `NO_DETECTION_MS`. | Hint "Apoya el documento sobre fondo liso y oscuro" + boton "Capturar igual" → captura full-res → editor con esquinas iniciales en las 4 esquinas del frame. |
| **Contorno no convexo / esquina fuera de frame** | `DETECT_RESULT.corners == null` (worker ya filtro por `isConvex`), o esquina fuera de `[0,w]×[0,h]`. | Overlay no se dibuja; auto-captura no dispara. Al capturar, editor con frame completo (esquinas en las esquinas del frame). |
| **`visibilitychange` → hidden** | `document.visibilityState === 'hidden'`. | Pausar loop (cancelar rVFC/rAF), NO detener el track (se reanuda rapido); reanudar al `visible`. Si estuvo oculto mucho tiempo y el track murio, re-`getUserMedia`. |

Adicion a `messages.ts` para el fallback sin OffscreenCanvas:
```ts
export interface WarpResponseImageData {
  readonly id: number;
  readonly type: 'WARP_RESULT_IMAGEDATA';
  readonly image: ImageDataLike;   // transfer:[image.data.buffer]
  readonly outWidth: number;
  readonly outHeight: number;
}
// WorkerResponse incluye tambien WarpResponseImageData.
```

---

## 9. ADRs restantes (cortas)

### ADR-002 — RPC con `id` de correlacion + drop-latest en DETECT
- **Contexto:** el loop de deteccion emite frames a ~30–60fps; el worker no puede seguir ese ritmo. Un protocolo naive encolaria bitmaps y crashea iOS por memoria.
- **Decision:** protocolo request/response con `id`; una sola inferencia DETECT en vuelo; frames nuevos con worker ocupado se descartan (no se crea el bitmap).
- **Consecuencias:** (+) memoria acotada, sin backlog; (+) latencia percibida baja (siempre el frame mas reciente); (−) FPS de deteccion limitado por el worker, aceptable para overlay interpolado.

### ADR-003 — Salida del warp via `mat.data → ImageData → transferToImageBitmap` (no `cv.imshow`)
- **Contexto:** `cv.imshow` sobre `OffscreenCanvas` no esta confirmado en todas las builds (R4).
- **Decision:** extraer `mat.data`, construir `ImageData`, `OffscreenCanvas.putImageData`, `transferToImageBitmap()`. En fallback sin OffscreenCanvas, devolver `ImageDataLike` directo.
- **Consecuencias:** (+) camino confirmado y portable; (−) una copia extra de pixeles, despreciable frente a la robustez.

### ADR-004 — `geometry.ts` puro y compartido (testeable en Node)
- **Contexto:** el orden de esquinas y la convexidad son la logica mas propensa a bugs (R5) y la que mas valor tiene testear.
- **Decision:** implementar geometria como funciones puras sin DOM ni OpenCV, sobre `Point`/`Quad`. El worker y el `CornerEditor` la reutilizan.
- **Consecuencias:** (+) Vitest cubre el nucleo riesgoso sin browser; (+) una sola fuente de verdad de orden/convexidad; (−) el worker duplica la conversion `cv.Point ↔ Point`, costo trivial.

### ADR-005 — Rotacion/volteo en la receta, no en el worker
- **Contexto:** rotar/voltear son baratos y frecuentes; re-invocar el worker por cada rotacion es derroche.
- **Decision:** `rotation`/`flipH`/`flipV` viven en `EditRecipe` y se aplican en presentacion (CSS transform en Fase 1; canvas al exportar en fases futuras). Solo `corners`/`aspectRatio` disparan re-warp.
- **Consecuencias:** (+) UI instantanea para rotar/voltear; (+) no destructivo; (−) el "resultado final pixel-perfecto" con rotacion se materializa recien al exportar (fuera de Fase 1).

### ADR-006 — Fallback de import minimo comparte el pipeline (no un camino aparte)
- **Contexto:** el criterio de aceptacion exige funcionar en desktop sin camara.
- **Decision:** `<input type="file">` decodifica a `ImageBitmap` y entra al MISMO pipeline DETECT→editor→WARP. No se crea logica de warp separada para import.
- **Consecuencias:** (+) una sola ruta de correccion de perspectiva; (+) menos superficie de test; (−) el fallback arrastra la carga de OpenCV igual (aceptable).

---

## 10. Trazabilidad capabilities → componentes de diseño

| CAP (propuesta §5) | Componentes/artefactos de diseño que lo habilitan |
|---|---|
| CAP-1 Camara | `useCamera`, `CameraSlice`, `CameraSelector`, feature-detect torch/ImageCapture (§8) |
| CAP-2 Deteccion en vivo | Loop §2.1, `DETECT` (§1), interpolacion `INTERP_ALPHA`, `DetectionSlice` |
| CAP-3 Auto-captura | Buffer de estabilidad §2.1, `STABILITY_*`, `countdown` en `DetectionSlice` |
| CAP-4 Captura de frame | Secuencia §2.2, cap 16MP §7, `CapturedFrame`, ImageCapture/drawImage §8 |
| CAP-5 Feedback de calidad | `QUALITY`/`QualityMetrics` (§1), `BLUR_THRESHOLD`/`DARK_THRESHOLD`, `QualityHints` (aria-live) |
| CAP-6 Editor de esquinas | `CornerEditor`, `isConvex` §6.2, lupa magnificadora, re-warp al soltar §2.2 |
| CAP-7 Warp | `WARP` (§1), `getPerspectiveTransform`/`warpPerspective`, `outputSize` §6.4, `inferAspectRatio` §6.3 |
| CAP-8 Rotacion/volteo | `EditRecipe` §5.2, ADR-005 |
| CAP-9 Carga OpenCV | `opencvLoader`, maquina de estados §4, `OpenCvSlice` |
| CAP-10 Fallbacks | Matriz §8, backoff §4.4, degradado manual |

---

## 11. Notas para `sdd-tasks` (que NO decide el diseño, se cierra en apply)

Marcado explicitamente como verificacion empirica (no fijar como final en tasks):
- **R1** — `BLUR_THRESHOLD` / `DARK_THRESHOLD` a 640px: valores de partida en §6.4; calibrar con dispositivos reales.
- **R5** — orden de esquinas con documentos rotados (§6.1): validar con fixtures 0/30/45/90°; desempate para cuadrados.
- **Umbral de estabilidad** (`STABILITY_VARIANCE_PX`, `STABILITY_MS`): valores de partida; ajustar por feel.
- **Alcance del degradado sin OpenCV** (§4.4): confirmar en apply cuan lejos llega la captura+edicion sin WASM.
- **Progreso de carga**: real (Fetch Streams) o indeterminado segun `Content-Length` del asset — verificar contra el asset oficial en apply.

Restricciones que tasks DEBE respetar:
- TS `strict: true`, sin `any`. Todos los tipos del contrato en `messages.ts`.
- Bundle inicial < 200KB gzip; OpenCV 100% lazy (fuera del bundle).
- Nada de multipagina/filtros/PDF/firma/PWA/Firebase (fases posteriores).
- No inventar APIs de navegador/OpenCV; feature-detect antes de usar (torch, ImageCapture, OffscreenCanvas).
</content>
</invoke>
