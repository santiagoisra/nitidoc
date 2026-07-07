# Proposal — core-scanner (Fase 1: Core Scanner)

> Change name: `core-scanner` · Artifact store: openspec · Estado del proyecto: **GREENFIELD**
> Alcance: SOLO Fase 1 del roadmap (seccion 9 del prompt maestro). No incluye multipagina, filtros, PDF, firma, PWA-offline ni Firebase.

---

## 1. Why / Intent

**Problema que resuelve la Fase 1:** hoy Nitidoc es solo un prompt maestro sin una linea de codigo. La Fase 1 entrega el nucleo insustituible de un escaner de documentos: convertir la camara del dispositivo en un capturador que detecta un documento en vivo, lo captura y corrige su perspectiva para producir una imagen "escaneada" plana y recta. Sin esto, ninguna fase posterior (filtros, PDF, firma, sync) tiene materia prima sobre la cual operar.

**Valor:**
- Es el diferencial percibido del producto: "apuntas y sale derecho". Todo lo demas es post-procesado.
- Es la parte tecnicamente mas riesgosa (camara + WASM + Web Worker + limites de iOS), por lo que resolverla primero desbloquea y desriesga el resto del roadmap.
- Establece el esqueleto arquitectonico (scaffold feature-sliced, worker de OpenCV, patron de imagenes inmutables + receta) que las Fases 2-6 reutilizan sin reescribir.

**Como se ve el exito:** un usuario en movil o desktop abre el escaner, apunta a un documento, ve el contorno en vivo, captura (auto o manual), ajusta esquinas si hace falta, y obtiene una imagen deswarpeada correctamente. Este es exactamente el criterio de aceptacion del roadmap: *"Escaneo de 1 pagina con warp correcto en movil y desktop"*.

---

## 2. Scope

### 2.1 In scope (Fase 1)

| Capacidad | Referencia prompt |
|---|---|
| Scaffold greenfield minimo (Vite + React 18 + TS strict + Tailwind + tokens + Zustand) | secc. 1.2, 2, 5 |
| Apertura de camara trasera + selector de camara + torch (si el device lo soporta) | F1 (secc. 3.1) |
| Deteccion de documento en vivo con overlay del contorno (interpolado, sin jitter) | F1 |
| Auto-captura por estabilidad de esquinas + countdown + toggle a manual (FAB) | F1 |
| Feedback de calidad: "acercate", "muy oscuro", "manten firme" (blur laplaciano) | F1 |
| Captura del frame full-res (con cap por limite de 16MP de iOS) | F1, secc. 6 |
| Deteccion automatica de 4 esquinas + editor manual (handles + lupa + validacion convexa) | F3 (secc. 3.2) |
| Warp de perspectiva (`warpPerspective`) con aspect ratio inferido + override manual | F3 |
| Rotacion 90 y volteo post-warp (edicion simple de la pagina resultante) | F3 |
| Worker de OpenCV.js (deteccion + warp fuera del hilo de UI, con `OffscreenCanvas`) | secc. 2.1.2 |
| Lazy-load de OpenCV.js WASM con indicador de progreso (sin cache SW aun) | secc. 2.1.1 (parcial) |
| Casos borde de captura: permiso denegado, sin camara (fallback import minimo), no-deteccion en 5s, contorno no convexo, fallo de carga de OpenCV, `visibilitychange` | secc. 6 |
| Harness de testing listo (Vitest + Playwright configurados, sin suite completa aun) | secc. 2, 10 |

### 2.2 Out of scope (fases posteriores — NO tocar en esta fase)

| Fuera de alcance | Va en |
|---|---|
| Modo lote / bandeja de multiples paginas | Fase 2 |
| Los 6 filtros (WebGL shaders) y ajustes finos brillo/contraste | Fase 2 |
| Grilla multipagina, reorden drag & drop (dnd-kit) | Fase 2 |
| Export PDF (pdf-lib), ZIP (JSZip) | Fase 3 |
| Firma (signature_pad) | Fase 3 |
| Web Share / File System Access / imprimir | Fase 3 |
| PWA: manifest, service worker, Workbox `CacheFirst` de WASM, install prompt, offline | Fase 4 |
| Persistencia IndexedDB (`idb`), biblioteca de documentos | Fase 4 |
| Firebase Auth/Firestore/Storage, reglas, sync offline | Fase 5 |
| Import de imagenes completo (drag&drop, HEIC, Web Share Target) | Fase 6 (solo un fallback minimo "elegir imagen" entra en Fase 1 por el criterio desktop) |
| CSP/COOP/COEP en Firebase Hosting | Fase 4/5 (single-thread en Fase 1 lo difiere) |

**Nota sobre el import minimo:** el criterio de aceptacion exige que funcione en desktop, y muchos desktops no tienen camara. Por eso Fase 1 incluye un fallback minimo de "elegir imagen desde archivo" (`<input type="file" accept="image/*">`) que alimenta el mismo pipeline de deteccion/warp. NO se implementa drag&drop, multiple, HEIC ni Web Share Target — eso queda para Fase 6. Es la superficie minima para cumplir "warp correcto en desktop".

---

## 3. Enfoque tecnico / decisiones de arquitectura

### 3.1 DECISION CLAVE — jscanify vs OpenCV.js puro en el worker

**Fork:** el prompt maestro (secc. 2) lista `jscanify + OpenCV.js` como stack de deteccion, y la regla 2.1.2 exige que deteccion y warp corran en un **Web Worker**. La exploracion confirmo que `jscanify` retorna `HTMLCanvasElement` y depende del DOM en varios de sus metodos (`extractPaper`, `highlightPaper`), y no esta garantizado que su modulo importe limpio en un Worker sin referenciar `document`/`window` en el top-level.

**Decision: adoptar Opcion B de la exploracion — reimplementar el pipeline de deteccion/warp con OpenCV.js puro dentro del worker.** `jscanify` NO entra como dependencia del worker.

**Pipeline DOM-free a implementar en `opencv.worker.ts`:**
```
cv.matFromImageData(imageData)
  -> cv.cvtColor (RGBA -> GRAY)
  -> cv.GaussianBlur
  -> cv.Canny  (o adaptiveThreshold; calibrar en apply)
  -> cv.findContours
  -> seleccionar contorno de mayor area
  -> cv.approxPolyDP  (buscar poligono de 4 lados)
  -> ordenar esquinas: TL=min(x+y), BR=max(x+y), TR=min(y-x), BL=max(y-x)
  -> cv.getPerspectiveTransform(srcCorners, dstCorners)
  -> cv.warpPerspective(src, dst, M, cv.Size(outW, outH))
```

**Rationale:**
- Cumple la regla 2.1.2 al pie (100% DOM-free, corre en worker sin hacks).
- El algoritmo de deteccion de papel es exactamente el que jscanify implementa internamente; reimplementarlo con `cv.Mat` es codigo conocido y auditado, no invencion.
- Menos superficie de dependencia: una libreria menos que mantener/actualizar, y control total sobre el tuning de umbrales (critico para el riesgo de calibracion laplaciana).
- Habilita en Fase 1/design evaluar un **build custom recortado de OpenCV.js** (solo imgproc: contornos + perspectiva + Laplacian), reduciendo el peso del lazy-load muy por debajo de los ~8MB del build generico.

**Tradeoff aceptado:** perdemos la conveniencia de las funciones helper de jscanify y debemos escribir/testear el pipeline manual. Se mitiga porque el algoritmo esta bien documentado y porque nos da el control de tuning que igual necesitariamos. `jscanify` queda como **referencia de algoritmo**, no como dependencia — no se lista en `package.json`.

> Verificacion empirica requerida en apply: el orden de esquinas por sumas/restas asume orientacion aproximadamente vertical del documento; validar con documentos rotados y aplicar normalizacion antes de `getPerspectiveTransform`.

### 3.2 Worker + OffscreenCanvas + transferables

- **Transferencia hilo->worker:** `createImageBitmap(video)` en el hilo principal, `postMessage(bitmap, { transfer: [bitmap] })` (zero-copy). En el worker se dibuja el `ImageBitmap` en un `OffscreenCanvas` interno -> `getImageData` -> `cv.matFromImageData` (no hay conversion directa `ImageBitmap`->`cv.Mat`).
- **Transferencia worker->hilo (salida del warp):** en vez de depender de `cv.imshow` sobre `OffscreenCanvas` (no confirmado en todas las builds), extraer `mat.data` -> `new ImageData(...)` -> `OffscreenCanvas.putImageData` -> `transferToImageBitmap()` -> devolver el `ImageBitmap` con `transfer`. Camino seguro y confirmado.
- **Contrato de mensajes** (a detallar en design): `INIT` (cargar WASM), `DETECT` (frame reducido -> esquinas), `WARP` (frame full-res + 4 esquinas -> ImageBitmap deswarpeado), `QUALITY` (blur/iluminacion, reusando el Mat gris). El calculo de calidad reusa el `cv.Mat` gris ya computado para contornos.
- **Fallback sin OffscreenCanvas** (Safari < 16.4): streaming de `ImageData`/`ImageBitmap` sin `OffscreenCanvas` interno; el worker recibe `ImageData` ya extraida en el hilo principal. Se marca como camino degradado.
- **Higiene de memoria:** `ImageBitmap.close()` y `URL.revokeObjectURL()` agresivos tras cada captura (critico en iOS). Todo `cv.Mat` se libera con `.delete()` en `finally`.

### 3.3 Build de OpenCV.js — single-thread WASM

**Decision: usar el build single-thread de OpenCV.js, sin SIMD-threads, en Fase 1.**

**Rationale:**
- Bug confirmado (OpenCV GitHub #25790, #25956): OpenCV.js con WASM threads falla dentro de un Web Worker.
- Threads requieren `SharedArrayBuffer`, que exige headers `COOP: same-origin` + `COEP: require-corp`. Esos headers pueden romper el popup OAuth de Firebase Auth en Fase 5. Single-thread evita configurar COOP/COEP y difiere ese conflicto.
- El prompt maestro (secc. 8.2) ya sugiere explicitamente esta salida ("si complica, usar build single-thread").
- SIMD sin threads es una mejora segura a evaluar despues; no bloquea Fase 1.

**Lazy-load:** OpenCV.js se carga via `import()` dinamico SOLO al entrar al modo escaner, con indicador de progreso. En Fase 1 NO se configura el cache `CacheFirst` de Workbox (eso es Fase 4); la carga sale de red cada vez, aceptable para el alcance actual.

### 3.4 Camara (`useCamera`)

- `getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } })`. Usar `ideal` (no `exact`) para permitir fallback en desktop sin camara trasera. Leer `track.getSettings()` tras abrir para conocer la resolucion **real** (el 4K no esta garantizado en gama media).
- Selector de camara: `enumerateDevices()` filtrando `kind === 'videoinput'` (requiere permiso previo para tener `label`).
- Torch: chequear `track.getCapabilities().torch` ANTES de `applyConstraints({ advanced: [{ torch: true }] })`. Torch es device-gated (iPhone y webcams de laptop no lo exponen): ocultar el boton si no esta disponible, nunca asumir.
- Feature-detect de `ImageCapture` con fallback a `drawImage(video)` sobre canvas (soporte de `ImageCapture` en iOS Safari es parcial/inexistente).
- `visibilitychange`: pausar loop de deteccion y detener frames cuando `document.hidden`, reanudar al volver.

### 3.5 Estado (Zustand)

- Un store de scanner: estado de camara (device seleccionado, torch on/off, resolucion real), estado de deteccion (esquinas actuales interpoladas, estabilidad, calidad), estado de captura (frame capturado, esquinas editadas), y estado de carga de OpenCV (idle/loading/progress/ready/error).
- Patron de imagen inmutable: el frame capturado original nunca se muta; las ediciones (esquinas, rotacion, volteo) se guardan como una "receta" JSON que se aplica al renderizar/exportar (secc. 5 del prompt). Fase 1 establece este patron aunque solo tenga una pagina.

---

## 4. Impacto — estructura y dependencias

### 4.1 Estructura de archivos a crear (feature-sliced, alineada a secc. 5)

```
nitidoc/
├── index.html
├── package.json
├── tsconfig.json                 # strict: true, sin any
├── vite.config.ts                # + config Vitest
├── tailwind.config.ts
├── postcss.config.js
├── playwright.config.ts
├── src/
│   ├── main.tsx
│   ├── app/
│   │   ├── App.tsx               # layout + ruta unica al escaner (Fase 1)
│   │   └── providers/            # theme/store providers si hacen falta
│   ├── styles/
│   │   └── tokens.css            # CSS variables de la seccion 1.2
│   ├── features/
│   │   └── scanner/
│   │       ├── worker/
│   │       │   ├── opencv.worker.ts      # pipeline deteccion + warp (DOM-free)
│   │       │   └── messages.ts           # tipos del contrato de mensajes
│   │       ├── hooks/
│   │       │   ├── useCamera.ts
│   │       │   └── useDocumentDetection.ts
│   │       ├── components/
│   │       │   ├── CameraView.tsx        # <video> + overlay de contorno
│   │       │   ├── CaptureButton.tsx     # FAB 72px, anillo animado
│   │       │   ├── CornerEditor.tsx      # handles + lupa + validacion convexa
│   │       │   ├── QualityHints.tsx      # aria-live warnings
│   │       │   └── CameraSelector.tsx
│   │       ├── lib/
│   │       │   ├── opencvLoader.ts       # lazy-load + progreso
│   │       │   ├── geometry.ts           # orden esquinas, convexidad, aspect ratio
│   │       │   └── captureFallback.ts    # <input type=file> minimo (desktop)
│   │       └── store/
│   │           └── scannerStore.ts       # Zustand
│   ├── shared/
│   │   ├── ui/                   # design system base (Button, Sheet, Toast...)
│   │   ├── lib/                  # utilidades transversales
│   │   └── types/
│   └── editor/                   # placeholder de feature (rotacion/volteo Fase 1)
├── tests/
│   ├── unit/                     # Vitest (geometry, ordenamiento esquinas)
│   └── e2e/                      # Playwright (harness listo, fixture de imagen)
└── public/
    └── fonts/                    # Inter self-hosted (subset latin)
```

> Se crean SOLO las carpetas de feature que Fase 1 toca (`scanner`, y un minimo de `editor`/`shared`). NO se crean `document/`, `signature/`, `library/`, `sync/`, `sw/` todavia.

### 4.2 Dependencias que ENTRAN ahora

**Runtime:**
- `react`, `react-dom` (18.x)
- `zustand`
- OpenCV.js WASM — **no via npm generico**; se decide en design entre el prebuilt oficial y un build custom recortado (secc. 3.3). Se sirve como asset lazy, no en el bundle inicial.

**Dev / build:**
- `vite`, `@vitejs/plugin-react`
- `typescript`
- `tailwindcss`, `postcss`, `autoprefixer`
- `vitest`, `@testing-library/react`, `jsdom` (o `happy-dom`)
- `@playwright/test`
- `lucide-react` (iconografia, secc. 1.2)

**Dependencias que NO entran todavia** (fases posteriores): `jscanify` (queda como referencia de algoritmo, ver 3.1), `pdf-lib`, `signature_pad`, `vite-plugin-pwa`/`workbox`, `idb`, `firebase`, `browser-image-compression`, `heic2any`, `jszip`, `dnd-kit`.

### 4.3 Presupuesto de performance (secc. 2.1.5)

- Bundle inicial objetivo **< 200KB gzip** sin contar OpenCV. React 18 + Zustand + Tailwind (purgado) + el shell del scanner deben caber; OpenCV.js sale 100% por lazy-load dinamico y NO cuenta.
- Deteccion en vivo a ~640px de ancho (frame reducido); captura final a full-res con cap por 16MP.

---

## 5. Requisitos de alto nivel (capabilities → los convierte `sdd-spec` en Given/When/Then)

- **CAP-1 Camara — apertura y control:** abrir camara trasera por defecto; leer resolucion real; enumerar y seleccionar entre multiples camaras; feature-detect y toggle de torch/flash; pausar/reanudar en `visibilitychange`.
- **CAP-2 Deteccion en vivo:** detectar contorno del documento en cada frame reducido; dibujar overlay del contorno en `--color-primary-light` interpolando esquinas entre frames (sin jitter); actualizar estado de esquinas actuales.
- **CAP-3 Auto-captura:** detectar estabilidad de esquinas (varianza bajo umbral durante ~800ms); mostrar countdown de 3 puntos; disparar captura automatica; toggle para desactivar y usar FAB manual.
- **CAP-4 Captura de frame:** capturar el frame a resolucion completa (con cap por limite de 16MP de iOS); via `ImageCapture` o fallback `drawImage`; liberar recursos (`ImageBitmap.close`, `revokeObjectURL`).
- **CAP-5 Feedback de calidad:** analizar cada frame para producir hints "acercate mas", "muy oscuro" (histograma), "manten firme" (varianza laplaciana); exponer via `aria-live`.
- **CAP-6 Editor de esquinas:** mostrar 4 handles arrastrables sobre el frame capturado; lupa magnificadora bajo el dedo; validar cuadrilatero convexo antes de habilitar confirmar; recalcular warp al soltar (no en cada frame de arrastre).
- **CAP-7 Warp / correccion de perspectiva:** aplicar `getPerspectiveTransform` + `warpPerspective` a las 4 esquinas; inferir aspect ratio (A4/carta/ticket) con override manual; devolver imagen deswarpeada.
- **CAP-8 Rotacion / volteo:** rotar 90 y voltear la imagen resultante (edicion post-warp, no destructiva sobre el original — parte de la "receta").
- **CAP-9 Carga de OpenCV:** lazy-load del WASM al entrar al escaner, con indicador de progreso; estados idle/loading/ready/error.
- **CAP-10 Casos borde / fallbacks:** permiso de camara denegado (instrucciones + fallback import); sin camara en desktop (fallback import minimo); no-deteccion en 5s (hint + "capturar igual" -> editor con frame completo); contorno no convexo/esquina fuera de frame (frame completo + editor manual); fallo de carga de OpenCV (reintento con backoff + modo degradado manual).

---

## 6. Riesgos y plan de rollback

### 6.1 Riesgos (de la exploracion + esta propuesta)

| # | Riesgo | Severidad | Mitigacion |
|---|---|---|---|
| R1 | Umbral de varianza laplaciana sin valor universal para camara movil a 640px | Media | Empezar con valores de partida (~100 a 640px), calibrar empiricamente en apply con dispositivos reales; exponer el umbral como constante configurable. Marcado como **verificacion empirica requerida**. |
| R2 | `ImageCapture`/torch parcial o inexistente en iOS Safari (navegador prioritario de test) | Media-alta | Feature-detection obligatoria; fallback `drawImage`; ocultar boton de torch si no hay capacidad. Comunicar como limitacion conocida, no bug. |
| R3 | Tamano del build de OpenCV.js (~8MB generico) | Media | Evaluar en design un build custom recortado (solo imgproc: contornos, perspectiva, Laplacian). Lazy-load ya lo saca del bundle inicial. |
| R4 | `cv.imshow` sobre `OffscreenCanvas` no confirmado | Baja | Usar el camino seguro `mat.data` -> `ImageData` -> `putImageData` -> `transferToImageBitmap` (ya adoptado en 3.2). |
| R5 | Orden de esquinas por sumas/restas falla con documentos muy rotados | Media | Normalizar orientacion antes de `getPerspectiveTransform`; validar con fixtures rotados. **Verificacion empirica.** |
| R6 | Resolucion "ideal" 4K vs hardware real de gama media | Baja | Leer `track.getSettings()`; no asumir 4K; convivir con cap de 16MP. |
| R7 | Build custom de OpenCV.js requiere toolchain Emscripten (friccion de setup) | Media | Si el custom build complica el arranque, usar prebuilt oficial single-thread en Fase 1 y diferir la optimizacion de peso. Decision de design. |
| R8 | Bundle inicial > 200KB gzip | Baja-media | Purgar Tailwind, `import()` dinamico agresivo, verificar con `rollup-plugin-visualizer` en apply. |

### 6.2 Plan de rollback (requerido por config.yaml)

Como es greenfield, el rollback es de bajo riesgo por naturaleza (no hay produccion ni datos de usuario que romper). Aun asi:

- **Rollback de scaffold:** todo el trabajo vive en una rama de feature; si el scaffold resulta inadecuado, se descarta la rama sin impacto (no hay `main` desplegado). El scaffold es reproducible desde esta propuesta.
- **Rollback del fork OpenCV.js puro:** si la reimplementacion del pipeline no alcanza calidad de deteccion aceptable en apply, el fallback es (a) volver a evaluar jscanify SOLO en el hilo principal (fuera del worker, aceptando una excepcion documentada a la regla 2.1.2 para la deteccion en vivo, manteniendo el warp en worker), o (b) reintroducir jscanify como dependencia con las funciones DOM-free tras verificar su fuente. El warp con OpenCV.js puro se mantiene en ambos casos.
- **Rollback del build single-thread:** si single-thread resulta demasiado lento para deteccion en vivo, el siguiente paso NO es threads (bug conocido) sino SIMD-sin-threads o bajar la resolucion de deteccion por debajo de 640px. Cambiar a threads+COOP/COEP queda explicitamente vetado en Fase 1.
- **Modo degradado permanente disponible:** ante cualquier fallo de OpenCV (carga o calidad), la app cae a "captura + editor manual de esquinas con frame completo", que sigue cumpliendo el criterio de aceptacion (warp manual correcto). Esto actua como red de seguridad de producto, no solo de rollback tecnico.

---

## 7. Criterios de aceptacion de Fase 1

1. **Criterio del roadmap (secc. 9):** un usuario puede escanear 1 pagina con **warp correcto en movil y desktop**.
2. En movil con camara: abrir camara trasera, ver contorno en vivo, auto-captura por estabilidad (o captura manual con FAB), y obtener la pagina deswarpeada.
3. En desktop sin camara: usar el fallback de import minimo, detectar/editar esquinas y obtener la pagina deswarpeada.
4. El editor manual de esquinas permite corregir una deteccion imperfecta (handles + lupa + validacion convexa) y el warp resultante es visiblemente recto.
5. La deteccion y el warp corren en un Web Worker (el hilo de UI no se bloquea durante el procesamiento).
6. OpenCV.js se carga lazy con indicador de progreso y NO esta en el bundle inicial.
7. Casos borde cubiertos: permiso denegado, sin camara, no-deteccion en 5s, contorno no convexo, fallo de carga de OpenCV, `visibilitychange` — todos con su fallback funcional.
8. Bundle inicial < 200KB gzip (sin OpenCV); TS `strict: true` sin `any`.
9. Harness de testing operativo: Vitest corre al menos un test unit de geometria (orden de esquinas/convexidad) y Playwright tiene un E2E de humo con fixture de imagen.

> Los umbrales que dependen de calibracion empirica (R1, R5) se fijan durante apply con dispositivos reales; en spec/design se documentan como valores de partida, no como constantes finales.
