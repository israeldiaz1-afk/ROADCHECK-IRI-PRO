# Roadcheck IRI — Documentación de Módulos

## Arquitectura general

PWA vanilla JS sin build step. Stack: Leaflet (mapas), Chart.js (gráficos), localStorage (persistencia).

### Ficheros principales

| Fichero | Responsabilidad |
|---|---|
| `index.html` | Shell de la app, CSS, HTML declarativo |
| `app.js` | Todo el motor (IRI + Urbano + Confort) |
| `manifest.json` | Metadatos PWA |
| `sw.js` | Service worker de caché |
| `comfort_filter_test.html` | Herramienta standalone de validación Fase 7 — filtros Wk/Wd |

---

## Módulo Urbano (Pothole Detection Engine)

### Modo de activación

El selector `#modeSwitch` llama a `setMode('iri'|'urban')`. La preferencia persiste en `localStorage('rc_mode')`.

### Pipeline de detección (modo urbano activo + calibrado)

```
onRaw(x,y,z)
  └─ feedUrbanBuffer()        — acumula S.urbanBuf (hasta 90 muestras, ~1.5s a 60Hz)
       ├─ updateNoiseBaseline() — ventana deslizante de 300 muestras (~5s) para mean/std
       └─ detectEvent()        — trigger 4-sigma con suelo absoluto de 1.2 m/s²
            └─ extractFeaturesAndScore() — ventana ±200ms alrededor del pico
                 └─ scoreAndClassify()   — score ponderado 0-100, umbrales de severidad
                      └─ registerEvent() → onUrbanEventDetected() — UI + marcador + vibración
```

### Estado global (objeto `S`)

```javascript
S.mode          // 'iri' | 'urban' | 'comfort'
S.urbanBuf      // últimas 90 muestras {t, ax, ay, az, vert}
S.urbanBufMax   // 90
S.urbanEvents   // eventos de la sesión activa
S.noiseBaseline // {mean, std, samples[300]}
S._lastEventTs  // anti-rebote: timestamp del último evento
S.groundTruth   // marcadores manuales para validación (Fase 7)
```

### Estructura de un evento

```javascript
{
  id, ts, lat, lon, speed,
  type: 'pothole'|'manhole'|'speedbump'|'crack'|'unknown',
  severity: 'leve'|'moderado'|'grave',
  score,          // 0-100
  features: { peakAmp, jerkMax, duration, bipolarity, freqEnergy, brakeCorrelation },
  confirmed,      // true si confirmCount >= 2
  confirmCount
}
```

### Persistencia

- `rc_mode` — preferencia de modo
- `rc_urban_events` — eventos confirmados (agrupados por `mergeEventsIntoStorage`, radio 4 m)

---

## Parámetros ajustables (requieren validación en campo)

Todos en `app.js`. Valores de punto de partida de ingeniería:

| Constante/variable | Ubicación | Valor inicial | Descripción |
|---|---|---|---|
| `4` (sigma trigger) | `detectEvent()` | 4 | Umbral en σ para disparar evento |
| `1.2` (suelo abs.) | `detectEvent()` | 1.2 m/s² | Mínimo absoluto de amplitud |
| `300` (anti-rebote) | `detectEvent()` | 300 ms | Tiempo mínimo entre eventos |
| `URBAN_WEIGHTS.amp` | top-level | 0.30 | Peso de amplitud en score |
| `URBAN_WEIGHTS.jerk` | top-level | 0.25 | Peso de jerk |
| `URBAN_WEIGHTS.bipolarity` | top-level | 0.20 | Peso de bipolaridad |
| `URBAN_WEIGHTS.freqEnergy` | top-level | 0.15 | Peso de energía frecuencial |
| `URBAN_WEIGHTS.brakePenalty` | top-level | 0.10 | Penalización por frenado |
| `8` (ampCeiling) | `scoreAndClassify()` | 8 m/s² | Techo de normalización de amplitud |
| `40` (jerkCeiling) | `scoreAndClassify()` | 40 m/s³ | Techo de normalización de jerk |
| `25` (scoreDiscard) | `scoreAndClassify()` | 25 | Score mínimo para registrar |
| `40` (severityMod) | `scoreAndClassify()` | 40 | Umbral score → moderado |
| `65` (severityGrave) | `scoreAndClassify()` | 65 | Umbral score → grave |
| `0.6` (brakeVeto) | `scoreAndClassify()` | 0.6 | Veto por correlación de frenado |
| `25` (vRefUrban) | `normalizeByVelocity()` | 25 km/h | Velocidad de referencia urbana |
| `5` (vMinNorm) | `normalizeByVelocity()` | 5 km/h | Velocidad mínima para normalizar |
| `0.7` (speedExp) | `normalizeByVelocity()` | 0.7 | Exponente ley de potencia urbana |
| `4` (PROXIMITY_M) | `mergeEventsIntoStorage()` | 4 m | Radio de confirmación multi-pasada |
| `350 / 80` (ms) | `classifyType()` | 350 / 80 ms | Umbrales de duración para speedbump/manhole |

---

## Funciones de exportación urbana

- `exportUrbanEventsXLSX()` — hoja Eventos + hoja Resumen
- `exportUrbanEventsHTML()` — informe con mapa Leaflet y tabla
- `exportValidationDataset()` — JSON con `{urbanEvents, groundTruth, comparisonResults}`

---

## Próximos pasos de validación en campo — Módulo Urbano

1. Conducir en zona urbana conocida con baches identificados manualmente.
2. Marcar cada bache con `🏷️ Marcar bache real` en el momento del paso.
3. Al detener la sesión, revisar precisión/recall mostrados automáticamente.
4. Exportar el dataset JSON con `exportValidationDataset()`.
5. Ajustar `URBAN_WEIGHTS` y umbrales según los resultados:
   - Muchos FP → subir umbral sigma o `scoreDiscard`
   - Muchos FN → bajar umbral sigma o subir pesos de `amp`/`jerk`
   - Clasificación errónea → ajustar umbrales de duración en `classifyType()`
6. Si la energía espectral resulta insuficiente, sustituir los cruces por cero por una FFT real (p. ej. con `fft.js` ~8 KB) operando sobre `S.urbanBuf`.

---

## Módulo Confort de Marcha (ISO 2631-1)

### Modo de activación

Tercer botón `📳 Confort` en `#modeSwitch` → `setMode('comfort')`. Persiste en `localStorage('rc_mode')`.

### Pipeline de procesado (modo confort activo + calibrado)

```
onRaw(x,y,z)
  └─ onComfortSample()        — proyecta ejes, aplica filtros Wk/Wd en cascada
       ├─ trackSampleRate()    — mide fs real; reconstruye filtros si cambia >10%
       ├─ updateRunningRMSComfort() — ventana deslizante 1s por eje
       ├─ accumulateVDV()      — suma de |w|^4·dt (método de integración trapezoidal)
       └─ computeLiveComfort() — combinación vectorial con factores k → avLive
            └─ updateComfortUI() — panel, barra, VDV en tiempo real
```

### Estado global `S.comfort`

```javascript
S.comfort = {
  fsActual,               // Hz medido en tiempo real
  filtersZ/X/Y,           // funciones de cascada biquad (Wk para Z, Wd para X/Y)
  rmsWindowZ/X/Y,         // ventana deslizante 1s para RMS continuo
  avLive,                 // a_v combinada actual (m/s²)
  sumPow4Z/X/Y,           // acumuladores VDV (cuarta potencia)
  segments, pts,          // ruta activa
  _currentSegPts,         // puntos del segmento en curso
  _segDist, _segStartPow4Z // tracking de segmentación
}
```

### Estructura de un segmento de confort

```javascript
{ pts: [{lat,lon},...], avAvg, vdv, level, color }
// level: 'no_confortable'|'poco'|'moderado'|'incomodo'|'muy_incomodo'|'extremo'
```

### Persistencia

- `rc_comfort_routes` — rutas de confort guardadas (paralelo a `rc_routes`)

### Funciones de exportación

- `expComfortXLSX(id)` — hoja Datos + hoja Segmentos + hoja Resumen (con disclaimer ISO)
- `expComfortHTML(id)` — informe con mapa de calor + gráfico + disclaimer pericial

### Filtros ISO 2631-1 — parámetros y advertencia

Los parámetros en `ISO2631_PARAMS` son una **reconstrucción desde fuentes secundarias**, no una transcripción verificada del texto oficial. Ver advertencia completa en `RIDE_COMFORT_SPEC.md` Fase 0.

### Validación de Fase 7 — Resultado del barrido de frecuencias

**Herramienta:** `comfort_filter_test.html` (standalone, ejecutar en navegador local)

**Cascada Wk (validada con fs=60Hz):** HP(0.4Hz, Q=0.71) × HP(4Hz, Q=0.85) × LP(28.5Hz, Q=0.71) × LP(12.5Hz, Q=0.63)

**Resultado observado con fs=60Hz:**
- **Wk:** pico en 6.3 Hz (−0.18 dB), zona plana de −1.6 dB a −0.7 dB entre 4-8 Hz, caída pronunciada por debajo de 2 Hz (−12 dB a 2 Hz, −35 dB a 0.5 Hz) y caída progresiva por encima de 8 Hz (−8 dB a 16 Hz). Forma consistente con la sensibilidad vertical máxima de ISO 2631-1 en la banda 4-8 Hz.
- **Wd:** pico en 1 Hz (−0.86 dB), dentro del rango esperado 0.5-2 Hz. Curva monotonamente decreciente a frecuencias superiores.
- **Conclusión:** Wk ✓ pico verificado en 4-8 Hz. Wd ✓ pico verificado en 0.5-2 Hz. Los valores absolutos de ganancia deben compararse contra la curva oficial de la norma si se dispone de ella antes de uso pericial.

**Nota de implementación:** la cascada original con `stepSection` (LP-boost en 2.37 Hz) producía pico en 1 Hz (incorrecto). Se reemplazó por HP(4Hz, Q=0.85) que desplaza el pico a la banda 4-8 Hz. El clamp `f2safe=min(100Hz, 0.95·fs/2)` evita la inestabilidad de polos cuando fs≤200 Hz (bug original: prewarp negativo → polos fuera del círculo unitario → NaN).

**Disclaimer metodológico pericial (incluir literal en todos los informes):**

> *"El valor de confort de marcha mostrado es una estimación obtenida mediante acelerómetro de smartphone, aplicando las curvas de ponderación en frecuencia definidas en la norma ISO 2631-1:1997, calculadas mediante reconstrucción digital de los filtros normativos (ver metodología). No constituye una medición con instrumento certificado conforme a ISO 8041. El valor debe interpretarse como indicador orientativo de ingeniería de campo, no como medición acreditada de laboratorio."*
