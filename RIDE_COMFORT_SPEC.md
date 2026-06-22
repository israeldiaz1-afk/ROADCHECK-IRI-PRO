# Especificación Técnica: Módulo de Confort de Marcha (ISO 2631-1)
## Pavement Check — Modo "Confort de Marcha"

> **Instrucciones para Claude Code**: Tercer modo de la app, junto a `iri` y `urban` ya existentes. Sigue las fases en orden, cada una con commit al finalizar. Reutiliza toda la infraestructura existente (acelerómetro, calibración, GPS, mapas, exportaciones) — no la dupliques. **Fase 7 es obligatoria antes de considerar el módulo listo para uso pericial** — no es opcional ni puede saltarse, es la validación de que el filtro implementado realmente reproduce la curva de la norma.

---

## 0. ADVERTENCIA METODOLÓGICA — leer antes de implementar

Este módulo estima la percepción de confort vibracional según las curvas de ponderación de la norma ISO 2631-1, usando el acelerómetro de un smartphone. Esto **no es una medición con instrumento certificado** (la norma ISO 8041 exige acelerómetros calibrados con trazabilidad y montaje normalizado). El resultado es una **estimación de ingeniería de campo**, igual que el IRI ya calculado en la app.

**Este texto debe incluirse literalmente en cualquier exportación/informe generado por este módulo** (ver Fase 6):

> *"El valor de confort de marcha mostrado es una estimación obtenida mediante acelerómetro de smartphone, aplicando las curvas de ponderación en frecuencia definidas en la norma ISO 2631-1:1997, calculadas mediante reconstrucción digital de los filtros normativos (ver metodología). No constituye una medición con instrumento certificado conforme a ISO 8041. El valor debe interpretarse como indicador orientativo de ingeniería de campo, no como medición acreditada de laboratorio."*

---

## 1. FUNDAMENTO TÉCNICO (para que Claude Code entienda el porqué, no solo el qué)

El cuerpo humano no percibe igual todas las frecuencias de vibración. La norma define dos curvas de ponderación:

- **`Wk`** (eje vertical Z): máxima sensibilidad entre 4-8 Hz
- **`Wd`** (ejes horizontales X, Y): máxima sensibilidad entre 1-2 Hz

Cada curva se construye como una cascada de secciones de 2º orden:
1. Filtro de banda (pasa-altos + pasa-bajos) — limita el rango de análisis
2. Filtro de transición aceleración-velocidad — dobla la pendiente a partir de cierta frecuencia
3. Solo en `Wk`: un "escalón ascendente" adicional entre 2-3.5 Hz que reproduce el pico de sensibilidad vertical

> ⚠️ **Nota de transparencia importante**: los valores de frecuencia de corte y factor Q de cada sección que se dan en la Fase 2.2 son una reconstrucción a partir de fuentes secundarias ampliamente citadas en literatura técnica e implementaciones de referencia — **no una transcripción verificada letra por letra del texto oficial de la norma**. Por eso la Fase 7 (validación de la curva de respuesta) es obligatoria, no opcional: ahí se comprueba que el filtro resultante reproduce la forma característica publicada de `Wk`/`Wd` antes de dar el módulo por válido para uso pericial. Si el usuario dispone de una copia oficial de ISO 2631-1:1997 Anexo A, los valores deben contrastarse contra ella.

---

## FASE 1 — Estructura de datos y tercer modo

### 1.1 Extender el selector de modo existente

El proyecto ya tiene `S.mode = 'iri' | 'urban'`. Añadir tercera opción:

```javascript
S.mode = 'iri'; // 'iri' | 'urban' | 'comfort'
```

UI: extender el `mode-switch` ya existente (Fase 1 del módulo urbano) a 3 botones:

```html
<div class="mode-switch" id="modeSwitch">
  <button class="mode-btn active" data-mode="iri" onclick="setMode('iri')">🛣️ Carretera</button>
  <button class="mode-btn" data-mode="urban" onclick="setMode('urban')">🕳️ Urbano</button>
  <button class="mode-btn" data-mode="comfort" onclick="setMode('comfort')">📳 Confort</button>
</div>
```

> Si 3 botones no caben bien en una fila en móviles estrechos, usar scroll horizontal o reducir el texto a iconos + tooltip — decisión de Claude Code, manteniendo el estilo visual ya establecido.

### 1.2 Estado global para confort

```javascript
S.comfort = {
  vehicleProfile: 'turismo',     // único perfil en V1; arquitectura preparada para 'autobus','vmp' después
  fsActual: 60,                  // Hz real medido en tiempo de ejecución (ver Fase 2.3)
  filtersZ: null, filtersX: null, filtersY: null, // instancias de filtro biquad en cascada
  rmsWindowZ: [], rmsWindowX: [], rmsWindowY: [], // ventana deslizante 1s para RMS continuo
  avLive: 0,                      // a_v actual (m/s²), para el indicador en tiempo real
  // Acumuladores de sesión
  sumPow4Z: 0, sumPow4X: 0, sumPow4Y: 0, sumDt: 0, // para VDV (ver Fase 3.3)
  sumSqZ: 0, sumSqX: 0, sumSqY: 0, sumN: 0,         // para RMS de sesión completa
  segments: [] // confort por segmento de ruta, mismo segLen que IRI/urbano
};
```

### 1.3 Estructura de un segmento de confort (reutiliza patrón de `segmentize()` existente)

```javascript
{
  pts: [...],          // mismo formato de puntos GPS que ya usas
  avAvg: number,       // a_v medio del segmento (m/s²)
  vdv: number,         // VDV del segmento
  level: string,       // 'no_confortable'|'poco'|'moderado'|'incomodo'|'muy_incomodo'|'extremo'
  color: string
}
```

### ✅ Criterios de aceptación Fase 1
- [ ] Tercer botón de modo visible y funcional, sin romper los otros dos
- [ ] `S.comfort` inicializado correctamente al cambiar a modo confort
- [ ] Commit: `feat(comfort): estructura de datos y tercer modo (Confort de Marcha)`

---

## FASE 2 — Filtros de ponderación digital Wk/Wd

### 2.1 Transformada bilineal — fórmula general (esto sí es DSP estándar, sin incertidumbre)

Para una sección analógica de 2º orden con función de transferencia:

```
H(s) = (b2·s² + b1·s + b0) / (a2·s² + a1·s + a0)
```

La transformada bilineal con pre-distorsión de frecuencia (frequency pre-warping) a frecuencia de muestreo `fs`:

```javascript
function bilinearTransform(b2, b1, b0, a2, a1, a0, fs) {
  const T = 1 / fs;
  const c = 2 / T; // constante de la transformada bilineal

  // Coeficientes del filtro digital resultante (biquad estándar forma directa II)
  const a0d = a2*c*c + a1*c + a0;
  const b0d = (b2*c*c + b1*c + b0) / a0d;
  const b1d = (2*b0 - 2*b2*c*c) / a0d;
  const b2d = (b2*c*c - b1*c + b0) / a0d;
  const a1d = (2*a0 - 2*a2*c*c) / a0d;
  const a2d = (a2*c*c - a1*c + a0) / a0d;

  return { b0: b0d, b1: b1d, b2: b2d, a1: a1d, a2: a2d }; // a0 normalizado a 1
}

// Aplicación del biquad, forma directa II transpuesta (estándar, numéricamente estable)
function makeBiquad(coeffs) {
  let z1 = 0, z2 = 0;
  return function process(x) {
    const y = coeffs.b0*x + z1;
    z1 = coeffs.b1*x - coeffs.a1*y + z2;
    z2 = coeffs.b2*x - coeffs.a2*y;
    return y;
  };
}
```

### 2.2 Parámetros de las secciones (con pre-distorsión de frecuencia angular)

```javascript
// ⚠️ Ver advertencia de Fase 1 sobre el origen de estos valores nominales.
// Validar la forma de la curva resultante en Fase 7 antes de uso pericial.

const ISO2631_PARAMS = {
  bandLimit: { f1: 0.4, f2: 100, Q: 0.71 },         // común a Wk y Wd
  transition_Wk: { f: 12.5, Q: 0.63 },
  transition_Wd: { f: 2.0, Q: 0.63 },
  step_Wk: {
    f5: 2.37, Q5: 0.91,
    f6: 3.35, Q6: 0.91
  }
};

function prewarp(fHz, fs) {
  return (2 * fs) * Math.tan(Math.PI * fHz / fs); // ω pre-distorsionada
}

// Construcción de cada sección como par (numerador, denominador) en s, ANTES de bilinear:

function highPassSection(fHz, Q, fs) {
  const w = prewarp(fHz, fs);
  // H(s) = s² / (s² + (w/Q)s + w²)
  return bilinearTransform(1, 0, 0, 1, w/Q, w*w, fs);
}
function lowPassSection(fHz, Q, fs) {
  const w = prewarp(fHz, fs);
  // H(s) = w² / (s² + (w/Q)s + w²)
  return bilinearTransform(0, 0, w*w, 1, w/Q, w*w, fs);
}
function transitionSection(fHz, Q, fs) {
  const w = prewarp(fHz, fs);
  // H(s) = w² / (s² + (w/Q)s + w²)  [misma forma que low-pass, distinta f de aplicación conceptual]
  return bilinearTransform(0, 0, w*w, 1, w/Q, w*w, fs);
}
function stepSection(f5, Q5, f6, Q6, fs) {
  // Sección compuesta del escalón ascendente de Wk — cascada de dos resonadores
  const w5 = prewarp(f5, fs), w6 = prewarp(f6, fs);
  const sec1 = bilinearTransform(0, 0, w6*w6, 1, w5/Q5, w5*w5, fs); // forma aproximada del escalón
  const sec2 = bilinearTransform(1, w6/Q6, w6*w6, 1, w6/Q6, w6*w6, fs);
  return [sec1, sec2]; // cascada de 2 biquads
}
```

### 2.3 Medición de frecuencia de muestreo real en tiempo de ejecución

**Crítico**: el filtro digital depende de `fs`. El acelerómetro del móvil no garantiza una tasa fija (especialmente en `devicemotion` fallback, o si el SO limita por ahorro de batería). Hay que medirla y reconstruir el filtro si cambia significativamente:

```javascript
S.comfort._dtBuffer = [];

function trackSampleRate(timestamp) {
  if (S.comfort._lastTs) {
    const dt = timestamp - S.comfort._lastTs;
    if (dt > 0 && dt < 100) { // descartar saltos anómalos
      S.comfort._dtBuffer.push(dt);
      if (S.comfort._dtBuffer.length > 120) S.comfort._dtBuffer.shift(); // ~2s de historial
    }
  }
  S.comfort._lastTs = timestamp;

  if (S.comfort._dtBuffer.length >= 60) {
    const avgDt = S.comfort._dtBuffer.reduce((a,b)=>a+b,0) / S.comfort._dtBuffer.length;
    const measuredFs = 1000 / avgDt;
    // Reconstruir filtros solo si la fs medida difiere >10% de la usada actualmente
    if (Math.abs(measuredFs - S.comfort.fsActual) / S.comfort.fsActual > 0.10) {
      S.comfort.fsActual = measuredFs;
      rebuildComfortFilters(measuredFs);
    }
  }
}
```

### 2.4 Construcción de las cascadas completas Wk y Wd

```javascript
function buildWkCascade(fs) {
  const hp = highPassSection(ISO2631_PARAMS.bandLimit.f1, ISO2631_PARAMS.bandLimit.Q, fs);
  const lp = lowPassSection(ISO2631_PARAMS.bandLimit.f2, ISO2631_PARAMS.bandLimit.Q, fs);
  const trans = transitionSection(ISO2631_PARAMS.transition_Wk.f, ISO2631_PARAMS.transition_Wk.Q, fs);
  const step = stepSection(ISO2631_PARAMS.step_Wk.f5, ISO2631_PARAMS.step_Wk.Q5,
                            ISO2631_PARAMS.step_Wk.f6, ISO2631_PARAMS.step_Wk.Q6, fs);
  const stages = [makeBiquad(hp), makeBiquad(lp), makeBiquad(trans), makeBiquad(step[0]), makeBiquad(step[1])];
  return function(x) { return stages.reduce((v, stage) => stage(v), x); };
}

function buildWdCascade(fs) {
  const hp = highPassSection(ISO2631_PARAMS.bandLimit.f1, ISO2631_PARAMS.bandLimit.Q, fs);
  const lp = lowPassSection(ISO2631_PARAMS.bandLimit.f2, ISO2631_PARAMS.bandLimit.Q, fs);
  const trans = transitionSection(ISO2631_PARAMS.transition_Wd.f, ISO2631_PARAMS.transition_Wd.Q, fs);
  const stages = [makeBiquad(hp), makeBiquad(lp), makeBiquad(trans)];
  return function(x) { return stages.reduce((v, stage) => stage(v), x); };
}

function rebuildComfortFilters(fs) {
  S.comfort.filtersZ = buildWkCascade(fs); // eje vertical
  S.comfort.filtersX = buildWdCascade(fs); // eje horizontal X
  S.comfort.filtersY = buildWdCascade(fs); // eje horizontal Y
}
```

### ✅ Criterios de aceptación Fase 2
- [ ] `rebuildComfortFilters()` se ejecuta sin errores ni `NaN` en los coeficientes
- [ ] Al alimentar el filtro con una señal senoidal sintética de 5Hz (frecuencia de máxima sensibilidad de `Wk`), la salida amplifica respecto a una senoidal de 0.5Hz o 50Hz (verificación rápida de que el filtro tiene forma de banda, no es plano)
- [ ] `trackSampleRate()` detecta correctamente cambios de `fs` y reconstruye filtros (probar forzando un `fs` distinto manualmente)
- [ ] Commit: `feat(comfort): filtros de ponderación Wk/Wd con transformada bilineal y fs adaptativa`

---

## FASE 3 — Cálculo RMS continuo, VDV y combinación vectorial

### 3.1 Procesado por muestra

```javascript
function onComfortSample(ax, ay, az, timestamp) {
  trackSampleRate(timestamp);
  if (!S.comfort.filtersZ) rebuildComfortFilters(S.comfort.fsActual);

  // Restar gravedad ya calibrada (reutilizar S.grav, S.gravMag existentes del pipeline IRI)
  const g = S.grav;
  const vertRaw = ax*g.x + ay*g.y + az*g.z - S.gravMag; // igual que en IRI/urbano
  // Para X/Y horizontales, proyección ortogonal al eje vertical calibrado (simplificación:
  // usar componentes crudas menos su proyección sobre g — Claude Code: documentar esta
  // aproximación, la separación rigurosa de ejes tras una rotación arbitraria del móvil
  // es más compleja; para V1 es aceptable, marcar como mejora futura si se requiere precisión extrema)
  const vertX = ax - (ax*g.x)*g.x;
  const vertY = ay - (ay*g.y)*g.y;

  const wZ = S.comfort.filtersZ(vertRaw);
  const wX = S.comfort.filtersX(vertX);
  const wY = S.comfort.filtersY(vertY);

  updateRunningRMS('Z', wZ);
  updateRunningRMS('X', wX);
  updateRunningRMS('Y', wY);
  accumulateVDV(wZ, wX, wY, timestamp);

  computeLiveComfort();
}
```

### 3.2 RMS continuo (ventana deslizante 1s)

```javascript
function updateRunningRMS(axis, sample) {
  const key = 'rmsWindow' + axis;
  S.comfort[key].push(sample);
  const maxLen = Math.round(S.comfort.fsActual * 1.0); // 1 segundo
  if (S.comfort[key].length > maxLen) S.comfort[key].shift();
}

function rmsOf(arr) {
  if (!arr.length) return 0;
  return Math.sqrt(arr.reduce((s,v)=>s+v*v,0) / arr.length);
}
```

### 3.3 VDV (Vibration Dose Value) — más sensible a picos que el RMS puro

```javascript
function accumulateVDV(wZ, wX, wY, timestamp) {
  const dt = (S.comfort._lastVdvTs ? (timestamp - S.comfort._lastVdvTs) : 16.7) / 1000;
  S.comfort._lastVdvTs = timestamp;
  S.comfort.sumPow4Z += Math.pow(Math.abs(wZ), 4) * dt;
  S.comfort.sumPow4X += Math.pow(Math.abs(wX), 4) * dt;
  S.comfort.sumPow4Y += Math.pow(Math.abs(wY), 4) * dt;
}

function getVDV(axis) {
  const sum = S.comfort['sumPow4' + axis];
  return Math.pow(sum, 0.25);
}
```

> **Por qué importa el VDV aquí**: una ruta puede tener un RMS medio aceptable pero con 2-3 baches puntuales muy severos que el promedio diluye. El VDV pondera la cuarta potencia, así que los picos pesan mucho más — es el indicador recomendado por la propia norma cuando el factor de cresta de la señal es alto (justo el caso de carreteras con baches puntuales), complementando al RMS, no sustituyéndolo.

### 3.4 Combinación vectorial (factores k de la norma, posición sentada)

```javascript
const COMFORT_K_FACTORS = { kx: 1.4, ky: 1.4, kz: 1.0 }; // ⚠️ valor estándar de literatura — validar contra texto oficial si se dispone de él (ver advertencia Fase 1)

function computeLiveComfort() {
  const awZ = rmsOf(S.comfort.rmsWindowZ);
  const awX = rmsOf(S.comfort.rmsWindowX);
  const awY = rmsOf(S.comfort.rmsWindowY);

  const av = Math.sqrt(
    (COMFORT_K_FACTORS.kx**2) * awX**2 +
    (COMFORT_K_FACTORS.ky**2) * awY**2 +
    (COMFORT_K_FACTORS.kz**2) * awZ**2
  );
  S.comfort.avLive = av;
  updateComfortUI(av); // ver Fase 4
}
```

### ✅ Criterios de aceptación Fase 3
- [ ] `S.comfort.avLive` se actualiza en tiempo real sin `NaN`
- [ ] Con el móvil en reposo total (tras calibración), `avLive` debe acercarse a 0 (igual que el IRI en reposo, mismo criterio del módulo urbano)
- [ ] Con un golpe seco controlado, `avLive` sube notablemente y vuelve a bajar — confirma respuesta dinámica razonable
- [ ] VDV se acumula de forma monótona creciente durante toda la sesión (nunca decrece)
- [ ] Commit: `feat(comfort): cálculo RMS continuo, VDV y combinación vectorial ISO 2631-1`

---

## FASE 4 — Escala de percepción y UI en tiempo real

### 4.1 Tabla de clasificación (literal de la norma, según el documento de referencia del usuario)

```javascript
const COMFORT_SCALE = [
  { max: 0.315, level: 'no_confortable',   label: 'No confortable',          color: '#10B981' },
  { max: 0.5,   level: 'poco',              label: 'Un poco incómodo',        color: '#84CC16' },
  { max: 0.8,   level: 'moderado',          label: 'Moderadamente incómodo',  color: '#F59E0B' },
  { max: 1.25,  level: 'incomodo',          label: 'Incómodo',                color: '#F97316' },
  { max: 2.0,   level: 'muy_incomodo',      label: 'Muy incómodo',            color: '#EF4444' },
  { max: Infinity, level: 'extremo',        label: 'Extremadamente incómodo', color: '#991B1B' }
];

function classifyComfort(av) {
  return COMFORT_SCALE.find(s => av <= s.max);
}
```

### 4.2 Panel UI en pantalla principal (modo Confort)

Reutilizar el patrón visual ya establecido por `.iri-panel`/`.urban-panel` (mismo `--s1`, `--mono`, bordes `--ln`):

```html
<div class="comfort-panel hidden" id="comfortPanel">
  <div class="comfort-main">
    <span class="comfort-value" id="comfortAv">0.00</span>
    <span class="comfort-unit">m/s²</span>
  </div>
  <div class="comfort-level" id="comfortLevel">No confortable</div>
  <div class="comfort-bar">
    <div class="comfort-bar-fill" id="comfortBarFill"></div>
  </div>
  <div class="comfort-vdv">VDV sesión: <span id="comfortVdv">0.00</span></div>
</div>
```

`updateComfortUI(av)`:
```javascript
function updateComfortUI(av) {
  const cls = classifyComfort(av);
  set('comfortAv', av.toFixed(3));
  set('comfortLevel', cls.label);
  $('comfortLevel').style.color = cls.color;
  const pct = Math.min(100, (av / 2.5) * 100); // escala visual, techo de referencia 2.5 m/s²
  $('comfortBarFill').style.width = pct + '%';
  $('comfortBarFill').style.background = cls.color;
  const vdvZ = getVDV('Z');
  set('comfortVdv', vdvZ.toFixed(2));
}
```

### ✅ Criterios de aceptación Fase 4
- [ ] El panel cambia de color y etiqueta correctamente según los 6 niveles al simular distintas intensidades de vibración
- [ ] La barra visual se mueve de forma proporcional y suave
- [ ] Commit: `feat(comfort): UI en tiempo real con escala de percepción ISO 2631-1`

---

## FASE 5 — Registro de sesión, segmentación y mapa de calor

### 5.1 Segmentación por tramo (reutilizar `segmentize()` ya existente, adaptado)

Igual patrón que IRI/Urbano: cada `C.segLen` metros, cerrar un segmento de confort con:
- `avAvg`: RMS medio del tramo (recalculado sobre los puntos del segmento, no solo el valor "live")
- `vdv`: VDV acumulado en ese tramo específico
- `level`/`color`: según `classifyComfort()`

### 5.2 Guardado de ruta (mismo patrón que rutas IRI)

```javascript
S.comfort.pendingRoute = {
  id, date, pts, segments,
  avgAv: number,        // media de toda la sesión
  vdvSession: { z, x, y },
  vehicleProfile: 'turismo',
  fsUsed: S.comfort.fsActual // documentar qué fs se usó, relevante para trazabilidad
};
```

Persistencia: nueva clave `rc_comfort_routes` en localStorage, estructura paralela a `rc_routes`.

### 5.3 Mapa de calor en Visor Global

Añadir tercera opción al `#viewMode` (que ya tiene `iri_c`/`iri_m`/`urban_events` si la Fase 5 del módulo urbano la añadió):

```html
<option value="comfort_heatmap">Confort de Marcha</option>
```

Colorear segmentos por `level`/`color` del confort, mismo patrón visual que ya usas para IRI por tramos.

### ✅ Criterios de aceptación Fase 5
- [ ] Una sesión de confort se guarda correctamente con segmentos coloreados
- [ ] El Visor Global muestra el mapa de calor de confort sin romper las otras 2 visualizaciones existentes
- [ ] Commit: `feat(comfort): segmentación de ruta y mapa de calor en Visor Global`

---

## FASE 6 — Exportación e informes con disclaimer metodológico

### 6.1 Extender exportaciones existentes

Mismo patrón que XLSX/HTML de IRI y Urbano (`doXLSX()`, `expHTML()`), nueva función `expComfortXLSX()` / `expComfortHTML()` con:
- Hoja/sección de datos punto a punto: timestamp, lat, lon, velocidad, `a_v` instantáneo, nivel
- Hoja/sección resumen: `a_v` medio sesión, VDV por eje, perfil de vehículo, `fs` usado, fecha
- **El texto de advertencia metodológica de la Fase 0, literal, en lugar visible del informe** (no solo en una nota al pie pequeña — debe ser parte explícita del cuerpo del informe si va a usarse en peritajes)

### 6.2 Informe HTML

Reutilizar la plantilla con mapa interactivo + gráfico con zoom ya validada en el módulo IRI/Urbano, sustituyendo los datos por los de confort. Incluir mapa de calor de la ruta coloreado por nivel de confort.

### ✅ Criterios de aceptación Fase 6
- [ ] Exportación XLSX y HTML funcionan correctamente
- [ ] El texto de advertencia metodológica aparece de forma clara y completa en ambos formatos
- [ ] Commit: `feat(comfort): exportación e informes con disclaimer metodológico pericial`

---

## FASE 7 — VALIDACIÓN OBLIGATORIA: respuesta en frecuencia del filtro

> **Esta fase no es opcional.** Sin ella, el módulo no debe considerarse válido para uso pericial, independientemente de que el resto del código funcione sin errores.

### 7.1 Generar la curva de respuesta del filtro implementado

Crear una herramienta de validación (puede ser un HTML standalone, igual patrón que `pothole_test_bench.html`) que:

1. Construya los filtros `Wk` y `Wd` con `S.comfort.fsActual` típico (ej. 60Hz)
2. Inyecte señales senoidales sintéticas puras de amplitud unitaria a frecuencias barridas: 0.5, 1, 2, 3, 4, 5, 6.3, 8, 10, 12.5, 16, 20, 25, 31.5, 40, 50 Hz (frecuencias de tercio de octava estándar, igual que usa la propia norma para publicar la curva)
3. Mida la amplitud RMS de la salida filtrada para cada frecuencia tras estabilización del filtro (descartar las primeras muestras transitorias)
4. Dibuje la curva resultante (dB = 20·log10(amplitud_salida/amplitud_entrada) vs frecuencia, eje X logarítmico)

### 7.2 Comparación visual contra la norma

El usuario debe comparar la curva generada contra la curva publicada de `Wk`/`Wd` de ISO 2631-1 (ampliamente reproducida en literatura técnica — buscar "ISO 2631-1 Wk Wd frequency weighting curve" para encontrar una referencia gráfica fiable con la que contrastar).

**Lo que debe verse en `Wk`:**
- Pico de ganancia máxima entre 4-8 Hz
- Caída pronunciada por debajo de 0.5Hz y por encima de 80Hz
- Forma característica con el "hombro" del escalón ascendente sobre 2-3.5Hz

**Lo que debe verse en `Wd`:**
- Ganancia máxima en banda más amplia y baja, aproximadamente 0.5-2Hz
- Sin el escalón de `Wk`, curva más simple

### 7.3 Si la curva NO coincide razonablemente con la forma esperada

Esto significa que algún parámetro de la Fase 2.2 necesita ajuste. **No usar el módulo para informes periciales hasta que esto se resuelva.** Posibles causas a revisar:
- Error de signo o de orden en alguna sección de la cascada
- Confusión entre frecuencia de corte y frecuencia central en alguna sección
- Error en la transformada bilineal (verificar contra un caso de prueba simple conocido, ej. un filtro pasa-bajos simple de 1er orden con respuesta analítica conocida)

### ✅ Criterios de aceptación Fase 7
- [ ] La herramienta de barrido de frecuencias genera la curva sin errores
- [ ] La curva de `Wk` muestra claramente el pico 4-8Hz y la forma general esperada
- [ ] La curva de `Wd` muestra claramente el pico en banda baja 0.5-2Hz
- [ ] Documentar en `CLAUDE.md` el resultado de esta validación (capturas o descripción de la curva obtenida) como evidencia de que el filtro fue verificado antes de su uso
- [ ] Commit: `test(comfort): validación de respuesta en frecuencia de los filtros Wk/Wd`

---

## RESUMEN DE ARCHIVOS A MODIFICAR

| Archivo | Cambios |
|---|---|
| `app.js` | Motor de filtrado Wk/Wd, cálculo RMS/VDV, lógica de modo confort, exportaciones |
| `index.html` | Tercer botón de modo, panel de confort, nueva opción en selector de visor |
| Nuevo: `comfort_filter_test.html` | Herramienta de validación de la Fase 7 (igual patrón que `pothole_test_bench.html`) |

## PARÁMETROS AJUSTABLES

```javascript
const COMFORT_TUNABLE = {
  rmsWindowSeconds: 1.0,
  fsRebuildToleranceRatio: 0.10,
  comfortBarCeiling: 2.5,        // techo visual de la barra de UI, no afecta al cálculo
  // Los parámetros de filtro (ISO2631_PARAMS) y factores k (COMFORT_K_FACTORS)
  // están documentados en sus respectivas secciones y requieren la validación
  // de Fase 7 antes de cualquier ajuste — no son "tuning" libre como en el
  // módulo urbano, son reconstrucción de una norma técnica.
};
```

---

## ORDEN DE EJECUCIÓN

1. Leer este documento completo, especialmente la Fase 0 y el aviso de la Fase 1
2. Fases 1 → 6 en orden, commit tras cada una
3. **Fase 7 obligatoria** antes de dar el módulo por terminado
4. Actualizar `CLAUDE.md` con: arquitectura del módulo, resultado de la validación de Fase 7, y el texto de disclaimer metodológico para referencia rápida
