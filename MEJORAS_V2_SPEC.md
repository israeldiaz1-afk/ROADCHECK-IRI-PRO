# Especificación Técnica: UI Fixes + Calibración Adaptativa + Red Colaborativa
## Pavement Check — Paquete de mejoras v2

> **Instrucciones para Claude Code**: Sigue las fases en orden estricto, commit al finalizar cada una. No modifiques la lógica de cálculo de IRI, Urbano ni Confort — solo UI, calibración y red. Si algo no está claro, pregunta antes de implementar. Requisito previo: el repo debe estar migrado a Cloudflare Pages antes de iniciar la Fase 6 (red colaborativa). Las Fases 1-5 son independientes de Cloudflare y pueden implementarse antes de la migración.

---

## FASE 1 — Legibilidad global: escala de textos

### 1.1 Problema
Los textos de la app son demasiado pequeños para uso en movimiento o con luz solar directa. Afecta especialmente a valores numéricos, chips de estado y etiquetas de panel.

### 1.2 Cambios CSS

Aplicar en `:root` del `index.html`:

```css
:root {
  /* Escala base aumentada: todo el sistema de tipografía sube proporcionalmente */
  --fs-xs:   0.72rem;   /* antes ~0.58rem — etiquetas secundarias */
  --fs-sm:   0.82rem;   /* antes ~0.68rem — chips, badges, metadatos */
  --fs-md:   0.95rem;   /* antes ~0.78rem — texto de panel, botones */
  --fs-lg:   1.15rem;   /* antes ~0.95rem — valores compactos */
  --fs-xl:   1.55rem;   /* antes ~1.25rem — valores principales */
  --fs-xxl:  2.10rem;   /* antes ~1.80rem — valor IRI/av central */

  /* Tamaño mínimo de área táctil (WCAG 2.5.5) */
  --tap-min: 44px;
}
```

### 1.3 Aplicación específica por elemento

| Elemento | Propiedad | Nuevo valor |
|---|---|---|
| Valores IRI/av/score principales (`.iri-val`, `.comfort-value`) | `font-size` | `var(--fs-xxl)` |
| Valores compactos (panel apilado `.compact`) | `font-size` | `var(--fs-xl)` |
| Chips de estado (`.chip`) | `font-size` / `min-height` | `var(--fs-sm)` / `var(--tap-min)` |
| Botones de acción (`.btn`, `.mode-chip`) | `font-size` / `min-height` | `var(--fs-md)` / `var(--tap-min)` |
| Etiquetas de panel (`.iri-lbl`, `.u-lbl`, etc.) | `font-size` | `var(--fs-xs)` |
| Mensajes de estado (`.iriCond`, `.comfortLevel`) | `font-size` | `var(--fs-sm)` |
| Tabla historial (`.rc-name`, `.rc-meta`) | `font-size` | `var(--fs-sm)` / `var(--fs-xs)` |

### 1.4 Criterio de aceptación
- [ ] El valor IRI/av principal es legible a distancia de brazo extendido sin gafas
- [ ] Los chips de estado tienen área táctil mínima de 44px de altura
- [ ] Ningún texto relevante queda por debajo de 0.72rem
- [ ] Commit: `style: escala de textos global para legibilidad en campo`

---

## FASE 2 — Corrección parpadeo UI con múltiples modos activos

### 2.1 Problema
Cuando Confort + Carretera están activos simultáneamente, `updateIRI()` y `updateComfortUI()` actualizan el DOM de forma independiente a frecuencias distintas (~65ms y ~100ms respectivamente), causando reflows concurrentes y parpadeo visible en los dígitos.

### 2.2 Solución: cola de actualizaciones UI centralizada

```javascript
// Reemplazar todas las llamadas directas a funciones de actualización de UI
// por un sistema de cola con un único rAF por frame.

const UI_QUEUE = {};
let uiFramePending = false;

function queueUI(key, fn) {
  UI_QUEUE[key] = fn; // la última actualización por clave gana (no se acumulan)
  if (!uiFramePending) {
    uiFramePending = true;
    requestAnimationFrame(flushUI);
  }
}

function flushUI() {
  uiFramePending = false;
  const keys = Object.keys(UI_QUEUE);
  keys.forEach(k => { try { UI_QUEUE[k](); } catch(e) {} delete UI_QUEUE[k]; });
}
```

### 2.3 Migración de funciones existentes

Sustituir las llamadas directas en `onVert()` y `onComfortSample()`:

```javascript
// ANTES:
updateIRI(iriM, iriC);
updateComfortUI(av);

// AHORA:
queueUI('iri', () => updateIRI(iriM, iriC));
queueUI('comfort', () => updateComfortUI(av));
```

Aplicar el mismo patrón a `onUrbanEventDetected()` y `updateStats()`.

### 2.4 Criterios de aceptación
- [ ] Con Carretera + Confort activos, los dígitos son estables sin parpadeo durante 30s de prueba
- [ ] La frecuencia de actualización visual no supera 60fps (garantizado por rAF)
- [ ] Commit: `fix: cola de actualizaciones UI con rAF para eliminar parpadeo multi-modo`

---

## FASE 3 — Panel de medición Urbano: contadores de eventos

### 3.1 Problema
Mostrar IRI durante una sesión en modo Urbano no tiene sentido — ese motor no está activo. El panel de medición debe mostrar información relevante del modo activo.

### 3.2 Nueva lógica de panel de medición según modos activos

```javascript
function updateMeasPanel() {
  const hasIRI     = S.activeModes.has('iri');
  const hasUrban   = S.activeModes.has('urban');
  const hasComfort = S.activeModes.has('comfort');

  // Panel IRI: solo si Carretera está activo
  $('measIRIPanel')?.classList.toggle('hidden', !hasIRI);

  // Panel Urbano: solo si Urbano está activo
  $('measUrbanPanel')?.classList.toggle('hidden', !hasUrban);

  // Panel Confort: solo si Confort está activo
  $('measComfortPanel')?.classList.toggle('hidden', !hasComfort);
}
```

### 3.3 Nuevo panel de medición Urbano

```html
<div class="meas-urban-panel hidden" id="measUrbanPanel">
  <div class="meas-event-counts">
    <div class="mec">
      <span class="mec-val" id="muLeve">0</span>
      <span class="mec-lbl">🟡 Leves</span>
    </div>
    <div class="mec">
      <span class="mec-val" id="muMod" style="color:#F97316">0</span>
      <span class="mec-lbl">🟠 Moderados</span>
    </div>
    <div class="mec">
      <span class="mec-val" id="muGrave" style="color:#EF4444">0</span>
      <span class="mec-lbl">🔴 Graves</span>
    </div>
  </div>
  <div class="meas-last-event" id="muLastEvent">Sin eventos detectados</div>
</div>
```

Actualizar desde `onUrbanEventDetected()` vía `queueUI()`:

```javascript
queueUI('urban_meas', () => {
  const counts = S.urbanEvents.reduce((a, e) => {
    a[e.severity] = (a[e.severity] || 0) + 1; return a;
  }, {});
  set('muLeve',  (counts.leve     || 0).toString());
  set('muMod',   (counts.moderado || 0).toString());
  set('muGrave', (counts.grave    || 0).toString());
  const last = S.urbanEvents[S.urbanEvents.length - 1];
  if (last) {
    const icons = { pothole:'🕳️', manhole:'⭕', speedbump:'⛰️', unknown:'❓' };
    $('muLastEvent').textContent =
      `${icons[last.type] || '❓'} ${last.type} · ${last.severity} · score ${last.score.toFixed(0)}`;
  }
});
```

### 3.4 Criterios de aceptación
- [ ] En modo Urbano, el panel de medición muestra los 3 contadores, sin IRI
- [ ] En modo Carretera, el panel muestra IRI como antes
- [ ] Con Urbano + Confort, se ven ambos paneles apilados (contadores + a_v)
- [ ] Commit: `feat(meas): panel de medición Urbano con contadores de eventos`

---

## FASE 4 — Gráfico acelerómetro: 3 canales EKG independientes

### 4.1 Concepto
En vez de 3 líneas superpuestas en el mismo eje Y (ilegible en móvil), mostrar 3 carriles horizontales independientes como un EKG o un sismógrafo. Cada carril ocupa exactamente 1/3 de la altura disponible.

```
┌─────────────────────────────────────────────┐
│ Z │──────/\/\────────────────────────────── │  ← vertical (baches)
├─────────────────────────────────────────────┤
│ X │──────────────────────────────────────── │  ← lateral
├─────────────────────────────────────────────┤
│ Y │─────────────────────────────────╲────── │  ← longitudinal (frenadas)
└─────────────────────────────────────────────┘
     ↑ marcas de eventos (franjas verticales de color)
```

### 4.2 Implementación con Canvas 2D nativo (sin Chart.js)

```javascript
// Sustituir make3AxisChart() y updateMeas3AxisChart() por esta implementación.
// Canvas 2D es ~10x más ligero que Chart.js para este caso de uso.

const EKG = {
  canvas: null, ctx: null,
  W: 0, H: 0,        // dimensiones actuales
  buf: { z:[], x:[], y:[], marks:[], max:120 }, // 2s a 60Hz
  COLORS: { z:'#0EA5E9', x:'#EF4444', y:'#10B981' },
  LABELS: { z:'Z', x:'X', y:'Y' },
  animId: null
};

function initEKG(canvasId) {
  EKG.canvas = $(canvasId);
  if (!EKG.canvas) return;
  EKG.ctx = EKG.canvas.getContext('2d');
  // Tamaño físico = CSS px × devicePixelRatio para nitidez en pantallas HiDPI
  const resize = () => {
    const rect = EKG.canvas.getBoundingClientRect();
    EKG.canvas.width  = rect.width  * devicePixelRatio;
    EKG.canvas.height = rect.height * devicePixelRatio;
    EKG.W = EKG.canvas.width;
    EKG.H = EKG.canvas.height;
  };
  resize();
  new ResizeObserver(resize).observe(EKG.canvas);
}

function pushEKG(z, x, y) {
  ['z','x','y'].forEach(ax => {
    EKG.buf[ax].push({ax}.ax === 'z' ? z : {ax}.ax === 'x' ? x : y);
    if (EKG.buf[ax].length > EKG.buf.max) EKG.buf[ax].shift();
  });
  // Nota Claude Code: simplificar el push anterior — es pseudocódigo ilustrativo.
  // Implementar como: EKG.buf.z.push(z); EKG.buf.x.push(x); EKG.buf.y.push(y);
  // con el trim correspondiente.
  if (!EKG.animId) EKG.animId = requestAnimationFrame(drawEKG);
}

function markEKG(color) {
  EKG.buf.marks.push({ idx: EKG.buf.z.length - 1, color });
  if (EKG.buf.marks.length > 20) EKG.buf.marks.shift();
}

function drawEKG() {
  EKG.animId = null;
  if (!EKG.ctx || EKG.W === 0) return;
  const { ctx, W, H, buf, COLORS, LABELS } = EKG;
  const AXES = ['z','x','y'];
  const rowH = H / 3;
  const labelW = 28 * devicePixelRatio;

  ctx.clearRect(0, 0, W, H);

  AXES.forEach((ax, i) => {
    const y0 = i * rowH;
    const plotW = W - labelW;

    // Fondo de carril (alternado para distinguirlos)
    ctx.fillStyle = i % 2 === 0 ? 'rgba(9,24,41,.9)' : 'rgba(13,32,64,.9)';
    ctx.fillRect(0, y0, W, rowH);

    // Separador horizontal
    ctx.strokeStyle = 'rgba(14,165,233,.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();

    // Etiqueta de eje
    ctx.fillStyle = COLORS[ax];
    ctx.font = `bold ${14 * devicePixelRatio}px Courier New`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(LABELS[ax], labelW / 2, y0 + rowH / 2);

    // Línea central de referencia (0 m/s²)
    const midY = y0 + rowH / 2;
    ctx.strokeStyle = 'rgba(14,165,233,.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(labelW, midY); ctx.lineTo(W, midY); ctx.stroke();
    ctx.setLineDash([]);

    // Señal
    const data = buf[ax];
    if (data.length < 2) return;
    const scaleY = (rowH / 2) / 12; // ±12 m/s² = rango completo del carril
    ctx.strokeStyle = COLORS[ax];
    ctx.lineWidth = 1.5 * devicePixelRatio;
    ctx.beginPath();
    data.forEach((v, j) => {
      const px = labelW + (j / buf.max) * plotW;
      const py = midY - v * scaleY;
      j === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();

    // Marcas de eventos (franjas verticales de color que atraviesan el carril)
    buf.marks.forEach(m => {
      if (m.idx < 0 || m.idx >= buf.max) return;
      const px = labelW + (m.idx / buf.max) * plotW;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 2 * devicePixelRatio;
      ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(px, y0 + 2); ctx.lineTo(px, y0 + rowH - 2); ctx.stroke();
      ctx.globalAlpha = 1;
    });
  });
}

function stopEKG() {
  if (EKG.animId) { cancelAnimationFrame(EKG.animId); EKG.animId = null; }
  EKG.buf.z = []; EKG.buf.x = []; EKG.buf.y = []; EKG.buf.marks = [];
}
```

### 4.3 Integración con el pipeline de datos

Llamar a `pushEKG(ax, ay, az)` desde `onRaw()` cuando la sesión está activa, justo después de alimentar los otros pipelines. Llamar a `markEKG(color)` desde `registerChartMark()` existente en vez del plugin Chart.js anterior.

### 4.4 Criterios de aceptación
- [ ] Los 3 carriles son claramente distinguibles a primera vista
- [ ] La línea de referencia (0 m/s²) es visible en cada carril
- [ ] Un golpe seco al móvil produce un pico claro en el carril Z
- [ ] Un frenazo produce una desviación clara en el carril Y (longitudinal)
- [ ] Las marcas de eventos atraviesan los 3 carriles simultáneamente con el color correcto por modo
- [ ] No hay parpadeo ni artefactos — el canvas se renderiza a demanda (no en bucle continuo)
- [ ] Commit: `feat(meas): gráfico EKG de 3 canales independientes con Canvas 2D nativo`

---

## FASE 5 — Calibración dinámica adaptativa continua

### 5.1 Concepto

La calibración actual es estática: se mide el vector de gravedad una vez al inicio y se usa fijo durante toda la sesión. Si el móvil se mueve ligeramente en su soporte (lo cual siempre ocurre), el eje vertical calibrado se desvía y todos los cálculos se contaminan progresivamente.

La calibración adaptativa recalcula continuamente el vector de gravedad usando **solo las muestras "en calma"** (velocidad constante, sin curvas, sin eventos activos), de forma silenciosa y sin interrumpir la medición.

### 5.2 Estado global

```javascript
S.adaptiveCal = {
  active: false,          // true cuando hay condiciones para recalibrar
  gravBuf: [],            // buffer de muestras "en calma" para recálculo
  gravBufMax: 180,        // 3s a 60Hz
  lastUpdate: 0,          // timestamp del último ajuste
  updateCount: 0,         // nº de recalibraciones realizadas en la sesión
  driftDeg: 0,            // desviación acumulada desde la calibración inicial (grados)
  driftThresholdDeg: 2.0, // umbral de aviso al usuario (2° de desviación)
  status: 'idle'          // 'idle' | 'sampling' | 'updated' | 'drift_warning'
};
```

### 5.3 Condiciones para muestras "en calma"

Una muestra se considera válida para recalibración adaptativa si SE CUMPLEN TODAS:
1. `S.lastPos.speed` entre 15 y 90 km/h (velocidad constante de crucero, no parado ni brusco)
2. Aceleración lateral `|ay_calibrada|` < 0.3 m/s² (sin curvas)
3. Jerk vertical `|Δvert/Δt|` < 0.8 m/s³ (sin baches activos)
4. No hay ningún evento urbano activo en los últimos 500ms
5. La sesión lleva más de 10s activa (evitar arranque)

### 5.4 Algoritmo de recalibración

```javascript
function feedAdaptiveCalibration(x, y, z, timestamp) {
  if (!S.active || !S.calibrated) return;

  const speed = S.lastPos?.speed || 0;
  const g = S.grav;
  const vertCal = x*g.x + y*g.y + z*g.z;
  const latCal  = Math.abs(x*g.y - y*g.x); // simplificación, suficiente para campo

  // Verificar condiciones de calma
  const prevVert = S.adaptiveCal.gravBuf[S.adaptiveCal.gravBuf.length-1]?.vert || vertCal;
  const jerk = Math.abs(vertCal - prevVert) * 60; // aproximación a 60Hz
  const calm = speed > 15 && speed < 90 && latCal < 0.3 && jerk < 0.8
               && !S._recentUrbanEvent && (timestamp - S._sessionStart) > 10000;

  if (!calm) {
    S.adaptiveCal.status = 'idle';
    return;
  }

  S.adaptiveCal.status = 'sampling';
  S.adaptiveCal.gravBuf.push({ x, y, z, vert: vertCal });
  if (S.adaptiveCal.gravBuf.length > S.adaptiveCal.gravBufMax) S.adaptiveCal.gravBuf.shift();

  // Recalcular cada 3s de muestras en calma acumuladas
  if (S.adaptiveCal.gravBuf.length < S.adaptiveCal.gravBufMax) return;

  let mx=0, my=0, mz=0;
  S.adaptiveCal.gravBuf.forEach(s=>{mx+=s.x;my+=s.y;mz+=s.z;});
  const n = S.adaptiveCal.gravBuf.length;
  mx/=n; my/=n; mz/=n;
  const mag = Math.sqrt(mx*mx+my*my+mz*mz);
  if (mag < 0.5) return; // muestra inválida

  const newGrav = { x:mx/mag, y:my/mag, z:mz/mag };

  // Calcular desviación angular respecto al vector calibrado original
  const dot = newGrav.x*g.x + newGrav.y*g.y + newGrav.z*g.z;
  const driftDeg = Math.acos(Math.min(1, Math.abs(dot))) * 180 / Math.PI;

  S.adaptiveCal.driftDeg = driftDeg;
  S.adaptiveCal.lastUpdate = timestamp;
  S.adaptiveCal.updateCount++;
  S.adaptiveCal.gravBuf = []; // resetear buffer tras actualizar

  if (driftDeg > S.adaptiveCal.driftThresholdDeg) {
    // Deriva significativa: actualizar el vector de gravedad silenciosamente
    S.grav = newGrav;
    S.gravMag = mag;
    S.adaptiveCal.status = 'updated';
    queueUI('adaptiveCal', updateAdaptiveCalUI);
  } else {
    S.adaptiveCal.status = 'idle';
  }
}
```

### 5.5 Indicador visual de calibración adaptativa

El usuario debe ser consciente en todo momento del estado de calibración. Añadir un indicador compacto en la pantalla de medición, junto a los chips de estado existentes:

```html
<div class="adapt-cal-indicator" id="adaptCalInd">
  <div class="aci-dot" id="aciDot"></div>
  <span class="aci-txt" id="aciTxt">Cal. estática</span>
</div>
```

Estados visuales del indicador:

| Estado | Color del punto | Texto | Significado |
|---|---|---|---|
| `idle` | Gris `#3A5F7A` | `Cal. estática` | Calibración original activa, sin condiciones para recalibrar |
| `sampling` | Azul pulsante `#0EA5E9` | `Recalibrando…` | Acumulando muestras en calma |
| `updated` | Verde `#10B981` | `Cal. actualizada ×N` | Vector de gravedad ajustado N veces en la sesión |
| `drift_warning` | Ámbar `#F59E0B` | `Deriva X.X°` | Solo informativo, ya se corrigió automáticamente |

Animación del punto azul durante `sampling`:
```css
.aci-dot.sampling { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%,100%{opacity:.4;transform:scale(.8)} 50%{opacity:1;transform:scale(1.2)} }
```

```javascript
function updateAdaptiveCalUI() {
  const st = S.adaptiveCal.status;
  const dot = $('aciDot'), txt = $('aciTxt');
  if (!dot || !txt) return;
  dot.className = 'aci-dot ' + st;
  const colors = { idle:'#3A5F7A', sampling:'#0EA5E9', updated:'#10B981', drift_warning:'#F59E0B' };
  dot.style.background = colors[st] || '#3A5F7A';
  const texts = {
    idle: 'Cal. estática',
    sampling: 'Recalibrando…',
    updated: `Cal. ×${S.adaptiveCal.updateCount}`,
    drift_warning: `Deriva ${S.adaptiveCal.driftDeg.toFixed(1)}°`
  };
  txt.textContent = texts[st] || 'Cal. estática';
}
```

### 5.6 Integración con onRaw()

```javascript
// Añadir al final de onRaw(), después de alimentar los otros pipelines:
if (S.active && !S.paused) {
  feedAdaptiveCalibration(x, y, z, Date.now());
  queueUI('adaptiveCal', updateAdaptiveCalUI);
}
```

### 5.7 Criterios de aceptación
- [ ] Conduciendo a velocidad constante en línea recta, el indicador pasa de "Cal. estática" a "Recalibrando…" en menos de 5 segundos
- [ ] Tras 3s de muestras en calma acumuladas, el indicador muestra "Cal. ×1"
- [ ] Al girar o frenar bruscamente, el indicador vuelve a "Cal. estática" (condiciones de calma no cumplidas)
- [ ] El vector de gravedad actualizado en `S.grav` se refleja inmediatamente en los cálculos de IRI, Urbano y Confort (todos usan `S.grav`)
- [ ] Commit: `feat: calibración dinámica adaptativa continua con indicador en tiempo real`

---

## FASE 6 — Migración a Cloudflare Pages

> Esta fase es prerequisito de la Fase 7 (red colaborativa). No requiere tocar código de la app.

### 6.1 Pasos

1. En Cloudflare Dashboard → Pages → Create project → Connect to Git
2. Seleccionar el repo `ROADCHECK-IRI-PRO` de GitHub
3. Build settings: Framework preset = None, build command vacío, output directory = `/` (raíz del repo, ya que es una PWA estática sin build step)
4. Deploy → Cloudflare asignará un dominio `pavement-check.pages.dev` (o similar)
5. En GitHub → Settings → Pages → desactivar GitHub Pages (o dejarlo como backup, no hay conflicto)

### 6.2 Headers necesarios para la PWA (crear `_headers` en raíz del repo)

```
/*
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Opener-Policy: same-origin
  Cache-Control: no-cache
  
/sw.js
  Cache-Control: no-cache, no-store
  
/manifest.json
  Cache-Control: max-age=86400
```

### 6.3 Criterios de aceptación
- [ ] La app carga correctamente desde el dominio `.pages.dev` asignado
- [ ] El sensor y el GPS funcionan (requieren HTTPS — Cloudflare lo proporciona automáticamente)
- [ ] El service worker se registra correctamente
- [ ] Commit: `chore: migración a Cloudflare Pages + headers PWA`

---

## FASE 7 — Red colaborativa: Cloudflare Worker + KV

### 7.1 Arquitectura

```
App (PWA) ←→ Cloudflare Worker (API REST) ←→ KV Store (eventos compartidos)
```

El Worker es una API JSON minimalista con 3 endpoints:

| Endpoint | Método | Descripción |
|---|---|---|
| `/api/events` | GET | Obtener eventos confirmados en un bounding box GPS |
| `/api/events` | POST | Enviar nuevos eventos de una sesión |
| `/api/events/:id/confirm` | POST | Confirmar un evento existente (pasada adicional) |

### 7.2 Estructura del Worker (`workers/pavement-check-api/index.js`)

```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    // GET /api/events?lat=X&lon=Y&r=R  → eventos en radio R metros
    if (url.pathname === '/api/events' && request.method === 'GET') {
      const lat = parseFloat(url.searchParams.get('lat'));
      const lon = parseFloat(url.searchParams.get('lon'));
      const r   = Math.min(parseFloat(url.searchParams.get('r') || '500'), 2000); // máx 2km
      if (isNaN(lat) || isNaN(lon)) return new Response('{"error":"lat/lon required"}', { status:400, headers });

      // Leer índice de celdas de la rejilla (~100m × 100m)
      const cellKeys = getCellKeys(lat, lon, r);
      const events = [];
      await Promise.all(cellKeys.map(async key => {
        const val = await env.EVENTS_KV.get(key, 'json');
        if (val) events.push(...val);
      }));

      // Filtrar solo confirmados (confirmCount >= 2) o recientes (< 7 días)
      const now = Date.now();
      const filtered = events.filter(e =>
        e.confirmCount >= 2 || (now - e.ts) < 7 * 86400 * 1000
      );
      return new Response(JSON.stringify(filtered), { headers });
    }

    // POST /api/events → enviar nuevos eventos
    if (url.pathname === '/api/events' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return new Response('{"error":"invalid json"}', {status:400,headers}); }
      const events = Array.isArray(body.events) ? body.events : [];
      if (!events.length) return new Response('{"ok":true,"stored":0}', { headers });

      // Sanitizar y almacenar — anonimizar lat/lon a la rejilla de 10m
      let stored = 0;
      for (const ev of events.slice(0, 50)) { // máx 50 eventos por POST
        if (!ev.lat || !ev.lon || !ev.type || !ev.severity) continue;
        const cellKey = getCellKey(ev.lat, ev.lon);
        const cell = (await env.EVENTS_KV.get(cellKey, 'json')) || [];

        // Buscar evento existente en la misma celda y mismo tipo (±10m)
        const existing = cell.find(e =>
          haversine(e.lat, e.lon, ev.lat, ev.lon) < 10 && e.type === ev.type
        );

        if (existing) {
          existing.confirmCount = (existing.confirmCount || 1) + 1;
          existing.score = ((existing.score * (existing.confirmCount-1)) + ev.score) / existing.confirmCount;
          existing.lastSeen = Date.now();
        } else {
          cell.push({
            id: crypto.randomUUID(),
            ts: Date.now(),
            lat: snapToGrid(ev.lat, 0.0001),  // snap a ~10m para anonimizar
            lon: snapToGrid(ev.lon, 0.0001),
            type: ev.type,
            severity: ev.severity,
            score: ev.score || 50,
            confirmCount: 1,
            lastSeen: Date.now()
          });
        }

        // Expirar eventos > 90 días sin confirmación
        const pruned = cell.filter(e => (Date.now() - e.lastSeen) < 90 * 86400 * 1000);
        await env.EVENTS_KV.put(cellKey, JSON.stringify(pruned), { expirationTtl: 90*86400 });
        stored++;
      }
      return new Response(JSON.stringify({ ok: true, stored }), { headers });
    }

    return new Response('{"error":"not found"}', { status: 404, headers });
  }
};

// Rejilla de celdas ~100m × 100m para indexación KV
function getCellKey(lat, lon) {
  return `cell:${Math.round(lat*1000)}:${Math.round(lon*1000)}`;
}
function getCellKeys(lat, lon, radiusM) {
  const dLat = (radiusM / 111320) * 1.1;
  const dLon = (radiusM / (111320 * Math.cos(lat * Math.PI/180))) * 1.1;
  const keys = new Set();
  for (let dlat = -dLat; dlat <= dLat; dlat += 0.001)
    for (let dlon = -dLon; dlon <= dLon; dlon += 0.001)
      keys.add(getCellKey(lat+dlat, lon+dlon));
  return [...keys];
}
function snapToGrid(val, step) { return Math.round(val / step) * step; }
function haversine(a, b, c, d) {
  const R=6371000, r=x=>x*Math.PI/180;
  const s=Math.sin(r(c-a)/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(r(d-b)/2)**2;
  return R*2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));
}
```

### 7.3 Configuración del Worker (`wrangler.toml` en raíz del repo)

```toml
name = "pavement-check-api"
main = "workers/pavement-check-api/index.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "EVENTS_KV"
id = "REEMPLAZAR_CON_ID_REAL_TRAS_CREAR_EL_KV"
```

### 7.4 Consentimiento en la app (primera vez)

Al finalizar la primera sesión (evento `stopMeasurement`), si el usuario no ha dado respuesta todavía:

```javascript
function checkSharingConsent() {
  const consent = localStorage.getItem('rc_sharing_consent');
  if (consent !== null) return; // ya respondió
  $('sharingConsentModal').classList.remove('hidden');
}
```

```html
<div class="modal hidden" id="sharingConsentModal">
  <div class="modal-box">
    <h3>🌐 Red colaborativa</h3>
    <p>¿Quieres compartir los eventos detectados (baches, tapas, badenes) con otros usuarios de Pavement Check?</p>
    <p class="modal-note">Los datos se comparten de forma anónima — las coordenadas GPS se aproximan a una precisión de ~10m y no se envía ningún dato personal.</p>
    <div class="modal-acts">
      <button onclick="setSharing(true, false)">Sí, compartir</button>
      <button onclick="setSharing(false, false)" class="btn-sec">No por ahora</button>
    </div>
    <label class="chk-row" style="margin-top:10px">
      <input type="checkbox" id="sharingNoAsk"> No volver a preguntar
    </label>
  </div>
</div>

function setSharing(yes, silent) {
  const noAsk = $('sharingNoAsk')?.checked || silent;
  localStorage.setItem('rc_sharing_consent', yes ? 'yes' : 'no');
  if (!noAsk) localStorage.removeItem('rc_sharing_consent'); // volverá a preguntar la próxima vez
  else localStorage.setItem('rc_sharing_consent', yes ? 'yes' : 'no');
  $('sharingConsentModal').classList.add('hidden');
  if (yes) syncEventsToNetwork();
}
```

### 7.5 Sincronización con la red

```javascript
const WORKER_URL = 'https://pavement-check-api.TU_USUARIO.workers.dev';

async function syncEventsToNetwork() {
  if (localStorage.getItem('rc_sharing_consent') !== 'yes') return;
  const events = JSON.parse(localStorage.getItem('rc_urban_events') || '[]')
    .filter(e => e.confirmed && e.confirmCount >= 1);
  if (!events.length) return;
  try {
    await fetch(`${WORKER_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events })
    });
    log('Eventos sincronizados con la red: ' + events.length);
  } catch(e) { /* silencioso — no bloquear la app si falla la red */ }
}

async function fetchNetworkEvents(lat, lon, radiusM=500) {
  if (localStorage.getItem('rc_sharing_consent') !== 'yes') return [];
  try {
    const r = await fetch(`${WORKER_URL}/api/events?lat=${lat}&lon=${lon}&r=${radiusM}`);
    return await r.json();
  } catch { return []; }
}
```

### 7.6 Visualización en el Visor Global

Los eventos de la red se muestran en el Visor con un estilo distinto a los propios:
- Marcador más transparente (opacity 0.6)
- Borde discontinuo
- Tooltip: "Red · confirmado por N usuarios"
- Se cargan automáticamente al abrir el Visor si el usuario ha dado consentimiento

### 7.7 Criterios de aceptación
- [ ] El Worker desplegado responde correctamente a GET y POST en `/api/events`
- [ ] El modal de consentimiento aparece al finalizar la primera sesión
- [ ] Si el usuario marca "No volver a preguntar" y acepta, no vuelve a aparecer
- [ ] Si el usuario marca "No volver a preguntar" y rechaza, tampoco vuelve a aparecer
- [ ] Los eventos locales confirmados se envían al Worker tras consentimiento
- [ ] Los eventos de la red aparecen en el Visor Global diferenciados visualmente de los propios
- [ ] Si el Worker no está disponible, la app funciona exactamente igual (degradación silenciosa)
- [ ] Commit: `feat: red colaborativa de eventos con Cloudflare Worker + KV`

---

## RESUMEN DE ARCHIVOS

| Archivo | Cambios |
|---|---|
| `index.html` | Fases 1-5: CSS escala textos, panel urbano medición, EKG canvas, indicador cal. adaptativa, modal consentimiento |
| `app.js` | Fases 2-5: cola rAF, contadores urbano, EKG Canvas2D, calibración adaptativa |
| `_headers` | Fase 6: headers Cloudflare Pages |
| `wrangler.toml` | Fase 7: configuración Worker |
| `workers/pavement-check-api/index.js` | Fase 7: código del Worker |

## ORDEN DE EJECUCIÓN

1. Fases 1-5 (no requieren Cloudflare) → commit por fase
2. Fase 6 (migración Cloudflare Pages) → el usuario configura manualmente en el dashboard
3. Fase 7 (Worker + KV) → commit + `wrangler deploy`
4. Actualizar `WORKER_URL` en `app.js` con la URL real del Worker desplegado
5. Actualizar `CLAUDE.md` con la nueva arquitectura
