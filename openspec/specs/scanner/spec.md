# Scanner Specification

## Purpose

Convertir la camara del dispositivo (o un fallback de import de archivo en desktop sin camara) en un capturador que detecta un documento en vivo, evalua su calidad, y captura un frame full-res listo para pasar al pipeline de correccion de perspectiva. Cubre CAP-1 a CAP-5, CAP-9 y CAP-10 de la propuesta `core-scanner`.

**Restriccion transversal:** todo el codigo de este dominio se implementa en TypeScript `strict: true`, sin `any`.

## Requirements

### Requirement: Apertura y control de camara

El sistema MUST abrir la camara trasera (`facingMode: environment`, `ideal` no `exact`) por defecto al entrar al modo escaner, y MUST leer la resolucion real via `track.getSettings()` en vez de asumir la resolucion `ideal` solicitada. El sistema MUST enumerar camaras disponibles (`enumerateDevices()` filtrando `videoinput`) y permitir seleccionar entre ellas cuando haya mas de una. El sistema MUST feature-detectar soporte de torch (`track.getCapabilities().torch`) antes de ofrecer el control, y MUST ocultar el boton de torch si el dispositivo no lo expone. El sistema MUST pausar el loop de deteccion cuando `document.hidden` es verdadero (evento `visibilitychange`) y MUST reanudarlo al volver a estar visible.

#### Scenario: Apertura exitosa de camara trasera en movil

- GIVEN un usuario en un dispositivo movil con camara y permisos aun no otorgados
- WHEN el usuario entra al modo escaner
- THEN el sistema solicita permiso de camara con `facingMode: { ideal: 'environment' }`
- AND al otorgarse el permiso, el sistema lee `track.getSettings()` y expone la resolucion real obtenida

#### Scenario: Multiples camaras disponibles

- GIVEN el dispositivo tiene mas de una camara de video
- WHEN el usuario abre el selector de camara
- THEN el sistema lista los dispositivos `videoinput` con su `label`
- AND al seleccionar uno distinto, el stream de video cambia a la camara elegida

#### Scenario: Torch no disponible en el dispositivo

- GIVEN el track de video activo no reporta capacidad `torch` en `getCapabilities()`
- WHEN se renderiza la UI de control de camara
- THEN el sistema NO muestra el boton de torch

#### Scenario: Permiso de camara denegado

- GIVEN el usuario deniega el permiso de camara en el prompt del navegador
- WHEN el sistema recibe el rechazo de `getUserMedia`
- THEN el sistema muestra instrucciones para habilitar el permiso
- AND ofrece el fallback de import de archivo como via alternativa

#### Scenario: Sin camara disponible (desktop)

- GIVEN el dispositivo no tiene ninguna camara de video (`enumerateDevices()` no retorna `videoinput`, o `getUserMedia` falla con `NotFoundError`)
- WHEN el usuario entra al modo escaner
- THEN el sistema activa el fallback de import minimo (`<input type="file" accept="image/*">`)
- AND el flujo de deteccion/edicion de esquinas se alimenta con la imagen importada

#### Scenario: Pestaña oculta durante la deteccion en vivo

- GIVEN el modo escaner esta activo y la deteccion en vivo corriendo
- WHEN el evento `visibilitychange` reporta `document.hidden === true`
- THEN el sistema pausa el loop de deteccion y detiene el envio de frames al worker
- AND al volver `document.hidden` a `false`, el sistema reanuda el loop sin requerir reapertura de camara

### Requirement: Deteccion de documento en vivo

El sistema MUST analizar cada frame reducido (~640px de ancho) para detectar el contorno de un documento, delegando el procesamiento de imagen (deteccion de bordes, contornos, aproximacion poligonal) al Web Worker de OpenCV. El sistema MUST dibujar un overlay del contorno detectado sobre el video en vivo, interpolando las esquinas entre frames consecutivos para evitar jitter visual perceptible.

> Nota de calibracion: el algoritmo interno de deteccion (Canny/adaptiveThreshold, umbrales, kernel de blur) se especifica en el dominio `perspective` y en design; este requisito describe el comportamiento observable en el hilo de UI, no el algoritmo.

#### Scenario: Documento detectado y overlay estable

- GIVEN la camara esta activa y un documento esta dentro del encuadre
- WHEN el worker retorna 4 esquinas para un frame
- THEN el sistema dibuja el contorno interpolado entre la posicion anterior y la nueva
- AND el overlay se actualiza en cada frame subsiguiente sin saltos abruptos perceptibles

#### Scenario: No hay deteccion durante 5 segundos

- GIVEN la camara esta activa pero ningun frame produjo un contorno valido durante 5 segundos continuos
- WHEN se cumple el umbral de 5 segundos sin deteccion
- THEN el sistema muestra un hint indicando la falta de deteccion
- AND ofrece la opcion "capturar igual", que al activarse lleva el frame completo directamente al editor manual de esquinas

#### Scenario: Contorno detectado no es convexo o tiene una esquina fuera de frame

- GIVEN el worker retorna un poligono de 4 lados que no pasa la validacion de convexidad, o alguna esquina cae fuera de los limites del frame
- WHEN el sistema evalua el resultado de deteccion
- THEN el sistema descarta el contorno para efectos de auto-captura
- AND si el usuario captura manualmente en ese estado, el frame completo se envia al editor manual de esquinas sin esquinas preseleccionadas invalidas

### Requirement: Auto-captura por estabilidad de esquinas

El sistema SHOULD disparar una captura automatica cuando la varianza de posicion de las 4 esquinas se mantiene bajo un umbral durante una ventana de estabilidad continua, mostrando un countdown visual de 3 puntos antes de capturar. El sistema MUST permitir desactivar la auto-captura y usar un boton de captura manual (FAB) en cualquier momento.

> Valor de partida a calibrar empiricamente en apply (no es constante final): ventana de estabilidad ~800ms.

#### Scenario: Esquinas estables durante la ventana de estabilidad

- GIVEN el contorno detectado se mantiene con varianza de posicion bajo el umbral configurado durante ~800ms
- WHEN se cumple la ventana de estabilidad
- THEN el sistema muestra un countdown de 3 puntos
- AND al finalizar el countdown dispara la captura automatica del frame

#### Scenario: Esquinas inestables interrumpen el countdown

- GIVEN un countdown de auto-captura esta en curso
- WHEN la posicion de las esquinas supera el umbral de varianza antes de completar el countdown
- THEN el sistema cancela el countdown
- AND vuelve a esperar una nueva ventana de estabilidad sin capturar

#### Scenario: Usuario desactiva auto-captura

- GIVEN la auto-captura esta activa por defecto
- WHEN el usuario activa el toggle de captura manual
- THEN el sistema deja de evaluar estabilidad para disparar captura automatica
- AND el FAB de captura manual queda habilitado para disparar la captura bajo demanda del usuario

### Requirement: Captura de frame full-res

El sistema MUST capturar el frame activo a la resolucion completa disponible, aplicando un cap de 16 megapixeles para dispositivos iOS. El sistema MUST usar `ImageCapture` cuando el navegador lo soporte, y MUST usar el fallback `drawImage(video)` sobre un canvas cuando no lo soporte. El sistema MUST liberar los recursos asociados a la captura (`ImageBitmap.close()`, `URL.revokeObjectURL()`) inmediatamente despues de procesar cada captura.

#### Scenario: Captura via ImageCapture

- GIVEN el navegador soporta la API `ImageCapture`
- WHEN se dispara una captura (automatica o manual)
- THEN el sistema usa `ImageCapture.takePhoto()` (o `grabFrame()`) para obtener el frame full-res
- AND el resultado se cap a 16MP si el dispositivo es iOS y la resolucion nativa lo excede

#### Scenario: Fallback a drawImage sin soporte de ImageCapture

- GIVEN el navegador (p. ej. iOS Safari) no soporta `ImageCapture` o lo soporta parcialmente
- WHEN se dispara una captura
- THEN el sistema dibuja el frame del `<video>` sobre un canvas interno con `drawImage`
- AND extrae la imagen resultante para continuar el pipeline, sin depender de `ImageCapture`

#### Scenario: Liberacion de recursos tras captura

- GIVEN una captura de frame fue procesada exitosamente
- WHEN el pipeline termina de consumir el `ImageBitmap` u objeto URL generado
- THEN el sistema llama a `ImageBitmap.close()` y/o `URL.revokeObjectURL()` segun corresponda
- AND ningun recurso de imagen queda retenido mas alla del ciclo de vida de esa captura

### Requirement: Feedback de calidad en vivo

El sistema SHOULD analizar cada frame procesado para producir hints de calidad accionables: distancia insuficiente al documento ("acercate mas"), iluminacion insuficiente via histograma ("muy oscuro"), y desenfoque via varianza laplaciana ("manten firme"). El sistema MUST exponer estos hints mediante una region `aria-live` para accesibilidad.

> Valor de partida a calibrar empiricamente en apply (no es constante final): umbral de varianza laplaciana de blur (~100 a 640px de ancho de frame).

#### Scenario: Frame con blur detectado

- GIVEN el calculo de varianza laplaciana sobre el frame gris cae por debajo del umbral de blur configurado
- WHEN el sistema evalua la calidad del frame actual
- THEN el sistema emite el hint "manten firme" en la region `aria-live`
- AND el hint desaparece cuando un frame subsiguiente supera el umbral

#### Scenario: Frame con iluminacion insuficiente

- GIVEN el histograma de intensidad del frame gris indica un promedio por debajo del umbral de "muy oscuro"
- WHEN el sistema evalua la calidad del frame actual
- THEN el sistema emite el hint "muy oscuro" en la region `aria-live`

#### Scenario: Documento demasiado lejos del encuadre

- GIVEN el area del contorno detectado ocupa una proporcion menor al umbral esperado del frame
- WHEN el sistema evalua la calidad del frame actual
- THEN el sistema emite el hint "acercate mas" en la region `aria-live`

### Requirement: Carga lazy de OpenCV.js

El sistema MUST cargar OpenCV.js WASM mediante `import()` dinamico exclusivamente al entrar al modo escaner, y MUST NOT incluirlo en el bundle inicial de la aplicacion. El sistema MUST exponer un estado de carga observable con al menos los valores `idle`, `loading` (con progreso), `ready` y `error`, y MUST mostrar un indicador de progreso visible durante `loading`.

#### Scenario: Carga exitosa de OpenCV al entrar al escaner

- GIVEN el usuario navega al modo escaner por primera vez en la sesion
- WHEN el sistema inicia la carga dinamica del modulo de OpenCV.js
- THEN el estado de carga transiciona de `idle` a `loading` mostrando progreso
- AND al completarse, transiciona a `ready` habilitando la deteccion en vivo

#### Scenario: Fallo de carga de OpenCV.js

- GIVEN la carga dinamica de OpenCV.js falla (error de red, WASM no soportado, u otro error de inicializacion)
- WHEN el sistema detecta el fallo de carga
- THEN el estado de carga transiciona a `error`
- AND el sistema reintenta la carga con backoff
- AND si los reintentos se agotan, el sistema ofrece un modo degradado de captura + editor manual de esquinas sin deteccion automatica

### Requirement: Fallback de import de imagen (desktop sin camara)

El sistema MUST ofrecer un input minimo de seleccion de archivo (`<input type="file" accept="image/*">`) que alimente el mismo pipeline de deteccion y correccion de perspectiva usado por la captura de camara, para cumplir el criterio de aceptacion de warp correcto en desktop. El sistema MUST NOT implementar drag&drop, seleccion multiple, soporte HEIC, ni Web Share Target en esta fase — esas capacidades quedan fuera de alcance (Fase 6).

#### Scenario: Import de imagen en desktop sin camara

- GIVEN el usuario esta en un desktop sin camara disponible
- WHEN selecciona un archivo de imagen via el input de import
- THEN el sistema carga la imagen seleccionada como frame de entrada
- AND el pipeline de deteccion de esquinas y correccion de perspectiva se ejecuta sobre esa imagen igual que sobre un frame de camara

#### Scenario: Import de imagen no ofrece funcionalidad fuera de alcance

- GIVEN el fallback de import esta activo
- WHEN el usuario intenta arrastrar un archivo sobre la zona de import o seleccionar mas de un archivo
- THEN el sistema no ofrece manejo de drag&drop ni de seleccion multiple en esta fase
- AND solo el flujo de seleccion simple de un archivo esta disponible
