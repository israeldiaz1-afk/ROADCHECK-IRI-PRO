/* ROADCHECK IRI · app.js v3.2
   Fixes: OSM tiles (no black bg), chart axes display:false (no overlap),
   detail map explicit height (no black), bidirectional map↔chart sync */

const DEF={coefA:2.0,coefB:.50,vRef:80,vExp:.50,vMin:10,segLen:100,noiseFloor:.05,freq:60};
let C={...DEF};

const S={
  active:false,paused:false,pts:[],dist:0,segCount:0,
  lastPos:null,gpsReady:false,watchId:null,
  iriMA:0,iriCA:0,iriN:0,
  iriMax:0,iriMin:Infinity,iriSum:0,iriCnt:0,
  sensorOK:false,calibrated:false,
  calPhase:0,calStart:0,gravSamples:[],vibSamples:[],
  grav:null,gravMag:9.81,noiseLevel:.05,
  hpPrev:0,hpPrevIn:0,buf:[],bufMax:50,
  chartMain:null,chartMeas:null,chartDetail:null,
  chartZ:[],chartI:[],chartMax:80,lastChartUpd:0,lastIRIUpd:0,
  vehicleId:null,selRoutes:new Set(),showAvg:false,
  curDetail:null,curDetailRoute:null,overlapCb:null,pendingRoute:null,
  timerRef:null,timerStart:0,
  mode:'iri',
  urbanBuf:[],urbanBufMax:90,
  urbanEvents:[],
  noiseBaseline:{mean:0,std:0.05,samples:[]},
  _lastEventTs:null,
  mapMain:null,mapMeas:null,mapVisor:null,mapDetail:null,
  lineMain:null,lineMeas:null,mkMain:null,mkMeas:null,mkDetail:null,
};

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
}
function saveCfg(){try{localStorage.setItem('rc_cfg',JSON.stringify(C));}catch(e){}}

// ─ mode switch ────────────────────────────────
function setMode(mode){
  S.mode=mode;
  localStorage.setItem('rc_mode',mode);
  S.urbanBuf=[];S.urbanEvents=[];
  document.querySelectorAll('.mode-btn').forEach(b=>{
    b.classList.toggle('active',b.dataset.mode===mode);
  });
  $('iriPanel')?.classList.toggle('hidden',mode==='urban');
  $('urbanPanel')?.classList.toggle('hidden',mode==='iri');
}
const capitalize=s=>s.charAt(0).toUpperCase()+s.slice(1);
function allVeh(){return[...VEHICLES,...JSON.parse(localStorage.getItem('rc_cveh')||'[]')];}
function allRoutes(){try{return JSON.parse(localStorage.getItem('rc_routes')||'[]');}catch(e){return[];}}
function saveRoute(r){try{const rs=allRoutes();rs.push(r);localStorage.setItem('rc_routes',JSON.stringify(rs));}catch(e){toast('Error guardando');}}
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
  const{latitude:lat,longitude:lon,speed:spd,accuracy:acc}=pos.coords;
  const kmh=spd!=null?spd*3.6:0;
  const at='±'+acc.toFixed(0)+'m';
  set('gpsPill',at);
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
    S.lineMain?.addLatLng([lat,lon]);
    S.lineMeas?.addLatLng([lat,lon]);
    S.dist+=d;
    const dt=S.dist<1000?S.dist.toFixed(0)+' m':(S.dist/1000).toFixed(2)+' km';
    set('distPill',dt);set('measDist',dt);
  }
  const st=kmh>1?kmh.toFixed(1)+' km/h':'0 km/h';
  set('speedPill',st);set('measSpeed',st);
  if(S.active&&!S.paused&&S.calibrated&&S.iriN>0){
    S.pts.push({ts:Date.now(),lat,lon,speed:kmh,iri_m:S.iriMA/S.iriN,iri_c:S.iriCA/S.iriN});
    S.iriMA=0;S.iriCA=0;S.iriN=0;
    const sn=Math.floor(S.dist/C.segLen);if(sn>S.segCount){S.segCount=sn;set('aSegs',S.segCount.toString());}
  }
  S.lastPos={lat,lon,speed:kmh};
}
function setChip(ci,di,li,cls,col,lbl){const e=$(ci);if(!e)return;e.className='chip '+cls;const d=$(di);if(d)d.style.background=col;set(li,lbl);}
function mapCenter(map,lat,lon,z){if(!map)return;map.setView([lat,lon],z);setTimeout(()=>{try{map.invalidateSize();}catch(e){}},120);}
function mapMk(map,key,lat,lon){
  if(!map)return;
  if(!S[key])S[key]=L.circleMarker([lat,lon],{radius:7,color:'#fff',weight:2,fillColor:'#0EA5E9',fillOpacity:1}).addTo(map);
  else S[key].setLatLng([lat,lon]);
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
      setChip('cSEN','dSEN','lSEN','warn','#F59E0B','SEN NCAL');
    }catch(e){motionFB();}
  }else{motionFB();}
}
function motionFB(){
  window.addEventListener('devicemotion',e=>{const a=e.accelerationIncludingGravity;if(a)onRaw(a.x||0,a.y||0,a.z||0);},{passive:true});
  S.sensorOK=true;setChip('cSEN','dSEN','lSEN','warn','#F59E0B','SEN NCAL');
}
function onRaw(x,y,z){
  if(!S.sensorOK)return;
  if(S.calPhase>0){doCalSample(x,y,z);return;}
  if(!S.calibrated)return;
  const g=S.grav;
  const raw=Math.abs(x*g.x+y*g.y+z*g.z-S.gravMag);
  if(S.mode==='urban'){feedUrbanBuffer(x,y,z,Date.now());}
  onVert(raw);
}

// ─ urban buffer ───────────────────────────────
function feedUrbanBuffer(x,y,z,t){
  const g=S.grav;
  const vert=x*g.x+y*g.y+z*g.z-S.gravMag; // con signo, para forma de onda
  S.urbanBuf.push({t,ax:x,ay:y,az:z,vert});
  if(S.urbanBuf.length>S.urbanBufMax)S.urbanBuf.shift();
  updateNoiseBaseline(vert);
  detectEvent();
}

function updateNoiseBaseline(vert){
  S.noiseBaseline.samples.push(Math.abs(vert));
  if(S.noiseBaseline.samples.length>300)S.noiseBaseline.samples.shift();
  S.noiseBaseline.mean=S.noiseBaseline.samples.reduce((a,b)=>a+b,0)/S.noiseBaseline.samples.length;
  const variance=S.noiseBaseline.samples.reduce((a,b)=>a+(b-S.noiseBaseline.mean)**2,0)/S.noiseBaseline.samples.length;
  S.noiseBaseline.std=Math.sqrt(variance);
}

function detectEvent(){
  if(S.urbanBuf.length<20)return;
  const latest=S.urbanBuf[S.urbanBuf.length-1];
  const dynamicThreshold=S.noiseBaseline.mean+4*S.noiseBaseline.std; // 4-sigma
  if(Math.abs(latest.vert)<Math.max(dynamicThreshold,1.2))return; // 1.2 m/s² suelo absoluto
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

  // Energía espectral aproximada: cruces por cero (proxy ligero sin FFT)
  let crossings=0;
  for(let i=1;i<verts.length;i++){if(Math.sign(verts[i])!==Math.sign(verts[i-1]))crossings++;}
  const windowDurationS=(window[window.length-1].t-window[0].t)/1000;
  const crossingFreq=windowDurationS>0?crossings/windowDurationS/2:0;
  const freqEnergy=Math.min(1,Math.max(0,(crossingFreq-4)/16)); // normalizado 0-1, pico 8-20Hz

  // Correlación con frenado: eje Y longitudinal sostenido = frenazo, no bache
  const ays=window.map(s=>Math.abs(s.ay));
  const ayAvg=ays.reduce((a,b)=>a+b,0)/ays.length;
  const brakeCorrelation=Math.min(1,ayAvg/3); // 3 m/s² ~ frenada fuerte

  const features={peakAmp,jerkMax,duration,bipolarity,freqEnergy,brakeCorrelation};
  scoreAndClassify(features,triggerTs);
}
function showIOSPerm(){$('sensorPermModal')?.classList.remove('hidden');}
function grantIOS(){$('sensorPermModal')?.classList.add('hidden');DeviceMotionEvent.requestPermission().then(s=>{if(s==='granted'){S.sensorOK=true;$('btnIOS')?.classList.add('hidden');tryAccel();startCal();toast('Permiso concedido');}else toast('Permiso denegado');});}

// ─ calibración 6s ─────────────────────────────
function startCal(){
  if(!S.sensorOK){toast('Sensor no disponible');return;}
  S.calibrated=false;S.calPhase=1;S.calStart=Date.now();
  S.gravSamples=[];S.vibSamples=[];S.hpPrev=0;S.hpPrevIn=0;S.buf=[];
  $('calPanel')?.classList.remove('hidden');
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
  if(!ok){set('calLbl','Calibrar');$('calIco').textContent='🎯';set('calVal','Requerido');toast('⚠️ Calibración fallida: '+err);return;}
  if(S.vibSamples.length>0){S.noiseLevel=Math.max(DEF.noiseFloor,rmsA(S.vibSamples)*1.5);C.noiseFloor=S.noiseLevel;saveCfg();}
  S.calibrated=true;S.hpPrev=0;S.hpPrevIn=0;S.buf=[];
  setChip('cSEN','dSEN','lSEN','ok','#10B981','SEN CAL');
  set('calLbl','Calibrado');$('calIco').textContent='✅';
  $('calVal').textContent='✓';$('calVal').style.color='var(--good)';
  $('btnCal')?.classList.add('cal-ok');
  $('calReqNote')?.classList.add('off');
  set('iriM','0.00');set('iriC','0.00');
  const cd=$('iriCond');if(cd){cd.textContent='Sin movimiento';cd.style.color='var(--dim)';}
  toast('✅ Calibración OK · Ruido: '+S.noiseLevel.toFixed(3)+' m/s²');
}
function doCalibrate(){startCal();}

// ─ IRI real-time ──────────────────────────────
function onVert(raw){
  const iriM=computeIRI(raw),kmh=S.lastPos?.speed||0,iriC=spdCorr(iriM,kmh);
  const now=Date.now();
  if(now-S.lastIRIUpd>65){S.lastIRIUpd=now;updateIRI(iriM,iriC);if(S.active&&!S.paused)updateStats();}
  if(S.active&&!S.paused){S.iriMA+=iriM;S.iriCA+=iriC;S.iriN++;S.iriMax=Math.max(S.iriMax,iriC);S.iriMin=Math.min(S.iriMin,iriC);S.iriSum+=iriC;S.iriCnt++;}
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
  const lbl=S.chartZ.map((_,i)=>i),mxZ=Math.max(...S.chartZ,.05),mxI=Math.max(...S.chartI,.5);
  [S.chartMain,S.chartMeas].forEach(c=>{
    if(!c)return;
    c.data.labels=lbl;c.data.datasets[0].data=S.chartZ;c.data.datasets[1].data=S.chartI;
    c.options.scales.y.max=Math.max(.1,mxZ*1.4);
    c.options.scales.y1.max=Math.max(1,mxI*1.4);
    c.update('none');
  });
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
  if(S.mapMain)S.lineMain=L.polyline([],{color:'#0EA5E9',weight:3,opacity:.8}).addTo(S.mapMain);
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
    S.lineMeas=L.polyline([],{color:'#0EA5E9',weight:4}).addTo(S.mapMeas);
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
function startMeasurement(){
  if(!S.calibrated){
    toast('⚠️ Calibra el sensor antes de medir (pulsa 🎯)');
    const b=$('btnCal');if(b){b.style.borderColor='var(--bad)';setTimeout(()=>b.style.borderColor='',2000);}
    return;
  }
  if(!S.vehicleId){toast('⚠️ Selecciona un vehículo');openGarage();return;}
  S.active=true;S.paused=false;S.pts=[];S.dist=0;S.segCount=0;
  S.iriMA=0;S.iriCA=0;S.iriN=0;S.iriMax=0;S.iriMin=Infinity;S.iriSum=0;S.iriCnt=0;
  S.buf=[];S.chartZ=[];S.chartI=[];S.hpPrev=0;S.hpPrevIn=0;
  S.lineMain?.setLatLngs([]);S.lineMeas?.setLatLngs([]);
  $('meas-sc').classList.remove('hidden');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    initMeasMap();
    if(S.lastPos&&S.mapMeas)mapCenter(S.mapMeas,S.lastPos.lat,S.lastPos.lon,17);
  }));
  if(!S.chartMeas)S.chartMeas=makeChart('measChart','#5A7E9C');
  ['aMax','aMed','aMin'].forEach(id=>set(id,'—'));set('aSegs','0');
  $('btnPause').classList.remove('hidden');$('btnResume').classList.add('hidden');
  startTimer();
}
function pauseMeasurement(){S.paused=true;$('btnPause').classList.add('hidden');$('btnResume').classList.remove('hidden');toast('⏸ Pausado');}
function resumeMeasurement(){S.paused=false;$('btnPause').classList.remove('hidden');$('btnResume').classList.add('hidden');toast('▶ Reanudado');}
function stopMeasurement(){
  S.active=false;S.paused=false;stopTimer();$('meas-sc').classList.add('hidden');
  if(S.pts.length<2){toast('Sin datos suficientes');return;}
  const segs=segmentize(S.pts,C.segLen),allC=S.pts.map(p=>p.iri_c),allM=S.pts.map(p=>p.iri_m);
  S.pendingRoute={id:Date.now().toString(),date:new Date().toISOString(),pts:S.pts,segs,
    avgC:allC.reduce((a,b)=>a+b,0)/allC.length,avgM:allM.reduce((a,b)=>a+b,0)/allM.length,
    dist:S.dist,segLen:C.segLen,vehicleId:S.vehicleId};
  $('routeNameInput').value='';$('routeNameModal').classList.remove('hidden');
}
function confirmSave(){
  if(!S.pendingRoute)return;
  S.pendingRoute.name=$('routeNameInput').value.trim()||fmtD(Date.parse(S.pendingRoute.date));
  saveRoute(S.pendingRoute);$('routeNameModal').classList.add('hidden');
  toast('✅ Ruta guardada · IRI '+S.pendingRoute.avgC.toFixed(2)+' m/km');S.pendingRoute=null;
}
function discardRoute(){S.pendingRoute=null;$('routeNameModal').classList.add('hidden');toast('Ruta descartada');}
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

// ─ History ────────────────────────────────────
function loadHistory(){
  const routes=allRoutes(),search=($('histSearch')?.value||'').toLowerCase(),cont=$('histList');if(!cont)return;
  const f=routes.filter(r=>(r.name||'').toLowerCase().includes(search)||(fmtD(Date.parse(r.date))).includes(search));
  if(!f.length){cont.innerHTML='<div class="empty-st"><div class="empty-ico">🛣️</div><p class="empty-txt">'+(routes.length?'Sin resultados.':'Sin rutas guardadas.')+'</p></div>';return;}
  cont.innerHTML=f.slice().reverse().map(r=>{
    const iri=(r.avgC||0).toFixed(2),bc=iCls(r.avgC||0),lb=iLbl(r.avgC||0);
    const dt=r.dist<1000?r.dist.toFixed(0)+' m':(r.dist/1000).toFixed(2)+' km';
    return`<div class="route-card" onclick="openDetail('${r.id}')">
      <div class="rc-ind" style="background:${iCol(r.avgC||0)}"></div>
      <div class="rc-body"><div class="rc-name">${escH(r.name||fmtD(Date.parse(r.date)))}</div>
      <div class="rc-meta"><span>📏 ${dt}</span><span>🗓 ${fmtD(Date.parse(r.date))}</span></div>
      <span class="iri-badge ${bc}">IRI ${iri} — ${lb}</span></div>
      <div class="rc-acts">
        <button class="rca" onclick="event.stopPropagation();expXLSX('${r.id}')"><span class="rca-ico">📊</span>Excel</button>
        <button class="rca" onclick="event.stopPropagation();expHTML('${r.id}')"><span class="rca-ico">📈</span>Informe</button>
        <button class="rca" onclick="event.stopPropagation();expKML('${r.id}')"><span class="rca-ico">🌍</span>KML</button>
        <button class="rca" onclick="event.stopPropagation();expJSON('${r.id}')"><span class="rca-ico">{ }</span>JSON</button>
        <button class="rca del" onclick="event.stopPropagation();deleteRoute('${r.id}')"><span class="rca-ico">🗑</span>Borrar</button>
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
      L.polyline(coords,{color:seg.color||iCol(seg.iriC),weight:5,opacity:.9})
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
  const mode=$('viewMode')?.value||'iri_c',routes=allRoutes().filter(r=>S.selRoutes.has(r.id));
  if(!routes.length)return;
  routes.forEach(r=>(r.segs||[]).forEach(seg=>{
    const iri=mode==='iri_m'?seg.iriM:seg.iriC,coords=(seg.pts||[]).map(p=>[p.lat,p.lon]);
    if(coords.length<2)return;
    L.polyline(coords,{color:iCol(iri),weight:5,opacity:.88}).addTo(S.mapVisor).on('click',()=>{
      const c=$('segCard');c.classList.remove('hidden');
      c.innerHTML='<h5>Tramo seleccionado</h5><p>IRI Corregido: <strong>'+(seg.iriC||0).toFixed(3)+' m/km</strong></p><p>IRI Medido: <strong>'+(seg.iriM||0).toFixed(3)+' m/km</strong></p><p>Vel. media: <strong>'+(seg.speedAvg||0).toFixed(1)+' km/h</strong></p><p>Distancia: <strong>'+(seg.dist||0).toFixed(0)+' m</strong></p><p>Condición: <strong style="color:'+iCol(seg.iriC||0)+'">'+iLbl(seg.iriC||0)+'</strong></p>';
    });
  }));
  const allP=routes.flatMap(r=>(r.pts||[]).map(p=>[p.lat,p.lon]));
  if(allP.length)S.mapVisor.fitBounds(L.latLngBounds(allP),{padding:[14,14]});
  setTimeout(()=>{try{S.mapVisor.invalidateSize();}catch(e){}},100);
}

// ─ Exports ────────────────────────────────────
function dlBlob(c,t,n){const b=new Blob([c],{type:t}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=n;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);}
function expJSON(id){const r=allRoutes().find(r=>r.id===id);if(!r)return;dlBlob(JSON.stringify(r,null,2),'application/json','roadcheck_'+r.id.slice(-6)+'.json');toast('JSON exportado');}
function expKML(id){
  const r=allRoutes().find(r=>r.id===id);if(!r?.segs?.length)return;
  let k='<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n<name>'+escH(r.name||'Roadcheck IRI')+'</name>\n<Style id="g"><LineStyle><color>ff81b910</color><width>4</width></LineStyle></Style>\n<Style id="f"><LineStyle><color>ff0b9ef5</color><width>4</width></LineStyle></Style>\n<Style id="p"><LineStyle><color>ff4444ef</color><width>4</width></LineStyle></Style>\n';
  r.segs.forEach((s,i)=>{const st=s.iriC<=2.5?'g':s.iriC<=5?'f':'p';k+='<Placemark><name>Tramo '+(i+1)+'</name><description>IRI: '+(s.iriC||0).toFixed(3)+' | '+(s.dist||0).toFixed(0)+'m | '+iLbl(s.iriC)+'</description><styleUrl>#'+st+'</styleUrl><LineString><tessellate>1</tessellate><coordinates>'+(s.pts||[]).map(p=>(p.lon||0).toFixed(7)+','+p.lat.toFixed(7)+',0').join('\n')+'</coordinates></LineString></Placemark>\n';});
  k+='</Document></kml>';dlBlob(k,'application/vnd.google-earth.kml+xml','roadcheck_'+r.id.slice(-6)+'.kml');toast('KML exportado');
}
function expXLSX(id){const r=allRoutes().find(r=>r.id===id);if(!r?.pts)return;loadXLSX(()=>doXLSX(r));}
function loadXLSX(cb){if(typeof XLSX!=='undefined'){cb();return;}const s=document.createElement('script');s.src='https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js';s.onload=cb;s.onerror=()=>toast('Error cargando SheetJS');document.head.appendChild(s);}
function doXLSX(r){
  const wb=XLSX.utils.book_new();let da=0;
  const rws=[['#','Fecha','Lat','Lon','Dist.(m)','Vel.(km/h)','IRI_Medido','IRI_Corregido','Condición']];
  r.pts.forEach((p,i)=>{if(i>0)da+=geo(r.pts[i-1].lat,r.pts[i-1].lon,p.lat,p.lon);rws.push([i+1,fmtD(p.ts),p.lat.toFixed(7),p.lon.toFixed(7),da.toFixed(1),(p.speed||0).toFixed(1),(p.iri_m||0).toFixed(4),(p.iri_c||0).toFixed(4),iLbl(p.iri_c)]);});
  const ws1=XLSX.utils.aoa_to_sheet(rws);ws1['!cols']=[{wch:5},{wch:18},{wch:13},{wch:13},{wch:11},{wch:11},{wch:13},{wch:14},{wch:10}];XLSX.utils.book_append_sheet(wb,ws1,'Datos');
  const sr=[['Tramo','IRI Medido','IRI Corregido','Vel.(km/h)','Dist.(m)','Condición']];
  (r.segs||[]).forEach((s,i)=>sr.push([i+1,(s.iriM||0).toFixed(3),(s.iriC||0).toFixed(3),(s.speedAvg||0).toFixed(1),(s.dist||0).toFixed(1),iLbl(s.iriC)]));
  const ws2=XLSX.utils.aoa_to_sheet(sr);XLSX.utils.book_append_sheet(wb,ws2,'Segmentos');
  const ws3=XLSX.utils.aoa_to_sheet([['ROADCHECK IRI — RESUMEN'],[''],['Nombre',r.name||''],['Fecha',fmtD(Date.parse(r.date))],['Distancia (m)',r.dist.toFixed(1)],['IRI Medido medio',(r.avgM||0).toFixed(4)],['IRI Corregido medio',(r.avgC||0).toFixed(4)],['Condición',iLbl(r.avgC)],['Segmentos',(r.segs||[]).length],['Puntos GPS',r.pts.length]]);
  ws3['!cols']=[{wch:26},{wch:22}];XLSX.utils.book_append_sheet(wb,ws3,'Resumen');
  XLSX.writeFile(wb,'roadcheck_'+r.id.slice(-6)+'.xlsx');toast('Excel exportado ✓');
}
function expHTML(id){
  const r=allRoutes().find(r=>r.id===id);if(!r?.pts)return;
  let da=0;const dists=[0],iM=[],iC=[],sp=[];
  r.pts.forEach((p,i)=>{if(i>0){da+=geo(r.pts[i-1].lat,r.pts[i-1].lon,p.lat,p.lon);dists.push(da);}iM.push(+(p.iri_m||0).toFixed(4));iC.push(+(p.iri_c||0).toFixed(4));sp.push(+(p.speed||0).toFixed(1));});
  const sH=(r.segs||[]).map((s,i)=>`<tr><td>${i+1}</td><td>${(s.iriM||0).toFixed(3)}</td><td style="font-weight:700;color:${iCol(s.iriC)}">${(s.iriC||0).toFixed(3)}</td><td>${(s.speedAvg||0).toFixed(1)}</td><td>${(s.dist||0).toFixed(0)}</td><td style="color:${iCol(s.iriC)}">${iLbl(s.iriC)}</td></tr>`).join('');
  const ptsJ=JSON.stringify(r.pts.map(p=>({lat:p.lat,lon:p.lon,iri_m:+(p.iri_m||0).toFixed(4),iri_c:+(p.iri_c||0).toFixed(4),speed:+(p.speed||0).toFixed(1)})));
  const segsJ=JSON.stringify((r.segs||[]).map(s=>({pts:(s.pts||[]).map(p=>({lat:p.lat,lon:p.lon})),iriC:+(s.iriC||0).toFixed(3),iriM:+(s.iriM||0).toFixed(3),dist:+(s.dist||0).toFixed(1)})));
  const html=`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=yes"><title>Roadcheck IRI</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js"><\/script>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',Arial,sans-serif;background:#05111F;color:#B8D0E4}.tb{display:flex;align-items:center;gap:10px;padding:9px 14px;background:#091829;border-bottom:1px solid rgba(14,165,233,.2);position:sticky;top:0;z-index:1000}.back{padding:6px 13px;background:rgba(14,165,233,.12);border:1px solid rgba(14,165,233,.25);border-radius:4px;color:#0EA5E9;font-size:.73rem;font-weight:700;cursor:pointer;letter-spacing:.5px;text-transform:uppercase}.rt{font-size:.82rem;font-weight:700;color:#0EA5E9;letter-spacing:1px;font-family:'Courier New',monospace;text-transform:uppercase}.c{padding:12px 12px 28px}h2{font-size:.67rem;text-transform:uppercase;letter-spacing:2px;color:#3A5F7A;margin-bottom:9px;font-family:'Courier New',monospace;padding-top:12px}.cards{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:3px}.card{background:#091829;border:1px solid rgba(14,165,233,.15);border-radius:6px;padding:9px 14px;flex:1;min-width:110px;text-align:center}.card .v{font-size:1.35rem;font-weight:700;font-family:'Courier New',monospace;color:#F59E0B}.card .l{font-size:.57rem;color:#3A5F7A;text-transform:uppercase;letter-spacing:1px;margin-top:2px}#map{height:300px;border-radius:6px;overflow:hidden;border:1px solid rgba(14,165,233,.2);margin-bottom:5px}.bx{background:#091829;border:1px solid rgba(14,165,233,.1);border-radius:6px;padding:10px;margin-bottom:7px;position:relative}.bx canvas{touch-action:none}.zh{font-size:.56rem;color:#3A5F7A;text-align:right;margin-top:3px;font-family:'Courier New',monospace}.rb{position:absolute;top:8px;right:8px;padding:3px 7px;background:rgba(14,165,233,.1);border:1px solid rgba(14,165,233,.2);border-radius:3px;color:#0EA5E9;font-size:.53rem;cursor:pointer}#pi{background:#0D2040;border:1px solid rgba(14,165,233,.2);border-radius:6px;padding:9px 11px;font-size:.64rem;color:#5A7E9C;line-height:1.9;min-height:36px;font-family:'Courier New',monospace;margin-bottom:7px}#pi span{color:#B8D0E4;font-weight:700}table{width:100%;border-collapse:collapse;font-size:.7rem}th{background:#091829;padding:7px 8px;text-align:left;font-size:.58rem;text-transform:uppercase;color:#3A5F7A;letter-spacing:1px;font-family:'Courier New',monospace}td{padding:7px 8px;border-bottom:1px solid rgba(14,165,233,.07)}.dv{height:1px;background:rgba(14,165,233,.1);margin:12px 0}</style>
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
</div>
<script>
const PTS=${ptsJ},SEGS=${segsJ},DS=${JSON.stringify(dists.map(d=>+d.toFixed(0)))},IC=${JSON.stringify(iC)},IM=${JSON.stringify(iM)},SP=${JSON.stringify(sp)};
const ic=v=>v<=2.5?'#10B981':v<=5?'#F59E0B':'#EF4444';
const map=L.map('map',{zoomControl:true,attributionControl:true});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,subdomains:['a','b','c'],attribution:'© OpenStreetMap'}).addTo(map);
SEGS.forEach(s=>{if(s.pts.length<2)return;L.polyline(s.pts.map(p=>[p.lat,p.lon]),{color:ic(s.iriC),weight:5,opacity:.9}).addTo(map);});
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
  dlBlob(html,'text/html','informe_roadcheck_'+r.id.slice(-6)+'.html');toast('Informe HTML exportado ✓');
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
  startGPS();
  startSensor();
  S.chartMain=makeChart('mainChart');
  $('segSlider')?.addEventListener('input',function(){set('segValLbl',this.value+' m');});
  $('vRefSlider')?.addEventListener('input',function(){set('vRefLbl',this.value);});
  $('vExpSlider')?.addEventListener('input',function(){set('vExpLbl',parseFloat(this.value).toFixed(2));});
  $('vMinSlider')?.addEventListener('input',function(){set('vMinLbl',this.value);});
  set('segVal',C.segLen+' m');set('vrefVal',C.vRef+' km/h');
  const savedMode=localStorage.getItem('rc_mode')||'iri';
  if(savedMode!=='iri')setMode(savedMode);
  // Doble rAF garantiza que el CSS clamp() ya está calculado
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    initStaticMaps();
  }));
  console.log('[Roadcheck IRI v3.2] OK');
});
