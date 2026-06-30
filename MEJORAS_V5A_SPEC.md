# Especificación Técnica: Paquete A — Correcciones + Calibración + Separación de Ruido
## Pavement Check — v5a

> **Instrucciones para Claude Code**:
> 1. Lee este documento COMPLETO antes de tocar una sola línea de código.
> 2. Ejecuta las fases en orden estricto. No empieces la siguiente sin terminar la anterior.
> 3. Cada fase tiene referencias exactas a líneas del código actual — úsalas, no reinterpretes.
> 4. Al finalizar TODAS las fases: `git push`. Cloudflare despliega automáticamente.
> 5. Ante cualquier duda, para y pregunta. No implementes soluciones alternativas sin consultar.

---

## FASE 1 — Correcciones de bugs críticos

### 1.1 Etiqueta "No confortable" → "Confortable"

**Archivo**: `app.js`
**Búsqueda exacta** (el array `COMFORT_SCALE` contiene esta línea):
```javascript
{ max: 0.315, level: 'no_confortable', label: 'No confortable', color: '#10B981' },
```
**Sustitución exacta**:
```javascript
{ max: 0.315, level: 'no_confortable', label: 'Confortable', color: '#10B981' },
```
> ⚠️ Solo cambia el valor de `label`. No toques `level`, `max` ni `color`.

---

### 1.2 Botón ⊕ de centrado: reposicionar para no tapar indicador de velocidad

**Archivo**: `index.html`
**Contexto**: el botón existe en `.map-wrap` dentro de `#tab-main` y en `.m-map` dentro de `#meas-sc`.

En **ambas** ocurrencias, cambiar el CSS inline del botón de `bottom:12px; right:12px` a `bottom:12px; left:12px`:

```html
<!-- ANTES (en ambos mapas): -->
<button class="btn-map-center" onclick="centerMapOnMe('main')">⊕</button>

<!-- DESPUÉS: añadir style explícito para moverlo a la izquierda -->
<button class="btn-map-center" style="bottom:12px;left:12px;right:auto" onclick="centerMapOnMe('main')">⊕</button>
<button class="btn-map-center" style="bottom:12px;left:12px;right:auto" onclick="centerMapOnMe('meas')">⊕</button>
```

Si el CSS de `.btn-map-center` tiene `right:12px` hardcodeado, añadir `right:auto` en el style inline es suficiente para sobreescribirlo.

---

### 1.3 EKG: corregir marcas espurias con antirebote por source

**Archivo**: `app.js`
**Función a sustituir**: `registerChartMark()` (actualmente en líneas ~1847-1865 según el código que me mostraste)

**Sustitución completa**:
```javascript
function registerChartMark(color, source) {
  if (!EKG.buf) return;
  const now = EKG.buf.totalSamples;

  // ANTIREBOTE: no registrar dos marcas del mismo source
  // en menos de 30 muestras (~0.5s a 60Hz).
  // Esto elimina las marcas espurias cuando un evento Z
  // tarda 2s en atenuarse y el algoritmo dispara múltiples veces.
  const recent = EKG.buf.marks.find(
    m => m.source === source && (now - m.absIdx) < 30
  );
  if (recent) return;

  EKG.buf.marks.push({ absIdx: now - 1, color, source, ts: Date.now() });

  // Limpiar marcas que ya han salido del buffer visible
  EKG.buf.marks = EKG.buf.marks.filter(
    m => (now - m.absIdx) <= EKG.buf.max
  );
}
```

**En `drawEKG()`**, envolver el bloque de dibujo de marcas en `ctx.save()`/`ctx.restore()` para evitar que un error en el globalAlpha contamine el resto del canvas:

Localizar el `buf.marks.forEach(m => {` dentro de `drawEKG()` y añadir save/restore:

```javascript
// ANTES:
buf.marks.forEach(m => {
  const bufStart = Math.max(0, buf.totalSamples - buf.max);
  const relIdx = m.absIdx - bufStart;
  if (relIdx < 0 || relIdx >= buf.max) return;
  const px = labelW + (relIdx / buf.max) * plotW;
  ctx.strokeStyle = m.color; ctx.lineWidth = 2 * devicePixelRatio; ctx.globalAlpha = .7;
  ctx.beginPath(); ctx.moveTo(px, y0 + 2); ctx.lineTo(px, y0 + rowH - 2); ctx.stroke();
  ctx.globalAlpha = 1;
});

// DESPUÉS:
ctx.save(); // ← AÑADIR
buf.marks.forEach(m => {
  const bufStart = Math.max(0, buf.totalSamples - buf.max);
  const relIdx = m.absIdx - bufStart;
  if (relIdx < 0 || relIdx >= buf.max) return;
  const px = labelW + (relIdx / buf.max) * plotW;
  ctx.strokeStyle = m.color;
  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.moveTo(px, y0 + 2);
  ctx.lineTo(px, y0 + rowH - 2);
  ctx.stroke();
});
ctx.restore(); // ← AÑADIR (sustituye el ctx.globalAlpha = 1 anterior)
```

---

### 1.4 Selector de cámara: no mostrar si no hay cámara externa

**Archivo**: `app.js`
**Función a sustituir**: `initCameraSelector()` completa

```javascript
async function initCameraSelector() {
  try {
    // Pedir permiso genérico primero para que el navegador revele los deviceIds reales
    const tmpStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    tmpStream.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');

    // Detectar cámaras externas: las integradas de Android siempre contienen
    // 'facing', 'camera2', 'built-in', 'back' o 'front' en su label.
    // Una cámara USB externa tendrá un label distinto (ej. "USB Camera", "HD Camera")
    const externalCams = videoDevices.filter(d => {
      const lbl = (d.label || '').toLowerCase();
      return !lbl.includes('facing') &&
             !lbl.includes('camera2') &&
             !lbl.includes('built-in') &&
             !lbl.includes('back') &&
             !lbl.includes('front') &&
             !lbl.includes('cámara') &&
             !lbl.includes('camera 0') &&
             !lbl.includes('camera 1') &&
             !lbl.includes('camera 2') &&
             !lbl.includes('camera 3');
    });

    if (externalCams.length === 0) {
      // Solo cámaras integradas — usar la principal trasera sin preguntar nada
      S.selectedCameraId = null; // null → getUserMedia usará facingMode:'environment'
      startVideoBuffer();
      return;
    }

    // Hay al menos una cámara externa — mostrar selector con opciones claras
    const opts = [
      ...externalCams.map(d => ({
        deviceId: d.deviceId,
        label: '🔌 ' + (d.label || 'Cámara externa')
      })),
      { deviceId: '__builtin__', label: '📱 Cámara trasera del móvil' }
    ];
    showCameraSelector(opts);

  } catch(e) {
    log('[Cámara] No disponible: ' + e.message);
    // No bloquear la sesión si la cámara falla
    startVideoBuffer();
  }
}
```

**También corregir** `confirmCameraSelection()` para manejar `__builtin__`:
```javascript
function confirmCameraSelection() {
  const sel = document.querySelector('input[name="camDev"]:checked');
  const val = sel?.value;
  // '__builtin__' significa usar la cámara trasera integrada
  S.selectedCameraId = (val && val !== '__builtin__') ? val : null;
  $('cameraSelectorModal').classList.add('hidden');
  startVideoBuffer();
}

function skipCamera() {
  S.selectedCameraId = null;
  $('cameraSelectorModal').classList.add('hidden');
  // No iniciar buffer — la sesión continúa sin cámara
}
```

**Mover el momento de inicialización**: el selector debe aparecer al INICIAR la sesión, no al terminarla.
En `startMeasurement()`, añadir la llamada al inicio:
```javascript
// En startMeasurement(), DESPUÉS de validar calibración y vehículo,
// ANTES de mostrar la pantalla de medición:
if (S.activeModes.has('urban') || S.activeModes.has('comfort')) {
  await initCameraSelector(); // esperar a que el usuario elija o se descarte
}
```
> ⚠️ `startMeasurement()` debe ser `async` si no lo es ya.

### ✅ Criterios Fase 1
- [ ] El nivel más bajo de confort visible dice "Confortable" (no "No confortable")
- [ ] El botón ⊕ está en la esquina inferior IZQUIERDA del mapa en ambas pantallas
- [ ] El EKG no muestra múltiples marcas juntas para el mismo evento — máximo 1 marca por source cada 0.5s
- [ ] Al iniciar sesión sin cámara externa conectada: NO aparece ningún selector de cámara
- [ ] El selector de cámara aparece al INICIAR la sesión, no al terminarla
- [ ] Commit: `fix: etiqueta Confortable, botón mapa izquierda, EKG antirebote, selector cámara`

---

## FASE 2 — Pantalla principal limpia

### 2.1 Qué eliminar de `#tab-main`

La pantalla principal deja de mostrar valores en tiempo real de IRI, Urbano ni Confort. Esos valores solo se muestran durante la sesión activa (pantalla de medición).

**En `index.html`**, dentro de `#mainPanelsContainer`, sustituir el contenido completo por un único indicador de vibración de fondo:

```html
<!-- ELIMINAR completamente: iriPanel, urbanPanel, comfortPanel -->
<!-- SUSTITUIR por: -->
<div id="mainPanelsContainer">
  <div class="baseline-indicator" id="baselineIndicator">
    <div class="bi-row">
      <div class="bi-dot" id="biDot"></div>
      <span class="bi-label" id="biLabel">Sensor sin calibrar</span>
    </div>
    <div class="bi-detail" id="biDetail"></div>
  </div>
</div>
```

```css
.baseline-indicator {
  display: flex; flex-direction: column; gap: 4px;
  padding: 8px 12px;
  background: var(--s2);
  border-radius: var(--r8);
  border: 1px solid rgba(14,165,233,.12);
  margin: 4px 0;
}
.bi-row { display: flex; align-items: center; gap: 8px; }
.bi-dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  background: var(--dim); transition: background .4s;
}
.bi-label { font-size: var(--fs-sm); color: var(--txt); font-family: var(--mono); }
.bi-detail { font-size: var(--fs-xs); color: var(--dim); font-family: var(--mono); padding-left: 18px; }
```

**Lógica del indicador** — actualizar desde `endCal()` y en el loop de `onVert()` cuando NO está activa la sesión:

```javascript
function updateBaselineIndicator() {
  const dot = $('biDot'), lbl = $('biLabel'), det = $('biDetail');
  if (!dot) return;

  if (!S.calibrated) {
    dot.style.background = '#3A5F7A';
    lbl.textContent = 'Sensor sin calibrar';
    det.textContent = 'Pulsa 🎯 para calibrar antes de iniciar';
    return;
  }

  // Todos los modos calibrados: mostrar que el ruido de fondo es cero
  const noiseOk = S.noiseLevel <= 0.15; // umbral de "ruido aceptable"
  dot.style.background = noiseOk ? '#10B981' : '#F59E0B';
  lbl.textContent = noiseOk ? '✅ Ruido de fondo calibrado' : '⚠️ Ruido de fondo elevado';

  // Detalle por modo activo
  const details = [];
  if (S.activeModes.has('iri'))     details.push('IRI: baseline OK');
  if (S.activeModes.has('urban'))   details.push('Urbano: umbral ' + (S.noiseBaseline.mean + 4*S.noiseBaseline.std).toFixed(3) + ' m/s²');
  if (S.activeModes.has('comfort')) details.push('Confort: a_v baseline ' + (S.comfort.avBaseline||0).toFixed(3) + ' m/s²');
  det.textContent = details.join(' · ');
}
```

Llamar a `updateBaselineIndicator()`:
- Al finalizar `endCal()` (exitoso)
- Desde `recalcMainLayout()` (cada vez que cambia el layout)
- Al llamar a `setMode()` / `toggleMode()`

### 2.2 Eliminar registro de recorrido en el mapa principal

El mapa de la pantalla principal no debe dibujar la línea de recorrido mientras no hay sesión activa. La línea solo debe existir en la pantalla de medición (`mapMeas`).

**En `initStaticMaps()`**, eliminar la creación de `S.lineMain`:
```javascript
// ELIMINAR esta línea:
S.lineMain = L.polyline([], { color:'#0EA5E9', weight:6, opacity:.9 }).addTo(S.mapMain);
```

**En `onGPS()`**, eliminar todas las referencias a `S.lineMain`:
```javascript
// ELIMINAR:
S.lineMain?.addLatLng([lat, lon]);
```

**En `startMeasurement()`**, eliminar el reset de `S.lineMain`:
```javascript
// ELIMINAR:
S.lineMain?.setLatLngs([]);
```

> El marcador de posición actual (`S.mkMain` / `mapMk(S.mapMain,...)`) SÍ se mantiene — sirve para centrar el mapa en la posición actual, que sí tiene sentido en la pantalla principal.

### ✅ Criterios Fase 2
- [ ] La pantalla principal no muestra ningún valor IRI, eventos urbanos ni a_v de confort
- [ ] Se muestra el indicador de baseline: verde + "✅ Ruido de fondo calibrado" tras calibrar
- [ ] El mapa principal no dibuja ninguna línea de recorrido
- [ ] El marcador de posición actual sigue visible en el mapa principal
- [ ] Commit: `feat: pantalla principal limpia con indicador de baseline`

---

## FASE 3 — Calibración adaptativa A3 (parada + botón manual)

### 3.1 Recalibración automática en parada detectada

La condición de calma actual (velocidad 15-90 km/h) nunca se cumple en ciudad. Sustituir por detección de parada (semáforo, stop).

**En `feedAdaptiveCalibration()`** (líneas 1883-1916 del código actual), sustituir COMPLETAMENTE la función:

```javascript
function feedAdaptiveCalibration(x, y, z, timestamp) {
  if (!S.calibrated || !S.grav) return;

  const speed = S.lastPos?.speed || 0;
  const sessionAge = timestamp - (S._sessionStart || timestamp);

  // DOS condiciones de recalibración (A3):
  // A) Parada detectada: v < 2 km/h durante > 4s consecutivos (semáforo, stop)
  // B) Manual: S._manualRecalRequest === true (botón pulsado por el usuario)

  const stopped = speed < 2;

  if (stopped) {
    S.adaptiveCal._stopStart = S.adaptiveCal._stopStart || timestamp;
    const stopDuration = timestamp - S.adaptiveCal._stopStart;
    if (stopDuration < 4000) return; // esperar 4s de parada continua
    // 4s de parada → condición A cumplida, continuar
  } else {
    // Al moverse, resetear el contador de parada
    S.adaptiveCal._stopStart = null;
    if (!S._manualRecalRequest) {
      S.adaptiveCal.status = 'idle';
      queueUI('adaptiveCal', updateAdaptiveCalUI);
      return;
    }
  }

  // Limpiar flag de solicitud manual
  if (S._manualRecalRequest) S._manualRecalRequest = false;

  // Acumular muestras de gravedad (mismo algoritmo que la calibración inicial)
  S.adaptiveCal.status = 'sampling';
  queueUI('adaptiveCal', updateAdaptiveCalUI);

  S.adaptiveCal.gravBuf.push({ x, y, z });
  if (S.adaptiveCal.gravBuf.length > S.adaptiveCal.gravBufMax) {
    S.adaptiveCal.gravBuf.shift();
  }

  // Necesitamos el buffer completo para calcular la media
  if (S.adaptiveCal.gravBuf.length < S.adaptiveCal.gravBufMax) return;

  // Calcular nuevo vector de gravedad
  let mx = 0, my = 0, mz = 0;
  S.adaptiveCal.gravBuf.forEach(s => { mx += s.x; my += s.y; mz += s.z; });
  const n = S.adaptiveCal.gravBuf.length;
  mx /= n; my /= n; mz /= n;
  const mag = Math.sqrt(mx*mx + my*my + mz*mz);
  if (mag < 0.5) return; // vector degenerado, ignorar

  const newGrav = { x: mx/mag, y: my/mag, z: mz/mag };

  // Calcular deriva angular respecto al vector actual
  const g = S.grav;
  const dot = Math.min(1, Math.abs(newGrav.x*g.x + newGrav.y*g.y + newGrav.z*g.z));
  const driftDeg = Math.acos(dot) * 180 / Math.PI;

  S.adaptiveCal.driftDeg = driftDeg;
  S.adaptiveCal.lastUpdate = timestamp;
  S.adaptiveCal.updateCount++;
  S.adaptiveCal.gravBuf = []; // resetear buffer
  S.adaptiveCal._stopStart = null; // resetear contador de parada

  // Aplicar siempre en parada (incluso con deriva pequeña — es un momento seguro)
  S.grav = newGrav;
  S.gravMag = mag;
  S.adaptiveCal.status = 'updated';

  // Recalcular también el baseline de confort con la nueva orientación
  if (S.comfort?.avBaseline !== undefined) {
    // El baseline se recalculará en el próximo ciclo de computeLiveComfort()
    // cuando la señal esté en reposo (velocidad < 2 km/h garantizada aquí)
    S.comfort.avBaseline = Math.max(0, S.comfort.avLive || 0) * 0.5;
  }

  log('[CalAdaptiva] Recalibrado en parada · deriva=' + driftDeg.toFixed(2) + '° · ×' + S.adaptiveCal.updateCount);
  queueUI('adaptiveCal', updateAdaptiveCalUI);
}
```

### 3.2 Botón de recalibración manual

**En `index.html`**, dentro de `#meas-sc`, añadir el botón junto al indicador de calibración adaptativa existente (`#adaptCalBar`):

```html
<!-- Junto a .adapt-cal-bar existente, dentro del mismo contenedor -->
<div class="adapt-cal-row">
  <div class="adapt-cal-bar" id="adaptCalBar">
    <div class="acb-left">
      <div class="acb-dot" id="aciDot"></div>
      <span class="acb-status" id="aciTxt">Cal. estática</span>
    </div>
    <div class="acb-right">
      <span class="acb-count hidden" id="aciCount">🔄 <span id="aciCountVal">0</span> recal.</span>
      <span class="acb-drift hidden" id="aciDrift"></span>
    </div>
  </div>
  <button class="btn-recal" id="btnManualRecal" onclick="requestManualRecal()"
    title="Recalibrar ahora (usa cuando estés parado en semáforo)">
    🎯
  </button>
</div>
```

```css
.adapt-cal-row {
  display: flex; align-items: center; gap: 6px;
  flex-shrink: 0;
}
.btn-recal {
  width: 36px; height: 36px; border-radius: 50%;
  background: var(--s2); border: 1px solid rgba(14,165,233,.25);
  color: var(--sky); font-size: 1rem; cursor: pointer; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
.btn-recal:active { background: rgba(14,165,233,.15); }
```

**Función en `app.js`**:
```javascript
function requestManualRecal() {
  if (!S.calibrated) { toast('Calibra el sensor primero'); return; }
  S._manualRecalRequest = true;
  S.adaptiveCal.gravBuf = []; // resetear buffer para acumular fresh
  S.adaptiveCal.status = 'sampling';
  queueUI('adaptiveCal', updateAdaptiveCalUI);
  toast('🎯 Recalibrando… mantén el móvil quieto 3s');
}
```

### 3.3 Actualizar `updateAdaptiveCalUI()` para mostrar contador correctamente

La función actual ya existe — solo añadir la visualización del contador (`aciCount`) que actualmente puede estar oculto:

```javascript
// En updateAdaptiveCalUI(), en el bloque del contador:
const n = S.adaptiveCal.updateCount;
const cntEl = $('aciCount');
if (cntEl) {
  cntEl.classList.toggle('hidden', n === 0);
  const cntVal = $('aciCountVal');
  if (cntVal) cntVal.textContent = n;
}
```

### ✅ Criterios Fase 3
- [ ] Parado 4s en semáforo → el indicador cambia a "Recalibrando…" (punto azul pulsante)
- [ ] Tras 3s de acumulación → "Cal. ×1" aparece en el indicador
- [ ] El botón 🎯 en la pantalla de medición dispara recalibración inmediata
- [ ] Al reanudar la marcha, el indicador vuelve a "Cal. estática" hasta la próxima parada
- [ ] Commit: `feat: calibración adaptativa A3 — automática en parada y botón manual`

---

## FASE 4 — Separación de ruido de rodadura: 3 capas

### 4.1 Estado global para las 3 capas

```javascript
// Añadir al objeto S al inicio de app.js:
S.noiseFilter = {
  // Capa 1: modelo gaussiano en tiempo real
  eventMask: false,     // true durante 1s tras un evento — excluye esas muestras del modelo
  eventMaskTs: 0,

  // Capa 2: percentil post-procesado (se calcula al terminar la sesión)
  percentile15: 0,      // percentil 15 de amplitud de toda la sesión
  appliedPost: false,   // true si ya se aplicó el post-procesado

  // Capa 3: firma espectral automática
  refBuf: [],           // buffer de los tramos más suaves (percentil bajo acumulado)
  refBufMax: 600,       // ~10s de muestras "suaves"
  refSpectrum: null,    // firma espectral de referencia una vez calculada
};
```

### 4.2 Capa 1 — Modelo gaussiano mejorado (excluir eventos del cálculo de fondo)

**En `updateNoiseBaseline()`** (líneas 366-372 del código actual), sustituir:

```javascript
function updateNoiseBaseline(vert) {
  // NUEVO: excluir muestras durante y justo después de un evento detectado
  // (los eventos contaminan el cálculo de la "vibración de fondo normal")
  const now = Date.now();
  if (S.noiseFilter.eventMask && (now - S.noiseFilter.eventMaskTs) < 1000) {
    return; // dentro de la ventana de máscara de evento — no actualizar la línea base
  }
  S.noiseFilter.eventMask = false;

  S.noiseBaseline.samples.push(Math.abs(vert));
  if (S.noiseBaseline.samples.length > 300) S.noiseBaseline.samples.shift();

  S.noiseBaseline.mean = S.noiseBaseline.samples.reduce((a, b) => a + b, 0)
                         / S.noiseBaseline.samples.length;

  const variance = S.noiseBaseline.samples.reduce(
    (a, b) => a + (b - S.noiseBaseline.mean) ** 2, 0
  ) / S.noiseBaseline.samples.length;

  S.noiseBaseline.std = Math.sqrt(variance);
}
```

**En `registerEvent()`** (donde se confirma un evento urbano), activar la máscara:
```javascript
// Al inicio de registerEvent(), antes de hacer el push a S.urbanEvents:
S.noiseFilter.eventMask = true;
S.noiseFilter.eventMaskTs = Date.now();
```

### 4.3 Capa 3 — Firma espectral automática (identificar tramos suaves propios de la sesión)

La Capa 3 aprende qué es "asfalto bueno" para esta sesión específica analizando los tramos de menor vibración. No requiere intervención del usuario.

```javascript
function updateReferenceSpectrum(vert, speedKmh) {
  // Solo acumular muestras a velocidad de crucero y sin eventos recientes
  if (speedKmh < 10 || speedKmh > 90) return;
  if (S.noiseFilter.eventMask) return;

  const absVert = Math.abs(vert);

  // Solo añadir al buffer de referencia si la muestra está por debajo
  // del percentil 20 actual del baseline (tramos más suaves)
  const p20Threshold = S.noiseBaseline.mean + 0.5 * S.noiseBaseline.std;
  if (absVert > p20Threshold) return;

  S.noiseFilter.refBuf.push(absVert);
  if (S.noiseFilter.refBuf.length > S.noiseFilter.refBufMax) {
    S.noiseFilter.refBuf.shift();
  }

  // Calcular firma espectral de referencia una vez que tengamos suficientes muestras
  if (S.noiseFilter.refBuf.length >= S.noiseFilter.refBufMax) {
    const mean = S.noiseFilter.refBuf.reduce((a, b) => a + b, 0) / S.noiseFilter.refBuf.length;
    const std  = Math.sqrt(
      S.noiseFilter.refBuf.reduce((a, b) => a + (b - mean) ** 2, 0) / S.noiseFilter.refBuf.length
    );
    S.noiseFilter.refSpectrum = { mean, std, n: S.noiseFilter.refBuf.length };
  }
}
```

Llamar a `updateReferenceSpectrum(vert, speed)` desde `feedUrbanBuffer()` y desde el pipeline de IRI en `onVert()`.

### 4.4 Capa 2 — Post-procesado por percentil al terminar la sesión

**Nueva función** `applyPostProcessNoise()` llamada desde `stopMeasurement()` antes de mostrar el modal de guardar:

```javascript
function applyPostProcessNoise() {
  // Recoger todas las amplitudes de eventos de la sesión
  const allAmplitudes = S.urbanEvents.map(e => e.features?.peakAmp || 0);
  if (allAmplitudes.length < 5) return; // no suficientes datos

  // Calcular el percentil 15 (vibración de fondo típica de la sesión)
  const sorted = [...allAmplitudes].sort((a, b) => a - b);
  const p15idx = Math.floor(sorted.length * 0.15);
  S.noiseFilter.percentile15 = sorted[p15idx];

  // Reclasificar eventos: los que quedan por debajo del percentil + 1σ
  // del baseline son candidatos a ser "ruido de rodadura", no eventos reales
  const noiseThreshold = S.noiseFilter.percentile15 + S.noiseBaseline.std;

  let discarded = 0;
  S.urbanEvents = S.urbanEvents.filter(e => {
    const amp = e.features?.peakAmp || 0;
    if (amp <= noiseThreshold && e.severity === 'leve' && !e.geminiConfirm) {
      discarded++;
      return false; // descartar — probablemente ruido de rodadura
    }
    return true;
  });

  if (discarded > 0) {
    S.noiseFilter.appliedPost = true;
    toast(`🧹 Post-procesado: ${discarded} evento${discarded>1?'s':''} de ruido eliminado${discarded>1?'s':''}`);
    log(`[Ruido] Percentil 15=${S.noiseFilter.percentile15.toFixed(3)} · Umbral=${noiseThreshold.toFixed(3)} · Descartados=${discarded}`);
  }
}
```

**Botón "Limpiar ruido de fondo"** en el modal de guardar sesión:

```html
<!-- En el modal de nombrar ruta (routeNameModal), añadir antes del botón "Guardar": -->
<div class="noise-filter-row" id="noiseFilterRow" style="display:none">
  <span class="nfr-info" id="noiseFilterInfo"></span>
  <button class="btn btn-sec" onclick="applyPostProcessNoise();updateNoiseFilterUI()">
    🧹 Limpiar ruido de fondo
  </button>
</div>
```

```javascript
function updateNoiseFilterUI() {
  const row = $('noiseFilterRow');
  const info = $('noiseFilterInfo');
  if (!row || !info) return;
  const hasUrban = S.activeModes.has('urban') && S.urbanEvents.length > 0;
  row.style.display = hasUrban ? 'flex' : 'none';
  if (hasUrban) {
    info.textContent = S.noiseFilter.appliedPost
      ? `✅ Ruido de fondo eliminado`
      : `${S.urbanEvents.length} eventos · p15=${S.noiseFilter.percentile15.toFixed(3)} m/s²`;
  }
}
```

Llamar a `updateNoiseFilterUI()` al abrir `routeNameModal` en `stopMeasurement()`.

### ✅ Criterios Fase 4
- [ ] En el log durante sesión urbana: las muestras de "durante evento" no actualizan `noiseBaseline`
- [ ] Al terminar una sesión urbana con >5 eventos, aparece el botón "🧹 Limpiar ruido de fondo"
- [ ] Al pulsarlo: el toast indica cuántos eventos de ruido se eliminaron
- [ ] `S.noiseFilter.refSpectrum` se calcula tras ~10s de circulación en asfalto bueno (verificar en log)
- [ ] Commit: `feat: separación de ruido de rodadura — 3 capas (gaussiano, percentil, firma espectral)`

---

## FASE 5 — Línea de recorrido más gruesa

Un cambio de 3 líneas, pero en su propia fase para tener su propio commit limpio.

**En `app.js`**, localizar TODAS las instancias de `L.polyline` que crean líneas de recorrido y actualizar `weight`:

```javascript
// mapMeas (pantalla de medición activa):
S.lineMeas = L.polyline([], { color:'#0EA5E9', weight:6, opacity:.95 }).addTo(S.mapMeas);

// mapDetail (vista de detalle de ruta en historial):
// En initDetailMap(), en el forEach de segs:
L.polyline(coords, { color: seg.color||iCol(seg.iriC), weight:7, opacity:.92 })

// mapVisor (visor global):
// En refreshVisor(), en el forEach de segs:
L.polyline(coords, { color: iCol(iri), weight:7, opacity:.90 })
```

> `S.lineMain` ya fue eliminado en la Fase 2, así que no aparece aquí.

### ✅ Criterios Fase 5
- [ ] La línea de recorrido en la pantalla de medición es visiblemente más gruesa que antes
- [ ] La línea en el detalle de ruta y en el visor global también más gruesa
- [ ] Commit: `style: línea de recorrido weight 6-7 para visibilidad con luz solar`

---

## ORDEN DE EJECUCIÓN Y PUSH FINAL

```
Fase 1 → verificar criterios → commit
Fase 2 → verificar criterios → commit
Fase 3 → verificar criterios → commit
Fase 4 → verificar criterios → commit
Fase 5 → verificar criterios → commit
git push → Cloudflare Pages despliega automáticamente
```

## RESUMEN DE ARCHIVOS MODIFICADOS

| Archivo | Fases | Cambios principales |
|---|---|---|
| `app.js` | 1,2,3,4,5 | registerChartMark, initCameraSelector, updateBaselineIndicator, feedAdaptiveCalibration, updateNoiseBaseline, applyPostProcessNoise, updateReferenceSpectrum, requestManualRecal |
| `index.html` | 1,2,3,4 | btn-map-center posición, mainPanelsContainer simplificado, adapt-cal-row con botón manual, noiseFilterRow en modal guardar |

## VARIABLES GLOBALES NUEVAS EN S (para que el Spec B las pueda usar)

```javascript
// Estas variables deben existir en S tras implementar este spec:
S.noiseFilter = { eventMask, eventMaskTs, percentile15, appliedPost, refBuf, refBufMax, refSpectrum }
S.adaptiveCal._stopStart = null    // timestamp de inicio de parada detectada
S._manualRecalRequest = false      // flag de solicitud manual de recalibración
```
