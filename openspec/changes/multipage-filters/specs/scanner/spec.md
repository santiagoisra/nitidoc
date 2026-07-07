# Delta for Scanner

## ADDED Requirements

### Requirement: Continuidad de camara entre paginas

El sistema MUST mantener el stream de camara y el loop de deteccion en vivo activos al confirmar el warp de
una pagina, en vez de cerrar la camara o navegar fuera del modo escaner. El sistema MUST reanudar la
deteccion (`startDetection`) inmediatamente tras el `append` de la pagina confirmada, reusando el mismo patron
que ya usa `handleEditorCancel` en F1 para retomar deteccion sin reapertura de camara. Esta continuidad MUST
respetar el cap duro de paginas del dominio `document`: al alcanzarlo, el sistema deja de reanudar la
deteccion para nuevas capturas y expone el hint de limite (delta `document`).

#### Scenario: Confirmar una pagina no cierra la camara

- GIVEN el usuario confirmo el warp de la pagina activa
- WHEN el sistema agrega la pagina al documento
- THEN el `MediaStream` de camara permanece activo (no se llama `track.stop()`)
- AND el loop de deteccion se reanuda automaticamente para la siguiente captura

#### Scenario: Reanudacion de deteccion reusa el patron de cancelacion de F1

- GIVEN el usuario cancelo previamente el editor de esquinas en F1 (patron `handleEditorCancel`)
- WHEN Fase 2 confirma una pagina en la bandeja continua
- THEN el sistema invoca la misma ruta de reanudacion de deteccion (`startDetection`) sin duplicar logica de apertura de camara
