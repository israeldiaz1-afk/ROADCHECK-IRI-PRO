# Especificación Técnica: Paquete B — YOLO + Vídeo + Triple Validación + Aprendizaje
## Pavement Check — v5b

> **Instrucciones para Claude Code**:
> 1. Este spec REQUIERE que el Spec A (v5a) esté completamente implementado y pusheado.
> 2. Lee este documento COMPLETO antes de tocar una sola línea de código.
> 3. La Fase 1 (modelo YOLO) requiere un paso manual externo — leer con atención.
> 4. Máxima precisión en cada implementación. Ante cualquier duda, para y pregunta.
> 5. Al finalizar TODAS las fases: `git push` + `wrangler deploy`.

---

## CONTEXTO DEL SISTEMA DE VALIDACIÓN COMPLETO

```
EVENTO DETECTADO (vibración)
        ↓
[CAPA 1 — Instantáneo, dispositivo]
YOLO11n → detección visual de patología en frame extraído
        ↓
[CAPA 2 — 1-3s, nube]
Gemini 2.5 Flash → análisis imagen+vibración combinado
        ↓
[CAPA 3 — 5-10s, dispositivo]
Modelo vídeo propio (MobileNetV3) → clasificación secuencia temporal
        ↓
[CAPA 4 — Post-sesión, opcional]
Validación humana → galería de clips con vídeo ±3.5s + bounding boxes YOLO
        ↓
[APRENDIZAJE CONTINUO]
Datos etiquetados (capas 1+2+3+4) → reentrenamiento incremental del modelo de vídeo
```

**Tres marcadores en pantalla de medición:**
```
🔔 Detectados: 12    (vibración, instantáneo)
🟠 Validados YOLO+Gemini: 9    (imagen, ~2s de retardo)
✅ Triple validación: 6    (vídeo+modelo, ~8s de retardo)
```

---

## FASE 1 — Modelo YOLO11n entrenado sobre datasets combinados

### 1.1 Dataset de entrenamiento combinado

El modelo se entrena sobre la combinación de:

| Dataset | Fuente | Clases relevantes |
|---|---|---|
| RDD2022 | github.com/sekilab/RoadDamageDetector | D00 (grieta long.), D10 (grieta trans.), D20 (alligator), D40 (bache) |
| CQU-BPDD | Disponible en papers (ver nota) | transverse_crack, alligator_crack, longitudinal_crack, pothole, raveling, patch |
| Crack500 | github.com/fyangneil/pavement-crack-detection | alligator, longitudinal, transverse, multifurcate |

**Clases unificadas del modelo final (11 clases):**
```
0: pothole          (D40 + CQU pothole)
1: alligator_crack  (D20 + CQU alligator + Crack500 alligator)
2: longitudinal_crack (D00 + CQU longitudinal + Crack500 longitudinal)
3: transverse_crack (D10 + CQU transverse + Crack500 transverse)
4: raveling         (CQU raveling — desintegración superficial)
5: patch            (CQU patch — parche/reparación)
6: manhole          (tapas de registro — añadir si hay imágenes)
7: speedbump        (badenes — añadir si hay imágenes)
8: crack_sealed     (grieta sellada)
9: multifurcate     (grieta multidireccional, Crack500)
10: no_damage       (asfalto en buen estado — clase negativa, crítica para descartar FP)
```

### 1.2 Proceso de entrenamiento (paso manual — no ejecutable por Claude Code)

> ⚠️ **Claude Code**: este paso lo ejecuta el usuario en Kaggle/Colab. Tu trabajo en esta fase es preparar los archivos de configuración necesarios.

**Claude Code debe crear** en la raíz del proyecto:

```yaml
# yolo_training/dataset.yaml
path: /path/to/combined_dataset
train: images/train
val: images/val
nc: 11
names:
  0: pothole
  1: alligator_crack
  2: longitudinal_crack
  3: transverse_crack
  4: raveling
  5: patch
  6: manhole
  7: speedbump
  8: crack_sealed
  9: multifurcate
  10: no_damage
```

```python
# yolo_training/train.py
# Ejecutar en Kaggle con GPU T4 (gratuito)
from ultralytics import YOLO

model = YOLO('yolo11n.pt')  # nano — equilibrio tamaño/precisión para ONNX en móvil

results = model.train(
    data='dataset.yaml',
    epochs=100,
    imgsz=640,
    batch=16,
    device=0,
    augment=True,
    degrees=10,       # rotación (cámaras no siempre perfectamente horizontales)
    flipud=0.0,       # no voltear verticalmente (el asfalto siempre abajo)
    fliplr=0.5,       # voltear horizontal sí
    hsv_h=0.015,      # variación de tono (distintas condiciones de luz)
    hsv_s=0.7,        # variación de saturación
    hsv_v=0.4,        # variación de brillo
    mosaic=1.0,       # mosaico de imágenes (mejora detección de objetos pequeños)
    mixup=0.1,
    name='pavement_check_yolo11n',
    project='runs/train'
)

# Exportar a ONNX optimizado para móvil
model.export(
    format='onnx',
    imgsz=640,
    simplify=True,    # simplificar el grafo para ONNX Runtime Web
    opset=12,         # opset compatible con ONNX Runtime Web en navegador
    dynamic=False,    # tamaño fijo para mejor rendimiento en dispositivo
    half=False        # float32 (más compatible que float16 en navegadores)
)
# Output: runs/train/pavement_check_yolo11n/weights/best.onnx
```

```python
# yolo_training/quantize.py
# Cuantizar a INT8 para reducir tamaño (~4x) manteniendo >90% de precisión
import onnxruntime as rt
from onnxruntime.quantization import quantize_dynamic, QuantType

quantize_dynamic(
    'best.onnx',
    'best_int8.onnx',
    weight_type=QuantType.QInt8
)
# El modelo INT8 debería quedar en ~2-3MB — apto para Cloudflare Pages (límite 25MB por archivo)
```

**Claude Code**: guardar estos archivos en `/yolo_training/` y añadir `yolo_training/` a `.gitignore` (solo los scripts, no el modelo entrenado).

> **Nota para el usuario**: tras entrenar, copiar `best_int8.onnx` a `/models/pavement_yolo11n.onnx` en el repo.

### 1.3 Integración ONNX Runtime Web en la app

```html
<!-- En index.html, en el <head>, añadir: -->
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js"></script>
```

**Inicialización del modelo** (en `app.js`):

```javascript
const YOLO_STATE = {
  session: null,       // InferenceSession de ONNX Runtime Web
  loading: false,
  ready: false,
  MODEL_URL: '/models/pavement_yolo11n.onnx',
  INPUT_SIZE: 640,
  CONF_THRESHOLD: 0.45,   // umbral de confianza mínima para detección
  NMS_THRESHOLD: 0.5,     // umbral NMS para eliminar detecciones solapadas
  CLASS_NAMES: [
    'pothole','alligator_crack','longitudinal_crack','transverse_crack',
    'raveling','patch','manhole','speedbump','crack_sealed','multifurcate','no_damage'
  ]
};

async function initYOLO() {
  if (YOLO_STATE.ready || YOLO_STATE.loading) return;
  YOLO_STATE.loading = true;
  try {
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
    YOLO_STATE.session = await ort.InferenceSession.create(YOLO_STATE.MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });
    YOLO_STATE.ready = true;
    log('[YOLO] Modelo cargado OK');
  } catch(e) {
    log('[YOLO] Error cargando modelo: ' + e.message);
    // La app continúa sin YOLO — degradación silenciosa
  }
  YOLO_STATE.loading = false;
}
```

Llamar a `initYOLO()` al inicio de `startMeasurement()` si `S.activeModes.has('urban')`.

### 1.4 Preprocesado de imagen y ejecución de inferencia

```javascript
async function runYOLO(imageBlob) {
  if (!YOLO_STATE.ready || !imageBlob) return null;

  // Crear elemento imagen temporal para dibujar en canvas
  const img = new Image();
  const url = URL.createObjectURL(imageBlob);
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  URL.revokeObjectURL(url);

  // Preprocesar: redimensionar a 640×640 y normalizar a [0,1]
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = YOLO_STATE.INPUT_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, YOLO_STATE.INPUT_SIZE, YOLO_STATE.INPUT_SIZE);
  const imageData = ctx.getImageData(0, 0, YOLO_STATE.INPUT_SIZE, YOLO_STATE.INPUT_SIZE);

  // Convertir RGBA uint8 → Float32 RGB [0,1] en formato CHW (channels-first)
  const SIZE = YOLO_STATE.INPUT_SIZE;
  const input = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    input[i]               = imageData.data[i * 4]     / 255.0; // R
    input[i + SIZE*SIZE]   = imageData.data[i * 4 + 1] / 255.0; // G
    input[i + 2*SIZE*SIZE] = imageData.data[i * 4 + 2] / 255.0; // B
  }

  const tensor = new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]);
  const feeds = { images: tensor }; // nombre del input según arquitectura YOLOv11

  const results = await YOLO_STATE.session.run(feeds);
  // Output shape: [1, 84, 8400] para YOLO11n con 80 clases — se adapta a 11 clases
  // La primera dimensión es batch, segunda es (4 bbox + num_classes), tercera son las anchors

  return parseYOLOOutput(results, imageData.width, imageData.height);
}

function parseYOLOOutput(results, origW, origH) {
  // Obtener el tensor de salida (nombre puede variar según exportación)
  const outputName = Object.keys(results)[0];
  const output = results[outputName].data;
  const numClasses = YOLO_STATE.CLASS_NAMES.length;
  const numAnchors = output.length / (4 + numClasses);

  const detections = [];
  for (let i = 0; i < numAnchors; i++) {
    const offset = i * (4 + numClasses);
    const cx = output[offset];
    const cy = output[offset + 1];
    const w  = output[offset + 2];
    const h  = output[offset + 3];

    // Encontrar la clase con mayor confianza
    let maxConf = 0, maxClass = 0;
    for (let c = 0; c < numClasses; c++) {
      const conf = output[offset + 4 + c];
      if (conf > maxConf) { maxConf = conf; maxClass = c; }
    }

    if (maxConf < YOLO_STATE.CONF_THRESHOLD) continue;
    if (YOLO_STATE.CLASS_NAMES[maxClass] === 'no_damage') continue; // ignorar clase negativa

    // Convertir de coordenadas normalizadas a píxeles originales
    const x1 = (cx - w/2) * origW / YOLO_STATE.INPUT_SIZE;
    const y1 = (cy - h/2) * origH / YOLO_STATE.INPUT_SIZE;
    const x2 = (cx + w/2) * origW / YOLO_STATE.INPUT_SIZE;
    const y2 = (cy + h/2) * origH / YOLO_STATE.INPUT_SIZE;

    detections.push({ x1, y1, x2, y2, conf: maxConf, class: maxClass,
                      className: YOLO_STATE.CLASS_NAMES[maxClass] });
  }

  return applyNMS(detections);
}

function applyNMS(detections) {
  // Non-Maximum Suppression: eliminar detecciones solapadas
  detections.sort((a, b) => b.conf - a.conf);
  const keep = [];
  const suppressed = new Set();

  for (let i = 0; i < detections.length; i++) {
    if (suppressed.has(i)) continue;
    keep.push(detections[i]);
    for (let j = i + 1; j < detections.length; j++) {
      if (suppressed.has(j)) continue;
      if (iou(detections[i], detections[j]) > YOLO_STATE.NMS_THRESHOLD) {
        suppressed.add(j);
      }
    }
  }
  return keep;
}

function iou(a, b) {
  const interX1 = Math.max(a.x1, b.x1), interY1 = Math.max(a.y1, b.y1);
  const interX2 = Math.min(a.x2, b.x2), interY2 = Math.min(a.y2, b.y2);
  if (interX2 < interX1 || interY2 < interY1) return 0;
  const inter = (interX2 - interX1) * (interY2 - interY1);
  const aArea = (a.x2-a.x1) * (a.y2-a.y1);
  const bArea = (b.x2-b.x1) * (b.y2-b.y1);
  return inter / (aArea + bArea - inter);
}
```

### ✅ Criterios Fase 1
- [ ] Los archivos de entrenamiento existen en `/yolo_training/`
- [ ] `initYOLO()` carga el modelo sin error cuando el archivo `.onnx` existe en `/models/`
- [ ] Si el modelo no existe, la app continúa sin error (degradación silenciosa)
- [ ] `runYOLO()` devuelve un array de detecciones con `{x1,y1,x2,y2,conf,class,className}`
- [ ] Commit: `feat(yolo): integración YOLO11n ONNX con NMS y degradación silenciosa`

---

## FASE 2 — Buffer de vídeo con extracción compensada por velocidad

### 2.1 Buffer de frames para vídeo

```javascript
const VIDEO_BUF = {
  stream: null,
  video: null,
  canvas: document.createElement('canvas'),
  frames: [],           // { ts: number, blob: Blob }
  maxAgeMs: 3500,       // 3.5s de buffer circular
  captureIntervalMs: 100, // 10 fps — suficiente para vídeo de validación
  _intervalId: null,
  capturing: false
};
VIDEO_BUF.canvas.width = 640;
VIDEO_BUF.canvas.height = 480;
```

```javascript
async function startVideoBuffer() {
  if (VIDEO_BUF.capturing) return;
  try {
    const constraints = {
      video: S.selectedCameraId
        ? { deviceId: { exact: S.selectedCameraId }, width:{ideal:640}, height:{ideal:480} }
        : { facingMode: 'environment', width:{ideal:640}, height:{ideal:480} },
      audio: false
    };
    VIDEO_BUF.stream = await navigator.mediaDevices.getUserMedia(constraints);
    VIDEO_BUF.video = document.createElement('video');
    VIDEO_BUF.video.srcObject = VIDEO_BUF.stream;
    VIDEO_BUF.video.playsInline = true;
    VIDEO_BUF.video.muted = true;
    await VIDEO_BUF.video.play();

    const ctx = VIDEO_BUF.canvas.getContext('2d');

    VIDEO_BUF._intervalId = setInterval(() => {
      if (!VIDEO_BUF.video || VIDEO_BUF.video.readyState < 2) return;
      ctx.drawImage(VIDEO_BUF.video, 0, 0, 640, 480);
      VIDEO_BUF.canvas.toBlob(blob => {
        if (!blob) return;
        const ts = Date.now();
        VIDEO_BUF.frames.push({ ts, blob });
        // Purgar frames más antiguos que maxAgeMs
        const cutoff = ts - VIDEO_BUF.maxAgeMs;
        while (VIDEO_BUF.frames.length > 0 && VIDEO_BUF.frames[0].ts < cutoff) {
          VIDEO_BUF.frames.shift();
        }
      }, 'image/jpeg', 0.75);
    }, VIDEO_BUF.captureIntervalMs);

    VIDEO_BUF.capturing = true;
    log('[Vídeo] Buffer activo — ' + (S.selectedCameraId ? 'cámara externa' : 'cámara trasera'));

  } catch(e) {
    log('[Vídeo] No disponible: ' + e.message);
    // Continuar sin vídeo — la app funciona sin cámara
  }
}

function stopVideoBuffer() {
  if (VIDEO_BUF._intervalId) { clearInterval(VIDEO_BUF._intervalId); VIDEO_BUF._intervalId = null; }
  if (VIDEO_BUF.stream) VIDEO_BUF.stream.getTracks().forEach(t => t.stop());
  VIDEO_BUF.capturing = false;
  VIDEO_BUF.frames = [];
  VIDEO_BUF.stream = null;
  VIDEO_BUF.video = null;
}
```

### 2.2 Extracción de frame compensada por velocidad

```javascript
function calcFrameDelay(speedKmh) {
  // El algoritmo tarda ~300ms en confirmar el evento tras el impacto.
  // La cámara está montada ~3.5m delante del eje trasero (estimación conservadora).
  // A la velocidad actual, el bache ya habrá quedado esa distancia atrás.
  const analysisDelayMs = 300;
  const cameraOffsetM = 3.5;
  const speedMs = Math.max(speedKmh / 3.6, 0.1); // evitar división por cero
  const geometricDelayMs = (cameraOffsetM / speedMs) * 1000;
  return Math.min(analysisDelayMs + geometricDelayMs, VIDEO_BUF.maxAgeMs - 200); // techo: no ir más allá del buffer
}

function extractFrameForEvent(eventTs, speedKmh) {
  if (!VIDEO_BUF.frames.length) return null;
  const delayMs = calcFrameDelay(speedKmh);
  const targetTs = eventTs - delayMs;

  // Buscar el frame más cercano al instante objetivo
  let best = null, bestDiff = Infinity;
  VIDEO_BUF.frames.forEach(f => {
    const diff = Math.abs(f.ts - targetTs);
    if (diff < bestDiff) { best = f; bestDiff = diff; }
  });

  // Descartar si la diferencia es mayor de 1.5s (el frame ya no corresponde al evento)
  return bestDiff < 1500 ? best?.blob : null;
}

function extractClipForEvent(eventTs, speedKmh) {
  // Extraer todos los frames en ventana [eventTs - 2.5s, eventTs + 1s]
  // para la galería de validación humana
  const startTs = eventTs - 2500;
  const endTs   = eventTs + 1000;
  return VIDEO_BUF.frames.filter(f => f.ts >= startTs && f.ts <= endTs).map(f => f.blob);
}
```

### ✅ Criterios Fase 2
- [ ] Al iniciar sesión urbana, el log muestra "[Vídeo] Buffer activo"
- [ ] `extractFrameForEvent(ts, 30)` devuelve el frame de hace ~820ms a 30 km/h (verificar en log: `calcFrameDelay(30)` ≈ 820)
- [ ] `extractClipForEvent()` devuelve entre 20 y 40 frames (~2-4s a 10fps)
- [ ] Al terminar la sesión, `stopVideoBuffer()` libera todos los recursos
- [ ] Commit: `feat(video): buffer de frames con extracción compensada por velocidad`

---

## FASE 3 — Pipeline de triple validación

### 3.1 Tres marcadores en pantalla de medición urbana

**Sustituir el HTML del `#measUrbanPanel`** (que ya tiene contadores leve/moderado/grave):

```html
<div class="meas-urban-panel hidden" id="measUrbanPanel">
  <!-- Marcadores de las 3 capas de validación -->
  <div class="validation-counters">
    <div class="vc-item">
      <span class="vc-val" id="vcDetected">0</span>
      <span class="vc-lbl">🔔 Detectados</span>
    </div>
    <div class="vc-item">
      <span class="vc-val" id="vcYoloGemini" style="color:#F97316">0</span>
      <span class="vc-lbl">🟠 YOLO+Gemini</span>
    </div>
    <div class="vc-item">
      <span class="vc-val" id="vcTriple" style="color:#10B981">0</span>
      <span class="vc-lbl">✅ Triple val.</span>
    </div>
  </div>

  <!-- Severidad (como antes) -->
  <div class="meas-event-counts">
    <div class="mec"><span class="mec-val" id="muLeve">0</span><span class="mec-lbl">🟡 Leves</span></div>
    <div class="mec"><span class="mec-val" id="muMod" style="color:#F97316">0</span><span class="mec-lbl">🟠 Moder.</span></div>
    <div class="mec"><span class="mec-val" id="muGrave" style="color:#EF4444">0</span><span class="mec-lbl">🔴 Graves</span></div>
  </div>

  <!-- Último evento con miniatura -->
  <div class="meas-last-event-row">
    <img id="lastEventThumb" style="display:none;width:72px;height:54px;border-radius:4px;object-fit:cover;border:1px solid rgba(14,165,233,.3);cursor:pointer" alt="Último evento" onclick="openEventLightbox(this._eventId)">
    <div class="meas-last-event" id="muLastEvent">Sin eventos detectados</div>
  </div>
</div>
```

### 3.2 Flujo completo de validación por evento

```javascript
async function processEventValidation(event) {
  // === CAPA 1: YOLO (instantánea) ===
  const frameBlob = extractFrameForEvent(event.ts, event.speed);
  event._frameBlob = frameBlob; // guardar para la galería
  event._clipBlobs = extractClipForEvent(event.ts, event.speed); // para vídeo

  let yoloResult = null;
  if (frameBlob && YOLO_STATE.ready) {
    yoloResult = await runYOLO(frameBlob);
    event.yolo = {
      detections: yoloResult,
      confirmed: yoloResult && yoloResult.length > 0 &&
                 !yoloResult.every(d => d.className === 'no_damage'),
      topClass: yoloResult?.[0]?.className || null,
      topConf:  yoloResult?.[0]?.conf || 0
    };
    log(`[YOLO] ${event.yolo.confirmed ? '✅ ' + event.yolo.topClass + ' (' + (event.yolo.topConf*100).toFixed(0) + '%)' : '❌ Sin patología'}`);
  }

  // Si YOLO descarta el evento con alta confianza (no_damage > 0.8) → eliminar
  if (yoloResult && yoloResult.length > 0) {
    const noDamage = yoloResult.find(d => d.className === 'no_damage' && d.conf > 0.8);
    if (noDamage && (!event.yolo?.confirmed)) {
      event._discardedByYOLO = true;
      S.urbanEvents = S.urbanEvents.filter(e => e.id !== event.id);
      updateValidationCounters();
      toast('🔍 YOLO: falso positivo descartado');
      updateLearningStats(event, 'discarded_yolo');
      return;
    }
  }

  // Actualizar marcador 1 (detectados ya estaba, no cambiar aquí)
  // El marcador 2 (YOLO+Gemini) se actualiza cuando AMBOS respondan

  // === CAPA 2: GEMINI (1-3s) ===
  if (frameBlob) {
    analyzeEventWithGemini(event, frameBlob, yoloResult).then(geminiResult => {
      if (!geminiResult) return;

      const layer2Confirmed = event.yolo?.confirmed !== false && !geminiResult.discard;

      if (geminiResult.discard && event.yolo?.confirmed === false) {
        // Ambos descartan → falso positivo confirmado
        event._discardedByLayer2 = true;
        S.urbanEvents = S.urbanEvents.filter(e => e.id !== event.id);
        updateLearningStats(event, 'discarded_both');
        updateValidationCounters();
        toast('🔍 YOLO+Gemini: falso positivo confirmado');
        return;
      }

      if (layer2Confirmed) {
        event.layer2Confirmed = true;
        // Refinar tipo y severidad con los datos de ambas capas
        if (event.yolo?.topClass && !geminiResult.discard) {
          event.type = reconcileType(event.yolo.topClass, geminiResult.type);
        }
        updateLearningStats(event, 'confirmed_layer2');
        updateValidationCounters();
        showEventThumbnail(event, frameBlob);
      }

      // === CAPA 3: MODELO VÍDEO (5-10s) ===
      // Se ejecuta en paralelo con un retardo — no bloquea el resultado de la Capa 2
      if (event._clipBlobs?.length > 3) {
        setTimeout(() => {
          runVideoModel(event._clipBlobs, event.features).then(videoResult => {
            if (!videoResult) return;
            event.videoModel = videoResult;
            const layer3Confirmed = layer2Confirmed && videoResult.confirmed;
            if (layer3Confirmed) {
              event.tripleConfirmed = true;
              updateLearningStats(event, 'confirmed_triple');
              updateValidationCounters();
              log(`[Triple] ✅ ${event.type}/${event.severity} — confianza acumulada alta`);
            }
          });
        }, 100); // pequeño retardo para no bloquear el hilo
      }
    });
  }
}

function reconcileType(yoloClass, geminiType) {
  // Tabla de reconciliación: dar preferencia a YOLO para tipos visuales claros
  const yoloToApp = {
    'pothole': 'pothole', 'alligator_crack': 'crack', 'longitudinal_crack': 'crack',
    'transverse_crack': 'crack', 'raveling': 'degraded', 'patch': 'patch',
    'manhole': 'manhole', 'speedbump': 'speedbump'
  };
  return yoloToApp[yoloClass] || geminiType || 'unknown';
}
```

### 3.3 Función actualizada de Gemini con contexto de YOLO

```javascript
async function analyzeEventWithGemini(event, imageBlob, yoloDetections) {
  const base64 = await blobToBase64(imageBlob);

  // Incluir las detecciones de YOLO en el prompt para que Gemini las considere
  const yoloContext = yoloDetections?.length > 0
    ? `\nDetecciones previas de YOLO11n: ${yoloDetections.map(d => `${d.className} (confianza ${(d.conf*100).toFixed(0)}%)`).join(', ')}`
    : '\nYOLO11n: sin detecciones claras en la imagen.';

  const vibDesc = `Firma de vibración del sensor:
- Amplitud pico: ${event.features?.peakAmp?.toFixed(2)} m/s²
- Jerk máximo: ${event.features?.jerkMax?.toFixed(1)} m/s³
- Duración: ${event.features?.duration?.toFixed(0)} ms
- Bipolaridad: ${event.features?.bipolarity?.toFixed(2)}
- Energía frecuencial: ${event.features?.freqEnergy?.toFixed(2)}
- Velocidad: ${event.speed?.toFixed(1)} km/h${yoloContext}`;

  const prompt = `Eres un sistema de análisis de pavimento vial con experiencia en inspección técnica de carreteras urbanas. Se te proporciona una imagen de la calzada y datos del acelerómetro del vehículo en el mismo instante.

${vibDesc}

Analiza imagen y datos conjuntamente. Responde ÚNICAMENTE con un objeto JSON (sin markdown, sin texto adicional):
{
  "type": "pothole|manhole|speedbump|crack|degraded|patch|none",
  "severity": "leve|moderado|grave|none",
  "confidence": 0.0-1.0,
  "description": "descripción técnica breve en español (máx 100 caracteres)",
  "discard": true|false,
  "discard_reason": "frenazo|sin_desperfecto|imagen_borrosa|none"
}

Criterios de descarte:
- "discard": true si la imagen muestra asfalto en buen estado Y la vibración es compatible con frenazo (bipolaridad < 0.1, duración > 400ms)
- "discard": true si la imagen está desenfocada o sin visibilidad del pavimento
- Si YOLO detectó algo y la imagen es coherente, da más peso a confirmar`;

  try {
    const res = await fetch(`${WORKER_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, features: event.features, speed: event.speed })
    });
    const result = await res.json();
    event.gemini = result;
    event.geminiConfirm = !result.discard;
    return result;
  } catch(e) {
    log('[Gemini] Error: ' + e.message);
    return null; // silencioso
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
```

### 3.4 Función `updateValidationCounters()`

```javascript
function updateValidationCounters() {
  const total   = S.urbanEvents.length;
  const layer2  = S.urbanEvents.filter(e => e.layer2Confirmed).length;
  const triple  = S.urbanEvents.filter(e => e.tripleConfirmed).length;

  queueUI('validationCounters', () => {
    set('vcDetected',   total.toString());
    set('vcYoloGemini', layer2.toString());
    set('vcTriple',     triple.toString());
    // Actualizar también los contadores de severidad
    const leve     = S.urbanEvents.filter(e => e.severity==='leve').length;
    const moderado = S.urbanEvents.filter(e => e.severity==='moderado').length;
    const grave    = S.urbanEvents.filter(e => e.severity==='grave').length;
    set('muLeve',  leve.toString());
    set('muMod',   moderado.toString());
    set('muGrave', grave.toString());
  });
}
```

### ✅ Criterios Fase 3
- [ ] Los 3 marcadores aparecen en la pantalla de medición urbana
- [ ] El marcador "🔔 Detectados" sube inmediatamente al detectar un evento
- [ ] El marcador "🟠 YOLO+Gemini" sube 1-4s después
- [ ] El marcador "✅ Triple val." sube 5-10s después
- [ ] Un frenazo fuerte sin bache visible: YOLO y Gemini coinciden en descartar → el evento desaparece
- [ ] Commit: `feat: pipeline de triple validación con 3 marcadores asíncronos`

---

## FASE 4 — Modelo de vídeo propio (MobileNetV3 + vibración)

### 4.1 Modelo ligero para clasificación de secuencias

El modelo de vídeo propio clasifica secuencias de frames junto con la firma de vibración. Es un modelo de clasificación, no de detección — más simple y ligero que YOLO.

```javascript
const VIDEO_MODEL = {
  session: null,
  ready: false,
  MODEL_URL: '/models/pavement_video_model.onnx',
  SEQUENCE_FRAMES: 10,  // usar 10 frames espaciados del clip de 3.5s
  FRAME_SIZE: 112,      // MobileNetV3 trabaja a 112×112
  CLASS_NAMES: ['pothole','crack','speedbump','manhole','degraded','no_damage'],
  CONF_THRESHOLD: 0.60  // umbral más alto que YOLO — el modelo propio debe ser conservador al inicio
};

async function initVideoModel() {
  if (VIDEO_MODEL.ready || !window.ort) return;
  try {
    VIDEO_MODEL.session = await ort.InferenceSession.create(VIDEO_MODEL.MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });
    VIDEO_MODEL.ready = true;
    log('[VideoModel] Modelo cargado OK');
  } catch(e) {
    log('[VideoModel] No disponible: ' + e.message);
    // Continuar sin modelo de vídeo
  }
}

async function runVideoModel(clipBlobs, vibrationFeatures) {
  if (!VIDEO_MODEL.ready || clipBlobs.length < 5) return null;

  // Seleccionar N frames espaciados uniformemente del clip
  const N = VIDEO_MODEL.SEQUENCE_FRAMES;
  const step = Math.max(1, Math.floor(clipBlobs.length / N));
  const selectedBlobs = Array.from({length: N}, (_, i) => clipBlobs[Math.min(i * step, clipBlobs.length - 1)]);

  // Preprocesar cada frame a 112×112 y concatenar en tensor [1, N, 3, 112, 112]
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = VIDEO_MODEL.FRAME_SIZE;
  const ctx = canvas.getContext('2d');
  const S = VIDEO_MODEL.FRAME_SIZE;
  const frameData = new Float32Array(N * 3 * S * S);

  for (let fi = 0; fi < N; fi++) {
    const img = new Image();
    const url = URL.createObjectURL(selectedBlobs[fi]);
    await new Promise(res => { img.onload = res; img.src = url; });
    URL.revokeObjectURL(url);
    ctx.drawImage(img, 0, 0, S, S);
    const pixels = ctx.getImageData(0, 0, S, S).data;
    const offset = fi * 3 * S * S;
    for (let i = 0; i < S * S; i++) {
      // Normalización ImageNet estándar
      frameData[offset + i]           = (pixels[i*4]   / 255.0 - 0.485) / 0.229; // R
      frameData[offset + i + S*S]     = (pixels[i*4+1] / 255.0 - 0.456) / 0.224; // G
      frameData[offset + i + 2*S*S]   = (pixels[i*4+2] / 255.0 - 0.406) / 0.225; // B
    }
  }

  // Features de vibración normalizadas como vector auxiliar
  const vibVector = new Float32Array([
    Math.min((vibrationFeatures?.peakAmp || 0) / 8, 1),
    Math.min((vibrationFeatures?.jerkMax || 0) / 220, 1),
    Math.min((vibrationFeatures?.duration || 0) / 500, 1),
    vibrationFeatures?.bipolarity || 0,
    vibrationFeatures?.freqEnergy || 0
  ]);

  try {
    const videoTensor = new ort.Tensor('float32', frameData, [1, N, 3, S, S]);
    const vibTensor   = new ort.Tensor('float32', vibVector, [1, 5]);
    const feeds = { video_frames: videoTensor, vib_features: vibTensor };
    const results = await VIDEO_MODEL.session.run(feeds);

    const output = Object.values(results)[0].data;
    let maxConf = 0, maxClass = 0;
    output.forEach((v, i) => { if (v > maxConf) { maxConf = v; maxClass = i; } });

    const confirmed = maxConf >= VIDEO_MODEL.CONF_THRESHOLD &&
                      VIDEO_MODEL.CLASS_NAMES[maxClass] !== 'no_damage';

    return { confirmed, className: VIDEO_MODEL.CLASS_NAMES[maxClass], confidence: maxConf };
  } catch(e) {
    log('[VideoModel] Error en inferencia: ' + e.message);
    return null;
  }
}
```

### 4.2 Script de entrenamiento del modelo de vídeo (para Kaggle/Colab)

```python
# video_model_training/train_video_model.py
# Arquitectura: MobileNetV3-Small como extractor de features por frame
# + GRU para capturar la secuencia temporal
# + Capa de fusión con vector de vibración
# Salida: clasificación en 6 categorías

import torch
import torch.nn as nn
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights

class PavementVideoModel(nn.Module):
    def __init__(self, num_classes=6, num_frames=10, vib_dim=5):
        super().__init__()
        # Backbone: MobileNetV3-Small pretrenado en ImageNet
        backbone = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT)
        self.features = backbone.features
        self.avgpool  = backbone.avgpool
        self.frame_dim = 576  # dimensión de salida de MobileNetV3-Small

        # GRU para capturar dependencias temporales entre frames
        self.temporal = nn.GRU(
            input_size=self.frame_dim,
            hidden_size=256,
            num_layers=2,
            batch_first=True,
            dropout=0.3
        )

        # Fusión con vector de vibración
        self.vib_embed = nn.Linear(vib_dim, 32)

        # Clasificador final
        self.classifier = nn.Sequential(
            nn.Linear(256 + 32, 128),
            nn.ReLU(),
            nn.Dropout(0.4),
            nn.Linear(128, num_classes)
        )

    def forward(self, video_frames, vib_features):
        # video_frames: [batch, T, 3, 112, 112]
        B, T, C, H, W = video_frames.shape
        # Procesar cada frame con el backbone
        frames_flat = video_frames.view(B*T, C, H, W)
        frame_feats = self.avgpool(self.features(frames_flat))
        frame_feats = frame_feats.view(B, T, self.frame_dim)

        # Secuencia temporal
        _, hidden = self.temporal(frame_feats)
        temporal_feat = hidden[-1]  # último estado oculto de la GRU

        # Embed de vibración
        vib_feat = torch.relu(self.vib_embed(vib_features))

        # Fusión y clasificación
        combined = torch.cat([temporal_feat, vib_feat], dim=1)
        return self.classifier(combined)


# Exportar a ONNX tras el entrenamiento:
def export_to_onnx(model, path='pavement_video_model.onnx'):
    model.eval()
    dummy_video = torch.zeros(1, 10, 3, 112, 112)
    dummy_vib   = torch.zeros(1, 5)
    torch.onnx.export(
        model, (dummy_video, dummy_vib), path,
        input_names=['video_frames', 'vib_features'],
        output_names=['class_probs'],
        dynamic_axes={'video_frames': {0:'batch'}, 'vib_features': {0:'batch'}},
        opset_version=12
    )
```

### ✅ Criterios Fase 4
- [ ] `initVideoModel()` se llama en `startMeasurement()` junto con `initYOLO()`
- [ ] `runVideoModel()` procesa el clip sin bloquear el hilo principal (es async)
- [ ] Si el modelo no existe, la capa 3 queda inactiva silenciosamente
- [ ] El marcador "✅ Triple val." solo sube cuando `event.tripleConfirmed === true`
- [ ] Commit: `feat(video-model): clasificador MobileNetV3+GRU para capa 3 de validación`

---

## FASE 5 — Sistema de aprendizaje continuo

### 5.1 Estadísticas de aprendizaje

```javascript
// En S, añadir:
S.learning = {
  totalEvents: 0,
  discardedYOLO: 0,
  discardedBoth: 0,
  confirmedLayer2: 0,
  confirmedTriple: 0,
  humanConfirmed: 0,
  humanCorrected: 0,
  sessionsCount: 0,
  // Historial de ajustes de umbral
  thresholdHistory: []
};
```

```javascript
function updateLearningStats(event, outcome) {
  // outcome: 'discarded_yolo' | 'discarded_both' | 'confirmed_layer2' | 'confirmed_triple' | 'human_confirmed' | 'human_corrected'
  S.learning.totalEvents++;
  switch(outcome) {
    case 'discarded_yolo':    S.learning.discardedYOLO++;    break;
    case 'discarded_both':    S.learning.discardedBoth++;    break;
    case 'confirmed_layer2':  S.learning.confirmedLayer2++;  break;
    case 'confirmed_triple':  S.learning.confirmedTriple++;  break;
    case 'human_confirmed':   S.learning.humanConfirmed++;   break;
    case 'human_corrected':   S.learning.humanCorrected++;   break;
  }
  persistLearningStats();
  maybeAdjustThresholds();
}

function persistLearningStats() {
  try {
    const stored = JSON.parse(localStorage.getItem('rc_learning') || '{}');
    // Acumular en el histórico persistente (no solo la sesión actual)
    Object.keys(S.learning).forEach(k => {
      if (typeof S.learning[k] === 'number') {
        stored[k] = (stored[k] || 0) + (S.learning[k] - (stored['_prev_' + k] || 0));
        stored['_prev_' + k] = S.learning[k];
      }
    });
    localStorage.setItem('rc_learning', JSON.stringify(stored));
  } catch(e) {}
}
```

### 5.2 Autoajuste de umbrales basado en resultados

```javascript
function maybeAdjustThresholds() {
  const stored = JSON.parse(localStorage.getItem('rc_learning') || '{}');
  const total   = stored.totalEvents || 0;
  const discarded = (stored.discardedYOLO || 0) + (stored.discardedBoth || 0);
  const confirmed = (stored.confirmedLayer2 || 0) + (stored.confirmedTriple || 0);

  // Solo ajustar cuando hay suficientes datos (mínimo 50 eventos acumulados)
  if (total < 50) return;

  const falsePositiveRate = discarded / total;
  const LEARNING_RATE = 0.02; // ajuste máximo del 2% por iteración — conservador

  if (falsePositiveRate > 0.40) {
    // Más del 40% de falsos positivos → subir el umbral de disparo
    URBAN_TUNABLE.scoreDiscardBelow = Math.min(
      45, // techo: nunca subir más de 45 (perderíamos muchos eventos reales)
      URBAN_TUNABLE.scoreDiscardBelow + LEARNING_RATE * 100
    );
    log(`[Aprendizaje] FP rate=${(falsePositiveRate*100).toFixed(0)}% → subiendo umbral a ${URBAN_TUNABLE.scoreDiscardBelow.toFixed(1)}`);
  } else if (falsePositiveRate < 0.10 && confirmed / total > 0.80) {
    // Menos del 10% de FP y >80% confirmados → podemos bajar el umbral (capturar más)
    URBAN_TUNABLE.scoreDiscardBelow = Math.max(
      15, // suelo: nunca bajar de 15
      URBAN_TUNABLE.scoreDiscardBelow - LEARNING_RATE * 100
    );
    log(`[Aprendizaje] FP rate=${(falsePositiveRate*100).toFixed(0)}% → bajando umbral a ${URBAN_TUNABLE.scoreDiscardBelow.toFixed(1)}`);
  }

  // Persistir el umbral aprendido asociado al vehículo
  try {
    const vid = S.vehicleId || 'default';
    const vehLearning = JSON.parse(localStorage.getItem('rc_veh_learning') || '{}');
    vehLearning[vid] = { scoreDiscardBelow: URBAN_TUNABLE.scoreDiscardBelow, updatedAt: Date.now() };
    localStorage.setItem('rc_veh_learning', JSON.stringify(vehLearning));
  } catch(e) {}

  S.learning.thresholdHistory.push({ ts: Date.now(), threshold: URBAN_TUNABLE.scoreDiscardBelow, falsePositiveRate });
}
```

### 5.3 Indicador de confianza del sistema

```javascript
function getSystemConfidence() {
  const stored = JSON.parse(localStorage.getItem('rc_learning') || '{}');
  const total     = stored.totalEvents || 0;
  const confirmed = (stored.confirmedLayer2 || 0) + (stored.confirmedTriple || 0) + (stored.humanConfirmed || 0);
  const discarded = (stored.discardedYOLO || 0) + (stored.discardedBoth || 0);

  if (total < 20) return { confidence: 0, level: 'insufficient_data', sessions: stored.sessionsCount || 0 };

  const precision = confirmed / Math.max(confirmed + discarded, 1);
  const level = precision >= 0.90 ? 'high'
              : precision >= 0.75 ? 'medium'
              : 'low';

  return { confidence: precision, level, sessions: stored.sessionsCount || 0, total };
}
```

**Mostrar en la pantalla de configuración** (o en el modal de inicio de sesión):
```javascript
// En algún punto de la UI de configuración existente:
function renderConfidenceIndicator() {
  const conf = getSystemConfidence();
  const pct = (conf.confidence * 100).toFixed(0);
  const icons = { high: '🧠', medium: '📊', low: '📈', insufficient_data: '⏳' };
  return `${icons[conf.level]} IA: ${conf.total > 0 ? pct + '% precisión' : 'Aprendiendo…'} (${conf.sessions} sesiones)`;
}
```

### ✅ Criterios Fase 5
- [ ] Tras una sesión con 5+ eventos, `localStorage.getItem('rc_learning')` contiene datos
- [ ] Tras 50+ eventos acumulados, el umbral `scoreDiscardBelow` se ajusta si FP rate > 40%
- [ ] El indicador de confianza muestra "⏳ IA: Aprendiendo…" hasta tener 20 eventos
- [ ] Los umbrales aprendidos se cargan al iniciar la siguiente sesión con el mismo vehículo
- [ ] Commit: `feat(learning): autoajuste de umbrales y estadísticas de confianza del sistema`

---

## FASE 6 — Galería de validación humana post-sesión

### 6.1 Lightbox con vídeo y bounding boxes de YOLO

```javascript
// Almacenar eventos con sus recursos visuales para la galería
S.eventGallery = []; // { event, frameBlob, clipBlobs, yoloBboxes }

function addToGallery(event, frameBlob, clipBlobs) {
  S.eventGallery.push({ event, frameBlob, clipBlobs });
}

function openEventGallery() {
  if (!S.eventGallery.length) { toast('Sin eventos con imagen en esta sesión'); return; }
  renderGalleryModal(0);
  $('eventGalleryModal').classList.remove('hidden');
}

function renderGalleryModal(idx) {
  const item = S.eventGallery[idx];
  if (!item) return;
  const { event, frameBlob, clipBlobs } = item;

  // Dibujar frame con bounding boxes de YOLO superpuestos
  const canvas = $('galleryCanvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  const url = URL.createObjectURL(frameBlob);
  img.onload = () => {
    canvas.width = img.width; canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);

    // Dibujar bounding boxes de YOLO
    (event.yolo?.detections || []).forEach(det => {
      const colors = { pothole:'#EF4444', alligator_crack:'#F97316', longitudinal_crack:'#F59E0B',
                       transverse_crack:'#EAB308', manhole:'#8B5CF6', speedbump:'#06B6D4' };
      ctx.strokeStyle = colors[det.className] || '#0EA5E9';
      ctx.lineWidth = 3;
      ctx.strokeRect(det.x1, det.y1, det.x2-det.x1, det.y2-det.y1);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = 'bold 14px Courier New';
      ctx.fillText(`${det.className} ${(det.conf*100).toFixed(0)}%`, det.x1, det.y1 - 5);
    });
  };
  img.src = url;

  // Información del evento
  set('galleryEventInfo',
    `#${idx+1}/${S.eventGallery.length} · ${event.type} · ${event.severity} · score ${event.score?.toFixed(0)} · ${event.speed?.toFixed(0)} km/h\n` +
    (event.gemini?.description || '') + '\n' +
    (event.tripleConfirmed ? '✅ Triple validación' : event.layer2Confirmed ? '🟠 YOLO+Gemini' : '🔔 Solo vibración')
  );

  // Reproductor de clip de vídeo (si hay clips disponibles)
  if (clipBlobs?.length > 3) {
    renderVideoPlayer(clipBlobs, $('galleryVideoPlayer'));
  }

  // Botones de validación humana
  $('galleryBtnConfirm').onclick = () => humanValidate(idx, 'confirmed');
  $('galleryBtnDiscard').onclick = () => humanValidate(idx, 'discarded');
  $('galleryBtnCorrect').onclick = () => humanValidate(idx, 'corrected');
  $('galleryBtnPrev').disabled = idx === 0;
  $('galleryBtnNext').disabled = idx === S.eventGallery.length - 1;
  $('galleryBtnPrev').onclick  = () => renderGalleryModal(idx - 1);
  $('galleryBtnNext').onclick  = () => renderGalleryModal(idx + 1);

  $('galleryCurrentIdx').value = idx; // guardar idx actual para validación
}

function humanValidate(idx, action) {
  const item = S.eventGallery[idx];
  if (!item) return;
  const { event } = item;

  switch(action) {
    case 'confirmed':
      event.humanValidated = true;
      event.humanConfirmed = true;
      updateLearningStats(event, 'human_confirmed');
      toast('✅ Evento confirmado');
      break;
    case 'discarded':
      event.humanValidated = true;
      event.humanConfirmed = false;
      S.urbanEvents = S.urbanEvents.filter(e => e.id !== event.id);
      updateLearningStats(event, 'human_corrected');
      toast('❌ Falso positivo marcado');
      break;
    case 'corrected':
      // Abrir selector de tipo para corrección
      showTypeCorrectionModal(event, idx);
      return;
  }

  // Actualizar estado visual del botón
  $('galleryBtnConfirm').disabled = true;
  $('galleryBtnDiscard').disabled = true;

  // Guardar para el dataset de entrenamiento
  saveToTrainingDataset(event, item.frameBlob, item.clipBlobs, action);
}

async function saveToTrainingDataset(event, frameBlob, clipBlobs, humanLabel) {
  // Guardar metadatos en localStorage para futuro entrenamiento
  // (las imágenes/clips son demasiado grandes para localStorage — solo metadatos)
  try {
    const dataset = JSON.parse(localStorage.getItem('rc_training_dataset') || '[]');
    dataset.push({
      id: event.id,
      ts: event.ts,
      type: event.type,
      severity: event.severity,
      score: event.score,
      features: event.features,
      yoloResult: event.yolo,
      geminiResult: event.gemini,
      videoModelResult: event.videoModel,
      humanLabel,
      hasFrame: !!frameBlob,
      hasClip: clipBlobs?.length > 0
    });
    // Mantener solo los últimos 500 registros
    if (dataset.length > 500) dataset.splice(0, dataset.length - 500);
    localStorage.setItem('rc_training_dataset', JSON.stringify(dataset));
  } catch(e) {}
}
```

### 6.2 Reproductor de clip de vídeo

```javascript
function renderVideoPlayer(clipBlobs, containerEl) {
  if (!containerEl || !clipBlobs?.length) return;

  let currentFrame = 0;
  let playing = false;
  let intervalId = null;
  const FPS = 10;

  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 240;
  canvas.style.width = '100%'; canvas.style.borderRadius = '6px';
  const ctx = canvas.getContext('2d');

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:6px;margin-top:4px;justify-content:center';
  controls.innerHTML = `
    <button id="vpPlay" style="padding:4px 12px;background:var(--sky);color:#05111F;border:none;border-radius:4px;cursor:pointer;font-size:.75rem">▶</button>
    <button id="vpPause" style="padding:4px 12px;background:var(--s2);color:var(--txt);border:1px solid rgba(14,165,233,.2);border-radius:4px;cursor:pointer;font-size:.75rem">⏸</button>
    <span style="font-family:var(--mono);font-size:.65rem;color:var(--dim);align-self:center" id="vpFrame">0/${clipBlobs.length}</span>
  `;

  containerEl.innerHTML = '';
  containerEl.appendChild(canvas);
  containerEl.appendChild(controls);

  async function showFrame(idx) {
    if (idx < 0 || idx >= clipBlobs.length) return;
    const img = new Image();
    const url = URL.createObjectURL(clipBlobs[idx]);
    await new Promise(res => { img.onload = res; img.src = url; });
    ctx.drawImage(img, 0, 0, 320, 240);
    URL.revokeObjectURL(url);
    document.getElementById('vpFrame').textContent = `${idx+1}/${clipBlobs.length}`;
  }

  document.getElementById('vpPlay').onclick = () => {
    if (playing) return;
    playing = true;
    intervalId = setInterval(async () => {
      await showFrame(currentFrame);
      currentFrame = (currentFrame + 1) % clipBlobs.length;
    }, 1000 / FPS);
  };
  document.getElementById('vpPause').onclick = () => {
    playing = false;
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
  };

  showFrame(0); // mostrar primer frame al abrir
}
```

### 6.3 HTML del modal de galería

```html
<!-- Añadir al final de index.html, antes del cierre </body> -->
<div class="modal hidden" id="eventGalleryModal">
  <div class="modal-box gallery-box">
    <h3>📷 Galería de eventos — Validación</h3>
    <canvas id="galleryCanvas" style="width:100%;border-radius:6px;margin:8px 0"></canvas>
    <div id="galleryVideoPlayer" style="margin:6px 0"></div>
    <div id="galleryEventInfo" style="font-family:var(--mono);font-size:.68rem;color:var(--dim);white-space:pre-line;margin:6px 0"></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">
      <button id="galleryBtnConfirm" class="btn" style="flex:1">✅ Correcto</button>
      <button id="galleryBtnDiscard" class="btn btn-sec" style="flex:1">❌ Falso positivo</button>
      <button id="galleryBtnCorrect" class="btn btn-sec" style="flex:1">✏️ Corregir tipo</button>
    </div>
    <div style="display:flex;gap:6px;justify-content:space-between;margin-top:4px">
      <button id="galleryBtnPrev" class="btn btn-sec">← Anterior</button>
      <span id="galleryCurrentIdx" style="display:none"></span>
      <button id="galleryBtnNext" class="btn btn-sec">Siguiente →</button>
    </div>
    <button class="btn btn-sec" style="width:100%;margin-top:8px" onclick="$('eventGalleryModal').classList.add('hidden')">Cerrar</button>
  </div>
</div>
```

```css
.gallery-box {
  max-width: 520px;
  max-height: 92vh;
  overflow-y: auto;
}
```

**Acceso a la galería**: añadir botón "📷 Galería" en el modal de guardar ruta:
```html
<button class="btn btn-sec" onclick="openEventGallery()">📷 Revisar eventos</button>
```

### ✅ Criterios Fase 6
- [ ] Al terminar una sesión urbana con imágenes, aparece el botón "📷 Revisar eventos"
- [ ] La galería muestra el frame con los bounding boxes de YOLO superpuestos
- [ ] El reproductor de vídeo muestra el clip de 3.5s con play/pausa
- [ ] Confirmar un evento actualiza `S.learning.humanConfirmed`
- [ ] Descartar un evento lo elimina de `S.urbanEvents` y actualiza las estadísticas
- [ ] Commit: `feat(gallery): galería de validación humana con vídeo y bboxes YOLO`

---

## FASE 7 — Actualizar endpoint Worker para Gemini con contexto YOLO

El Worker actual en `/api/analyze` no recibe las detecciones de YOLO. Actualizar para incluirlas en el prompt:

```javascript
// En workers/pavement-check-api/index.js, en el endpoint /api/analyze:
// El body ahora puede incluir: { image, features, speed, yoloDetections }

const { image, features, speed, yoloDetections } = body;
const yoloContext = yoloDetections?.length > 0
  ? `\nDetecciones YOLO11n (confianza > 45%): ${yoloDetections.map(d => `${d.className} ${(d.conf*100).toFixed(0)}%`).join(', ')}`
  : '\nYOLO11n: sin detecciones en la imagen.';
// ... añadir yoloContext al prompt de Gemini ...
```

Después de actualizar el Worker: `wrangler deploy`

### ✅ Criterios Fase 7
- [ ] El Worker actualizado recibe `yoloDetections` en el body y lo incluye en el prompt de Gemini
- [ ] `wrangler deploy` ejecutado exitosamente
- [ ] Commit: `feat(worker): prompt Gemini enriquecido con detecciones YOLO`

---

## ORDEN DE EJECUCIÓN Y DESPLIEGUE FINAL

```
Prerequisito: MEJORAS_V5A_SPEC.md completamente implementado y pusheado

Fase 1 → commit (crear archivos de entrenamiento — modelo .onnx se añade manualmente)
Fase 2 → commit → verificar log del buffer de vídeo
Fase 3 → commit → verificar 3 marcadores en pantalla de medición
Fase 4 → commit (el modelo .onnx del video se añade manualmente después del entrenamiento)
Fase 5 → commit → verificar localStorage 'rc_learning' tras sesión de prueba
Fase 6 → commit → verificar galería con eventos de prueba
Fase 7 → commit → wrangler deploy
git push → Cloudflare Pages despliega automáticamente
```

## RESUMEN DE ARCHIVOS MODIFICADOS

| Archivo | Fases | Cambios |
|---|---|---|
| `app.js` | 1-7 | YOLO_STATE, VIDEO_MODEL, VIDEO_BUF, processEventValidation, runYOLO, runVideoModel, updateValidationCounters, updateLearningStats, maybeAdjustThresholds, openEventGallery, renderGalleryModal, humanValidate |
| `index.html` | 1,3,6 | script ONNX Runtime, #measUrbanPanel con 3 marcadores, #eventGalleryModal |
| `workers/pavement-check-api/index.js` | 7 | contexto YOLO en prompt Gemini |
| `yolo_training/` (nuevo) | 1 | dataset.yaml, train.py, quantize.py |
| `video_model_training/` (nuevo) | 4 | train_video_model.py |
| `/models/` (nuevo, archivos añadidos manualmente) | 1,4 | pavement_yolo11n.onnx, pavement_video_model.onnx |

## VARIABLES GLOBALES NUEVAS (para referencia futura)

```javascript
// Disponibles en S tras este spec:
S.eventGallery      // array de { event, frameBlob, clipBlobs }
S.learning          // estadísticas de aprendizaje de la sesión
// Globales (no en S):
YOLO_STATE          // estado del modelo YOLO
VIDEO_MODEL         // estado del modelo de vídeo
VIDEO_BUF           // buffer de frames de vídeo
```
