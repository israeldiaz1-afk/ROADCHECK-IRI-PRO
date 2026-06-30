# Especificación Técnica: Rediseño del Flujo de Validación
## Pavement Check — v5e

> **Instrucciones para Claude Code**: Lee el documento COMPLETO antes de tocar nada.
> Este spec reordena el flujo de guardado/validación y añade la capacidad de
> retomar validaciones pendientes desde el historial. Sigue las fases en orden,
> commit por fase. Al terminar: git push.

---

## NUEVO FLUJO COMPLETO

```
DETENER MEDICIÓN
       ↓
Análisis automático de ruido (sin preguntar)
→ markNoiseCandidates() se ejecuta solo
→ Marca candidatos en S.urbanEvents
       ↓
"¿Validar ahora o más tarde?"
       ↓
   ┌───┴───┐
 AHORA   MÁS TARDE
   ↓        ↓
 Galería   Guardar directamente
 completa  con validationComplete=false
   ↓        ↓
 Guardar   (queda en historial
 con          como "pendiente")
 validation
 Complete=
 true/false
 según si
 quedó algo
 sin validar
       ↓
HISTORIAL
       ↓
Ruta con validationComplete=false
muestra botón "🔍 Continuar validación"
       ↓
Reabre galería con eventos guardados
(imágenes recuperadas de IndexedDB)
       ↓
Al validar el último evento pendiente:
validationComplete pasa a true automáticamente
       ↓
INFORME / EXCEL
       ↓
Siempre generable, pero si validationComplete=false:
→ Banner "⚠️ INFORME PRELIMINAR — N eventos sin validar"
Si validationComplete=true:
→ Informe normal, sin banner
```

---

## FASE 1 — Aplicar análisis de ruido automáticamente al detener

### 1.1 Eliminar el botón manual, ejecutar automáticamente

En `stopMeasurement()`, dentro del bloque `if(S.activeModes.has('urban'))`, añadir la llamada automática justo después de crear `urbanData = {pending:true}`:

```javascript
if(S.activeModes.has('urban')){
  urbanData = { pending: true };
  // Análisis automático de ruido — sin esperar acción del usuario
  if (S.urbanEvents.length >= 5) {
    markNoiseCandidates();
  }
  if(S.groundTruth && S.groundTruth.length > 0) showValidationResults();
}
```

### 1.2 Eliminar el botón manual del modal de guardar

En `index.html`, dentro de `#routeNameModal`, eliminar el botón:
```html
<button class="btn btn-sec" style="font-size:.62rem" onclick="markNoiseCandidates()">🧹 Analizar ruido de fondo</button>
```

Sustituir por un indicador informativo (no botón) que se actualiza vía `updateNoiseFilterUI()`:
```html
<div class="noise-filter-row" id="noiseFilterRow" style="display:none;font-size:.62rem;color:var(--dim);font-family:var(--mono);margin:4px 0">
  <span id="noiseFilterInfo"></span>
</div>
```

Actualizar `updateNoiseFilterUI()`:
```javascript
function updateNoiseFilterUI(){
  const row=$('noiseFilterRow'),info=$('noiseFilterInfo');
  if(!row||!info)return;
  const hasUrban=S.activeModes.has('urban')&&S.urbanEvents.length>0;
  row.style.display=hasUrban?'block':'none';
  if(hasUrban){
    const candidates=S.urbanEvents.filter(e=>e.noiseCandidate).length;
    info.textContent = candidates>0
      ? `🟡 ${candidates} candidato(s) a ruido marcados — revísalos en la validación`
      : `${S.urbanEvents.length} eventos · sin candidatos a ruido detectados`;
  }
}
```

### ✅ Criterios Fase 1
- [ ] Al detener una sesión con 5+ eventos, el análisis de ruido se ejecuta automáticamente sin pulsar nada
- [ ] El modal de guardar muestra cuántos candidatos a ruido hay, sin botón de acción
- [ ] Commit: `feat(noise): análisis de ruido automático al detener sesión`

---

## FASE 2 — Estado de validación persistente en la ruta

### 2.1 Calcular y guardar `validationComplete`

En `buildUrbanDataFinal()`, añadir el cálculo:

```javascript
function buildUrbanDataFinal() {
  if (!S.activeModes.has('urban')) return null;

  const eventsClean = S.urbanEvents.map(
    ({_frameBlobs,_frameBlob,_clipBlobs,...e}) => e
  );

  if (eventsClean.length > 0) {
    mergeEventsIntoStorage(eventsClean);
  }

  const validationComplete = eventsClean.length === 0 ||
    eventsClean.every(e => !!e.humanLabel);
  const pendingCount = eventsClean.filter(e => !e.humanLabel).length;

  return {
    events: eventsClean,
    count: eventsClean.length,
    noiseApplied: S.noiseFilter?.appliedPost || false,
    noiseCandidatesMarked: S.urbanEvents.filter(e => e.noiseCandidate).length,
    validationComplete,
    pendingCount
  };
}
```

### 2.2 `confirmSave()` ya llama a `buildUrbanDataFinal()`

No necesita cambios adicionales — el flag se calcula automáticamente según cuántos eventos quedaron sin `humanLabel`.

### ✅ Criterios Fase 2
- [ ] Al guardar una ruta con todos los eventos validados: `r.urbanData.validationComplete === true`
- [ ] Al guardar sin validar nada: `r.urbanData.validationComplete === false` y `pendingCount` igual al total
- [ ] Commit: `feat(validation): flag validationComplete calculado y persistido por ruta`

---

## FASE 3 — Retomar validación desde el historial

### 3.1 Badge de pendiente en la lista de rutas

Localizar la función que renderiza el historial. Para cada ruta con `urbanData?.validationComplete === false`, añadir:

```javascript
const pendingBadge = r.urbanData && r.urbanData.validationComplete===false
  ? `<span class="route-pending-badge">⏳ ${r.urbanData.pendingCount} sin validar</span>`
  : '';
```

CSS:
```css
.route-pending-badge {
  display: inline-block;
  font-size: var(--fs-xs);
  background: rgba(245,158,11,.15);
  color: #F59E0B;
  padding: 2px 8px;
  border-radius: 8px;
  margin-left: 6px;
  font-family: var(--mono);
}
```

### 3.2 Botón "Continuar validación" en el detalle de ruta

En la pantalla de detalle de ruta, añadir condicionalmente:

```html
<button class="btn btn-sec" id="btnContinueValidation"
        style="display:none;width:100%;margin-top:6px"
        onclick="continueValidation()">
  🔍 Continuar validación
</button>
```

Mostrar/ocultar según el estado de la ruta al abrir el detalle:
```javascript
const btn = $('btnContinueValidation');
if (btn) {
  const pending = route.urbanData && route.urbanData.validationComplete===false;
  btn.style.display = pending ? 'block' : 'none';
  btn.dataset.routeId = route.id;
}
```

### 3.3 Función `continueValidation()` — recupera eventos e imágenes de IndexedDB

```javascript
async function continueValidation() {
  const routeId = $('btnContinueValidation')?.dataset.routeId;
  if (!routeId) return;

  const route = allRoutes().find(r => r.id === routeId);
  if (!route || !route.urbanData) {
    toast('Ruta no encontrada');
    return;
  }

  toast('Cargando eventos…');
  const events = route.urbanData.events || [];

  GAL.items = await Promise.all(events.map(async (event) => {
    const [blobA, blobB, blobC] = await getImageBlobs([
      event.id + '_A', event.id + '_B', event.id + '_C'
    ]);
    const frameBlobs = [];
    if (blobA) frameBlobs.push({ blob: blobA, label: 'A', diff: 0 });
    if (blobB) frameBlobs.push({ blob: blobB, label: 'B', diff: 0 });
    if (blobC) frameBlobs.push({ blob: blobC, label: 'C', diff: 0 });

    const eventWithFrames = { ...event, _frameBlobs: frameBlobs };
    return { event: eventWithFrames };
  }));

  S._continuingValidationRouteId = routeId;

  const firstPending = GAL.items.findIndex(i => !i.event.humanLabel);
  openGallery(firstPending >= 0 ? firstPending : 0);
}
```

### 3.4 Persistir cambios al cerrar la galería en modo "continuar validación"

Sustituir `closeGallery()`:

```javascript
function closeGallery(){
  $('eventGalleryModal').classList.add('hidden');
  GAL.img=null;

  if (S._continuingValidationRouteId) {
    saveValidationProgress(S._continuingValidationRouteId);
    S._continuingValidationRouteId = null;
    toast('✅ Progreso de validación guardado');
    return;
  }

  if(S.pendingRoute){
    showRouteNameModal();
  }
}

function saveValidationProgress(routeId) {
  try {
    const routes = allRoutes();
    const idx = routes.findIndex(r => r.id === routeId);
    if (idx === -1) return;

    const updatedEvents = GAL.items.map(i => {
      const { _frameBlobs, ...cleanEvent } = i.event;
      return cleanEvent;
    });

    const validationComplete = updatedEvents.every(e => !!e.humanLabel);
    const pendingCount = updatedEvents.filter(e => !e.humanLabel).length;

    routes[idx].urbanData = {
      ...routes[idx].urbanData,
      events: updatedEvents,
      validationComplete,
      pendingCount
    };

    localStorage.setItem('rc_routes', JSON.stringify(routes));
  } catch(e) {
    console.error('[saveValidationProgress]', e.message);
    toast('⚠️ Error guardando progreso');
  }
}
```

### ✅ Criterios Fase 3
- [ ] Una ruta con validación pendiente muestra el badge "⏳ N sin validar" en el historial
- [ ] El botón "🔍 Continuar validación" aparece en el detalle de esa ruta
- [ ] Al pulsarlo, la galería se abre con los eventos y SUS IMÁGENES recuperadas de IndexedDB
- [ ] Al validar eventos y cerrar la galería, los cambios se guardan en la ruta
- [ ] Cuando se valida el último evento pendiente, `validationComplete` pasa a `true`
- [ ] Commit: `feat(validation): retomar validación pendiente desde historial con imágenes de IndexedDB`

---

## FASE 4 — Informe preliminar vs final

### 4.1 Banner de informe preliminar en `expHTMLUrban()`

```javascript
const preliminaryBanner = !liveRoute.urbanData?.validationComplete
  ? `<div style="background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;
       padding:10px 14px;margin-bottom:16px;color:#92400E;font-size:.85rem">
       ⚠️ <strong>INFORME PRELIMINAR</strong> —
       ${liveRoute.urbanData?.pendingCount || 0} evento(s) sin validar.
       Este informe puede contener falsos positivos no revisados.
     </div>`
  : '';
```

Insertarlo justo después de `<h1>`:
```javascript
const html=`<!DOCTYPE html>...
<h1>📋 Informe de Patologías de Pavimento Urbano</h1>
${preliminaryBanner}
<div class="meta">...
```

### 4.2 Indicador "Sin validar" en cada tarjeta

Ya existe el badge `⏳ Sin validar` del spec v5d — verificar que sigue funcionando, sin cambios necesarios aquí.

### 4.3 Mismo aviso en la exportación Excel

```javascript
if (!liveRoute.urbanData?.validationComplete) {
  const warningRow = [{
    'AVISO': `⚠️ INFORME PRELIMINAR — ${liveRoute.urbanData?.pendingCount||0} eventos sin validar`
  }];
  const wsWarning = XLSX.utils.json_to_sheet(warningRow);
  XLSX.utils.book_append_sheet(wb, wsWarning, 'AVISO');
}
```

### ✅ Criterios Fase 4
- [ ] Un informe HTML de una ruta con validación incompleta muestra el banner amarillo
- [ ] Un informe HTML de una ruta completamente validada NO muestra banner
- [ ] El Excel incluye una hoja "AVISO" cuando la validación está incompleta
- [ ] Commit: `feat(report): banner de informe preliminar cuando validación incompleta`

---

## FASE 5 — Texto más claro en el modal de validación

```html
<div class="modal-bg hidden" id="validateNowModal">
  <div class="modal">
    <h3>📷 Eventos registrados</h3>
    <p class="sub">
      Se han registrado <span id="vnCount">0</span> eventos con imagen.
    </p>
    <p class="sub" style="font-size:.7rem;color:var(--dim)">
      Puedes validarlos ahora o guardarlos para revisar más tarde
      desde el historial. El informe estará disponible en ambos
      casos, marcado como preliminar hasta que completes la validación.
    </p>
    <div class="modal-btns" style="flex-direction:column;gap:8px">
      <button class="btn btn-pri" onclick="validateNow()">
        ✅ Validar ahora
      </button>
      <button class="btn btn-sec" onclick="validateLater()">
        🕐 Guardar y validar más tarde
      </button>
    </div>
  </div>
</div>
```

### ✅ Criterios Fase 5
- [ ] El texto deja claro que ambas opciones permiten guardar y generar informe
- [ ] Commit: `style(modal): texto más claro en validateNowModal`

---

## ORDEN DE EJECUCIÓN

```
Fase 1 → commit
Fase 2 → commit
Fase 3 → commit (la más compleja — probar a fondo)
Fase 4 → commit
Fase 5 → commit
git push
```

## PRUEBA DE ACEPTACIÓN COMPLETA

1. Sesión urbana con 6+ eventos → Detener
2. Verificar que el análisis de ruido se ejecutó solo (sin pulsar nada)
3. "Más tarde" → Guardar ruta sin validar nada
4. Ir al historial → verificar badge "⏳ N sin validar" en la tarjeta de la ruta
5. Abrir el detalle de esa ruta → pulsar "🔍 Continuar validación"
6. Verificar que la galería abre CON las imágenes (recuperadas de IndexedDB)
7. Validar solo 3 de los 6 eventos → cerrar galería con ✕
8. Volver al historial → la ruta sigue marcada como pendiente, con menos eventos sin validar
9. Generar informe HTML → debe mostrar el banner "⚠️ INFORME PRELIMINAR"
10. Volver a "Continuar validación" → validar los 3 eventos restantes
11. Cerrar galería → la ruta ya NO debe mostrar badge de pendiente
12. Generar informe de nuevo → el banner preliminar debe haber desaparecido
