# Roadcheck IRI — Documentación del Módulo Urbano

## Arquitectura general

PWA vanilla JS sin build step. Stack: Leaflet (mapas), Chart.js (gráficos), localStorage (persistencia).

### Ficheros principales

| Fichero | Responsabilidad |
|---|---|
| `index.html` | Shell de la app, CSS, HTML declarativo |
| `app.js` | Todo el motor (IRI + Urbano) |
| `manifest.json` | Metadatos PWA |
| `sw.js` | Service worker de caché |

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
S.mode          // 'iri' | 'urban'
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

## Próximos pasos de validación en campo (Fase 7)

1. Conducir en zona urbana conocida con baches identificados manualmente.
2. Marcar cada bache con `🏷️ Marcar bache real` en el momento del paso.
3. Al detener la sesión, revisar precisión/recall mostrados automáticamente.
4. Exportar el dataset JSON con `exportValidationDataset()`.
5. Ajustar `URBAN_WEIGHTS` y umbrales según los resultados:
   - Muchos FP → subir umbral sigma o `scoreDiscard`
   - Muchos FN → bajar umbral sigma o subir pesos de `amp`/`jerk`
   - Clasificación errónea → ajustar umbrales de duración en `classifyType()`
6. Si la energía espectral resulta insuficiente, sustituir los cruces por cero por una FFT real (p. ej. con `fft.js` ~8 KB) operando sobre `S.urbanBuf`.
