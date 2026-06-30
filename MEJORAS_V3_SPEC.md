# Especificación Técnica: Confort Baseline + Calibración Continua + Validación por Imagen
## Pavement Check — Paquete de mejoras v3

> **Instrucciones para Claude Code**: Sigue las fases en orden, commit al finalizar cada una. La Fase 4 (Gemini) depende de que el Worker ya tenga la variable de entorno GEMINI_API_KEY configurada en Cloudflare — no toques esa key en ningún archivo de código. Nunca escribas la API key en texto plano en ningún archivo del repo.

---

## FASE 1 — Correcciones pendientes del paquete anterior

### 1.1 Valor base de confort: restar avBaseline

**Problema**: tras calibración, el filtro Wk/Wd produce un `a_v` residual no nulo incluso con el móvil en reposo, porque el ruido del sensor pasa por el filtro. Esto hace que la lectura base sea "No confortable" cuando debería ser cero.

**Solución**: medir el `a_v` de fondo durante la calibración y restarlo en tiempo real.

En `endCal()`, tras la calibración exitosa, añadir:

```javascript
// Calcular a_v de fondo con las muestras de vibración ya recogidas (vibSamples)
// Reutilizar las muestras del eje vertical de la Fase 2 de calibración
if (S.vibSamples.length > 30) {
  // Construir filtros temporales con la fs actual para medir el baseline
  const wkTmp = buildWkCascade(S.comfort.fsActual || 60);
  const rmsBaseline = Math.sqrt(
    S.vibSamples.reduce((s,v) => s + wkTmp(v)*wkTmp(v), 0) / S.vibSamples.length
  );
  S.comfort.avBaseline = Math.min(rmsBaseline * 1.2, 0.3); // margen del 20%, techo 0.3
  log('Comfort baseline: ' + S.comfort.avBaseline.toFixed(4) + ' m/s²');
}
```

En `computeLiveComfort()`, aplicar la resta:

```javascript
// ANTES:
const av = Math.sqrt(K.z**2*awZ**2 + K.x**2*awX**2 + K.y**2*awY**2);

// AHORA:
const avRaw = Math.sqrt(K.z**2*awZ**2 + K.x**2*awX**2 + K.y**2*awY**2);
const av = Math.max(0, avRaw - (S.comfort.avBaseline || 0));
S.comfort.avLive = av;
```

El resultado: con el móvil en reposo tras calibración → `av ≈ 0` → nivel "Sin vibración perceptible".

Añadir ese nivel al inicio de `COMFORT_SCALE`:

```javascript
const COMFORT_SCALE = [
  { max: 0.05,  level: 'none',           label: 'Sin vibración perceptible', color: '#3A5F7A' },
  { max: 0.315, level: 'no_confortable', label: 'No confortable',            color: '#10B981' },
  { max: 0.5,   level: 'poco',           label: 'Un poco incómodo',          color: '#84CC16' },
  { max: 0.8,   level: 'moderado',       label: 'Moderadamente incómodo',    color: '#F59E0B' },
  { max: 1.25,  level: 'incomodo',       label: 'Incómodo',                  color: '#F97316' },
  { max: 2.0,   level: 'muy_incomodo',   label: 'Muy incómodo',              color: '#EF4444' },
  { max: Infinity, level: 'extremo',     label: 'Extremadamente incómodo',   color: '#991B1B' }
];
```

### 1.2 Línea de recorrido más gruesa en el mapa

En todas las instancias de `L.polyline` que dibujan el recorrido activo (mapMain, mapMeas):

```javascript
// ANTES:
L.polyline([], { color:'#0EA5E9', weight:3, opacity:.8 })

// AHORA:
L.polyline([], { color:'#0EA5E9', weight:6, opacity:.9 })
```

Aplicar también a los segmentos del mapa de detalle (weight 5 → 7) y al visor global (weight 5 → 7).

### 1.3 Indicador calibración adaptativa: visible y con contador

**Problema**: el indicador existe en el HTML pero no es suficientemente visible y no muestra claramente el contador de recalibraciones durante la sesión.

Sustituir el HTML actual del indicador por:

```html
<div class="adapt-cal-bar" id="adaptCalBar">
  <div class="acb-left">
    <div class="acb-dot" id="aciDot"></div>
    <span class="acb-status" id="aciTxt">Cal. estática</span>
  </div>
  <div class="acb-right">
    <span class="acb-count" id="aciCount" style="display:none">
      🔄 <span id="aciCountVal">0</span> recal.
    </span>
    <span class="acb-drift" id="aciDrift" style="display:none"></span>
  </div>
</div>
```

CSS:
```css
.adapt-cal-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 7px 12px;
  background: var(--s2);
  border-top: 1px solid rgba(14,165,233,.12);
  font-family: var(--mono);
  font-size: var(--fs-xs);
  flex-shrink: 0; /* no se comprime nunca */
}
.acb-left { display:flex; align-items:center; gap:7px; }
.acb-right { display:flex; align-items:center; gap:10px; color:var(--dim); }
.acb-dot {
  width:10px; height:10px; border-radius:50%; flex-shrink:0;
  background:#3A5F7A; transition:background .4s;
}
.acb-dot.sampling { animation: pulse 1.2s ease-in-out infinite; }
.acb-status { color:var(--txt); }
.acb-count { color:var(--good); font-weight:700; }
.acb-drift  { color:var(--fair); }
@keyframes pulse { 0%,100%{opacity:.4;transform:scale(.8)} 50%{opacity:1;transform:scale(1.3)} }
```

Actualizar `updateAdaptiveCalUI()`:

```javascript
function updateAdaptiveCalUI() {
  const st  = S.adaptiveCal.status;
  const dot = $('aciDot'), txt = $('aciTxt');
  const cnt = $('aciCount'), cntVal = $('aciCountVal');
  const driftEl = $('aciDrift');
  if (!dot || !txt) return;

  const colors = {
    idle:'#3A5F7A', sampling:'#0EA5E9',
    updated:'#10B981', drift_warning:'#F59E0B'
  };
  dot.style.background = colors[st] || '#3A5F7A';
  dot.className = 'acb-dot' + (st==='sampling' ? ' sampling' : '');

  const texts = {
    idle:          'Cal. estática',
    sampling:      'Recalibrando…',
    updated:       'Cal. adaptativa activa',
    drift_warning: 'Deriva detectada — corrigiendo'
  };
  txt.textContent = texts[st] || 'Cal. estática';

  // Contador de recalibraciones
  const n = S.adaptiveCal.updateCount;
  if (cnt) {
    cnt.style.display = n > 0 ? 'inline' : 'none';
    if (cntVal) cntVal.textContent = n;
  }

  // Deriva acumulada (solo si es significativa)
  if (driftEl) {
    const d = S.adaptiveCal.driftDeg;
    driftEl.style.display = d > 0.5 ? 'inline' : 'none';
    driftEl.textContent = 'Δ' + d.toFixed(1) + '°';
  }
}
```

### ✅ Criterios de aceptación Fase 1
- [ ] Con móvil en reposo calibrado, `a_v` muestra 0.000 y nivel "Sin vibración perceptible"
- [ ] La línea de recorrido es claramente visible en el mapa con luz solar
- [ ] La barra de calibración adaptativa es visible en la parte inferior de la pantalla de medición
- [ ] Al conducir en línea recta >15s, el punto azul pulsa y aparece "Recalibrando…"
- [ ] Tras la primera recalibración, aparece "🔄 1 recal." en la barra
- [ ] Commit: `fix: comfort baseline, línea mapa más gruesa, barra calibración adaptativa`

---

## FASE 2 — Buffer de vídeo con extracción de frame por velocidad

### 2.1 Concepto

La cámara trasera genera un stream de vídeo continuo (no se graba nada). Los frames se almacenan en un buffer circular de 3 segundos. Cuando el algoritmo detecta un evento en el instante T con velocidad V, el frame a extraer corresponde al instante:

```
T_frame = T - retardo_detección(V)
```

Donde el retardo se calcula a partir de la velocidad:

```javascript
function calcFrameDelay(speedKmh) {
  // Distancia recorrida durante la ventana de análisis del algoritmo
  // ventana de análisis: ~300ms fija + latencia de pipeline ~100ms
  const analysisWindowMs = 400;
  // A mayor velocidad, el bache queda más atrás en el mismo tiempo
  // La cámara trasera apunta ~3-5m detrás del eje trasero
  // Añadimos el tiempo que tardó el vehículo en recorrer esa distancia
  const distCameraToRear = 3.5; // metros (estimación conservadora)
  const speedMs = speedKmh / 3.6;
  const extraDelayMs = speedMs > 0 ? (distCameraToRear / speedMs) * 1000 : 0;
  return analysisWindowMs + extraDelayMs;
}
```

Ejemplo a 30 km/h:
- `speedMs = 8.33 m/s`
- `extraDelay = (3.5 / 8.33) × 1000 = 420ms`
- `retardo total = 400 + 420 = 820ms` → el frame a extraer es el de hace ~820ms

### 2.2 Implementación del buffer de frames

```javascript
const VIDEO_BUF = {
  stream: null,
  video: null,       // elemento <video> oculto
  canvas: null,      // canvas oculto para extracción de frames
  ctx: null,
  frames: [],        // { ts, blob }  — buffer circular de 3s
  maxAgeMs: 3000,
  capturing: false,
  captureInterval: null
};

async function startVideoBuffer() {
  if (VIDEO_BUF.capturing) return;
  try {
    VIDEO_BUF.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment', // cámara trasera
        width: { ideal: 640 },    // resolución media — equilibrio calidad/velocidad
        height: { ideal: 480 }
      },
      audio: false
    });
    VIDEO_BUF.video = document.createElement('video');
    VIDEO_BUF.video.srcObject = VIDEO_BUF.stream;
    VIDEO_BUF.video.playsInline = true;
    VIDEO_BUF.video.muted = true;
    await VIDEO_BUF.video.play();

    VIDEO_BUF.canvas = document.createElement('canvas');
    VIDEO_BUF.canvas.width  = 640;
    VIDEO_BUF.canvas.height = 480;
    VIDEO_BUF.ctx = VIDEO_BUF.canvas.getContext('2d');

    // Capturar 4 frames/segundo — suficiente para el retardo de 0.5-2s
    VIDEO_BUF.captureInterval = setInterval(captureFrame, 250);
    VIDEO_BUF.capturing = true;
    log('[Cámara] Buffer de vídeo activo');
  } catch(e) {
    log('[Cámara] No disponible: ' + e.message);
    // Continuar sin cámara — la app funciona igualmente
  }
}

function captureFrame() {
  if (!VIDEO_BUF.ctx || !VIDEO_BUF.video) return;
  try {
    VIDEO_BUF.ctx.drawImage(VIDEO_BUF.video, 0, 0, 640, 480);
    VIDEO_BUF.canvas.toBlob(blob => {
      if (!blob) return;
      const ts = Date.now();
      VIDEO_BUF.frames.push({ ts, blob });
      // Purgar frames más antiguos que maxAgeMs
      const cutoff = ts - VIDEO_BUF.maxAgeMs;
      while (VIDEO_BUF.frames.length > 0 && VIDEO_BUF.frames[0].ts < cutoff) {
        VIDEO_BUF.frames.shift();
      }
    }, 'image/jpeg', 0.75); // JPEG 75% — buen equilibrio calidad/tamaño
  } catch(e) {}
}

function stopVideoBuffer() {
  if (VIDEO_BUF.captureInterval) clearInterval(VIDEO_BUF.captureInterval);
  if (VIDEO_BUF.stream) VIDEO_BUF.stream.getTracks().forEach(t => t.stop());
  VIDEO_BUF.capturing = false;
  VIDEO_BUF.frames = [];
  log('[Cámara] Buffer detenido');
}

function extractFrameForEvent(eventTs, speedKmh) {
  if (!VIDEO_BUF.frames.length) return null;
  const delayMs = calcFrameDelay(speedKmh);
  const targetTs = eventTs - delayMs;
  // Buscar el frame más cercano al instante objetivo
  let best = VIDEO_BUF.frames[0];
  let bestDiff = Math.abs(VIDEO_BUF.frames[0].ts - targetTs);
  VIDEO_BUF.frames.forEach(f => {
    const diff = Math.abs(f.ts - targetTs);
    if (diff < bestDiff) { best = f; bestDiff = diff; }
  });
  return bestDiff < 1500 ? best.blob : null; // descartar si la diferencia es >1.5s
}
```

### 2.3 Integración con el ciclo de vida de la sesión

```javascript
// En startMeasurement(): iniciar buffer de vídeo si hay al menos un modo activo
if (S.activeModes.has('urban') || S.activeModes.has('comfort')) {
  startVideoBuffer(); // no bloquear — si falla, la sesión continúa igualmente
}

// En stopMeasurement():
stopVideoBuffer();
```

### 2.4 Botón manual de captura

```html
<!-- En la pantalla de medición, junto al botón de marcar bache real -->
<button class="btn-float hidden" id="btnPhoto" onclick="captureManualPhoto()">
  📷
</button>
```

```javascript
function captureManualPhoto() {
  if (!VIDEO_BUF.capturing) { toast('Cámara no disponible'); return; }
  const blob = VIDEO_BUF.frames[VIDEO_BUF.frames.length - 1]?.blob;
  if (!blob) { toast('Sin frame disponible'); return; }
  // Crear un evento manual con la foto actual y posición GPS
  const manualEvent = {
    id: Date.now() + '_manual',
    ts: Date.now(),
    lat: S.lastPos?.lat, lon: S.lastPos?.lon,
    speed: S.lastPos?.speed || 0,
    type: 'unknown', severity: 'manual',
    score: 0, manual: true,
    imageBlob: blob
  };
  S.urbanEvents.push(manualEvent);
  analyzeEventWithGemini(manualEvent, blob);
  toast('📷 Foto capturada — analizando…');
}
```

### ✅ Criterios de aceptación Fase 2
- [ ] Al iniciar sesión con modo Urbano activo, el navegador solicita permiso de cámara
- [ ] Si el usuario deniega la cámara, la sesión continúa sin error (degradación silenciosa)
- [ ] El buffer almacena frames de los últimos 3 segundos
- [ ] `extractFrameForEvent()` devuelve el frame correcto según velocidad (verificar en log)
- [ ] El botón 📷 captura el frame actual y lo encola para análisis
- [ ] Commit: `feat: buffer de vídeo con extracción de frame compensada por velocidad`

---

## FASE 3 — Análisis de imagen + vibración con Gemini (Worker)

### 3.1 Nuevo endpoint en el Worker: `/api/analyze`

Añadir al archivo `workers/pavement-check-api/index.js`:

```javascript
// POST /api/analyze
// Body: { image: base64string, features: { peakAmp, jerkMax, duration, bipolarity, freqEnergy, speed } }
// Responde: { type, severity, confidence, description, discard }

if (url.pathname === '/api/analyze' && request.method === 'POST') {
  let body;
  try { body = await request.json(); } catch {
    return new Response('{"error":"invalid json"}', { status:400, headers });
  }

  const { image, features } = body;
  if (!image || !features) {
    return new Response('{"error":"image and features required"}', { status:400, headers });
  }

  // Construir prompt para Gemini — combina imagen y firma de vibración
  const vibDesc = `Firma de vibración del sensor:
- Amplitud pico: ${features.peakAmp?.toFixed(2)} m/s²
- Jerk máximo: ${features.jerkMax?.toFixed(1)} m/s³
- Duración del evento: ${features.duration?.toFixed(0)} ms
- Bipolaridad (rebote): ${features.bipolarity?.toFixed(2)} (0=sin rebote, 1=rebote completo)
- Energía en alta frecuencia: ${features.freqEnergy?.toFixed(2)}
- Velocidad del vehículo: ${features.speed?.toFixed(1)} km/h`;

  const prompt = `Eres un sistema de análisis de pavimento vial. Se te proporciona una imagen tomada desde la cámara trasera de un vehículo y los datos del sensor acelerómetro registrados en el mismo instante.

${vibDesc}

Analiza la imagen y los datos de vibración conjuntamente y responde ÚNICAMENTE con un objeto JSON con esta estructura exacta (sin texto adicional, sin markdown):
{
  "type": "pothole|manhole|speedbump|crack|degraded|none",
  "severity": "leve|moderado|grave|none",
  "confidence": 0.0-1.0,
  "description": "descripción breve en español (máx 80 caracteres)",
  "discard": true|false
}

Criterios:
- "discard": true si la imagen muestra asfalto en buen estado o la firma de vibración corresponde claramente a un frenazo (bipolaridad<0.1 y alta correlación con desaceleración longitudinal)
- "type": "none" si no se identifica ningún desperfecto
- "confidence": tu nivel de certeza sobre la clasificación
- "severity": basada en la imagen visual combinada con la amplitud del sensor`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'image/jpeg', data: image } }
            ]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 256 }
        })
      }
    );

    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    // Parsear JSON de la respuesta (limpiar posibles backticks de markdown)
    const clean = rawText.replace(/```json|```/g, '').trim();
    let result;
    try { result = JSON.parse(clean); }
    catch { result = { type:'unknown', severity:'leve', confidence:0.3, description:'Error de análisis', discard:false }; }

    return new Response(JSON.stringify(result), { headers });

  } catch(e) {
    return new Response(
      JSON.stringify({ type:'unknown', severity:'leve', confidence:0, description:'Error de conexión', discard:false }),
      { headers }
    );
  }
}
```

### 3.2 Función de análisis en app.js

```javascript
async function analyzeEventWithGemini(event, imageBlob) {
  if (!imageBlob) return;

  // Convertir blob a base64
  const base64 = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(imageBlob);
  });

  const payload = {
    image: base64,
    features: {
      peakAmp:    event.features?.peakAmp    || 0,
      jerkMax:    event.features?.jerkMax    || 0,
      duration:   event.features?.duration   || 0,
      bipolarity: event.features?.bipolarity || 0,
      freqEnergy: event.features?.freqEnergy || 0,
      speed:      event.speed || 0
    }
  };

  try {
    const res = await fetch(`${WORKER_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const analysis = await res.json();

    // Actualizar el evento con el resultado de Gemini
    event.gemini = analysis;
    event.imageBlob = imageBlob; // guardar para miniaturas

    if (analysis.discard) {
      // Gemini descarta el evento — eliminarlo de la sesión
      S.urbanEvents = S.urbanEvents.filter(e => e.id !== event.id);
      toast('🔍 Falso positivo descartado por análisis de imagen');
      log(`[Gemini] Descartado: ${analysis.description}`);
    } else {
      // Enriquecer el evento con los datos de Gemini
      if (analysis.type && analysis.type !== 'unknown') event.type = analysis.type;
      if (analysis.severity && analysis.severity !== 'none') event.severity = analysis.severity;
      event.geminiConfidence = analysis.confidence;
      event.geminiDescription = analysis.description;

      // Mostrar miniatura en el panel de medición
      showEventThumbnail(event, imageBlob);
      toast(`🔍 ${analysis.description} (conf. ${(analysis.confidence*100).toFixed(0)}%)`);
      log(`[Gemini] ${analysis.type}/${analysis.severity} conf=${analysis.confidence} — ${analysis.description}`);
    }

    // Actualizar contadores UI
    queueUI('urban_meas', updateUrbanMeasPanel);

  } catch(e) {
    log('[Gemini] Error: ' + e.message);
    // Mantener el evento con la clasificación original del algoritmo
  }
}

function showEventThumbnail(event, blob) {
  const url = URL.createObjectURL(blob);
  const thumb = $('lastEventThumb');
  if (thumb) {
    thumb.src = url;
    thumb.style.display = 'block';
    thumb.title = event.geminiDescription || event.type;
    // Liberar URL después de 30s para no acumular memoria
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}
```

### 3.3 Integración con registerEvent()

```javascript
// Al final de registerEvent(), tras añadir el evento a S.urbanEvents:
const imageBlob = extractFrameForEvent(event.ts, event.speed);
if (imageBlob) {
  analyzeEventWithGemini(event, imageBlob);
} else {
  log('[Gemini] Sin frame disponible para este evento');
}
```

### 3.4 Miniatura en panel de medición

```html
<!-- En el panel de medición Urbano -->
<div class="meas-urban-panel hidden" id="measUrbanPanel">
  <div class="meas-event-counts">
    <div class="mec"><span class="mec-val" id="muLeve">0</span><span class="mec-lbl">🟡 Leves</span></div>
    <div class="mec"><span class="mec-val" id="muMod" style="color:#F97316">0</span><span class="mec-lbl">🟠 Moderados</span></div>
    <div class="mec"><span class="mec-val" id="muGrave" style="color:#EF4444">0</span><span class="mec-lbl">🔴 Graves</span></div>
  </div>
  <div class="meas-last-event-row">
    <img id="lastEventThumb" style="display:none;width:72px;height:54px;border-radius:4px;object-fit:cover;border:1px solid rgba(14,165,233,.3)" alt="Último evento">
    <div class="meas-last-event" id="muLastEvent">Sin eventos detectados</div>
  </div>
</div>
```

### ✅ Criterios de aceptación Fase 3
- [ ] El endpoint `/api/analyze` del Worker responde correctamente (probar con curl o Postman)
- [ ] Al detectar un evento, el log muestra `[Gemini] tipo/severidad conf=X`
- [ ] Un frenazo brusco sin desperfecto real provoca `[Gemini] Descartado`
- [ ] La miniatura de la imagen aparece en el panel de medición tras análisis
- [ ] Si el Worker no responde (sin red), el evento se mantiene con la clasificación del algoritmo
- [ ] Commit: `feat: análisis imagen+vibración con Gemini 1.5 Flash vía Worker proxy`

---

## FASE 4 — Exportación enriquecida con imágenes y análisis Gemini

### 4.1 Incluir análisis Gemini en exportaciones existentes

En `expXLSX()` y `expHTML()`, añadir columnas/secciones:
- Columna "Tipo (Gemini)" — `event.gemini?.type`
- Columna "Severidad (Gemini)" — `event.gemini?.severity`
- Columna "Confianza" — `event.gemini?.confidence`
- Columna "Descripción IA" — `event.gemini?.description`
- Columna "Validado por IA" — `!event.gemini?.discard`

### 4.2 Informe HTML: galería de imágenes por evento

En el informe HTML exportado, añadir una sección de galería tras la tabla de eventos:

```html
<h2>Galería de Eventos</h2>
<div class="gallery">
  <!-- Por cada evento con imagen -->
  <div class="gal-item">
    <img src="data:image/jpeg;base64,..." alt="bache moderado">
    <div class="gal-info">
      <span>🕳️ pothole · moderado</span>
      <span>Conf. 87%</span>
      <span>Score: 68</span>
    </div>
  </div>
</div>
```

Las imágenes se embeben como base64 en el HTML — el informe es autocontenido (un único archivo).

### ✅ Criterios de aceptación Fase 4
- [ ] El XLSX incluye las columnas de análisis Gemini
- [ ] El informe HTML incluye la galería de imágenes de los eventos con imagen disponible
- [ ] Eventos sin imagen (cámara no disponible o descartados) se exportan igualmente
- [ ] Commit: `feat: exportaciones enriquecidas con análisis Gemini e imágenes`

---

## RESUMEN DE ARCHIVOS A MODIFICAR

| Archivo | Cambios |
|---|---|
| `app.js` | Fases 1-4: baseline confort, buffer vídeo, cliente Gemini, exportaciones |
| `index.html` | Fases 1-3: barra cal. adaptativa, miniatura evento, botón foto |
| `workers/pavement-check-api/index.js` | Fase 3: endpoint `/api/analyze` con proxy Gemini |

## ORDEN DE EJECUCIÓN

1. Fase 1 → commit → verificar en móvil que `a_v` base es 0
2. Fase 2 → commit → verificar log de buffer de vídeo al iniciar sesión
3. Fase 3 → commit → `wrangler deploy` para actualizar el Worker → verificar endpoint
4. Fase 4 → commit
5. `git push` → Cloudflare Pages despliega automáticamente

## NOTA SOBRE PRIVACIDAD Y CÁMARA

Añadir en el modal de inicio de sesión (o en un nuevo modal la primera vez que se solicita la cámara) una nota explícita:

> "La cámara se usa únicamente para capturar frames individuales en el momento de detectar un desperfecto. No se graba vídeo ni se almacena ningún contenido fuera del dispositivo, excepto los frames enviados al analizador de IA para clasificación. Los frames se procesan y descartan inmediatamente."
