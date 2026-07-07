# Perspective Specification

## Purpose

Cubrir la edicion manual de esquinas sobre un frame capturado, la correccion de perspectiva (warp) hacia una imagen plana y recta, y las ediciones simples post-warp (rotacion y volteo) que completan el pipeline de escaneo de una pagina. Cubre CAP-6, CAP-7 y CAP-8 de la propuesta `core-scanner`.

**Restriccion transversal:** todo el codigo de este dominio se implementa en TypeScript `strict: true`, sin `any`.

## Requirements

### Requirement: Editor manual de esquinas

El sistema MUST mostrar 4 handles arrastrables superpuestos sobre el frame capturado (o importado), preseleccionados en las esquinas detectadas automaticamente cuando existan, o distribuidos sobre el frame completo cuando no haya deteccion valida. El sistema MUST mostrar una lupa magnificadora bajo el punto de arrastre mientras el usuario mueve un handle. El sistema MUST validar que el cuadrilatero formado por las 4 esquinas sea convexo antes de habilitar el boton de confirmar. El sistema MUST recalcular el warp de perspectiva solo al soltar el handle (`pointerup`/`touchend`), no en cada frame intermedio de arrastre.

#### Scenario: Handles preseleccionados desde deteccion automatica

- GIVEN el worker detecto un contorno valido y convexo para el frame capturado
- WHEN el usuario entra al editor de esquinas
- THEN los 4 handles se posicionan sobre las esquinas detectadas automaticamente
- AND el boton de confirmar esta habilitado si el cuadrilatero inicial es convexo

#### Scenario: Sin deteccion previa, editor con frame completo

- GIVEN no hubo deteccion valida (por no-deteccion en 5s, contorno no convexo, o import manual sin deteccion)
- WHEN el usuario entra al editor de esquinas
- THEN los 4 handles se distribuyen inicialmente sobre las esquinas del frame completo
- AND el usuario puede ajustarlos manualmente antes de confirmar

#### Scenario: Arrastre de un handle muestra lupa

- GIVEN el editor de esquinas esta activo
- WHEN el usuario comienza a arrastrar un handle
- THEN el sistema muestra una lupa magnificadora centrada en la posicion del handle bajo el dedo/cursor
- AND la lupa desaparece al soltar el handle

#### Scenario: Cuadrilatero no convexo bloquea confirmacion

- GIVEN el usuario arrastro un handle de forma que el cuadrilatero resultante ya no es convexo (p. ej. dos lados se cruzan)
- WHEN el sistema valida la convexidad tras soltar el handle
- THEN el boton de confirmar se deshabilita
- AND el sistema indica visualmente que el cuadrilatero actual es invalido

#### Scenario: Recalculo de warp solo al soltar el handle

- GIVEN el usuario esta arrastrando un handle a traves de multiples posiciones intermedias
- WHEN el handle aun no fue soltado
- THEN el sistema NO dispara un recalculo de `warpPerspective` por cada posicion intermedia
- AND al soltar el handle (evento final de arrastre), el sistema dispara un unico recalculo de warp con las 4 esquinas finales

### Requirement: Correccion de perspectiva (warp)

El sistema MUST aplicar `getPerspectiveTransform` seguido de `warpPerspective` sobre las 4 esquinas confirmadas para producir una imagen deswarpeada plana y recta. El sistema MUST inferir el aspect ratio de salida (A4, carta, o ticket) a partir de las proporciones del cuadrilatero detectado, y MUST permitir al usuario sobrescribir manualmente ese aspect ratio inferido. El sistema MUST ejecutar el calculo de warp en el Web Worker de OpenCV, fuera del hilo de UI.

> Verificacion empirica requerida en apply: el orden de esquinas por sumas/restas de coordenadas (TL=min(x+y), BR=max(x+y), TR=min(y-x), BL=max(y-x)) asume orientacion aproximadamente vertical del documento. Debe validarse con documentos rotados y, de ser necesario, aplicar una normalizacion de orientacion antes de invocar `getPerspectiveTransform`. El criterio de ordenamiento descrito aqui es un punto de partida, no un valor final.

#### Scenario: Warp exitoso con aspect ratio inferido

- GIVEN el usuario confirmo un cuadrilatero convexo de 4 esquinas
- WHEN el sistema dispara el calculo de warp en el worker
- THEN el worker ordena las esquinas, calcula `getPerspectiveTransform` y aplica `warpPerspective`
- AND el aspect ratio de salida se infiere de las proporciones del cuadrilatero (A4/carta/ticket)
- AND la imagen resultante se muestra plana y recta en el hilo de UI

#### Scenario: Usuario sobrescribe el aspect ratio inferido

- GIVEN el sistema infirio un aspect ratio para el warp
- WHEN el usuario selecciona manualmente un aspect ratio distinto antes de confirmar
- THEN el sistema usa el aspect ratio elegido por el usuario para las dimensiones de salida del warp
- AND descarta el valor inferido automaticamente

#### Scenario: Warp corre en Web Worker sin bloquear la UI

- GIVEN el usuario confirmo las esquinas y disparo el calculo de warp
- WHEN el worker procesa `getPerspectiveTransform` y `warpPerspective`
- THEN el hilo principal de UI permanece responsivo (sin bloqueo perceptible) durante el procesamiento
- AND el resultado del warp se recibe en el hilo principal como un `ImageBitmap` transferido

#### Scenario: Documento con orientacion rotada respecto al orden de esquinas por defecto

- GIVEN un documento capturado con una rotacion significativa respecto a la vertical
- WHEN el sistema ordena las esquinas por la heuristica de sumas/restas de coordenadas
- THEN el resultado del ordenamiento se marca como sujeto a verificacion empirica en apply
- AND cualquier ajuste de normalizacion de orientacion necesario se documenta como parte de esa verificacion, no como comportamiento ya validado

### Requirement: Rotacion y volteo post-warp

El sistema MUST permitir rotar la imagen resultante del warp en incrementos de 90 grados y voltearla horizontalmente. El sistema MUST aplicar estas ediciones de forma no destructiva: el frame original capturado nunca se muta, y las transformaciones (esquinas, rotacion, volteo) se conservan como una "receta" que se aplica al renderizar o exportar la imagen resultante.

#### Scenario: Rotacion de 90 grados

- GIVEN el usuario tiene la imagen deswarpeada visible en el editor post-warp
- WHEN el usuario activa la accion de rotar 90 grados
- THEN la imagen mostrada rota 90 grados
- AND la rotacion se registra en la receta de edicion sin alterar el frame original capturado

#### Scenario: Volteo horizontal

- GIVEN el usuario tiene la imagen deswarpeada visible en el editor post-warp
- WHEN el usuario activa la accion de voltear
- THEN la imagen mostrada se voltea horizontalmente
- AND el volteo se registra en la receta de edicion sin alterar el frame original capturado

#### Scenario: Ediciones no destructivas sobre el original

- GIVEN el usuario aplico una o mas ediciones (esquinas, rotacion, volteo) sobre una captura
- WHEN el sistema persiste el resultado de la sesion de edicion
- THEN el frame original capturado permanece intacto en su forma original
- AND las ediciones aplicadas quedan representadas unicamente en la receta JSON asociada a esa captura
