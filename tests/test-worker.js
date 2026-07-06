// tests/test-worker.js
// Ejecutar con: node tests/test-worker.js
// Requiere: node 18+

const WORKER_URL = 'https://pavement-check-api.israeldiaz1.workers.dev';

async function runTests() {
  console.log('🔬 Pavement Check — Test Suite Worker\n');
  const results = [];

  async function test(name, fn) {
    try {
      const start = Date.now();
      const result = await fn();
      const ms = Date.now() - start;
      if (result.ok) {
        console.log(`✅ ${name} (${ms}ms)`);
        if (result.detail) console.log(`   ${result.detail}`);
      } else {
        console.log(`❌ ${name} (${ms}ms)`);
        console.log(`   ${result.error}`);
      }
      results.push({ name, ...result, ms });
    } catch(e) {
      console.log(`❌ ${name}`);
      console.log(`   Error: ${e.message}`);
      results.push({ name, ok: false, error: e.message });
    }
  }

  // TEST 1: Worker responde
  await test('Worker accesible', async () => {
    const res = await fetch(`${WORKER_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: '', features: {} })
    });
    return res.status < 500
      ? { ok: true, detail: `HTTP ${res.status}` }
      : { ok: false, error: `HTTP ${res.status}` };
  });

  // TEST 2: Worker devuelve JSON válido
  await test('Worker devuelve JSON válido', async () => {
    const res = await fetch(`${WORKER_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: 'dGVzdA==', // base64 de "test"
        features: {
          peakAmp: 2.5, jerkMax: 50,
          duration: 120, bipolarity: 0.6,
          freqEnergy: 0.3, speed: 30
        }
      })
    });
    const data = await res.json();
    const hasRequired = ['type','severity','confidence','description','discard']
      .every(k => k in data);
    const validType = ['pothole','crack','alligator_crack','longitudinal_crack',
      'transverse_crack','manhole','speedbump','degraded','patch','unknown']
      .includes(data.type);
    const validSev = ['leve','moderado','grave'].includes(data.severity);
    const validConf = typeof data.confidence === 'number'
      && data.confidence >= 0 && data.confidence <= 1;

    if (!hasRequired)
      return { ok: false, error: `Faltan campos: ${JSON.stringify(data)}` };
    if (!validType)
      return { ok: false, error: `Tipo inválido: ${data.type}` };
    if (!validSev)
      return { ok: false, error: `Severidad inválida: ${data.severity}` };
    if (!validConf)
      return { ok: false, error: `Confianza inválida: ${data.confidence}` };

    return {
      ok: true,
      detail: `type=${data.type} sev=${data.severity} conf=${data.confidence.toFixed(2)} discard=${data.discard}`
    };
  });

  // TEST 3: Worker responde en tiempo razonable (<5s)
  await test('Worker latencia < 5s', async () => {
    const start = Date.now();
    await fetch(`${WORKER_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'dGVzdA==', features: {} })
    });
    const ms = Date.now() - start;
    return ms < 5000
      ? { ok: true, detail: `${ms}ms` }
      : { ok: false, error: `Demasiado lento: ${ms}ms` };
  });

  // TEST 4: Modelo YOLO accesible via HTTP
  await test('Modelo YOLO accesible', async () => {
    const res = await fetch(
      'https://roadcheck-iri-pro.pages.dev/models/pavement_yolo11n.onnx',
      { method: 'HEAD' }
    );
    const size = res.headers.get('content-length');
    return res.ok
      ? { ok: true, detail: `${(size/1024/1024).toFixed(1)} MB` }
      : { ok: false, error: `HTTP ${res.status}` };
  });

  // TEST 5: Modelo FP32 accesible via HTTP
  await test('Modelo YOLO FP32 accesible', async () => {
    const res = await fetch(
      'https://roadcheck-iri-pro.pages.dev/models/pavement_yolo11n_fp32.onnx',
      { method: 'HEAD' }
    );
    const size = res.headers.get('content-length');
    return res.ok
      ? { ok: true, detail: `${(size/1024/1024).toFixed(1)} MB` }
      : { ok: false, error: `HTTP ${res.status} — ¿subiste el modelo FP32?` };
  });

  // RESUMEN
  console.log('\n' + '─'.repeat(50));
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n📊 Resultado: ${passed}/${results.length} pruebas pasadas`);
  if (failed > 0) {
    console.log(`⚠️  ${failed} prueba(s) fallida(s) — revisar errores arriba`);
  } else {
    console.log('🎉 Todos los servicios funcionan correctamente');
  }
}

runTests().catch(console.error);
