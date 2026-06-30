# Especificación Técnica: Fix Crítico — Persistencia IndexedDB + Flujo de Validación
## Pavement Check — v5d

> **Instrucciones para Claude Code**: Lee el documento COMPLETO antes de tocar nada.
> Este spec reescribe la arquitectura de almacenamiento de imágenes — es el cambio
> más importante hasta ahora. Sigue las fases EN ORDEN ESTRICTO. Cada fase depende
> de la anterior. Un commit por fase, verificación en consola antes de continuar.
> Al terminar todo: git push.

---

## CONTEXTO DEL PROBLEMA

Diagnóstico completo de 7 problemas conectados, todos con causa raíz identificada:

1. **Gemini nunca se invoca** — `analyzeEventWithGemini()` existe pero no se llama desde `registerEvent()`. Por eso tipo/severidad/confianza/descripción de Gemini siempre están vacíos.
2. **"Validados: 0" en informes** — `urbanData.events` se copia ANTES de que el usuario valide en la galería. Las validaciones humanas nunca llegan a los datos guardados.
3. **Fotos ausentes en informes desde historial** — los blobs viven solo en memoria, `localStorage` no los persiste.
4. **Discrepancia de conteo HTML vs Excel** — leen de fuentes de datos distintas (`urbanData.events` vs `localStorage('rc_urban_events')` fusionado por proximidad GPS).
5. **Checkmark de ruido fantasma** — lee de `S.noiseFilter.appliedPost` (variable global), no de la ruta específica.
6. **Falta "Leves" en el resumen del informe.**
7. **Sin visibilidad de candidatos a ruido** — el filtro de ruido eliminaba directamente sin mostrar qué se descartaba.

---

## FASE 1 — Capa de persistencia IndexedDB para imágenes

### 1.1 Wrapper de IndexedDB

Crear un módulo nuevo al inicio de `app.js`, después de la declaración de `S`:

```javascript
// ════════════════════════════════════════════════
// PERSISTENCIA DE IMÁGENES — IndexedDB
// ════════════════════════════════════════════════
const IMG_DB = {
  dbName: 'pavement_check_images',
  storeName: 'event_images',
  version: 1,
  db: null
};

function openImageDB() {
  return new Promise((resolve, reject) => {
    if (IMG_DB.db) { resolve(IMG_DB.db); return; }
    const req = indexedDB.open(IMG_DB.dbName, IMG_DB.version);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IMG_DB.storeName)) {
        db.createObjectStore(IMG_DB.storeName, { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => { IMG_DB.db = e.target.result; resolve(IMG_DB.db); };
    req.onerror = (e) => { console.error('[IMG_DB] open error', e); reject(e); };
  });
}

// Guarda un blob asociado a una clave única (eventId_frameLabel)
async function saveImageBlob(key, blob) {
  try {
    const db = await openImageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMG_DB.storeName, 'readwrite');
      tx.objectStore(IMG_DB.storeName).put({ key, blob, ts: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => { console.error('[IMG_DB] save error', e); resolve(false); };
    });
  } catch(e) { console.error('[IMG_DB] saveImageBlob', e); return false; }
}

// Recupera un blob por clave
async function getImageBlob(key) {
  try {
    const db = await openImageDB();
    return new Promise((resolve) => {
      const tx = db.transaction(IMG_DB.storeName, 'readonly');
      const req = tx.objectStore(IMG_DB.storeName).get(key);
      req.onsuccess = () => resolve(req.result?.blob || null);
      req.onerror = () => resolve(null);
    });
  } catch(e) { return null; }
}

// Recupera múltiples blobs por un array de claves (en paralelo)
async function getImageBlobs(keys) {
  const results = await Promise.all(keys.map(k => getImageBlob(k)));
  return results;
}

// Elimina blobs por claves (cuando se descarta un evento)
async function deleteImageBlobs(keys) {
  try {
    const db = await openImageDB();
    const tx = db.transaction(IMG_DB.storeName, 'readwrite');
    const store = tx.objectStore(IMG_DB.storeName);
    keys.forEach(k => store.delete(k));
    return new Promise(resolve => { tx.oncomplete = () => resolve(true); });
  } catch(e) { return false; }
}

// Limpieza de imágenes antiguas (>90 días) — llamar al cargar la app
async function pruneOldImages() {
  try {
    const db = await openImageDB();
    const cutoff = Date.now() - 90*86400000;
    const tx = db.transaction(IMG_DB.storeName, 'readwrite');
    const store = tx.objectStore(IMG_DB.storeName);
    const req = store.openCursor();
    let pruned = 0;
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.ts < cutoff) { cursor.delete(); pruned++; }
        cursor.continue();
      } else if (pruned > 0) {
        log('[IMG_DB] Limpiadas ' + pruned + ' imágenes antiguas');
      }
    };
  } catch(e) {}
}
```

Llamar a `pruneOldImages()` desde el `window.addEventListener('load', ...)` existente, sin bloquear el arranque.

### 1.2 Claves de imagen por evento

Cada evento tendrá hasta 3 frames (A, B, C). La clave en IndexedDB es:
```
{eventId}_A
{eventId}_B
{eventId}_C
```

### ✅ Criterios Fase 1
- [ ] `openImageDB()` no lanza error al cargar la app
- [ ] `saveImageBlob('test_A', new Blob(['x']))` seguido de `getImageBlob('test_A')` devuelve el blob
- [ ] Commit: `feat(storage): capa de persistencia IndexedDB para imágenes de eventos`

---

## FASE 2 — Guardar frames en IndexedDB al capturarlos

### 2.1 Modificar `registerEvent()` para persistir inmediatamente

En `registerEvent()`, sustituir el bloque de extracción de frames:

```javascript
// ANTES (extrae frames y los deja solo en memoria):
const frames = VIDEO_BUF.capturing
  ? extractFramesForEvent(event.ts, event.speed||0)
  : [];
event._frameBlobs = frames;
event._frameBlob = frames[1]?.blob || frames[0]?.blob;
addToGallery(event);
if (frames.length > 0) showEventThumbnail(event);

// AHORA (persiste en IndexedDB en paralelo, sin bloquear):
const frames = VIDEO_BUF.capturing
  ? extractFramesForEvent(event.ts, event.speed||0)
  : [];
event._frameBlobs = frames; // sigue disponible en memoria para la sesión activa
event._frameBlob = frames[1]?.blob || frames[0]?.blob;

// Persistir cada frame en IndexedDB con su label como sufijo de clave
frames.forEach(f => {
  saveImageBlob(event.id + '_' + f.label, f.blob);
});
event._hasStoredImages = frames.length > 0;

addToGallery(event);
if (frames.length > 0) showEventThumbnail(event);

// Invocar Gemini con el frame nominal (B) o el primero disponible
if (event._frameBlob) {
  analyzeEventWithGemini(event, event._frameBlob, null).then(result => {
    if (!result) return;
    event.gemini = result;
    event.geminiConfirm = !result.discard;
    queueUI('gallery_refresh', () => {
      if (GAL.items.some(i => i.event.id === event.id)) {
        renderGalleryItem(GAL.idx);
      }
    });
  });
}
```

### ✅ Criterios Fase 2
- [ ] Tras detectar un evento, log muestra que se guardan frames en IndexedDB
- [ ] `event._hasStoredImages` es `true` cuando hay al menos 1 frame
- [ ] Tras 1-3 segundos, `event.gemini` tiene datos (verificar en consola: `S.urbanEvents[0].gemini`)
- [ ] Commit: `feat(storage): persistir frames en IndexedDB al capturar, invocar Gemini`

---

## FASE 3 — Flujo de guardado: validación ANTES de construir datos finales

### 3.1 Retrasar la construcción de `urbanData` hasta después de validar

En `stopMeasurement()`, sustituir el bloque del modo urbano:

```javascript
// ANTES:
if(S.activeModes.has('urban')){
  const eventsClean = S.urbanEvents.map(
    ({_frameBlobs,_frameBlob,_clipBlobs,...e})=>e
  );
  urbanData = {events: eventsClean, count: eventsClean.length};
  if(eventsClean.length > 0) mergeEventsIntoStorage(eventsClean);
  if(S.groundTruth && S.groundTruth.length > 0) showValidationResults();
}

// AHORA — solo marcar que está pendiente, sin construir todavía:
if(S.activeModes.has('urban')){
  urbanData = { pending: true };
  if(S.groundTruth && S.groundTruth.length > 0) showValidationResults();
}
```

### 3.2 Nueva función que construye los datos finales tras validación

```javascript
function buildUrbanDataFinal() {
  if (!S.activeModes.has('urban')) return null;

  // Quitar blobs en memoria (ya están en IndexedDB) antes de serializar
  const eventsClean = S.urbanEvents.map(
    ({_frameBlobs,_frameBlob,_clipBlobs,...e}) => e
  );

  if (eventsClean.length > 0) {
    mergeEventsIntoStorage(eventsClean);
  }

  return {
    events: eventsClean,
    count: eventsClean.length,
    noiseApplied: S.noiseFilter?.appliedPost || false,
    noiseCandidatesMarked: S.urbanEvents.filter(e => e.noiseCandidate).length
  };
}
```

### 3.3 Llamar a la construcción final en `confirmSave()`

En `confirmSave()`, al inicio de la función, ANTES de `saveRoute(r)`:

```javascript
function confirmSave(){
  if(!S.pendingRoute)return;
  const r=S.pendingRoute;

  // Construir urbanData final AHORA, con todas las validaciones ya aplicadas
  if (r.urbanData?.pending) {
    r.urbanData = buildUrbanDataFinal();
  }

  r.name=$('routeNameInput').value.trim()||fmtD(Date.parse(r.date));
  saveRoute(r);
  $('routeNameModal').classList.add('hidden');

  // Mantener referencia con los _frameBlobs vivos para generar informe inmediato
  S._lastSavedRouteWithBlobs = {
    ...r,
    urbanData: {
      ...r.urbanData,
      events: S.urbanEvents.map(e => ({...e})) // copia con blobs en memoria intactos
    }
  };

  const modesUsed=r.modesUsed||['iri'];
  const parts=[];
  if(modesUsed.includes('iri')&&r.avgC!=null)parts.push('IRI '+r.avgC.toFixed(2)+' m/km');
  if(modesUsed.includes('comfort')&&r.comfortData)parts.push('a_v '+r.comfortData.avgAv.toFixed(3)+' m/s²');
  if(modesUsed.includes('urban')&&r.urbanData)parts.push(r.urbanData.events.length+' eventos');
  toast('✅ Guardado · '+(parts.join(' · ')||'OK'));
  S.pendingRoute=null;
}
```

### ✅ Criterios Fase 3
- [ ] Validar eventos en galería ANTES de guardar refleja `humanLabel` en `r.urbanData.events`
- [ ] Tras guardar, `r.urbanData.events[0].humanLabel` tiene el valor correcto (confirmed/discarded/corrected)
- [ ] Commit: `fix(flow): construir urbanData después de validación humana, no antes`

---

## FASE 4 — Informe HTML: recuperar imágenes de IndexedDB

### 4.1 Reescribir `expHTMLUrban()` para leer de IndexedDB con fallback a memoria

```javascript
async function expHTMLUrban(r){
  // Preferir la copia con blobs en memoria si es la sesión recién guardada
  const liveRoute = (S._lastSavedRouteWithBlobs?.id === r.id)
    ? S._lastSavedRouteWithBlobs : r;
  const events = liveRoute.urbanData?.events || [];
  if(!events.length){toast('Sin eventos urbanos');return;}

  const sevColors={leve:'#F59E0B',moderado:'#F97316',grave:'#EF4444'};
  const typeIcons={pothole:'🕳️',manhole:'⭕',speedbump:'⛰️',crack:'〰️',degraded:'🔴',patch:'🔧',unknown:'❓'};
  const total=events.length;
  const leves=events.filter(e=>e.severity==='leve').length;
  const graves=events.filter(e=>e.severity==='grave').length;
  const moderados=events.filter(e=>e.severity==='moderado').length;
  const validated=events.filter(e=>e.humanLabel==='confirmed').length;

  // Recuperar imágenes: primero memoria (sesión activa), luego IndexedDB (historial)
  const eventsWithImages = await Promise.all(events.map(async e => {
    let blob = e._frameBlobs?.[1]?.blob || e._frameBlobs?.[0]?.blob ||
               e._frameBlobs?.[2]?.blob || e._frameBlob || null;

    if (!blob || !(blob instanceof Blob)) {
      // Intentar recuperar de IndexedDB por las 3 claves posibles
      blob = await getImageBlob(e.id + '_B') ||
             await getImageBlob(e.id + '_A') ||
             await getImageBlob(e.id + '_C');
    }

    if (!blob || !(blob instanceof Blob)) {
      return { ...e, imgB64: null };
    }
    const imgB64 = await blobToBase64(blob);
    return { ...e, imgB64 };
  }));

  const noiseBtn = liveRoute.urbanData?.noiseApplied
    ? '<p style="color:#10B981;font-size:.8rem">✅ Ruido de fondo eliminado en esta ruta</p>'
    : '';

  const noiseCandidatesNote = liveRoute.urbanData?.noiseCandidatesMarked > 0
    ? `<p style="color:#EAB308;font-size:.75rem">🟡 ${liveRoute.urbanData.noiseCandidatesMarked} evento(s) marcado(s) como candidato a ruido en su momento</p>`
    : '';

  const rows = eventsWithImages.map((e,i) => {
    const ic=typeIcons[e.type]||'❓';
    const sc=sevColors[e.severity]||'#666';
    const vb = e.humanLabel==='confirmed'
      ? '<span class="ev val-ok">✅ Confirmado</span>'
      : e.humanLabel==='discarded'
      ? '<span class="ev val-no">❌ Falso positivo</span>'
      : e.humanLabel==='corrected'
      ? '<span class="ev val-ed">✏️ Corregido</span>'
      : '<span class="ev" style="background:#37415133;color:#9ca3af">⏳ Sin validar</span>';
    const noiseBadge = e.noiseCandidate
      ? '<span class="ev" style="background:#EAB30822;color:#92400E">🟡 Candidato a ruido</span>'
      : '';
    const geminiInfo = e.gemini?.description
      ? `<div class="cd">🔍 "${e.gemini.description}" (conf. ${((e.gemini.confidence||0)*100).toFixed(0)}%)</div>`
      : '';

    return `<div class="card">
      ${e.imgB64
        ? `<img src="data:image/jpeg;base64,${e.imgB64}">`
        : '<div class="noi">📷 Sin imagen</div>'}
      <div class="cb">
        <div class="ch">
          <span class="ct">${ic} ${e.type||'—'}</span>
          <span class="cs" style="background:${sc}22;color:${sc}">${e.severity||'—'}</span>
        </div>
        <div class="cm">Score:${e.score?.toFixed(0)||'—'} ·
          ${e.speed?.toFixed(0)||'—'}km/h ·
          ${e.lat?.toFixed(5)||'—'},${e.lon?.toFixed(5)||'—'}</div>
        ${geminiInfo}
        ${vb} ${noiseBadge}
      </div></div>`;
  }).join('');

  const html=`<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Informe Urbano — Pavement Check</title>
<style>
body{font-family:Segoe UI,sans-serif;margin:0;padding:16px;background:#f8f9fa;color:#1a1a2e}
h1{font-size:1.4rem;color:#0EA5E9;margin-bottom:4px}
.meta{font-size:.8rem;color:#666;margin-bottom:8px}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:16px}
.stat{background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.sv{font-size:1.6rem;font-weight:700}
.sl{font-size:.68rem;color:#666}
.cards{display:grid;gap:16px}
.card{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.12)}
.card img{width:100%;max-height:220px;object-fit:cover}
.noi{height:100px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:2rem}
.cb{padding:12px}
.ch{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.ct{font-weight:700;font-size:1rem}
.cs{font-size:.75rem;font-weight:700;padding:3px 10px;border-radius:10px}
.cm{font-size:.72rem;color:#666;font-family:monospace;margin-top:4px}
.cd{font-size:.78rem;color:#444;margin-top:6px;font-style:italic}
.ev{display:inline-block;font-size:.68rem;padding:2px 8px;border-radius:8px;margin-top:4px;margin-right:4px}
.val-ok{background:#d1fae5;color:#065f46}
.val-no{background:#fee2e2;color:#991b1b}
.val-ed{background:#fef3c7;color:#92400e}
</style></head><body>
<h1>📋 Informe de Patologías de Pavimento Urbano</h1>
<div class="meta">${new Date(r.date||Date.now()).toLocaleString('es-ES')} · ${r.name||'Sin nombre'} · Pavement Check</div>
${noiseBtn}
${noiseCandidatesNote}
<div class="stats">
  <div class="stat"><div class="sv">${total}</div><div class="sl">Total</div></div>
  <div class="stat"><div class="sv" style="color:#F59E0B">${leves}</div><div class="sl">Leves</div></div>
  <div class="stat"><div class="sv" style="color:#F97316">${moderados}</div><div class="sl">Moderados</div></div>
  <div class="stat"><div class="sv" style="color:#EF4444">${graves}</div><div class="sl">Graves</div></div>
  <div class="stat"><div class="sv" style="color:#10B981">${validated}</div><div class="sl">Validados</div></div>
</div>
<div class="cards">${rows}</div>
</body></html>`;

  dlBlob(html,'text/html','informe_urbano_'+(r.name||'ruta').replace(/\s/g,'_')+'_'+new Date().toISOString().slice(0,10)+'.html');
}
```

### ✅ Criterios Fase 4
- [ ] El informe generado inmediatamente tras guardar muestra fotos correctamente
- [ ] El informe generado desde el historial (sesión nueva, app recargada) también muestra fotos — recuperadas de IndexedDB
- [ ] El resumen incluye Leves/Moderados/Graves/Validados correctamente contados
- [ ] Cada evento muestra su validación humana real (✅/❌/✏️/⏳ Sin validar)
- [ ] La descripción de Gemini aparece cuando está disponible
- [ ] Commit: `fix(report): recuperar imágenes de IndexedDB, datos de validación correctos`

---

## FASE 5 — Excel: misma fuente de datos que el HTML

### 5.1 Unificar la fuente de eventos en la exportación Excel

Localizar la función de exportación Excel urbana (probablemente `exportUrbanEventsXLSX()`) y asegurarse de que lee de la MISMA fuente que el HTML — `r.urbanData.events`, no de `localStorage('rc_urban_events')` fusionado globalmente:

```javascript
// Verificar y corregir si es necesario:
function exportUrbanEventsXLSX(r){
  const liveRoute=(S._lastSavedRouteWithBlobs?.id===r.id)
    ?S._lastSavedRouteWithBlobs:r;
  const events=liveRoute.urbanData?.events||[];
  // ... resto de la función usando 'events' de esta fuente,
  // no de allRoutes() ni de localStorage global
}
```

Las columnas deben incluir explícitamente:
```javascript
'Validación': e.humanLabel || 'Sin validar',
'Tipo (Gemini)': e.gemini?.type || '—',
'Severidad (Gemini)': e.gemini?.severity || '—',
'Confianza': e.gemini?.confidence ? (e.gemini.confidence*100).toFixed(0)+'%' : '—',
'Descripción IA': e.gemini?.description || '—',
'Candidato a ruido': e.noiseCandidate ? 'Sí' : 'No',
```

### ✅ Criterios Fase 5
- [ ] El conteo de eventos en Excel coincide exactamente con el HTML
- [ ] Las columnas de Gemini están rellenas cuando hay datos
- [ ] La columna Validación refleja la validación humana real
- [ ] Commit: `fix(xlsx): misma fuente de datos que HTML, columnas Gemini rellenas`

---

## FASE 6 — Candidatos a ruido visibles (no eliminación directa)

### 6.1 Sustituir eliminación automática por marcado visible

```javascript
function markNoiseCandidates(){
  const allAmp = S.urbanEvents.map(e => e.features?.peakAmp || 0);
  if (allAmp.length < 5) {
    toast('Insuficientes eventos para analizar ruido');
    return;
  }
  const sorted = [...allAmp].sort((a,b) => a-b);
  const p15 = sorted[Math.floor(sorted.length*0.15)];
  const threshold = p15 + (S.noiseBaseline?.std || 0.1);

  let marked = 0;
  S.urbanEvents.forEach(e => {
    const amp = e.features?.peakAmp || 0;
    if (amp <= threshold && e.severity === 'leve' && !e.humanLabel) {
      e.noiseCandidate = true;
      marked++;
    }
  });

  S.noiseFilter.percentile15 = p15;
  S.noiseFilter.appliedPost = true; // marca que se ejecutó el análisis

  toast(marked > 0
    ? `🟡 ${marked} evento(s) candidato(s) a ruido — revísalos en la galería`
    : 'Sin candidatos a ruido detectados');

  queueUI('gallery_refresh', () => {
    if (GAL.idx < GAL.items.length) renderGalleryItem(GAL.idx);
  });
  updateNoiseFilterUI();
}
```

Sustituir en `index.html` la llamada del botón en `#routeNameModal`:
```html
<!-- ANTES: -->
onclick="applyPostProcessNoise();updateNoiseFilterUI()"
<!-- AHORA: -->
onclick="markNoiseCandidates()"
```

### 6.2 Badge visible en la galería

En `renderGalleryItem()`, dentro del array de `galBadges`, añadir:

```javascript
event.noiseCandidate
  ? '<span class="gal-badge" style="background:rgba(234,179,8,.2);color:#EAB308">🟡 Candidato a ruido</span>'
  : ''
```

### ✅ Criterios Fase 6
- [ ] Botón "🧹 Analizar ruido de fondo" marca eventos sin eliminarlos
- [ ] Los eventos marcados muestran badge amarillo en la galería
- [ ] El usuario puede confirmar o descartar manualmente cada candidato igual que cualquier otro evento
- [ ] Commit: `feat(noise): candidatos a ruido visibles y editables, no eliminación automática`

---

## ORDEN DE EJECUCIÓN

```
Fase 1 → verificar IndexedDB funciona → commit
Fase 2 → verificar Gemini se invoca y persiste frames → commit
Fase 3 → verificar urbanData refleja validaciones → commit
Fase 4 → verificar informe con fotos desde memoria Y desde historial → commit
Fase 5 → verificar Excel coincide con HTML → commit
Fase 6 → verificar candidatos a ruido visibles → commit
git push
```

## PRUEBA DE ACEPTACIÓN COMPLETA (hacer al final)

1. Iniciar sesión urbana nueva
2. Generar 5+ eventos
3. Detener → "Validar ahora"
4. Confirmar 3 eventos, descartar 1, corregir tipo de 1
5. Cerrar galería con "💾 Guardar ruta"
6. Ir al historial, abrir esa ruta, generar informe HTML
7. Verificar: fotos presentes, validaciones correctas, conteos correctos
8. Cerrar la app completamente (recargar página)
9. Volver al historial, abrir la MISMA ruta, generar informe de nuevo
10. Verificar: las fotos SIGUEN apareciendo (recuperadas de IndexedDB)
