# Especificación Técnica: Paquete de Mejoras v4
## Pavement Check — Correcciones + GPS Preciso + Cámara + UX

> **Instrucciones para Claude Code**: Sigue las fases en orden estricto, commit al finalizar cada una. No modifiques la lógica de cálculo de IRI, Urbano ni Confort salvo donde se indique explícitamente. Haz git push al finalizar todas las fases.

---

## FASE 1 — Correcciones críticas pendientes

### 1.1 Confort: umbral de redondeo a cero

En `computeLiveComfort()`, tras calcular `av`:

```javascript
// Umbral de redondeo: valores < 0.05 m/s² se muestran como 0.000
// (ruido residual del filtro con móvil en reposo)
S.comfort.avLive = av < 0.05 ? 0 : av;
```

En `COMFORT_SCALE`, el nivel "none" ya existe — verificar que su umbral es `0.05`:
```javascript
{ max: 0.05, level: 'none', label: 'Sin vibración perceptible', color: '#3A5F7A' },
```

### 1.2 Panel de confort en modo Confort solo (pantalla de medición)

Cuando solo está activo el modo Confort (sin IRI ni Urbano), la pantalla de medición no muestra ningún valor de `a_v`. Añadir panel dedicado:

```html
<!-- En #meas-sc, visible solo cuando Confort está activo -->
<div class="meas-comfort-solo hidden" id="measComfortSolo">
  <div class="mcs-val" id="mcsAv">0.000</div>
  <div class="mcs-unit">m/s² · a<sub>v</sub></div>
  <div class="mcs-level" id="mcsLevel">Sin vibración perceptible</div>
</div>
```

```css
.meas-comfort-solo {
  display: flex; flex-direction: column; align-items: center;
  padding: 10px; background: var(--s2);
  border-radius: var(--r8); margin: 6px 8px; flex-shrink: 0;
}
.mcs-val {
  font-size: var(--fs-xxl); font-weight: 700;
  font-family: var(--mono); color: var(--sky);
}
.mcs-unit { font-size: var(--fs-xs); color: var(--dim); margin-top: 2px; }
.mcs-level { font-size: var(--fs-sm); font-weight: 700; margin-top: 4px; }
```

En `updateComfortUI()`, añadir al final:
```javascript
// Panel solo-confort en medición
const soloPanel = $('measComfortSolo');
if (soloPanel) {
  const soloOnly = S.activeModes.has('comfort') &&
    !S.activeModes.has('iri') && !S.activeModes.has('urban');
  soloPanel.classList.toggle('hidden', !S.active || !soloOnly);
  set('mcsAv', av.toFixed(3));
  const mcsLvl = $('mcsLevel');
  if (mcsLvl) { mcsLvl.textContent = cls.label; mcsLvl.style.color = cls.color; }
}
```

### 1.3 Marcas de eventos en gráfico EKG — corregir interferencias rosas

**Problema**: las marcas se acumulan indefinidamente en `S.chartMarks` y nunca se limpian correctamente. Cuando el buffer circular rota, los índices de las marcas antiguas apuntan a posiciones incorrectas del nuevo buffer, generando líneas en posiciones aleatorias.

**Fix en `drawEKG()`**: filtrar las marcas cuyo índice relativo al buffer actual sea válido:

```javascript
// En drawEKG(), al dibujar las marcas, calcular el índice RELATIVO al buffer actual
buf.marks.forEach(m => {
  // El índice absoluto de la marca menos el inicio del buffer circular
  const bufStart = Math.max(0, buf.totalSamples - buf.max);
  const relIdx = m.absIdx - bufStart; // índice relativo a la ventana visible
  if (relIdx < 0 || relIdx >= buf.max) return; // fuera de la ventana visible
  const px = labelW + (relIdx / buf.max) * plotW;
  // ... dibujar la marca ...
});
```

En `S.rawAxisBuf`, añadir contador de muestras totales:
```javascript
S.rawAxisBuf = { x:[], y:[], z:[], marks:[], max:120, totalSamples:0 };
```

En `pushEKG()`:
```javascript
S.rawAxisBuf.totalSamples++;
```

En `registerChartMark()` / `markEKG()`:
```javascript
// Guardar el índice ABSOLUTO de la muestra, no el relativo
S.rawAxisBuf.marks.push({
  absIdx: S.rawAxisBuf.totalSamples - 1,
  color,
  source,
  ts: Date.now()
});
// Limpiar marcas más antiguas que el buffer visible (~2s)
S.rawAxisBuf.marks = S.rawAxisBuf.marks.filter(
  m => S.rawAxisBuf.totalSamples - m.absIdx <= S.rawAxisBuf.max
);
```

### 1.4 Línea de recorrido más gruesa

En todas las instancias de `L.polyline` para el recorrido activo:
```javascript
// weight: 3 → 6 en mapMain y mapMeas
// weight: 5 → 7 en mapDetail y mapVisor
```

### ✅ Criterios de aceptación Fase 1
- [ ] Con móvil en reposo calibrado: `a_v = 0.000` y "Sin vibración perceptible"
- [ ] Modo Confort solo en medición: se ve el valor `a_v` y el nivel
- [ ] Gráfico EKG: sin marcas rosas espurias — solo aparecen marcas en el instante del evento
- [ ] Línea de recorrido visible con luz solar directa
- [ ] Commit: `fix: confort baseline, panel confort solo, EKG marcas, línea mapa`

---

## FASE 2 — Botón de centrado de mapa

### 2.1 HTML — botón flotante sobre el mapa

Añadir en la pantalla principal y en la pantalla de medición, superpuesto sobre el mapa:

```html
<!-- Pantalla principal -->
<div class="map-wrap" style="position:relative">
  <div id="mapMain"></div>
  <button class="btn-map-center" onclick="centerMapOnMe('main')" title="Centrar en mi posición">
    ⊕
  </button>
</div>

<!-- Pantalla de medición -->
<div class="m-map" style="position:relative">
  <div id="mapMeas"></div>
  <button class="btn-map-center" onclick="centerMapOnMe('meas')" title="Centrar en mi posición">
    ⊕
  </button>
</div>
```

```css
.btn-map-center {
  position: absolute;
  bottom: 12px; right: 12px;
  z-index: 1000;
  width: 44px; height: 44px;
  background: var(--s1);
  border: 2px solid rgba(14,165,233,.4);
  border-radius: 50%;
  color: var(--sky);
  font-size: 1.4rem;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 8px rgba(0,0,0,.4);
  transition: background .15s;
}
.btn-map-center:active { background: rgba(14,165,233,.2); }
```

### 2.2 Función de centrado

```javascript
function centerMapOnMe(which) {
  const map = which === 'main' ? S.mapMain : S.mapMeas;
  if (!map) return;
  if (!S.lastPos) { toast('Sin posición GPS todavía'); return; }
  map.setView([S.lastPos.lat, S.lastPos.lon], 17, { animate: true });
}
```

### ✅ Criterios de aceptación Fase 2
- [ ] El botón ⊕ es visible superpuesto sobre el mapa en ambas pantallas
- [ ] Al pulsarlo centra el mapa en la posición actual con animación suave
- [ ] El botón tiene área táctil mínima de 44×44px
- [ ] No interfiere con el zoom/pan normal del mapa (Leaflet)
- [ ] Commit: `feat: botón de centrado de mapa en posición actual`

---

## FASE 3 — GPS hiperpreciso: Kalman + snapping OSM + promedio de posiciones

### 3.1 Filtro de Kalman para posición GPS

El filtro de Kalman reduce el ruido de la señal GPS suavizando saltos puntuales manteniendo la trayectoria real. Implementación simplificada 2D (lat/lon):

```javascript
const GPS_KALMAN = {
  lat: null, lon: null,
  varLat: 1, varLon: 1,       // varianza estimada del estado
  Q: 0.00001,                  // ruido del proceso (movimiento real)
  R: 0.0001,                   // ruido de la medición (precisión GPS)
  initialized: false
};

function kalmanGPS(rawLat, rawLon, accuracy) {
  // Ajustar R dinámicamente según la precisión reportada por el GPS
  const R = Math.max(GPS_KALMAN.R, (accuracy / 111320) ** 2);

  if (!GPS_KALMAN.initialized) {
    GPS_KALMAN.lat = rawLat;
    GPS_KALMAN.lon = rawLon;
    GPS_KALMAN.varLat = R;
    GPS_KALMAN.varLon = R;
    GPS_KALMAN.initialized = true;
    return { lat: rawLat, lon: rawLon };
  }

  // Predicción (el estado se mueve con ruido Q)
  GPS_KALMAN.varLat += GPS_KALMAN.Q;
  GPS_KALMAN.varLon += GPS_KALMAN.Q;

  // Actualización (ganancia de Kalman)
  const kLat = GPS_KALMAN.varLat / (GPS_KALMAN.varLat + R);
  const kLon = GPS_KALMAN.varLon / (GPS_KALMAN.varLon + R);

  GPS_KALMAN.lat += kLat * (rawLat - GPS_KALMAN.lat);
  GPS_KALMAN.lon += kLon * (rawLon - GPS_KALMAN.lon);
  GPS_KALMAN.varLat *= (1 - kLat);
  GPS_KALMAN.varLon *= (1 - kLon);

  return { lat: GPS_KALMAN.lat, lon: GPS_KALMAN.lon };
}
```

### 3.2 Promedio de posiciones en el momento del evento

En `registerEvent()`, en vez de usar `S.lastPos` directamente (un único punto GPS), promediar las últimas 5 posiciones GPS recibidas:

```javascript
// Buffer de posiciones GPS recientes
S.gpsHistory = []; // {lat, lon, ts, accuracy} — últimas 10 posiciones

// En onGPS(), añadir al buffer:
S.gpsHistory.push({ lat, lon, ts: Date.now(), accuracy: acc });
if (S.gpsHistory.length > 10) S.gpsHistory.shift();

// En registerEvent():
function getBestPosition() {
  if (!S.gpsHistory.length) return S.lastPos;
  // Usar las últimas 5 posiciones, ponderadas por 1/accuracy²
  const recent = S.gpsHistory.slice(-5);
  let wLat=0, wLon=0, wTotal=0;
  recent.forEach(p => {
    const w = 1 / Math.max(p.accuracy, 1) ** 2;
    wLat += p.lat * w; wLon += p.lon * w; wTotal += w;
  });
  return { lat: wLat/wTotal, lon: wLon/wTotal };
}
```

### 3.3 Snapping al eje de calzada via Overpass API

Para eventos en modo Urbano, una vez registrado el punto GPS (Kalman + promedio), hacer una llamada asíncrona a la API de OpenStreetMap para anclar el punto al eje de la calzada más cercana. Esto reduce el error de posición de ~3-5m a <1m en entornos urbanos con calles bien mapeadas:

```javascript
async function snapToRoad(lat, lon) {
  // Buscar la vía más cercana en un radio de 15m
  const query = `
    [out:json][timeout:5];
    way(around:15,${lat},${lon})["highway"];
    out geom;
  `;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query)
    });
    const data = await res.json();
    if (!data.elements?.length) return { lat, lon }; // sin vía cercana, mantener original

    // Encontrar el punto más cercano en la geometría de la vía
    let bestLat=lat, bestLon=lon, bestDist=Infinity;
    data.elements.forEach(way => {
      const geom = way.geometry || [];
      for (let i=0; i<geom.length-1; i++) {
        const proj = projectPointOnSegment(
          lat, lon,
          geom[i].lat, geom[i].lon,
          geom[i+1].lat, geom[i+1].lon
        );
        const d = geo(lat, lon, proj.lat, proj.lon);
        if (d < bestDist) { bestDist=d; bestLat=proj.lat; bestLon=proj.lon; }
      }
    });
    return bestDist < 15 ? { lat:bestLat, lon:bestLon, snapped:true, snapDist:bestDist } : { lat, lon };
  } catch { return { lat, lon }; } // silencioso si no hay red
}

function projectPointOnSegment(pLat,pLon,aLat,aLon,bLat,bLon) {
  // Proyección del punto P sobre el segmento AB en coordenadas planas locales
  const dLat=bLat-aLat, dLon=bLon-aLon;
  const t=Math.max(0,Math.min(1,((pLat-aLat)*dLat+(pLon-aLon)*dLon)/(dLat*dLat+dLon*dLon||1)));
  return { lat:aLat+t*dLat, lon:aLon+t*dLon };
}
```

Integrar en `registerEvent()`:
```javascript
// Registro inmediato con posición Kalman+promedio
const pos = getBestPosition();
event.lat = pos.lat; event.lon = pos.lon;
S.urbanEvents.push(event);

// Snapping asíncrono — no bloquea el registro
snapToRoad(pos.lat, pos.lon).then(snapped => {
  if (snapped.snapped) {
    event.lat = snapped.lat; event.lon = snapped.lon;
    event.snapDist = snapped.snapDist;
    log(`[GPS] Snapping: ${snapped.snapDist.toFixed(1)}m → calzada`);
  }
});
```

### 3.4 Integración de Kalman en onGPS()

```javascript
function onGPS(pos) {
  const { latitude:rawLat, longitude:rawLon, speed:spd, accuracy:acc } = pos.coords;
  // Aplicar filtro de Kalman antes de usar la posición
  const filtered = kalmanGPS(rawLat, rawLon, acc);
  const lat = filtered.lat, lon = filtered.lon;
  // ... resto de onGPS() usando lat/lon filtrados ...
}
```

### ✅ Criterios de aceptación Fase 3
- [ ] `kalmanGPS()` produce posiciones más suaves que el GPS crudo (verificable en log: lat/lon filtrado vs raw)
- [ ] `getBestPosition()` devuelve un promedio ponderado de las últimas 5 posiciones
- [ ] `snapToRoad()` funciona en entorno urbano (verificar en log: "Snapping: X.Xm → calzada")
- [ ] Si Overpass no responde, el evento se registra con la posición Kalman sin bloquear
- [ ] Commit: `feat: GPS hiperpreciso con filtro Kalman, promedio ponderado y snapping OSM`

---

## FASE 4 — Selector de cámara y visor de fotos ampliables

### 4.1 Selector de fuente de cámara

Al iniciar sesión en modo Urbano (o Confort), mostrar un selector compacto antes de iniciar el buffer de vídeo:

```javascript
async function initCameraSelector() {
  // Enumerar dispositivos de vídeo disponibles
  try {
    // Primero pedir permiso genérico para que el navegador revele los deviceIds
    await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then(s => s.getTracks().forEach(t => t.stop())); // pedir y soltar inmediatamente

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');

    if (videoDevices.length <= 1) {
      // Solo hay una cámara — usarla directamente sin mostrar selector
      S.selectedCameraId = videoDevices[0]?.deviceId || null;
      startVideoBuffer();
      return;
    }

    // Hay más de una cámara (ej. integrada + USB externa) — mostrar selector
    showCameraSelector(videoDevices);
  } catch(e) {
    log('[Cámara] No disponible: ' + e.message);
  }
}

function showCameraSelector(devices) {
  $('cameraSelectorModal').classList.remove('hidden');
  $('cameraDeviceList').innerHTML = devices.map((d, i) => `
    <label class="cam-opt">
      <input type="radio" name="camDev" value="${d.deviceId}"
        ${i===0?'checked':''}>
      <span>${d.label || 'Cámara ' + (i+1)}</span>
    </label>
  `).join('');
}

function confirmCameraSelection() {
  const sel = document.querySelector('input[name="camDev"]:checked');
  S.selectedCameraId = sel?.value || null;
  $('cameraSelectorModal').classList.add('hidden');
  startVideoBuffer();
}
```

```html
<div class="modal hidden" id="cameraSelectorModal">
  <div class="modal-box">
    <h3>📷 Seleccionar cámara</h3>
    <p style="font-size:var(--fs-xs);color:var(--dim);margin-bottom:8px">
      Se detectaron varias cámaras. Selecciona cuál usar para capturar eventos.
    </p>
    <div id="cameraDeviceList"></div>
    <div class="modal-acts" style="margin-top:10px">
      <button onclick="confirmCameraSelection()">Usar esta cámara</button>
      <button class="btn-sec" onclick="skipCamera()">Sin cámara</button>
    </div>
  </div>
</div>
```

### 4.2 Actualizar `startVideoBuffer()` para usar el deviceId seleccionado

```javascript
async function startVideoBuffer() {
  const constraints = {
    video: S.selectedCameraId
      ? { deviceId: { exact: S.selectedCameraId }, width:{ideal:640}, height:{ideal:480} }
      : { facingMode: 'environment', width:{ideal:640}, height:{ideal:480} },
    audio: false
  };
  // ... resto igual que antes ...
}
```

### 4.3 Visor de fotos ampliables durante la sesión

Cuando Gemini analiza un evento y confirma un desperfecto, mostrar la miniatura en el panel de medición con posibilidad de ampliar a pantalla completa:

```html
<!-- Lightbox para ampliar fotos durante sesión -->
<div class="photo-lightbox hidden" id="photoLightbox" onclick="closeLightbox()">
  <img id="lightboxImg" alt="Evento detectado">
  <div class="lightbox-info" id="lightboxInfo"></div>
  <button class="lightbox-close" onclick="closeLightbox()">✕</button>
</div>
```

```css
.photo-lightbox {
  position: fixed; inset: 0; z-index: 9000;
  background: rgba(0,0,0,.92);
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  padding: 20px;
}
.photo-lightbox img {
  max-width: 100%; max-height: 75vh;
  border-radius: 8px; object-fit: contain;
}
.lightbox-info {
  color: var(--txt); font-family: var(--mono);
  font-size: var(--fs-sm); margin-top: 10px;
  text-align: center;
}
.lightbox-close {
  position: absolute; top: 16px; right: 16px;
  background: rgba(255,255,255,.1); border: none;
  color: #fff; font-size: 1.4rem; width: 44px; height: 44px;
  border-radius: 50%; cursor: pointer;
}
```

```javascript
function showEventThumbnail(event, blob) {
  const url = URL.createObjectURL(blob);
  const thumb = $('lastEventThumb');
  if (thumb) {
    thumb.src = url;
    thumb.style.display = 'block';
    thumb.onclick = () => openLightbox(url, event);
    setTimeout(() => URL.revokeObjectURL(url), 60000); // liberar tras 1 min
  }
}

function openLightbox(url, event) {
  $('lightboxImg').src = url;
  const info = event.geminiDescription
    ? `🔍 ${event.geminiDescription} · ${event.type} · ${event.severity}`
    : `${event.type} · ${event.severity} · score ${event.score?.toFixed(0)||'—'}`;
  set('lightboxInfo', info);
  $('photoLightbox').classList.remove('hidden');
}

function closeLightbox() {
  $('photoLightbox').classList.add('hidden');
  $('lightboxImg').src = '';
}
```

### ✅ Criterios de aceptación Fase 4
- [ ] Con solo la cámara integrada: no aparece el selector, se usa directamente
- [ ] Con cámara USB externa conectada: aparece el selector con ambas opciones
- [ ] La miniatura de la foto aparece en el panel de medición tras análisis Gemini
- [ ] Tocar la miniatura abre el lightbox a pantalla completa
- [ ] El lightbox muestra la descripción de Gemini si está disponible
- [ ] Commit: `feat: selector de cámara multi-dispositivo y visor de fotos ampliables`

---

## RESUMEN DE ARCHIVOS A MODIFICAR

| Archivo | Cambios |
|---|---|
| `app.js` | Fases 1-4: confort baseline, EKG marcas, Kalman GPS, snapping OSM, selector cámara, lightbox |
| `index.html` | Fases 1-4: panel confort solo, botón centrado mapa, modal selector cámara, lightbox |

## ORDEN DE EJECUCIÓN

1. Fase 1 → commit → verificar en móvil confort=0 y EKG sin interferencias
2. Fase 2 → commit → verificar botón centrado en ambas pantallas
3. Fase 3 → commit → verificar en log que Kalman y snapping funcionan
4. Fase 4 → commit → verificar selector cámara y lightbox
5. `git push` → Cloudflare despliega automáticamente

## NOTAS PARA CLAUDE CODE

- El snapping a Overpass es ASÍNCRONO y nunca debe bloquear el registro del evento
- Si Overpass devuelve error o timeout, el evento se mantiene con posición Kalman sin ningún mensaje de error al usuario
- El selector de cámara solo aparece si hay MÁS de un dispositivo de vídeo — con una sola cámara es transparente
- `closeLightbox()` debe ser accesible globalmente (window.closeLightbox) para el onclick del overlay
