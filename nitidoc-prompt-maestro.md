# NITIDOC — Prompt maestro de desarrollo (0 → 100)

> **Instrucción para el agente de desarrollo:** Sos un equipo senior de desarrollo full-stack especializado en PWAs de alto rendimiento. Tu tarea es construir **Nitidoc**, una Progressive Web App de escaneo de documentos completa, gratuita y sin límites artificiales, siguiendo TODAS las especificaciones de este documento. No omitas features. No uses placeholders. Cada módulo debe quedar funcional y testeado antes de pasar al siguiente. El proyecto se despliega en **Firebase** (Hosting + Auth + Firestore + Storage).

---

## 1. Identidad del producto

### 1.1 Nombre y concepto
- **Nombre:** Nitidoc (de "nítido" + "documento")
- **Tagline:** *"Escaneá sin límites. Desde cualquier dispositivo."*
- **Propuesta de valor:** Todas las funciones que las apps de escaneo cobran (multipágina, filtros, firma, exportación PDF, sin marca de agua) — gratis, en el navegador, instalable como app, funcionando offline.
- **Idioma de la UI:** Español (es-AR) como default, con i18n preparado para en/pt.

### 1.2 Sistema de diseño

**Paleta de colores:**

| Token | Hex | Uso |
|---|---|---|
| `--color-primary` | `#0EA5A4` (teal 600) | Botón de captura, CTAs, acentos |
| `--color-primary-dark` | `#0B7C7B` | Hover/pressed |
| `--color-primary-light` | `#5EEAD4` | Highlights, bordes de detección |
| `--color-bg` | `#0F172A` (slate 900) | Fondo modo cámara y app (dark-first) |
| `--color-surface` | `#1E293B` (slate 800) | Cards, sheets, toolbars |
| `--color-surface-light` | `#F8FAFC` | Modo claro (opcional, fase 2) |
| `--color-text` | `#F1F5F9` | Texto principal |
| `--color-text-muted` | `#94A3B8` | Texto secundario |
| `--color-success` | `#22C55E` | Confirmaciones, "documento detectado" |
| `--color-warning` | `#F59E0B` | Alertas de calidad (borroso, poca luz) |
| `--color-danger` | `#EF4444` | Eliminar página, errores |
| `--color-overlay` | `rgba(15,23,42,0.75)` | Overlays de cámara |

**Justificación:** dark-first porque el uso principal es la cámara (fondo oscuro reduce distracción y consumo en OLED). El teal transmite precisión/limpieza y contrasta bien sobre papel blanco en el viewfinder.

**Tipografía:**
- UI: `Inter` (variable, self-hosted, subsets latin)
- Números/metadata: `Inter` tabular-nums
- Escala: 12 / 14 / 16 / 20 / 24 / 32 px, line-height 1.5

**Componentes base:** botones (primary / secondary / ghost / danger), bottom sheet, toast, modal de confirmación, stepper de páginas (thumbnails arrastrables), slider (para ajustes de filtro), FAB de captura estilo obturador (72px, anillo animado al detectar documento).

**Iconografía:** Lucide icons. Ícono de app: hoja de papel con esquina doblada + destello de escaneo en teal sobre fondo slate. Generar en 192/512/maskable para el manifest.

**Accesibilidad:** contraste AA mínimo, targets táctiles ≥44px, `aria-live` para estados de detección, soporte completo de teclado en desktop, `prefers-reduced-motion`.

---

## 2. Stack técnico

| Capa | Tecnología | Motivo |
|---|---|---|
| Framework | **React 18 + TypeScript + Vite** | DX, tree-shaking, ecosistema |
| Estado | **Zustand** | Simple, sin boilerplate, persist middleware |
| Estilos | **Tailwind CSS** + CSS variables (tokens de arriba) | Velocidad + theming |
| Detección de documentos | **jscanify + OpenCV.js (WASM)** | Open source (MIT), detección de contornos, corrección de perspectiva, supresión de glare |
| Procesamiento de imagen | **Canvas API + WebGL shaders propios** | Filtros en tiempo real sin dependencias pesadas |
| PDF | **pdf-lib** | Creación/modificación de PDF 100% client-side, TypeScript, sin dependencias |
| Firma | **signature_pad** | Captura de firma manuscrita en canvas (trazo suavizado) |
| PWA | **vite-plugin-pwa (Workbox)** | Service worker, precache, estrategias de cache |
| Persistencia local | **IndexedDB vía `idb`** | Blobs de páginas y documentos offline-first |
| Backend | **Firebase**: Hosting, Auth (anónimo + Google), Firestore, Storage | Ya disponible en la cuenta del usuario |
| Compresión | **browser-image-compression** | Reducir peso antes de subir a Storage |
| Testing | Vitest + Playwright | Unit + E2E (flujo de escaneo completo) |

### 2.1 Reglas críticas de performance
1. **OpenCV.js (~8 MB WASM) NUNCA se carga en el bundle inicial.** Lazy-load solo al entrar al modo escáner, con indicador de progreso. Cachearlo con Workbox (`CacheFirst`) para que la segunda carga sea instantánea y funcione offline.
2. Toda la detección de contornos y el warp de perspectiva corren en un **Web Worker** (usar `OffscreenCanvas` donde esté disponible) — el hilo de UI jamás se bloquea.
3. Detección en vivo sobre el stream a **resolución reducida (ej. 640px de ancho)**; la captura final se toma del frame a resolución completa.
4. Filtros con WebGL para preview en tiempo real; fallback a Canvas 2D + `filter` si WebGL no está disponible.
5. Presupuesto: bundle inicial < 200 KB gzip (sin contar OpenCV lazy), TTI < 3s en 4G, Lighthouse PWA score 100.

---

## 3. Funcionalidades (especificación completa)

### 3.1 Captura

**F1 — Escaneo con cámara en vivo:**
- Abrir cámara trasera por defecto: `getUserMedia({ video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } } })`, con selector de cámara si hay varias.
- Overlay en tiempo real: contorno del documento detectado dibujado en `--color-primary-light` con animación suave (interpolar esquinas entre frames para evitar jitter).
- **Auto-captura:** cuando el contorno se mantiene estable (varianza de esquinas < umbral durante ~800ms), countdown visual de 3 puntos y captura automática. Toggle para desactivarla y capturar manual con el FAB.
- Feedback de calidad: warnings "Acercate más", "Muy oscuro" (analizar histograma), "Mantené firme" (blur por varianza laplaciana).
- Flash/torch si el dispositivo lo soporta (`ImageCapture` API / `applyConstraints({ advanced: [{ torch: true }] })`).
- **Modo lote (batch):** tras cada captura, la página se agrega a una bandeja inferior con thumbnail y contador; la cámara sigue abierta para escanear la siguiente página sin fricción. Este es el flujo default.

**F2 — Importar imágenes:**
- `<input type="file" accept="image/*" multiple>` + drag & drop en desktop + Web Share Target (recibir imágenes compartidas desde otras apps cuando la PWA está instalada — configurar `share_target` en el manifest).
- Cada imagen importada pasa por el mismo pipeline de detección automática de documento.
- Soportar HEIC con conversión (heic2any, lazy-loaded solo si se detecta el formato).

### 3.2 Edición de página

**F3 — Corrección de perspectiva:**
- Detección automática de las 4 esquinas con jscanify (`findPaperContour` + `getCornerPoints`).
- **Editor manual de esquinas:** vista con las 4 esquinas arrastrables (handles grandes + lupa magnificadora que muestra zoom del área bajo el dedo, estilo apps nativas). Validar que el cuadrilátero sea convexo.
- Warp con `cv.warpPerspective` a un rectángulo con relación de aspecto inferida (detectar si es A4, carta, ticket, etc. por proporciones; permitir override).
- Rotación 90° y volteo.

**F4 — Filtros (aplicables por página o a todo el documento):**

| Filtro | Implementación |
|---|---|
| **Original** | Sin procesamiento |
| **Color realzado** | Auto white-balance + saturación leve + sharpen (unsharp mask) |
| **Escala de grises** | Luminancia + curva de contraste suave |
| **Blanco y negro** | Umbral adaptativo (adaptive threshold estilo documento) |
| **Alto contraste B&N** | Umbral adaptativo agresivo + limpieza de ruido (morfología) — ideal para texto |
| **Eco / Ahorro tinta** | B&N + inversión de fondos oscuros |

- Sliders finos: brillo, contraste, nitidez (persisten como parámetros no destructivos — guardar siempre el original + receta de edición, re-renderizar al exportar).
- Preview en vivo del filtro sobre el thumbnail de cada opción.

**F5 — Gestión multipágina:**
- Grilla de páginas con reordenamiento drag & drop (dnd-kit), duplicar, eliminar (con undo por toast, 5s), rotar, insertar nueva página en posición arbitraria (re-abre cámara).
- Selección múltiple para aplicar filtro/eliminar en lote.

### 3.3 Documento final

**F6 — Exportación PDF:**
- pdf-lib: una página PDF por imagen, tamaño de página configurable (A4 / Carta / Ajustar a imagen), orientación auto.
- Calidad configurable: Alta (JPEG q0.92), Media (q0.8), Compacta (q0.6 + downscale a 1500px lado mayor). Mostrar peso estimado.
- Metadata: título, autor "Nitidoc", fecha.
- Export alternativo: imágenes sueltas (ZIP con JSZip) o JPEG individual.

**F7 — Firma:**
- Canvas de firma con signature_pad (fondo transparente, trazo con presión si hay stylus).
- Alternativas: subir imagen de firma / escanear firma en papel (recorte automático + quitar fondo por umbral).
- Guardar firmas en biblioteca local (IndexedDB) para reutilizar.
- Colocación: drag, resize y rotate sobre la página elegida; se incrusta como PNG con `drawImage` de pdf-lib al exportar.
- **Aclaración obligatoria en la UI:** es una firma *dibujada* (imagen), no una firma digital criptográfica.

**F8 — Guardar y compartir:**
- **Local:** descarga directa; en navegadores compatibles usar File System Access API (`showSaveFilePicker`) para elegir carpeta; fallback a `<a download>`.
- **Compartir:** Web Share API Level 2 con archivos (`navigator.share({ files: [pdfFile] })`) — cubre WhatsApp, Mail, Telegram, etc. en móvil. Fallback: descargar + copiar al portapapeles.
- **Nube (opcional, requiere login):** guardar en Firebase Storage del usuario. Botones "Guardar en Google Drive" (Google Picker API / Drive API con OAuth) como integración fase 2.
- **Imprimir:** `window.print()` sobre un iframe con el PDF.

### 3.4 Biblioteca y sincronización

**F9 — Biblioteca local (offline-first):**
- Todos los documentos viven primero en IndexedDB: `{ id, nombre, páginas[{blobOriginal, receta, orden}], creadoEl, editadoEl, tags }`.
- Home: lista/grilla de documentos con búsqueda por nombre, renombrar, duplicar, eliminar.
- Funciona 100% sin conexión y sin cuenta.

**F10 — Cuenta y sync (opcional):**
- Firebase Auth: login anónimo automático → link con Google si el usuario quiere sincronizar.
- Firestore: metadata de documentos. Storage: blobs (comprimidos, ruta `users/{uid}/docs/{docId}/pages/{n}.jpg`).
- Sync incremental con cola de subida cuando vuelve la conexión (Background Sync donde esté disponible).
- **Security Rules estrictas:** cada usuario solo lee/escribe bajo su `uid`. Incluir las reglas en el repo (`firestore.rules`, `storage.rules`) y testearlas con el emulador.

### 3.5 PWA

**F11 — Instalabilidad y offline:**
- `manifest.webmanifest`: name "Nitidoc", short_name "Nitidoc", `display: standalone`, `theme_color: #0F172A`, `background_color: #0F172A`, íconos 192/512 + maskable, `share_target` para recibir imágenes, shortcuts ("Nuevo escaneo", "Mis documentos").
- Service Worker (Workbox): precache del shell, `CacheFirst` para OpenCV WASM y fuentes, `StaleWhileRevalidate` para assets, página offline.
- Prompt de instalación custom (interceptar `beforeinstallprompt`) mostrado tras el primer escaneo exitoso, no antes.
- Detección de update del SW con toast "Hay una nueva versión — Actualizar".

---

## 4. Flujo de usuario principal (happy path)

1. Usuario abre la app → Home con FAB "+ Escanear".
2. Tap → se pide permiso de cámara (con pantalla explicativa previa si es la primera vez) → carga de OpenCV con progreso.
3. Apunta al documento → contorno teal en vivo → auto-captura → página cae a la bandeja → escanea 3 páginas más.
4. Tap "Listo (4)" → pantalla de revisión: corrige esquinas de la página 2 manualmente, aplica "Alto contraste B&N" a todas.
5. Reordena páginas, renombra el documento "Contrato alquiler".
6. Tap "Firmar" → dibuja firma → la arrastra a la página 4.
7. Tap "Exportar" → PDF calidad Media → "Compartir" → WhatsApp. Fin. **Total: menos de 90 segundos.**

---

## 5. Arquitectura del código

```
src/
├── app/                # rutas, providers, layout
├── features/
│   ├── scanner/        # cámara, detección, worker de OpenCV
│   │   ├── worker/     # opencv.worker.ts (detección + warp)
│   │   └── hooks/      # useCamera, useDocumentDetection
│   ├── editor/         # esquinas, filtros, rotación
│   │   └── filters/    # shaders WebGL + fallbacks canvas
│   ├── document/       # multipágina, reorden, export PDF
│   ├── signature/      # pad, biblioteca de firmas, colocación
│   ├── library/        # home, IndexedDB, búsqueda
│   └── sync/           # Firebase auth + firestore + storage
├── shared/             # ui/ (design system), lib/, types/
└── sw/                 # service worker config
```

**Principios:**
- Las imágenes originales son inmutables; toda edición es una "receta" (JSON de operaciones) que se aplica al renderizar/exportar. Permite undo infinito y re-exportar en otra calidad.
- Tipado estricto (`strict: true`), sin `any`.
- Los workers se comunican con transferables (`ImageBitmap`, `ArrayBuffer`) — nunca clonar imágenes grandes por postMessage.

---

## 6. Casos borde y errores (implementar TODOS)

- Permiso de cámara denegado → pantalla con instrucciones por navegador para rehabilitarlo + fallback a importar fotos.
- Sin cámara (desktop) → default a importación con drag & drop.
- Documento no detectado en 5s → hint "Apoyá el documento sobre fondo liso y oscuro" + botón "Capturar igual" (recorte manual después).
- Detección de contorno no convexo o esquina fuera de frame → usar frame completo y abrir editor manual.
- Memoria: en iOS Safari, canvas > 16MP falla → cap de resolución de captura y liberar (`close()`) los `ImageBitmap` agresivamente. Revocar `ObjectURL`s.
- IndexedDB llena / `QuotaExceededError` → avisar y ofrecer borrar documentos viejos o bajar calidad.
- OpenCV falla al cargar (red) → reintento con backoff + modo degradado (recorte manual sin auto-detección).
- Pérdida de conexión durante sync → cola persistente, reintento al reconectar.
- Pantalla bloqueada/cambio de app durante escaneo → pausar stream, restaurar estado al volver (`visibilitychange`).

---

## 7. Seguridad y privacidad

- **Privacy-first como feature de marketing:** el procesamiento es 100% en el dispositivo; nada sube a ningún servidor salvo que el usuario active sync.
- HTTPS obligatorio (Firebase Hosting lo da; la cámara no funciona sin él).
- CSP estricta en headers de Hosting (`firebase.json`): sin `unsafe-eval` salvo el scope necesario para WASM (`'wasm-unsafe-eval'`).
- Sin analytics de terceros invasivos; si se agrega telemetría, que sea opt-in.
- Reglas de Firestore/Storage con validación de tamaño (max 10MB por página) y content-type imagen.

---

## 8. Deploy en Firebase

1. `firebase init`: Hosting (SPA rewrite a `/index.html`), Firestore, Storage, Emulators.
2. `firebase.json`: headers de cache (assets con hash → `max-age=31536000, immutable`; `index.html` y SW → `no-cache`), headers `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin` **solo si** se usa OpenCV con threads/SIMD (evaluar; si complica, usar build single-thread).
3. CI: GitHub Actions → build + tests + `firebase hosting:channel:deploy` en PRs (preview channels) + deploy a producción en merge a `main`.
4. Configurar dominio custom cuando esté disponible.

---

## 9. Roadmap de entrega (construir en este orden)

| Fase | Alcance | Criterio de aceptación |
|---|---|---|
| **1 — Core scanner** | Cámara + detección en vivo + captura + corrección de perspectiva + editor de esquinas | Escaneo de 1 página con warp correcto en móvil y desktop |
| **2 — Multipágina + filtros** | Modo lote, grilla, reorden, los 6 filtros, ajustes finos | Documento de 5 páginas con filtros mixtos |
| **3 — PDF + firma + compartir** | Export pdf-lib, signature pad, Web Share, descarga, imprimir | PDF firmado compartido por WhatsApp desde Android e iOS |
| **4 — PWA + offline** | Manifest, SW, install prompt, IndexedDB, biblioteca | Funciona en modo avión; instalable con Lighthouse PWA 100 |
| **5 — Firebase sync** | Auth, Firestore, Storage, reglas, cola offline | Documento creado en el celu aparece en la PC |
| **6 — Polish** | i18n, share target, HEIC, Drive, modo claro, onboarding | QA completo en iOS Safari, Chrome Android, desktop |

**Matriz de testing obligatoria:** iOS Safari (el más restrictivo — probar SIEMPRE acá primero), Chrome Android, Chrome/Edge/Firefox desktop.

---

## 10. Definición de terminado (DoD global)

- [ ] Todas las features F1–F11 implementadas sin mocks
- [ ] Lighthouse: PWA 100, Performance ≥ 90 móvil
- [ ] Cero errores de consola en el happy path
- [ ] Funciona offline tras la primera visita
- [ ] Reglas de seguridad de Firebase testeadas con emulador
- [ ] E2E de Playwright: escanear (imagen fixture) → filtrar → firmar → exportar PDF → validar que el PDF tiene N páginas
- [ ] README con setup, arquitectura y decisiones técnicas
