# Document Specification (delta — new domain)

## Purpose

Gestion de documentos multipagina: `DocumentSlice` reemplaza `CaptureSlice` (F1), retiene N paginas ordenadas con
un modelo de memoria por capas, expone grilla con reorder y borrado con undo. Cubre AC1–AC3, AC7, AC9 de la
propuesta `multipage-filters`.

**Restriccion transversal:** TypeScript `strict: true`, sin `any`. Preserva la higiene de memoria de F1
(design core-scanner §7: close-before-overwrite, cap 16MP, un solo `OffscreenCanvas` por operacion en el worker).

## Requirements

### Requirement: Bandeja de captura continua

El sistema MUST mantener la camara abierta y el loop de deteccion activo tras confirmar cada pagina (reusando
el patron `handleEditorCancel`/`startDetection` de F1), permitiendo capturar `>= 2` paginas en una sola sesion.
El sistema MUST generar el thumbnail (~150px) UNA sola vez por pagina, al confirmar. El sistema MUST imponer un
cap duro de 30 paginas por documento y MUST bloquear nuevas capturas con un hint visible al alcanzarlo.

#### Scenario: Captura continua de multiples paginas

- GIVEN el usuario confirmo el warp de la pagina 1
- WHEN el sistema agrega la pagina a `pages[]`
- THEN la camara permanece abierta y el loop de deteccion se reanuda sin reapertura
- AND el usuario puede capturar la pagina 2 sin salir del modo escaner

#### Scenario: Cap duro de 30 paginas alcanzado

- GIVEN el documento ya tiene 30 paginas
- WHEN el usuario intenta disparar una nueva captura
- THEN el sistema bloquea la captura y muestra un hint indicando el limite alcanzado

### Requirement: Modelo `DocumentSlice` y retencion por capas

El sistema MUST reemplazar `CaptureSlice` por `DocumentSlice` (`pages`, `activePageId`, `selectedPageIds`,
`pendingDeletion`, `phase`). El sistema MUST materializar `ImageBitmap` full-res unicamente para la pagina
`activePageId`; toda pagina inactiva MUST retener su original y su warp como `Blob` JPEG comprimido
(~2–4MB @ q0.85), nunca un `ImageBitmap` full-res vivo. Al reingresar al editor de esquinas de una pagina
inactiva, el sistema MUST decodificar su `originalBlob` a `ImageBitmap` y re-ejecutar el warp con
`recipe.corners` antes de habilitarla como pagina activa; la pagina previamente activa MUST comprimirse a
`Blob` y liberar su `ImageBitmap` full-res en el mismo cambio.

#### Scenario: Reentrada al editor de una pagina inactiva

- GIVEN la pagina 3 esta inactiva (solo retiene `originalBlob`/`warpedBlob`)
- WHEN el usuario la selecciona para editar sus esquinas
- THEN el sistema decodifica `originalBlob` a `ImageBitmap` y re-ejecuta el warp con las esquinas guardadas
- AND la pagina 3 pasa a ser `activePageId`

#### Scenario: Cambio de pagina activa libera el full-res anterior

- GIVEN la pagina 3 es la activa con `ImageBitmap` full-res vivo
- WHEN el usuario activa la pagina 5
- THEN el sistema comprime y libera el `ImageBitmap` de la pagina 3 a `Blob`
- AND la memoria full-res viva se mantiene acotada a ~1 pagina en todo momento

### Requirement: Grilla de paginas con reorder

El sistema MUST mostrar todas las paginas de `pages[]` ordenadas por `order` usando thumbnails cacheados
(sin recomputo full-res). El sistema MUST implementar drag-and-drop de reorder con `@dnd-kit` (feature
lazy-loaded). En `onDragEnd`, el sistema MUST recalcular el campo `order` de TODO el array (no update
parcial), garantizando ausencia de huecos y duplicados.

#### Scenario: Reorder por drag-and-drop

- GIVEN la grilla muestra 5 paginas con `order` 0..4
- WHEN el usuario arrastra la pagina en `order: 4` a la posicion `order: 0`
- THEN el sistema recalcula `order` para las 5 paginas sin huecos ni duplicados
- AND la grilla refleja el nuevo orden persistido en el store

### Requirement: Borrado de pagina con undo por toast

El sistema MUST mostrar un toast (reusando la primitiva `Toast` ya existente en `shared/ui`; Fase 2 agrega el host/timer/accion "Deshacer", no re-crea la primitiva) durante una ventana de
5 segundos al borrar una pagina. El sistema MUST retener la `DocumentPage` completa en `pendingDeletion` sin
liberar sus recursos (`Blob`/thumbnail) durante la ventana. Si el usuario deshace, el sistema MUST reinsertar
la pagina en su `order` original. Si la ventana expira sin deshacer, el sistema MUST liberar duramente los
recursos (cerrar thumbnail, descartar `Blob`s).

#### Scenario: Undo dentro de la ventana de 5s

- GIVEN el usuario borro la pagina en `order: 2`
- WHEN presiona "Deshacer" antes de que expiren los 5s
- THEN el sistema reinserta la pagina en `order: 2`
- AND ningun recurso de la pagina fue liberado durante la ventana

#### Scenario: Expiracion sin undo libera memoria

- GIVEN el usuario borro una pagina y no interactuo con el toast
- WHEN transcurren 5s sin "Deshacer"
- THEN el sistema cierra el thumbnail y descarta los `Blob`s retenidos en `pendingDeletion`
- AND la pagina no reaparece en `pages[]`

### Requirement: Migracion desde `CaptureSlice` (F1)

El sistema MUST retirar `CaptureSlice` y sus acciones (`setOriginalFrame`, `setWarpedImage`, `setRecipe`,
`resetCaptureSlice`) reemplazandolas por las acciones de `DocumentSlice` (`addPage`, `setActivePage`,
`updateRecipe`, `reorderPages`, `deletePage`/`restorePage`, `setPhase`). `ScannerScreen` y `CornerEditor`
MUST leer/escribir la pagina activa (`activePageId`) en vez de una unica pagina implicita. Los tests de F1 que
asumen la forma single-page (store de captura, `CornerEditor`, `ScannerScreen`) MUST reescribirse contra la
nueva forma como grupo de tareas propio, sin perder cobertura de higiene de memoria (close-before-overwrite,
cap 16MP, un solo `OffscreenCanvas` por operacion).

#### Scenario: Migracion no rompe higiene de memoria existente

- GIVEN la suite de tests de F1 fue reescrita contra `DocumentSlice`
- WHEN se ejecuta la suite completa
- THEN los tests de close-before-overwrite, cap 16MP y single-OffscreenCanvas siguen pasando sin regresion
- AND ningun test remanente referencia `CaptureSlice`
