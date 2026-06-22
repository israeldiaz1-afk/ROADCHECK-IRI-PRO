# Especificación Técnica: Rediseño + Arquitectura Multi-Modo
## Pavement Check — Rebranding, UX y Activación Combinada de Modos

> **Instrucciones para Claude Code**: Sigue las fases en orden, commit al finalizar cada una. **Requisito previo obligatorio**: `RIDE_COMFORT_SPEC.md` debe estar completamente implementado (Fases 1-7, incluida la validación de filtros) antes de iniciar este documento — este rediseño asume que los 3 motores de cálculo (IRI, Urbano, Confort) ya existen como pipelines independientes y funcionales. Aquí no se toca la lógica de cálculo de ninguno de los 3, solo cómo se activan, combinan y presentan.

---

## 0. CONTEXTO Y RESUMEN DE CAMBIOS

Esta especificación cubre:
1. Rebranding completo a **"Pavement Check"**
2. Arquitectura multi-modo: activación combinada en vez de selección única
3. Corrección definitiva del problema de layout (botón de inicio no visible)
4. Eliminación del gráfico de acelerómetro de la pantalla principal
5. Reordenación de la pantalla principal con criterios de jerarquía visual
6. Nueva pantalla de medición: mapa 75% / gráfico de 3 ejes 25%, con resaltado de eventos
7. Guardado y exportación de sesiones combinadas (más de un modo a la vez)

---

## FASE 1 — Rebranding a "Pavement Check"

### 1.1 Cambios de texto

| Ubicación | Cambio |
|---|---|
| `<title>` en `index.html` | `Pavement Check` |
| Logo/marca en header (`.brand-name` o equivalente) | `PAVEMENT CHECK` |
| `manifest.json` → `name` | `Pavement Check` |
| `manifest.json` → `short_name` | `PavementCheck` (o `PvmtCheck` si hay límite de caracteres en el icono de inicio) |
| Cualquier mención a "Roadcheck IRI" en comentarios de cabecera de `app.js`/`index.html` | Actualizar a "Pavement Check" |
| Meta `apple-mobile-web-app-title` | `Pavement Check` |

### 1.2 Icono (opcional, valorar con el usuario)

Si el icono SVG embebido en `manifest.json` contiene texto "ROADCHECK" renderizado dentro del propio SVG, debe regenerarse con el nuevo nombre. Si es un icono genérico sin texto, no requiere cambios.

### ✅ Criterios de aceptación Fase 1
- [ ] No queda ninguna referencia visible a "Roadcheck IRI" en la interfaz de usuario
- [ ] El nombre de la PWA instalada (icono en pantalla de inicio del móvil) muestra "Pavement Check"
- [ ] Commit: `chore: rebranding completo a Pavement Check`

---

## FASE 2 — Arquitectura multi-modo

### 2.1 Sustituir el modo único por un conjunto de modos activos

```javascript
// ANTES: S.mode = 'iri' | 'urban' | 'comfort'
// AHORA:
S.activeModes = new Set(['iri']); // por defecto, Carretera activo en solitario al abrir la app
```

### 2.2 Regla de compatibilidad (única regla de exclusión del sistema)

```javascript
const MODE_INCOMPATIBLE_PAIRS = [['iri', 'urban']];

function toggleMode(mode) {
  if (S.activeModes.has(mode)) {
    S.activeModes.delete(mode);
    if (S.activeModes.size === 0) S.activeModes.add('iri'); // nunca dejar 0 modos activos, fallback a Carretera
  } else {
    // Si el modo que se activa es incompatible con alguno ya activo, desactivar el incompatible
    MODE_INCOMPATIBLE_PAIRS.forEach(([a, b]) => {
      if (mode === a && S.activeModes.has(b)) S.activeModes.delete(b);
      if (mode === b && S.activeModes.has(a)) S.activeModes.delete(a);
    });
    S.activeModes.add(mode);
  }
  saveCfg(); // persistir selección de modos en localStorage (rc_activeModes)
  renderModeUI();
  renderMainPanels(); // ver Fase 4
}
```

### 2.3 Vehículo obligatorio solo si Carretera está activo

Modificar la validación existente en `startMeasurement()`:

```javascript
// ANTES: if (!S.vehicleId) { ... bloquear inicio ... }
// AHORA:
if (S.activeModes.has('iri') && !S.vehicleId) {
  toast('⚠️ Selecciona un vehículo (necesario para el modo Carretera)');
  openGarage();
  return;
}
```

Si Carretera **no** está entre los modos activos, el inicio procede sin exigir vehículo. El chip de vehículo en la pantalla principal debe indicarlo visualmente (ej. atenuado o con texto "No requerido" cuando Carretera no está activo).

### ✅ Criterios de aceptación Fase 2
- [ ] Activar Urbano con Carretera activo desactiva automáticamente Carretera (y viceversa)
- [ ] Activar Confort no desactiva nada
- [ ] No es posible quedarse con 0 modos activos
- [ ] Iniciar sesión con solo Urbano y/o Confort activos, sin vehículo seleccionado, NO bloquea el inicio
- [ ] Iniciar sesión con Carretera activo, sin vehículo, SÍ bloquea el inicio (comportamiento ya existente, preservado)
- [ ] Commit: `feat(arch): arquitectura multi-modo con regla de exclusión Carretera↔Urbano`

---

## FASE 3 — Selector de modos tipo chip (sustituye al selector de 1 sola opción)

### 3.1 HTML

```html
<div class="mode-selector" id="modeSelector">
  <button class="mode-chip" data-mode="iri" onclick="toggleMode('iri')">
    <span class="mc-ico">🛣️</span><span class="mc-lbl">Carretera</span>
  </button>
  <button class="mode-chip" data-mode="urban" onclick="toggleMode('urban')">
    <span class="mc-ico">🕳️</span><span class="mc-lbl">Urbano</span>
  </button>
  <button class="mode-chip" data-mode="comfort" onclick="toggleMode('comfort')">
    <span class="mc-ico">📳</span><span class="mc-lbl">Confort</span>
  </button>
</div>
```

### 3.2 Estilo

Reutilizar el lenguaje visual ya validado (`--sky`, `--sky-a`, `--sky-b`, `--s1`, `--s2`, bordes `--ln`). Estado activo: fondo `--sky-a`, borde `--sky-b`, icono/texto en `--sky`. Estado inactivo: fondo `--s1`, borde `--ln`, texto atenuado `--dim`.

```javascript
function renderModeUI() {
  document.querySelectorAll('.mode-chip').forEach(btn => {
    const mode = btn.dataset.mode;
    btn.classList.toggle('active', S.activeModes.has(mode));
  });
}
```

### 3.3 Feedback al intentar combinación inválida

Aunque la Fase 2 resuelve la incompatibilidad automáticamente (desactivando el otro modo sin bloquear), añadir un **toast informativo breve** la primera vez que esto ocurra en una sesión de uso, para que el usuario entienda por qué se desactivó algo solo:

```javascript
// Dentro de toggleMode(), justo antes de desactivar el incompatible:
toast('Carretera y Urbano no pueden combinarse — se ha desactivado el otro modo');
```

### ✅ Criterios de aceptación Fase 3
- [ ] Los 3 chips se muestran correctamente y reflejan el estado real de `S.activeModes`
- [ ] El toast informativo aparece al provocar la desactivación automática
- [ ] Commit: `feat(ui): selector de modos tipo chip multi-activación`

---

## FASE 4 — Paneles apilados compactos

### 4.1 Cada panel de modo necesita una variante compacta

Los 3 paneles ya existentes (`.iri-panel`, `.urban-panel`, `.comfort-panel`) deben aceptar una clase modificadora `.compact` que:
- Reduce el tamaño de fuente de los valores principales (~30-40% menos que la versión expandida)
- Reduce el padding interno
- Elimina elementos secundarios no esenciales (ej. en compacto, ocultar la leyenda de escala, mantener solo el valor + color de estado)

```css
.iri-panel.compact .iri-val,
.urban-panel.compact .u-val,
.comfort-panel.compact .comfort-value { font-size: 1.1rem; } /* ejemplo, ajustar a la escala real del proyecto */
.iri-panel.compact .iri-scale,
.comfort-panel.compact .comfort-bar { height: 2px; }
```

### 4.2 Lógica de renderizado según nº de modos activos

```javascript
function renderMainPanels() {
  const n = S.activeModes.size;
  ['iri', 'urban', 'comfort'].forEach(mode => {
    const panel = $(mode + 'Panel'); // iriPanel, urbanPanel, comfortPanel
    if (!panel) return;
    const isActive = S.activeModes.has(mode);
    panel.classList.toggle('hidden', !isActive);
    panel.classList.toggle('compact', isActive && n > 1);
  });
}
```

### 4.3 Orden de apilado cuando hay 2 paneles

Orden fijo, no depende del orden de activación: **Carretera/Urbano primero (el que esté activo de los dos, son excluyentes así que nunca compiten), Confort siempre debajo**. Esto da consistencia visual — el usuario siempre sabe dónde mirar cada cosa.

### ✅ Criterios de aceptación Fase 4
- [ ] Con 1 modo activo, su panel se muestra expandido (tamaño actual sin cambios)
- [ ] Con 2 modos activos, ambos paneles se muestran apilados en versión compacta, sin solaparse
- [ ] El orden de apilado es siempre el mismo (Carretera/Urbano arriba, Confort abajo)
- [ ] Commit: `feat(ui): paneles apilados compactos para combinación de 2 modos`

---

## FASE 5 — Corrección definitiva del layout (botón de inicio siempre visible)

### 5.1 Recalcular el presupuesto de altura del `clamp()`

Esta es la causa raíz del bug reportado: los cálculos de `clamp()` para el mapa (`.map-wrap`) se diseñaron pensando en un único panel de indicador. Con paneles compactos apilables (Fase 4) y la posibilidad de 2 paneles simultáneos, el presupuesto de altura disponible para el mapa cambia dinámicamente.

**Enfoque recomendado**: en vez de un `clamp()` estático en CSS puro, calcular la altura del mapa **en JavaScript** tras renderizar los paneles, restando del alto total de pantalla disponible:

```javascript
function recalcMainLayout() {
  const screenEl = $('tab-main');
  const header = screenEl.querySelector('.hdr');
  const modeSelector = $('modeSelector');
  const panelsContainer = $('mainPanelsContainer'); // contenedor de iriPanel+urbanPanel+comfortPanel
  const calBar = $('calPanel');
  const actGrid = screenEl.querySelector('.act-grid');
  const startBtn = $('btnStart');
  const calReqNote = $('calReqNote');

  const totalH = screenEl.clientHeight;
  const usedH = [header, modeSelector, panelsContainer, calBar, actGrid, startBtn, calReqNote]
    .filter(el => el && !el.classList.contains('hidden'))
    .reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);

  const gaps = 8 * 7; // estimar separación entre elementos, ajustar al gap real del CSS
  const availableForMap = Math.max(110, totalH - usedH - gaps);

  const mapWrap = $('mapMain')?.closest('.map-wrap');
  if (mapWrap) {
    mapWrap.style.height = availableForMap + 'px';
    S.mapMain?.invalidateSize();
  }
}
```

Llamar a `recalcMainLayout()`:
- Tras `renderMainPanels()` (cada vez que cambian los modos activos)
- En el evento `resize` de la ventana (rotación de pantalla, teclado virtual, etc.)
- Tras mostrar/ocultar el panel de calibración

### 5.2 Por qué este enfoque y no más `clamp()` anidados

Los `clamp()` en CSS no pueden conocer la altura real renderizada de un número variable de paneles (1 o 2, expandido o compacto) sin convertirse en una cascada de variables CSS extremadamente frágil. Calcular en JS tras el render real es más robusto y es exactamente el mismo principio que ya se usó para resolver el problema del mapa en `meas-sc` (inicialización lazy tras medir el contenedor real).

### ✅ Criterios de aceptación Fase 5
- [ ] El botón "Iniciar Medición" es visible sin scroll en los 5 escenarios: Carretera sola, Urbano solo, Confort solo, Carretera+Confort, Urbano+Confort
- [ ] Probar específicamente en una pantalla pequeña (simular ~640px de alto en las herramientas de desarrollador) — el peor caso
- [ ] El mapa se redimensiona correctamente (sin quedar negro ni con tamaño 0) al cambiar de combinación de modos
- [ ] Commit: `fix(layout): cálculo dinámico de altura para garantizar visibilidad del botón de inicio en cualquier combinación de modos`

---

## FASE 6 — Eliminar gráfico de acelerómetro de la pantalla principal

### 6.1 Retirar el `.chart-wrap`/`#mainChart` de `tab-main`

El gráfico en tiempo real de la pantalla principal deja de existir. La señal cruda de acelerómetro solo se visualiza en la pantalla de medición activa (Fase 8).

```javascript
// Eliminar de la función de inicialización: S.chartMain = makeChart('mainChart');
// Eliminar el nodo .chart-wrap del HTML de tab-main
```

> Esto libera espacio vertical adicional en la pantalla principal, lo que también ayuda a la Fase 5.

### ✅ Criterios de aceptación Fase 6
- [ ] No queda ningún gráfico visible en la pantalla principal
- [ ] No quedan referencias a `mainChart` causando errores en consola
- [ ] Commit: `refactor: eliminar gráfico de acelerómetro de pantalla principal`

---

## FASE 7 — Jerarquía visual y tono más amable

### 7.1 Orden de la pantalla principal (de arriba a abajo)

1. Header compacto (marca + chips de estado GPS/Sensor)
2. Selector de modos (chips)
3. Panel(es) de indicador (expandido o apilado compacto según Fase 4)
4. Mapa (toma el espacio restante, calculado en Fase 5)
5. Panel de calibración (solo si está calibrando, oculto el resto del tiempo)
6. Grid de acciones (vehículo/tramo/velocidad ref./calibrar)
7. Botón de inicio (siempre el último elemento, siempre visible)

### 7.2 Mensajes más conversacionales

Sustituir etiquetas puramente técnicas por texto más natural donde no se pierda precisión:

| Antes | Después |
|---|---|
| `SEN NCAL` | `Sensor sin calibrar` (o mantener abreviado en el chip pero con tooltip/title completo) |
| `Requerido` (en valor de calibración) | `Pulsa para calibrar` |
| Mensajes de `toast` ya existentes | Revisar que usen tono cercano, ej. "✅ Todo listo, calibración completada" en vez de solo el dato numérico de ruido |

> Claude Code: mantener el rigor técnico en los **datos** (números, unidades, nombres de parámetros en modales de configuración) — el tono "amable" aplica a mensajes de estado y guía al usuario, no a sustituir terminología técnica por vaguedades en contextos donde la precisión importa (recordar que esta es una herramienta para informes periciales).

### 7.3 Aire entre elementos

Revisar que el `gap` entre secciones principales de `tab-main` sea consistente y con algo más de respiro que el actual (ej. de `5px` a `7-8px` en los gaps principales, mantener los internos de cada panel más ajustados).

### ✅ Criterios de aceptación Fase 7
- [ ] El orden visual sigue exactamente la lista 7.1
- [ ] Los mensajes de estado clave se han revisado para sonar más naturales sin perder precisión técnica
- [ ] Commit: `style: jerarquía visual y tono conversacional en pantalla principal`

---

## FASE 8 — Nueva pantalla de medición: mapa 75% / gráfico 3 ejes 25%

### 8.1 Layout

```css
#meas-sc {
  display: flex; flex-direction: column;
  /* estructura existente de header/stats se mantiene */
}
.m-map { flex: 3; min-height: 0; /* 75% relativo */ }
.m-chart-3axis { flex: 1; min-height: 90px; /* 25% relativo */ }
```

Usar `flex: 3` / `flex: 1` sobre los dos contenedores principales (mapa y gráfico) dentro del área flexible de la pantalla de medición consigue la proporción 75/25 de forma robusta independientemente de la altura total de pantalla — más fiable que porcentajes fijos.

### 8.2 Gráfico de 3 ejes con datos crudos

Nuevo gráfico Chart.js (sustituye al `measChart` actual de IRI/Urbano en pantalla de medición):

```javascript
function make3AxisChart(canvasId) {
  const ctx = $(canvasId)?.getContext('2d');
  if (!ctx) return null;
  return new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'X', data: [], borderColor: '#EF4444', yAxisID: 'y', tension: .25, pointRadius: 0, fill: false },
      { label: 'Y', data: [], borderColor: '#10B981', yAxisID: 'y', tension: .25, pointRadius: 0, fill: false },
      { label: 'Z', data: [], borderColor: '#0EA5E9', yAxisID: 'y', tension: .25, pointRadius: 0, fill: false }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: { display: false }, y: { display: false } }, // mismo criterio que ya se aplicó para evitar solapamiento
      plugins: { legend: { display: false } } // leyenda manual en HTML, mismo patrón ya usado
    }
  });
}
```

Leyenda manual en HTML (mismo patrón ya validado para el gráfico anterior, sin superposición):

```html
<div class="chart-3axis-wrap">
  <div class="chart-hdr">
    <span class="chart-lbl">Acelerómetro (X·Y·Z)</span>
    <div class="chart-leg">
      <div class="cl"><div class="cl-ln" style="background:#EF4444"></div>X</div>
      <div class="cl"><div class="cl-ln" style="background:#10B981"></div>Y</div>
      <div class="cl"><div class="cl-ln" style="background:#0EA5E9"></div>Z</div>
    </div>
  </div>
  <div class="chart-cnv"><canvas id="measChart3Axis"></canvas></div>
</div>
```

### 8.3 Buffer de datos crudos para el gráfico

```javascript
S.rawAxisBuf = { x: [], y: [], z: [], max: 80 };

function feedRawAxisChart(x, y, z) {
  S.rawAxisBuf.x.push(x); S.rawAxisBuf.y.push(y); S.rawAxisBuf.z.push(z);
  if (S.rawAxisBuf.x.length > S.rawAxisBuf.max) {
    S.rawAxisBuf.x.shift(); S.rawAxisBuf.y.shift(); S.rawAxisBuf.z.shift();
  }
  updateMeas3AxisChart();
}
```

Llamar a `feedRawAxisChart(x, y, z)` desde el mismo punto de entrada del acelerómetro (`onRaw`) que ya alimenta los 3 pipelines existentes (IRI, Urbano, Confort) — un único punto de entrada de datos crudos, múltiples consumidores.

### 8.4 Resaltado de eventos por modo activo

Cada modo activo define su propio criterio de "instante destacable". Mantener un registro de marcas a superponer en el gráfico:

```javascript
S.chartMarks = []; // {idxInBuffer, color, source}

function registerChartMark(color, source) {
  S.chartMarks.push({ idx: S.rawAxisBuf.x.length - 1, color, source, ts: Date.now() });
  // Limpiar marcas más antiguas que el propio buffer (ya no visibles)
  S.chartMarks = S.chartMarks.filter(m => Date.now() - m.ts < 3000);
}
```

**Disparadores por modo** (llamar a `registerChartMark()` desde el punto correspondiente de cada pipeline ya existente):

| Modo activo | Disparador | Color de marca |
|---|---|---|
| Urbano | Cuando `registerEvent()` confirma un evento (no descartado) | Naranja `#F59E0B` (o rojo `#EF4444` si severidad grave) |
| Carretera | Cuando el IRI corregido instantáneo entra en zona "Malo" (`iriC > 5`) | Rojo `#EF4444` |
| Confort | Cuando `av` cruza a nivel "Incómodo" o peor (`av > 0.8`) | Púrpura `#A855F7` |

### 8.5 Renderizado de las marcas sobre el gráfico (plugin Chart.js)

Reutilizar el patrón de plugin de línea vertical ya usado en el gráfico de detalle de ruta (`vertLinePlugin`), adaptado para soportar múltiples marcas con color:

```javascript
const multiMarkPlugin = {
  id: 'multiMark',
  afterDatasetsDraw(chart) {
    if (!S.chartMarks?.length) return;
    const meta = chart.getDatasetMeta(0);
    S.chartMarks.forEach(mark => {
      if (mark.idx < 0 || mark.idx >= meta.data.length) return;
      const x = meta.data[mark.idx]?.x;
      if (x === undefined) return;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = mark.color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.restore();
    });
  }
};
```

Si hay 2 modos activos simultáneos, ambos pueden generar marcas en el mismo gráfico con sus colores respectivos — no hay conflicto, son eventos independientes que comparten el eje temporal.

### ✅ Criterios de aceptación Fase 8
- [ ] La proporción 75/25 se mantiene correctamente en distintos tamaños de pantalla
- [ ] El gráfico muestra los 3 ejes con colores distintos y leyenda sin solapamiento (mismo criterio ya validado anteriormente)
- [ ] Al simular un evento Urbano durante una sesión con Urbano activo, aparece la marca naranja/roja en el instante correcto
- [ ] Con Carretera+Confort activos simultáneamente, ambos tipos de marca pueden aparecer en el mismo gráfico sin interferirse
- [ ] Commit: `feat(measurement): pantalla de medición con mapa 75%/gráfico 3 ejes 25% y resaltado de eventos multi-modo`

---

## FASE 9 — Guardado de sesiones combinadas

### 9.1 Estructura de ruta guardada con múltiples datasets

```javascript
{
  id, date, pts, // estructura base ya existente
  modesUsed: ['iri', 'comfort'], // array de modos activos durante esta sesión
  iriData: { segs, avgC, avgM, vehicleId } | null,      // null si Carretera no estuvo activo
  urbanData: { events } | null,                          // null si Urbano no estuvo activo
  comfortData: { segments, avgAv, vdvSession, fsUsed } | null // null si Confort no estuvo activo
}
```

### 9.2 Historial: indicar combinación de modos en cada tarjeta de ruta

Añadir badges pequeños en `.rc-meta` de cada tarjeta del historial indicando qué modos generaron esa sesión (ej. `🛣️+📳` para Carretera+Confort).

### ✅ Criterios de aceptación Fase 9
- [ ] Una sesión con 2 modos activos guarda correctamente ambos datasets sobre el mismo recorrido GPS
- [ ] El historial muestra qué combinación de modos generó cada ruta
- [ ] Las rutas antiguas (guardadas antes de este cambio, con la estructura previa de un solo modo) se siguen abriendo sin errores — añadir compatibilidad hacia atrás en la función de carga
- [ ] Commit: `feat(storage): guardado de sesiones combinadas multi-modo con compatibilidad retroactiva`

---

## FASE 10 — Exportaciones combinadas

### 10.1 XLSX y HTML

Adaptar `expXLSX()`/`expHTML()` (y sus equivalentes de Urbano/Confort si son funciones separadas) para que, dado un `route.modesUsed`, incluyan únicamente las hojas/secciones correspondientes a los modos presentes en esa sesión — sin generar secciones vacías para modos no usados.

### ✅ Criterios de aceptación Fase 10
- [ ] Exportar una ruta Carretera+Confort genera un XLSX/HTML con ambas secciones, sin secciones de Urbano vacías
- [ ] Exportar una ruta de un solo modo (compatibilidad retroactiva) sigue funcionando igual que antes
- [ ] Commit: `feat(export): exportaciones adaptadas a sesiones combinadas multi-modo`

---

## RESUMEN DE ARCHIVOS A MODIFICAR

| Archivo | Cambios |
|---|---|
| `app.js` | Arquitectura multi-modo, recálculo de layout, gráfico de 3 ejes, guardado/exportación combinados |
| `index.html` | Rebranding, selector de chips, eliminación de gráfico principal, nueva estructura de pantalla de medición |
| `manifest.json` | Rebranding |

## ORDEN DE EJECUCIÓN

1. Confirmar que `RIDE_COMFORT_SPEC.md` está completamente implementado y validado (Fase 7 de ese documento)
2. Fases 1 → 10 de este documento, en orden, commit tras cada una
3. Prueba manual final: recorrer las 5 combinaciones válidas de modos (Carretera, Urbano, Confort, Carretera+Confort, Urbano+Confort) verificando que en todas ellas el botón de inicio es visible y el flujo completo (calibrar → iniciar → medir → detener → guardar → exportar) funciona sin errores
4. Actualizar `CLAUDE.md` con la arquitectura multi-modo final
