# AUDIT.md — Backlog de Auditoría Técnica
## Pavement Check — Auditoría profunda de código (julio 2026)

> **Para Claude Code**: Este documento es el backlog priorizado resultante de una
> auditoría completa de app.js (5104 líneas), index.html (873) y el Worker (212).
> Los fixes están organizados en FASES DE EJECUCIÓN. Ejecuta UNA fase por sesión,
> commit por fix dentro de cada fase, verificación antes de pasar a la siguiente.
> NO apliques fases fuera de orden: las primeras cambian la calidad de los datos
> que las siguientes consumen.

---

# FASE 1 — CALIDAD DE DATOS (crítico, ejecutar primero)

## C1 🔴 — Ventana de features cortada en el flanco de subida

**Ubicación**: `detectEvent()` → `extractFeaturesAndScore()` (líneas ~586-660)

**Problema**: `detectEvent()` dispara en cuanto la última muestra cruza el umbral 4σ
y `extractFeaturesAndScore(latest.t)` filtra `|s.t - triggerTs| <= 200`. Pero el
buffer solo contiene el pasado: en el instante del trigger, los +200ms posteriores
aún no existen. Consecuencias:
- `peakAmp` se calcula sobre el flanco de subida, no sobre el pico real (20-100ms después)
- `bipolarity` (rebote de signo opuesto tras el pico) es casi imposible de medir
  → potholes reales clasificados como manhole o unknown sistemáticamente
- `duration` y el `waveform` salen truncados
- Mientras la señal sigue sobre el umbral y el score sale bajo,
  `extractFeaturesAndScore` se re-ejecuta a 60Hz (CPU desperdiciada)

**Fix**:
```javascript
function detectEvent(){
  if(S.urbanBuf.length<20)return;
  const latest=S.urbanBuf[S.urbanBuf.length-1];
  const thr=Math.max(S.noiseBaseline.mean+4*S.noiseBaseline.std, URBAN_TUNABLE.triggerFloorMs2);
  if(Math.abs(latest.vert)<thr)return;
  if(S._lastEventTs&&latest.t-S._lastEventTs<300)return;
  if(S._pendingTrigger)return;           // ya hay una extracción programada
  S._pendingTrigger=latest.t;
  setTimeout(()=>{                        // esperar cola post-evento
    extractFeaturesAndScore(S._pendingTrigger);
    S._pendingTrigger=null;
  },280);
}
```
Con esto la ventana ±200ms queda completa (a 60Hz, ~24 muestras a cada lado).

**Verificación**: generar evento de prueba y comprobar en el waveform del informe
que la cola de bajada del pico es visible (antes se cortaba en el pico).

**Commit**: `fix(detect): diferir extracción de features hasta tener cola post-evento`

---

## F1-F4 🔴 — Fusión: aprendizaje circular y gradiente incorrecto

**Ubicación**: `updateFusionWeights()`, `evaluateFusion()`, `computeFusionScore()`

**Problemas**:
- **F1 (circular)**: `target = h.confirmed ? 1 : 0` usa `h.confirmed` que se definió
  como `fusionScore >= 0.45` — la propia predicción umbralizada. El gradiente entrena
  el modelo para reproducir sus propias decisiones. La señal correcta es `humanLabel`
  de la validación en galería.
- **F2 (gradiente)**: se usa `∂p/∂w_i ≈ s_i` (gradiente de suma sin normalizar), pero
  `computeFusionScore` divide por Σw → el gradiente real es `(s_i − p)/Σw`.
- **F3 (normalización)**: se normaliza dentro del bucle (50 renormalizaciones por
  actualización) y el floor `Math.max(0.05, w/total)` se aplica después de dividir,
  rompiendo que Σw=1.
- **F4 (peso fantasma)**: `weights.video = 0.15` participa en la normalización pero
  `computeFusionScore` no lo consume → diluye a los otros tres.

**Fix — sustituir updateFusionWeights() completa**:
```javascript
function updateFusionWeights() {
  // Solo eventos validados por humano Y con las 3 capas
  const labeled = S.fusion.history.filter(h =>
    h.humanLabel &&
    Object.values(h.scores).every(v => v !== null)
  );
  if (labeled.length < 20) return;
  const LR = 0.05;
  const w = S.fusion.weights;
  labeled.slice(-100).forEach(h => {
    const target = (h.humanLabel === 'confirmed' || h.humanLabel === 'corrected') ? 1 : 0;
    const p = computeFusionScore(h.scores);
    if (p === null) return;
    const err = target - p;
    const totW = w.vibration + w.yolo + w.gemini;   // sin 'video'
    // Gradiente correcto de la media ponderada: dp/dw_i = (s_i − p)/Σw
    w.vibration += LR * err * (h.scores.vibration - p) / totW;
    w.yolo      += LR * err * (h.scores.yolo      - p) / totW;
    w.gemini    += LR * err * (h.scores.gemini    - p) / totW;
  });
  // Normalizar UNA vez, al final: floor primero, división después
  ['vibration','yolo','gemini'].forEach(k => w[k] = Math.max(0.05, w[k]));
  const t = w.vibration + w.yolo + w.gemini;
  ['vibration','yolo','gemini'].forEach(k => w[k] /= t);
  try {
    const key = 'rc_fusion_weights_' + (S.vehicleId||'default');
    localStorage.setItem(key, JSON.stringify(w));
  } catch(e) {}
}
```

**Cambios adicionales necesarios**:
1. Eliminar `video: 0.15` de `S.fusion.weights`.
2. En `validateEvent()` (galería), al asignar `humanLabel`, actualizar también la
   entrada correspondiente de `S.fusion.history`:
```javascript
const histEntry = S.fusion.history.find(h => h.eventId === event.id);
if (histEntry) histEntry.humanLabel = label;
```
3. Llamar a `updateFusionWeights()` también en `saveValidationProgress()` (validación
   diferida desde historial), no solo en `stopMeasurement()`.

**Verificación**: validar 20+ eventos, comprobar en consola que los pesos cambian
y que Σw = 1.0 tras la actualización.

**Commit**: `fix(fusion): aprendizaje con etiquetas humanas, gradiente correcto, sin peso fantasma`

---

# FASE 2 — SIMULADOR (verificar Fase 1 sin salir a campo)

## S1 — Grabación de sesiones reales (?record)

**Diseño**: flag `?record` que durante una ruta real vuelca cada muestra cruda a un
buffer: `{t,x,y,z,gx,gy,gz}` de `onRaw`/`onGyro` + cada fix GPS
`{t,lat,lon,speed,accuracy}`. A 60Hz × 20min ≈ 72k muestras ≈ 3-4MB. Exportable
con `dlBlob()` al parar. Guardar también `{grav, gravMag, noiseLevel}` de la
calibración en el JSON.

## S2 — Replay de sesiones (?sim)

```javascript
const SIM={active:false,data:null,idx:0,gpsIdx:0,t0:0,speed:1};
async function startSimulation(file,speedFactor=1){
  SIM.data=JSON.parse(await file.text());
  SIM.active=true;SIM.speed=speedFactor;SIM.t0=performance.now();
  // Cortocircuitar hardware:
  S.sensorOK=true;
  S.grav=SIM.data.calibration.grav;
  S.gravMag=SIM.data.calibration.gravMag;
  S.calibrated=true;
  simTick();
}
function simTick(){
  if(!SIM.active)return;
  const elapsed=(performance.now()-SIM.t0)*SIM.speed;
  while(SIM.idx<SIM.data.samples.length &&
        SIM.data.samples[SIM.idx].t-SIM.data.samples[0].t<=elapsed){
    const s=SIM.data.samples[SIM.idx++];
    onGyro(s.gx,s.gy,s.gz);
    onRaw(s.x,s.y,s.z);
  }
  while(SIM.gpsIdx<SIM.data.gps.length &&
        SIM.data.gps[SIM.gpsIdx].t-SIM.data.samples[0].t<=elapsed){
    const g=SIM.data.gps[SIM.gpsIdx++];
    onGPS({coords:{latitude:g.lat,longitude:g.lon,speed:g.speed/3.6,accuracy:g.accuracy}});
  }
  requestAnimationFrame(simTick);
}
```
**Clave arquitectónica**: inyectar en `onRaw`/`onGPS`, no por debajo — así TODO el
pipeline (baseline, detectEvent, features, scoring, fusión, GPS) se ejecuta idéntico
a producción. Con `speedFactor=4` una ruta de 20min se repasa en 5.

## S3 — Generador sintético paramétrico

```javascript
function synthEvent(type,amp=3,fs=60){
  const n=Math.round(fs*0.6),out=[];
  for(let i=0;i<n;i++){
    const t=i/fs;let v=0;
    if(type==='pothole')   v=-amp*Math.exp(-((t-0.15)/0.03)**2)+amp*0.45*Math.exp(-((t-0.22)/0.04)**2);
    if(type==='speedbump') v= amp*0.6*Math.sin(Math.PI*Math.max(0,Math.min(1,(t-0.05)/0.35)));
    if(type==='manhole')   v=-amp*Math.exp(-((t-0.15)/0.012)**2);
    if(type==='brake')     v=0; // el frenazo va en el eje Y, no en vert
    out.push(v+(Math.random()-0.5)*0.15);
  }
  return out;
}
```
Verificar que `classifyType()` devuelve lo esperado por cada combinación de
amplitud/velocidad. Añadir como SECCIÓN 7 de `runAutoTests()`.

## S4 — Mocks de capa visual

- Frames: 5-10 JPEGs de baches reales en `/sim/frames/` servidos por un VIDEO_BUF falso
- YOLO corre de verdad (es local y determinista)
- `?mockGemini`: respuestas canned sin tocar el Worker (ahorra cuota, tests deterministas)

**Commits Fase 2**: `feat(sim): grabación de sesiones`, `feat(sim): replay con inyección en onRaw/onGPS`, `feat(sim): generador sintético + tests classifyType`, `feat(sim): mocks visuales`

---

# FASE 3 — ESTABILIDAD (bugs de crash y leaks)

## C3 🔴 — Doble getUserMedia concurrente
**Ubicación**: `startMeasurement()` (líneas ~1694-1718)
`initCameraSelector()` → `startVideoBuffer()` abre la cámara, y ~10 líneas después
un `getUserMedia({video:true})` de diagnóstico abre la MISMA cámara en paralelo.
En Android produce `NotReadableError` intermitente. **Fix**: eliminar el bloque de
diagnóstico completo; `startVideoBuffer` ya toastea éxito/fallo.
**Commit**: `fix(camera): eliminar getUserMedia de diagnóstico concurrente`

## C4 🔴 — Overpass API una vez por evento
**Ubicación**: `registerEvent()` → `snapToRoad()` (línea ~1211)
- Rate limiting: overpass-api.de banea IPs con >1-2 req/s
- Race condition: el `.then()` muta `event.lat/lon` DESPUÉS de pintar el marcador
  y potencialmente después de serializar el evento
**Fix**: mover el snapping a lote en `stopMeasurement()`, antes de
`buildUrbanDataFinal()` — una query Overpass con todos los puntos o N espaciadas.
**Commit**: `fix(gps): snap-to-road en lote al parar, no por evento`

## A1 🟠 — Leak de listeners window en galería
**Ubicación**: `initGalleryGestures()` (líneas ~4533-4548)
El clonado del canvas limpia los listeners del canvas, pero cada llamada añade
`window.addEventListener('mousemove')` y `('mouseup')` que NUNCA se eliminan.
Cada apertura de galería = +2 listeners permanentes con closure sobre el canvas
clonado anterior. **Fix** (mismo patrón que `_galKeyHandler`):
```javascript
let _galMouseMove=null,_galMouseUp=null;
function initGalleryGestures(){
  // ...clonado del canvas igual...
  if(_galMouseMove)window.removeEventListener('mousemove',_galMouseMove);
  if(_galMouseUp)window.removeEventListener('mouseup',_galMouseUp);
  _galMouseMove=e=>{ /* código actual del mousemove */ };
  _galMouseUp=()=>{ /* código actual del mouseup */ };
  window.addEventListener('mousemove',_galMouseMove);
  window.addEventListener('mouseup',_galMouseUp);
}
```
**Commit**: `fix(gallery): eliminar leak de listeners mousemove/mouseup en window`

## A2 🟠 — showEventThumbnail definida DOS veces
**Ubicación**: líneas ~3659 y ~4088
Dos declaraciones con firmas distintas: `(event, blob)` con lightbox y `(event)` con
galería. Por hoisting la segunda pisa a la primera → el camino `openLightbox` es
código muerto y `captureManualPhoto` (que pasa `imageBlob` sin `_frameBlobs`) nunca
muestra thumbnail. **Fix**: eliminar la primera (línea 3659), verificar que la
superviviente maneja el caso de evento manual con `imageBlob`.
**Commit**: `fix(ui): eliminar showEventThumbnail duplicada`

## A3 🟠 — Bucle infinito potencial en loadFrameToCanvas
**Ubicación**: líneas ~4399-4405
Si `wrap` tiene dimensiones 0 (modal cerrado mientras carga), el retry via
`requestAnimationFrame` se repite indefinidamente creando Image+objectURL a 60Hz.
**Fix**: contador de reintentos (máx 30) + abortar si el modal tiene clase `hidden`:
```javascript
function loadFrameToCanvas(blob,label,retryCount=0){
  if(!blob)return;
  if(retryCount>30)return;
  const modal=$('eventGalleryModal');
  if(modal?.classList.contains('hidden'))return;
  // ... resto igual, y en el retry:
  requestAnimationFrame(()=>loadFrameToCanvas(blob,label,retryCount+1));
}
```
**Commit**: `fix(gallery): límite de reintentos en loadFrameToCanvas`

## A4 🟠 — Frame anotado solo se genera si YOLO está listo
**Ubicación**: `registerEvent()` PASO 5 (líneas ~1251-1284)
`annotateFrameForHuman` + `saveImageBlob('_best_human')` viven dentro de
`if (YOLO_STATE.ready)`. Si YOLO aún carga (primeros 10-20s) o falla, el frame
anotado nunca se genera y la galería cae a frames crudos. **Fix**: extraer los
pasos de anotación fuera de la dependencia de YOLO — anotar con lo que haya
(`event.yolo` puede ser undefined, el código ya usa `?.`).
**Commit**: `fix(quality): anotar frame para humano aunque YOLO no esté listo`

## A5 🟠 — Test de calcFrameDelay desactualizado
**Ubicación**: líneas ~5012-5018
El test espera `<= 2550` (maxAgeMs=3000 × 0.85) pero `VIDEO_BUF.maxAgeMs` es ahora
5000 → clamp real 4250 → el test falla siempre. **Fix**: usar
`VIDEO_BUF.maxAgeMs*0.85` en el test (y en `calcFrameDelay` si está hardcodeado).
**Commit**: `fix(test): actualizar límite de calcFrameDelay al buffer de 5s`

## A6 🟠 — XSS desde salida de Gemini en informe urbano
**Ubicación**: `expHTMLUrban()` (línea ~2494)
`e.gemini.description` se interpola sin `escH()` (en `expHTML` sí se escapa —
inconsistencia). La descripción viene de un LLM procesando imágenes arbitrarias.
**Fix**: envolver con `escH()` todas las interpolaciones de `gemini.description`
en informes.
**Commit**: `fix(security): escapar descripción de Gemini en informes`

---

# FASE 4 — WORKER Y GEMINI

## W1 — Prompt reescrito con responseSchema

**Problemas actuales**:
1. Dos bloques "IMPORTANTE" con esquemas contradictorios (uno permite `none`,
   otro añade `patch|unknown` y quita `none`)
2. El criterio de descarte pide evaluar correlación de frenado pero el payload
   no incluye `brakeCorrelation` ni datos de giroscopio
3. "cámara trasera de un vehículo" induce a interpretar vista hacia atrás
4. Parsing frágil de JSON en texto libre cuando la API soporta `responseSchema`

**Fix — Worker /api/analyze**:
```javascript
const prompt = `Eres un sistema experto de auscultación de pavimento urbano.
Recibes UNA imagen de la calzada tomada desde un smartphone montado en el
parabrisas de un vehículo, mirando hacia delante en el sentido de la marcha,
y la firma del acelerómetro/giroscopio registrada al pasar las ruedas sobre
ese punto (la imagen se capturó ~0,5-1 s ANTES del impacto, por lo que el
desperfecto suele estar en el tercio inferior-central de la imagen).

DATOS DEL SENSOR:
- Amplitud pico: ${f.peakAmp?.toFixed(2)} m/s² (leve<1.5, moderado 1.5-3, grave>3)
- Jerk máximo: ${f.jerkMax?.toFixed(1)} m/s³
- Duración: ${f.duration?.toFixed(0)} ms (badén>220, tapa<80)
- Bipolaridad: ${f.bipolarity?.toFixed(2)} (>0.3 = caída+rebote, típico de bache)
- Energía alta frecuencia: ${f.freqEnergy?.toFixed(2)}
- Correlación de frenado: ${f.brakeCorrelation?.toFixed(2)} (>0.5 = posible frenazo)
- Rotación roll/pitch: ${f.gyroRoll?.toFixed(3)}/${f.gyroPitch?.toFixed(3)} rad/s
- Velocidad: ${f.speed?.toFixed(1)} km/h

TAREA: clasifica el desperfecto combinando imagen y sensor. La imagen manda
para el TIPO; el sensor manda para la SEVERIDAD. Si la imagen muestra asfalto
en buen estado y la firma es compatible con frenazo (brakeCorrelation>0.5,
bipolaridad<0.15, roll<0.1), marca discard=true. Si ves un desperfecto claro
en la imagen aunque la firma sea débil, NO lo descartes: baja la severidad.

Responde describiendo en "description" QUÉ ves en la imagen (máx 80 caracteres,
español), no lo que dice el sensor.`;

const body = {
  contents: [{ parts: [
    { text: prompt },
    { inline_data: { mime_type: 'image/jpeg', data: image } }
  ]}],
  generationConfig: {
    temperature: 0.1,
    maxOutputTokens: 256,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'OBJECT',
      properties: {
        type:       { type: 'STRING', enum: ['pothole','crack','alligator_crack','manhole','speedbump','degraded','patch','none'] },
        severity:   { type: 'STRING', enum: ['leve','moderado','grave'] },
        confidence: { type: 'NUMBER' },
        description:{ type: 'STRING' },
        discard:    { type: 'BOOLEAN' }
      },
      required: ['type','severity','confidence','description','discard']
    }
  }
};
```
- Eliminar el `replace(/```json|```/g,'')` — con responseSchema ya no hay fences
- Mantener el validador de fallback del Worker, alineado con este enum único
- **Cliente**: añadir `brakeCorrelation`, `gyroRoll`, `gyroPitch` al payload en
  `analyzeEventWithGemini()`

## W2 — Migrar a gemini-2.0-flash
Gemini 1.5 Flash está en vía de retirada. Mismo endpoint, mejor visión, soporta
responseSchema. Verificar disponibilidad actual al implementar.

## W3 — Gemini no debe pisar la clasificación antes de validación
**Ubicación**: `analyzeEventWithGemini()` (línea ~3643)
`event.type`/`severity` se sobrescriben con lo que diga Gemini ANTES de la
validación humana. **Fix**: solo promocionar a `event.type` si
`result.confidence >= 0.7`; si no, mantener la clasificación de vibración y
guardar la propuesta solo en `event.gemini.*`.

## W4 — Seguridad mínima del Worker
- Token compartido en header (embebido en la PWA — no es seguridad real pero
  sube la barrera contra el abuso de cuota)
- Rate limit por IP con contador en KV
- En `/api/events` GET: `getCellKeys` con r=2000 genera ~2000 lecturas KV por
  petición. Limitar r a 500-800 (~130 lecturas).

**Commits Fase 4**: `feat(worker): responseSchema + prompt unificado`,
`feat(worker): migrar a gemini-2.0-flash`, `fix(client): Gemini no pisa
clasificación bajo confianza 0.7`, `feat(worker): token + rate limit`

---

# FASE 5 — RENDIMIENTO Y ROBUSTEZ

## M1 — Backpressure del buffer de vídeo
`setInterval` a 17ms lanza un encode JPEG cada tick; en el A56 `toBlob` tarda >17ms
→ los encodes se encolan y saturan el hilo principal compitiendo con ONNX/CLAHE.
La selección de frames tolera ±800ms de desviación. **Fix**: bajar
`captureIntervalMs` a 66-100ms (10-15fps) — mismo resultado funcional, 4-6× menos
CPU. Además: el modo confort arranca el buffer sin usarlo (línea ~1694,
`urban||comfort`) — condicionar a solo `urban`.
**Commit**: `perf(video): 10-15fps de captura, buffer solo en modo urbano`

## M2 — Liberar _frameBlobs tras el pipeline
Cada evento retiene ~250KB de blobs en memoria toda la sesión (100 eventos ≈ 25MB).
Ya se persiste todo en IndexedDB al registrar. **Fix**: al terminar el pipeline
(YOLO+Gemini+anotación), `delete event._frameBlobs; delete event._frameBlob;` —
la galería ya los recupera con `ensureFrames()`.
**Commit**: `perf(memory): liberar blobs de eventos tras pipeline completo`

## M3 — S.fusion.history sin límite y con duplicados
Crece indefinidamente y recibe una entrada por cada `evaluateFusion()` del mismo
evento (+YOLO, +Gemini). **Fix**: en `evaluateFusion()`, actualizar la entrada
existente si `eventId` ya está en history (no push duplicado); limitar a las
últimas 200 entradas; purgar en `startMeasurement()`.
**Commit**: `fix(fusion): history sin duplicados, límite 200, purga por sesión`

## M4 — updateGyroViz a 60Hz sin throttle
Redibuja el canvas completo en cada lectura, incluso sin sesión activa.
**Fix**: pasar por `queueUI('gyro', updateGyroViz)` como el resto de la UI.
**Commit**: `perf(gyro): throttle de la rosa del giroscopio via queueUI`

## M5 — Red colaborativa: código muerto
`syncEventsToNetwork()` y `fetchNetworkEvents()` no se invocan desde ningún sitio.
**Decisión pendiente del usuario**: conectarlas (sync en `confirmSave()`) o
eliminarlas. NO tocar sin preguntar.

## M8 — Menores
- `motionFB` añade un listener `devicemotion` por invocación → guard de único registro
- `saveToTrainingDataset` en `continueValidation` recibe `event._frameBlob` que ahí
  nunca existe → pasar `hasImage: event._hasStoredImages` en su lugar
- Prompt del Worker ya corregido en W1 (cámara mirando adelante)

**Commit**: `fix(misc): listener devicemotion único, hasImage en validación diferida`

---

# FASE 6 — FEATURES DE ALTO IMPACTO (del top-5 de la auditoría)

## T1 — Crash recovery (persistencia incremental de sesión)
Si Android mata la PWA a mitad de ruta, se pierden todos los eventos.
**Diseño**: snapshot `rc_session_wip` en localStorage cada 30s o cada 10 eventos
(sin blobs — ya están en IndexedDB). Al arrancar, si existe `rc_session_wip`,
ofrecer "Recuperar sesión interrumpida" que reconstruye `S.urbanEvents`/`S.pts`
y va directo al modal de guardar.
**Commit**: `feat(recovery): snapshot de sesión en curso + recuperación al arrancar`

## T2 — Cola de inferencia con backpressure
Dos eventos separados 400ms lanzan dos `runYOLO` y dos Gemini en paralelo
compitiendo por el mismo hilo WASM y la radio. **Diseño**: cola con concurrencia
1 para YOLO, 2 para Gemini, reintento exponencial, persistencia de pendientes en
IndexedDB para procesar al parar (modo "sin cobertura: analizar al llegar").
**Commit**: `feat(queue): cola de inferencia con backpressure y reintentos`

## T3 — Panel de métricas por capa
Con `rc_training_dataset` calcular precision/recall por capa (¿cuántas veces acertó
la vibración sola? ¿y YOLO?) y mostrarlo en un panel. Defendibilidad pericial:
"el sistema tiene P=0.87/R=0.79 sobre N=340 eventos validados".
**Commit**: `feat(metrics): panel precision/recall por capa de detección`

## T4 — Pipeline de imagen en Web Worker con OffscreenCanvas
CLAHE + sharpen + Laplaciano son ~50-150ms de bloqueo del hilo principal por
evento, justo cuando sensores y buffer están a tope → jank y muestras con dt
irregular (ensucia jerk y filtros ISO). **Fix**: mover
`applyCLAHE`/`sharpenBlob`/`calcSharpness` a un Web Worker con OffscreenCanvas.
**Commit**: `perf(quality): pipeline de imagen en Web Worker`

## T5 — Sync automático R2 entre dispositivos
Endpoint en el Worker con R2 binding:
- `PUT /api/routes/{deviceId}/{routeId}` con el JSON del export (imágenes incluidas)
- `GET /api/routes?since=ts` para descarga incremental
- Reutiliza el 90% de `confirmExportSelected`/`importFullDataset`
- `deviceId` real: UUID en localStorage (no vehicleId)
- Conflictos: "última validación gana" por evento
**Commit**: `feat(sync): subida/bajada automática de rutas via R2`

---

# FASE 7 — HALLAZGOS DE CAMPO (julio 2026, primera salida real)

## G1 🔴 — Bug: solo 3 de 5 frames en validación diferida

**Ubicación**: `ensureFrames()` en la galería

**Problema**: desde V5I Fase 1 se capturan 5 frames por evento (A-E), pero
`ensureFrames()` solo recupera `_A`, `_B`, `_C` de IndexedDB cuando se valida
desde "Continuar validación" (historial). Al validar inmediatamente tras el
evento sí aparecen los 5 (están en memoria vía `_frameBlobs`), pero al validar
diferido se pierden D y E.

**Fix**: actualizar `ensureFrames()` para recuperar los 5 posibles (`_A` a `_E`),
preservando la preferencia por `_best_human` si existe. *(Aplicado en esta
sesión — verificar que quedó bien.)*

**Commit**: `fix(gallery): recuperar 5 frames A-E en validación diferida`

---

## G2 🔴 — Causa raíz confirmada: control manual de exposición sobreexpone en sol directo

**Historial de la regresión** (para no repetir el error):
1. `ba7579e` introdujo `exposureMode:'manual'` + `exposureTime:1000µs` (pensado
   para reducir motion blur)
2. Esto causó fotos completamente blancas en condiciones de sol directo sobre
   asfalto (superficie muy reflectante) — el A56 compensaba la exposición corta
   con ganancia máxima → saturación
3. Se intentó parchear con `exposureCompensation` (`cae74ee`) sin eliminar la
   causa — no funcionó
4. **Fix definitivo aplicado** (`78504c1`): eliminación completa del bloque de
   control manual de exposición. Cámara en auto-exposición pura.

**Verificado en campo**: fotos ya no sobreexpuestas. ✅

**Lección para futuros cambios de cámara**: cualquier constraint manual de
exposición debe probarse específicamente en exterior con sol directo antes de
darse por bueno — las pruebas en interior no lo detectan.

**Estado**: ✅ Resuelto, sin acción adicional.

---

## G3 🟠 — Resonancia mecánica del soporte de móvil contamina la detección

**Contexto**: el móvil que toma fotos va en un soporte fijo (parabrisas/salpicadero).
A ciertas velocidades el soporte puede entrar en resonancia mecánica, y algunos
impactos pueden amplificarse no linealmente por el propio soporte — generando
falsos positivos o severidades infladas que NO reflejan el estado real del
pavimento.

**Por qué la calibración actual no lo resuelve**: `endCal()` calibra el ruido de
fondo en condiciones estáticas (coche parado). La resonancia es dependiente de
la frecuencia/velocidad — no es un offset constante restable una vez.

**Fix propuesto — filtro de correlación con giroscopio**:
La hipótesis física clave: la resonancia del soporte genera vibración vertical
del propio soporte pero NO rotación real del vehículo (roll/pitch), mientras que
un bache real SÍ afecta a la rueda y por tanto rota la carrocería completa.

En `classifyType()` o en el cálculo de score, añadir un factor de sospecha:
```javascript
// Sospecha de resonancia de soporte: alta amplitud vertical
// pero rotación mínima (el chasis no se movió, solo el soporte)
const suspectResonance = f.peakAmp > 2.0 &&
  (f.gyroRoll||0) < 0.03 && (f.gyroPitch||0) < 0.03;

if (suspectResonance) {
  // Penalizar el score en vez de descartar directamente —
  // dejar que Gemini/YOLO confirmen o descarten con la imagen
  score *= 0.6;
}
```

**Fix complementario — calibración por barrido de velocidad**:
Ampliar el proceso de calibración inicial (o un modo de calibración avanzada
opcional) para circular unos segundos a distintas velocidades (20/30/40/50 km/h)
sobre asfalto conocido y liso, capturando el espectro de vibración de fondo en
función de la velocidad. Esto permite detectar a qué rango de velocidad el
soporte resuena más y ajustar el umbral dinámicamente según la velocidad actual
del vehículo.

Implementar el filtro de giroscopio primero (rápido, usa infraestructura ya
existente) y evaluar en campo si es suficiente antes de construir la
calibración por barrido (más compleja).

**Commit sugerido**: `feat(detect): penalizar score por sospecha de resonancia
del soporte (alta amplitud + baja rotación)`

**Verificación**: comparar en campo eventos detectados en tramos de asfalto
conocido y liso (sin baches reales) a distintas velocidades — el número de
falsos positivos debería bajar tras el fix.

---

## G4 🟡 — Contraste insuficiente con luz solar directa

**Problema**: la paleta de colores actual (tema oscuro) es difícil de leer en
la pantalla con sol directo sobre el vehículo — botones y textos poco visibles.

**Fix**: revisar variables CSS `--bg`, `--s1`, `--s2`, `--txt`, `--dim`, `--sky`
en `:root` de `index.html` y aumentar el contraste, especialmente el peso de
fuente de textos secundarios (`--dim`) y el contraste de botones primarios.
Considerar un modo "alto contraste"/"exterior" activable manualmente.

**Commit sugerido**: `fix(ui): aumentar contraste para uso con luz solar directa`

---

## G5 🟡 — Feedback visual del proceso de detección poco evidente

**Problema**: cuando se detecta un evento, no hay señal visual clara e
inmediata de que "algo está pasando" — el proceso vibración→YOLO→Gemini→fusión
ocurre en segundo plano sin indicación en pantalla.

**Fix propuesto**: al disparar `registerEvent()`:
1. Flash visual breve (borde de pantalla o icono) en el momento del trigger
2. Indicador de progreso por etapas mientras YOLO/Gemini procesan
   (ej. 3 puntos que se van iluminando: 📳→🎯→🤖→⚖️)
3. Resultado final breve (toast o badge) cuando la fusión termina

Integrar con G6: que los gráficos de acelerómetro/giroscopio "destaquen"
visualmente (parpadeo, cambio de color) en el momento exacto del evento.

**Commit sugerido**: `feat(ux): indicador de progreso de detección en pantalla
de medición`

---

## G6 🟡 — Gráficos de acelerómetro/giroscopio poco atractivos visualmente

**Fix propuesto**: gradientes de color según intensidad, trail/estela del
recorrido reciente, animación suave de transición, resaltado sincronizado
entre los 3 gráficos cuando hay un evento (parte de G5).

**Commit sugerido**: `feat(ui): rediseño visual de joystick/barra-Z/rosa-giroscopio`

---

## G7 — Modo apaisado (landscape)

**Alcance**: soportar apaisado requiere media queries para reorganizar cada
pantalla (inicio, medición, historial, galería, informes), verificar que el
canvas de vídeo y los gráficos de sensores se adaptan sin distorsión, y decidir
qué pantallas permiten rotación libre.

**Complejidad**: alta — toca CSS de todas las pantallas.

**Estado**: diseño pendiente, no iniciar sin spec dedicado.

---

## G8 — Arquitectura de dos dispositivos (A34 cámara fija + A56 vibración)

**Propuesta**: A34 fijo en posición óptima para fotos (parabrisas), A56 en
posición óptima para medir vibración real del vehículo — resolvería G3 de raíz.

**Requiere**: protocolo de sincronización en tiempo real entre dispositivos
(WiFi local/Bluetooth), sincronización precisa de timestamps, rol diferenciado
en la PWA (modo "sensor" vs modo "cámara"), transmisión de eventos desde A56
hacia A34 para capturar el frame correspondiente.

**Complejidad**: alta — nueva arquitectura de captura distribuida.

**Estado**: idea validada conceptualmente, diseño técnico pendiente.

---

# ORDEN DE EJECUCIÓN GLOBAL (actualizado)

```
FASE 1 (C1 + F1-F4)     → los datos que todo lo demás consume        ✅ HECHO
FASE 2 (S1-S4)          → simulador, verificar Fase 1                ✅ HECHO
FASE 3 (C3,C4,A1-A6)    → estabilidad                                ✅ HECHO
FASE 7 · G1,G2          → bugs de campo urgentes                     ✅ HECHO
FASE 7 · G3             → filtro resonancia soporte (giroscopio)     ⏳ SIGUIENTE
FASE 7 · G4             → contraste luz solar                        ⏳ pendiente
FASE 7 · G5,G6          → UX medición + gráficos                     ⏳ pendiente
FASE 4 (W1-W4)          → calidad de Gemini (prompt+responseSchema)  ⏳ pendiente
FASE 5 (M1-M4, M8)      → rendimiento                                ⏳ pendiente
FASE 6 · T1             → crash recovery (prioritario para campo)    ⏳ pendiente
FASE 6 · T2-T5          → cola inferencia, métricas, Worker img, R2  ⏳ pendiente
FASE 7 · G7             → modo apaisado (spec dedicado)              ⏳ más adelante
FASE 7 · G8             → arquitectura dos dispositivos (spec ded.)  ⏳ más adelante
```

**Reglas**:
1. UNA fase/hallazgo por sesión de Code cuando el cambio es de riesgo medio-alto
   (G3, G7, G8); los de riesgo bajo (G4-G6) pueden agruparse
2. Commit por fix individual dentro de cada fase
3. Verificar cada fase (con `?test` y en dispositivo, idealmente en campo real
   con sol) antes de la siguiente
4. M5 (red colaborativa) NO tocar sin decisión del usuario
5. G3 (resonancia): verificar en campo comparando falsos positivos antes/después
   en un tramo de asfalto liso conocido, a varias velocidades
6. G7 y G8 requieren spec dedicado — no ejecutar directamente desde este
   documento sin desarrollarlos primero
