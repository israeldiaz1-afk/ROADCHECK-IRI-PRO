// tests/test-logic.js
// Pruebas unitarias de la lógica de la app sin navegador
// Ejecutar con: node tests/test-logic.js

console.log('🔬 Pavement Check — Test Suite Lógica\n');
const results = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result.ok) {
      console.log(`✅ ${name}`);
      if (result.detail) console.log(`   ${result.detail}`);
    } else {
      console.log(`❌ ${name}: ${result.error}`);
    }
    results.push({ name, ...result });
  } catch(e) {
    console.log(`❌ ${name}: ${e.message}`);
    results.push({ name, ok: false, error: e.message });
  }
}

// Réplica de las funciones a testear
function calcFrameDelay(speedKmh) {
  const analysisMs = 300;
  const cameraOffsetM = 2.0;
  const speedMs = Math.max(speedKmh / 3.6, 0.1);
  return Math.min(
    analysisMs + (cameraOffsetM / speedMs) * 1000,
    3000 * 0.85
  );
}

function normalizeByVelocity(amp, speed, vRef=25, vMin=5, exp=0.7) {
  const v = Math.max(speed, vMin);
  const factor = Math.pow(vRef / v, exp);
  return amp * factor;
}

function calcDegradationRate(evolution) {
  const n = evolution.length;
  if (n < 2) return 0;
  const msPerDay = 86400000;
  const t0 = evolution[0].ts;
  const xs = evolution.map(e => (e.ts - t0) / msPerDay);
  const ys = evolution.map(e => e.score);
  const xMean = xs.reduce((a,b)=>a+b,0)/n;
  const yMean = ys.reduce((a,b)=>a+b,0)/n;
  const num = xs.reduce((s,x,i)=>s+(x-xMean)*(ys[i]-yMean),0);
  const den = xs.reduce((s,x)=>s+(x-xMean)**2,0);
  return den > 0 ? num/den : 0;
}

// TEST: calcFrameDelay
test('calcFrameDelay a 10 km/h (~1020ms)', () => {
  const d = calcFrameDelay(10);
  return Math.abs(d - 1020) < 50
    ? { ok: true, detail: `${d.toFixed(0)}ms` }
    : { ok: false, error: `Esperado ~1020ms, obtenido ${d.toFixed(0)}ms` };
});

test('calcFrameDelay a 30 km/h (~540ms)', () => {
  const d = calcFrameDelay(30);
  return Math.abs(d - 540) < 50
    ? { ok: true, detail: `${d.toFixed(0)}ms` }
    : { ok: false, error: `Esperado ~540ms, obtenido ${d.toFixed(0)}ms` };
});

test('calcFrameDelay a 50 km/h (~444ms)', () => {
  const d = calcFrameDelay(50);
  return Math.abs(d - 444) < 50
    ? { ok: true, detail: `${d.toFixed(0)}ms` }
    : { ok: false, error: `Esperado ~444ms, obtenido ${d.toFixed(0)}ms` };
});

test('calcFrameDelay nunca supera el 85% del buffer (2550ms)', () => {
  const d = calcFrameDelay(1); // velocidad mínima
  return d <= 2550
    ? { ok: true, detail: `${d.toFixed(0)}ms <= 2550ms` }
    : { ok: false, error: `${d.toFixed(0)}ms > límite del buffer` };
});

// TEST: normalización por velocidad
test('normalizeByVelocity: velocidad = vRef → factor 1.0', () => {
  const result = normalizeByVelocity(2.0, 25);
  return Math.abs(result - 2.0) < 0.01
    ? { ok: true, detail: `factor=1.0 correcto` }
    : { ok: false, error: `Esperado 2.0, obtenido ${result.toFixed(3)}` };
});

test('normalizeByVelocity: velocidad baja → amplifica', () => {
  const result = normalizeByVelocity(2.0, 10);
  return result > 2.0
    ? { ok: true, detail: `${result.toFixed(3)} > 2.0 ✓` }
    : { ok: false, error: `No amplificó a velocidad baja` };
});

test('normalizeByVelocity: velocidad alta → reduce', () => {
  const result = normalizeByVelocity(2.0, 60);
  return result < 2.0
    ? { ok: true, detail: `${result.toFixed(3)} < 2.0 ✓` }
    : { ok: false, error: `No redujo a velocidad alta` };
});

// TEST: tasa de degradación
test('calcDegradationRate: sin datos (<2) → 0', () => {
  const rate = calcDegradationRate([{ ts: Date.now(), score: 0.5 }]);
  return rate === 0
    ? { ok: true }
    : { ok: false, error: `Esperado 0, obtenido ${rate}` };
});

test('calcDegradationRate: tendencia creciente → positivo', () => {
  const now = Date.now();
  const evolution = [
    { ts: now, score: 0.3 },
    { ts: now + 7*86400000, score: 0.5 },
    { ts: now + 14*86400000, score: 0.7 }
  ];
  const rate = calcDegradationRate(evolution);
  return rate > 0
    ? { ok: true, detail: `rate=${rate.toFixed(4)}/día` }
    : { ok: false, error: `Esperado positivo, obtenido ${rate}` };
});

test('calcDegradationRate: tendencia decreciente → negativo', () => {
  const now = Date.now();
  const evolution = [
    { ts: now, score: 0.8 },
    { ts: now + 7*86400000, score: 0.5 },
    { ts: now + 14*86400000, score: 0.2 }
  ];
  const rate = calcDegradationRate(evolution);
  return rate < 0
    ? { ok: true, detail: `rate=${rate.toFixed(4)}/día` }
    : { ok: false, error: `Esperado negativo, obtenido ${rate}` };
});

// RESUMEN
console.log('\n' + '─'.repeat(50));
const passed = results.filter(r => r.ok).length;
console.log(`\n📊 ${passed}/${results.length} pruebas pasadas`);
