/* PAVEMENT CHECK · app.js v4.0
   Multi-mode: IRI (Carretera) + Urbano + Confort de Marcha (ISO 2631-1)
   Fixes: OSM tiles, chart axes, detail map, bidirectional map↔chart sync */

const DEF={coefA:2.0,coefB:.50,vRef:80,vExp:.50,vMin:10,segLen:100,noiseFloor:.05,freq:60};
let C={...DEF};

const S={
  active:false,paused:false,pts:[],dist:0,segCount:0,
  lastPos:null,gpsReady:false,watchId:null,gpsHistory:[],selectedCameraId:null,
  iriMA:0,iriCA:0,iriN:0,
  iriMax:0,iriMin:Infinity,iriSum:0,iriCnt:0,
  sensorOK:false,calibrated:false,
  calPhase:0,calStart:0,gravSamples:[],vibSamples:[],
  grav:null,gravMag:9.81,noiseLevel:.05,
  hpPrev:0,hpPrevIn:0,buf:[],bufMax:50,
  chartMeas:null,chartDetail:null,
  chartZ:[],chartI:[],chartMax:80,lastChartUpd:0,lastIRIUpd:0,
  vehicleId:null,selRoutes:new Set(),showAvg:false,
  curDetail:null,curDetailRoute:null,overlapCb:null,pendingRoute:null,
  timerRef:null,timerStart:0,
  activeModes:new Set(['iri']),
  urbanBuf:[],urbanBufMax:90,
  urbanEvents:[],
  noiseBaseline:{mean:0,std:0.05,samples:[]},
  noiseFilter:{
    eventMask:false,eventMaskTs:0,
    percentile15:0,appliedPost:false,
    refBuf:[],refBufMax:600,refSpectrum:null
  },
  _lastEventTs:null,
  groundTruth:[],
  comfort:{
    vehicleProfile:'turismo',
    fsActual:60,
    filtersZ:null,filtersX:null,filtersY:null,
    rmsWindowZ:[],rmsWindowX:[],rmsWindowY:[],
    avLive:0,avBaseline:0,
    sumPow4Z:0,sumPow4X:0,sumPow4Y:0,
    sumSqZ:0,sumSqX:0,sumSqY:0,sumN:0,
    segments:[],pts:[],_currentSegPts:[],
    _dtBuffer:[],_lastTs:null,_lastVdvTs:null,
    _segStartPow4Z:0,_segDist:0
  },
  mapMain:null,mapMeas:null,mapVisor:null,mapDetail:null,
  lineMeas:null,mkMain:null,mkMeas:null,mkDetail:null,
  _sessionStart:0,
  _recentUrbanEvent:false,
  _manualRecalRequest:false,
  autoRecalEnabled:true,
  adaptiveCal:{
    active:false,gravBuf:[],gravBufMax:180,
    lastUpdate:0,updateCount:0,driftDeg:0,
    driftThresholdDeg:2.0,status:'idle',_stopStart:null
  }
};

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

async function getImageBlobs(keys) {
  const results = await Promise.all(keys.map(k => getImageBlob(k)));
  return results;
}

async function deleteImageBlobs(keys) {
  try {
    const db = await openImageDB();
    const tx = db.transaction(IMG_DB.storeName, 'readwrite');
    const store = tx.objectStore(IMG_DB.storeName);
    keys.forEach(k => store.delete(k));
    return new Promise(resolve => { tx.oncomplete = () => resolve(true); });
  } catch(e) { return false; }
}

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
        console.log('[IMG_DB] Limpiadas ' + pruned + ' imágenes antiguas');
      }
    };
  } catch(e) {}
}

const VEHICLES=[
  {id:'v01',name:'Toyota Corolla (2018-24)',cat:'Compacto',coefA:2.00,coefB:.50,desc:'McPherson/torsión · 1.3 Hz'},
  {id:'v02',name:'Honda Civic (2020-24)',cat:'Compacto',coefA:2.10,coefB:.50,desc:'McPherson/torsión · 1.35 Hz'},
  {id:'v03',name:'VW Golf (2020-24)',cat:'Compacto',coefA:2.05,coefB:.48,desc:'McPherson/multibr. · 1.3 Hz'},
  {id:'v04',name:'Renault Clio (2019-24)',cat:'Compacto',coefA:1.90,coefB:.45,desc:'McPherson/torsión · 1.25 Hz'},
  {id:'v05',name:'SEAT Ibiza (2020-24)',cat:'Compacto',coefA:1.92,coefB:.46,desc:'McPherson/torsión · 1.27 Hz'},
  {id:'v06',name:'Opel Corsa (2020-24)',cat:'Compacto',coefA:1.88,coefB:.44,desc:'McPherson/torsión · 1.25 Hz'},
  {id:'v07',name:'Peugeot 307 SW (2002-08)',cat:'Compacto',coefA:2.12,coefB:.55,desc:'McPherson/torsión · 1.22 Hz · gen.2002'},
  {id:'v08',name:'Peugeot 308 (2022-24)',cat:'Compacto',coefA:2.00,coefB:.46,desc:'McPherson/torsión · 1.28 Hz'},
  {id:'v09',name:'BMW Serie 3 (2019-24)',cat:'Sedán',coefA:2.30,coefB:.55,desc:'McPherson/mult. · 1.45 Hz · sport'},
  {id:'v10',name:'Mercedes Clase C (2021-24)',cat:'Sedán',coefA:2.20,coefB:.50,desc:'McPherson/multibr. · 1.4 Hz'},
  {id:'v11',name:'Audi A4 (2020-24)',cat:'Sedán',coefA:2.25,coefB:.52,desc:'McPherson/trapecio · 1.42 Hz'},
  {id:'v12',name:'Tesla Model 3 (2021-24)',cat:'Sedán',coefA:2.40,coefB:.58,desc:'McPherson/mult. · 1.5 Hz'},
  {id:'v13',name:'Ford Mondeo (2018-24)',cat:'Sedán',coefA:2.15,coefB:.50,desc:'McPherson/integral · 1.3 Hz'},
  {id:'v14',name:'Skoda Octavia (2020-24)',cat:'Sedán',coefA:2.05,coefB:.47,desc:'McPherson/multibr. · 1.28 Hz'},
  {id:'v15',name:'VW Passat (2020-24)',cat:'Sedán',coefA:2.08,coefB:.48,desc:'McPherson/multibr. · 1.3 Hz'},
  {id:'v16',name:'Toyota RAV4 (2019-24)',cat:'SUV',coefA:2.40,coefB:.55,desc:'McPherson/multibr. · 1.2 Hz'},
  {id:'v17',name:'Honda CR-V (2020-24)',cat:'SUV',coefA:2.35,coefB:.53,desc:'McPherson/multibr. · 1.2 Hz'},
  {id:'v18',name:'VW Tiguan (2021-24)',cat:'SUV',coefA:2.30,coefB:.50,desc:'McPherson/multibr. · 1.22 Hz'},
  {id:'v19',name:'Nissan Qashqai (2021-24)',cat:'SUV',coefA:2.30,coefB:.50,desc:'McPherson/torsión · 1.2 Hz'},
  {id:'v20',name:'Kia Sportage (2022-24)',cat:'SUV',coefA:2.35,coefB:.52,desc:'McPherson/mult. · 1.25 Hz'},
  {id:'v21',name:'Citroën C4 (2021-24)',cat:'SUV',coefA:1.65,coefB:.40,desc:'PHC hidráulico · 1.0 Hz · máx confort'},
  {id:'v22',name:'Jeep Renegade (2021-24)',cat:'SUV',coefA:2.42,coefB:.56,desc:'McPherson/torsión · 1.15 Hz'},
  {id:'v23',name:'Porsche 911 (2020-24)',cat:'Deportivo',coefA:2.90,coefB:.65,desc:'McPherson/mult. · 1.9 Hz · PASM'},
  {id:'v24',name:'Ford Mustang (2020-24)',cat:'Deportivo',coefA:2.70,coefB:.60,desc:'McPherson/integral · 1.7 Hz'},
  {id:'v25',name:'Mazda MX-5 (2016-24)',cat:'Deportivo',coefA:2.80,coefB:.60,desc:'McPherson/doble horq. · 1.75 Hz'},
  {id:'v26',name:'BMW M3 (2021-24)',cat:'Deportivo',coefA:3.00,coefB:.65,desc:'Adaptativo M · 2.0 Hz'},
  {id:'v27',name:'Ford Ranger (2019-24)',cat:'Pick-up',coefA:2.80,coefB:.65,desc:'Doble horq./ballestas · 1.1 Hz'},
  {id:'v28',name:'Toyota Hilux (2020-24)',cat:'Pick-up',coefA:2.90,coefB:.65,desc:'Doble horq./ballestas · 1.05 Hz'},
  {id:'v29',name:'VW Amarok (2022-24)',cat:'Pick-up',coefA:2.85,coefB:.60,desc:'Doble horq./mult. · 1.15 Hz'},
  {id:'v30',name:'Citroën Berlingo (2018-24)',cat:'Furgoneta',coefA:2.50,coefB:.60,desc:'McPherson/ballestas · 1.15 Hz'},
  {id:'v31',name:'VW Transporter T6 (2015-24)',cat:'Furgoneta',coefA:2.60,coefB:.65,desc:'McPherson/ballestas · 1.1 Hz'},
];

// ─ helpers ────────────────────────────────────
const $=id=>document.getElementById(id);
const set=(id,v)=>{const e=$(id);if(e)e.textContent=v;};
function geo(a,b,c,d){const R=6371000,r=x=>x*Math.PI/180,s=Math.sin(r(c-a)/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(r(d-b)/2)**2;return R*2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));}
const rmsA=a=>a.length?Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length):0;
const fmtD=ts=>new Date(ts).toLocaleString('es',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const iCol=v=>v<=2.5?'#10B981':v<=5?'#F59E0B':'#EF4444';
const iCls=v=>v<=2.5?'good':v<=5?'fair':'bad';
const iLbl=v=>v<=2.5?'Bueno':v<=5?'Regular':'Malo';
const escH=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function toast(msg,dur=2400){document.querySelectorAll('.toast').forEach(t=>t.remove());const t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(()=>{t.style.transition='opacity .3s';t.style.opacity='0';setTimeout(()=>t.remove(),320);},dur);}

// ─ config / storage ───────────────────────────
function loadCfg(){
  try{const s=localStorage.getItem('rc_cfg');if(s)C={...C,...JSON.parse(s)};}catch(e){}
  S.noiseLevel=C.noiseFloor;
  const vid=localStorage.getItem('rc_veh');
  if(vid){const v=allVeh().find(v=>v.id===vid);if(v){C.coefA=v.coefA;C.coefB=v.coefB;S.vehicleId=vid;updateVehUI(v);}}
  // Restaurar modos activos (con retrocompat a rc_mode anterior)
  const savedModes=localStorage.getItem('rc_activeModes');
  if(savedModes){try{const m=JSON.parse(savedModes);if(Array.isArray(m)&&m.length)S.activeModes=new Set(m);}catch(e){}}
  else{const old=localStorage.getItem('rc_mode');if(old)S.activeModes=new Set([old]);}
}
function saveCfg(){try{localStorage.setItem('rc_cfg',JSON.stringify(C));}catch(e){}}
function saveActiveModes(){try{localStorage.setItem('rc_activeModes',JSON.stringify([...S.activeModes]));}catch(e){}}

// ─ multi-mode architecture ────────────────────
const MODE_INCOMPATIBLE_PAIRS=[['iri','urban']];

function toggleMode(mode){
  if(S.activeModes.has(mode)){
    S.activeModes.delete(mode);
    if(S.activeModes.size===0)S.activeModes.add('iri');
  } else {
    MODE_INCOMPATIBLE_PAIRS.forEach(([a,b])=>{
      if(mode===a&&S.activeModes.has(b)){toast('Carretera y Urbano no pueden combinarse — se ha desactivado el otro modo');S.activeModes.delete(b);}
      if(mode===b&&S.activeModes.has(a)){toast('Carretera y Urbano no pueden combinarse — se ha desactivado el otro modo');S.activeModes.delete(a);}
    });
    S.activeModes.add(mode);
  }
  saveActiveModes();
  renderModeUI();
  renderMainPanels();
  recalcMainLayout();
}
function renderModeUI(){
  document.querySelectorAll('.mode-chip').forEach(btn=>{
    btn.classList.toggle('active',S.activeModes.has(btn.dataset.mode));
  });
  // Chip de vehículo: atenuado si Carretera no está activo
  const vehChip=$('cVEH');
  if(vehChip)vehChip.style.opacity=S.activeModes.has('iri')?'1':'0.45';
}
function renderMainPanels(){
  const n=S.activeModes.size;
  ['iri','urban','comfort'].forEach(mode=>{
    const panel=$(mode+'Panel');
    if(!panel)return;
    const isActive=S.activeModes.has(mode);
    panel.classList.toggle('hidden',!isActive);
    panel.classList.toggle('compact',isActive&&n>1);
  });
}
function updateMeasPanel(){
  const hasIRI=S.activeModes.has('iri');
  const hasUrban=S.activeModes.has('urban');
  $('measIRIPanel')?.classList.toggle('hidden',!hasIRI);
  $('measUrbanPanel')?.classList.toggle('hidden',!hasUrban);
}
function recalcMainLayout(){
  const screenEl=$('tab-main');if(!screenEl)return;
  const mapWrap=$('mapMain')?.closest('.map-wrap');if(!mapWrap)return;
  const totalH=screenEl.clientHeight;
  const usedH=[
    screenEl.querySelector('.hdr'),
    $('modeSelector'),
    $('mainPanelsContainer'),
    $('calPanel'),
    screenEl.querySelector('.act-grid'),
    $('btnStart'),
    $('calReqNote'),
    $('btnIOS')
  ].filter(el=>el&&!el.classList.contains('hidden'))
   .reduce((sum,el)=>sum+el.getBoundingClientRect().height,0);
  const gaps=8*8;
  const available=Math.max(100,totalH-usedH-gaps);
  mapWrap.style.height=available+'px';
  try{S.mapMain?.invalidateSize();}catch(e){}
  updateBaselineIndicator();
}
function updateBaselineIndicator(){
  const dot=$('biDot'),lbl=$('biLabel'),det=$('biDetail');
  if(!dot)return;
  if(!S.calibrated){
    dot.style.background='#3A5F7A';
    lbl.textContent='Sensor sin calibrar';
    det.textContent='Pulsa 🎯 para calibrar antes de iniciar';
    return;
  }
  dot.style.background='#10B981';
  lbl.textContent='✅ Sensor calibrado';
  const details=[];
  if(S.activeModes.has('iri'))details.push('IRI: baseline OK');
  if(S.activeModes.has('urban'))details.push('Urbano: umbral '+(S.noiseBaseline.mean+4*S.noiseBaseline.std).toFixed(3)+' m/s²');
  if(S.activeModes.has('comfort'))details.push('Confort: a_v baseline '+(S.comfort.avBaseline||0).toFixed(3)+' m/s²');
  det.textContent=details.join(' · ');
}
const capitalize=s=>s.charAt(0).toUpperCase()+s.slice(1);

// ─ Cola de actualizaciones UI (rAF) ───────────
const UI_QUEUE={};
let uiFramePending=false;
function queueUI(key,fn){
  UI_QUEUE[key]=fn;
  if(!uiFramePending){uiFramePending=true;requestAnimationFrame(flushUI);}
}
function flushUI(){
  uiFramePending=false;
  const keys=Object.keys(UI_QUEUE);
  keys.forEach(k=>{try{UI_QUEUE[k]();}catch(e){}delete UI_QUEUE[k];});
}
function allVeh(){return[...VEHICLES,...JSON.parse(localStorage.getItem('rc_cveh')||'[]')];}
function allRoutes(){try{return JSON.parse(localStorage.getItem('rc_routes')||'[]');}catch(e){return[];}}
function saveRoute(r){
  try{
    const clean=JSON.parse(JSON.stringify(r,
      (key,val)=>{
        if(key==='_frameBlobs'||
           key==='_frameBlob'||
           key==='_clipBlobs') return undefined;
        return val;
      }
    ));
    const rs=allRoutes();
    rs.push(clean);
    localStorage.setItem('rc_routes',JSON.stringify(rs));
  }catch(e){
    console.error('[saveRoute]',e.message);
    toast('⚠️ Error guardando: '+e.message);
  }
}
function delRoute(id){localStorage.setItem('rc_routes',JSON.stringify(allRoutes().filter(r=>r.id!==id)));}
function clearRoutes(){localStorage.removeItem('rc_routes');}

// ─ IRI engine ────────────────────────────────
function hpf(x){const y=.9494*(S.hpPrev+x-S.hpPrevIn);S.hpPrev=y;S.hpPrevIn=x;return y;}
function computeIRI(raw){
  const f=hpf(raw);S.buf.push(f);if(S.buf.length>S.bufMax)S.buf.shift();
  const clean=Math.max(0,rmsA(S.buf)-S.noiseLevel);
  return clean<=0?0:Math.max(0,C.coefA*clean+C.coefB);
}
function spdCorr(m,kmh){return(kmh<C.vMin||kmh<=0)?m:m*Math.pow(C.vRef/kmh,C.vExp);}

// ─ GPS Kalman + snapping ──────────────────────
const GPS_KALMAN={lat:null,lon:null,varLat:1,varLon:1,Q:0.00001,R:0.0001,initialized:false};

function kalmanGPS(rawLat,rawLon,accuracy){
  const R=Math.max(GPS_KALMAN.R,(accuracy/111320)**2);
  if(!GPS_KALMAN.initialized){
    GPS_KALMAN.lat=rawLat;GPS_KALMAN.lon=rawLon;
    GPS_KALMAN.varLat=R;GPS_KALMAN.varLon=R;
    GPS_KALMAN.initialized=true;
    return{lat:rawLat,lon:rawLon};
  }
  GPS_KALMAN.varLat+=GPS_KALMAN.Q;GPS_KALMAN.varLon+=GPS_KALMAN.Q;
  const kLat=GPS_KALMAN.varLat/(GPS_KALMAN.varLat+R);
  const kLon=GPS_KALMAN.varLon/(GPS_KALMAN.varLon+R);
  GPS_KALMAN.lat+=kLat*(rawLat-GPS_KALMAN.lat);
  GPS_KALMAN.lon+=kLon*(rawLon-GPS_KALMAN.lon);
  GPS_KALMAN.varLat*=(1-kLat);GPS_KALMAN.varLon*=(1-kLon);
  return{lat:GPS_KALMAN.lat,lon:GPS_KALMAN.lon};
}

function getBestPosition(){
  if(!S.gpsHistory.length)return S.lastPos;
  const recent=S.gpsHistory.slice(-5);
  let wLat=0,wLon=0,wTotal=0;
  recent.forEach(p=>{const w=1/Math.max(p.accuracy,1)**2;wLat+=p.lat*w;wLon+=p.lon*w;wTotal+=w;});
  return{lat:wLat/wTotal,lon:wLon/wTotal};
}

function projectPointOnSegment(pLat,pLon,aLat,aLon,bLat,bLon){
  const dLat=bLat-aLat,dLon=bLon-aLon;
  const t=Math.max(0,Math.min(1,((pLat-aLat)*dLat+(pLon-aLon)*dLon)/(dLat*dLat+dLon*dLon||1)));
  return{lat:aLat+t*dLat,lon:aLon+t*dLon};
}

async function snapToRoad(lat,lon){
  const query=`[out:json][timeout:5];way(around:15,${lat},${lon})["highway"];out geom;`;
  try{
    const res=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:'data='+encodeURIComponent(query)});
    const data=await res.json();
    if(!data.elements?.length)return{lat,lon};
    let bestLat=lat,bestLon=lon,bestDist=Infinity;
    data.elements.forEach(way=>{
      const geom=way.geometry||[];
      for(let i=0;i<geom.length-1;i++){
        const proj=projectPointOnSegment(lat,lon,geom[i].lat,geom[i].lon,geom[i+1].lat,geom[i+1].lon);
        const d=geo(lat,lon,proj.lat,proj.lon);
        if(d<bestDist){bestDist=d;bestLat=proj.lat;bestLon=proj.lon;}
      }
    });
    return bestDist<15?{lat:bestLat,lon:bestLon,snapped:true,snapDist:bestDist}:{lat,lon};
  }catch{return{lat,lon};}
}

// ─ GPS ───────────────────────────────────────
function startGPS(){
  if(!('geolocation' in navigator)){toast('GPS no disponible');return;}
  const opt={enableHighAccuracy:true,maximumAge:1000,timeout:12000};
  navigator.geolocation.getCurrentPosition(
    p=>{onGPS(p);S.watchId=navigator.geolocation.watchPosition(onGPS,()=>{},opt);},
    ()=>{S.watchId=navigator.geolocation.watchPosition(onGPS,()=>{},opt);},
    {enableHighAccuracy:false,maximumAge:60000,timeout:4000}
  );
}
function onGPS(pos){
  const{latitude:rawLat,longitude:rawLon,speed:spd,accuracy:acc}=pos.coords;
  const filtered=kalmanGPS(rawLat,rawLon,acc);
  const lat=filtered.lat,lon=filtered.lon;
  S.gpsHistory.push({lat,lon,ts:Date.now(),accuracy:acc});
  if(S.gpsHistory.length>10)S.gpsHistory.shift();
  const kmh=(spd!=null&&spd>0.42)?spd*3.6:0;
  const at='±'+acc.toFixed(0)+'m';
  setChip('cGPS','dGPS','lGPS',acc<=20?'ok':'warn',acc<=20?'#10B981':'#F59E0B','GPS '+at);
  if(!S.gpsReady){
    S.gpsReady=true;
    mapCenter(S.mapMain,lat,lon,16);
    S.lastPos={lat,lon,speed:kmh};return;
  }
  const d=geo(S.lastPos.lat,S.lastPos.lon,lat,lon);
  if(kmh<3&&d<2){S.lastPos={...S.lastPos,speed:kmh};return;}
  mapMk(S.mapMain,'mkMain',lat,lon);
  mapMk(S.mapMeas,'mkMeas',lat,lon);
  if(kmh>2){
    S.lineMeas?.addLatLng([lat,lon]);
    S.dist+=d;
    const dt=S.dist<1000?S.dist.toFixed(0)+' m':(S.dist/1000).toFixed(2)+' km';
    set('distPill',dt);set('measDist',dt);
  }
  const st=kmh>1?kmh.toFixed(1)+' km/h':'0 km/h';
  set('speedPill',st);set('measSpeed',st);
  if(S.active&&!S.paused&&S.calibrated&&S.activeModes.has('iri')&&S.iriN>0){
    S.pts.push({ts:Date.now(),lat,lon,speed:kmh,iri_m:S.iriMA/S.iriN,iri_c:S.iriCA/S.iriN});
    S.iriMA=0;S.iriCA=0;S.iriN=0;
    const sn=Math.floor(S.dist/C.segLen);if(sn>S.segCount){S.segCount=sn;set('aSegs',S.segCount.toString());}
  }
  if(S.active&&!S.paused&&S.calibrated&&S.activeModes.has('comfort')){
    const cf=S.comfort;
    const pt={ts:Date.now(),lat,lon,speed:kmh,av:cf.avLive};
    cf.pts.push(pt);
    cf._currentSegPts.push(pt);
    cf._segDist+=(kmh>2?d:0);
    if(cf._segDist>=C.segLen)closeComfortSegment();
  }
  S.lastPos={lat,lon,speed:kmh};
}
function setChip(ci,di,li,cls,col,lbl){const e=$(ci);if(!e)return;e.className='chip '+cls;const d=$(di);if(d)d.style.background=col;set(li,lbl);}
function mapCenter(map,lat,lon,z){if(!map)return;map.setView([lat,lon],z);setTimeout(()=>{try{map.invalidateSize();}catch(e){}},120);}
function mapMk(map,key,lat,lon){
  if(!map)return;
  if(S[key]){
    const prev=S[key].getLatLng();
    if(geo(prev.lat,prev.lng,lat,lon)<8)return;
    S[key].setLatLng([lat,lon]);
  } else {
    S[key]=L.circleMarker([lat,lon],{radius:7,color:'#fff',weight:2,fillColor:'#0EA5E9',fillOpacity:1}).addTo(map);
  }
  map.panTo([lat,lon]);
}

// ─ sensor ─────────────────────────────────────
function startSensor(){
  if(S.sensorOK)return;
  if(typeof DeviceMotionEvent!=='undefined'&&typeof DeviceMotionEvent.requestPermission==='function'){$('btnIOS')?.classList.remove('hidden');return;}
  tryAccel();
}
function tryAccel(){
  if('Accelerometer' in window){
    try{
      window._accel=new Accelerometer({frequency:C.freq,referenceFrame:'device'});
      window._accel.addEventListener('reading',()=>onRaw(window._accel.x||0,window._accel.y||0,window._accel.z||0));
      window._accel.addEventListener('error',()=>motionFB());
      window._accel.start();S.sensorOK=true;
      setChip('cSEN','dSEN','lSEN','warn','#F59E0B','Sin calibrar');
    }catch(e){motionFB();}
  }else{motionFB();}
}
function motionFB(){
  window.addEventListener('devicemotion',e=>{const a=e.accelerationIncludingGravity;if(a)onRaw(a.x||0,a.y||0,a.z||0);},{passive:true});
  S.sensorOK=true;setChip('cSEN','dSEN','lSEN','warn','#F59E0B','Sin calibrar');
}
function onRaw(x,y,z){
  if(!S.sensorOK)return;
  if(S.calPhase>0){doCalSample(x,y,z);return;}
  if(!S.calibrated)return;
  const g=S.grav;
  const raw=Math.abs(x*g.x+y*g.y+z*g.z-S.gravMag);
  if(S.active){
    if(S.activeModes.has('urban'))feedUrbanBuffer(x,y,z,Date.now());
    if(S.activeModes.has('comfort'))onComfortSample(x,y,z,Date.now());
    onVert(raw);
  }
  if(S.active&&!S.paused){
    updateAccelViz(x,y,z);
    const _ts=Date.now();
    feedAdaptiveCalibration(x,y,z,_ts);
    queueUI('adaptiveCal',updateAdaptiveCalUI);
  }
}

// ─ urban buffer ───────────────────────────────
function feedUrbanBuffer(x,y,z,t){
  const g=S.grav;
  const vert=x*g.x+y*g.y+z*g.z-S.gravMag; // con signo, para forma de onda
  S.urbanBuf.push({t,ax:x,ay:y,az:z,vert});
  if(S.urbanBuf.length>S.urbanBufMax)S.urbanBuf.shift();
  updateNoiseBaseline(vert);
  updateReferenceSpectrum(vert,S.lastPos?.speed||0);
  detectEvent();
}

function updateNoiseBaseline(vert){
  const now=Date.now();
  if(S.noiseFilter.eventMask&&(now-S.noiseFilter.eventMaskTs)<1000)return;
  S.noiseFilter.eventMask=false;
  S.noiseBaseline.samples.push(Math.abs(vert));
  if(S.noiseBaseline.samples.length>300)S.noiseBaseline.samples.shift();
  S.noiseBaseline.mean=S.noiseBaseline.samples.reduce((a,b)=>a+b,0)/S.noiseBaseline.samples.length;
  const variance=S.noiseBaseline.samples.reduce((a,b)=>a+(b-S.noiseBaseline.mean)**2,0)/S.noiseBaseline.samples.length;
  S.noiseBaseline.std=Math.sqrt(variance);
}
function updateReferenceSpectrum(vert,speedKmh){
  if(speedKmh<10||speedKmh>90)return;
  if(S.noiseFilter.eventMask)return;
  const absVert=Math.abs(vert);
  const p20Threshold=S.noiseBaseline.mean+0.5*S.noiseBaseline.std;
  if(absVert>p20Threshold)return;
  S.noiseFilter.refBuf.push(absVert);
  if(S.noiseFilter.refBuf.length>S.noiseFilter.refBufMax)S.noiseFilter.refBuf.shift();
  if(S.noiseFilter.refBuf.length>=S.noiseFilter.refBufMax){
    const mean=S.noiseFilter.refBuf.reduce((a,b)=>a+b,0)/S.noiseFilter.refBuf.length;
    const std=Math.sqrt(S.noiseFilter.refBuf.reduce((a,b)=>a+(b-mean)**2,0)/S.noiseFilter.refBuf.length);
    S.noiseFilter.refSpectrum={mean,std,n:S.noiseFilter.refBuf.length};
  }
}

function detectEvent(){
  if(S.urbanBuf.length<20)return;
  const latest=S.urbanBuf[S.urbanBuf.length-1];
  const dynamicThreshold=S.noiseBaseline.mean+4*S.noiseBaseline.std; // 4-sigma
  if(Math.abs(latest.vert)<Math.max(
    dynamicThreshold,
    URBAN_TUNABLE.triggerFloorMs2))return;
  if(S._lastEventTs&&latest.t-S._lastEventTs<300)return; // anti-rebote 300ms
  extractFeaturesAndScore(latest.t);
}

function extractFeaturesAndScore(triggerTs){
  const window=S.urbanBuf.filter(s=>Math.abs(s.t-triggerTs)<=200);
  if(window.length<6)return;

  const verts=window.map(s=>s.vert);
  const peakAmp=Math.max(...verts.map(Math.abs));

  // Jerk: derivada discreta de la aceleración vertical
  let jerkMax=0;
  for(let i=1;i<window.length;i++){
    const dt=(window[i].t-window[i-1].t)/1000;
    if(dt<=0)continue;
    const jerk=Math.abs((window[i].vert-window[i-1].vert)/dt);
    jerkMax=Math.max(jerkMax,jerk);
  }

  // Duración: tiempo con |vert| > mitad del pico
  const halfPeak=peakAmp*0.5;
  const above=window.filter(s=>Math.abs(s.vert)>halfPeak);
  const duration=above.length>1?(above[above.length-1].t-above[0].t):0;

  // Bipolaridad: caída seguida de rebote de signo opuesto (firma de bache)
  let bipolarity=0;
  const peakIdx=window.findIndex(s=>Math.abs(s.vert)===peakAmp);
  if(peakIdx>=0&&peakIdx<window.length-3){
    const peakSign=Math.sign(window[peakIdx].vert);
    const after=window.slice(peakIdx+1,peakIdx+6);
    const oppositeSignPeak=Math.max(...after.map(s=>peakSign>0?-s.vert:s.vert),0);
    bipolarity=Math.min(1,oppositeSignPeak/peakAmp);
  }

  // freqEnergy: solo en ±9 muestras alrededor del pico para no contaminar con
  // cruces por cero del ruido de fondo fuera del evento
  const coreStart=Math.max(0,peakIdx-9);
  const coreEnd=Math.min(window.length,peakIdx+9);
  const core=window.slice(coreStart,coreEnd);
  let crossings=0;
  for(let i=1;i<core.length;i++){if(Math.sign(core[i].vert)!==Math.sign(core[i-1].vert))crossings++;}
  const coreDurationS=core.length>1?(core[core.length-1].t-core[0].t)/1000:0.001;
  const crossingFreq=coreDurationS>0?crossings/coreDurationS/2:0;
  const freqEnergy=Math.min(1,Math.max(0,(crossingFreq-4)/16));

  // Correlación con frenado: eje Y longitudinal sostenido = frenazo, no bache
  const ays=window.map(s=>Math.abs(s.ay));
  const ayAvg=ays.reduce((a,b)=>a+b,0)/ays.length;
  const brakeCorrelation=Math.min(1,ayAvg/3); // 3 m/s² ~ frenada fuerte

  const features={peakAmp,jerkMax,duration,bipolarity,freqEnergy,brakeCorrelation};

  // Capturar ventana de vibración centrada en el pico — solo eje vertical calibrado
  const wfStart = Math.max(0, peakIdx - 15);
  const wfEnd = Math.min(window.length, peakIdx + 45);
  const waveform = window.slice(wfStart, wfEnd)
    .map(s => parseFloat(s.vert.toFixed(4)));

  scoreAndClassify(features,triggerTs,waveform);
}

// ─ scoring & classification ───────────────────
// Parámetros ajustables en campo — valores validados con banco de pruebas sintético
const URBAN_TUNABLE={
  triggerSigma:4,
  triggerFloorMs2:0.8,
  vRefUrban:25,
  vMinNormalize:5,
  speedExponent:0.7,
  ampCeiling:6,      // bajado de 8 → 6 (rango real observado: 0.1-5 m/s²)
  jerkCeiling:220,   // subido de 40 → 220 (rango real: 9-300 m/s³, antes saturaba siempre)
  scoreDiscardBelow:25,
  severityModerateAt:40,
  severityGraveAt:65,
  proximityConfirmM:4,
  confirmAfterPasses:2
};

const URBAN_WEIGHTS={amp:0.30,jerk:0.25,bipolarity:0.20,freqEnergy:0.15,brakePenalty:0.10};

function normalizeByVelocity(value,speedKmh){
  const{vRefUrban,vMinNormalize,speedExponent}=URBAN_TUNABLE;
  if(speedKmh<vMinNormalize)return value;
  return value*Math.pow(vRefUrban/speedKmh,speedExponent);
}

function scoreAndClassify(features,triggerTs,waveform){
  const speed=S.lastPos?.speed||0;
  const ampNorm=Math.min(1,normalizeByVelocity(features.peakAmp,speed)/URBAN_TUNABLE.ampCeiling);

  // Clasificar tipo PRIMERO — los badenes tienen fórmula de puntuación propia
  const type=classifyType(features);

  if(type==='speedbump'){
    // Badenes: firma físicamente suave (bajo jerk, sin bipolaridad, sin alta frecuencia)
    // — esas son sus características definitorias, no señal débil. La fórmula de impacto
    // agudo los penalizaría injustamente. Se valoran solo por amplitud normalizada.
    const bumpScore=Math.max(0,Math.min(100,ampNorm*100));
    if(bumpScore<15)return;
    const severity=bumpScore>=55?'moderado':'leve';
    registerEvent({triggerTs,speed,severity,score:bumpScore,type,features,waveform});
    return;
  }

  const jerkNorm=Math.min(1,features.jerkMax/URBAN_TUNABLE.jerkCeiling);

  const rawScore=
    URBAN_WEIGHTS.amp*ampNorm+
    URBAN_WEIGHTS.jerk*jerkNorm+
    URBAN_WEIGHTS.bipolarity*features.bipolarity+
    URBAN_WEIGHTS.freqEnergy*features.freqEnergy-
    URBAN_WEIGHTS.brakePenalty*features.brakeCorrelation;

  const score=Math.max(0,Math.min(100,rawScore*100));

  // Sin veto absoluto por frenado: la puerta de disparo (Fase 2.3) ya descarta
  // frenadas puras insuficientes. Un veto aquí descartaría baches reales que
  // ocurren mientras se frena — frecuente en ciudad. La correlación de frenado
  // penaliza el score de forma proporcional mediante brakePenalty (-0.10).
  if(score<URBAN_TUNABLE.scoreDiscardBelow)return;

  const severity=score>=URBAN_TUNABLE.severityGraveAt?'grave':score>=URBAN_TUNABLE.severityModerateAt?'moderado':'leve';
  registerEvent({triggerTs,speed,severity,score,type,features,waveform});
}

function classifyType(f){
  if(f.duration>220&&f.freqEnergy<0.15)return 'speedbump'; // largo, baja frecuencia
  if(f.duration<80&&f.bipolarity<0.2)return 'manhole';     // corto, sin rebote
  if(f.bipolarity>0.28&&f.freqEnergy>0.15)return 'pothole';// firma bipolar con frecuencia
  return 'unknown';
}

function registerEvent({triggerTs,speed,severity,score,type,features,waveform}){
  if(!S.lastPos)return;
  const pos=getBestPosition()||S.lastPos;
  const event={
    id:triggerTs+'_'+Math.random().toString(36).slice(2,7),
    ts:triggerTs,
    lat:pos.lat,lon:pos.lon,
    speed,type,severity,score,features,
    waveform:waveform||[],
    confirmed:false,confirmCount:1
  };
  S.noiseFilter.eventMask=true;S.noiseFilter.eventMaskTs=Date.now();
  S.urbanEvents.push(event);
  S._lastEventTs=triggerTs;
  S._recentUrbanEvent=true;setTimeout(()=>{S._recentUrbanEvent=false;},500);
  registerChartMark(severity==='grave'?'#EF4444':'#F59E0B','urban');
  onUrbanEventDetected(event);
  // Snapping asíncrono — no bloquea el registro
  snapToRoad(pos.lat,pos.lon).then(snapped=>{
    if(snapped.snapped){
      event.lat=snapped.lat;event.lon=snapped.lon;event.snapDist=snapped.snapDist;
    }
  });
  const frames=VIDEO_BUF.capturing
    ? extractFramesForEvent(event.ts,event.speed||0)
    : [];
  event._frameBlobs=frames;
  event._frameBlob=frames[1]?.blob||frames[0]?.blob;

  // Persistir cada frame en IndexedDB con su label como sufijo de clave
  frames.forEach(f => {
    saveImageBlob(event.id + '_' + f.label, f.blob);
  });
  event._hasStoredImages = frames.length > 0;

  // Añadir SIEMPRE a galería independientemente de frames
  addToGallery(event);
  if(frames.length>0) showEventThumbnail(event);

  // Invocar Gemini con el frame nominal (B) o el primero disponible
  if (event._frameBlob) {
    analyzeEventWithGemini(event, event._frameBlob).then(result => {
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
}
function showIOSPerm(){$('sensorPermModal')?.classList.remove('hidden');}
function grantIOS(){$('sensorPermModal')?.classList.add('hidden');DeviceMotionEvent.requestPermission().then(s=>{if(s==='granted'){S.sensorOK=true;$('btnIOS')?.classList.add('hidden');tryAccel();startCal();toast('Permiso concedido');}else toast('Permiso denegado');});}

// ─ calibración 6s ─────────────────────────────
function startCal(){
  if(!S.sensorOK){toast('Sensor no disponible');return;}
  S.calibrated=false;S.calPhase=1;S.calStart=Date.now();
  S.gravSamples=[];S.vibSamples=[];S.hpPrev=0;S.hpPrevIn=0;S.buf=[];
  $('calPanel')?.classList.remove('hidden');recalcMainLayout();
  $('calFill').style.width='0%';
  set('calMsg','Fase 1/2: mantén el teléfono quieto…');set('calStep','FASE 1/2');
  set('calLbl','Calibrando…');$('calIco').textContent='⏳';set('calVal','');
  $('btnCal')?.classList.remove('cal-ok');
}
function doCalSample(x,y,z){
  const el=Date.now()-S.calStart;
  $('calFill').style.width=Math.min(100,(el/6000)*100)+'%';
  if(S.calPhase===1){
    if(S.gravSamples.length>0){const l=S.gravSamples[S.gravSamples.length-1];if(Math.abs(x-l.x)+Math.abs(y-l.y)+Math.abs(z-l.z)>.5)return;}
    S.gravSamples.push({x,y,z});
    if(el>=3000&&S.gravSamples.length>=10){
      let mx=0,my=0,mz=0;S.gravSamples.forEach(s=>{mx+=s.x;my+=s.y;mz+=s.z;});
      mx/=S.gravSamples.length;my/=S.gravSamples.length;mz/=S.gravSamples.length;
      const mag=Math.sqrt(mx*mx+my*my+mz*mz);if(mag<.5){endCal(false,'vector inválido');return;}
      S.grav={x:mx/mag,y:my/mag,z:mz/mag};S.gravMag=mag;S.calPhase=2;S.hpPrev=0;S.hpPrevIn=0;
      set('calMsg','Fase 2/2: detectando vibración de fondo…');set('calStep','FASE 2/2');
    }
  }else if(S.calPhase===2){
    const g=S.grav;S.vibSamples.push(Math.abs(hpf(Math.abs(x*g.x+y*g.y+z*g.z-S.gravMag))));
    if(el>=6000)endCal(true);
  }
}
function endCal(ok,err=''){
  S.calPhase=0;$('calPanel')?.classList.add('hidden');
  if(!ok){recalcMainLayout();set('calLbl','Calibrar');$('calIco').textContent='🎯';set('calVal','Pulsa para calibrar');toast('⚠️ Calibración fallida: '+err);return;}
  if(S.vibSamples.length>0){S.noiseLevel=Math.max(DEF.noiseFloor,rmsA(S.vibSamples)*1.5);C.noiseFloor=S.noiseLevel;saveCfg();}
  S.calibrated=true;S.hpPrev=0;S.hpPrevIn=0;S.buf=[];
  setChip('cSEN','dSEN','lSEN','ok','#10B981','SEN CAL');
  set('calLbl','Calibrado');$('calIco').textContent='✅';
  $('calVal').textContent='✓';$('calVal').style.color='var(--good)';
  $('btnCal')?.classList.add('cal-ok');
  $('calReqNote')?.classList.add('off');
  set('iriM','0.00');set('iriC','0.00');
  const cd=$('iriCond');if(cd){cd.textContent='Sin movimiento';cd.style.color='var(--dim)';}
  if(S.vibSamples.length>30){
    const wkTmp=buildWkCascade(S.comfort.fsActual||60);
    const skip=Math.floor(S.vibSamples.length*0.3);
    let sumSq=0,n=0;
    S.vibSamples.forEach((v,i)=>{const out=wkTmp(v);if(i>=skip){sumSq+=out*out;n++;}});
    const rmsBaseline=n>0?Math.sqrt(sumSq/n):0;
    const avBaseline=Math.sqrt(
      (1.0*rmsBaseline**2)+
      (1.96*(rmsBaseline*0.7)**2)+
      (1.96*(rmsBaseline*0.7)**2)
    );
    S.comfort.avBaseline=Math.min(avBaseline*1.1,0.5);
    console.log('[Comfort baseline] av='+S.comfort.avBaseline.toFixed(4));
  }
  recalcMainLayout();
  updateBaselineIndicator();
  setTimeout(updateBaselineIndicator,300);
  toast('✅ Todo listo — calibración completada · Ruido: '+S.noiseLevel.toFixed(3)+' m/s²');
}
function doCalibrate(){startCal();}

// ─ urban UI ───────────────────────────────────
function onUrbanEventDetected(event){
  // Marcador en mapa (no es DOM de panel — sin rAF)
  addEventMarkerToMap(event);
  // Toast solo para graves
  if(event.severity==='grave')toast('🕳️ Bache grave detectado');
  // Vibración háptica
  if(navigator.vibrate&&event.severity!=='leve')navigator.vibrate(event.severity==='grave'?[80,40,80]:60);
  // Actualizaciones DOM via cola rAF
  queueUI('urban',()=>{
    const counts=S.urbanEvents.reduce((acc,e)=>{acc[e.severity]=(acc[e.severity]||0)+1;return acc;},{});
    set('uEventCount',S.urbanEvents.length.toString());
    set('uGraveCount',(counts.grave||0).toString());
    set('uModCount',(counts.moderado||0).toString());
    const icons={pothole:'🕳️',manhole:'⭕',speedbump:'⛰️',crack:'➰',unknown:'❓'};
    const el=$('uLastEvent');
    if(el)el.innerHTML=`${icons[event.type]||'❓'} ${capitalize(event.severity)} · score ${event.score.toFixed(0)} · ${event.speed.toFixed(0)} km/h`;
  });
  queueUI('urban_meas',()=>{
    const counts=S.urbanEvents.reduce((a,e)=>{a[e.severity]=(a[e.severity]||0)+1;return a;},{});
    set('muLeve',(counts.leve||0).toString());
    set('muMod',(counts.moderado||0).toString());
    set('muGrave',(counts.grave||0).toString());
    const last=S.urbanEvents[S.urbanEvents.length-1];
    if(last){const icons={pothole:'🕳️',manhole:'⭕',speedbump:'⛰️',unknown:'❓'};const mu=$('muLastEvent');if(mu)mu.textContent=`${icons[last.type]||'❓'} ${last.type} · ${last.severity} · score ${last.score.toFixed(0)}`;}
  });
}

function addEventMarkerToMap(event){
  const colors={leve:'#F59E0B',moderado:'#F97316',grave:'#EF4444'};
  const map=S.active?S.mapMeas:S.mapMain;
  if(!map)return;
  L.circleMarker([event.lat,event.lon],{
    radius:event.severity==='grave'?8:6,
    color:'#fff',weight:1.5,
    fillColor:colors[event.severity],fillOpacity:0.9
  }).addTo(map).bindTooltip(`${event.type} · ${event.severity} (${event.score.toFixed(0)})`);
}

// ─ IRI real-time ──────────────────────────────
function onVert(raw){
  const iriM=computeIRI(raw),kmh=S.lastPos?.speed||0,iriC=spdCorr(iriM,kmh);
  const now=Date.now();
  if(now-S.lastIRIUpd>65){S.lastIRIUpd=now;const _m=iriM,_c=iriC;queueUI('iri',()=>updateIRI(_m,_c));if(S.active&&!S.paused){queueUI('stats',updateStats);queueUI('comfort',()=>updateComfortUI(S.comfort.avLive));}}
  if(S.active&&!S.paused){S.iriMA+=iriM;S.iriCA+=iriC;S.iriN++;S.iriMax=Math.max(S.iriMax,iriC);S.iriMin=Math.min(S.iriMin,iriC);S.iriSum+=iriC;S.iriCnt++;if(iriC>5)registerChartMark('#EF4444','iri');updateReferenceSpectrum(S.hpPrev,kmh);}
  if(now-S.lastChartUpd>82){S.lastChartUpd=now;S.chartZ.push(+Math.abs(S.hpPrev).toFixed(3));S.chartI.push(+iriC.toFixed(3));if(S.chartZ.length>S.chartMax){S.chartZ.shift();S.chartI.shift();}updateCharts();}
}
function updateIRI(m,c){
  const eM=$('iriM'),eC=$('iriC'),eCond=$('iriCond');
  if(eM){eM.textContent=m.toFixed(2);eM.className='iri-val '+iCls(m);}
  if(eC){eC.textContent=c.toFixed(2);eC.className='iri-val '+iCls(c);}
  if(eCond&&c>0){eCond.textContent=iLbl(c);eCond.style.color=iCol(c);}
  const cur=$('iriCur');if(cur)cur.style.left=Math.min(100,(c/10)*100)+'%';
  const aM=$('aIriM'),aC=$('aIriC'),aCd=$('aCond'),cM=$('mCardM'),cC=$('mCardC');
  if(aM){aM.textContent=m.toFixed(2);aM.style.color=iCol(m);}
  if(aC){aC.textContent=c.toFixed(2);aC.style.color=iCol(c);}
  if(aCd){aCd.textContent=iLbl(c);aCd.style.color=iCol(c);}
  if(cM)cM.className='m-card '+iCls(m);if(cC)cC.className='m-card '+iCls(c);
}
function updateStats(){set('aMax',S.iriMax.toFixed(2));set('aMin',S.iriMin===Infinity?'—':S.iriMin.toFixed(2));set('aMed',S.iriCnt?(S.iriSum/S.iriCnt).toFixed(2):'—');}

// ─ Charts ─────────────────────────────────────
// IMPORTANTE: y y y1 con display:false para que Chart.js
// no reserve espacio para los ejes → sin solapamiento con la leyenda HTML
function makeChart(id,zCol='#3A5F7A'){
  const ctx=$(id)?.getContext('2d');if(!ctx)return null;
  return new Chart(ctx,{type:'line',data:{labels:[],datasets:[
    {label:'Acel.',data:[],borderColor:zCol,yAxisID:'y',tension:.3,pointRadius:0,fill:false},
    {label:'IRI',data:[],borderColor:'#F59E0B',yAxisID:'y1',tension:.3,pointRadius:0,fill:false,
      segment:{borderColor:c=>iCol(c.p1.raw||0)}}
  ]},options:{
    responsive:true,maintainAspectRatio:false,animation:false,
    layout:{padding:0},
    scales:{
      x:{display:false},
      y:{display:false},   // ← COMPLETAMENTE OCULTO: no ocupa espacio ni solapa
      y1:{display:false}   // ← COMPLETAMENTE OCULTO: no ocupa espacio ni solapa
    },
    plugins:{legend:{display:false}}
  }});
}
function updateCharts(){
  if(!S.chartMeas)return;
  const lbl=S.chartZ.map((_,i)=>i),mxZ=Math.max(...S.chartZ,.05),mxI=Math.max(...S.chartI,.5);
  const c=S.chartMeas;
  c.data.labels=lbl;c.data.datasets[0].data=S.chartZ;c.data.datasets[1].data=S.chartI;
  c.options.scales.y.max=Math.max(.1,mxZ*1.4);
  c.options.scales.y1.max=Math.max(1,mxI*1.4);
  c.update('none');
}

// Plugin línea vertical para gráfico de detalle
const vertLinePlugin={
  id:'vl',
  afterDatasetsDraw(chart){
    if(chart._hlIdx===undefined||chart._hlIdx<0)return;
    const ds=chart.getDatasetMeta(0);
    if(!ds?.data[chart._hlIdx])return;
    const x=ds.data[chart._hlIdx].x,{top,bottom}=chart.chartArea,ctx=chart.ctx;
    ctx.save();ctx.beginPath();ctx.strokeStyle='rgba(255,255,255,.45)';ctx.lineWidth=1.5;
    ctx.setLineDash([4,4]);ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();ctx.restore();
  }
};

function makeDetailChart(route){
  const ctx=$('detailChart')?.getContext('2d');if(!ctx)return;
  if(S.chartDetail){S.chartDetail.destroy();S.chartDetail=null;}
  let d=0;const dists=[0];
  for(let i=1;i<route.pts.length;i++){d+=geo(route.pts[i-1].lat,route.pts[i-1].lon,route.pts[i].lat,route.pts[i].lon);dists.push(d);}
  S.chartDetail=new Chart(ctx,{
    type:'line',
    plugins:[vertLinePlugin],
    data:{labels:dists.map(d=>d.toFixed(0)),datasets:[
      {label:'IRI Corregido (m/km)',data:route.pts.map(p=>p.iri_c),borderColor:'#F59E0B',yAxisID:'yI',tension:.3,
        pointRadius:3,pointHoverRadius:7,fill:false,segment:{borderColor:c=>iCol(c.p1.raw||0)}},
      {label:'Velocidad (km/h)',data:route.pts.map(p=>p.speed),borderColor:'#0EA5E9',yAxisID:'yS',tension:.3,
        pointRadius:0,fill:false}
    ]},
    options:{
      responsive:true,maintainAspectRatio:false,animation:false,
      onClick(e){
        const el=S.chartDetail.getElementsAtEventForMode(e,'index',{intersect:false},true);
        if(el.length)syncFromChart(el[0].index);
      },
      onHover(e){
        const el=S.chartDetail.getElementsAtEventForMode(e,'index',{intersect:false},true);
        if(el.length)syncFromChart(el[0].index,false);
      },
      scales:{
        x:{title:{display:true,text:'Distancia (m)',color:'#3A5F7A',font:{size:11}},
          ticks:{color:'#3A5F7A',font:{family:'JetBrains Mono',size:11},maxTicksLimit:7}},
        yI:{type:'linear',position:'left',min:0,
          title:{display:true,text:'IRI (m/km)',color:'#F59E0B',font:{size:11}},
          ticks:{color:'#F59E0B',font:{family:'JetBrains Mono',size:11}},
          grid:{color:'rgba(14,165,233,.06)'}},
        yS:{type:'linear',position:'right',min:0,
          title:{display:true,text:'km/h',color:'#0EA5E9',font:{size:11}},
          ticks:{color:'#0EA5E9',font:{family:'JetBrains Mono',size:11}},
          grid:{drawOnChartArea:false}}
      },
      plugins:{
        legend:{labels:{color:'#5A7E9C',font:{size:11},usePointStyle:true,pointStyle:'line'}},
        tooltip:{callbacks:{title:i=>'Dist: '+i[0].label+' m',label:i=>i.dataset.label+': '+parseFloat(i.raw).toFixed(2)}}
      }
    }
  });
  S.chartDetail._hlIdx=-1;
}

// Sincronía bidireccional: gráfico → mapa
function syncFromChart(idx,panMap=true){
  if(!S.curDetailRoute)return;
  const p=S.curDetailRoute.pts[idx];if(!p)return;
  // Línea vertical en gráfico
  S.chartDetail._hlIdx=idx;
  S.chartDetail.update('none');
  // Mover marcador en mapa
  if(S.mapDetail&&S.mkDetail){
    if(!S.mapDetail.hasLayer(S.mkDetail))S.mkDetail.addTo(S.mapDetail);
    S.mkDetail.setLatLng([p.lat,p.lon]);
    if(panMap)S.mapDetail.panTo([p.lat,p.lon]);
  }
  showPtInfo(idx,p);
}

// Sincronía bidireccional: mapa → gráfico
function syncFromMap(idx){
  if(!S.curDetailRoute||!S.chartDetail)return;
  const p=S.curDetailRoute.pts[idx];if(!p)return;
  S.chartDetail._hlIdx=idx;
  S.chartDetail.update('none');
  if(S.mapDetail&&S.mkDetail){
    if(!S.mapDetail.hasLayer(S.mkDetail))S.mkDetail.addTo(S.mapDetail);
    S.mkDetail.setLatLng([p.lat,p.lon]);
  }
  showPtInfo(idx,p);
}

// ─ Mapas ─────────────────────────────────────
// OSM estándar: fondo blanco/gris, calles reconocibles, muy fiable
const TILES='https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TOPT={maxZoom:19,subdomains:['a','b','c'],attribution:'© OpenStreetMap contributors'};

function _mkMap(id,zoom){
  const el=$(id);if(!el){console.error('[MAP] not found:',id);return null;}
  try{
    const map=L.map(el,{zoomControl:false,attributionControl:false});
    L.tileLayer(TILES,TOPT).addTo(map);
    map.setView([40.4168,-3.7038],zoom);
    try{map.invalidateSize();}catch(e){}
    if('ResizeObserver' in window){
      new ResizeObserver(()=>{try{map.invalidateSize();}catch(e){}}).observe(el.parentElement||el);
    }
    return map;
  }catch(e){console.error('[MAP] init error:',e);return null;}
}

function initStaticMaps(){
  S.mapMain=_mkMap('mapMain',6);
  S.mapVisor=_mkMap('mapVisor',6);
  if(S.mapVisor)L.control.zoom({position:'bottomright'}).addTo(S.mapVisor);
  [300,800,1600].forEach(t=>setTimeout(()=>{[S.mapMain,S.mapVisor].forEach(m=>{try{m&&m.invalidateSize();}catch(e){}});},t));
}

// mapMeas: lazy — solo cuando #meas-sc es visible
function initMeasMap(){
  if(S.mapMeas)return;
  const el=$('mapMeas'),parent=el?.closest('.m-map');if(!el||!parent)return;
  const h=parent.getBoundingClientRect().height||200;
  el.style.height=h+'px';el.style.width='100%';
  try{
    S.mapMeas=L.map(el,{zoomControl:false,attributionControl:false});
    L.tileLayer(TILES,TOPT).addTo(S.mapMeas);
    S.lineMeas=L.polyline([],{color:'#0EA5E9',weight:6,opacity:.95}).addTo(S.mapMeas);
    if(S.lastPos)S.mapMeas.setView([S.lastPos.lat,S.lastPos.lon],17);
    else S.mapMeas.setView([40.4168,-3.7038],16);
    try{S.mapMeas.invalidateSize();}catch(e){}
    if('ResizeObserver' in window){
      new ResizeObserver(()=>{
        const nh=parent.getBoundingClientRect().height;
        if(nh>0){el.style.height=nh+'px';try{S.mapMeas.invalidateSize();}catch(e){}}
      }).observe(parent);
    }
  }catch(e){console.error('[MAP] meas error:',e);}
}

// ─ Measurement ────────────────────────────────
async function startMeasurement(){
  if(!S.calibrated){
    toast('⚠️ Calibra el sensor antes de medir (pulsa 🎯)');
    const b=$('btnCal');if(b){b.style.borderColor='var(--bad)';setTimeout(()=>b.style.borderColor='',2000);}
    return;
  }
  if(S.activeModes.has('iri')&&!S.vehicleId){toast('⚠️ Selecciona un vehículo para el modo Carretera');openGarage();return;}
  S.active=true;S.paused=false;S.dist=0;S._sessionStart=Date.now();S._recentUrbanEvent=false;
  S.adaptiveCal={active:false,gravBuf:[],gravBufMax:180,lastUpdate:0,updateCount:0,driftDeg:0,driftThresholdDeg:2.0,status:'idle',_stopStart:null};
  S._manualRecalRequest=false;
  S.buf=[];S.chartZ=[];S.chartI=[];S.hpPrev=0;S.hpPrevIn=0;
  EKG.buf.marks=[];EKG.buf.totalSamples=0;
  GAL.items=[];GAL.idx=0;GAL.activeFrameIdx=1;VIDEO_BUF.frames=[];
  S.lineMeas?.setLatLngs([]);

  if(S.activeModes.has('urban')){
    S.urbanEvents=[];S.urbanBuf=[];S._lastEventTs=null;
    S.groundTruth=[];
    S.noiseBaseline={mean:0,std:0.05,samples:[]};
    S.noiseFilter={eventMask:false,eventMaskTs:0,percentile15:0,appliedPost:false,refBuf:[],refBufMax:600,refSpectrum:null};
    set('uEventCount','0');set('uGraveCount','0');set('uModCount','0');
    const lEl=$('uLastEvent');if(lEl)lEl.textContent='Sin eventos detectados aún';
    const lblBtn=$('urbanLabelBtn');if(lblBtn)lblBtn.style.display='block';
  }
  if(S.activeModes.has('comfort')){
    const cf=S.comfort;
    cf.pts=[];cf.segments=[];cf._currentSegPts=[];
    cf.sumPow4Z=0;cf.sumPow4X=0;cf.sumPow4Y=0;
    cf.sumSqZ=0;cf.sumSqX=0;cf.sumSqY=0;cf.sumN=0;
    cf.avLive=0;cf.rmsWindowZ=[];cf.rmsWindowX=[];cf.rmsWindowY=[];
    cf._dtBuffer=[];cf._lastTs=null;cf._lastVdvTs=null;
    cf._segStartPow4Z=0;cf._segDist=0;
    rebuildComfortFilters(cf.fsActual);
  }
  if(S.activeModes.has('iri')){
    S.pts=[];S.segCount=0;
    S.iriMA=0;S.iriCA=0;S.iriN=0;S.iriMax=0;S.iriMin=Infinity;S.iriSum=0;S.iriCnt=0;
  }

  if(S.activeModes.has('urban')||S.activeModes.has('comfort')){
    initCameraSelector().catch(e=>console.log('[Cámara] Error en inicio: '+e.message));
  }
  if(S.activeModes.has('urban')){
    initYOLO();
  }
  $('meas-sc').classList.remove('hidden');
  updateMeasPanel();
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    initMeasMap();
    if(S.lastPos&&S.mapMeas)mapCenter(S.mapMeas,S.lastPos.lat,S.lastPos.lon,17);
  }));
  ['aMax','aMed','aMin'].forEach(id=>set(id,'—'));set('aSegs','0');
  $('btnPause').classList.remove('hidden');$('btnResume').classList.add('hidden');
  startTimer();
  try {
    navigator.mediaDevices.getUserMedia({video:true,audio:false})
      .then(s => {
        toast('✅ Cámara OK: '+s.getVideoTracks()[0].label);
        s.getTracks().forEach(t=>t.stop());
      })
      .catch(e => toast('❌ Cámara error: '+e.name));
  } catch(e) {
    toast('❌ Excepción: '+e.message);
  }
}
function pauseMeasurement(){S.paused=true;$('btnPause').classList.add('hidden');$('btnResume').classList.remove('hidden');toast('⏸ Pausado');}
function resumeMeasurement(){S.paused=false;$('btnPause').classList.remove('hidden');$('btnResume').classList.add('hidden');toast('▶ Reanudado');}
function stopMeasurement(){
  $('cameraSelectorModal')?.classList.add('hidden');
  S.active=false;
  S.paused=false;stopTimer();$('meas-sc').classList.add('hidden');
  stopVideoBuffer();EKG.buf.marks=[];EKG.buf.totalSamples=0;
  const lblBtn=$('urbanLabelBtn');if(lblBtn)lblBtn.style.display='none';

  const modesUsed=[...S.activeModes];
  let iriData=null,urbanData=null,comfortData=null;

  if(S.activeModes.has('urban')){
    // Solo marcar como pendiente — se construirá en confirmSave() tras validación
    urbanData={ pending: true };
    // Análisis automático de ruido — sin esperar acción del usuario
    if (S.urbanEvents.length >= 5) {
      markNoiseCandidates();
    }
    if(S.groundTruth&&S.groundTruth.length>0)
      showValidationResults();
  }
  if(S.activeModes.has('comfort')){
    comfortData=collectComfortData();
  }
  if(S.activeModes.has('iri')&&S.pts.length>=2){
    const segs=segmentize(S.pts,C.segLen),allC=S.pts.map(p=>p.iri_c),allM=S.pts.map(p=>p.iri_m);
    iriData={segs,avgC:allC.reduce((a,b)=>a+b,0)/allC.length,avgM:allM.reduce((a,b)=>a+b,0)/allM.length,vehicleId:S.vehicleId};
  }

  if(!iriData&&!urbanData&&!comfortData){
    // En modo urbano siempre hay urbanData aunque
    // no haya eventos — guardar igualmente
    if(!S.activeModes.has('urban')){
      toast('Sin datos suficientes');return;
    }
    urbanData={events:[],count:0};
  }

  const pts=S.activeModes.has('iri')?S.pts:(S.comfort.pts||[]);
  S.pendingRoute={
    id:Date.now().toString(),date:new Date().toISOString(),modesUsed,
    pts,dist:S.dist,segLen:C.segLen,
    segs:iriData?.segs||[],avgC:iriData?.avgC??null,avgM:iriData?.avgM??null,
    vehicleId:iriData?.vehicleId||null,
    iriData,urbanData,comfortData
  };
  showValidateModal();
}
function buildUrbanDataFinal() {
  if (!S.activeModes.has('urban')) return null;

  const eventsClean = S.urbanEvents.map(
    ({_frameBlobs,_frameBlob,_clipBlobs,...e}) => e
  );

  if (eventsClean.length > 0) {
    mergeEventsIntoStorage(eventsClean);
  }

  const validationComplete = eventsClean.length > 0 &&
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

function showValidateModal(){
  const n=GAL.items.length;
  if(n===0){showRouteNameModal();return;}
  set('vnCount',n.toString());
  const modal=$('validateNowModal');
  if(!modal){showRouteNameModal();return;}
  modal.classList.remove('hidden');
}
function validateNow(){
  $('validateNowModal').classList.add('hidden');
  openEventGallery();
}
function validateLater(){
  $('validateNowModal').classList.add('hidden');
  showRouteNameModal();
}
function showRouteNameModal(){
  $('routeNameInput').value='';
  const modal=$('routeNameModal');
  if(modal){
    modal.style.zIndex='9999';
    modal.classList.remove('hidden');
  }
  updateNoiseFilterUI();
}
function collectComfortData(){
  const cf=S.comfort;
  if(cf._currentSegPts.length>0)closeComfortSegment();
  if(cf.pts.length<2)return null;
  const allAv=cf.pts.map(p=>p.av);
  const avgAv=Math.sqrt(allAv.reduce((s,v)=>s+v*v,0)/allAv.length);
  return{pts:cf.pts,segments:cf.segments,avgAv,
    vdvSession:{z:getVDV('Z'),x:getVDV('X'),y:getVDV('Y')},
    vehicleProfile:cf.vehicleProfile,fsUsed:cf.fsActual};
}

function confirmSave(){
  if(!S.pendingRoute)return;
  const r=S.pendingRoute;

  // Construir urbanData final AHORA, con todas las validaciones ya aplicadas
  if (r.urbanData?.pending) {
    r.urbanData = buildUrbanDataFinal() || {events:[],count:0};
  }

  r.name=$('routeNameInput').value.trim()||fmtD(Date.parse(r.date));
  saveRoute(r);$('routeNameModal').classList.add('hidden');

  // Mantener referencia con los _frameBlobs vivos para generar informe inmediato
  S._lastSavedRouteWithBlobs = {
    ...r,
    urbanData: r.urbanData ? {
      ...r.urbanData,
      events: S.urbanEvents.map(e => ({...e}))
    } : r.urbanData
  };

  const modesUsed=r.modesUsed||['iri'];
  const parts=[];
  if(modesUsed.includes('iri')&&r.avgC!=null)parts.push('IRI '+r.avgC.toFixed(2)+' m/km');
  if(modesUsed.includes('comfort')&&r.comfortData)parts.push('a_v '+r.comfortData.avgAv.toFixed(3)+' m/s²');
  if(modesUsed.includes('urban')&&r.urbanData)parts.push(r.urbanData.events.length+' eventos');
  toast('✅ Guardado · '+(parts.join(' · ')||'OK'));
  S.pendingRoute=null;
}
function discardRoute(){S.pendingRoute=null;$('routeNameModal').classList.add('hidden');toast('Ruta descartada');}
function applyPostProcessNoise(){
  markNoiseCandidates();
}

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
  S.noiseFilter.appliedPost = true;

  toast(marked > 0
    ? `🟡 ${marked} evento(s) candidato(s) a ruido — revísalos en la galería`
    : 'Sin candidatos a ruido detectados');

  queueUI('gallery_refresh', () => {
    if (GAL.idx < GAL.items.length) renderGalleryItem(GAL.idx);
  });
  updateNoiseFilterUI();
}
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
function startTimer(){S.timerStart=Date.now();S.timerRef=setInterval(()=>{if(S.paused)return;const e=Math.floor((Date.now()-S.timerStart)/1000);set('measTimer',String(Math.floor(e/60)).padStart(2,'0')+':'+String(e%60).padStart(2,'0'));},500);}
function stopTimer(){clearInterval(S.timerRef);S.timerRef=null;}
function segmentize(pts,sLen){
  const segs=[];if(pts.length<2)return segs;
  let cur={pts:[pts[0]],mS:0,cS:0,spS:0,n:0,d:0};
  for(let i=1;i<pts.length;i++){
    const p=pts[i-1],c=pts[i],d=geo(p.lat,p.lon,c.lat,c.lon);
    cur.pts.push(c);cur.mS+=c.iri_m;cur.cS+=c.iri_c;cur.spS+=c.speed;cur.n++;cur.d+=d;
    if(cur.d>=sLen||i===pts.length-1){const ac=cur.cS/cur.n;segs.push({pts:[...cur.pts],iriM:cur.mS/cur.n,iriC:ac,speedAvg:cur.spS/cur.n,dist:cur.d,color:iCol(ac)});cur={pts:[c],mS:0,cS:0,spS:0,n:0,d:0};}
  }return segs;
}
function rOvlp(r1,r2,thr=25){const p1=r1.pts||[],p2=r2.pts||[];for(let i=0;i<p1.length;i+=4)for(let j=0;j<p2.length;j+=4)if(geo(p1[i].lat,p1[i].lon,p2[j].lat,p2[j].lon)<=thr)return true;return false;}

// ─ urban storage & merge ──────────────────────
function mergeEventsIntoStorage(newEvents){
  let stored;
  try{stored=JSON.parse(localStorage.getItem('rc_urban_events')||'[]');}catch(e){stored=[];}
  const PROXIMITY_M=4; // radio de agrupación en metros

  newEvents.forEach(ev=>{
    const match=stored.find(s=>geo(s.lat,s.lon,ev.lat,ev.lon)<=PROXIMITY_M&&s.type===ev.type);
    if(match){
      match.confirmCount++;
      match.score=(match.score*(match.confirmCount-1)+ev.score)/match.confirmCount; // media móvil
      match.confirmed=match.confirmCount>=2;
      match.lastSeen=ev.ts;
    }else{
      const {_frameBlobs,_frameBlob,_clipBlobs,...evClean}=ev;
      stored.push({...evClean,lastSeen:ev.ts});
    }
  });
  try{
    localStorage.setItem('rc_urban_events',JSON.stringify(stored));
  }catch(e){
    console.error('[merge]',e.message);
    toast('⚠️ Error guardando eventos: '+e.message);
  }
}

// ─ History ────────────────────────────────────
const MODE_ICONS={iri:'🛣️',urban:'🏙️',comfort:'📳'};
function modeBadgesHtml(modesUsed){
  return modesUsed.map(m=>MODE_ICONS[m]||m).join('+');
}
function loadHistory(){
  // Unified routes (new format) + legacy comfort routes (old format)
  const unified=allRoutes().map(r=>({...r,modesUsed:r.modesUsed||['iri'],_src:'unified'}));
  const legacyComfort=allComfortRoutes().map(r=>({...r,modesUsed:['comfort'],_src:'comfort'}));
  const allR=[...unified,...legacyComfort].sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
  const search=($('histSearch')?.value||'').toLowerCase();
  const cont=$('histList');if(!cont)return;
  const f=allR.filter(r=>(r.name||'').toLowerCase().includes(search)||(fmtD(Date.parse(r.date))).includes(search));
  if(!f.length){cont.innerHTML='<div class="empty-st"><div class="empty-ico">🛣️</div><p class="empty-txt">'+(allR.length?'Sin resultados.':'Sin rutas guardadas.')+'</p></div>';return;}
  cont.innerHTML=f.map(r=>{
    const dt=(r.dist||0)<1000?(r.dist||0).toFixed(0)+' m':((r.dist||0)/1000).toFixed(2)+' km';
    const modes=r.modesUsed||['iri'];
    const mIcons=modeBadgesHtml(modes);
    const isLegacyComfort=r._src==='comfort';

    // Legacy comfort route (old rc_comfort_routes format)
    if(isLegacyComfort){
      const av=(r.avgAv||0).toFixed(3),cls=classifyComfort(r.avgAv||0);
      return`<div class="route-card">
        <div class="rc-ind" style="background:${cls.color}"></div>
        <div class="rc-body"><div class="rc-name">${escH(r.name||fmtD(Date.parse(r.date)))}</div>
        <div class="rc-meta"><span>${mIcons}</span><span>📏 ${dt}</span><span>🗓 ${fmtD(Date.parse(r.date))}</span></div>
        <span class="iri-badge" style="background:rgba(14,165,233,.1);color:#0EA5E9;border:1px solid rgba(14,165,233,.25)">a_v ${av} m/s² — ${cls.label}</span></div>
        <div class="rc-acts">
          <button class="rca" onclick="expComfortXLSX('${r.id}')"><span class="rca-ico">📊</span>Excel</button>
          <button class="rca" onclick="expComfortHTML('${r.id}')"><span class="rca-ico">📈</span>Informe</button>
          <button class="rca del" onclick="delComfortRoute('${r.id}');loadHistory();toast('Eliminada')"><span class="rca-ico">🗑</span>Borrar</button>
        </div></div>`;
    }

    // Unified route — build summary badges per mode
    const badges=[];
    if(modes.includes('iri')&&r.avgC!=null)badges.push(`<span class="iri-badge ${iCls(r.avgC)}">IRI ${r.avgC.toFixed(2)} — ${iLbl(r.avgC)}</span>`);
    if(modes.includes('comfort')&&r.comfortData){const cls=classifyComfort(r.comfortData.avgAv||0);badges.push(`<span class="iri-badge" style="background:rgba(168,85,247,.1);color:#A855F7;border:1px solid rgba(168,85,247,.25)">a_v ${(r.comfortData.avgAv||0).toFixed(3)} m/s²</span>`);}
    if(modes.includes('urban')&&r.urbanData)badges.push(`<span class="iri-badge" style="background:rgba(245,158,11,.1);color:#F59E0B;border:1px solid rgba(245,158,11,.25)">${r.urbanData.events.length} eventos</span>`);

    const pendingBadge = r.urbanData && r.urbanData.validationComplete===false
      ? `<span class="route-pending-badge">⏳ ${r.urbanData.pendingCount} sin validar</span>`
      : '';

    const canOpenDetail=modes.includes('iri')&&(r.segs||[]).length>0;
    const clickAttr=canOpenDetail?`onclick="openDetail('${r.id}')" style="cursor:pointer"`:'';
    const stopProp=canOpenDetail?'event.stopPropagation();':'';
    const actsExtra=canOpenDetail?`
          <button class="rca" onclick="${stopProp}expKML('${r.id}')"><span class="rca-ico">🌍</span>KML</button>
          <button class="rca" onclick="${stopProp}expJSON('${r.id}')"><span class="rca-ico">{ }</span>JSON</button>`:'';
    const continueValBtn = r.urbanData?.validationComplete===false
      ? `<button class="rca" onclick="event.stopPropagation();continueValidation('${r.id}')"><span class="rca-ico">🔍</span>Validar</button>`
      : '';

    return`<div class="route-card" ${clickAttr}>
      <div class="rc-ind" style="background:${r.avgC!=null?iCol(r.avgC):'#A855F7'}"></div>
      <div class="rc-body"><div class="rc-name">${escH(r.name||fmtD(Date.parse(r.date)))}${pendingBadge}</div>
      <div class="rc-meta"><span>${mIcons}</span><span>📏 ${dt}</span><span>🗓 ${fmtD(Date.parse(r.date))}</span></div>
      ${badges.join(' ')}</div>
      <div class="rc-acts">
        ${continueValBtn}
        <button class="rca" onclick="${stopProp}expXLSX('${r.id}')"><span class="rca-ico">📊</span>Excel</button>
        <button class="rca" onclick="${stopProp}expHTML('${r.id}')"><span class="rca-ico">📈</span>Informe</button>${actsExtra}
        <button class="rca del" onclick="${stopProp}deleteRoute('${r.id}')"><span class="rca-ico">🗑</span>Borrar</button>
      </div></div>`;
  }).join('');
}
function filterHistory(q){loadHistory();}
function deleteRoute(id){if(confirm('¿Eliminar esta ruta?')){delRoute(id);loadHistory();toast('Eliminada');}}
function clearAllHistory(){if(confirm('¿Borrar TODAS las rutas?')){clearRoutes();loadHistory();toast('Historial borrado');}}

// ─ Route detail ───────────────────────────────
function openDetail(id){
  const route=allRoutes().find(r=>r.id===id);if(!route)return;
  S.curDetail=route;
  const others=allRoutes().filter(r=>r.id!==id&&rOvlp(route,r));
  if(others.length){
    $('overlapList').innerHTML=others.map(r=>`<li>${escH(r.name||fmtD(Date.parse(r.date)))}</li>`).join('');
    $('overlapModal').classList.remove('hidden');
    S.overlapCb=c=>showDetail(route,c?others:[]);
  }else showDetail(route,[]);
}
function resolveOverlap(c){$('overlapModal').classList.add('hidden');if(S.overlapCb){S.overlapCb(c);S.overlapCb=null;}}
function showDetail(route,others){
  let dr=route;if(others.length)dr=mergeRoute(route,others);
  S.curDetailRoute=dr;
  $('detail-sc').classList.remove('hidden');
  const dt=route.dist<1000?route.dist.toFixed(0)+' m':(route.dist/1000).toFixed(2)+' km';
  const avgS=route.pts.length?route.pts.reduce((s,p)=>s+p.speed,0)/route.pts.length:0;
  set('detailTitle',escH(route.name||fmtD(Date.parse(route.date))));
  set('dIRI',(dr.avgC||0).toFixed(3));set('dDist',dt);set('dSpeed',avgS.toFixed(1)+' km/h');set('dSegs',(dr.segs||[]).length.toString());
  $('dPtInfo').textContent='Toca el gráfico o un punto de la ruta en el mapa para inspeccionar';
  // Mostrar botón continuar validación si hay pendientes
  const btn=$('btnContinueValidation');
  if(btn){
    const pending=route.urbanData&&route.urbanData.validationComplete===false;
    btn.style.display=pending?'block':'none';
    btn.dataset.routeId=route.id;
  }
  // Inicializar tras render
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    initDetailMap(dr);
    makeDetailChart(dr);
  }));
}
function mergeRoute(base,others){
  const merged=base.pts.map(p=>{let sC=p.iri_c,sM=p.iri_m,n=1;others.forEach(r=>{const nr=r.pts.find(q=>geo(p.lat,p.lon,q.lat,q.lon)<15);if(nr){sC+=nr.iri_c;sM+=nr.iri_m;n++;}});return{...p,iri_c:sC/n,iri_m:sM/n};});
  const segs=segmentize(merged,base.segLen||C.segLen),allC=merged.map(p=>p.iri_c);
  return{...base,pts:merged,segs,avgC:allC.reduce((a,b)=>a+b,0)/allC.length};
}
function closeDetail(){
  $('detail-sc').classList.add('hidden');
  if(S.mapDetail){try{S.mapDetail.remove();}catch(e){}S.mapDetail=null;}
  if(S.chartDetail){S.chartDetail.destroy();S.chartDetail=null;}
  S.curDetail=null;S.curDetailRoute=null;
}

function initDetailMap(route){
  if(S.mapDetail){try{S.mapDetail.remove();}catch(e){}S.mapDetail=null;}
  const el=$('detailMapInner');if(!el)return;
  // ★ Establecer altura explícita en px antes de que Leaflet lea las dimensiones
  const parent=el.closest('.d-map');
  const h=(parent?.getBoundingClientRect().height)||195;
  el.style.height=h+'px';
  el.style.width='100%';
  try{
    S.mapDetail=L.map(el,{zoomControl:true,attributionControl:false});
    L.tileLayer(TILES,TOPT).addTo(S.mapDetail);
    // Dibujar segmentos coloreados
    (route.segs||[]).forEach(seg=>{
      const coords=(seg.pts||[]).map(p=>[p.lat,p.lon]);if(coords.length<2)return;
      L.polyline(coords,{color:seg.color||iCol(seg.iriC),weight:7,opacity:.92})
        .addTo(S.mapDetail)
        .bindTooltip('IRI: '+(seg.iriC||0).toFixed(2)+' · '+(seg.dist||0).toFixed(0)+'m · '+iLbl(seg.iriC),{permanent:false});
    });
    // ★ Marcadores invisibles en cada punto GPS para sincronía mapa→gráfico
    route.pts.forEach((p,idx)=>{
      L.circleMarker([p.lat,p.lon],{
        radius:6,color:'transparent',fillColor:'transparent',fillOpacity:0,
        // Área de toque amplia
        bubblingMouseEvents:false
      }).addTo(S.mapDetail)
        .on('click',()=>syncFromMap(idx))
        .on('mouseover',()=>syncFromMap(idx));
    });
    // Marcador de punto seleccionado
    S.mkDetail=L.circleMarker([0,0],{radius:9,color:'#fff',weight:2.5,fillColor:'#F59E0B',fillOpacity:1});
    // Ajustar vista
    const allP=route.pts.map(p=>[p.lat,p.lon]);
    if(allP.length)S.mapDetail.fitBounds(L.latLngBounds(allP),{padding:[18,18]});
    try{S.mapDetail.invalidateSize();}catch(e){}
    if('ResizeObserver' in window){
      new ResizeObserver(()=>{try{S.mapDetail?.invalidateSize();}catch(e){}}).observe(el.parentElement||el);
    }
  }catch(e){console.error('[MAP] detail error:',e);}
}
function showPtInfo(idx,p){
  $('dPtInfo').innerHTML='<b>#'+(idx+1)+'</b> · Lat <span>'+p.lat.toFixed(5)+'</span> · Lon <span>'+p.lon.toFixed(5)+'</span> · Vel <span>'+p.speed.toFixed(1)+' km/h</span> · IRI_m <span style="color:#0EA5E9">'+p.iri_m.toFixed(3)+'</span> · IRI_c <span style="color:'+iCol(p.iri_c)+'">'+p.iri_c.toFixed(3)+'</span>';
}
function exportCurXLSX(){if(S.curDetail)expXLSX(S.curDetail.id);}
function exportCurHTML(){if(S.curDetail)expHTML(S.curDetail.id);}
function exportCurKML(){if(S.curDetail)expKML(S.curDetail.id);}
function exportCurJSON(){if(S.curDetail)expJSON(S.curDetail.id);}

// ─ Visor ──────────────────────────────────────
function loadVisor(){
  const routes=allRoutes(),cont=$('routeCheckboxes');if(!cont)return;
  if(!routes.length){cont.innerHTML='<p style="font-size:.62rem;color:var(--dim);padding:4px;font-family:var(--mono)">Sin rutas</p>';return;}
  cont.innerHTML=routes.map(r=>`<label class="chk-row"><input type="checkbox" value="${r.id}" ${S.selRoutes.has(r.id)?'checked':''} onchange="onVCb(this)"><div class="chk-col" style="background:${iCol(r.avgC||0)}"></div><span style="flex:1;font-size:.67rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escH(r.name||fmtD(Date.parse(r.date)))}</span><span class="tag">${(r.dist/1000).toFixed(1)}km</span></label>`).join('');
}
function onVCb(cb){cb.checked?S.selRoutes.add(cb.value):S.selRoutes.delete(cb.value);checkVOvlp();}
function toggleAllVisor(v){document.querySelectorAll('#routeCheckboxes input').forEach(cb=>{cb.checked=v;v?S.selRoutes.add(cb.value):S.selRoutes.delete(cb.value);});checkVOvlp();}
function toggleAvg(){S.showAvg=!S.showAvg;set('btnAvg',S.showAvg?'✓ Promediado':'Promediar solapadas');refreshVisor();}
function checkVOvlp(){
  const routes=allRoutes().filter(r=>S.selRoutes.has(r.id));let hasOv=false;
  outer:for(let i=0;i<routes.length-1;i++)for(let j=i+1;j<routes.length;j++)if(rOvlp(routes[i],routes[j])){hasOv=true;break outer;}
  if(hasOv){$('overlapList').innerHTML=allRoutes().filter(r=>S.selRoutes.has(r.id)).map(r=>`<li>${escH(r.name||fmtD(Date.parse(r.date)))}</li>`).join('');$('overlapModal').classList.remove('hidden');S.overlapCb=c=>{S.showAvg=c;refreshVisor()};}
  else refreshVisor();
}
function refreshVisor(){
  if(!S.mapVisor)return;
  S.mapVisor.eachLayer(l=>{
    if(!(l instanceof L.TileLayer)){try{S.mapVisor.removeLayer(l);}catch(e){}}
  });
  const mode=$('viewMode')?.value||'iri_c';

  if(mode==='comfort_heatmap'){
    const cr=allComfortRoutes();
    if(!cr.length){toast('Sin rutas de confort guardadas');return;}
    const allP=[];
    cr.forEach(route=>{
      (route.segments||[]).forEach(seg=>{
        const coords=(seg.pts||[]).map(p=>[p.lat,p.lon]);if(coords.length<2)return;
        L.polyline(coords,{color:seg.color||'#888',weight:7,opacity:.90})
          .addTo(S.mapVisor).bindTooltip('a_v: '+(seg.avAvg||0).toFixed(3)+' m/s² · '+seg.level);
        allP.push(...coords);
      });
    });
    if(allP.length)S.mapVisor.fitBounds(L.latLngBounds(allP),{padding:[20,20]});
    setTimeout(()=>{try{S.mapVisor.invalidateSize();}catch(e){}},100);
    return;
  }

  if(mode==='urban_events'){
    // Visualizar eventos urbanos almacenados
    let stored;
    try{stored=JSON.parse(localStorage.getItem('rc_urban_events')||'[]');}catch(e){stored=[];}
    if(!stored.length){toast('Sin eventos urbanos guardados');return;}
    const colors={leve:'#F59E0B',moderado:'#F97316',grave:'#EF4444'};
    const allP=[];
    stored.forEach(ev=>{
      const r=ev.confirmed?8:5,op=ev.confirmed?0.9:0.45;
      L.circleMarker([ev.lat,ev.lon],{
        radius:r,color:'#fff',weight:ev.confirmed?2:1,
        fillColor:colors[ev.severity]||'#888',fillOpacity:op
      }).addTo(S.mapVisor).bindTooltip(
        `${ev.type} · ${ev.severity} · score ${(ev.score||0).toFixed(0)}${ev.confirmed?' ✓ ('+ev.confirmCount+' pasadas)':' (candidato)'}`
      );
      allP.push([ev.lat,ev.lon]);
    });
    if(allP.length)S.mapVisor.fitBounds(L.latLngBounds(allP),{padding:[20,20]});
    setTimeout(()=>{try{S.mapVisor.invalidateSize();}catch(e){}},100);
    return;
  }

  const routes=allRoutes().filter(r=>S.selRoutes.has(r.id));
  if(!routes.length)return;
  routes.forEach(r=>(r.segs||[]).forEach(seg=>{
    const iri=mode==='iri_m'?seg.iriM:seg.iriC,coords=(seg.pts||[]).map(p=>[p.lat,p.lon]);
    if(coords.length<2)return;
    L.polyline(coords,{color:iCol(iri),weight:7,opacity:.90}).addTo(S.mapVisor).on('click',()=>{
      const c=$('segCard');c.classList.remove('hidden');
      c.innerHTML='<h5>Tramo seleccionado</h5><p>IRI Corregido: <strong>'+(seg.iriC||0).toFixed(3)+' m/km</strong></p><p>IRI Medido: <strong>'+(seg.iriM||0).toFixed(3)+' m/km</strong></p><p>Vel. media: <strong>'+(seg.speedAvg||0).toFixed(1)+' km/h</strong></p><p>Distancia: <strong>'+(seg.dist||0).toFixed(0)+' m</strong></p><p>Condición: <strong style="color:'+iCol(seg.iriC||0)+'">'+iLbl(seg.iriC||0)+'</strong></p>';
    });
  }));
  const allP=routes.flatMap(r=>(r.pts||[]).map(p=>[p.lat,p.lon]));
  if(allP.length)S.mapVisor.fitBounds(L.latLngBounds(allP),{padding:[14,14]});
  setTimeout(()=>{try{S.mapVisor.invalidateSize();}catch(e){}},100);
}

// ─ Exports ────────────────────────────────────
function dlBlob(c, t, n) {
  document.querySelectorAll('.modal-bg:not(.hidden)')
    .forEach(m => {
      if (m.id !== 'downloadReadyModal') {
        m.classList.add('hidden');
      }
    });

  const safeName = n.replace(/[\/\\:,*?"<>|]/g,'-')
                    .replace(/\s+/g,'_');
  const b = new Blob([c], { type: t });

  // Intentar Web Share API con archivo (Android)
  if (navigator.share && navigator.canShare) {
    const file = new File([b], safeName, { type: t });
    if (navigator.canShare({ files: [file] })) {
      navigator.share({
        title: 'Pavement Check — ' + safeName,
        files: [file]
      }).catch(e => {
        if (e.name !== 'AbortError') {
          // Fallback a descarga clásica si Web Share falla
          triggerClassicDownload(b, safeName, t);
        }
      });
      return;
    }
  }

  // Fallback: descarga clásica para PC o si
  // Web Share no está disponible
  triggerClassicDownload(b, safeName, t);
}

function triggerClassicDownload(blob, name, type) {
  const url = URL.createObjectURL(blob);
  const link = $('downloadReadyLink');
  link.href = url;
  link.download = name;
  link.target = '_self';
  set('downloadReadyInfo', name);
  $('downloadReadyModal').classList.remove('hidden');
  link.onclick = () => {
    setTimeout(() => {
      $('downloadReadyModal').classList.add('hidden');
      URL.revokeObjectURL(url);
    }, 2000);
  };
}
function expJSON(id){const r=allRoutes().find(r=>r.id===id);if(!r)return;dlBlob(JSON.stringify(r,null,2),'application/json','roadcheck_'+r.id.slice(-6)+'.json');toast('JSON exportado');}
function expKML(id){
  const r=allRoutes().find(r=>r.id===id);if(!r?.segs?.length)return;
  let k='<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n<name>'+escH(r.name||'Roadcheck IRI')+'</name>\n<Style id="g"><LineStyle><color>ff81b910</color><width>4</width></LineStyle></Style>\n<Style id="f"><LineStyle><color>ff0b9ef5</color><width>4</width></LineStyle></Style>\n<Style id="p"><LineStyle><color>ff4444ef</color><width>4</width></LineStyle></Style>\n';
  r.segs.forEach((s,i)=>{const st=s.iriC<=2.5?'g':s.iriC<=5?'f':'p';k+='<Placemark><name>Tramo '+(i+1)+'</name><description>IRI: '+(s.iriC||0).toFixed(3)+' | '+(s.dist||0).toFixed(0)+'m | '+iLbl(s.iriC)+'</description><styleUrl>#'+st+'</styleUrl><LineString><tessellate>1</tessellate><coordinates>'+(s.pts||[]).map(p=>(p.lon||0).toFixed(7)+','+p.lat.toFixed(7)+',0').join('\n')+'</coordinates></LineString></Placemark>\n';});
  k+='</Document></kml>';dlBlob(k,'application/vnd.google-earth.kml+xml','roadcheck_'+r.id.slice(-6)+'.kml');toast('KML exportado');
}
function expXLSX(id){const r=allRoutes().find(r=>r.id===id);if(!r)return;loadXLSX(()=>doXLSX(r));}
function loadXLSX(cb){if(typeof XLSX!=='undefined'){cb();return;}const s=document.createElement('script');s.src='https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js';s.onload=cb;s.onerror=()=>toast('Error cargando SheetJS');document.head.appendChild(s);}
function doXLSX(r){
  try{
  const wb=XLSX.utils.book_new();
  const modes=r.modesUsed||['iri'];

  // IRI sheets
  if(modes.includes('iri')&&r.pts?.length){
    let da=0;
    const rws=[['#','Fecha','Lat','Lon','Dist.(m)','Vel.(km/h)','IRI_Medido','IRI_Corregido','Condición']];
    r.pts.forEach((p,i)=>{if(i>0)da+=geo(r.pts[i-1].lat,r.pts[i-1].lon,p.lat,p.lon);rws.push([i+1,fmtD(p.ts),p.lat.toFixed(7),p.lon.toFixed(7),da.toFixed(1),(p.speed||0).toFixed(1),(p.iri_m||0).toFixed(4),(p.iri_c||0).toFixed(4),iLbl(p.iri_c)]);});
    const ws1=XLSX.utils.aoa_to_sheet(rws);ws1['!cols']=[{wch:5},{wch:18},{wch:13},{wch:13},{wch:11},{wch:11},{wch:13},{wch:14},{wch:10}];XLSX.utils.book_append_sheet(wb,ws1,'IRI_Datos');
    const sr=[['Tramo','IRI Medido','IRI Corregido','Vel.(km/h)','Dist.(m)','Condición']];
    (r.segs||[]).forEach((s,i)=>sr.push([i+1,(s.iriM||0).toFixed(3),(s.iriC||0).toFixed(3),(s.speedAvg||0).toFixed(1),(s.dist||0).toFixed(1),iLbl(s.iriC)]));
    const ws2=XLSX.utils.aoa_to_sheet(sr);XLSX.utils.book_append_sheet(wb,ws2,'IRI_Segmentos');
  }

  // Urban sheet — usar copia live si es la ruta recién guardada
  if(modes.includes('urban')&&r.urbanData?.events?.length){
    const liveRoute=(S._lastSavedRouteWithBlobs?.id===r.id&&S._lastSavedRouteWithBlobs?.urbanData?.events?.some(e=>e._frameBlobs))?S._lastSavedRouteWithBlobs:r;
    const ev=liveRoute.urbanData?.events||r.urbanData.events;
    const uw=[['#','Fecha','Lat','Lon','Vel.(km/h)','Tipo','Severidad','Score','Confirmado','Tipo (Gemini)','Severidad (Gemini)','Confianza','Descripción IA','Validado por IA','Validación','Candidato a ruido']];
    ev.forEach((e,i)=>uw.push([i+1,fmtD(e.ts),(e.lat||0).toFixed(7),(e.lon||0).toFixed(7),(e.speed||0).toFixed(1),e.type||'',e.severity||'',+(e.score||0).toFixed(1),e.confirmed?'Sí':'No',e.gemini?.type||'',e.gemini?.severity||'',e.gemini?.confidence!=null?+(e.gemini.confidence*100).toFixed(0)+'%':'',e.gemini?.description||'',e.gemini?(!e.gemini.discard?'Sí':'No'):'',e.humanLabel||'Sin validar',e.noiseCandidate?'Sí':'No']));
    const wsu=XLSX.utils.aoa_to_sheet(uw);wsu['!cols']=[{wch:5},{wch:18},{wch:13},{wch:13},{wch:11},{wch:12},{wch:11},{wch:8},{wch:11},{wch:14},{wch:18},{wch:11},{wch:32},{wch:14},{wch:14},{wch:16}];
    XLSX.utils.book_append_sheet(wb,wsu,'Urbano_Eventos');
  }

  // Comfort sheet
  if(modes.includes('comfort')&&r.comfortData?.pts?.length){
    const cd=r.comfortData;
    const cw=[['#','Fecha','Lat','Lon','Vel.(km/h)','a_v (m/s²)','Nivel ISO 2631-1']];
    cd.pts.forEach((p,i)=>cw.push([i+1,fmtD(p.ts),(p.lat||0).toFixed(7),(p.lon||0).toFixed(7),(p.speed||0).toFixed(1),(p.av||0).toFixed(4),classifyComfort(p.av||0).label]));
    const wsc=XLSX.utils.aoa_to_sheet(cw);wsc['!cols']=[{wch:5},{wch:18},{wch:13},{wch:13},{wch:11},{wch:13},{wch:28}];
    XLSX.utils.book_append_sheet(wb,wsc,'Confort_Datos');
    const sr2=[['Segmento','a_v medio (m/s²)','VDV (m/s^1.75)','Nivel','Puntos GPS']];
    (cd.segments||[]).forEach((s,i)=>sr2.push([i+1,(s.avAvg||0).toFixed(4),(s.vdv||0).toFixed(4),s.level,(s.pts||[]).length]));
    const wsc2=XLSX.utils.aoa_to_sheet(sr2);XLSX.utils.book_append_sheet(wb,wsc2,'Confort_Segmentos');
  }

  // Summary sheet
  const sum=[['PAVEMENT CHECK — RESUMEN'],[''],
    ['Nombre',r.name||''],['Fecha',fmtD(Date.parse(r.date))],
    ['Modos usados',modes.join(', ')],
    ['Distancia (m)',(r.dist||0).toFixed(1)],['']
  ];
  if(modes.includes('iri')&&r.avgC!=null){sum.push(['IRI Corregido medio',(r.avgC||0).toFixed(4)]);sum.push(['IRI Medido medio',(r.avgM||0).toFixed(4)]);sum.push(['Condición IRI',iLbl(r.avgC)]);sum.push(['']);}
  if(modes.includes('urban')&&r.urbanData){sum.push(['Eventos urbanos detectados',r.urbanData.events.length]);sum.push(['']);}
  if(modes.includes('comfort')&&r.comfortData){const cd=r.comfortData;sum.push(['a_v medio sesión (m/s²)',(cd.avgAv||0).toFixed(4)]);sum.push(['Nivel confort',classifyComfort(cd.avgAv||0).label]);sum.push(['VDV Z (m/s^1.75)',((cd.vdvSession?.z)||0).toFixed(4)]);sum.push(['fs usado (Hz)',(cd.fsUsed||60).toFixed(1)]);sum.push(['']);sum.push(['ADVERTENCIA METODOLÓGICA']);sum.push(['',COMFORT_DISCLAIMER]);}
  const ws3=XLSX.utils.aoa_to_sheet(sum);ws3['!cols']=[{wch:28},{wch:70}];XLSX.utils.book_append_sheet(wb,ws3,'Resumen');

  // Hoja AVISO cuando la validación está incompleta
  const liveRouteXLSX=(S._lastSavedRouteWithBlobs?.id===r.id&&S._lastSavedRouteWithBlobs?.urbanData?.events?.some(e=>e._frameBlobs))?S._lastSavedRouteWithBlobs:r;
  if(modes.includes('urban')&&!liveRouteXLSX.urbanData?.validationComplete){
    const warningRow=[{'AVISO':`⚠️ INFORME PRELIMINAR — ${liveRouteXLSX.urbanData?.pendingCount||0} eventos sin validar`}];
    const wsWarning=XLSX.utils.json_to_sheet(warningRow);
    XLSX.utils.book_append_sheet(wb,wsWarning,'AVISO');
  }

  XLSX.writeFile(wb,'pavcheck_'+r.id.slice(-6)+'.xlsx');toast('Excel exportado ✓');
  }catch(e){console.error('[doXLSX] ERROR:',e);toast('⚠️ Error generando Excel: '+e.message);}
}
function getReportMode(session){
  const modes=session.modesUsed||[];
  if(modes.includes('urban')&&!modes.includes('iri'))return'urban';
  if(modes.includes('iri')&&!modes.includes('urban'))return'iri';
  return'mixed';
}
async function expHTMLUrban(r){
  try{
  // Preferir la copia con blobs en memoria si es la sesión recién guardada
  const liveRoute = (S._lastSavedRouteWithBlobs?.id === r.id &&
                    S._lastSavedRouteWithBlobs?.urbanData?.events?.some(e=>e._frameBlobs))
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

  const buildWaveformSVG = (waveform, severity) => {
    if (!waveform || waveform.length < 3) return '';
    const W = 280, H = 60, PAD = 8;
    const max = Math.max(...waveform.map(Math.abs), 0.5);
    const pts = waveform.map((v, i) => {
      const x = PAD + (i / (waveform.length-1)) * (W - PAD*2);
      const y = H/2 - (v / max) * (H/2 - PAD);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const peakI = waveform.reduce((b, v, i) => Math.abs(v) > Math.abs(waveform[b]) ? i : b, 0);
    const px = PAD + (peakI/(waveform.length-1))*(W-PAD*2);
    const py = H/2 - (waveform[peakI]/max)*(H/2-PAD);
    const sevColor = severity==='grave' ? '#EF4444' : severity==='moderado' ? '#F97316' : '#F59E0B';
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;border-radius:4px;background:#f8fafc;margin-top:6px"><line x1="${PAD}" y1="${H/2}" x2="${W-PAD}" y2="${H/2}" stroke="#e2e8f0" stroke-width="1"/><polyline points="${pts}" fill="none" stroke="${sevColor}" stroke-width="1.5" stroke-linejoin="round"/><line x1="${px.toFixed(1)}" y1="${PAD}" x2="${px.toFixed(1)}" y2="${H-PAD}" stroke="${sevColor}" stroke-width="1" stroke-dasharray="3,2" opacity="0.5"/><circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3" fill="${sevColor}" stroke="#fff" stroke-width="1.5"/><text x="${px.toFixed(1)}" y="${Math.max(10,py-5).toFixed(1)}" text-anchor="middle" font-size="8" font-family="monospace" fill="${sevColor}">${Math.abs(waveform[peakI]).toFixed(2)}m/s\xB2</text></svg>`;
  };

  const validatedEvents = eventsWithImages.filter(e =>
    e.humanLabel === 'confirmed' || e.humanLabel === 'corrected'
  );
  const validatedLeves = validatedEvents.filter(e=>e.severity==='leve').length;
  const validatedModerados = validatedEvents.filter(e=>e.severity==='moderado').length;
  const validatedGraves = validatedEvents.filter(e=>e.severity==='grave').length;
  const validatedRows = validatedEvents.map((e,i) => {
    const ic=typeIcons[e.type]||'❓';
    const sc=sevColors[e.severity]||'#666';
    const vb = e.humanLabel==='confirmed'
      ? '<span class="ev val-ok">✅ Confirmado</span>'
      : '<span class="ev val-ed">✏️ Corregido</span>';
    return `<div class="card">
      ${e.imgB64?`<img src="data:image/jpeg;base64,${e.imgB64}">`:'<div class="noi">📷 Sin imagen</div>'}
      <div class="cb">
        <div class="ch">
          <span class="ct">${ic} ${e.type||'—'}</span>
          <span class="cs" style="background:${sc}22;color:${sc}">${e.severity||'—'}</span>
        </div>
        <div class="cm">Score:${e.score?.toFixed(0)||'—'} · ${e.speed?.toFixed(0)||'—'}km/h · ${e.lat?.toFixed(5)||'—'},${e.lon?.toFixed(5)||'—'}</div>
        ${buildWaveformSVG(e.waveform, e.severity)}
        ${vb}
      </div></div>`;
  }).join('');
  const validatedForMap = JSON.stringify(validatedEvents.map(e => ({
    lat:e.lat, lon:e.lon, type:e.type, severity:e.severity, score:e.score,
    humanLabel:e.humanLabel, id:e.id
  })));
  const validatedSummary = (liveRoute.urbanData?.validationComplete && validatedEvents.length > 0)
    ? `<div style="margin-top:32px;border-top:2px solid #0EA5E9;padding-top:20px">
        <h2 style="font-size:1.1rem;color:#0EA5E9;margin-bottom:12px">✅ Resumen de eventos validados (${validatedEvents.length})</h2>
        <div class="stats">
          <div class="stat"><div class="sv">${validatedEvents.length}</div><div class="sl">Total</div></div>
          <div class="stat"><div class="sv" style="color:#F59E0B">${validatedLeves}</div><div class="sl">Leves</div></div>
          <div class="stat"><div class="sv" style="color:#F97316">${validatedModerados}</div><div class="sl">Moderados</div></div>
          <div class="stat"><div class="sv" style="color:#EF4444">${validatedGraves}</div><div class="sl">Graves</div></div>
        </div>
        <div style="margin-bottom:16px">
          <div id="validatedMap" style="height:250px;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0"></div>
        </div>
        <div class="cards">${validatedRows}</div>
      </div>`
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
    const geminiSuggest = e.geminiSuggestsDiscard
      ? '<span class="ev" style="background:#EF444422;color:#991B1B">🤖 IA sugiere descarte</span>'
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
        ${buildWaveformSVG(e.waveform, e.severity)}
        ${geminiInfo}
        ${vb} ${noiseBadge} ${geminiSuggest}
      </div></div>`;
  }).join('');

  const preliminaryBanner = !liveRoute.urbanData?.validationComplete
    ? `<div style="background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;padding:10px 14px;margin-bottom:16px;color:#92400E;font-size:.85rem">
       ⚠️ <strong>INFORME PRELIMINAR</strong> —
       ${liveRoute.urbanData?.pendingCount||0} evento(s) sin validar.
       Este informe puede contener falsos positivos no revisados.
     </div>`
    : '';

  const eventsForMap = JSON.stringify(eventsWithImages.map(e => ({
    lat: e.lat, lon: e.lon, type: e.type,
    severity: e.severity, score: e.score,
    humanLabel: e.humanLabel, id: e.id
  })));

  const html=`<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Informe Urbano — Pavement Check</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
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
${preliminaryBanner}
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
<div style="margin-bottom:20px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <h2 style="font-size:1rem;color:#0EA5E9;margin:0">📍 Mapa de eventos</h2>
    <label style="font-size:.75rem;color:#666;display:flex;align-items:center;gap:4px">
      <input type="checkbox" id="showOtherRoutes" onchange="toggleOtherRoutes(this.checked)">
      Ver eventos de otras rutas
    </label>
  </div>
  <div id="reportMap" style="height:300px;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0"></div>
</div>
<div class="cards">${rows}</div>
${validatedSummary}
<script>
const ROUTE_EVENTS = ${eventsForMap};
let OTHER_EVENTS = [];
try {
  const stored = JSON.parse(localStorage.getItem('rc_urban_events') || '[]');
  OTHER_EVENTS = stored.filter(e => !ROUTE_EVENTS.find(r => r.id === e.id));
} catch(e) {}
const SEV_COLORS = { grave:'#EF4444', moderado:'#F97316', leve:'#F59E0B' };
const TYPE_ICONS = { pothole:'🕳️', manhole:'⭕', speedbump:'⛰️', crack:'〰️', degraded:'🔴', patch:'🔧' };
const map = L.map('reportMap');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);
let currentMarkers = [];
let otherMarkers = [];
function addRouteMarkers() {
  ROUTE_EVENTS.forEach((e,i) => {
    if (!e.lat || !e.lon) return;
    const color = SEV_COLORS[e.severity] || '#94a3b8';
    const icon = L.divIcon({
      html: '<div style="background:' + color + ';width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)"></div>',
      iconSize:[14,14], iconAnchor:[7,7], className:''
    });
    const marker = L.marker([e.lat, e.lon], {icon});
    marker.bindPopup('<b>' + (TYPE_ICONS[e.type]||'❓') + ' ' + (e.type||'—') + '</b><br>Severidad: ' + (e.severity||'—') + '<br>Score: ' + (e.score?.toFixed(0)||'—') + '<br>' + (e.humanLabel ? 'Validado: ' + e.humanLabel : '⏳ Sin validar'));
    marker.addTo(map);
    currentMarkers.push(marker);
  });
  if (currentMarkers.length > 0) {
    const group = L.featureGroup(currentMarkers);
    map.fitBounds(group.getBounds().pad(0.2));
  }
}
function toggleOtherRoutes(show) {
  if (show) {
    OTHER_EVENTS.forEach(e => {
      if (!e.lat || !e.lon) return;
      const icon = L.divIcon({
        html: '<div style="background:#94a3b8;width:10px;height:10px;border-radius:50%;border:2px solid #fff;opacity:0.6"></div>',
        iconSize:[10,10], iconAnchor:[5,5], className:''
      });
      const marker = L.marker([e.lat, e.lon], {icon});
      marker.bindPopup('<b>Otra ruta</b><br>' + (TYPE_ICONS[e.type]||'❓') + ' ' + (e.type||'—'));
      marker.addTo(map);
      otherMarkers.push(marker);
    });
  } else {
    otherMarkers.forEach(m => map.removeLayer(m));
    otherMarkers = [];
  }
}
addRouteMarkers();
const validatedMapEl = document.getElementById('validatedMap');
if (validatedMapEl) {
  const VALIDATED_EVENTS = ${validatedForMap};
  const vmap = L.map('validatedMap');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(vmap);
  const vMarkers = [];
  VALIDATED_EVENTS.forEach(e => {
    if (!e.lat || !e.lon) return;
    const color = SEV_COLORS[e.severity] || '#94a3b8';
    const icon = L.divIcon({
      html: '<div style="background:' + color + ';width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)"></div>',
      iconSize:[14,14], iconAnchor:[7,7], className:''
    });
    const marker = L.marker([e.lat, e.lon], {icon});
    marker.bindPopup('<b>' + (TYPE_ICONS[e.type]||'❓') + ' ' + (e.type||'—') + '</b><br>Severidad: ' + (e.severity||'—') + '<br>' + (e.humanLabel==='confirmed'?'✅ Confirmado':'✏️ Corregido'));
    marker.addTo(vmap);
    vMarkers.push(marker);
  });
  if (vMarkers.length > 0) {
    vmap.fitBounds(L.featureGroup(vMarkers).getBounds().pad(0.2));
  }
}
<\/script>
</body></html>`;

  const statusTag = liveRoute.urbanData?.validationComplete ? 'FINAL' : 'PRELIMINAR';
  dlBlob(html,'text/html','informe_urbano_'+statusTag+'_'+(r.name||'ruta').replace(/\s/g,'_')+'_'+new Date().toISOString().slice(0,10)+'.html');
  }catch(e){console.error('[expHTMLUrban] ERROR:',e);toast('⚠️ Error generando informe: '+e.message);}
}
function expHTML(id){
  const r=allRoutes().find(r=>r.id===id);if(!r)return;
  const modes=r.modesUsed||['iri'];
  if(getReportMode(r)==='urban'){expHTMLUrban(r);return;}
  // Unified route: delegate comfort-only to comfort exporter; multi-mode builds combined HTML
  if(!modes.includes('iri')&&modes.includes('comfort')&&!modes.includes('urban')){expComfortHTML(id,r);return;}
  if(!r?.pts)return;
  let da=0;const dists=[0],iM=[],iC=[],sp=[];
  r.pts.forEach((p,i)=>{if(i>0){da+=geo(r.pts[i-1].lat,r.pts[i-1].lon,p.lat,p.lon);dists.push(da);}iM.push(+(p.iri_m||0).toFixed(4));iC.push(+(p.iri_c||0).toFixed(4));sp.push(+(p.speed||0).toFixed(1));});
  const sH=(r.segs||[]).map((s,i)=>`<tr><td>${i+1}</td><td>${(s.iriM||0).toFixed(3)}</td><td style="font-weight:700;color:${iCol(s.iriC)}">${(s.iriC||0).toFixed(3)}</td><td>${(s.speedAvg||0).toFixed(1)}</td><td>${(s.dist||0).toFixed(0)}</td><td style="color:${iCol(s.iriC)}">${iLbl(s.iriC)}</td></tr>`).join('');
  const ptsJ=JSON.stringify(r.pts.map(p=>({lat:p.lat,lon:p.lon,iri_m:+(p.iri_m||0).toFixed(4),iri_c:+(p.iri_c||0).toFixed(4),speed:+(p.speed||0).toFixed(1)})));
  const segsJ=JSON.stringify((r.segs||[]).map(s=>({pts:(s.pts||[]).map(p=>({lat:p.lat,lon:p.lon})),iriC:+(s.iriC||0).toFixed(3),iriM:+(s.iriM||0).toFixed(3),dist:+(s.dist||0).toFixed(1)})));
  // Extra sections for urban and comfort modes
  const _evs=r.urbanData?.events||[];
  const urbanGallery=_evs.filter(e=>e.imageSrc).map(e=>`<div class="gal-item"><img src="${e.imageSrc}" alt="${escH(e.type||'')} ${escH(e.severity||'')}"><div class="gal-info"><span>${e.type||'?'} · ${e.severity||'?'}</span><span>Conf. ${e.gemini?.confidence!=null?(e.gemini.confidence*100).toFixed(0)+'%':'-'}</span><span>Score: ${(e.score||0).toFixed(0)}</span></div></div>`).join('');
  const urbanSection=modes.includes('urban')&&_evs.length?`<div class="dv"></div><h2>Eventos Urbanos (${_evs.length})</h2><table><thead><tr><th>#</th><th>Tipo</th><th>Severidad</th><th>Score</th><th>Vel.(km/h)</th><th>Confirmado</th><th>Tipo (Gemini)</th><th>Sev. Gemini</th><th>Conf.</th><th>Descripción IA</th></tr></thead><tbody>${_evs.map((e,i)=>`<tr><td>${i+1}</td><td>${escH(e.type||'')}</td><td style="color:${e.severity==='grave'?'#EF4444':e.severity==='moderado'?'#F59E0B':'#10B981'}">${e.severity||''}</td><td>${(e.score||0).toFixed(1)}</td><td>${(e.speed||0).toFixed(1)}</td><td>${e.confirmed?'Sí':'No'}</td><td>${escH(e.gemini?.type||'')}</td><td>${escH(e.gemini?.severity||'')}</td><td>${e.gemini?.confidence!=null?(e.gemini.confidence*100).toFixed(0)+'%':''}</td><td>${escH(e.gemini?.description||'')}</td></tr>`).join('')}</tbody></table>${urbanGallery?`<div class="dv"></div><h2>Galería de Eventos</h2><div class="gallery">${urbanGallery}</div>`:''}`:'';
  const cd=r.comfortData;
  const comfortSection=modes.includes('comfort')&&cd?`<div class="dv"></div><h2>Confort de Marcha (ISO 2631-1)</h2><div class="cards"><div class="card"><div class="v">${(cd.avgAv||0).toFixed(3)}</div><div class="l">a_v medio (m/s²)</div></div><div class="card"><div class="v" style="font-size:.75rem;color:${classifyComfort(cd.avgAv||0).color}">${classifyComfort(cd.avgAv||0).label}</div><div class="l">Nivel</div></div><div class="card"><div class="v">${((cd.vdvSession?.z)||0).toFixed(3)}</div><div class="l">VDV_Z (m/s^1.75)</div></div></div><p style="font-size:.56rem;color:#5A7E9C;margin-bottom:8px">${escH(COMFORT_DISCLAIMER)}</p>`:'';
  const html=`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=yes"><title>Roadcheck IRI</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js"><\/script>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',Arial,sans-serif;background:#05111F;color:#B8D0E4}.tb{display:flex;align-items:center;gap:10px;padding:9px 14px;background:#091829;border-bottom:1px solid rgba(14,165,233,.2);position:sticky;top:0;z-index:1000}.back{padding:6px 13px;background:rgba(14,165,233,.12);border:1px solid rgba(14,165,233,.25);border-radius:4px;color:#0EA5E9;font-size:.73rem;font-weight:700;cursor:pointer;letter-spacing:.5px;text-transform:uppercase}.rt{font-size:.82rem;font-weight:700;color:#0EA5E9;letter-spacing:1px;font-family:'Courier New',monospace;text-transform:uppercase}.c{padding:12px 12px 28px}h2{font-size:.67rem;text-transform:uppercase;letter-spacing:2px;color:#3A5F7A;margin-bottom:9px;font-family:'Courier New',monospace;padding-top:12px}.cards{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:3px}.card{background:#091829;border:1px solid rgba(14,165,233,.15);border-radius:6px;padding:9px 14px;flex:1;min-width:110px;text-align:center}.card .v{font-size:1.35rem;font-weight:700;font-family:'Courier New',monospace;color:#F59E0B}.card .l{font-size:.57rem;color:#3A5F7A;text-transform:uppercase;letter-spacing:1px;margin-top:2px}#map{height:300px;border-radius:6px;overflow:hidden;border:1px solid rgba(14,165,233,.2);margin-bottom:5px}.bx{background:#091829;border:1px solid rgba(14,165,233,.1);border-radius:6px;padding:10px;margin-bottom:7px;position:relative}.bx canvas{touch-action:none}.zh{font-size:.56rem;color:#3A5F7A;text-align:right;margin-top:3px;font-family:'Courier New',monospace}.rb{position:absolute;top:8px;right:8px;padding:3px 7px;background:rgba(14,165,233,.1);border:1px solid rgba(14,165,233,.2);border-radius:3px;color:#0EA5E9;font-size:.53rem;cursor:pointer}#pi{background:#0D2040;border:1px solid rgba(14,165,233,.2);border-radius:6px;padding:9px 11px;font-size:.64rem;color:#5A7E9C;line-height:1.9;min-height:36px;font-family:'Courier New',monospace;margin-bottom:7px}#pi span{color:#B8D0E4;font-weight:700}table{width:100%;border-collapse:collapse;font-size:.7rem}th{background:#091829;padding:7px 8px;text-align:left;font-size:.58rem;text-transform:uppercase;color:#3A5F7A;letter-spacing:1px;font-family:'Courier New',monospace}td{padding:7px 8px;border-bottom:1px solid rgba(14,165,233,.07)}.dv{height:1px;background:rgba(14,165,233,.1);margin:12px 0}.gallery{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.gal-item{background:#091829;border:1px solid rgba(14,165,233,.15);border-radius:6px;overflow:hidden;width:160px}.gal-item img{width:100%;height:120px;object-fit:cover;display:block}.gal-info{padding:5px 7px;font-size:.56rem;color:#5A7E9C;font-family:'Courier New',monospace;display:flex;flex-direction:column;gap:2px}</style>
</head><body>
<div class="tb"><button class="back" onclick="history.length>1?history.back():window.close()">← Volver</button><div class="rt">Roadcheck IRI — Informe</div></div>
<div class="c">
<h2>Resumen</h2>
<div class="cards"><div class="card"><div class="v">${(r.avgC||0).toFixed(3)}</div><div class="l">IRI Corr. (m/km)</div></div><div class="card"><div class="v">${(r.dist/1000).toFixed(2)}</div><div class="l">Distancia (km)</div></div><div class="card"><div class="v">${(r.segs||[]).length}</div><div class="l">Segmentos</div></div><div class="card"><div class="v" style="color:${iCol(r.avgC)}">${iLbl(r.avgC)}</div><div class="l">Condición</div></div></div>
<p style="font-size:.58rem;color:#3A5F7A;margin-bottom:8px;font-family:'Courier New',monospace">${escH(r.name||'')} · ${fmtD(Date.parse(r.date))}</p>
<h2>Mapa de la Ruta</h2><div id="map"></div>
<div id="pi">Toca un punto del mapa o del gráfico para ver sus datos</div>
<h2>IRI Corregido + Velocidad</h2>
<div class="bx"><button class="rb" onclick="c1.resetZoom()">↺ Zoom</button><div style="height:260px"><canvas id="c1"></canvas></div><div class="zh">Pellizca para zoom · Arrastra para desplazar</div></div>
<h2>IRI Medido vs Corregido</h2>
<div class="bx"><button class="rb" onclick="c2.resetZoom()">↺ Zoom</button><div style="height:200px"><canvas id="c2"></canvas></div><div class="zh">Pellizca para zoom · Arrastra para desplazar</div></div>
<div class="dv"></div>
<h2>Datos por Segmento</h2>
<table><thead><tr><th>#</th><th>IRI Med.</th><th>IRI Corr.</th><th>Vel.(km/h)</th><th>Dist.(m)</th><th>Condición</th></tr></thead><tbody>${sH}</tbody></table>
${urbanSection}${comfortSection}
</div>
<script>
const PTS=${ptsJ},SEGS=${segsJ},DS=${JSON.stringify(dists.map(d=>+d.toFixed(0)))},IC=${JSON.stringify(iC)},IM=${JSON.stringify(iM)},SP=${JSON.stringify(sp)};
const ic=v=>v<=2.5?'#10B981':v<=5?'#F59E0B':'#EF4444';
const map=L.map('map',{zoomControl:true,attributionControl:true});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,subdomains:['a','b','c'],attribution:'© OpenStreetMap'}).addTo(map);
SEGS.forEach(s=>{if(s.pts.length<2)return;L.polyline(s.pts.map(p=>[p.lat,p.lon]),{color:ic(s.iriC),weight:7,opacity:.9}).addTo(map);});
if(PTS.length)map.fitBounds(L.latLngBounds(PTS.map(p=>[p.lat,p.lon])),{padding:[14,14]});
const hlMk=L.circleMarker([0,0],{radius:9,color:'#fff',weight:2,fillColor:'#F59E0B',fillOpacity:1});
PTS.forEach((p,i)=>L.circleMarker([p.lat,p.lon],{radius:6,color:'transparent',fillColor:'transparent',fillOpacity:0}).addTo(map).on('click',()=>hl(i)));
const vl={id:'vl',afterDatasetsDraw(ch){if(ch._hl===undefined||ch._hl<0)return;const ds=ch.getDatasetMeta(0);if(!ds?.data[ch._hl])return;const x=ds.data[ch._hl].x,{top,bottom}=ch.chartArea,ctx=ch.ctx;ctx.save();ctx.beginPath();ctx.strokeStyle='rgba(255,255,255,.4)';ctx.lineWidth=1.5;ctx.setLineDash([4,4]);ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();ctx.restore();}};
const zo={zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'x'},pan:{enabled:true,mode:'x'}};
const lg={labels:{color:'#5A7E9C',font:{size:12},usePointStyle:true,pointStyle:'line',boxWidth:22}};
const c1=new Chart(document.getElementById('c1'),{type:'line',plugins:[vl],data:{labels:DS,datasets:[{label:'IRI Corregido (m/km)',data:IC,borderColor:'#F59E0B',yAxisID:'y1',tension:.3,pointRadius:3,pointHoverRadius:7,fill:false,segment:{borderColor:c=>ic(c.p1.raw)}},{label:'Velocidad (km/h)',data:SP,borderColor:'#0EA5E9',yAxisID:'y2',tension:.3,pointRadius:0,fill:false,borderDash:[5,3]}]},options:{responsive:true,maintainAspectRatio:false,animation:false,onClick(e){const el=this.getElementsAtEventForMode(e,'index',{intersect:false},true);if(el.length)hl(el[0].index);},scales:{x:{title:{display:true,text:'Distancia (m)',color:'#3A5F7A',font:{size:12}},ticks:{color:'#3A5F7A',font:{size:11},maxTicksLimit:8}},y1:{type:'linear',position:'left',min:0,title:{display:true,text:'IRI (m/km)',color:'#F59E0B',font:{size:12}},ticks:{color:'#F59E0B',font:{size:11}},grid:{color:'rgba(14,165,233,.07)'}},y2:{type:'linear',position:'right',min:0,title:{display:true,text:'km/h',color:'#0EA5E9',font:{size:12}},ticks:{color:'#0EA5E9',font:{size:11}},grid:{drawOnChartArea:false}}},plugins:{legend:lg,zoom:zo,tooltip:{callbacks:{title:i=>'Dist: '+i[0].label+' m',label:i=>i.dataset.label+': '+parseFloat(i.raw).toFixed(2)}}}}});
const c2=new Chart(document.getElementById('c2'),{type:'line',plugins:[vl],data:{labels:DS,datasets:[{label:'IRI Medido',data:IM,borderColor:'#3A5F7A',tension:.3,pointRadius:0,fill:false},{label:'IRI Corregido',data:IC,borderColor:'#F59E0B',tension:.3,pointRadius:0,fill:false,segment:{borderColor:c=>ic(c.p1.raw)}}]},options:{responsive:true,maintainAspectRatio:false,animation:false,onClick(e){const el=this.getElementsAtEventForMode(e,'index',{intersect:false},true);if(el.length)hl(el[0].index);},scales:{x:{ticks:{color:'#3A5F7A',font:{size:11},maxTicksLimit:8}},y:{min:0,title:{display:true,text:'IRI (m/km)',color:'#5A7E9C',font:{size:12}},ticks:{color:'#5A7E9C',font:{size:11}},grid:{color:'rgba(14,165,233,.07)'}}},plugins:{legend:lg,zoom:zo,tooltip:{callbacks:{title:i=>'Dist: '+i[0].label+' m',label:i=>i.dataset.label+': '+parseFloat(i.raw).toFixed(2)}}}}});
function hl(i){const p=PTS[i];if(!p)return;if(!map.hasLayer(hlMk))hlMk.addTo(map);hlMk.setLatLng([p.lat,p.lon]);map.panTo([p.lat,p.lon]);c1._hl=i;c1.update('none');c2._hl=i;c2.update('none');document.getElementById('pi').innerHTML='Pto <span>#'+(i+1)+'<\/span> · Lat <span>'+p.lat.toFixed(5)+'<\/span> · Lon <span>'+p.lon.toFixed(5)+'<\/span> · Vel <span>'+p.speed+' km/h<\/span> · IRI_m <span style="color:#0EA5E9">'+p.iri_m.toFixed(3)+'<\/span> · IRI_c <span style="color:'+ic(p.iri_c)+'">'+p.iri_c.toFixed(3)+'<\/span>';}
<\/script></body></html>`;
  dlBlob(html,'text/html','pavcheck_'+r.id.slice(-6)+'.html');toast('Informe HTML exportado ✓');
}

// ─ urban validation (Fase 7) ──────────────────
function markGroundTruth(){
  if(!S.active||!S.lastPos){toast('Activa una sesión urbana primero');return;}
  if(!S.groundTruth)S.groundTruth=[];
  const gt={ts:Date.now(),lat:S.lastPos.lat,lon:S.lastPos.lon,speed:S.lastPos.speed||0};
  S.groundTruth.push(gt);
  toast('🏷️ Bache real marcado (#'+S.groundTruth.length+')');
  // Marcador visual diferenciado
  const map=S.mapMeas;
  if(map)L.circleMarker([gt.lat,gt.lon],{radius:9,color:'#fff',weight:2,fillColor:'#10B981',fillOpacity:0.95}).addTo(map).bindTooltip('GT #'+S.groundTruth.length);
}

function computeValidationMetrics(detected,groundTruth,proximityM=5,proximityMs=2000){
  let VP=0,FP=0,FN=0;
  const usedGT=new Set();
  detected.forEach(ev=>{
    const match=groundTruth.find((gt,i)=>!usedGT.has(i)&&geo(ev.lat,ev.lon,gt.lat,gt.lon)<=proximityM&&Math.abs(ev.ts-gt.ts)<=proximityMs);
    if(match){VP++;const idx=groundTruth.indexOf(match);usedGT.add(idx);}
    else FP++;
  });
  FN=groundTruth.length-usedGT.size;
  const precision=VP+FP>0?VP/(VP+FP):0;
  const recall=VP+FN>0?VP/(VP+FN):0;
  return{VP,FP,FN,precision,recall};
}

function showValidationResults(){
  const gt=S.groundTruth||[];
  if(!gt.length){toast('Sin ground truth marcado');return;}
  const m=computeValidationMetrics(S.urbanEvents,gt);
  const msg=`Validación:\nVP: ${m.VP} · FP: ${m.FP} · FN: ${m.FN}\nPrecisión: ${(m.precision*100).toFixed(1)}%\nRecall: ${(m.recall*100).toFixed(1)}%`;
  alert(msg);
}

function exportValidationDataset(){
  const gt=S.groundTruth||[];
  if(!S.urbanEvents.length&&!gt.length){toast('Sin datos de validación');return;}
  const m=gt.length?computeValidationMetrics(S.urbanEvents,gt):{VP:0,FP:0,FN:0,precision:0,recall:0};
  const dataset={urbanEvents:S.urbanEvents,groundTruth:gt,comparisonResults:m,exportedAt:new Date().toISOString()};
  dlBlob(JSON.stringify(dataset,null,2),'application/json','validation_dataset_'+Date.now().toString().slice(-6)+'.json');
  toast('Dataset de validación exportado ✓');
}

// ─ urban exports ──────────────────────────────
function exportUrbanEventsXLSX(r){
  const liveRoute=(S._lastSavedRouteWithBlobs?.id===r?.id)
    ?S._lastSavedRouteWithBlobs:r;
  const events=liveRoute?.urbanData?.events;
  if(!events?.length){toast('Sin eventos urbanos para exportar');return;}
  loadXLSX(()=>{
    const wb=XLSX.utils.book_new();
    const rows=[['#','Fecha','Lat','Lon','Tipo','Severidad','Score','Confirmaciones','Velocidad (km/h)','Confirmado','Validación','Tipo (Gemini)','Severidad (Gemini)','Confianza','Descripción IA','Candidato a ruido']];
    events.forEach((ev,i)=>{
      rows.push([
        i+1,fmtD(ev.ts),
        (ev.lat||0).toFixed(7),(ev.lon||0).toFixed(7),
        ev.type,ev.severity,
        (ev.score||0).toFixed(1),
        ev.confirmCount||1,
        (ev.speed||0).toFixed(1),
        ev.confirmed?'Sí':'No',
        ev.humanLabel||'Sin validar',
        ev.gemini?.type||'—',
        ev.gemini?.severity||'—',
        ev.gemini?.confidence!=null?(ev.gemini.confidence*100).toFixed(0)+'%':'—',
        ev.gemini?.description||'—',
        ev.noiseCandidate?'Sí':'No'
      ]);
    });
    const ws=XLSX.utils.aoa_to_sheet(rows);
    ws['!cols']=[{wch:4},{wch:18},{wch:13},{wch:13},{wch:12},{wch:10},{wch:8},{wch:15},{wch:16},{wch:12},{wch:14},{wch:14},{wch:18},{wch:11},{wch:32},{wch:16}];
    XLSX.utils.book_append_sheet(wb,ws,'Eventos');
    const summary=[['PAVEMENT CHECK — EVENTOS URBANOS'],[''],
      ['Total eventos',events.length],
      ['Graves',events.filter(e=>e.severity==='grave').length],
      ['Moderados',events.filter(e=>e.severity==='moderado').length],
      ['Leves',events.filter(e=>e.severity==='leve').length],
      ['Validados (confirmados)',events.filter(e=>e.humanLabel==='confirmed').length],
      ['Falsos positivos',events.filter(e=>e.humanLabel==='discarded').length],
      ['Candidatos a ruido',events.filter(e=>e.noiseCandidate).length],
    ];
    const ws2=XLSX.utils.aoa_to_sheet(summary);
    ws2['!cols']=[{wch:26},{wch:14}];
    XLSX.utils.book_append_sheet(wb,ws2,'Resumen');
    XLSX.writeFile(wb,'urban_eventos_'+Date.now().toString().slice(-6)+'.xlsx');
    toast('Excel de eventos exportado ✓');
  });
}

function exportUrbanEventsHTML(){
  let stored;
  try{stored=JSON.parse(localStorage.getItem('rc_urban_events')||'[]');}catch(e){stored=[];}
  if(!stored.length){toast('Sin eventos urbanos para exportar');return;}
  const total=stored.length;
  const graves=stored.filter(e=>e.severity==='grave').length;
  const mods=stored.filter(e=>e.severity==='moderado').length;
  const leves=stored.filter(e=>e.severity==='leve').length;
  const confirmed=stored.filter(e=>e.confirmed).length;
  const pctConf=(total>0?(confirmed/total*100).toFixed(1):0)+'%';
  const colors={leve:'#F59E0B',moderado:'#F97316',grave:'#EF4444'};
  const eventsJson=JSON.stringify(stored.map(e=>({lat:e.lat,lon:e.lon,type:e.type,severity:e.severity,score:+(e.score||0).toFixed(1),confirmed:e.confirmed,confirmCount:e.confirmCount||1})));
  const tableRows=stored.map((e,i)=>`<tr><td>${i+1}</td><td>${fmtD(e.ts)}</td><td>${e.lat.toFixed(5)}</td><td>${e.lon.toFixed(5)}</td><td>${e.type}</td><td style="color:${colors[e.severity]};font-weight:700">${e.severity}</td><td>${(e.score||0).toFixed(1)}</td><td>${e.confirmCount||1}</td><td>${(e.speed||0).toFixed(1)}</td><td>${e.confirmed?'✓':''}</td></tr>`).join('');
  const html=`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eventos Urbanos — Roadcheck IRI</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',Arial,sans-serif;background:#05111F;color:#B8D0E4}.tb{display:flex;align-items:center;gap:10px;padding:9px 14px;background:#091829;border-bottom:1px solid rgba(14,165,233,.2);position:sticky;top:0;z-index:1000}.back{padding:6px 13px;background:rgba(14,165,233,.12);border:1px solid rgba(14,165,233,.25);border-radius:4px;color:#0EA5E9;font-size:.73rem;font-weight:700;cursor:pointer;letter-spacing:.5px;text-transform:uppercase}.rt{font-size:.82rem;font-weight:700;color:#0EA5E9;letter-spacing:1px;font-family:'Courier New',monospace;text-transform:uppercase}.c{padding:12px 12px 28px}h2{font-size:.67rem;text-transform:uppercase;letter-spacing:2px;color:#3A5F7A;margin-bottom:9px;font-family:'Courier New',monospace;padding-top:12px}.cards{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px}.card{background:#091829;border:1px solid rgba(14,165,233,.15);border-radius:6px;padding:9px 14px;flex:1;min-width:90px;text-align:center}.card .v{font-size:1.35rem;font-weight:700;font-family:'Courier New',monospace;color:#F59E0B}.card .l{font-size:.57rem;color:#3A5F7A;text-transform:uppercase;letter-spacing:1px;margin-top:2px}#map{height:320px;border-radius:6px;overflow:hidden;border:1px solid rgba(14,165,233,.2);margin-bottom:10px}table{width:100%;border-collapse:collapse;font-size:.68rem}th{background:#091829;padding:7px 8px;text-align:left;font-size:.57rem;text-transform:uppercase;color:#3A5F7A;letter-spacing:1px;font-family:'Courier New',monospace}td{padding:6px 8px;border-bottom:1px solid rgba(14,165,233,.07)}</style>
</head><body>
<div class="tb"><button class="back" onclick="history.length>1?history.back():window.close()">← Volver</button><div class="rt">Eventos Urbanos — Roadcheck IRI</div></div>
<div class="c">
<h2>Resumen</h2>
<div class="cards">
<div class="card"><div class="v">${total}</div><div class="l">Total</div></div>
<div class="card"><div class="v" style="color:#EF4444">${graves}</div><div class="l">Graves</div></div>
<div class="card"><div class="v" style="color:#F97316">${mods}</div><div class="l">Moderados</div></div>
<div class="card"><div class="v" style="color:#F59E0B">${leves}</div><div class="l">Leves</div></div>
<div class="card"><div class="v" style="color:#10B981">${pctConf}</div><div class="l">% Confirmados</div></div>
</div>
<h2>Mapa de Eventos</h2>
<div id="map"></div>
<h2>Tabla de Eventos</h2>
<table><thead><tr><th>#</th><th>Fecha</th><th>Lat</th><th>Lon</th><th>Tipo</th><th>Severidad</th><th>Score</th><th>Pasadas</th><th>Vel.(km/h)</th><th>✓</th></tr></thead><tbody>${tableRows}</tbody></table>
</div>
<script>
const EVENTS=${eventsJson};
const map=L.map('map',{zoomControl:true,attributionControl:true});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,subdomains:['a','b','c'],attribution:'© OpenStreetMap'}).addTo(map);
const colors={leve:'#F59E0B',moderado:'#F97316',grave:'#EF4444'};
const pts=[];
EVENTS.forEach(ev=>{
  const r=ev.confirmed?9:5,op=ev.confirmed?0.92:0.45;
  L.circleMarker([ev.lat,ev.lon],{radius:r,color:'#fff',weight:ev.confirmed?2:1,fillColor:colors[ev.severity]||'#888',fillOpacity:op})
    .addTo(map).bindTooltip(ev.type+' · '+ev.severity+' · '+ev.score+(ev.confirmed?' ✓ ('+ev.confirmCount+' pasadas)':' (candidato)'));
  pts.push([ev.lat,ev.lon]);
});
if(pts.length)map.fitBounds(L.latLngBounds(pts),{padding:[20,20]});
<\/script></body></html>`;
  dlBlob(html,'text/html','informe_urban_'+Date.now().toString().slice(-6)+'.html');
  toast('Informe HTML urbano exportado ✓');
}

// ─ comfort storage ────────────────────────────
function allComfortRoutes(){try{return JSON.parse(localStorage.getItem('rc_comfort_routes')||'[]');}catch(e){return[];}}
function saveComfortRoute(r){try{const rs=allComfortRoutes();rs.push(r);localStorage.setItem('rc_comfort_routes',JSON.stringify(rs));}catch(e){toast('Error guardando ruta de confort');}}
function delComfortRoute(id){localStorage.setItem('rc_comfort_routes',JSON.stringify(allComfortRoutes().filter(r=>r.id!==id)));}

// ─ comfort exports (Fase 6) ───────────────────
const COMFORT_DISCLAIMER='El valor de confort de marcha mostrado es una estimación obtenida mediante acelerómetro de smartphone, aplicando las curvas de ponderación en frecuencia definidas en la norma ISO 2631-1:1997, calculadas mediante reconstrucción digital de los filtros normativos (ver metodología). No constituye una medición con instrumento certificado conforme a ISO 8041. El valor debe interpretarse como indicador orientativo de ingeniería de campo, no como medición acreditada de laboratorio.';

function expComfortXLSX(id){
  const r=allComfortRoutes().find(r=>r.id===id);if(!r?.pts)return;
  loadXLSX(()=>{
    const wb=XLSX.utils.book_new();
    const rows=[['#','Fecha','Lat','Lon','Vel.(km/h)','a_v (m/s²)','Nivel ISO 2631-1']];
    r.pts.forEach((p,i)=>rows.push([i+1,fmtD(p.ts),(p.lat||0).toFixed(7),(p.lon||0).toFixed(7),(p.speed||0).toFixed(1),(p.av||0).toFixed(4),classifyComfort(p.av||0).label]));
    const ws1=XLSX.utils.aoa_to_sheet(rows);ws1['!cols']=[{wch:5},{wch:18},{wch:13},{wch:13},{wch:11},{wch:13},{wch:28}];
    XLSX.utils.book_append_sheet(wb,ws1,'Datos');
    const sr=[['Segmento','a_v medio (m/s²)','VDV (m/s^1.75)','Nivel','Puntos GPS']];
    (r.segments||[]).forEach((s,i)=>sr.push([i+1,(s.avAvg||0).toFixed(4),(s.vdv||0).toFixed(4),s.level,(s.pts||[]).length]));
    const ws2=XLSX.utils.aoa_to_sheet(sr);ws2['!cols']=[{wch:11},{wch:18},{wch:18},{wch:28},{wch:12}];
    XLSX.utils.book_append_sheet(wb,ws2,'Segmentos');
    const sum=[['ROADCHECK IRI — CONFORT DE MARCHA (ISO 2631-1)'],[''],
      ['Nombre',r.name||''],['Fecha',fmtD(Date.parse(r.date))],
      ['Distancia (m)',(r.dist||0).toFixed(1)],
      ['a_v medio sesión (m/s²)',(r.avgAv||0).toFixed(4)],
      ['Nivel medio',classifyComfort(r.avgAv||0).label],
      ['VDV Z (m/s^1.75)',((r.vdvSession?.z)||0).toFixed(4)],
      ['VDV X (m/s^1.75)',((r.vdvSession?.x)||0).toFixed(4)],
      ['VDV Y (m/s^1.75)',((r.vdvSession?.y)||0).toFixed(4)],
      ['fs usado (Hz)',(r.fsUsed||60).toFixed(1)],[''],
      ['ADVERTENCIA METODOLÓGICA'],['',COMFORT_DISCLAIMER]];
    const ws3=XLSX.utils.aoa_to_sheet(sum);ws3['!cols']=[{wch:28},{wch:70}];
    XLSX.utils.book_append_sheet(wb,ws3,'Resumen');
    XLSX.writeFile(wb,'confort_'+r.id.slice(-6)+'.xlsx');toast('Excel de confort exportado ✓');
  });
}

function expComfortHTML(id,rOverride){
  const r=rOverride||(allComfortRoutes().find(r=>r.id===id));
  if(!r)return;
  const pts=r.pts||(r.comfortData?.pts);const segments=r.segments||(r.comfortData?.segments);
  const avgAv=r.avgAv||(r.comfortData?.avgAv)||0;const dist=r.dist||0;
  const vdvSession=r.vdvSession||(r.comfortData?.vdvSession)||{z:0,x:0,y:0};
  const fsUsed=r.fsUsed||(r.comfortData?.fsUsed)||60;
  if(!pts?.length)return;
  // Remap to expected field names
  Object.assign(r,{pts,segments,avgAv,dist,vdvSession,fsUsed});
  const ptsJ=JSON.stringify(r.pts.map(p=>({lat:p.lat,lon:p.lon,av:+(p.av||0).toFixed(4),speed:+(p.speed||0).toFixed(1)})));
  const segsJ=JSON.stringify((r.segments||[]).map(s=>({pts:s.pts||[],avAvg:+(s.avAvg||0).toFixed(4),vdv:+(s.vdv||0).toFixed(4),color:s.color||'#888',level:s.level})));
  const segRows=(r.segments||[]).map((s,i)=>`<tr><td>${i+1}</td><td style="font-weight:700;color:${s.color||'#888'}">${(s.avAvg||0).toFixed(3)}</td><td>${(s.vdv||0).toFixed(3)}</td><td style="color:${s.color||'#888'}">${s.level}</td></tr>`).join('');
  const scaleJ=JSON.stringify(COMFORT_SCALE.map(s=>({max:s.max===Infinity?9999:s.max,color:s.color,label:s.label})));
  const html=`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confort de Marcha — Roadcheck IRI</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',Arial,sans-serif;background:#05111F;color:#B8D0E4}.tb{display:flex;align-items:center;gap:10px;padding:9px 14px;background:#091829;border-bottom:1px solid rgba(14,165,233,.2);position:sticky;top:0;z-index:1000}.back{padding:6px 13px;background:rgba(14,165,233,.12);border:1px solid rgba(14,165,233,.25);border-radius:4px;color:#0EA5E9;font-size:.73rem;font-weight:700;cursor:pointer}.rt{font-size:.82rem;font-weight:700;color:#0EA5E9;letter-spacing:1px;font-family:'Courier New',monospace;text-transform:uppercase}.c{padding:12px 12px 28px}h2{font-size:.67rem;text-transform:uppercase;letter-spacing:2px;color:#3A5F7A;margin-bottom:9px;font-family:'Courier New',monospace;padding-top:12px}.cards{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px}.card{background:#091829;border:1px solid rgba(14,165,233,.15);border-radius:6px;padding:9px 14px;flex:1;min-width:90px;text-align:center}.card .v{font-size:1.35rem;font-weight:700;font-family:'Courier New',monospace;color:#F59E0B}.card .l{font-size:.57rem;color:#3A5F7A;text-transform:uppercase;letter-spacing:1px;margin-top:2px}#map{height:300px;border-radius:6px;overflow:hidden;border:1px solid rgba(14,165,233,.2);margin-bottom:10px}.bx{background:#091829;border:1px solid rgba(14,165,233,.1);border-radius:6px;padding:10px;margin-bottom:7px}.disclaimer{background:#0D2040;border:1px solid rgba(245,158,11,.35);border-radius:6px;padding:12px 14px;margin-bottom:10px;font-size:.64rem;color:#B8D0E4;line-height:1.7}.disc-title{font-size:.59rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#F59E0B;margin-bottom:5px;font-family:'Courier New',monospace}table{width:100%;border-collapse:collapse;font-size:.7rem}th{background:#091829;padding:7px 8px;text-align:left;font-size:.58rem;text-transform:uppercase;color:#3A5F7A;letter-spacing:1px;font-family:'Courier New',monospace}td{padding:7px 8px;border-bottom:1px solid rgba(14,165,233,.07)}</style>
</head><body>
<div class="tb"><button class="back" onclick="history.length>1?history.back():window.close()">← Volver</button><div class="rt">Confort de Marcha — ISO 2631-1</div></div>
<div class="c">
<div class="disclaimer"><div class="disc-title">⚠ Advertencia Metodológica — Leer antes de usar este informe en peritajes</div>${escH(COMFORT_DISCLAIMER)}</div>
<h2>Resumen</h2>
<div class="cards">
<div class="card"><div class="v">${(r.avgAv||0).toFixed(3)}</div><div class="l">a_v medio (m/s²)</div></div>
<div class="card"><div class="v">${((r.dist||0)/1000).toFixed(2)}</div><div class="l">Distancia (km)</div></div>
<div class="card"><div class="v">${(r.segments||[]).length}</div><div class="l">Segmentos</div></div>
<div class="card"><div class="v" style="font-size:.75rem;color:${classifyComfort(r.avgAv||0).color}">${classifyComfort(r.avgAv||0).label}</div><div class="l">Nivel ISO 2631-1</div></div>
</div>
<p style="font-size:.58rem;color:#3A5F7A;margin-bottom:8px;font-family:'Courier New',monospace">${escH(r.name||'')} · ${fmtD(Date.parse(r.date))} · fs: ${(r.fsUsed||60).toFixed(0)} Hz · VDV_Z: ${((r.vdvSession?.z)||0).toFixed(3)} m/s^1.75</p>
<h2>Mapa de Calor de Confort</h2><div id="map"></div>
<h2>a_v por Segmento</h2>
<div class="bx"><div style="height:200px"><canvas id="c1"></canvas></div></div>
<h2>Datos por Segmento</h2>
<table><thead><tr><th>#</th><th>a_v (m/s²)</th><th>VDV (m/s^1.75)</th><th>Nivel</th></tr></thead><tbody>${segRows}</tbody></table>
</div>
<script>
const SEGS=${segsJ},PTS=${ptsJ},SCALE=${scaleJ};
function cCol(av){return(SCALE.find(s=>av<=s.max)||SCALE[SCALE.length-1]).color;}
const map=L.map('map',{zoomControl:true,attributionControl:true});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,subdomains:['a','b','c'],attribution:'© OpenStreetMap'}).addTo(map);
const allP=[];
SEGS.forEach(s=>{if(!s.pts||s.pts.length<2)return;const c=s.pts.map(p=>[p.lat,p.lon]);L.polyline(c,{color:s.color||cCol(s.avAvg),weight:7,opacity:.9}).addTo(map).bindTooltip('a_v: '+s.avAvg+' m/s² · '+s.level);allP.push(...c);});
if(allP.length)map.fitBounds(L.latLngBounds(allP),{padding:[14,14]});
new Chart(document.getElementById('c1'),{type:'bar',data:{labels:SEGS.map((_,i)=>i+1),datasets:[{label:'a_v medio (m/s²)',data:SEGS.map(s=>s.avAvg),backgroundColor:SEGS.map(s=>(s.color||cCol(s.avAvg))+'cc'),borderColor:SEGS.map(s=>s.color||cCol(s.avAvg)),borderWidth:1}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{min:0,title:{display:true,text:'a_v (m/s²)',color:'#5A7E9C',font:{size:11}},ticks:{color:'#5A7E9C'},grid:{color:'rgba(14,165,233,.07)'}},x:{title:{display:true,text:'Segmento',color:'#3A5F7A',font:{size:11}},ticks:{color:'#3A5F7A'}}}}});
<\/script></body></html>`;
  dlBlob(html,'text/html','confort_'+r.id.slice(-6)+'.html');toast('Informe de confort exportado ✓');
}

// ─ comfort filters ISO 2631-1 (Fase 2) ────────
// ⚠️ Parámetros reconstruidos desde fuentes secundarias — validar curva en Fase 7.
const ISO2631_PARAMS={
  bandLimit:{f1:0.4,f2:100,Q:0.71},
  transition_Wk:{f:12.5,Q:0.63},
  transition_Wd:{f:2.0,Q:0.63},
  step_Wk:{f5:2.37,Q5:0.91,f6:3.35,Q6:0.91}
};

function bilinearTransform(b2,b1,b0,a2,a1,a0,fs){
  const c=2*fs;
  const a0d=a2*c*c+a1*c+a0;
  return{b0:(b2*c*c+b1*c+b0)/a0d,b1:(2*b0-2*b2*c*c)/a0d,b2:(b2*c*c-b1*c+b0)/a0d,
         a1:(2*a0-2*a2*c*c)/a0d,a2:(a2*c*c-a1*c+a0)/a0d};
}
function makeBiquad(co){
  let z1=0,z2=0;
  return x=>{const y=co.b0*x+z1;z1=co.b1*x-co.a1*y+z2;z2=co.b2*x-co.a2*y;return y;};
}
function prewarp(fHz,fs){return 2*fs*Math.tan(Math.PI*fHz/fs);}
function highPassSection(fHz,Q,fs){const w=prewarp(fHz,fs);return bilinearTransform(1,0,0,1,w/Q,w*w,fs);}
function lowPassSection(fHz,Q,fs){const w=prewarp(fHz,fs);return bilinearTransform(0,0,w*w,1,w/Q,w*w,fs);}
// HT: sección transición aceleración-velocidad ISO 2631-1 Tabla 1
// H(s) = (1 + s/ω3) / (1 + s/(Q4·ω4) + (s/ω4)²)
function HT(f3,f4,Q4,fs){
  const w3=prewarp(f3,fs),w4=prewarp(f4,fs);
  return bilinearTransform(0,1/w3,1, 1/(w4*w4),1/(Q4*w4),1, fs);
}
// HS: sección escalón (solo Wk) ISO 2631-1 Tabla 1
// H(s) = k·(1/ω5²·s²+1/(Q5·ω5)·s+1) / (1/ω6²·s²+1/(Q6·ω6)·s+1), k=(ω5/ω6)²
function HS(f5,Q5,f6,Q6,fs){
  const w5=prewarp(f5,fs),w6=prewarp(f6,fs),k=(w5/w6)*(w5/w6);
  return bilinearTransform(k/(w5*w5),k/(Q5*w5),k, 1/(w6*w6),1/(Q6*w6),1, fs);
}
// Wk = Hh(0.4Hz)×Hl(f2)×HT(12.5Hz)×HS(2.37/3.35Hz) — Oh et al. NCE 2017 / ISO 2631-1 Tabla 1
function buildWkCascade(fs){
  const f2=Math.min(100,0.95*fs/2); // clamp: f2=100Hz supera Nyquist si fs<=200Hz
  const stages=[
    makeBiquad(highPassSection(0.4,0.7071,fs)),
    makeBiquad(lowPassSection(f2,0.7071,fs)),
    makeBiquad(HT(12.5,12.5,0.63,fs)),
    makeBiquad(HS(2.37,0.94,3.35,0.91,fs))
  ];
  return x=>stages.reduce((v,s)=>s(v),x);
}
// Wd = Hh(0.4Hz)×Hl(f2)×HT(2.0Hz) — Oh et al. NCE 2017 / ISO 2631-1 Tabla 1
function buildWdCascade(fs){
  const f2=Math.min(100,0.95*fs/2);
  const stages=[
    makeBiquad(highPassSection(0.4,0.7071,fs)),
    makeBiquad(lowPassSection(f2,0.7071,fs)),
    makeBiquad(HT(2.0,2.0,0.63,fs))
  ];
  return x=>stages.reduce((v,s)=>s(v),x);
}
function rebuildComfortFilters(fs){
  const cf=S.comfort;
  cf.filtersZ=buildWkCascade(fs);
  cf.filtersX=buildWdCascade(fs);
  cf.filtersY=buildWdCascade(fs);
}
function trackSampleRate(timestamp){
  const cf=S.comfort;
  if(cf._lastTs){
    const dt=timestamp-cf._lastTs;
    if(dt>0&&dt<100){cf._dtBuffer.push(dt);if(cf._dtBuffer.length>120)cf._dtBuffer.shift();}
  }
  cf._lastTs=timestamp;
  if(cf._dtBuffer.length>=60){
    const avgDt=cf._dtBuffer.reduce((a,b)=>a+b,0)/cf._dtBuffer.length;
    const measuredFs=1000/avgDt;
    if(Math.abs(measuredFs-cf.fsActual)/cf.fsActual>0.10){cf.fsActual=measuredFs;rebuildComfortFilters(measuredFs);}
  }
}

// ─ comfort sample processing (Fase 3) ─────────
const COMFORT_K_FACTORS={kx:1.4,ky:1.4,kz:1.0};

function onComfortSample(x,y,z,timestamp){
  trackSampleRate(timestamp);
  const cf=S.comfort;
  if(!cf.filtersZ)rebuildComfortFilters(cf.fsActual);
  const g=S.grav;if(!g)return;
  const vertRaw=x*g.x+y*g.y+z*g.z-S.gravMag;
  // Proyección horizontal ortogonal al eje vertical (aproximación V1)
  const vertX=x-(x*g.x)*g.x;
  const vertY=y-(y*g.y)*g.y;
  const wZ=cf.filtersZ(vertRaw);
  const wX=cf.filtersX(vertX);
  const wY=cf.filtersY(vertY);
  updateRunningRMSComfort('Z',wZ);
  updateRunningRMSComfort('X',wX);
  updateRunningRMSComfort('Y',wY);
  accumulateVDV(wZ,wX,wY,timestamp);
  computeLiveComfort();
}
function updateRunningRMSComfort(axis,sample){
  const key='rmsWindow'+axis,cf=S.comfort;
  cf[key].push(sample);
  const maxLen=Math.round(cf.fsActual*1.0);
  if(cf[key].length>maxLen)cf[key].shift();
}
function rmsOf(arr){if(!arr.length)return 0;return Math.sqrt(arr.reduce((s,v)=>s+v*v,0)/arr.length);}
function accumulateVDV(wZ,wX,wY,timestamp){
  const cf=S.comfort;
  const dt=cf._lastVdvTs?(timestamp-cf._lastVdvTs)/1000:0.0167;
  cf._lastVdvTs=timestamp;
  cf.sumPow4Z+=Math.pow(Math.abs(wZ),4)*dt;
  cf.sumPow4X+=Math.pow(Math.abs(wX),4)*dt;
  cf.sumPow4Y+=Math.pow(Math.abs(wY),4)*dt;
}
function computeLiveComfort(){
  const cf=S.comfort;
  const awZ=rmsOf(cf.rmsWindowZ),awX=rmsOf(cf.rmsWindowX),awY=rmsOf(cf.rmsWindowY);
  const avRaw=Math.sqrt((COMFORT_K_FACTORS.kx**2)*awX**2+(COMFORT_K_FACTORS.ky**2)*awY**2+(COMFORT_K_FACTORS.kz**2)*awZ**2);
  const avRaw2=Math.max(0,avRaw-(cf.avBaseline||0));
  const av=avRaw2<0.05?0:avRaw2;
  cf.avLive=av;
  if(av>0.8)registerChartMark('#A855F7','comfort');
  const _av=av;queueUI('comfort',()=>updateComfortUI(_av));
}
// ─ comfort UI (Fase 4) ────────────────────────
const COMFORT_SCALE=[
  {max:0.05,  level:'none',           label:'Sin vibración perceptible',color:'#3A5F7A'},
  {max:0.315,level:'no_confortable',  label:'Confortable',            color:'#10B981'},
  {max:0.5,  level:'poco',            label:'Un poco incómodo',       color:'#84CC16'},
  {max:0.8,  level:'moderado',        label:'Moderadamente incómodo', color:'#F59E0B'},
  {max:1.25, level:'incomodo',        label:'Incómodo',               color:'#F97316'},
  {max:2.0,  level:'muy_incomodo',    label:'Muy incómodo',           color:'#EF4444'},
  {max:Infinity,level:'extremo',      label:'Extremadamente incómodo',color:'#991B1B'}
];
function classifyComfort(av){return COMFORT_SCALE.find(s=>av<=s.max)||COMFORT_SCALE[COMFORT_SCALE.length-1];}
function updateComfortUI(av){
  const cls=classifyComfort(av);
  set('comfortAv',av.toFixed(3));
  set('comfortLevel',cls.label);
  const lvEl=$('comfortLevel');if(lvEl)lvEl.style.color=cls.color;
  const pct=Math.min(100,(av/2.5)*100);
  const bf=$('comfortBarFill');
  if(bf){bf.style.width=pct+'%';bf.style.background=cls.color;}
  set('comfortVdv',getVDV('Z').toFixed(2));
  // Badge de confort en modo combinado (BUG 3)
  const badge=$('measComfortBadge');
  if(badge){
    const isComboMode=S.activeModes.has('comfort')&&(S.activeModes.has('iri')||S.activeModes.has('urban'));
    badge.classList.toggle('hidden',!S.active||!isComboMode);
    const mcbVal=$('mcbVal');
    if(mcbVal){mcbVal.textContent=cls.label;mcbVal.style.color=cls.color;}
  }
  // Panel solo-confort en medición
  const soloPanel=$('measComfortSolo');
  if(soloPanel){
    const soloOnly=S.activeModes.has('comfort')&&!S.activeModes.has('iri')&&!S.activeModes.has('urban');
    soloPanel.classList.toggle('hidden',!S.active||!soloOnly);
    set('mcsAv',av.toFixed(3));
    const mcsLvl=$('mcsLevel');
    if(mcsLvl){mcsLvl.textContent=cls.label;mcsLvl.style.color=cls.color;}
  }
}
function getVDV(axis){return Math.pow(Math.max(0,S.comfort['sumPow4'+axis]),0.25);}
function closeComfortSegment(){
  const cf=S.comfort;
  if(!cf._currentSegPts.length)return;
  const avVals=cf._currentSegPts.map(p=>p.av);
  const avAvg=Math.sqrt(avVals.reduce((s,v)=>s+v*v,0)/avVals.length||0);
  const cls=classifyComfort(avAvg);
  cf.segments.push({pts:cf._currentSegPts.map(p=>({lat:p.lat,lon:p.lon})),avAvg,vdv:getVDV('Z'),level:cls.level,color:cls.color});
  cf._currentSegPts=[];cf._segDist=0;cf._segStartPow4Z=cf.sumPow4Z;
  set('aSegs',cf.segments.length.toString());
}
function stopComfortSession(){
  const cf=S.comfort;
  if(cf._currentSegPts.length>0)closeComfortSegment();
  if(cf.pts.length<2){toast('Sin datos de confort suficientes');return;}
  const allAv=cf.pts.map(p=>p.av);
  const avgAv=Math.sqrt(allAv.reduce((s,v)=>s+v*v,0)/allAv.length);
  S.pendingComfortRoute={id:Date.now().toString(),date:new Date().toISOString(),type:'comfort',name:'',
    pts:cf.pts,segments:cf.segments,avgAv,
    vdvSession:{z:getVDV('Z'),x:getVDV('X'),y:getVDV('Y')},
    vehicleProfile:cf.vehicleProfile,fsUsed:cf.fsActual,dist:S.dist};
  $('routeNameInput').value='';$('routeNameModal').classList.remove('hidden');
  updateNoiseFilterUI();
}

// ─ Garage ─────────────────────────────────────
function openGarage(){renderGarage();$('garageModal').classList.remove('hidden');}
function closeGarage(){$('garageModal').classList.add('hidden');}
function openAddVehicle(){$('vName').value='';$('addVehicleModal').classList.remove('hidden');}
function closeAddVehicle(){$('addVehicleModal').classList.add('hidden');}
function saveNewVehicle(){
  const name=$('vName').value.trim();if(!name){toast('Escribe un nombre');return;}
  const cust=JSON.parse(localStorage.getItem('rc_cveh')||'[]');
  const v={id:'vc'+Date.now(),name,cat:$('vCat').value,coefA:parseFloat($('vCoefA').value),coefB:parseFloat($('vCoefB').value),desc:'Personalizado',custom:true};
  cust.push(v);localStorage.setItem('rc_cveh',JSON.stringify(cust));
  closeAddVehicle();selectVehicle(v.id);toast('Vehículo añadido');
}
function selectVehicle(id){
  const v=allVeh().find(v=>v.id===id);if(!v)return;
  C.coefA=v.coefA;C.coefB=v.coefB;S.vehicleId=id;
  localStorage.setItem('rc_veh',id);saveCfg();
  updateVehUI(v);renderGarage();toast('Vehículo: '+v.name.split('(')[0].trim());
}
function updateVehUI(v){
  const sh=v.name.split('(')[0].trim().split(' ').slice(0,3).join(' ');
  set('lVEH',sh);const c=$('cVEH');if(c)c.className='chip ok';set('vehVal',sh.substring(0,14));
}
function delCustVeh(id){
  if(!id.startsWith('vc'))return;
  const cust=JSON.parse(localStorage.getItem('rc_cveh')||'[]').filter(v=>v.id!==id);
  localStorage.setItem('rc_cveh',JSON.stringify(cust));
  if(S.vehicleId===id){S.vehicleId=null;localStorage.removeItem('rc_veh');set('lVEH','🚗 Vehículo');$('cVEH').className='chip veh';set('vehVal','Sin seleccionar');}
  renderGarage();toast('Eliminado');
}
function renderGarage(){
  const cats=['Compacto','Sedán','SUV','Deportivo','Pick-up','Furgoneta','Personalizado'];
  let h='';
  cats.forEach(cat=>{
    const vs=allVeh().filter(v=>v.cat===cat);if(!vs.length)return;
    h+='<div class="cat-h">'+cat+'</div>';
    vs.forEach(v=>{
      const a=S.vehicleId===v.id;
      h+='<div class="veh-row'+(a?' active':'')+'" onclick="selectVehicle(\''+v.id+'\')"><div><div class="veh-n">'+escH(v.name)+'</div><div class="veh-s">a:'+v.coefA.toFixed(2)+' b:'+v.coefB.toFixed(2)+' · '+escH((v.desc||'').substring(0,48))+'</div></div><div style="display:flex;gap:4px;align-items:center">'+(a?'<span style="color:#0EA5E9">✓</span>':'')+(v.id.startsWith('vc')?'<button class="btn btn-xs btn-red" onclick="event.stopPropagation();delCustVeh(\''+v.id+'\')">✕</button>':'')+'</div></div>';
    });
  });
  $('garageList').innerHTML=h;
}

// ─ Modals ─────────────────────────────────────
function openSegModal(){$('segSlider').value=C.segLen;set('segValLbl',C.segLen+' m');$('segModal').classList.remove('hidden');}
function closeSegModal(){$('segModal').classList.add('hidden');}
function saveSegLen(){C.segLen=parseInt($('segSlider').value);saveCfg();closeSegModal();set('segVal',C.segLen+' m');toast('Tramo: '+C.segLen+' m');}
function openSpeedModal(){$('vRefSlider').value=C.vRef;set('vRefLbl',C.vRef);$('vExpSlider').value=C.vExp;set('vExpLbl',C.vExp.toFixed(2));$('vMinSlider').value=C.vMin;set('vMinLbl',C.vMin);$('speedModal').classList.remove('hidden');}
function closeSpeedModal(){$('speedModal').classList.add('hidden');}
function saveSpeedCfg(){C.vRef=parseInt($('vRefSlider').value);C.vExp=parseFloat($('vExpSlider').value);C.vMin=parseInt($('vMinSlider').value);saveCfg();closeSpeedModal();set('vrefVal',C.vRef+' km/h');toast('v_ref='+C.vRef+' km/h n='+C.vExp.toFixed(2));}

// ─ Map center button ──────────────────────────
function centerMapOnMe(which){
  const map=which==='main'?S.mapMain:S.mapMeas;
  if(!map||!S.lastPos){toast('Sin posición GPS todavía');return;}
  const center=map.getCenter();
  const dist=geo(center.lat,center.lng,S.lastPos.lat,S.lastPos.lon);
  const animate=dist<500;
  map.setView([S.lastPos.lat,S.lastPos.lon],17,{animate});
}

// ─ Navigation ─────────────────────────────────
function switchTab(tab){
  ['main','history','visor'].forEach(t=>{
    const s=document.getElementById('tab-'+t),b=document.getElementById('tb-'+t);
    if(s)s.classList.toggle('hidden',t!==tab);
    if(b)b.classList.toggle('active',t===tab);
  });
  if(tab==='history')loadHistory();
  if(tab==='visor'){loadVisor();setTimeout(()=>{try{S.mapVisor?.invalidateSize();}catch(e){}refreshVisor();},150);}
  if(tab==='main')setTimeout(()=>{try{S.mapMain?.invalidateSize();}catch(e){}},100);
}

// ─ INIT ──────────────────────────────────────
window.addEventListener('load',()=>{
  loadCfg();
  pruneOldImages();
  startGPS();
  startSensor();
  $('segSlider')?.addEventListener('input',function(){set('segValLbl',this.value+' m');});
  $('vRefSlider')?.addEventListener('input',function(){set('vRefLbl',this.value);});
  $('vExpSlider')?.addEventListener('input',function(){set('vExpLbl',parseFloat(this.value).toFixed(2));});
  $('vMinSlider')?.addEventListener('input',function(){set('vMinLbl',this.value);});
  set('segVal',C.segLen+' m');set('vrefVal',C.vRef+' km/h');
  renderModeUI();
  renderMainPanels();
  // Doble rAF garantiza layout calculado antes de recalcMainLayout
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    initStaticMaps();
    recalcMainLayout();
  }));
  window.addEventListener('resize',()=>recalcMainLayout());
  console.log('[Pavement Check v4.0] OK');
});

// ─ EKG 3 canales Canvas 2D (Fase 4 v2) ───────────
const EKG={buf:{marks:[],max:120,totalSamples:0}};
const GAL={
  items:[],idx:0,activeFrameIdx:1,
  img:null,scale:1,minScale:1,maxScale:5,
  offsetX:0,offsetY:0,
  _lastTouchDist:null,_lastTouchX:null,_lastTouchY:null,
  _isDragging:false,_lastTap:0
};
function updateAccelViz(ax,ay,az){
  const dot=$('avDot'),zFill=$('avZfill'),zVal=$('avZval');
  if(!dot||!zFill||!S.grav)return;
  EKG.buf.totalSamples++;
  const g=S.grav;
  const vertRaw=ax*g.x+ay*g.y+az*g.z-S.gravMag;
  const dot_ag=ax*g.x+ay*g.y+az*g.z;
  const projX=ax-dot_ag*g.x;
  const projY=ay-dot_ag*g.y;
  const MAX_XY=4;
  const pctX=Math.max(-44,Math.min(44,(projX/MAX_XY)*44));
  const pctY=Math.max(-44,Math.min(44,(-projY/MAX_XY)*44));
  dot.style.left=(50+pctX)+'%';
  dot.style.top=(50+pctY)+'%';
  const magXY=Math.sqrt(projX*projX+projY*projY);
  if(!dot.classList.contains('event')){
    dot.className='av-dot'+(magXY>2?' bad':magXY>1?' warn':'');
  }
  const MAX_Z=6;
  const pctZ=Math.max(0,Math.min(50,Math.abs(vertRaw)/MAX_Z*50));
  zFill.style.height=pctZ+'%';
  if(!zFill.classList.contains('event')){
    zFill.className='av-zfill'+(Math.abs(vertRaw)>3?' bad':Math.abs(vertRaw)>1.5?' warn':'');
  }
  if(zVal)zVal.textContent=vertRaw.toFixed(2);
}
function flashAccelEvent(color){
  const dot=$('avDot'),zFill=$('avZfill');
  if(dot){dot.style.color=color;dot.classList.add('event');setTimeout(()=>dot.classList.remove('event'),700);}
  if(zFill){zFill.classList.add('event');setTimeout(()=>zFill.classList.remove('event'),700);}
}
function registerChartMark(color,source){
  if(!EKG.buf)return;
  const now=EKG.buf.totalSamples;
  const lastMark=EKG.buf.marks[EKG.buf.marks.length-1];
  if(lastMark&&(now-lastMark.absIdx)<45)return;
  EKG.buf.marks.push({absIdx:now-1,color,source,ts:Date.now()});
  EKG.buf.marks=EKG.buf.marks.filter(m=>(now-m.absIdx)<=EKG.buf.max);
  flashAccelEvent(color);
}

// ─ Calibración adaptativa A3 ──────────────────
function toggleAutoRecal(){
  S.autoRecalEnabled=!S.autoRecalEnabled;
  set('autoRecalVal',S.autoRecalEnabled?'Activada':'Desactivada');
  $('btnAutoRecal').style.opacity=S.autoRecalEnabled?'1':'0.5';
  toast(S.autoRecalEnabled?'🔄 Recalibración automática activada':'⏸ Recalibración automática desactivada');
}
function feedAdaptiveCalibration(x,y,z,timestamp){
  if(!S.calibrated||!S.grav)return;
  if(!S.autoRecalEnabled&&!S._manualRecalRequest)return;
  const speed=S.lastPos?.speed||0;
  const stopped=speed<2;
  if(stopped){
    S.adaptiveCal._stopStart=S.adaptiveCal._stopStart||timestamp;
    const stopDuration=timestamp-S.adaptiveCal._stopStart;
    if(stopDuration<4000)return;
  } else {
    S.adaptiveCal._stopStart=null;
    if(!S._manualRecalRequest){
      S.adaptiveCal.status='idle';
      queueUI('adaptiveCal',updateAdaptiveCalUI);
      return;
    }
  }
  if(S._manualRecalRequest)S._manualRecalRequest=false;
  S.adaptiveCal.status='sampling';
  queueUI('adaptiveCal',updateAdaptiveCalUI);
  S.adaptiveCal.gravBuf.push({x,y,z});
  if(S.adaptiveCal.gravBuf.length>S.adaptiveCal.gravBufMax)S.adaptiveCal.gravBuf.shift();
  if(S.adaptiveCal.gravBuf.length<S.adaptiveCal.gravBufMax)return;
  let mx=0,my=0,mz=0;
  S.adaptiveCal.gravBuf.forEach(s=>{mx+=s.x;my+=s.y;mz+=s.z;});
  const n=S.adaptiveCal.gravBuf.length;
  mx/=n;my/=n;mz/=n;
  const mag=Math.sqrt(mx*mx+my*my+mz*mz);
  if(mag<0.5)return;
  const newGrav={x:mx/mag,y:my/mag,z:mz/mag};
  const g=S.grav;
  const dot=Math.min(1,Math.abs(newGrav.x*g.x+newGrav.y*g.y+newGrav.z*g.z));
  const driftDeg=Math.acos(dot)*180/Math.PI;
  S.adaptiveCal.driftDeg=driftDeg;
  S.adaptiveCal.lastUpdate=timestamp;
  S.adaptiveCal.updateCount++;
  S.adaptiveCal.gravBuf=[];
  S.adaptiveCal._stopStart=null;
  S.grav=newGrav;S.gravMag=mag;
  S.adaptiveCal.status='updated';
  if(S.comfort?.avBaseline!==undefined){
    S.comfort.avBaseline=Math.max(0,S.comfort.avLive||0)*0.5;
  }
  console.log('[CalAdaptiva] Recalibrado en parada · deriva='+driftDeg.toFixed(2)+'° · ×'+S.adaptiveCal.updateCount);
  queueUI('adaptiveCal',updateAdaptiveCalUI);
}
function requestManualRecal(){
  if(!S.calibrated){toast('Calibra el sensor primero');return;}
  S._manualRecalRequest=true;
  S.adaptiveCal.gravBuf=[];
  S.adaptiveCal.status='sampling';
  queueUI('adaptiveCal',updateAdaptiveCalUI);
  toast('🎯 Recalibrando… mantén el móvil quieto 3s');
}
function updateAdaptiveCalUI(){
  const st=S.adaptiveCal.status;
  const dot=$('aciDot'),txt=$('aciTxt');
  const cnt=$('aciCount'),cntVal=$('aciCountVal');
  const driftEl=$('aciDrift');
  if(!dot||!txt)return;
  const colors={idle:'#3A5F7A',sampling:'#0EA5E9',updated:'#10B981',drift_warning:'#F59E0B'};
  dot.style.background=colors[st]||'#3A5F7A';
  dot.className='acb-dot'+(st==='sampling'?' sampling':'');
  const texts={idle:'Cal. estática',sampling:'Recalibrando…',updated:'Cal. adaptativa activa',drift_warning:'Deriva detectada — corrigiendo'};
  txt.textContent=texts[st]||'Cal. estática';
  const n=S.adaptiveCal.updateCount;
  if(cnt){cnt.classList.toggle('hidden',n===0);if(cntVal)cntVal.textContent=n;}
  if(driftEl){const d=S.adaptiveCal.driftDeg;driftEl.classList.toggle('hidden',d<=0.5);driftEl.textContent='Δ'+d.toFixed(1)+'°';}
}

// ─ Análisis Gemini (Fase 3) ───────────────────
async function analyzeEventWithGemini(event,imageBlob){
  if(!imageBlob)return;
  const base64=await new Promise(resolve=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(imageBlob);
  });
  event.imageSrc='data:image/jpeg;base64,'+base64;
  const payload={
    image:base64,
    features:{
      peakAmp:event.features?.peakAmp||0,
      jerkMax:event.features?.jerkMax||0,
      duration:event.features?.duration||0,
      bipolarity:event.features?.bipolarity||0,
      freqEnergy:event.features?.freqEnergy||0,
      speed:event.speed||0
    }
  };
  try{
    const res=await fetch(`${WORKER_URL}/api/analyze`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });
    const analysis=await res.json();
    event.gemini=analysis;
    event.imageBlob=imageBlob;
    if(analysis.discard){
      event.geminiSuggestsDiscard=true;
      toast('🔍 IA sugiere falso positivo — revísalo en la galería');
      console.log('[Gemini] Sugiere descarte: '+analysis.description);
    }else{
      if(analysis.type&&analysis.type!=='unknown')event.type=analysis.type;
      if(analysis.severity&&analysis.severity!=='none')event.severity=analysis.severity;
      event.geminiConfidence=analysis.confidence;
      event.geminiDescription=analysis.description;
      showEventThumbnail(event,imageBlob);
      toast('🔍 '+analysis.description+' (conf. '+(analysis.confidence*100).toFixed(0)+'%)');
      console.log('[Gemini] '+analysis.type+'/'+analysis.severity+' conf='+analysis.confidence+' — '+analysis.description);
    }
    queueUI('urban_meas',updateUrbanMeasPanel);
    return analysis;
  }catch(e){
    console.log('[Gemini] Error: '+e.message);
    return null;
  }
}

function showEventThumbnail(event,blob){
  const url=URL.createObjectURL(blob);
  const thumb=$('lastEventThumb');
  if(thumb){
    thumb.src=url;thumb.style.display='block';thumb.title=event.geminiDescription||event.type;
    thumb.onclick=()=>openLightbox(url,event);
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
}
function openLightbox(url,event){
  $('lightboxImg').src=url;
  const info=event.geminiDescription
    ?'🔍 '+event.geminiDescription+' · '+event.type+' · '+event.severity
    :event.type+' · '+event.severity+' · score '+(event.score?.toFixed(0)||'—');
  set('lightboxInfo',info);
  $('photoLightbox').classList.remove('hidden');
}
function closeLightbox(){
  $('photoLightbox').classList.add('hidden');
  $('lightboxImg').src='';
}
window.closeLightbox=closeLightbox;

function updateUrbanMeasPanel(){
  const counts=S.urbanEvents.reduce((a,e)=>{a[e.severity]=(a[e.severity]||0)+1;return a;},{});
  set('muLeve',(counts.leve||0).toString());
  set('muMod',(counts.moderado||0).toString());
  set('muGrave',(counts.grave||0).toString());
  const last=S.urbanEvents[S.urbanEvents.length-1];
  if(last){const icons={pothole:'🕳️',manhole:'⭕',speedbump:'⛰️',unknown:'❓'};const mu=$('muLastEvent');if(mu)mu.textContent=`${icons[last.type]||'❓'} ${last.type} · ${last.severity} · score ${last.score.toFixed(0)}`;}
}

// ─ Buffer de vídeo (Fase 2) ───────────────────
const VIDEO_BUF={stream:null,video:null,canvas:null,ctx:null,frames:[],maxAgeMs:3000,capturing:false,captureInterval:null};

const YOLO_STATE = {
  session: null,
  loading: false,
  ready: false,
  MODEL_URL: '/models/pavement_yolo11n.onnx',
  INPUT_SIZE: 640,
  CONF_THRESHOLD: 0.40,
  NMS_THRESHOLD: 0.5,
  CLASS_NAMES: [
    'longitudinal_crack','transverse_crack','alligator_crack',
    'pothole','manhole'
  ]
};

async function initYOLO() {
  if (YOLO_STATE.ready || YOLO_STATE.loading) return;
  if (!window.ort) {
    console.log('[YOLO] ONNX Runtime no disponible');
    return;
  }
  YOLO_STATE.loading = true;
  try {
    ort.env.wasm.wasmPaths =
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
    YOLO_STATE.session = await ort.InferenceSession.create(
      YOLO_STATE.MODEL_URL,
      { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }
    );
    YOLO_STATE.ready = true;
    console.log('[YOLO] Modelo cargado OK');
  } catch(e) {
    console.log('[YOLO] No disponible: ' + e.message);
  }
  YOLO_STATE.loading = false;
}

async function initCameraSelector(){
  S.selectedCameraId=null;
  await startVideoBuffer();
}
function openCameraSelector(){
  if(!S._lastExternalCams?.length)return;
  showCameraSelector([
    ...S._lastExternalCams.map(d=>({deviceId:d.deviceId,label:'🔌 '+(d.label||'Cámara externa')})),
    {deviceId:'__builtin__',label:'📱 Cámara trasera'}
  ]);
}
function showCameraSelector(devices){
  $('cameraSelectorModal').classList.remove('hidden');
  $('cameraDeviceList').innerHTML=devices.map((d,i)=>`
    <label class="cam-opt">
      <input type="radio" name="camDev" value="${d.deviceId}" ${i===0?'checked':''}>
      <span>${d.label||'Cámara '+(i+1)}</span>
    </label>
  `).join('');
}
function confirmCameraSelection(){
  const sel=document.querySelector('input[name="camDev"]:checked');
  const val=sel?.value;
  S.selectedCameraId=(val&&val!=='__builtin__')?val:null;
  $('cameraSelectorModal').classList.add('hidden');
  startVideoBuffer();
}
function skipCamera(){
  S.selectedCameraId=null;
  $('cameraSelectorModal').classList.add('hidden');
}

async function startVideoBuffer(){
  if(VIDEO_BUF.capturing) stopVideoBuffer();
  try{
    VIDEO_BUF.stream=await navigator.mediaDevices
      .getUserMedia({
        video:{facingMode:'environment'},
        audio:false
      });
    if(!VIDEO_BUF.canvas){
      VIDEO_BUF.canvas=document.createElement('canvas');
    }
    VIDEO_BUF.canvas.width=640;
    VIDEO_BUF.canvas.height=480;
    VIDEO_BUF.ctx=VIDEO_BUF.canvas.getContext('2d');
    VIDEO_BUF.video=document.createElement('video');
    VIDEO_BUF.video.srcObject=VIDEO_BUF.stream;
    VIDEO_BUF.video.playsInline=true;
    VIDEO_BUF.video.muted=true;
    VIDEO_BUF.video.setAttribute('playsinline','');
    // Esperar a que el video esté listo antes de capturar
    await new Promise((resolve,reject)=>{
      VIDEO_BUF.video.oncanplay=resolve;
      VIDEO_BUF.video.onerror=reject;
      setTimeout(reject,5000); // timeout 5s
      VIDEO_BUF.video.play().catch(reject);
    });
    VIDEO_BUF.captureInterval=setInterval(()=>{
      if(!VIDEO_BUF.video||
         VIDEO_BUF.video.readyState<2||
         VIDEO_BUF.video.paused) return;
      try{
        VIDEO_BUF.ctx.drawImage(
          VIDEO_BUF.video,0,0,640,480);
        VIDEO_BUF.canvas.toBlob(blob=>{
          if(!blob)return;
          const ts=Date.now();
          VIDEO_BUF.frames.push({ts,blob});
          const cutoff=ts-VIDEO_BUF.maxAgeMs;
          while(VIDEO_BUF.frames.length>0&&
                VIDEO_BUF.frames[0].ts<cutoff)
            VIDEO_BUF.frames.shift();
        },'image/jpeg',0.75);
      }catch(e){}
    },250);
    VIDEO_BUF.capturing=true;
    toast('📷 Cámara lista — '+
          VIDEO_BUF.stream.getVideoTracks()[0].label);
  }catch(e){
    toast('⚠️ Cámara no disponible: '+e.name);
    VIDEO_BUF.capturing=false;
  }
}

function captureFrame(){
  if(!VIDEO_BUF.video||VIDEO_BUF.video.readyState<2)return;
  if(!VIDEO_BUF.ctx||!VIDEO_BUF.canvas)return;
  try{
    VIDEO_BUF.ctx.drawImage(
      VIDEO_BUF.video,0,0,
      VIDEO_BUF.canvas.width,
      VIDEO_BUF.canvas.height
    );
    VIDEO_BUF.canvas.toBlob(blob=>{
      if(!blob)return;
      const ts=Date.now();
      VIDEO_BUF.frames.push({ts,blob});
      const cutoff=ts-VIDEO_BUF.maxAgeMs;
      while(VIDEO_BUF.frames.length>0&&
            VIDEO_BUF.frames[0].ts<cutoff)
        VIDEO_BUF.frames.shift();
    },'image/jpeg',0.80);
  }catch(e){
    console.error('[captureFrame]',e.message);
  }
}

function stopVideoBuffer(){
  if(VIDEO_BUF.captureInterval){clearInterval(VIDEO_BUF.captureInterval);VIDEO_BUF.captureInterval=null;}
  if(VIDEO_BUF.stream)VIDEO_BUF.stream.getTracks().forEach(t=>t.stop());
  VIDEO_BUF.capturing=false;VIDEO_BUF.frames=[];VIDEO_BUF.stream=null;VIDEO_BUF.video=null;
  const btn=$('btnPhoto');if(btn)btn.classList.add('hidden');
}

function calcFrameDelay(speedKmh){
  const analysisMs=300;
  const cameraOffsetM=2.0;
  const speedMs=Math.max(speedKmh/3.6,0.1);
  return Math.min(analysisMs+(cameraOffsetM/speedMs)*1000,VIDEO_BUF.maxAgeMs*0.85);
}
function extractFramesForEvent(eventTs,speedKmh){
  if(!VIDEO_BUF.frames.length){return[];}
  const D=calcFrameDelay(speedKmh);
  const targets=[
    {label:'A',ts:eventTs-(D+400)},
    {label:'B',ts:eventTs-(D+200)},
    {label:'C',ts:eventTs-D}
  ];
  const results=targets.map(t=>{
    let best=null,bestDiff=Infinity;
    VIDEO_BUF.frames.forEach(f=>{const d=Math.abs(f.ts-t.ts);if(d<bestDiff){best=f;bestDiff=d;}});
    const valid=best&&bestDiff<800;
    return valid?{blob:best.blob,label:t.label,diff:bestDiff}:null;
  }).filter(Boolean);
  const seen=new Set();
  return results.filter(r=>{if(seen.has(r.blob))return false;seen.add(r.blob);return true;});
}

function extractFrameForEvent(eventTs,speedKmh){
  if(!VIDEO_BUF.frames.length)return null;
  const delayMs=calcFrameDelay(speedKmh);
  const targetTs=eventTs-delayMs;
  let best=VIDEO_BUF.frames[0],bestDiff=Math.abs(VIDEO_BUF.frames[0].ts-targetTs);
  VIDEO_BUF.frames.forEach(f=>{const diff=Math.abs(f.ts-targetTs);if(diff<bestDiff){best=f;bestDiff=diff;}});
  return bestDiff<1500?best.blob:null;
}

function captureManualPhoto(){
  if(!VIDEO_BUF.capturing){toast('Cámara no disponible');return;}
  const blob=VIDEO_BUF.frames[VIDEO_BUF.frames.length-1]?.blob;
  if(!blob){toast('Sin frame disponible');return;}
  const manualEvent={
    id:Date.now()+'_manual',ts:Date.now(),
    lat:S.lastPos?.lat,lon:S.lastPos?.lon,
    speed:S.lastPos?.speed||0,
    type:'unknown',severity:'manual',score:0,manual:true,imageBlob:blob
  };
  S.urbanEvents.push(manualEvent);
  if(typeof analyzeEventWithGemini==='function')analyzeEventWithGemini(manualEvent,blob);
  toast('📷 Foto capturada — analizando…');
}

// ─ Helpers ────────────────────────────────────
function blobToBase64(blob){
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>res(r.result.split(',')[1]);
    r.onerror=rej;
    r.readAsDataURL(blob);
  });
}
function updateLearningStats(){}

// ─ Galería de validación ──────────────────────
function addToGallery(event){
  if(GAL.items.some(i=>i.event.id===event.id))return;
  GAL.items.push({event});
}
function showEventThumbnail(event){
  const thumb=$('lastEventThumb');if(!thumb)return;
  const frames=event._frameBlobs||[];
  const blob=frames[1]?.blob||frames[0]?.blob;
  if(!blob)return;
  const url=URL.createObjectURL(blob);
  thumb.src=url;thumb.style.display='block';
  const eventIdx=GAL.items.findIndex(i=>i.event.id===event.id);
  thumb.onclick=()=>openGallery(Math.max(0,eventIdx));
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function openGallery(startIdx=0){
  if(!GAL.items.length){toast('Sin eventos con imagen en esta sesión');return;}
  GAL.idx=Math.min(startIdx,GAL.items.length-1);
  $('eventGalleryModal').classList.remove('hidden');
  renderGalleryItem(GAL.idx);
  initGalleryGestures();
}
async function continueValidation(routeId){
  // routeId puede venir del botón de la tarjeta o del dataset del botón del detalle
  const rid = routeId || $('btnContinueValidation')?.dataset.routeId;
  if(!rid)return;

  const route=allRoutes().find(r=>r.id===rid);
  if(!route||!route.urbanData){toast('Ruta no encontrada');return;}

  toast('Cargando eventos…');
  const events=route.urbanData.events||[];

  GAL.items=await Promise.all(events.map(async(event)=>{
    const[blobA,blobB,blobC]=await getImageBlobs([
      event.id+'_A',event.id+'_B',event.id+'_C'
    ]);
    const frameBlobs=[];
    if(blobA)frameBlobs.push({blob:blobA,label:'A',diff:0});
    if(blobB)frameBlobs.push({blob:blobB,label:'B',diff:0});
    if(blobC)frameBlobs.push({blob:blobC,label:'C',diff:0});
    return{event:{...event,_frameBlobs:frameBlobs}};
  }));

  S._continuingValidationRouteId=rid;
  // Limpiar la copia obsoleta en memoria de esta
  // ruta — vamos a trabajar con datos frescos de
  // localStorage + IndexedDB, no con la sesión
  // original que quedó desactualizada
  if (S._lastSavedRouteWithBlobs?.id === rid) {
    S._lastSavedRouteWithBlobs = null;
  }
  const firstPending=GAL.items.findIndex(i=>!i.event.humanLabel);
  openGallery(firstPending>=0?firstPending:0);
}

function saveValidationProgress(routeId){
  try{
    const routes=allRoutes();
    const idx=routes.findIndex(r=>r.id===routeId);
    if(idx===-1)return;

    const updatedEvents=GAL.items.map(i=>{
      const{_frameBlobs,...cleanEvent}=i.event;
      return cleanEvent;
    });

    const validationComplete=updatedEvents.every(e=>!!e.humanLabel);
    const pendingCount=updatedEvents.filter(e=>!e.humanLabel).length;

    routes[idx].urbanData={
      ...routes[idx].urbanData,
      events:updatedEvents,
      validationComplete,
      pendingCount
    };

    localStorage.setItem('rc_routes',JSON.stringify(routes));
    if (S._lastSavedRouteWithBlobs?.id === routeId) {
      S._lastSavedRouteWithBlobs = null;
    }
  }catch(e){
    console.error('[saveValidationProgress]',e.message);
    toast('⚠️ Error guardando progreso');
  }
}

function closeGallery(){
  $('eventGalleryModal').classList.add('hidden');
  GAL.img=null;

  if(S._continuingValidationRouteId){
    saveValidationProgress(S._continuingValidationRouteId);
    S._continuingValidationRouteId=null;
    toast('✅ Progreso de validación guardado');
    loadHistory();
    return;
  }

  if(S.pendingRoute){
    showRouteNameModal();
  }
}
function galleryNav(dir){
  const newIdx=GAL.idx+dir;
  if(newIdx<0||newIdx>=GAL.items.length)return;
  GAL.idx=newIdx;renderGalleryItem(GAL.idx);
}
function openEventGallery(){
  if(!GAL.items.length){
    toast('Sin eventos registrados en esta sesión');
    return;
  }
  GAL.items.sort((a,b)=>(a.event.humanLabel?1:0)-(b.event.humanLabel?1:0));
  openGallery(0);
}
function renderGalleryItem(idx){
  const item=GAL.items[idx];if(!item)return;
  const{event}=item;
  set('galCounter',(idx+1)+' / '+GAL.items.length);
  renderGalleryDots(idx);
  $('galPrev').disabled=idx===0;
  $('galNext').disabled=idx===GAL.items.length-1;
  GAL.scale=1;GAL.offsetX=0;GAL.offsetY=0;
  GAL.activeFrameIdx=1;
  const frames=event._frameBlobs||[];
  const noFrames=frames.length===0;
  const canvas=$('galCanvas'),wrap=$('galImageWrap'),noImg=$('galNoImage'),
        thumbs=$('galThumbs'),badge=$('galFrameBadge');
  if(thumbs){
    if(noFrames){thumbs.innerHTML='';thumbs.style.display='none';}
    else{
      thumbs.style.display='flex';
      thumbs.innerHTML=frames.map((f,fi)=>{
        const url=URL.createObjectURL(f.blob);
        const active=fi===GAL.activeFrameIdx?' active':'';
        setTimeout(()=>URL.revokeObjectURL(url),60000);
        return`<div class="gal-thumb-wrap"><img class="gal-thumb${active}" src="${url}" onclick="selectGalleryFrame(${fi})" data-fi="${fi}"><div class="gal-thumb-label">${f.label} ${f.diff<100?'✓':'~'}${f.diff.toFixed(0)}ms</div></div>`;
      }).join('');
    }
  }
  if(noFrames){
    canvas.style.display='none';noImg.classList.remove('hidden');
    if(badge)badge.textContent='';
  } else {
    noImg.classList.add('hidden');canvas.style.display='block';
    loadFrameToCanvas(frames[GAL.activeFrameIdx]?.blob||frames[0]?.blob,
                      frames[GAL.activeFrameIdx]?.label||'B');
  }
  const typeIcons={pothole:'🕳️',manhole:'⭕',speedbump:'⛰️',crack:'〰️',degraded:'🔴',patch:'🔧',unknown:'❓'};
  const sevColors={leve:'#F59E0B',moderado:'#F97316',grave:'#EF4444'};
  const icon=typeIcons[event.type]||'❓';
  const sevColor=sevColors[event.severity]||'#3A5F7A';
  $('galBadges').innerHTML=[
    `<span class="gal-badge">${icon} ${event.type||'desconocido'}</span>`,
    `<span class="gal-badge" style="color:${sevColor}">${event.severity||'—'}</span>`,
    `<span class="gal-badge">Score: ${event.score?.toFixed(0)||'—'}</span>`,
    `<span class="gal-badge">${event.speed?.toFixed(0)||'—'} km/h</span>`,
    `<span class="gal-badge">${frames.length} frame${frames.length!==1?'s':''}</span>`,
    event.humanLabel
      ?`<span class="gal-badge ${event.humanLabel}">${event.humanLabel==='confirmed'?'✅':event.humanLabel==='discarded'?'❌':'✏️'} Validado</span>`
      :'<span class="gal-badge">Sin validar</span>',
    event.noiseCandidate
      ?'<span class="gal-badge" style="background:rgba(234,179,8,.2);color:#EAB308">🟡 Candidato a ruido</span>'
      :'',
    event.geminiSuggestsDiscard
      ?'<span class="gal-badge" style="background:rgba(239,68,68,.15);color:#EF4444">🤖 IA sugiere falso positivo</span>'
      :''
  ].join('');
  $('galDesc').textContent=event.gemini?.description||'';
  $('galCoords').textContent=event.lat?`📍 ${event.lat.toFixed(5)}, ${event.lon.toFixed(5)}`:'';
  const validated=!!event.humanLabel;
  $('galBtnOk').disabled=validated;$('galBtnEdit').disabled=validated;$('galBtnNo').disabled=validated;
}
function selectGalleryFrame(fi){
  const item=GAL.items[GAL.idx];if(!item)return;
  const frames=item.event._frameBlobs||[];if(!frames[fi])return;
  GAL.activeFrameIdx=fi;GAL.scale=1;GAL.offsetX=0;GAL.offsetY=0;
  document.querySelectorAll('.gal-thumb').forEach((el,i)=>el.classList.toggle('active',i===fi));
  loadFrameToCanvas(frames[fi].blob,frames[fi].label);
}
function loadFrameToCanvas(blob,label){
  if(!blob)return;
  const canvas=$('galCanvas'),wrap=$('galImageWrap'),badge=$('galFrameBadge');
  if(badge)badge.textContent='Frame '+label;
  const url=URL.createObjectURL(blob);
  GAL.img=new Image();
  GAL.img.onload=()=>{
    URL.revokeObjectURL(url);
    const wrapRect=wrap.getBoundingClientRect();
    const imgRatio=GAL.img.width/GAL.img.height;
    const wrapRatio=wrapRect.width/wrapRect.height;
    if(imgRatio>wrapRatio){canvas.width=wrapRect.width;canvas.height=wrapRect.width/imgRatio;}
    else{canvas.height=wrapRect.height;canvas.width=wrapRect.height*imgRatio;}
    drawGalleryCanvas();
  };
  GAL.img.src=url;
}
function drawGalleryCanvas(){
  const canvas=$('galCanvas');if(!canvas||!GAL.img)return;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.save();
  ctx.translate(canvas.width/2+GAL.offsetX,canvas.height/2+GAL.offsetY);
  ctx.scale(GAL.scale,GAL.scale);
  ctx.drawImage(GAL.img,-GAL.img.width/2,-GAL.img.height/2,GAL.img.width,GAL.img.height);
  ctx.restore();
}
function renderGalleryDots(activeIdx){
  const container=$('galDots');if(!container)return;
  const max=Math.min(GAL.items.length,9);
  const start=Math.max(0,Math.min(activeIdx-4,GAL.items.length-max));
  container.innerHTML=Array.from({length:max},(_,i)=>{
    const realIdx=start+i;
    return`<div class="gal-nav-dot${realIdx===activeIdx?' active':''}"></div>`;
  }).join('');
}
function initGalleryGestures(){
  const canvas=$('galCanvas');if(!canvas)return;
  const newCanvas=canvas.cloneNode(true);
  canvas.parentNode.replaceChild(newCanvas,canvas);
  const c=$('galCanvas');
  c.addEventListener('touchstart',e=>{
    if(e.touches.length===2){GAL._lastTouchDist=getTouchDist(e.touches);}
    else if(e.touches.length===1){
      GAL._lastTouchX=e.touches[0].clientX;GAL._lastTouchY=e.touches[0].clientY;GAL._isDragging=true;
      const now=Date.now();
      if(now-GAL._lastTap<300){GAL.scale=GAL.scale>1.5?1:3;GAL.offsetX=0;GAL.offsetY=0;drawGalleryCanvas();}
      GAL._lastTap=now;
    }
    e.preventDefault();
  },{passive:false});
  c.addEventListener('touchmove',e=>{
    e.preventDefault();
    if(e.touches.length===2){
      const dist=getTouchDist(e.touches);
      if(GAL._lastTouchDist){
        GAL.scale=Math.max(GAL.minScale,Math.min(GAL.maxScale,GAL.scale*(dist/GAL._lastTouchDist)));
        drawGalleryCanvas();
      }
      GAL._lastTouchDist=dist;
    } else if(e.touches.length===1&&GAL._isDragging&&GAL.scale>1){
      const dx=e.touches[0].clientX-(GAL._lastTouchX||0);
      const dy=e.touches[0].clientY-(GAL._lastTouchY||0);
      const cv=$('galCanvas');
      const maxOff=(cv.width*(GAL.scale-1))/2;
      GAL.offsetX=Math.max(-maxOff,Math.min(maxOff,GAL.offsetX+dx));
      GAL.offsetY=Math.max(-maxOff,Math.min(maxOff,GAL.offsetY+dy));
      GAL._lastTouchX=e.touches[0].clientX;GAL._lastTouchY=e.touches[0].clientY;
      drawGalleryCanvas();
    }
  },{passive:false});
  c.addEventListener('touchend',e=>{
    if(e.touches.length<2)GAL._lastTouchDist=null;
    if(e.touches.length===0)GAL._isDragging=false;
  });
}
function getTouchDist(touches){
  const dx=touches[0].clientX-touches[1].clientX;
  const dy=touches[0].clientY-touches[1].clientY;
  return Math.sqrt(dx*dx+dy*dy);
}
function validateEvent(label){
  const item=GAL.items[GAL.idx];if(!item)return;
  const{event}=item;
  event.humanLabel=label;event.humanTs=Date.now();
  renderGalleryItem(GAL.idx);
  saveToTrainingDataset(event,event._frameBlob,label);
  const stored=S.urbanEvents.find(e=>e.id===event.id);
  if(stored){stored.humanLabel=label;stored.humanTs=Date.now();}
  const nextUnvalidated=GAL.items.findIndex((it,i)=>i>GAL.idx&&!it.event.humanLabel);
  if(nextUnvalidated!==-1){setTimeout(()=>galleryNav(nextUnvalidated-GAL.idx),300);}
  else toast('✅ Sesión validada — '+GAL.items.filter(i=>i.event.humanLabel).length+' eventos');
  updateLearningStats(event,label==='discarded'?'human_discarded':'human_confirmed');
}
function openTypeCorrector(){
  const item=GAL.items[GAL.idx];if(!item)return;
  const types=[
    {key:'pothole',label:'🕳️ Bache'},{key:'manhole',label:'⭕ Tapa registro'},
    {key:'speedbump',label:'⛰️ Badén'},{key:'crack',label:'〰️ Grieta'},
    {key:'degraded',label:'🔴 Pavimento degradado'},{key:'patch',label:'🔧 Parche'}
  ];
  $('typeGrid').innerHTML=types.map(t=>`<button class="type-btn" onclick="correctEventType('${t.key}')">${t.label}</button>`).join('');
  $('typeCorrectorModal').classList.remove('hidden');
}
function correctEventType(type){
  const item=GAL.items[GAL.idx];if(!item)return;
  item.event.type=type;item.event.humanLabel='corrected';item.event.humanTs=Date.now();
  $('typeCorrectorModal').classList.add('hidden');
  renderGalleryItem(GAL.idx);
  saveToTrainingDataset(item.event,item.event._frameBlob,'corrected');
  toast('✏️ Tipo corregido: '+type);
}
async function saveToTrainingDataset(event,frameBlob,humanLabel){
  try{
    const dataset=JSON.parse(localStorage.getItem('rc_training_dataset')||'[]');
    const entry={
      id:event.id,ts:event.ts,type:event.type,severity:event.severity,
      score:event.score,speed:event.speed,lat:event.lat,lon:event.lon,
      features:event.features,geminiResult:event.gemini||null,
      humanLabel,humanTs:Date.now(),hasImage:!!frameBlob
    };
    const existing=dataset.findIndex(e=>e.id===event.id);
    if(existing>=0)dataset[existing]=entry;else dataset.push(entry);
    if(dataset.length>1000)dataset.splice(0,dataset.length-1000);
    localStorage.setItem('rc_training_dataset',JSON.stringify(dataset));
  }catch(e){console.log('[Dataset] Error guardando: '+e.message);}
}

// ─ Red colaborativa (Fase 7) ──────────────────
const WORKER_URL='https://pavement-check-api.israeldiaz1.workers.dev';

async function syncEventsToNetwork(){
  if(localStorage.getItem('rc_sharing_consent')!=='yes')return;
  const events=JSON.parse(localStorage.getItem('rc_urban_events')||'[]')
    .filter(e=>e.confirmed&&e.confirmCount>=1);
  if(!events.length)return;
  try{
    await fetch(`${WORKER_URL}/api/events`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({events})
    });
  }catch(e){/* silencioso */}
}
async function fetchNetworkEvents(lat,lon,radiusM=500){
  if(localStorage.getItem('rc_sharing_consent')!=='yes')return[];
  try{
    const r=await fetch(`${WORKER_URL}/api/events?lat=${lat}&lon=${lon}&r=${radiusM}`);
    return await r.json();
  }catch{return[];}
}
