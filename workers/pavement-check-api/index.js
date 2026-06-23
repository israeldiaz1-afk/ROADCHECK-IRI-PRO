export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    // GET /api/events?lat=X&lon=Y&r=R
    if (url.pathname === '/api/events' && request.method === 'GET') {
      const lat = parseFloat(url.searchParams.get('lat'));
      const lon = parseFloat(url.searchParams.get('lon'));
      const r   = Math.min(parseFloat(url.searchParams.get('r') || '500'), 2000);
      if (isNaN(lat) || isNaN(lon))
        return new Response('{"error":"lat/lon required"}', { status: 400, headers });

      const cellKeys = getCellKeys(lat, lon, r);
      const events = [];
      await Promise.all(cellKeys.map(async key => {
        const val = await env.EVENTS_KV.get(key, 'json');
        if (val) events.push(...val);
      }));

      const now = Date.now();
      const filtered = events.filter(e =>
        e.confirmCount >= 2 || (now - e.ts) < 7 * 86400 * 1000
      );
      return new Response(JSON.stringify(filtered), { headers });
    }

    // POST /api/events
    if (url.pathname === '/api/events' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return new Response('{"error":"invalid json"}', { status: 400, headers }); }

      const events = Array.isArray(body.events) ? body.events : [];
      if (!events.length) return new Response('{"ok":true,"stored":0}', { headers });

      let stored = 0;
      for (const ev of events.slice(0, 50)) {
        if (!ev.lat || !ev.lon || !ev.type || !ev.severity) continue;
        const cellKey = getCellKey(ev.lat, ev.lon);
        const cell = (await env.EVENTS_KV.get(cellKey, 'json')) || [];

        const existing = cell.find(e =>
          haversine(e.lat, e.lon, ev.lat, ev.lon) < 10 && e.type === ev.type
        );

        if (existing) {
          existing.confirmCount = (existing.confirmCount || 1) + 1;
          existing.score = ((existing.score * (existing.confirmCount - 1)) + ev.score) / existing.confirmCount;
          existing.lastSeen = Date.now();
        } else {
          cell.push({
            id: crypto.randomUUID(),
            ts: Date.now(),
            lat: snapToGrid(ev.lat, 0.0001),
            lon: snapToGrid(ev.lon, 0.0001),
            type: ev.type,
            severity: ev.severity,
            score: ev.score || 50,
            confirmCount: 1,
            lastSeen: Date.now()
          });
        }

        const pruned = cell.filter(e => (Date.now() - e.lastSeen) < 90 * 86400 * 1000);
        await env.EVENTS_KV.put(cellKey, JSON.stringify(pruned), { expirationTtl: 90 * 86400 });
        stored++;
      }
      return new Response(JSON.stringify({ ok: true, stored }), { headers });
    }

    // POST /api/analyze
    if (url.pathname === '/api/analyze' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return new Response('{"error":"invalid json"}', { status: 400, headers });
      }

      const { image, features } = body;
      if (!image || !features) {
        return new Response('{"error":"image and features required"}', { status: 400, headers });
      }

      const vibDesc = `Firma de vibración del sensor:
- Amplitud pico: ${features.peakAmp?.toFixed(2)} m/s²
- Jerk máximo: ${features.jerkMax?.toFixed(1)} m/s³
- Duración del evento: ${features.duration?.toFixed(0)} ms
- Bipolaridad (rebote): ${features.bipolarity?.toFixed(2)} (0=sin rebote, 1=rebote completo)
- Energía en alta frecuencia: ${features.freqEnergy?.toFixed(2)}
- Velocidad del vehículo: ${features.speed?.toFixed(1)} km/h`;

      const prompt = `Eres un sistema de análisis de pavimento vial. Se te proporciona una imagen tomada desde la cámara trasera de un vehículo y los datos del sensor acelerómetro registrados en el mismo instante.

${vibDesc}

Analiza la imagen y los datos de vibración conjuntamente y responde ÚNICAMENTE con un objeto JSON con esta estructura exacta (sin texto adicional, sin markdown):
{
  "type": "pothole|manhole|speedbump|crack|degraded|none",
  "severity": "leve|moderado|grave|none",
  "confidence": 0.0-1.0,
  "description": "descripción breve en español (máx 80 caracteres)",
  "discard": true|false
}

Criterios:
- "discard": true si la imagen muestra asfalto en buen estado o la firma de vibración corresponde claramente a un frenazo (bipolaridad<0.1 y alta correlación con desaceleración longitudinal)
- "type": "none" si no se identifica ningún desperfecto
- "confidence": tu nivel de certeza sobre la clasificación
- "severity": basada en la imagen visual combinada con la amplitud del sensor`;

      try {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 256 }
            })
          }
        );

        const geminiData = await geminiRes.json();
        const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const clean = rawText.replace(/```json|```/g, '').trim();
        let result;
        try { result = JSON.parse(clean); }
        catch { result = { type: 'unknown', severity: 'leve', confidence: 0.3, description: 'Error de análisis', discard: false }; }

        return new Response(JSON.stringify(result), { headers });
      } catch (e) {
        return new Response(
          JSON.stringify({ type: 'unknown', severity: 'leve', confidence: 0, description: 'Error de conexión', discard: false }),
          { headers }
        );
      }
    }

    return new Response('{"error":"not found"}', { status: 404, headers });
  }
};

function getCellKey(lat, lon) {
  return `cell:${Math.round(lat * 1000)}:${Math.round(lon * 1000)}`;
}
function getCellKeys(lat, lon, radiusM) {
  const dLat = (radiusM / 111320) * 1.1;
  const dLon = (radiusM / (111320 * Math.cos(lat * Math.PI / 180))) * 1.1;
  const keys = new Set();
  for (let dlat = -dLat; dlat <= dLat; dlat += 0.001)
    for (let dlon = -dLon; dlon <= dLon; dlon += 0.001)
      keys.add(getCellKey(lat + dlat, lon + dlon));
  return [...keys];
}
function snapToGrid(val, step) { return Math.round(val / step) * step; }
function haversine(a, b, c, d) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const s = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
