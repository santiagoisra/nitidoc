# Filters Specification (delta — new domain)

## Purpose

Filtros de realce no destructivos por pagina: 6 presets + sliders de brillo/contraste/nitidez, enrutados a
Canvas2D o al worker OpenCV segun el preset. El filtro es una capa de presentacion sobre el warp cacheado sin
filtro (ADR-005, D4). Cubre AC4–AC6, AC8 de la propuesta `multipage-filters`.

**Restriccion transversal:** TypeScript `strict: true`, sin `any`. No se agrega WebGL (D3).

## Requirements

### Requirement: `FilterParams` embebido en `EditRecipe`

El sistema MUST agregar el campo `filter: FilterParams` (`preset`, `brightness`, `contrast`, `sharpness`) a
`EditRecipe`. `EditRecipe` MUST seguir siendo serializable a JSON: MUST NOT contener referencias a
`ImageBitmap`, `Blob` ni `Mat` en ningun campo, incluido `filter`.

#### Scenario: Receta con filtro se serializa sin binarios

- GIVEN una pagina tiene `recipe.filter = { preset: 'bw', brightness: 10, contrast: 0, sharpness: 20 }`
- WHEN el sistema serializa la receta con `JSON.stringify`
- THEN el resultado no contiene ninguna referencia a `ImageBitmap`, `Blob` o `Mat`
- AND `JSON.parse` del resultado reconstruye una receta equivalente

### Requirement: 6 presets de filtro por pagina

El sistema MUST ofrecer los presets `original`, `enhanced`, `grayscale`, `bw`, `bw-high-contrast`, `eco` por
pagina. El sistema MUST NOT re-invocar `warpPerspective` al cambiar de preset o mover un slider: el filtro se
aplica sobre el `warpedBlob`/`ImageBitmap` de warp ya cacheado (D4).

#### Scenario: Cambio de preset no re-invoca el warp

- GIVEN la pagina activa tiene un warp ya calculado y cacheado
- WHEN el usuario cambia el preset de `original` a `bw-high-contrast`
- THEN el sistema NO dispara un nuevo `getPerspectiveTransform`/`warpPerspective`
- AND solo se re-renderiza la presentacion (Canvas2D o `APPLY_FILTER`) sobre el warp existente

### Requirement: Enrutamiento de render (Canvas2D vs worker)

El sistema MUST renderizar `original`, `enhanced` y `grayscale` con `ctx.filter` en Canvas2D (main thread). El
sistema MUST enrutar `bw`, `bw-high-contrast` y `eco` al worker OpenCV via el mensaje `APPLY_FILTER`
(`adaptiveThreshold` + `morphologyEx`/erode-dilate segun preset). El sistema MUST enrutar tambien al worker
cualquier receta con `sharpness > 0` (convolucion), independientemente del preset activo. Los sliders de
brillo/contraste que acompañan un preset adaptativo MUST aplicarse dentro del mismo pipeline del worker.

#### Scenario: Preset Canvas2D no toca el worker

- GIVEN el preset activo es `enhanced` con `sharpness: 0`
- WHEN el sistema renderiza la presentacion de la pagina
- THEN el render se resuelve enteramente con `ctx.filter` en el hilo principal
- AND no se envia ningun mensaje `APPLY_FILTER` al worker

#### Scenario: Preset adaptativo enruta al worker

- GIVEN el preset activo es `bw`
- WHEN el sistema renderiza la presentacion de la pagina
- THEN el sistema envia `APPLY_FILTER` al worker con `adaptiveThreshold` (GAUSSIAN_C, THRESH_BINARY)
- AND el resultado se recibe como `ImageBitmap` transferido, sin bloquear el hilo de UI

#### Scenario: Nitidez fuerza ruta de worker sobre preset Canvas2D

- GIVEN el preset activo es `grayscale` y el usuario sube `sharpness` a 40
- WHEN el sistema renderiza la presentacion de la pagina
- THEN el sistema enruta el render al worker (convolucion de nitidez) en vez de resolverlo solo con Canvas2D

### Requirement: Preview de filtros sobre thumbnail

El sistema MUST previsualizar los 6 presets sobre el thumbnail cacheado (~150px), nunca sobre el full-res. El
sistema MUST batchear los 3 presets adaptativos (`bw`, `bw-high-contrast`, `eco`) en UNA sola llamada
`APPLY_FILTER` al worker para evitar 3 roundtrips separados.

#### Scenario: Preview de los 6 presets sin recompute full-res

- GIVEN el usuario abre el selector de filtros para una pagina
- WHEN el sistema genera las 6 previsualizaciones de preset
- THEN todas se calculan sobre el thumbnail ~150px
- AND los 3 presets adaptativos se resuelven en una unica llamada `APPLY_FILTER`

### Requirement: Aplicar filtro a todo el documento (atajo de UI)

El sistema MUST ofrecer una accion "aplicar a todo el documento" que, tras confirmacion explicita del usuario,
escribe el mismo `FilterParams` en el campo `recipe.filter` de CADA pagina, sobrescribiendo filtros
individuales previos. El sistema MUST NOT emitir una llamada batch al worker para esta accion: la escritura de
recetas MUST ser instantanea (solo mutacion de estado) y el render real por pagina MUST ocurrir de forma
perezosa, bajo demanda (al visualizar o exportar esa pagina).

#### Scenario: Aplicar a todo el documento reescribe recetas sin renderizar

- GIVEN un documento de 5 paginas con filtros individuales distintos
- WHEN el usuario confirma "aplicar `eco` a todo el documento"
- THEN el sistema escribe `filter.preset = 'eco'` en las 5 recetas de forma instantanea
- AND ningun render full-res se dispara hasta que el usuario visualice o exporte una pagina puntual
