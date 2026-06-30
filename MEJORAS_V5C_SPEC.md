# Especificación Técnica: Estabilización Modo Urbano
## Pavement Check — v5c (Estabilización para validación de campo)

> **Instrucciones para Claude Code**:
> 1. Lee este documento COMPLETO antes de tocar una línea de código.
> 2. Fases en orden estricto. Commit al finalizar cada una.
> 3. Este spec NO toca el pipeline de fusión bayesiana ni YOLO — solo estabiliza
>    lo que ya existe para que funcione correctamente en campo.
> 4. git push al finalizar todas las fases.
> 5. Ante cualquier duda, para y pregunta. No implementes alternativas sin consultar.

---

## FASE 1 — Ejes del joystick calibrados por orientación del móvil

### 1.1 El problema

El joystick usa ax/ay crudos asumiendo posición horizontal.
En posición vertical, la gravedad cae en eje Y, desplazando el punto
central completamente hacia arriba. El fix proyecta sobre el plano
perpendicular al vector de gravedad calibrado — igual que hace IRI.

### 1.2 Fix en updateAccelViz()

Sustituir la función completa:

```javascript
function updateAccelViz(ax, ay, az) {
  const dot   = $('avDot');
  const zFill = $('avZfill');
  const zVal  = $('avZval');
  if (!dot || !zFill || !S.grav) return;

  const g = S.grav;

  // Componente vertical calibrada (lo que mide el IRI)
  const vertRaw = ax*g.x + ay*g.y + az*g.z - S.gravMag;

  // Proyección sobre el plano perpendicular a la gravedad
  // Esto elimina el offset de orientación sea cual sea la posición del móvil
  // vert proyectado sobre el plano horizontal calibrado:
  const dot_ag = ax*g.x + ay*g.y + az*g.z;
  const projX  = ax - dot_ag * g.x; // componente lateral calibrada
  const projY  = ay - dot_ag * g.y; // componente longitudinal calibrada

  // Joystick: lateral (projX) y longitudinal (projY)
  const MAX_XY = 4; // m/s² = rango completo
  const pctX = Math.max(-44, Math.min(44, (projX / MAX_XY) * 44));
  const pctY = Math.max(-44, Math.min(44, (-projY / MAX_XY) * 44));
  dot.style.left = (50 + pctX) + '%';
  dot.style.top  = (50 + pctY) + '%';

  const magXY = Math.sqrt(projX*projX + projY*projY);
  if (!dot.classList.contains('event')) {
    dot.className = 'av-dot' +
      (magXY > 2 ? ' bad' : magXY > 1 ? ' warn' : '');
  }

  // Barra Z: aceleración vertical calibrada
  const MAX_Z = 6;
  const pctZ  = Math.max(0, Math.min(50,
    Math.abs(vertRaw) / MAX_Z * 50));
  zFill.style.height = pctZ + '%';
  if (!zFill.classList.contains('event')) {
    zFill.className = 'av-zfill' +
      (Math.abs(vertRaw) > 3 ? ' bad'
       : Math.abs(vertRaw) > 1.5 ? ' warn' : '');
  }
  if (zVal) zVal.textContent = vertRaw.toFixed(2);
}
```

### 1.3 Verificación

En la pantalla de medición con el móvil en reposo (cualquier orientación
tras calibrar), el punto del joystick debe estar centrado en el círculo.
Al inclinar el móvil lateralmente, el punto se desplaza lateralmente.
Al frenar, el punto se desplaza hacia arriba (longitudinal).

### ✅ Criterios Fase 1
- [ ] Con móvil vertical calibrado: punto centrado en el joystick
- [ ] Con móvil horizontal calibrado: punto centrado en el joystick
- [ ] Al inclinar el móvil lateralmente: punto se desplaza
- [ ] La barra Z reacciona a golpes verticales en cualquier orientación
- [ ] Commit: `fix(viz): joystick proyectado sobre plano calibrado — orientación independiente`

---

## FASE 2 — Sincronización de imagen: retardo ajustado y calidad

### 2.1 Ajuste del retardo de compensación

La cámara está en el parabrisas (no en el eje trasero), a ~2m del punto
de impacto. Reducir el offset de 3.5m a 2.0m:

```javascript
function calcFrameDelay(speedKmh) {
  const analysisMs    = 300;
  const cameraOffsetM = 2.0; // parabrisas, no eje trasero
  const speedMs = Math.max(speedKmh / 3.6, 0.1);
  return Math.min(
    analysisMs + (cameraOffsetM / speedMs) * 1000,
    VIDEO_BUF.maxAgeMs * 0.85
  );
}
```

Retardos a velocidades típicas:
- 10 km/h → 300 + 720ms = 1020ms ✓
- 30 km/h → 300 + 240ms = 540ms  ✓
- 50 km/h → 300 + 144ms = 444ms  ✓

### 2.2 Extracción de 3 frames por evento (no 1)

En vez de un único frame con retardo fijo, extraer 3 frames en una
ventana de ±200ms alrededor del retardo nominal. Esto garantiza que
al menos uno capture el desperfecto claramente aunque el retardo
calculado tenga variabilidad real de ±200ms.

```javascript
// SUSTITUIR extractFrameForEvent() por extractFramesForEvent()
// que devuelve un array de hasta 3 blobs:

function extractFramesForEvent(eventTs, speedKmh) {
  if (!VIDEO_BUF.frames.length) {
    log('[Frames] Sin frames en buffer');
    return [];
  }
  const D = calcFrameDelay(speedKmh);

  // 3 targets: antes del nominal, nominal, después del nominal
  const targets = [
    { label: 'A', ts: eventTs - (D + 200) }, // más atrás
    { label: 'B', ts: eventTs - D           }, // nominal
    { label: 'C', ts: eventTs - (D - 200)  }, // más cerca
  ];

  const results = targets.map(t => {
    let best = null, bestDiff = Infinity;
    VIDEO_BUF.frames.forEach(f => {
      const d = Math.abs(f.ts - t.ts);
      if (d < bestDiff) { best = f; bestDiff = d; }
    });
    const valid = best && bestDiff < 800;
    log(`[Frame ${t.label}] target=${t.ts} diff=${bestDiff.toFixed(0)}ms `+
        `${valid ? '✓' : '✗'}`);
    return valid ? { blob: best.blob, label: t.label, diff: bestDiff } : null;
  }).filter(Boolean);

  // Deduplicar: si dos targets apuntan al mismo frame físico, usar solo uno
  const seen = new Set();
  return results.filter(r => {
    const key = r.blob; // mismo blob = mismo frame
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Devuelve array de { blob, label, diff } — mínimo 1, máximo 3
}

// NOTA para Claude Code: en todos los lugares donde antes se llamaba a
// extractFrameForEvent(), sustituir por extractFramesForEvent() y usar
// frames[1]?.blob (el nominal, índice 1) cuando se necesita un único frame
// para enviar a Gemini. Guardar el array completo en event._frameBlobs.
```

### 2.3 Integración en el registro de eventos

```javascript
// En registerEvent() o en processEventValidation(), tras detectar el evento:

const frames = extractFramesForEvent(event.ts, event.speed || 0);
event._frameBlobs = frames;          // array de {blob, label, diff}
event._frameBlob  = frames[1]?.blob  // frame nominal para Gemini
                 || frames[0]?.blob; // fallback al primero disponible

log(`[Frames] Capturados ${frames.length} frames para evento ${event.id}`);
```

### 2.4 Calidad de captura: aumentar resolución

```javascript
// En startVideoBuffer(), actualizar constraints:
const constraints = {
  video: S.selectedCameraId
    ? {
        deviceId: { exact: S.selectedCameraId },
        width:  { ideal: 1280 },
        height: { ideal: 720  },
        frameRate: { ideal: 30 }
      }
    : {
        facingMode: 'environment',
        width:  { ideal: 1280 },
        height: { ideal: 720  },
        frameRate: { ideal: 30 }
      },
  audio: false
};

// Actualizar dimensiones del canvas de captura:
VIDEO_BUF.canvas.width  = 1280;
VIDEO_BUF.canvas.height = 720;

// Subir calidad JPEG:
VIDEO_BUF.canvas.toBlob(blob => {
  // ...
}, 'image/jpeg', 0.85); // antes 0.75
```

> El buffer de 3.5s a 10fps y 1280×720 ocupa ~15-25MB en RAM.
> El Samsung A56 tiene 8GB — completamente viable.

### ✅ Criterios Fase 2
- [ ] Log "[Frame A/B/C] diff=XXXms" aparece 3 veces al detectar un evento
- [ ] Al menos 2 de los 3 frames tienen diff < 300ms
- [ ] `event._frameBlobs` tiene entre 1 y 3 elementos
- [ ] La resolución del stream es 1280×720
- [ ] Commit: `feat(video): 3 frames por evento con ventana ±200ms, resolución 1280×720`

---

## FASE 3 — Galería de validación con zoom/paneo y gestos táctiles

### 3.1 Estructura HTML del modal de galería

Sustituir o crear el modal `#eventGalleryModal` completo:

```html
<div class="modal hidden" id="eventGalleryModal">
  <div class="gallery-modal-box">

    <!-- Header -->
    <div class="gal-header">
      <span class="gal-counter" id="galCounter">1 / 0</span>
      <span class="gal-title" id="galTitle">Revisión de eventos</span>
      <button class="gal-close" onclick="closeGallery()">✕</button>
    </div>

    <!-- Visor de imagen con zoom/paneo -->
    <div class="gal-image-wrap" id="galImageWrap">
      <canvas id="galCanvas"></canvas>
      <div class="gal-no-image hidden" id="galNoImage">
        📷 Sin imagen capturada
      </div>
      <!-- Indicador de frame activo -->
      <div class="gal-frame-badge" id="galFrameBadge"></div>
    </div>

    <!-- Carrusel de miniaturas de los 3 frames -->
    <div class="gal-thumbs" id="galThumbs"></div>

    <!-- Info del evento -->
    <div class="gal-info" id="galInfo">
      <div class="gal-badges" id="galBadges"></div>
      <div class="gal-desc"  id="galDesc"></div>
      <div class="gal-coords" id="galCoords"></div>
    </div>

    <!-- Acciones de validación -->
    <div class="gal-actions">
      <button class="gal-btn gal-confirm" id="galBtnOk"
              onclick="validateEvent('confirmed')">
        ✅ Correcto
      </button>
      <button class="gal-btn gal-correct" id="galBtnEdit"
              onclick="openTypeCorrector()">
        ✏️ Corregir
      </button>
      <button class="gal-btn gal-reject" id="galBtnNo"
              onclick="validateEvent('discarded')">
        ❌ Falso positivo
      </button>
    </div>

    <!-- Navegación -->
    <div class="gal-nav">
      <button class="gal-nav-btn" id="galPrev"
              onclick="galleryNav(-1)">← Anterior</button>
      <div class="gal-nav-dots" id="galDots"></div>
      <button class="gal-nav-btn" id="galNext"
              onclick="galleryNav(1)">Siguiente →</button>
    </div>

  </div>
</div>

<!-- Corrector de tipo (sub-modal) -->
<div class="modal hidden" id="typeCorrectorModal">
  <div class="modal-box">
    <h3>✏️ Corregir clasificación</h3>
    <div class="type-grid" id="typeGrid"></div>
    <button class="btn btn-sec" style="margin-top:8px;width:100%"
            onclick="$('typeCorrectorModal').classList.add('hidden')">
      Cancelar
    </button>
  </div>
</div>
```

### 3.2 CSS de la galería

```css
.gallery-modal-box {
  position: fixed; inset: 0; z-index: 8000;
  background: var(--bg);
  display: flex; flex-direction: column;
  overflow: hidden;
}
.gal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; background: var(--s1);
  border-bottom: 1px solid rgba(14,165,233,.15);
  flex-shrink: 0;
}
.gal-counter { font-family: var(--mono); font-size: var(--fs-sm);
               color: var(--sky); }
.gal-title   { font-size: var(--fs-sm); color: var(--txt); }
.gal-close   { background: none; border: none; color: var(--dim);
               font-size: 1.2rem; cursor: pointer;
               width: 36px; height: 36px; }

.gal-image-wrap {
  flex: 1; position: relative; overflow: hidden;
  background: #000; cursor: grab; min-height: 0;
}
.gal-image-wrap:active { cursor: grabbing; }
#galCanvas { display: block; width: 100%; height: 100%;
             object-fit: contain; touch-action: none; }
.gal-frame-badge {
  position: absolute; top: 8px; right: 8px;
  background: rgba(0,0,0,.6); color: #fff;
  font-size: .65rem; font-family: var(--mono);
  padding: 3px 8px; border-radius: 8px;
  pointer-events: none;
}
.gal-thumbs {
  display: flex; gap: 6px; padding: 6px 14px;
  background: #000; flex-shrink: 0;
  overflow-x: auto; justify-content: center;
}
.gal-thumb {
  width: 72px; height: 54px; object-fit: cover;
  border-radius: 4px; cursor: pointer; flex-shrink: 0;
  border: 2px solid transparent;
  transition: border-color .15s, opacity .15s;
  opacity: .6;
}
.gal-thumb.active {
  border-color: var(--sky);
  opacity: 1;
}
.gal-thumb-wrap {
  position: relative; flex-shrink: 0;
}
.gal-thumb-label {
  position: absolute; bottom: 2px; left: 50%;
  transform: translateX(-50%);
  font-size: .5rem; color: #fff;
  background: rgba(0,0,0,.5); padding: 1px 4px;
  border-radius: 3px; pointer-events: none;
  font-family: var(--mono);
}

.gal-info {
  padding: 8px 14px; flex-shrink: 0;
  border-top: 1px solid rgba(14,165,233,.1);
}
.gal-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.gal-badge  {
  font-size: var(--fs-xs); font-family: var(--mono);
  padding: 2px 8px; border-radius: 10px;
  background: var(--s2); color: var(--txt);
}
.gal-badge.confirmed { background: rgba(16,185,129,.2); color: #10B981; }
.gal-badge.discarded { background: rgba(239,68,68,.2);  color: #EF4444; }
.gal-badge.corrected { background: rgba(245,158,11,.2); color: #F59E0B; }
.gal-desc   { font-size: var(--fs-xs); color: var(--dim);
              font-family: var(--mono); }
.gal-coords { font-size: var(--fs-xs); color: var(--dim);
              font-family: var(--mono); }

.gal-actions {
  display: flex; gap: 8px; padding: 8px 14px;
  flex-shrink: 0; background: var(--s1);
}
.gal-btn {
  flex: 1; padding: 10px 0; border: none; border-radius: 8px;
  font-size: var(--fs-sm); font-weight: 700; cursor: pointer;
  min-height: var(--tap-min);
}
.gal-confirm { background: rgba(16,185,129,.15); color: #10B981;
               border: 1px solid rgba(16,185,129,.3); }
.gal-correct { background: rgba(245,158,11,.15); color: #F59E0B;
               border: 1px solid rgba(245,158,11,.3); }
.gal-reject  { background: rgba(239,68,68,.15);  color: #EF4444;
               border: 1px solid rgba(239,68,68,.3); }
.gal-btn:disabled { opacity: .4; pointer-events: none; }

.gal-nav {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 14px; flex-shrink: 0;
  border-top: 1px solid rgba(14,165,233,.1);
}
.gal-nav-btn {
  background: var(--s2); border: 1px solid rgba(14,165,233,.2);
  color: var(--txt); padding: 8px 16px; border-radius: 6px;
  font-size: var(--fs-sm); cursor: pointer; min-height: var(--tap-min);
}
.gal-nav-btn:disabled { opacity: .3; pointer-events: none; }
.gal-nav-dots { display: flex; gap: 5px; }
.gal-nav-dot  {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--dim); transition: background .2s;
}
.gal-nav-dot.active { background: var(--sky); }

.type-grid {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 8px; margin-top: 8px;
}
.type-btn {
  padding: 12px 8px; border: 1px solid rgba(14,165,233,.2);
  border-radius: 8px; background: var(--s2);
  color: var(--txt); font-size: var(--fs-sm);
  cursor: pointer; text-align: center;
}
.type-btn:active { background: rgba(14,165,233,.15); }
```

### 3.3 Zoom y paneo con gestos táctiles

```javascript
// Estado del zoom/paneo de la galería
const GAL = {
  items: [],        // { event, frameBlob, clipBlobs }
  idx: 0,
  // Estado del visor de imagen
  img: null,        // Image actual cargada
  scale: 1,
  minScale: 1,
  maxScale: 5,
  offsetX: 0,
  offsetY: 0,
  // Estado de gestos táctiles
  _lastTouchDist: null,
  _lastTouchX: null,
  _lastTouchY: null,
  _isDragging: false,
  _tapTimeout: null,
  _lastTap: 0
};

function openGallery(startIdx = 0) {
  if (!GAL.items.length) {
    toast('Sin eventos con imagen en esta sesión');
    return;
  }
  GAL.idx = Math.min(startIdx, GAL.items.length - 1);
  $('eventGalleryModal').classList.remove('hidden');
  renderGalleryItem(GAL.idx);
  initGalleryGestures();
}

function closeGallery() {
  $('eventGalleryModal').classList.add('hidden');
  GAL.img = null;
}

function galleryNav(dir) {
  const newIdx = GAL.idx + dir;
  if (newIdx < 0 || newIdx >= GAL.items.length) return;
  GAL.idx = newIdx;
  renderGalleryItem(GAL.idx);
}

function renderGalleryItem(idx) {
  const item = GAL.items[idx];
  if (!item) return;
  const { event } = item;

  // Contador y dots de navegación
  set('galCounter', `${idx + 1} / ${GAL.items.length}`);
  renderGalleryDots(idx);

  // Botones nav
  $('galPrev').disabled = idx === 0;
  $('galNext').disabled = idx === GAL.items.length - 1;

  // Resetear zoom al cambiar de item
  GAL.scale = 1; GAL.offsetX = 0; GAL.offsetY = 0;
  GAL.activeFrameIdx = 1; // frame nominal por defecto (índice 1 = B)

  // Obtener los frames disponibles (array de {blob, label, diff})
  const frames = event._frameBlobs || [];
  const noFrames = frames.length === 0;

  const canvas = $('galCanvas');
  const wrap   = $('galImageWrap');
  const noImg  = $('galNoImage');
  const thumbs = $('galThumbs');
  const badge  = $('galFrameBadge');

  // Mostrar carrusel de miniaturas
  if (thumbs) {
    if (noFrames) {
      thumbs.innerHTML = '';
      thumbs.style.display = 'none';
    } else {
      thumbs.style.display = 'flex';
      thumbs.innerHTML = frames.map((f, fi) => {
        const url = URL.createObjectURL(f.blob);
        const active = fi === GAL.activeFrameIdx ? ' active' : '';
        // Revocar URL tras 60s
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return `
          <div class="gal-thumb-wrap">
            <img class="gal-thumb${active}"
                 src="${url}"
                 onclick="selectGalleryFrame(${fi})"
                 data-fi="${fi}">
            <div class="gal-thumb-label">
              ${f.label} ${f.diff < 100 ? '✓' : '~'}${f.diff.toFixed(0)}ms
            </div>
          </div>`;
      }).join('');
    }
  }

  // Cargar el frame activo en el canvas principal
  if (noFrames) {
    canvas.style.display = 'none';
    noImg.classList.remove('hidden');
    if (badge) badge.textContent = '';
  } else {
    noImg.classList.add('hidden');
    canvas.style.display = 'block';
    loadFrameToCanvas(frames[GAL.activeFrameIdx]?.blob
                   || frames[0]?.blob,
                      frames[GAL.activeFrameIdx]?.label || 'B');
  }

  // Info del evento
  const typeIcons = {
    pothole:'🕳️', manhole:'⭕', speedbump:'⛰️',
    crack:'〰️', degraded:'🔴', patch:'🔧', unknown:'❓'
  };
  const sevColors = {
    leve:'#F59E0B', moderado:'#F97316', grave:'#EF4444'
  };
  const icon     = typeIcons[event.type] || '❓';
  const sevColor = sevColors[event.severity] || '#3A5F7A';

  $('galBadges').innerHTML = [
    `<span class="gal-badge">${icon} ${event.type||'desconocido'}</span>`,
    `<span class="gal-badge" style="color:${sevColor}">`+
      `${event.severity||'—'}</span>`,
    `<span class="gal-badge">Score: ${event.score?.toFixed(0)||'—'}</span>`,
    `<span class="gal-badge">${event.speed?.toFixed(0)||'—'} km/h</span>`,
    `<span class="gal-badge">${frames.length} frame${frames.length!==1?'s':''}</span>`,
    event.humanLabel
      ? `<span class="gal-badge ${event.humanLabel}">`+
        `${event.humanLabel==='confirmed' ? '✅' :
           event.humanLabel==='discarded' ? '❌' : '✏️'} Validado</span>`
      : '<span class="gal-badge">Sin validar</span>'
  ].join('');

  $('galDesc').textContent   = event.gemini?.description || '';
  $('galCoords').textContent = event.lat
    ? `📍 ${event.lat.toFixed(5)}, ${event.lon.toFixed(5)}`
    : '';

  const validated = !!event.humanLabel;
  $('galBtnOk').disabled   = validated;
  $('galBtnEdit').disabled = validated;
  $('galBtnNo').disabled   = validated;
}

function selectGalleryFrame(fi) {
  const item = GAL.items[GAL.idx];
  if (!item) return;
  const frames = item.event._frameBlobs || [];
  if (!frames[fi]) return;

  GAL.activeFrameIdx = fi;
  GAL.scale = 1; GAL.offsetX = 0; GAL.offsetY = 0;

  // Actualizar clase active en miniaturas
  document.querySelectorAll('.gal-thumb').forEach((el, i) => {
    el.classList.toggle('active', i === fi);
  });

  loadFrameToCanvas(frames[fi].blob, frames[fi].label);
}

function loadFrameToCanvas(blob, label) {
  if (!blob) return;
  const canvas = $('galCanvas');
  const wrap   = $('galImageWrap');
  const badge  = $('galFrameBadge');
  if (badge) badge.textContent = `Frame ${label}`;

  const url = URL.createObjectURL(blob);
  GAL.img = new Image();
  GAL.img.onload = () => {
    URL.revokeObjectURL(url);
    const wrapRect  = wrap.getBoundingClientRect();
    const imgRatio  = GAL.img.width / GAL.img.height;
    const wrapRatio = wrapRect.width / wrapRect.height;
    if (imgRatio > wrapRatio) {
      canvas.width  = wrapRect.width;
      canvas.height = wrapRect.width / imgRatio;
    } else {
      canvas.height = wrapRect.height;
      canvas.width  = wrapRect.height * imgRatio;
    }
    drawGalleryCanvas();
  };
  GAL.img.src = url;
}

function drawGalleryCanvas() {
  const canvas = $('galCanvas');
  if (!canvas || !GAL.img) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(
    canvas.width/2  + GAL.offsetX,
    canvas.height/2 + GAL.offsetY
  );
  ctx.scale(GAL.scale, GAL.scale);
  ctx.drawImage(GAL.img,
    -GAL.img.width/2, -GAL.img.height/2,
    GAL.img.width, GAL.img.height);
  ctx.restore();
}

function renderGalleryDots(activeIdx) {
  const container = $('galDots');
  if (!container) return;
  const max = Math.min(GAL.items.length, 9);
  const start = Math.max(0, Math.min(activeIdx - 4, GAL.items.length - max));
  container.innerHTML = Array.from({ length: max }, (_, i) => {
    const realIdx = start + i;
    const active  = realIdx === activeIdx ? ' active' : '';
    return `<div class="gal-nav-dot${active}"></div>`;
  }).join('');
}

function initGalleryGestures() {
  const canvas = $('galCanvas');
  if (!canvas) return;

  // Eliminar listeners anteriores reasignando el canvas
  const newCanvas = canvas.cloneNode(true);
  canvas.parentNode.replaceChild(newCanvas, canvas);
  const c = $('galCanvas');

  // PINCH TO ZOOM
  c.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      GAL._lastTouchDist = getTouchDist(e.touches);
    } else if (e.touches.length === 1) {
      GAL._lastTouchX = e.touches[0].clientX;
      GAL._lastTouchY = e.touches[0].clientY;
      GAL._isDragging = true;
      // Detección de doble tap
      const now = Date.now();
      if (now - GAL._lastTap < 300) {
        // Doble tap: toggle zoom 1× ↔ 3×
        GAL.scale   = GAL.scale > 1.5 ? 1 : 3;
        GAL.offsetX = 0;
        GAL.offsetY = 0;
        drawGalleryCanvas();
      }
      GAL._lastTap = now;
    }
    e.preventDefault();
  }, { passive: false });

  c.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 2) {
      // Pinch zoom
      const dist = getTouchDist(e.touches);
      if (GAL._lastTouchDist) {
        const ratio = dist / GAL._lastTouchDist;
        GAL.scale = Math.max(GAL.minScale,
                    Math.min(GAL.maxScale, GAL.scale * ratio));
        drawGalleryCanvas();
      }
      GAL._lastTouchDist = dist;
    } else if (e.touches.length === 1 && GAL._isDragging && GAL.scale > 1) {
      // Pan drag (solo cuando hay zoom)
      const dx = e.touches[0].clientX - (GAL._lastTouchX || 0);
      const dy = e.touches[0].clientY - (GAL._lastTouchY || 0);
      // Limitar el paneo para no perder la imagen de vista
      const canvas = $('galCanvas');
      const maxOff = (canvas.width * (GAL.scale - 1)) / 2;
      GAL.offsetX = Math.max(-maxOff, Math.min(maxOff, GAL.offsetX + dx));
      GAL.offsetY = Math.max(-maxOff, Math.min(maxOff, GAL.offsetY + dy));
      GAL._lastTouchX = e.touches[0].clientX;
      GAL._lastTouchY = e.touches[0].clientY;
      drawGalleryCanvas();
    }
  }, { passive: false });

  c.addEventListener('touchend', e => {
    if (e.touches.length < 2) GAL._lastTouchDist = null;
    if (e.touches.length === 0) GAL._isDragging = false;
  });
}

function getTouchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx*dx + dy*dy);
}
```

### 3.4 Validación de eventos

```javascript
function validateEvent(label) {
  const item = GAL.items[GAL.idx];
  if (!item) return;
  const { event } = item;

  event.humanLabel = label;
  event.humanTs    = Date.now();

  // Actualizar badge de validación
  renderGalleryItem(GAL.idx);

  // Guardar en dataset de entrenamiento
  saveToTrainingDataset(event, item.frameBlob, label);

  // Actualizar en S.urbanEvents
  const stored = S.urbanEvents.find(e => e.id === event.id);
  if (stored) {
    stored.humanLabel = label;
    stored.humanTs    = Date.now();
  }

  // Si es falso positivo, eliminarlo de la lista principal
  if (label === 'discarded') {
    S.urbanEvents = S.urbanEvents.filter(e => e.id !== event.id);
  }

  // Avanzar automáticamente al siguiente sin validar
  const nextUnvalidated = GAL.items.findIndex(
    (item, i) => i > GAL.idx && !item.event.humanLabel
  );
  if (nextUnvalidated !== -1) {
    setTimeout(() => galleryNav(nextUnvalidated - GAL.idx), 300);
  } else {
    toast(`✅ Sesión validada — ${GAL.items.filter(i=>i.event.humanLabel).length} eventos`);
  }

  updateLearningStats(event, label === 'discarded'
    ? 'human_discarded' : 'human_confirmed');
}

function openTypeCorrector() {
  const item = GAL.items[GAL.idx];
  if (!item) return;

  const types = [
    { key:'pothole',   label:'🕳️ Bache' },
    { key:'manhole',   label:'⭕ Tapa registro' },
    { key:'speedbump', label:'⛰️ Badén' },
    { key:'crack',     label:'〰️ Grieta' },
    { key:'degraded',  label:'🔴 Pavimento degradado' },
    { key:'patch',     label:'🔧 Parche' },
  ];
  $('typeGrid').innerHTML = types.map(t =>
    `<button class="type-btn"
       onclick="correctEventType('${t.key}')">${t.label}</button>`
  ).join('');
  $('typeCorrectorModal').classList.remove('hidden');
}

function correctEventType(type) {
  const item = GAL.items[GAL.idx];
  if (!item) return;
  item.event.type       = type;
  item.event.humanLabel = 'corrected';
  item.event.humanTs    = Date.now();
  $('typeCorrectorModal').classList.add('hidden');
  renderGalleryItem(GAL.idx);
  saveToTrainingDataset(item.event, item.frameBlob, 'corrected');
  toast(`✏️ Tipo corregido: ${type}`);
}

async function saveToTrainingDataset(event, frameBlob, humanLabel) {
  try {
    const dataset = JSON.parse(
      localStorage.getItem('rc_training_dataset') || '[]'
    );
    const entry = {
      id:          event.id,
      ts:          event.ts,
      type:        event.type,
      severity:    event.severity,
      score:       event.score,
      speed:       event.speed,
      lat:         event.lat,
      lon:         event.lon,
      features:    event.features,
      geminiResult: event.gemini || null,
      humanLabel,
      humanTs:     Date.now(),
      hasImage:    !!frameBlob
    };
    // Actualizar si ya existe, añadir si no
    const existing = dataset.findIndex(e => e.id === event.id);
    if (existing >= 0) dataset[existing] = entry;
    else dataset.push(entry);
    // Mantener últimos 1000 registros
    if (dataset.length > 1000) dataset.splice(0, dataset.length - 1000);
    localStorage.setItem('rc_training_dataset', JSON.stringify(dataset));
  } catch(e) {
    log('[Dataset] Error guardando: ' + e.message);
  }
}
```

### 3.5 Añadir elementos a la galería desde el pipeline

```javascript
// GAL.items se rellena desde processEventValidation() o registerEvent()
function addToGallery(event) {
  // Evitar duplicados
  if (GAL.items.some(i => i.event.id === event.id)) return;
  // Los frames ya están en event._frameBlobs (array de {blob,label,diff})
  GAL.items.push({ event });
}

// Mostrar la miniatura del frame nominal en pantalla de medición
function showEventThumbnail(event) {
  const thumb = $('lastEventThumb');
  if (!thumb) return;
  // Usar el frame nominal (índice 1) o el primero disponible
  const frames = event._frameBlobs || [];
  const blob   = frames[1]?.blob || frames[0]?.blob;
  if (!blob) return;

  const url = URL.createObjectURL(blob);
  thumb.src = url;
  thumb.style.display = 'block';
  const eventIdx = GAL.items.findIndex(i => i.event.id === event.id);
  thumb.onclick = () => openGallery(Math.max(0, eventIdx));
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
```

### 3.6 Acceso a la galería

```javascript
// En stopMeasurement(), tras guardar la sesión, mostrar acceso a galería:
function openEventGallery() {
  if (!GAL.items.length) {
    toast('Sin eventos con imagen en esta sesión');
    return;
  }
  // Ordenar por eventos sin validar primero
  GAL.items.sort((a, b) => {
    const aVal = a.event.humanLabel ? 1 : 0;
    const bVal = b.event.humanLabel ? 1 : 0;
    return aVal - bVal;
  });
  openGallery(0);
}
```

Añadir botón en el modal de guardar ruta:
```html
<button class="btn btn-sec" style="width:100%;margin-top:6px"
        onclick="openEventGallery()">
  📷 Validar eventos ({{N}} sin validar)
</button>
```

Actualizar el texto dinámicamente:
```javascript
// En stopMeasurement(), antes de abrir el modal de guardar:
GAL.items = []; // resetear galería al inicio de cada sesión
// (se rellena durante la sesión desde processEventValidation)
const unvalidated = GAL.items.filter(i => !i.event.humanLabel).length;
$('galOpenBtn').textContent =
  `📷 Validar eventos (${unvalidated} sin validar)`;
```

### ✅ Criterios Fase 3
- [ ] La galería se abre desde el modal de guardar sesión
- [ ] Cada evento muestra el frame nominal (B) por defecto en el canvas principal
- [ ] Las miniaturas de los 3 frames aparecen en la barra inferior
- [ ] Al pulsar una miniatura se carga ese frame en el canvas principal con badge "Frame A/B/C"
- [ ] Pinch-to-zoom funciona sobre el canvas principal
- [ ] Doble tap alterna entre zoom 1× y 3×
- [ ] Pan/drag funciona cuando hay zoom activo
- [ ] Al validar un evento avanza automáticamente al siguiente sin validar
- [ ] El badge de validación se actualiza visualmente
- [ ] Commit: `feat(gallery): galería con 3 frames por evento, miniaturas, zoom pinch y doble tap`

---

## FASE 4 — Informe específico para modo urbano

### 4.1 Lógica de selección del tipo de informe

```javascript
// En expHTML() y expXLSX(), detectar el modo activo de la sesión guardada:
function getReportMode(session) {
  const modes = session.activeModes || [];
  if (modes.includes('urban') && !modes.includes('iri')) return 'urban';
  if (modes.includes('iri')   && !modes.includes('urban')) return 'iri';
  return 'mixed';
}
```

### 4.2 Informe HTML urbano con imágenes embebidas

```javascript
async function expHTMLUrban(session) {
  const events = session.urbanEvents || [];
  if (!events.length) { toast('Sin eventos urbanos'); return; }

  // Convertir imágenes a base64 para embeber en el HTML
  const eventsWithImages = await Promise.all(events.map(async e => {
    let imgB64 = null;
    if (e._frameBlob) {
      imgB64 = await blobToBase64(e._frameBlob);
    }
    return { ...e, imgB64 };
  }));

  const sevColors = {
    leve: '#F59E0B', moderado: '#F97316', grave: '#EF4444'
  };
  const typeIcons = {
    pothole:'🕳️', manhole:'⭕', speedbump:'⛰️',
    crack:'〰️', degraded:'🔴', patch:'🔧', unknown:'❓'
  };

  // Estadísticas del informe
  const total    = events.length;
  const graves   = events.filter(e => e.severity==='grave').length;
  const moderados= events.filter(e => e.severity==='moderado').length;
  const leves    = events.filter(e => e.severity==='leve').length;
  const validated= events.filter(e => e.humanLabel).length;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Informe Urbano — Pavement Check</title>
<style>
  body { font-family: 'Segoe UI', sans-serif; margin:0; padding:16px;
         background:#f8f9fa; color:#1a1a2e; }
  h1   { font-size:1.4rem; color:#0EA5E9; margin-bottom:4px; }
  .meta{ font-size:.8rem; color:#666; margin-bottom:16px; }
  .stats { display:grid; grid-template-columns:repeat(4,1fr);
           gap:8px; margin-bottom:20px; }
  .stat  { background:#fff; border-radius:8px; padding:12px;
           text-align:center; box-shadow:0 1px 3px rgba(0,0,0,.1); }
  .stat-val  { font-size:1.8rem; font-weight:700; }
  .stat-lbl  { font-size:.72rem; color:#666; }
  .events { display:grid; gap:16px; }
  .event  { background:#fff; border-radius:10px; overflow:hidden;
            box-shadow:0 1px 4px rgba(0,0,0,.12); }
  .event-img  { width:100%; max-height:220px; object-fit:cover; }
  .event-body { padding:12px; }
  .event-header { display:flex; justify-content:space-between;
                  align-items:center; margin-bottom:6px; }
  .event-type  { font-weight:700; font-size:1rem; }
  .event-sev   { font-size:.75rem; font-weight:700; padding:3px 10px;
                 border-radius:10px; }
  .event-meta  { font-size:.72rem; color:#666; font-family:monospace;
                 margin-top:4px; }
  .event-desc  { font-size:.8rem; color:#444; margin-top:6px;
                 font-style:italic; }
  .event-val   { display:inline-block; font-size:.68rem; padding:2px 8px;
                 border-radius:8px; margin-top:4px; }
  .val-ok   { background:#d1fae5; color:#065f46; }
  .val-no   { background:#fee2e2; color:#991b1b; }
  .val-edit { background:#fef3c7; color:#92400e; }
  .no-img   { height:100px; background:#f1f5f9;
              display:flex; align-items:center; justify-content:center;
              color:#94a3b8; font-size:2rem; }
  @media print {
    .events { display:block; }
    .event  { page-break-inside:avoid; margin-bottom:16px; }
  }
</style>
</head>
<body>
<h1>📋 Informe de Patologías de Pavimento Urbano</h1>
<div class="meta">
  Fecha: ${new Date(session.ts||Date.now()).toLocaleString('es-ES')} ·
  Ruta: ${session.name||'Sin nombre'} ·
  Distancia: ${(session.dist||0).toFixed(0)} m ·
  Pavement Check v1.0
</div>

<div class="stats">
  <div class="stat">
    <div class="stat-val">${total}</div>
    <div class="stat-lbl">Total eventos</div>
  </div>
  <div class="stat">
    <div class="stat-val" style="color:#EF4444">${graves}</div>
    <div class="stat-lbl">Graves</div>
  </div>
  <div class="stat">
    <div class="stat-val" style="color:#F97316">${moderados}</div>
    <div class="stat-lbl">Moderados</div>
  </div>
  <div class="stat">
    <div class="stat-val" style="color:#10B981">${validated}</div>
    <div class="stat-lbl">Validados</div>
  </div>
</div>

<div class="events">
${eventsWithImages.map((e, i) => {
  const icon  = typeIcons[e.type]  || '❓';
  const sCol  = sevColors[e.severity] || '#666';
  const valBadge = e.humanLabel === 'confirmed'
    ? '<span class="event-val val-ok">✅ Confirmado</span>'
    : e.humanLabel === 'discarded'
    ? '<span class="event-val val-no">❌ Falso positivo</span>'
    : e.humanLabel === 'corrected'
    ? '<span class="event-val val-edit">✏️ Corregido</span>'
    : '';
  const imgHtml = e.imgB64
    ? `<img class="event-img" src="data:image/jpeg;base64,${e.imgB64}" alt="Evento ${i+1}">`
    : `<div class="no-img">📷</div>`;
  return `
  <div class="event">
    ${imgHtml}
    <div class="event-body">
      <div class="event-header">
        <span class="event-type">${icon} ${e.type||'desconocido'}</span>
        <span class="event-sev"
              style="background:${sCol}22;color:${sCol}">
          ${e.severity||'—'}
        </span>
      </div>
      <div class="event-meta">
        Score: ${e.score?.toFixed(0)||'—'} ·
        ${e.speed?.toFixed(0)||'—'} km/h ·
        ${e.lat?.toFixed(5)||'—'}, ${e.lon?.toFixed(5)||'—'}
      </div>
      ${e.gemini?.description
        ? `<div class="event-desc">"${e.gemini.description}"</div>`
        : ''}
      ${valBadge}
    </div>
  </div>`;
}).join('')}
</div>
</body>
</html>`;

  dlBlob(html, 'text/html',
    'informe_urbano_' + (session.name||'ruta').replace(/\s/g,'_') +
    '_' + new Date().toISOString().slice(0,10) + '.html');
}
```

### 4.3 En expHTML() y expXLSX(), seleccionar el informe correcto

```javascript
// Al inicio de expHTML():
const mode = getReportMode(S.lastSession || S);
if (mode === 'urban') {
  expHTMLUrban(S.lastSession || S);
  return;
}
// ... resto del código IRI existente
```

En `expXLSX()`, añadir hoja "Eventos Urbanos" cuando hay eventos:

```javascript
// Al final de expXLSX(), antes del saveAs:
if ((S.lastSession?.urbanEvents || S.urbanEvents || []).length > 0) {
  const events = S.lastSession?.urbanEvents || S.urbanEvents || [];
  const wsUrban = XLSX.utils.json_to_sheet(events.map(e => ({
    'Tipo':        e.type || '—',
    'Severidad':   e.severity || '—',
    'Score':       e.score?.toFixed(1) || '—',
    'Velocidad km/h': e.speed?.toFixed(0) || '—',
    'Latitud':     e.lat?.toFixed(6) || '—',
    'Longitud':    e.lon?.toFixed(6) || '—',
    'Timestamp':   new Date(e.ts).toLocaleString('es-ES'),
    'Gemini':      e.gemini?.description || '—',
    'Validación':  e.humanLabel || 'Sin validar',
    'Con imagen':  e._frameBlob ? 'Sí' : 'No'
  })));
  XLSX.utils.book_append_sheet(wb, wsUrban, 'Eventos Urbanos');
}
```

### ✅ Criterios Fase 4
- [ ] Al exportar desde una sesión solo-urbana: se genera informe HTML urbano
- [ ] El informe incluye imagen de cada evento (o placeholder si no hay)
- [ ] El informe incluye estadísticas (total/graves/moderados/validados)
- [ ] El XLSX incluye hoja "Eventos Urbanos" con todos los campos
- [ ] La descripción de Gemini aparece si está disponible
- [ ] Commit: `feat(report): informe HTML urbano con imágenes embebidas y XLSX mejorado`

---

## ORDEN DE EJECUCIÓN

```
Fase 1 → verificar joystick centrado en vertical → commit
Fase 2 → verificar log de sincronización → commit
Fase 3 → verificar galería con zoom en móvil → commit
Fase 4 → verificar informe HTML urbano → commit
git push → Cloudflare despliega automáticamente
```

## NOTAS PARA CLAUDE CODE

1. `blobToBase64()` y `dlBlob()` ya existen en app.js — reutilizarlas.
2. `GAL` es un objeto global nuevo — declararlo al inicio de app.js:
   ```javascript
   const GAL = {
     items: [], idx: 0, activeFrameIdx: 1,
     img: null, scale: 1, minScale: 1, maxScale: 5,
     offsetX: 0, offsetY: 0,
     _lastTouchDist: null, _lastTouchX: null, _lastTouchY: null,
     _isDragging: false, _lastTap: 0
   };
   ```
3. `GAL.items` y `GAL.activeFrameIdx` se resetean en `startMeasurement()`:
   ```javascript
   GAL.items = []; GAL.idx = 0; GAL.activeFrameIdx = 1;
   ```
4. `addToGallery(event)` se llama desde `registerEvent()` justo después
   de asignar `event._frameBlobs` en la Fase 2.
5. `showEventThumbnail(event)` se llama tras añadir a la galería,
   sin parámetro blob — usa `event._frameBlobs` internamente.
6. En `expHTMLUrban()`, para los eventos usar el frame nominal:
   ```javascript
   const blob = e._frameBlobs?.[1]?.blob || e._frameBlobs?.[0]?.blob || null;
   ```
7. `selectGalleryFrame()` y `loadFrameToCanvas()` deben ser funciones
   globales accesibles desde el onclick de las miniaturas.
8. Si `processEventValidation()` no existe (V5B-Rev2 no implementado),
   añadir la extracción de frames directamente en `registerEvent()`:
   ```javascript
   event._frameBlobs = extractFramesForEvent(event.ts, event.speed || 0);
   event._frameBlob  = event._frameBlobs[1]?.blob || event._frameBlobs[0]?.blob;
   addToGallery(event);
   if (event._frameBlob) showEventThumbnail(event);
   ```
