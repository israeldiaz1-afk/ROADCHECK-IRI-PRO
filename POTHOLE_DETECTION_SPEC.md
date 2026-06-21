# Especificación Técnica: Módulo de Detección de Baches
## Roadcheck IRI — Modo Urbano (Pothole Detection Engine)

> **Instrucciones para Claude Code**: Este documento especifica un nuevo módulo a integrar en el proyecto Roadcheck IRI existente (`index.html` + `app.js`). Sigue las fases en orden. Cada fase tiene criterios de aceptación verificables. Haz commit de git al finalizar cada fase con el mensaje indicado. No avances a la siguiente fase sin completar los criterios de aceptación de la anterior. Si encuentras ambigüedad, prioriza: (1) no romper funcionalidad IRI existente, (2) mantener el estilo visual/arquitectura actual (vanilla JS, sin build step, Chart.js + Leaflet), (3) preguntar antes de tomar decisiones de diseño no especificadas aquí.

---

## 0. CONTEXTO DEL PROYECTO

- App existente: PWA vanilla JS (`index.html`, `app.js`, `manifest.json`, `sw.js`)
- Stack: Leaflet (mapas), Chart.js (gráficos), localStorage (persistencia)
- Ya existe: pipeline de acelerómetro con filtro paso-alto (`hpf()`), calibración de 6s (gravedad + ruido de fondo), cálculo de IRI con corrección por velocidad
- Objetivo: añadir un **segundo modo de funcionamiento** ("Modo Urbano") que en vez de calcular IRI continuo, detecta y clasifica **eventos discretos** (baches, badenes, tapas de registro) a baja velocidad, con confirmación espacial multi-pasada.
- **No eliminar ni romper el Modo Carretera (IRI) existente.** Ambos modos coexisten.

---

## FASE 1 — Estructura de datos y selector de modo

### 1.1 Nuevo estado global en `app.js`

Añadir al objeto `S` existente (no crear uno nuevo):

```javascript
// Modo de la app
S.mode = 'iri'; // 'iri' | 'urban'

// Buffer de muestras crudas para análisis de eventos (urban mode)
S.urbanBuf = []; // {t, ax, ay, az, vert} últimas N muestras, N = 60 (≈1s a 60Hz)
S.urbanBufMax = 90; // 1.5s de margen para capturar forma de onda completa

// Eventos detectados en la sesión activa
S.urbanEvents = []; // ver estructura de evento en 1.2

// Línea base de ruido adaptativa (se actualiza continuamente, no solo en calibración)
S.noiseBaseline = { mean: 0, std: 0.05, samples: [] }; // samples: ventana deslizante de 5s para recalcular
```

### 1.2 Estructura de un "evento" detectado

```javascript
{
  id: string,              // timestamp + random
  ts: number,               // epoch ms
  lat: number, lon: number,
  speed: number,            // km/h en el momento del evento
  type: 'pothole'|'manhole'|'speedbump'|'crack'|'unknown',
  severity: 'leve'|'moderado'|'grave',
  score: number,            // 0-100, score ponderado final
  features: {               // guardar para depuración/futuro ML
    peakAmp: number,
    jerkMax: number,
    duration: number,       // ms
    bipolarity: number,     // 0-1
    freqEnergy: number,     // energía banda 8-20Hz normalizada
    brakeCorrelation: number // 0-1, correlación con eje Y (frenado)
  },
  confirmed: boolean,        // true tras confirmación multi-pasada
  confirmCount: number       // nº de pasadas que lo confirman
}
```

### 1.3 Persistencia

Nueva clave localStorage: `rc_urban_events` (array de eventos confirmados, estructura igual a 1.2, agrupados — ver Fase 4).

### 1.4 UI: Selector de modo

En `index.html`, dentro de `#tab-main`, justo debajo del header (`.hdr`), añadir un selector de 2 botones tipo segmented control:

```html
<div class="mode-switch" id="modeSwitch">
  <button class="mode-btn active" data-mode="iri" onclick="setMode('iri')">🛣️ Carretera (IRI)</button>
  <button class="mode-btn" data-mode="urban" onclick="setMode('urban')">🕳️ Urbano (Baches)</button>
</div>
```

CSS coherente con el design system existente (`--sky`, `--s1`, `--s2`, `--mono`, `--r8`, bordes `var(--ln)`). Botón activo con fondo `var(--sky-a)` y borde `var(--sky-b)`, igual que `.chip.ok`.

`setMode(mode)` en `app.js`:
- Cambia `S.mode`
- Alterna visibilidad de los paneles específicos de cada modo (IRI panel vs nuevo panel urbano — ver Fase 3)
- Guarda preferencia en localStorage (`rc_mode`)
- Resetea buffers relevantes (`S.urbanBuf = []`, `S.urbanEvents = []`)

### ✅ Criterios de aceptación Fase 1
- [ ] El selector de modo aparece y cambia visualmente al pulsar
- [ ] `S.mode` cambia correctamente y persiste entre recargas (localStorage)
- [ ] No se rompe ninguna funcionalidad existente del modo IRI
- [ ] Commit: `feat(urban): estructura de datos y selector de modo`

---

## FASE 2 — Motor de extracción de características

### 2.1 Captura continua del buffer urbano

En la función existente `onRaw(x, y, z)` (o `onVert` si aplica), cuando `S.mode === 'urban'` y `S.calibrated === true`, además del procesado IRI normal, alimentar:

```javascript
function feedUrbanBuffer(x, y, z, t) {
  const g = S.grav;
  const vert = x*g.x + y*g.y + z*g.z - S.gravMag; // SIN valor absoluto — necesitamos el signo para forma de onda
  S.urbanBuf.push({ t, ax: x, ay: y, az: z, vert });
  if (S.urbanBuf.length > S.urbanBufMax) S.urbanBuf.shift();
  updateNoiseBaseline(vert);
  detectEvent(); // ver 2.3
}
```

### 2.2 Línea base de ruido adaptativa

```javascript
function updateNoiseBaseline(vert) {
  S.noiseBaseline.samples.push(Math.abs(vert));
  if (S.noiseBaseline.samples.length > 300) S.noiseBaseline.samples.shift(); // ~5s a 60Hz
  S.noiseBaseline.mean = S.noiseBaseline.samples.reduce((a,b)=>a+b,0) / S.noiseBaseline.samples.length;
  const variance = S.noiseBaseline.samples.reduce((a,b)=>a+(b-S.noiseBaseline.mean)**2,0) / S.noiseBaseline.samples.length;
  S.noiseBaseline.std = Math.sqrt(variance);
}
```

Esto reemplaza el uso de un `noiseLevel` fijo de calibración — el ruido de fondo cambia con el firme y la velocidad, así que debe recalcularse en continuo.

### 2.3 Detección de pico candidato (trigger)

```javascript
function detectEvent() {
  if (S.urbanBuf.length < 20) return; // necesitamos historial mínimo
  const latest = S.urbanBuf[S.urbanBuf.length - 1];
  const dynamicThreshold = S.noiseBaseline.mean + 4 * S.noiseBaseline.std; // 4-sigma, ajustable
  if (Math.abs(latest.vert) < Math.max(dynamicThreshold, 1.2)) return; // 1.2 m/s² suelo mínimo absoluto
  if (S._lastEventTs && latest.t - S._lastEventTs < 300) return; // anti-rebote: no dos eventos en <300ms
  extractFeaturesAndScore(latest.t);
}
```

### 2.4 Extracción del vector de características

Cuando se dispara un trigger, analizar la ventana de `S.urbanBuf` alrededor del pico (±150ms aprox, ajustar según `S.urbanBufMax`):

```javascript
function extractFeaturesAndScore(triggerTs) {
  const window = S.urbanBuf.filter(s => Math.abs(s.t - triggerTs) <= 200); // ventana ±200ms
  if (window.length < 6) return;

  const verts = window.map(s => s.vert);
  const peakAmp = Math.max(...verts.map(Math.abs));

  // Jerk: derivada discreta de la aceleración vertical
  let jerkMax = 0;
  for (let i = 1; i < window.length; i++) {
    const dt = (window[i].t - window[i-1].t) / 1000;
    if (dt <= 0) continue;
    const jerk = Math.abs((window[i].vert - window[i-1].vert) / dt);
    jerkMax = Math.max(jerkMax, jerk);
  }

  // Duración: tiempo durante el cual |vert| > umbral mitad del pico
  const halfPeak = peakAmp * 0.5;
  const above = window.filter(s => Math.abs(s.vert) > halfPeak);
  const duration = above.length > 1 ? (above[above.length-1].t - above[0].t) : 0;

  // Bipolaridad: ¿hay caída seguida de rebote de signo opuesto? (firma típica de bache)
  let bipolarity = 0;
  const peakIdx = window.findIndex(s => Math.abs(s.vert) === peakAmp);
  if (peakIdx >= 0 && peakIdx < window.length - 3) {
    const peakSign = Math.sign(window[peakIdx].vert);
    const after = window.slice(peakIdx + 1, peakIdx + 6);
    const oppositeSignPeak = Math.max(...after.map(s => peakSign > 0 ? -s.vert : s.vert), 0);
    bipolarity = Math.min(1, oppositeSignPeak / peakAmp);
  }

  // Energía en banda 8-20Hz (aproximación simple sin FFT completa: contar cruces por cero en la ventana)
  let crossings = 0;
  for (let i = 1; i < verts.length; i++) {
    if (Math.sign(verts[i]) !== Math.sign(verts[i-1])) crossings++;
  }
  const windowDurationS = (window[window.length-1].t - window[0].t) / 1000;
  const crossingFreq = windowDurationS > 0 ? crossings / windowDurationS / 2 : 0;
  const freqEnergy = Math.min(1, Math.max(0, (crossingFreq - 4) / 16)); // normalizado 0-1, pico esperado ~8-20Hz

  // Correlación con frenado (eje Y longitudinal simultáneo y sostenido = frenazo, no bache)
  const ays = window.map(s => Math.abs(s.ay));
  const ayAvg = ays.reduce((a,b)=>a+b,0) / ays.length;
  const brakeCorrelation = Math.min(1, ayAvg / 3); // normalizado, 3 m/s² ~ frenada fuerte sostenida

  const features = { peakAmp, jerkMax, duration, bipolarity, freqEnergy, brakeCorrelation };
  scoreAndClassify(features, triggerTs);
}
```

> **Nota para Claude Code**: la detección de cruces por cero como proxy de energía espectral es una aproximación deliberadamente ligera (sin FFT) para mantener el cómputo viable en tiempo real en un navegador móvil. Si en validación de campo resulta insuficiente, está documentado en la Fase 6 cómo sustituirlo por un FFT real con una librería ligera.

### ✅ Criterios de aceptación Fase 2
- [ ] `S.urbanBuf` se llena correctamente en modo urbano
- [ ] `S.noiseBaseline` se recalcula cada ~5s de buffer
- [ ] Al provocar manualmente un golpe seco al teléfono (simulando bache) en modo urbano, se dispara `extractFeaturesAndScore` (verificar con `console.log` temporal)
- [ ] Las 6 características se calculan sin `NaN`/`undefined`
- [ ] Commit: `feat(urban): motor de extracción de características`

---

## FASE 3 — Sistema de puntuación ponderada y clasificación

### 3.1 Normalización por velocidad

```javascript
function normalizeByVelocity(value, speedKmh) {
  const vRef = 25; // velocidad de referencia urbana, AJUSTABLE — no 80km/h como en IRI
  const vMin = 5;  // por debajo de esto no se normaliza (riesgo de división inestable)
  if (speedKmh < vMin) return value;
  return value * Math.pow(vRef / speedKmh, 0.7); // exponente urbano, distinto al de IRI (0.5)
}
```

### 3.2 Score ponderado

```javascript
const URBAN_WEIGHTS = {
  amp: 0.30,
  jerk: 0.25,
  bipolarity: 0.20,
  freqEnergy: 0.15,
  brakePenalty: 0.10 // resta, no suma
};

function scoreAndClassify(features, triggerTs) {
  const speed = S.lastPos?.speed || 0;
  const ampNorm = Math.min(1, normalizeByVelocity(features.peakAmp, speed) / 8); // 8 m/s² ~ techo de referencia
  const jerkNorm = Math.min(1, features.jerkMax / 40); // 40 m/s³ ~ techo de referencia, AJUSTABLE en campo

  const rawScore =
    URBAN_WEIGHTS.amp * ampNorm +
    URBAN_WEIGHTS.jerk * jerkNorm +
    URBAN_WEIGHTS.bipolarity * features.bipolarity +
    URBAN_WEIGHTS.freqEnergy * features.freqEnergy -
    URBAN_WEIGHTS.brakePenalty * features.brakeCorrelation;

  const score = Math.max(0, Math.min(100, rawScore * 100));

  // Descarte por correlación de frenado alta (probable frenazo, no bache)
  if (features.brakeCorrelation > 0.6 && features.bipolarity < 0.3) return; // descartado, no es evento

  // Umbrales de confianza
  if (score < 25) return; // ruido, descartar

  const severity = score >= 65 ? 'grave' : score >= 40 ? 'moderado' : 'leve';
  const type = classifyType(features);

  registerEvent({ triggerTs, speed, severity, score, type, features });
}

function classifyType(f) {
  if (f.duration > 350 && f.freqEnergy < 0.3) return 'speedbump'; // largo y baja frecuencia
  if (f.duration < 80 && f.bipolarity < 0.2) return 'manhole';     // corto y sin rebote
  if (f.bipolarity > 0.4 && f.freqEnergy > 0.4) return 'pothole';  // firma clásica de bache
  return 'unknown';
}
```

### 3.3 Registro del evento con posición GPS

```javascript
function registerEvent({ triggerTs, speed, severity, score, type, features }) {
  if (!S.lastPos) return; // sin GPS no se puede geolocalizar, descartar
  const event = {
    id: triggerTs + '_' + Math.random().toString(36).slice(2,7),
    ts: triggerTs,
    lat: S.lastPos.lat, lon: S.lastPos.lon,
    speed, type, severity, score, features,
    confirmed: false, confirmCount: 1
  };
  S.urbanEvents.push(event);
  S._lastEventTs = triggerTs;
  onUrbanEventDetected(event); // hook de UI — ver Fase 4
}
```

### ✅ Criterios de aceptación Fase 3
- [ ] El score se calcula en rango 0-100 sin valores fuera de rango
- [ ] Frenazos simulados (mover el móvil hacia adelante/atrás sosteniendo, sin golpe vertical) NO generan evento
- [ ] Golpes verticales secos SÍ generan evento con severidad coherente
- [ ] La clasificación por tipo da resultados razonables en pruebas manuales (golpe largo = speedbump, golpe corto = manhole/pothole)
- [ ] Commit: `feat(urban): sistema de puntuación y clasificación`

---

## FASE 4 — UI del Modo Urbano (reutilizando infraestructura existente)

### 4.1 Panel principal modo urbano

Sustituir el `.iri-panel` por un panel equivalente cuando `S.mode === 'urban'` (mismo contenedor, contenido condicional vía JS, NO duplicar HTML innecesariamente — usar `classList.toggle('hidden', ...)` sobre dos bloques):

```html
<div class="urban-panel hidden" id="urbanPanel">
  <div class="urban-stats">
    <div class="u-stat"><span class="u-val" id="uEventCount">0</span><span class="u-lbl">Eventos</span></div>
    <div class="u-stat"><span class="u-val" id="uGraveCount" style="color:var(--bad)">0</span><span class="u-lbl">Graves</span></div>
    <div class="u-stat"><span class="u-val" id="uModCount" style="color:var(--fair)">0</span><span class="u-lbl">Moderados</span></div>
  </div>
  <div class="urban-last-event" id="uLastEvent">Sin eventos detectados aún</div>
</div>
```

### 4.2 Hook de detección → feedback inmediato

```javascript
function onUrbanEventDetected(event) {
  // 1. Actualizar contadores UI
  const counts = S.urbanEvents.reduce((acc, e) => { acc[e.severity] = (acc[e.severity]||0)+1; return acc; }, {});
  set('uEventCount', S.urbanEvents.length.toString());
  set('uGraveCount', (counts.grave||0).toString());
  set('uModCount', (counts.moderado||0).toString());

  // 2. Mostrar el último evento
  const icons = { pothole:'🕳️', manhole:'⭕', speedbump:'⛰️', crack:'➰', unknown:'❓' };
  $('uLastEvent').innerHTML = `${icons[event.type]} ${capitalize(event.severity)} · score ${event.score.toFixed(0)} · ${event.speed.toFixed(0)} km/h`;

  // 3. Toast breve no intrusivo (solo graves para no saturar)
  if (event.severity === 'grave') toast('🕳️ Bache grave detectado');

  // 4. Marcador en el mapa activo (mapMain o mapMeas según pantalla)
  addEventMarkerToMap(event);

  // 5. Vibración háptica si está disponible (feedback físico inmediato, no visual)
  if (navigator.vibrate && event.severity !== 'leve') navigator.vibrate(event.severity === 'grave' ? [80,40,80] : 60);
}

function addEventMarkerToMap(event) {
  const colors = { leve: '#F59E0B', moderado: '#F97316', grave: '#EF4444' };
  const map = S.active ? S.mapMeas : S.mapMain;
  if (!map) return;
  L.circleMarker([event.lat, event.lon], {
    radius: event.severity === 'grave' ? 8 : 6,
    color: '#fff', weight: 1.5,
    fillColor: colors[event.severity], fillOpacity: 0.9
  }).addTo(map).bindTooltip(`${event.type} · ${event.severity} (${event.score.toFixed(0)})`);
}
```

### 4.3 Botón "Iniciar Detección" (reutiliza `startMeasurement` con rama de modo)

Modificar `startMeasurement()` existente: al inicio de la función, comprobar `S.mode`. Si es `'urban'`, saltar las validaciones de IRI que no apliquen (sigue exigiendo calibración y vehículo) pero resetear `S.urbanEvents = []` en vez de los acumuladores IRI. Al `stopMeasurement()`, en modo urbano, guardar los eventos en vez de una ruta IRI (ver 4.4).

### 4.4 Guardado de sesión urbana

```javascript
function stopUrbanSession() {
  if (S.urbanEvents.length === 0) { toast('Sin eventos detectados en esta sesión'); return; }
  mergeEventsIntoStorage(S.urbanEvents); // ver Fase 5 (confirmación multi-pasada)
  toast(`✅ ${S.urbanEvents.length} eventos guardados`);
}
```

### ✅ Criterios de aceptación Fase 4
- [ ] Cambiar a modo urbano muestra el panel correcto y oculta el panel IRI
- [ ] Iniciar una sesión urbana y simular eventos los muestra en tiempo real en pantalla y mapa
- [ ] Los contadores se actualizan correctamente
- [ ] La vibración funciona en dispositivos compatibles (verificar `navigator.vibrate` existe antes de llamar)
- [ ] Commit: `feat(urban): interfaz de modo urbano y feedback en tiempo real`

---

## FASE 5 — Confirmación espacial multi-pasada

### 5.1 Almacenamiento agrupado de eventos confirmados

```javascript
function mergeEventsIntoStorage(newEvents) {
  const stored = JSON.parse(localStorage.getItem('rc_urban_events') || '[]');
  const PROXIMITY_M = 4; // radio de agrupación

  newEvents.forEach(ev => {
    const match = stored.find(s => geo(s.lat, s.lon, ev.lat, ev.lon) <= PROXIMITY_M && s.type === ev.type);
    if (match) {
      match.confirmCount++;
      match.score = (match.score * (match.confirmCount - 1) + ev.score) / match.confirmCount; // media móvil
      match.confirmed = match.confirmCount >= 2;
      match.lastSeen = ev.ts;
    } else {
      stored.push({ ...ev, lastSeen: ev.ts });
    }
  });

  localStorage.setItem('rc_urban_events', JSON.stringify(stored));
}
```

> **Nota**: reutiliza la función `geo()` ya existente en `app.js` para distancia haversine — no la dupliques.

### 5.2 Visualización en el Visor Global

Añadir al selector `#viewMode` existente (que ya tiene `iri_c`/`iri_m`) una tercera opción:

```html
<option value="urban_events">Eventos Urbanos (Baches)</option>
```

En `refreshVisor()`, cuando `mode === 'urban_events'`, en vez de dibujar polylines de segmentos IRI, dibujar marcadores de `localStorage.getItem('rc_urban_events')`, coloreados por severidad y con opacidad/tamaño según `confirmed` (eventos confirmados = marcador sólido y grande; candidatos = marcador semitransparente y pequeño).

### ✅ Criterios de aceptación Fase 5
- [ ] Dos sesiones urbanas distintas que pasan por el mismo punto (±4m) consolidan el evento con `confirmCount: 2` y `confirmed: true`
- [ ] El Visor Global muestra correctamente los eventos urbanos con la nueva opción de visualización
- [ ] Eventos confirmados se distinguen visualmente de candidatos no confirmados
- [ ] Commit: `feat(urban): confirmación espacial multi-pasada y visualización en visor`

---

## FASE 6 — Exportación y reporting (reutilizar funciones existentes)

### 6.1 Extender exportación JSON/Excel

Añadir función `exportUrbanEventsXLSX()` siguiendo el mismo patrón que `doXLSX()` existente, con hoja `Eventos` (columnas: #, Fecha, Lat, Lon, Tipo, Severidad, Score, Confirmaciones, Velocidad) en vez de la hoja `Datos` de puntos IRI.

### 6.2 Extender informe HTML

Reutilizar la plantilla de `expHTML()` pero sustituyendo los gráficos de línea IRI por:
- Mapa con marcadores de eventos (ya tienes el patrón de mapa interactivo con Leaflet en el informe actual)
- Tabla de eventos en vez de tabla de segmentos
- Tarjetas resumen: Total eventos / Graves / Moderados / Leves / % confirmados

### ✅ Criterios de aceptación Fase 6
- [ ] Exportación XLSX de eventos urbanos funciona y abre correctamente en Excel/Sheets
- [ ] Informe HTML de eventos urbanos se genera y el mapa se visualiza correctamente (aplicar mismo fix de altura explícita que ya se usó para los mapas de la app)
- [ ] Commit: `feat(urban): exportación e informes de eventos urbanos`

---

## FASE 7 — Calibración de umbrales en campo (proceso semi-automatizado)

> Esta fase es manual/asistida, no solo código. Claude Code debe implementar las herramientas; el ajuste fino lo hace el usuario conduciendo.

### 7.1 Modo "Etiquetado" para validación

Añadir un botón flotante visible solo en modo urbano + sesión activa: `🏷️ Marcar bache real` — al pulsarlo, registra un evento "ground truth" en `S.groundTruth[]` con timestamp y posición, independientemente de si el algoritmo lo detectó.

### 7.2 Panel de comparación tras sesión

Al finalizar una sesión de validación, comparar `S.urbanEvents` (detectados por algoritmo) contra `S.groundTruth` (marcados manualmente por el usuario):
- Verdaderos positivos: evento detectado cerca (±5m, ±2s) de un ground truth
- Falsos positivos: evento detectado sin ground truth cercano
- Falsos negativos: ground truth sin evento detectado cercano

Mostrar precisión y recall simples:
```javascript
precision = VP / (VP + FP)
recall = VP / (VP + FN)
```

### 7.3 Exportar dataset de validación

Botón para exportar JSON con `{urbanEvents, groundTruth, comparisonResults}` — este archivo es el que se usa para ajustar manualmente los pesos de `URBAN_WEIGHTS` y los umbrales de `scoreAndClassify()`.

### ✅ Criterios de aceptación Fase 7
- [ ] El botón de marcado manual funciona y registra ground truth con posición
- [ ] El cálculo de precisión/recall se muestra correctamente tras una sesión de validación
- [ ] El JSON de validación se exporta con la estructura completa
- [ ] Commit: `feat(urban): herramientas de validación y calibración en campo`

---

## RESUMEN DE ARCHIVOS A MODIFICAR

| Archivo | Cambios |
|---|---|
| `app.js` | Todo el motor de detección (Fases 1-3, 5-7), lógica de UI urbana (Fase 4), exportaciones (Fase 6) |
| `index.html` | Selector de modo, panel urbano, botón de etiquetado, nueva opción en selector de visor |
| `manifest.json` | Sin cambios necesarios |
| `sw.js` | Sin cambios necesarios (no hay nuevos recursos externos que cachear) |

## PARÁMETROS AJUSTABLES (documentar en comentarios de código para fácil tuning posterior)

```javascript
const URBAN_TUNABLE = {
  triggerSigma: 4,        // umbral de disparo en desviaciones estándar sobre el ruido base
  triggerFloorMs2: 1.2,   // suelo absoluto de aceleración para disparo
  antiReboundMs: 300,     // tiempo mínimo entre eventos
  vRefUrban: 25,          // velocidad de referencia para normalización urbana (km/h)
  vMinNormalize: 5,       // velocidad mínima para aplicar normalización
  speedExponent: 0.7,     // exponente de la ley de potencia urbana
  ampCeiling: 8,           // techo de normalización de amplitud (m/s²)
  jerkCeiling: 40,         // techo de normalización de jerk (m/s³)
  scoreDiscardBelow: 25,   // descartar eventos con score menor
  severityModerateAt: 40,
  severityGraveAt: 65,
  brakeCorrelationVeto: 0.6,
  proximityConfirmM: 4,    // radio de confirmación multi-pasada
  confirmAfterPasses: 2
};
```

**Todos estos valores son punto de partida de ingeniería, no verdades absolutas — requieren ajuste con datos reales de campo (Fase 7).**

---

## ORDEN DE EJECUCIÓN RECOMENDADO PARA CLAUDE CODE

1. Leer este documento completo antes de tocar código
2. Fase 1 → commit
3. Fase 2 → commit
4. Fase 3 → commit
5. Fase 4 → commit
6. Fase 5 → commit
7. Fase 6 → commit
8. Fase 7 → commit
9. Al finalizar todas las fases, generar un resumen en `CLAUDE.md` (siguiendo el patrón ya establecido en otros proyectos del usuario) documentando: arquitectura del módulo, parámetros ajustables y su ubicación, y próximos pasos de validación en campo recomendados.
