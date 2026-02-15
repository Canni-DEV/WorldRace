# Guia de Debug y Funcionamiento del Sistema

Este documento explica como leer el HUD/DEBUG y como diagnosticar problemas del stream de tiles.

## 1. Vision general del pipeline

El runtime sigue este flujo:

`Data (Overpass + cache) -> Topology -> Road Mesh Build -> Render -> World Stream`

- `Data`: pide OSM (roads/buildings), usa cache local (IndexedDB), puede devolver `network`, `cache-fresh` o `cache-stale`.
- `Topology`: transforma ways en nodos/aristas, corta intersecciones, elimina degenerados y cose bordes.
- `Mesh`: genera la malla de roads y colision.
- `Stream`: decide que tiles cargar, cuales diferir (prefetch) y cuales descargar.

## 2. Controles utiles

- Mover camara: `WASD` o flechas.
- Subir/Bajar: `E/Q`.
- Look: `RMB`.
- Debug overlay de roads: `B`.

## 3. Como leer HUD vs DEBUG

- `HUD`: estado operativo rapido (FPS, frame, posicion, cache hit ratio, fuente de datos).
- `DEBUG`: detalle tecnico del tile actual, stream, topologia, malla y uso GPU.

## 4. Campos del panel DEBUG

### 4.1 Estado espacial

- `Tile: x:y`
  - Tile actual del anchor/camara.
- `Active tiles: N`
  - Cantidad de tiles del anillo activo (deben tener prioridad de carga).
- `Prefetch tiles: N`
  - Cantidad del anillo de prefetch (carga oportunista).
- `Active sample / Prefetch sample`
  - Muestra de keys de tiles para inspeccion rapida.
- `Floating recenter: N`
  - Cuantas veces se aplico floating origin.

### 4.2 Datos del tile actual

- `Tile data: <status> <tileKey>`
  - Estado del tile focal.
  - Valores comunes:
    - `network`: vino de red.
    - `cache-fresh`: vino de cache vigente.
    - `cache-stale`: vino de cache vencida con revalidacion en background.
    - `queued` / `loading fetch` / `loading build`: aun en proceso.
- `Current payload: X roads | Y buildings`
  - Cantidad de features OSM normalizadas en ese tile.

### 4.3 Topologia

- `Topology: nodes | edges`
  - Grafo vial despues del proceso de normalizacion.
- `Topology stats: splits | dropped | stitched`
  - `splits`: cortes en intersecciones.
  - `dropped`: segmentos invalidos/degenerados descartados.
  - `stitched`: uniones por tolerancia para continuidad.

### 4.4 Mesh de roads

- `Road mesh: edges | tris | collision tris`
  - Geometria final de render y de colision.
- `Width range: a-b m`
  - Rango de anchos resueltos en ese tile.
- `Junctions: ... | m/b/f ... | fail N`
  - Estadisticas de intersecciones.
  - `m/b/f` = miter / bevel / fallback.
  - `fail` > 0 indica fallos de triangulacion de cruces.
- `Road debug: on/off | rendered tiles N`
  - Overlay de debug y cantidad de tiles con mesh actualmente en escena.

### 4.5 Stream (scheduler y fiabilidad)

- `Stream queue: desired | loaded | pending | fetch | build`
  - `desired`: tiles objetivo totales.
  - `loaded`: tiles listos en escena.
  - `pending`: en cola.
  - `fetch`: requests de datos activas.
  - `build`: builds de mesh activos.
- `Stream timings: fetch X ms | build Y ms | mode worker/main-thread`
  - Ultima latencia de fetch y build.
- `Stream reliability: canceled_obsolete | deferred_prefetch | skipped_focus | disposed | errors f/b`
  - Son contadores acumulados desde que se abrio la app.
  - `canceled_obsolete`: cargas abortadas por tiles obsoletos.
  - `deferred_prefetch`: prefetch diferido por presupuesto/prioridad.
  - `skipped_focus`: prefetch bloqueado porque falta foreground.
  - `disposed`: tiles descargados y liberados.
  - `errors f/b`: errores de fetch/build.
- `Stream memory: mesh approx X MB`
  - Estimacion de memoria de mallas administradas por stream.

### 4.6 Renderer/GPU

- `GPU resources: geometries | textures`
  - Objetos GPU vivos.
- `Draw calls`
  - Cantidad de llamadas de dibujo por frame.
- `Triangles`
  - Triangulos renderizados por frame.

## 5. Interpretacion rapida (reglas practicas)

- Si `pending` no baja y `fetch ms` es alto:
  - Cuello de botella de red (normal con Overpass publico).
- Si `loaded` no crece pero `errors f` sube:
  - Problema de endpoint/timeouts.
- Si `skipped_focus` y `deferred_prefetch` suben:
  - Esperable; el scheduler esta priorizando foco.
- Si `canceled_obsolete` sube muy rapido sin mover camara:
  - Revisar hysteresis/cambios de tile o aborts espurios.
- Si `geometries`, `draw calls` y `mesh approx MB` solo suben y no bajan al alejarte:
  - Posible fuga en unload/dispose.

## 6. Semaforo recomendado

- Verde:
  - `errors f/b` en 0 o muy bajos.
  - `loaded` cercano a `desired` al estar quieto.
  - `build ms` bajo y estable.
- Amarillo:
  - `fetch ms` alto (2s-8s) pero recupera.
  - `pending` tarda en bajar por latencia externa.
- Rojo:
  - `errors f` sostenidos.
  - `loaded` estancado mucho tiempo en area con roads.
  - crecimiento continuo de memoria/GPU sin descarga.

## 7. Protocolo de validacion manual (recomendado)

1. Arrancar app y esperar 10-20s sin mover.
2. Verificar que el tile actual pase a `cache-fresh` o `network` estable.
3. Mover camara 2-3 tiles en linea recta.
4. Confirmar:
   - tile actual carga antes que prefetch.
   - `pending` baja cuando te quedas quieto.
   - no suben `errors f/b`.
5. Volver al area inicial y validar uso de cache (`cache-fresh`).

## 8. Notas importantes

- Los contadores de `Stream reliability` son acumulativos; no representan estado instantaneo.
- Un tile con pocas o cero roads puede ser valido en OSM para esa celda.
- Overpass publico puede tener throughput bajo; el sistema prioriza foco para mantener jugabilidad.
