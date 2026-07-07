# Proposal — multipage-filters (Fase 2: Gestion multipagina + Filtros)

> Change name: `multipage-filters` · Artifact store: openspec · Depends on: `core-scanner` (F1, archived) ·
> Scope: SOLO Fase 2. Esta propuesta resuelve las decisiones de alto nivel; `sdd-spec` y `sdd-design` bajan a contratos.

Fase 2 convierte al scanner single-page de F1 en un **capturador multipagina con filtros de realce**.
Un usuario escanea varias hojas en una sola sesion (bandeja de captura continua), reordena/borra paginas
en una grilla, y aplica uno de 6 filtros por pagina (o a todo el documento). Todo apoyado en el patron
no-destructivo de F1 (ADR-005): el filtro es una capa de presentacion, la receta sigue siendo JSON puro.

## Quick path (que cambia, en una pasada)

1. `CaptureSlice` (1 pagina) se **retira** y se reemplaza por `DocumentSlice` (N paginas ordenadas). Migracion directa.
2. `EditRecipe` gana un campo `filter: FilterParams`. La receta sigue siendo JSON serializable, sin binarios.
3. El worker OpenCV gana un mensaje `APPLY_FILTER` para los 3 presets adaptativos (B&N y variantes) + sharpness.
4. Nueva UI: bandeja de captura continua, grilla con reorder (@dnd-kit) y borrado con undo por toast.
5. Los tests de F1 (CornerEditor, ScannerScreen, store de captura) se **reescriben** contra la nueva forma — grupo de tareas propio.

## Two blocking unknowns — RESUELTAS

### D-MEM · Presupuesto de memoria multipagina en iOS → resuelto: "una pagina viva + originales comprimidos + cap duro"

**El problema medido:** un `ImageBitmap` full-res de 12MP ocupa ~48MB decodificado (RGBA). Con el modelo
ingenuo (cada pagina retiene `originalFrame` + `warpedImage` vivos), 5 paginas = ~450MB solo de bitmaps.
En un iPhone de gama media eso mata la pestaña. Este es el riesgo [ALTO] de la exploracion.

**Decision (supera la disyuntiva binaria de la exploracion):** ni "retener todo" ni "liberar y perder re-warp".
Adoptamos un modelo de retencion por capas:

| Recurso por pagina | Pagina ACTIVA (en edicion) | Paginas INACTIVAS (en bandeja/grilla) |
|---|---|---|
| Original full-res | `ImageBitmap` vivo (~48MB) para re-warp instantaneo | **`Blob` JPEG comprimido** (~2–4MB @ q0.85), decode on-demand |
| Warp sin filtro | `ImageBitmap` vivo para preview de filtro | **`Blob` JPEG comprimido** (baseline de export) |
| Thumbnail (grilla) | `ImageBitmap` chico (~150px) cacheado | `ImageBitmap` chico (~150px) cacheado |

- **Memoria full-res viva ≈ 1 pagina (~90MB pico), constante sin importar cuantas paginas tenga el documento.**
- **Re-warp preservado:** al reentrar al editor de esquinas de una pagina inactiva, se decodifica su `Blob`
  original a `ImageBitmap` y se re-warpea. Trade-off aceptado: el JPEG es lossy, asi que el re-warp parte de
  una version levemente degradada del original pristino — aceptable porque la mayoria de capturas ya llegan
  como JPEG de camara (ImageCapture) y la alternativa (48MB vivos/pagina) no es viable en iOS.
- **Cap duro de paginas:** 30 por documento (valor de partida, calibrar en apply — coherente con la convencion
  "valores de partida" de F1). Al alcanzarlo, la bandeja bloquea nuevas capturas con un hint claro.
- **Bonus:** los `Blob` ya son serializables → habilitan la persistencia en IndexedDB de Fase 4 sin retrabajo.

> El detalle fino del ciclo de vida (cuando materializar/comprimir/liberar, quien es dueño del `close()`)
> es trabajo de `sdd-design`. La propuesta fija el MODELO: una pagina viva, inactivas como Blob, cap duro.

### D-CV · Binding real de OpenCV para B&N → resuelto: CONFIRMADO, sin pivote

Verificacion empirica sobre `node_modules/@techstark/opencv-js@^4.10.0-release.1` (type defs):

| Funcion / constante | Presente | Ubicacion |
|---|---|---|
| `adaptiveThreshold` | ✅ | `src/types/opencv/imgproc_misc.ts:46` |
| `morphologyEx` | ✅ | `src/types/opencv/imgproc_filter.ts:529` |
| `erode` / `dilate` | ✅ | `imgproc_filter.ts:234` / `:195` |
| `getStructuringElement` | ✅ | `imgproc_filter.ts:427` |
| `ADAPTIVE_THRESH_MEAN_C` / `ADAPTIVE_THRESH_GAUSSIAN_C` | ✅ | `imgproc_misc.ts:442/450` |
| `THRESH_BINARY` / `THRESH_BINARY_INV` | ✅ | `imgproc_misc.ts:538/540` |

**Conclusion:** los filtros B&N / alto-contraste / eco proceden vía el worker OpenCV YA existente (imgproc ya
cargado, worker ya caliente). **No hay pivote de arquitectura.** `cvBindings.ts` se extiende para tipar estas
funciones nuevas (mismo patron de "narrow local typing" que ya usa el archivo). Trato empirico pendiente para
apply: calibrar `blockSize`/`C` del adaptiveThreshold y el kernel de morfologia (valores de partida en design).

## Scope

### In scope

- Reemplazo `CaptureSlice` → `DocumentSlice` (N paginas ordenadas, pagina activa, seleccion).
- `FilterParams` embebido en `EditRecipe`; los 6 presets + sliders brillo/contraste/nitidez.
- Mensaje worker `APPLY_FILTER` (presets adaptativos + sharpness por convolucion).
- Bandeja de captura continua (camara queda abierta entre paginas; thumbnails cacheados).
- Grilla de paginas con reorder drag-and-drop (@dnd-kit) y borrado con undo por toast (5s).
- Primitiva `Toast` propia en `shared/ui` (no hay libreria de toast hoy).
- Reescritura de tests de F1 impactados por la migracion de store (grupo de tareas propio).

### Out of scope (fases posteriores)

- Export a PDF / imagenes, compartir, guardado en disco → **Fase 3**.
- Persistencia en IndexedDB / offline / PWA / Workbox → **Fase 4** (aunque el modelo Blob ya la habilita).
- OCR, firma, anotaciones → **Fases 5–6**.
- Import HEIC / multi-file drag&drop → **Fase 6** (F1 dejo import single-file).
- Build custom recortado de OpenCV.js (ADR-001 lo difirio a Fase 4).
- WebGL / shaders (ver decision D3).

## Decisiones de arquitectura (forks resueltos)

| # | Fork | Decision | Rationale |
|---|---|---|---|
| D1 | Filtro en `EditRecipe` vs slice `Record<pageId,FilterParams>` | **En `EditRecipe`** | Mantiene "receta = JSON puro reconstruye todo" (ADR-005). Un solo sitio de verdad por pagina. |
| D2 | B&N por shader GLSL vs worker OpenCV | **Worker OpenCV** | Binding confirmado (D-CV); imgproc ya cargado; reimplementar adaptiveThreshold+morfologia en GLSL es alto riesgo sin beneficio. |
| D3 | Filtros de color por WebGL vs Canvas2D | **Canvas2D `ctx.filter`, sin WebGL** | Brillo/contraste/grises/saturacion se cubren con `ctx.filter` (instantaneo, main thread, cero dep). Sharpness (convolucion) y presets adaptativos van por el worker. **Rechazamos WebGL**: un segundo subsistema de render (shaders, context-loss, otra ruta) sin justificacion cuando Canvas2D + worker cubren los 6 presets. Supera la sugerencia de shaders de la exploracion. |
| D4 | `warpedImage` cacheado con filtro horneado vs sin filtro | **Sin filtro** | Consistente con ADR-005: el filtro es capa de presentacion sobre el warp base. Cambiar de preset no re-invoca el warp. |
| D5 | Migracion de store directa vs wrapper de compatibilidad | **Directa** | F1 ya en main; un wrapper agrega indireccion permanente sin beneficio. |
| D6 | Thumbnails al vuelo vs cacheados al confirmar | **Cacheados al confirmar** | Evita recompute full-res en cada render de grilla/bandeja. |
| D7 | "Aplicar filtro a todo el documento" = estado doc-level vs atajo de UI | **Atajo de UI** | Escribe el mismo `FilterParams` en la receta de cada pagina (con confirmacion, sobrescribe filtros individuales). No hay estado de filtro a nivel documento — la receta por pagina sigue siendo la unica verdad (ADR-005). |
| D8 | "Aplicar a todo" batch al worker vs por pagina | **Reescritura de recetas (instantaneo) + render perezoso** | "Aplicar a todo" solo reescribe recetas e invalida renders cacheados; el render real por el worker ocurre por pagina bajo demanda (al ver/exportar). Sin llamada gigante al worker. |

## Modelo de datos propuesto

```ts
// src/shared/types/scanner.ts
export interface FilterParams {
  readonly preset: 'original' | 'enhanced' | 'grayscale' | 'bw' | 'bw-high-contrast' | 'eco';
  readonly brightness: number; // -100..100  (0 = neutro)
  readonly contrast: number;   // -100..100  (0 = neutro)
  readonly sharpness: number;  // 0..100      (0 = off)
}

export interface EditRecipe {
  readonly corners: Quad;
  readonly aspectRatio: AspectRatioName;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly flipH: boolean;
  readonly flipV: boolean;
  readonly filter: FilterParams;   // NUEVO — sigue siendo JSON puro, sin binarios
}

// src/features/scanner/store/documentSlice.ts (reemplaza CaptureSlice)
export interface DocumentPage {
  readonly id: string;
  readonly order: number;
  readonly recipe: EditRecipe;
  readonly thumbnail: ImageBitmap;          // ~150px, cacheado al confirmar (D6)
  // Retencion por capas (D-MEM): pagina activa materializa full-res; inactivas guardan Blob.
  readonly originalBlob: Blob;              // JPEG del original full-res (decode on-demand para re-warp)
  readonly warpedBlob: Blob;               // JPEG del warp sin filtro (baseline de export/preview)
}

export interface DocumentSlice {
  readonly pages: readonly DocumentPage[];
  readonly activePageId: string | null;
  readonly selectedPageIds: readonly string[];
  /** Ventana de undo: retiene la pagina borrada (recursos sin liberar) hasta expirar el toast (5s). */
  readonly pendingDeletion: DocumentPage | null;
  readonly phase: 'idle' | 'capturing' | 'editing-corners' | 'warping' | 'tray' | 'grid' | 'done';
}
```

> Nota vs exploracion: la exploracion modelo `originalFrame: CapturedFrame` y `warpedImage: ImageBitmap` VIVOS
> por pagina. D-MEM lo corrige a `Blob` para paginas inactivas por seguridad de memoria en iOS; solo la pagina
> activa materializa `ImageBitmap` full-res (working set efimero, definido en design).

## Los 3 subsistemas

### 1. Filtros (6 presets)

| Preset | Ruta de render | Tecnica |
|---|---|---|
| `original` | Canvas2D | passthrough |
| `enhanced` (color realzado) | Canvas2D | `ctx.filter = brightness()/contrast()/saturate()` |
| `grayscale` | Canvas2D | `ctx.filter = grayscale(1)` + brillo/contraste |
| `bw` | **Worker** | gris → `adaptiveThreshold` (GAUSSIAN_C, THRESH_BINARY) |
| `bw-high-contrast` | **Worker** | adaptiveThreshold + `morphologyEx`/erode-dilate para limpiar ruido |
| `eco` | **Worker** | adaptiveThreshold con parametros que preservan gris tenue (menor tinta) |

- **Regla de enrutamiento:** si la receta requiere threshold adaptativo o `sharpness > 0` (convolucion) → render por worker; si no → Canvas2D en presentacion. Sliders brillo/contraste que acompañan un preset adaptativo se aplican dentro del pipeline del worker.
- **Preview de presets:** los 6 se previsualizan sobre el thumbnail chico (~150px). Los 3 adaptativos se batchean en UNA llamada `APPLY_FILTER` (evita 3 roundtrips), coherente con el patron RPC de F1.
- **Render de export-quality:** full-res por el worker, bajo demanda (no en cada tweak de slider).

### 2. Bandeja / captura por lote

- Tras cada `WARP_RESULT` confirmado: se genera el thumbnail (una vez), se comprimen original+warp a `Blob`, se hace `append` a `pages[]`, y **la camara permanece abierta** reusando el patron de `handleEditorCancel` de F1 (retoma `startDetection`).
- UI de bandeja: tira horizontal de thumbnails cacheados al pie de la camara + contador de paginas + boton "Listo" → pasa a grilla o cierre.
- Nunca se re-renderiza el full-res para pintar la bandeja (D6).

### 3. Grilla + reorder + undo

- Nuevas deps: **`@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`**. Feature de grilla **lazy-loaded** (aisla el peso de dnd-kit del bundle inicial; respeta el presupuesto < 200KB gzip de F1).
- `onDragEnd`: recalcula `order` de TODO el array (no update parcial) para evitar huecos/duplicados.
- Borrado con **undo por toast (5s)**: primitiva `Toast` propia en `shared/ui` + `pendingDeletion` en el store que retiene el `DocumentPage` completo (recursos SIN liberar) durante la ventana. Al expirar → liberacion dura (close thumbnails, drop Blobs). Al "Deshacer" → reinsertar en su `order`.

## Nuevas dependencias

| Dependencia | Motivo | Nota |
|---|---|---|
| `@dnd-kit/core` | drag base de la grilla | lazy-load del feature |
| `@dnd-kit/sortable` | reorder de lista/grid | — |
| `@dnd-kit/utilities` | helpers de transform (peer de sortable) | — |
| — (WebGL) | **NO se agrega** | D3: Canvas2D + worker cubren los 6 presets |
| — (toast lib) | **NO se agrega** | primitiva propia en `shared/ui` |

`@techstark/opencv-js` ya esta en `package.json` (F1) — no cambia; solo se extiende `cvBindings.ts`.

## Nota de migracion (grupo de tareas propio, primero en el corte)

Cambio **no-aditivo** que rompe superficie de F1. Debe ser el primer grupo de `sdd-tasks`:

- Retirar `CaptureSlice` y sus acciones (`setOriginalFrame`, `setWarpedImage`, `setRecipe`, `resetCaptureSlice`, `setPhase`); introducir `DocumentSlice` + acciones (`addPage`, `setActivePage`, `updateRecipe`, `reorderPages`, `deletePage`/`restorePage`, `setPhase`).
- Reescribir `ScannerScreen.tsx` y `CornerEditor` para leer/escribir la **pagina activa** en vez de la unica pagina.
- **Reescribir los tests de F1** que asumen la forma single-page: tests de store de captura, `CornerEditor`, `ScannerScreen`. Presupuestar como trabajo propio, no como "arreglo colateral".
- Preservar intactas las reglas de higiene de memoria de F1 (§7 del design de F1): close-before-overwrite, cap 16MP, un solo OffscreenCanvas por operacion en el worker.

## Acceptance criteria

- [ ] Se pueden capturar >=2 paginas en una sesion continua sin perder las anteriores; la camara queda abierta entre paginas.
- [ ] La grilla muestra todas las paginas por `order`; el drag-and-drop reordena y persiste el nuevo `order` sin huecos/duplicados.
- [ ] Borrar una pagina muestra un toast con "Deshacer" por 5s; deshacer la restaura en su posicion; al expirar se libera memoria.
- [ ] Los 6 presets se aplican por pagina y se previsualizan sobre el thumbnail; B&N/alto-contraste/eco pasan por el worker OpenCV.
- [ ] Cambiar de preset o mover un slider NO re-invoca el warp (solo re-render de presentacion o `APPLY_FILTER`).
- [ ] "Aplicar a todo el documento" escribe el filtro en cada pagina (con confirmacion) y es instantaneo (D8).
- [ ] La memoria full-res viva se mantiene ~1 pagina; escanear 10+ paginas no crashea en iOS (verificacion empirica en apply).
- [ ] `EditRecipe` sigue siendo JSON serializable (sin `ImageBitmap`/`Blob`/`Mat`): las recetas se pueden clonar/serializar.
- [ ] `tsc --noEmit` sin `any`; los tests de F1 reescritos pasan; el bundle inicial sigue < 200KB gzip (dnd-kit lazy).

## Riesgos abiertos (para spec/design/apply)

- **[MEDIO]** Parametros de `adaptiveThreshold` (blockSize/C) y kernel de morfologia: valores de partida en design; calibrar en apply con documentos reales.
- **[MEDIO]** Sharpness por convolucion en el worker: costo real full-res no prototipado; medir en apply.
- **[MEDIO]** Compresion JPEG del original (q0.85) degrada el re-warp: validar calidad percibida aceptable en apply.
- **[BAJO]** Impacto de bundle de @dnd-kit: confirmar que el lazy-load mantiene el presupuesto.
- **[BAJO]** UX exacta de "seleccion multiple" (`selectedPageIds`) para acciones batch: refinar en spec.
