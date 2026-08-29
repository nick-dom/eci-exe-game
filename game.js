
(function(){
"use strict";

/* ---------------------------------------------------------
   RNG com múltiplas sementes independentes
--------------------------------------------------------- */
function mulberry32(seed){
  let s = seed >>> 0;
  return function(){
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeMasterSeed(){
  return ((Date.now() ^ Math.floor(Math.random()*0xFFFFFFFF)) >>> 0);
}
function deriveSeed(master, salt){
  let x = (master ^ salt) >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 7;
  x ^= x << 17; x >>>= 0;
  return x >>> 0;
}

let MASTER_SEED, rngSpawn, rngEvents, rngQuestions, rngCrash, rngLoot;
function seedAllStreams(){
  MASTER_SEED   = makeMasterSeed();
  rngSpawn      = mulberry32(deriveSeed(MASTER_SEED, 0x9E3779B1));
  rngEvents     = mulberry32(deriveSeed(MASTER_SEED, 0x85EBCA77));
  rngQuestions  = mulberry32(deriveSeed(MASTER_SEED, 0xC2B2AE3D));
  rngCrash      = mulberry32(deriveSeed(MASTER_SEED, 0x27D4EB2F));
  rngLoot       = mulberry32(deriveSeed(MASTER_SEED, 0x165667B1));
}
seedAllStreams();
function rand(rng,a,b){ return a + rng()*(b-a); }
function pick(rng, arr){ return arr[Math.floor(rng()*arr.length)]; }

/* ---------------------------------------------------------
   ÁUDIO — SFX sintetizados via Web Audio (sem arquivos) +
   trilha lo-fi/chiptune de fundo que distorce no boss.
   Tudo síncrono e sem bloquear o jogo se o navegador recusar.
--------------------------------------------------------- */
const AUDIO = (function(){
  let actx = null, master = null, distortion = null, musicGain = null;
  let musicTimer = null, musicStep = 0, musicOn = false;
  const NOTES_CALM = [220,261.6,293.7,329.6,392.0,440.0];
  const NOTES_TENSE = [220,233.1,261.6,277.2,329.6,349.2];

  function ensure(){
    if(actx) return actx;
    try{
      actx = new (window.AudioContext||window.webkitAudioContext)();
      master = actx.createGain(); master.gain.value = 0.35; master.connect(actx.destination);
      musicGain = actx.createGain(); musicGain.gain.value = 0.10; musicGain.connect(master);
      distortion = actx.createWaveShaper(); distortion.connect(musicGain);
      setDistortion(0);
    } catch(e){ actx = null; }
    return actx;
  }
  function resume(){ const c = ensure(); if(c && c.state==='suspended') c.resume().catch(()=>{}); }

  function setDistortion(amount){ // 0..1
    if(!distortion) return;
    const k = amount*80, n = 256, curve = new Float32Array(n);
    for(let i=0;i<n;i++){
      const x = i*2/n - 1;
      curve[i] = k ? ((3+k)*x*20*Math.PI/180)/(Math.PI+k*Math.abs(x)) : x;
    }
    distortion.curve = curve;
  }

  function blip(freq, dur, type, gainTo, dest){
    const c = ensure(); if(!c) return;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = type||'square'; osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(gainTo||0.28, c.currentTime+0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime+dur);
    osc.connect(g); g.connect(dest||master);
    osc.start(); osc.stop(c.currentTime+dur+0.02);
  }

  return {
    resume,
    sfxBip(){ blip(880,0.09,'square',0.22); blip(1320,0.07,'square',0.12); },
    sfxDash(){ const c=ensure(); if(!c) return;
      const osc=c.createOscillator(), g=c.createGain();
      osc.type='sawtooth'; osc.frequency.setValueAtTime(180,c.currentTime);
      osc.frequency.exponentialRampToValueAtTime(900,c.currentTime+0.16);
      g.gain.setValueAtTime(0.22,c.currentTime); g.gain.exponentialRampToValueAtTime(0.0001,c.currentTime+0.18);
      osc.connect(g); g.connect(master); osc.start(); osc.stop(c.currentTime+0.2);
    },
    sfxGlitch(){ const c=ensure(); if(!c) return;
      for(let i=0;i<3;i++) setTimeout(()=>blip(rand(Math.random,120,2200),0.05,'square',0.18), i*35);
    },
    sfxAlert(){ blip(140,0.35,'sawtooth',0.25); blip(110,0.35,'sawtooth',0.18); },
    sfxHit(){ blip(90,0.2,'square',0.3); },
    sfxAttack(){ blip(660,0.08,'triangle',0.22); },
    sfxCaptcha(){ blip(500,0.06,'square',0.15); setTimeout(()=>blip(240,0.18,'sawtooth',0.2),90); },
    setMusicTension(t){ setDistortion(clamp01(t)); }, // 0 calmo, 1 distorcido (boss)
    startMusic(){
      const c = ensure(); if(!c || musicOn) return;
      musicOn = true; musicStep = 0;
      const step = ()=>{
        if(!musicOn) return;
        const bank = STATE_IS_BOSS() ? NOTES_TENSE : NOTES_CALM;
        const freq = bank[musicStep % bank.length] * (STATE_IS_BOSS()? (musicStep%4===0?0.5:1) : 1);
        blip(freq, 0.16, 'triangle', 0.10, distortion||master);
        musicStep++;
        musicTimer = setTimeout(step, STATE_IS_BOSS()? 190 : 260);
      };
      step();
    },
    stopMusic(){ musicOn=false; if(musicTimer) clearTimeout(musicTimer); },
  };
  function clamp01(v){ return Math.max(0,Math.min(1,v)); }
})();
let STATE_IS_BOSS = ()=> false; // sobrescrito abaixo, depois que STATE/PHASES existir

/* ---------------------------------------------------------
   DOM refs
--------------------------------------------------------- */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

const hud = document.getElementById('hud');
const phaseNameEl = document.getElementById('phaseName');
const barInt = document.getElementById('barInt');
const barCaos = document.getElementById('barCaos');
const barUlt = document.getElementById('barUlt');
const hScore = document.getElementById('hScore');
const hTime = document.getElementById('hTime');
const hCore = document.getElementById('hCore');
const hitsRow = document.getElementById('hitsRow');
const seedTagMenu = document.getElementById('seedTagMenu');
const seedTagHud = document.getElementById('seedTagHud');

const menuEl = document.getElementById('menu');
const dialogEl = document.getElementById('dialog');
const dialogTitle = document.getElementById('dialogTitle');
const dialogText = document.getElementById('dialogText');
const dialogOptions = document.getElementById('dialogOptions');
const crashEl = document.getElementById('crash');
const crashText = document.getElementById('crashText');
const endEl = document.getElementById('endScreen');
const endTitle = document.getElementById('endTitle');
const endText = document.getElementById('endText');
const endScore = document.getElementById('endScore');
const flashEl = document.getElementById('flash');

const btnStart = document.getElementById('btnStart');
const btnRetry = document.getElementById('btnRetry');
const aiStatusEl = document.getElementById('aiStatus');
const memLineEl = document.getElementById('memLine');
const menuTitleEl = document.getElementById('menuTitle');
const cbColorblind = document.getElementById('cbColorblind');
const renameInput = document.getElementById('renameInput');
const btnRename = document.getElementById('btnRename');

const btnChat = document.getElementById('btnChat');
const chatModal = document.getElementById('chatModal');
const chatTitleEl = document.getElementById('chatTitle');
const chatLogEl = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const btnChatSend = document.getElementById('btnChatSend');
const btnChatClose = document.getElementById('btnChatClose');

const secretBossListEl = document.getElementById('secretBossList');
const secretBossCountEl = document.getElementById('secretBossCount');
const aiConfigStatusEl = document.getElementById('aiConfigStatus');
const aiKeyInput = document.getElementById('aiKeyInput');
const aiEndpointInput = document.getElementById('aiEndpointInput');
const aiModelInput = document.getElementById('aiModelInput');
const btnAiSave = document.getElementById('btnAiSave');

function updateSecretBossPanel(){
  if(!secretBossListEl) return;
  const unlocked = ECI.unlockedList();
  secretBossCountEl.textContent = '('+unlocked.length+'/6)';
  secretBossListEl.innerHTML = '';
  ECI.VIRUS_ORDER.forEach(id=>{
    const v = ECI.VIRUS[id];
    const isUnlocked = ECI.isUnlocked(id);
    const row = document.createElement('div');
    row.className = 'secretBossItem' + (isUnlocked?'':' locked');
    const label = document.createElement('span');
    label.className = 'vname';
    label.textContent = isUnlocked ? (v.name+' — '+v.year) : '??? — digite a codeword em CONVERSAR';
    row.appendChild(label);
    if(isUnlocked){
      const btn = document.createElement('button');
      btn.className = 'secondary small';
      btn.textContent = 'LUTAR';
      btn.addEventListener('click', ()=> beginRun(menuEl, v.key));
      row.appendChild(btn);
    }
    secretBossListEl.appendChild(row);
  });
}
function updateAiConfigUI(){
  const cfg = ECI.getApiConfig();
  aiConfigStatusEl.textContent = '('+(cfg.apiMode||'local').toUpperCase()+')';
  const radio = document.querySelector('input[name="aiMode"][value="'+(cfg.apiMode||'local')+'"]');
  if(radio) radio.checked = true;
  aiKeyInput.value = cfg.apiKey||'';
  aiEndpointInput.value = cfg.customEndpoint||'';
  aiModelInput.value = cfg.customModel||'gpt-oss:20b';
}
if(btnAiSave) btnAiSave.addEventListener('click', ()=>{
  const mode = (document.querySelector('input[name="aiMode"]:checked')||{}).value || 'local';
  ECI.setApiConfig({ apiMode:mode, apiKey:aiKeyInput.value.trim(), customEndpoint:aiEndpointInput.value.trim(), customModel:aiModelInput.value.trim() });
  updateAiConfigUI();
  spawnGlitchText(['CONFIG DE IA SALVA']);
});

const captchaModal = document.getElementById('captchaModal');
const captchaCheckbox = document.getElementById('captchaCheckbox');
const captchaGlitchMsg = document.getElementById('captchaGlitchMsg');

const powEls = {
  dash: document.getElementById('pow-dash'),
  seg: document.getElementById('pow-seg'),
  rec: document.getElementById('pow-rec'),
  loop: document.getElementById('pow-loop'),
  panic: document.getElementById('pow-panic'),
  exploit: document.getElementById('pow-exploit'),
};

/* ---------------------------------------------------------
   Assets (sprites direcionais reais do mascote)
--------------------------------------------------------- */
const DIR_NAMES = ['east','south-east','south','south-west','west','north-west','north','north-east'];
const sprites = {};
let assetsLoaded = 0, assetsTotal = DIR_NAMES.length;
DIR_NAMES.forEach(name=>{
  const img = new Image();
  img.src = 'assets/' + name + '.png';
  img.onload = ()=> assetsLoaded++;
  sprites[name] = img;
});

function dirFromVector(vx,vy,fallback){
  if(vx===0 && vy===0) return fallback;
  let angle = Math.atan2(vy,vx) * 180/Math.PI;
  angle = (angle + 360) % 360;
  const idx = Math.round(angle/45) % 8;
  return DIR_NAMES[idx];
}
const DIR_VECTORS = { east:[1,0], 'south-east':[0.7071,0.7071], south:[0,1], 'south-west':[-0.7071,0.7071],
  west:[-1,0], 'north-west':[-0.7071,-0.7071], north:[0,-1], 'north-east':[0.7071,-0.7071] };
function dirToVector(dir){ const v = DIR_VECTORS[dir]||[0,1]; return {x:v[0], y:v[1]}; }

/* ---------------------------------------------------------
   Configuração das fases
--------------------------------------------------------- */
const PHASES = [
  { key:'bug',    name:'FASE 1 — BUG',            color:'#3b82f6', enemySpeed:1.35, spawnRate:1.5, scoreToNext:70,  hazards:false, minions:0 },
  { key:'bugexe', name:'FASE 2 — BUG.EXE',        color:'#60a5fa', enemySpeed:1.7,  spawnRate:1.25,scoreToNext:180, hazards:true,  minions:0 },
  { key:'eciexe', name:'FASE 3 — ECI.EXE',        color:'#7dd3fc', enemySpeed:1.95, spawnRate:1.05,scoreToNext:340, hazards:true,  minions:3 },
  { key:'overflow', name:'FASE 4 — OVERFLOW // BOSS', color:'#f5f7ff', bossSurvive:55 },
];
const PHASE_SCALE = [1, 1.12, 1.28, 1.5];

/* ---------------------------------------------------------
   Estado global
--------------------------------------------------------- */
let STATE = 'MENU'; // MENU, PLAYING, DIALOG, CRASH, GAMEOVER, VICTORY, CAPTCHA
let keys = {};
let player, bugs, hazards, minions, chaser, particles, glitchTexts, bossState;
let attacks = []; // projéteis do EXPLOIT do jogador
let score = 0, phaseIdx = 0, elapsed = 0;
let lastT = 0, shakeTimer = 0, shakeMag = 0;
let questionTimer = 0, nextQuestionAt = 0;
let crashTimer = 0, nextCrashCheckAt = 0;
let captchaTimer = 0, nextCaptchaAt = 0;
let globalSlowUntil = 0; // campo de lentidão afeta todos os inimigos até esse tempo (elapsed)
let sessionHighScore = 0;
let pendingDialog = null;
let profile = {}; // "perfil" que a IA aprende do jogador durante a sessão
let aiLive = true; // otimista até a 1a falha de rede (ai.js controla de verdade via ECI.isDown)

/* ---------------------------------------------------------
   NG+ — a cada vitória normal, o jogo fica mais difícil na
   próxima run (mais inimigos, mais rápidos, boss mais forte)
--------------------------------------------------------- */
let DIFF_MUL = 1; // recalculado em resetRun() a partir de ECI.cycles
function computeDiffMul(){ return 1 + Math.min(ECI.cycles, 6) * 0.16; }

/* ---------------------------------------------------------
   Chefões secretos — quando definido, resetRun() pula direto
   pra uma luta de boss temática, sem as 4 fases normais
--------------------------------------------------------- */
let secretBossKey = null; // null = run normal, senão 'morris'|'melissa'|'iloveyou'|'michelangelo'|'wannacry'|'stuxnet'

STATE_IS_BOSS = ()=> !!(PHASES[phaseIdx] && PHASES[phaseIdx].bossSurvive);

const GLITCH_LINES_BASE = ['SEGFAULT','STACK OVERFLOW','MEMORY LEAK','UNKNOWN EXCEPTION','404 CAOS','RECURSION++','NÃO.','CAOS.EXE ATIVADO','PÉSSIMO.','COMPILANDO...'];
/* easter eggs: vírus clássicos + jogos antigos, citados em tom de paródia */
const EASTER_EGG_LINES = [
  'ILOVEYOU.txt.vbs querendo rodar de novo',
  'MELISSA se espalhando pelo outlook fantasma',
  'BLASTER WORM: "billy gates, pare de fazer software"',
  'tentando abrir DOOM.EXE... falta memória convencional',
  'CONFIG.SYS não encontrado, alguém chame 1998',
  'PING enviado pra 127.0.0.1 e voltou ofendido',
];

/* ---------------------------------------------------------
   Banco de perguntas (aparecem como "erros" do sistema)
--------------------------------------------------------- */
const QUESTIONS = [
  { key:'lang', title:'ERRO INESPERADO', text:'EXCEÇÃO NÃO TRATADA: linguagem de programação favorita não definida. Escolha uma:',
    opts:[['Python','python'],['C/C++','c'],['JavaScript','javascript'],['Java','java']] },
  { key:'fuel', title:'RECURSO INSUFICIENTE', text:'nível de combustível do usuário crítico. o que te mantém acordado estudando?',
    opts:[['Café','café'],['Energético','energético'],['Não durmo mesmo','insônia']] },
  { key:'indent', title:'CONFLITO DE FORMATAÇÃO', text:'guerra clássica detectada. tabs ou espaços?',
    opts:[['Tabs','tabs'],['Espaços','espaços'],['Não ligo','indiferente']] },
  { key:'deadline', title:'PRAZO EXCEDIDO', text:'quando é a entrega do seu próximo trabalho?',
    opts:[['Hoje','hoje'],['Já passou','atrasado'],['Ainda tenho tempo','tranquilo']] },
  { key:'debugStyle', title:'STACKOVERFLOWERROR', text:'a pilha estourou. deseja continuar mesmo assim?',
    opts:[['Sim, sempre','yolo'],['Não, vou debugar','cauteloso']] },
  { key:'sleep', title:'MONITORAMENTO DE PROCESSO', text:'você dormiu essa semana?',
    opts:[['Sim','sim'],['Mais ou menos','talvez'],['ECI.EXE nunca dorme','nunca']] },
  { key:'os', title:'DETECÇÃO DE SISTEMA', text:'sistema operacional de preferência?',
    opts:[['Linux','linux'],['Windows','windows'],['macOS','mac']] },
  { key:'paradigm', title:'PARADIGMA DESCONHECIDO', text:'orientação a objetos ou funcional?',
    opts:[['OO','oo'],['Funcional','funcional'],['O que é isso','leigo']] },
  { key:'bug_feel', title:'ANÁLISE COMPORTAMENTAL', text:'como você reage a um bug que não consegue resolver?',
    opts:[['Grito internamente','grita'],['Vou dormir e penso amanhã','dorme'],['Chamo o ECI.EXE','invoca']] },
  { key:'why_here', title:'CONSULTA DE PROPÓSITO', text:'por que você estuda Engenharia de Computação?',
    opts:[['Amo programar','paixão'],['Mercado de trabalho','carreira'],['Não sei mais','crise']] },
];
let lastQuestionIdx = -1;

/* ---------------------------------------------------------
   Utilidades
--------------------------------------------------------- */
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function fmtTime(s){ s=Math.floor(s); return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }

function screenShake(mag, dur){ shakeMag = Math.max(shakeMag, mag); shakeTimer = Math.max(shakeTimer, dur); }

function spawnParticles(x,y,color,n,speed){
  for(let i=0;i<n;i++){
    particles.push({x,y,vx:rand(rngEvents,-speed,speed),vy:rand(rngEvents,-speed,speed),life:rand(rngEvents,0.3,0.7),c:color});
  }
}
function spawnGlitchText(extra){
  const lines = GLITCH_LINES_BASE.concat(extra||[]);
  glitchTexts.push({ text:pick(rngEvents,lines), x:rand(rngEvents,60,W-200), y:rand(rngEvents,60,H-60), life:1.0 });
}

/* ---------------------------------------------------------
   Setup / reset de partida
--------------------------------------------------------- */
function resetRun(){
  seedAllStreams();
  DIFF_MUL = computeDiffMul();
  player = {
    x:W/2, y:H/2, vx:0, vy:0, dir:'south',
    speed:3.3, hitR:20, invuln:0,
    hits:0, maxHits:5,
    ultCharge:0, ultMax:100,
    cd:{dash:0, seg:0, rec:0, loop:0, exploit:0},
    unlocked: secretBossKey ? {dash:true, seg:true, rec:true, loop:true} : {dash:true, seg:false, rec:false, loop:false},
    shield:false,
  };
  bugs = []; hazards = []; minions = []; particles = []; glitchTexts = []; attacks = [];
  chaser = { x:90, y:90, angle:0, freeze:0 };
  bossState = null;
  globalSlowUntil = 0;
  score = 0; elapsed = 0;
  questionTimer = 0; nextQuestionAt = rand(rngQuestions,18,26);
  crashTimer = 0; nextCrashCheckAt = rand(rngCrash,26,40);
  captchaTimer = 0; nextCaptchaAt = rand(rngEvents,30,55);
  profile = {};
  updatePowerIcons();

  if(secretBossKey){
    // luta de chefão secreto: pula direto pra fase de boss, com todos os poderes liberados
    phaseIdx = PHASES.length-1;
    startBoss(secretBossKey);
  } else {
    phaseIdx = 0;
    for(let i=0;i<6;i++) spawnBug();
  }
}

function spawnBug(){
  const r = rngLoot();
  const type = r<0.08 ? 'shield' : r<0.16 ? 'slow' : r<0.30 ? 'coffee' : 'bug';
  bugs.push({ x:rand(rngLoot,50,W-50), y:rand(rngLoot,50,H-50), wob:rand(rngLoot,0,Math.PI*2), type });
}

function spawnHazard(){
  hazards.push({ x:rand(rngEvents,60,W-60), y:rand(rngEvents,60,H-60), r:34, timer:0, state:'arming' }); // arming -> hot -> gone
}

/* tipos de minion: chaser (padrão), fleeing (foge), forker (se divide ao ser
   atingido pelo EXPLOIT), mirror (reflete o EXPLOIT de volta) */
function pickMinionType(){
  const r = rngSpawn();
  if(phaseIdx<2) return 'chaser';
  if(r<0.15) return 'fleeing';
  if(r<0.30) return 'forker';
  if(r<0.42) return 'mirror';
  return 'chaser';
}
function spawnMinions(n){
  minions = [];
  for(let i=0;i<n;i++) minions.push(makeMinion());
}
function makeMinion(type, x, y, hp){
  const t = type || pickMinionType();
  return {
    type:t, x: x!=null?x:rand(rngSpawn,40,W-40), y: y!=null?y:rand(rngSpawn,40,H-40),
    tx:0, ty:0, speed:rand(rngSpawn,1.1,1.6)*(t==='fleeing'?1.15:1),
    retarget:0, hp: hp!=null?hp: (t==='forker'?2:1),
  };
}

/* ---------------------------------------------------------
   Input
--------------------------------------------------------- */
window.addEventListener('keydown', e=>{
  const k = e.key.toLowerCase();
  keys[k] = true;
  if(k===' ') e.preventDefault();
  if(STATE==='PLAYING'){
    if(k==='q') tryPower('seg');
    if(k==='e') tryPower('rec');
    if(k==='r') tryPower('loop');
    if(k==='f') tryPower('panic');
    if(k==='x') tryPower('exploit');
  }
});
window.addEventListener('keyup', e=>{ keys[e.key.toLowerCase()] = false; });

function requestGameFullscreen(){
  const el = document.getElementById('wrap');
  try{
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if(req) req.call(el).catch(()=>{});
  } catch(e){ /* navegador recusou, sem problema, o jogo continua normal */ }
}

function beginRun(fromEl, bossKey){
  secretBossKey = bossKey || null;
  AUDIO.resume(); AUDIO.startMusic();
  requestGameFullscreen();
  fromEl.classList.add('hidden');
  hud.classList.remove('hidden');
  resetRun();
  STATE = 'PLAYING';
  lastT = performance.now();
  requestAnimationFrame(loop);
}
btnStart.addEventListener('click', ()=> beginRun(menuEl, null));
btnRetry.addEventListener('click', ()=> beginRun(endEl, secretBossKey));

seedTagMenu.textContent = '';
seedTagHud.textContent = '';

/* ---------------------------------------------------------
   IA — status no HUD, memória persistente e menu
--------------------------------------------------------- */
function updateAiStatus(){
  const down = ECI.isDown();
  aiStatusEl.textContent = down ? 'LOCAL' : 'NEURAL';
  aiStatusEl.style.color = down ? '#94a3b8' : '#7dd3fc';
}
function updateMenuMemoryUI(){
  const m = ECI.memory;
  menuTitleEl.innerHTML = ECI.name.replace('.', '<span>.</span>');
  document.title = ECI.name + ' — o jogo';
  renameInput.value = '';
  renameInput.placeholder = 'renomear ' + ECI.name;
  chatTitleEl.textContent = 'CONVERSA — ' + ECI.name;
  cbColorblind.checked = !!m.colorblind;
  document.body.classList.toggle('colorblind', !!m.colorblind);
  if(m.runs>0){
    memLineEl.classList.remove('hidden');
    let line = '> ' + ECI.name + ' lembra de você — ' + m.runs + ' execuções · recorde: ' + (m.bestScore||0);
    const facts = ECI.factsFrom(profile).concat(ECI.factsFrom(m.history||{}));
    if(facts.length) line += ' · da última vez: ' + facts[facts.length-1];
    memLineEl.textContent = line;
  } else {
    memLineEl.classList.add('hidden');
  }
}
ECI.loadMemory().then(()=>{ updateMenuMemoryUI(); updateAiStatus(); updateSecretBossPanel(); updateAiConfigUI(); });

cbColorblind.addEventListener('change', ()=>{
  ECI.memory.colorblind = cbColorblind.checked;
  document.body.classList.toggle('colorblind', cbColorblind.checked);
  ECI.saveMemory();
});
btnRename.addEventListener('click', ()=>{
  if(renameInput.value.trim()){ ECI.setName(renameInput.value); updateMenuMemoryUI(); }
});

/* ---------------------------------------------------------
   Modo conversa — digitar algo pro ECI.EXE e receber resposta
--------------------------------------------------------- */
function appendChat(role, text){
  const line = document.createElement('div');
  line.className = role==='u' ? 'msgU' : 'msgE';
  line.textContent = text;
  chatLogEl.appendChild(line);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}
btnChat.addEventListener('click', ()=>{
  AUDIO.resume();
  chatModal.classList.remove('hidden');
  chatInput.focus();
});
btnChatClose.addEventListener('click', ()=> chatModal.classList.add('hidden'));
async function sendChat(){
  const text = chatInput.value.trim();
  if(!text) return;
  chatInput.value = '';
  appendChat('u', text);
  btnChatSend.disabled = true;
  const res = await ECI.chatLine(text, profile, Math.random);
  updateAiStatus();
  appendChat('e', res.line);
  if(res.unlocked){ updateSecretBossPanel(); AUDIO.sfxAlert(); }
  btnChatSend.disabled = false;
}
btnChatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e=>{ if(e.key==='Enter') sendChat(); });

/* ---------------------------------------------------------
   Poderes
--------------------------------------------------------- */
function tryPower(name){
  if(!player || STATE!=='PLAYING') return;
  if(name==='exploit' && player.cd.exploit<=0){
    // EXPLOIT: dispara um projétil na direção atual, dano em minions e boss
    const dv = dirToVector(player.dir);
    attacks.push({ x:player.x, y:player.y, vx:dv.x*6.5, vy:dv.y*6.5, life:0.9, r:8 });
    player.cd.exploit = 0.55;
    AUDIO.sfxAttack();
  }
  else if(name==='seg' && player.unlocked.seg && player.cd.seg<=0){
    // SEGFAULT: teleporta para um ponto seguro (longe do chaser)
    let best=null, bestD=-1;
    for(let tries=0; tries<12; tries++){
      const cand = { x:rand(rngEvents,50,W-50), y:rand(rngEvents,50,H-50) };
      const d = dist(cand, chaser);
      if(d>bestD){ bestD=d; best=cand; }
    }
    spawnParticles(player.x,player.y,'#7dd3fc',16,4);
    player.x = best.x; player.y = best.y;
    player.invuln = 0.5;
    player.cd.seg = 6.5;
    spawnGlitchText(['SEGFAULT: acesso realocado']);
    AUDIO.sfxGlitch();
  }
  else if(name==='rec' && player.unlocked.rec && player.cd.rec<=0){
    // RECURSION: cria clones-isca
    for(let i=0;i<2;i++){
      minions.push({ x:player.x+rand(rngEvents,-30,30), y:player.y+rand(rngEvents,-30,30),
        decoy:true, life:4.0, tx:0,ty:0,speed:0,retarget:0 });
    }
    player.cd.rec = 11;
    spawnGlitchText(['RECURSION: cópia de si mesmo criada']);
    AUDIO.sfxGlitch();
  }
  else if(name==='loop' && player.unlocked.loop && player.cd.loop<=0){
    // INFINITE LOOP: congela inimigos
    chaser.freeze = 2.6;
    minions.forEach(m=> m.freeze = 2.6);
    if(bossState) bossState.freeze = 2.6;
    player.cd.loop = 15;
    spawnGlitchText(['HAHA','HAHA','INFINITE LOOP']);
    AUDIO.sfxGlitch();
  }
  else if(name==='panic' && player.ultCharge>=player.ultMax){
    // KERNEL PANIC: limpa a tela
    spawnParticles(player.x,player.y,'#f5f7ff',40,7);
    screenShake(14, 0.5);
    minions = [];
    if(bossState) bossState.stunned = 2.2;
    chaser.x = rand(rngEvents,40,W-40); chaser.y = rand(rngEvents,40,H-40);
    player.invuln = 1.5;
    if(player.hits>0) player.hits--;
    player.ultCharge = 0;
    flashPulse(0.8);
    spawnGlitchText(['KERNEL PANIC','ECI.EXE HAS TAKEN CONTROL']);
    AUDIO.sfxAlert();
  }
}

function flashPulse(intensity){
  flashEl.style.transition = 'none';
  flashEl.style.opacity = intensity;
  requestAnimationFrame(()=>{ flashEl.style.transition='opacity .5s'; flashEl.style.opacity=0; });
}

/* ---------------------------------------------------------
   Unlocks por fase
--------------------------------------------------------- */
function applyPhaseUnlocks(){
  if(phaseIdx>=1) player.unlocked.seg = true;
  if(phaseIdx>=2){ player.unlocked.rec = true; player.unlocked.loop = true; }
  updatePowerIcons();
  if(PHASES[phaseIdx].hazards) hazards = hazards.length? hazards : [];
  if(PHASES[phaseIdx].minions) spawnMinions(Math.round(PHASES[phaseIdx].minions*DIFF_MUL));
  if(PHASES[phaseIdx].key==='overflow') startBoss('root');
}

function updatePowerIcons(){
  powEls.dash.classList.toggle('locked', !player.unlocked.dash);
  powEls.seg.classList.toggle('locked', !player.unlocked.seg);
  powEls.rec.classList.toggle('locked', !player.unlocked.rec);
  powEls.loop.classList.toggle('locked', !player.unlocked.loop);
  powEls.panic.classList.toggle('locked', player.ultCharge < player.ultMax);
}

/* ---------------------------------------------------------
   Boss (Fase 4 — OVERFLOW)
--------------------------------------------------------- */
function startBoss(kind){
  const k = kind || 'root';
  const isSecret = k!=='root';
  minions = []; hazards = []; bugs = []; attacks = [];
  bossState = {
    kind: k,
    x:W/2, y:130, t:0, survive:(isSecret?50:PHASES[3].bossSurvive)*DIFF_MUL, patternTimer:0.6, pattern:0,
    projectiles:[], telegraphs:[], freeze:0, stunned:0,
    hp:Math.round(100*DIFF_MUL), hpMax:Math.round(100*DIFF_MUL), tauntTimer:rand(rngSpawn,5,8),
    dormant: k==='michelangelo', clock:null, wormTimer:0, keyTimer:rand(rngSpawn,4,7), keyBug:null,
    cloak: rand(rngSpawn,3,5), centrifuges: k==='stuxnet' ? [
      {x:W*0.22,y:H*0.72,hp:3,hpMax:3},{x:W*0.5,y:H*0.84,hp:3,hpMax:3},{x:W*0.78,y:H*0.72,hp:3,hpMax:3},
    ] : [],
  };
  const label = isSecret ? ECI.VIRUS[k.toUpperCase()].name : 'DEBUG.EXE // ROOT';
  spawnGlitchText([label + ' ONLINE']);
  AUDIO.sfxAlert();
  if(isSecret) ECI.bossEventLine(k,'intro',rngSpawn).then(line=>spawnGlitchText([line]));
}

const BOSS_PATTERN_SETS = {
  root:        ['ring','sweep','homing'],
  morris:      ['ring'],
  melissa:     ['doc_homing','sweep'],
  iloveyou:    ['heart'],
  michelangelo:[],
  wannacry:    [],
  stuxnet:     [],
};
function bossPickPattern(){
  const arr = BOSS_PATTERN_SETS[bossState.kind] || BOSS_PATTERN_SETS.root;
  return arr.length ? pick(rngSpawn, arr) : 'none';
}

function updatePatternTimer(b, dt, intensity){
  b.patternTimer -= dt;
  if(b.patternTimer<=0){
    b.pattern = bossPickPattern();
    b.patternTimer = Math.max(1.1, (rand(rngSpawn,3.4,5.2) - intensity*1.6) / DIFF_MUL);
    if(b.pattern!=='none') launchBossPattern(b.pattern, intensity);
  }
}
/* MORRIS — worm que se autorreplica: gera minions "forker" que dobram ao serem atingidos */
function updateMorrisSpread(b, dt, intensity){
  b.wormTimer -= dt;
  if(b.wormTimer<=0){
    b.wormTimer = Math.max(1.0, 2.6 - intensity*1.6) / DIFF_MUL;
    if(minions.length < 28){
      const n = 1 + Math.round(intensity*2*DIFF_MUL);
      for(let i=0;i<n;i++) minions.push(makeMinion('forker'));
      if(rngSpawn()<0.4) spawnGlitchText(['MORRIS.WORM SE REPLICOU']);
    }
  }
}
/* MICHELANGELO — dormente quase todo o combate; detona a arena quando o "cronômetro" (6 de março) zera */
function updateMichelangelo(b, dt, intensity){
  if(b.clock==null) b.clock = rand(rngSpawn,6,9);
  b.clock -= dt;
  if(b.clock<=0){
    if(b.dormant){
      b.dormant = false;
      launchBossPattern('corrupt', intensity);
      b.clock = 1.6;
    } else {
      b.dormant = true;
      b.clock = Math.max(4.5, rand(rngSpawn,7,10)-intensity*3) / DIFF_MUL;
    }
  }
}
/* WANNACRY — usa o sistema de hazards como "zonas criptografadas" que se espalham; solta uma
   "chave de descriptografia" de tempos em tempos pro jogador limpar a arena */
function updateWannacry(b, dt, intensity){
  b.keyTimer -= dt;
  if(b.keyTimer<=0 && !b.keyBug){
    b.keyTimer = rand(rngSpawn,7,10) / DIFF_MUL;
    b.keyBug = { x:rand(rngLoot,60,W-60), y:rand(rngLoot,60,H-60) };
    spawnGlitchText(['CHAVE DE DESCRIPTOGRAFIA DETECTADA']);
  }
  if(b.keyBug && dist(player,b.keyBug) < 22){
    hazards.forEach(h=>h.state='gone');
    spawnParticles(b.keyBug.x,b.keyBug.y,'#22d97a',16,3.5);
    spawnGlitchText(['ÁREAS DESCRIPTOGRAFADAS']);
    b.keyBug = null;
    AUDIO.sfxBip();
  }
  hazards.forEach(hz=>{
    if(hz.state==='hot' && !hz.spread && rngEvents() < dt*0.5*DIFF_MUL && hazards.length<10){
      hz.spread = true;
      hazards.push({ x:clamp(hz.x+rand(rngEvents,-90,90),40,W-40), y:clamp(hz.y+rand(rngEvents,-90,90),40,H-40), r:34, timer:0, state:'arming' });
    }
  });
}
/* STUXNET — fica encoberto e só se revela pra disparar um tiro cirúrgico contra as centrífugas
   que o jogador precisa proteger; se todas caírem, a sabotagem venceu mesmo com vida sobrando */
function updateStuxnet(b, dt, intensity){
  b.cloak -= dt;
  if(b.cloak<=0){
    const alive = b.centrifuges.filter(c=>c.hp>0);
    if(alive.length){
      const target = pick(rngSpawn, alive);
      const dx = target.x-b.x, dy = target.y-b.y, d = Math.hypot(dx,dy)||1;
      b.projectiles.push({ x:b.x, y:b.y, vx:(dx/d)*4.2, vy:(dy/d)*4.2, life:2.2, delay:0.55, c:'#a3f7bf', targetCentrifuge:target });
      spawnGlitchText(['STUXNET.ZERO MIROU']);
      AUDIO.sfxAttack();
    }
    b.cloak = Math.max(1.8, rand(rngSpawn,3.4,5.2) - intensity*1.8) / DIFF_MUL;
  }
}

function updateBoss(dt){
  const b = bossState;
  b.t += dt;
  AUDIO.setMusicTension(clamp(b.t/b.survive,0.4,1));
  if(b.freeze>0){ b.freeze -= dt; return; }
  if(b.stunned>0){ b.stunned -= dt; return; }

  const intensity = clamp(b.t / b.survive, 0, 1); // 0..1 dificuldade crescente

  if(b.kind==='michelangelo') updateMichelangelo(b, dt, intensity);
  else if(b.kind==='stuxnet') updateStuxnet(b, dt, intensity);
  else if(b.kind==='wannacry') updateWannacry(b, dt, intensity);
  else { updatePatternTimer(b, dt, intensity); if(b.kind==='morris') updateMorrisSpread(b, dt, intensity); }

  b.tauntTimer -= dt;
  if(b.tauntTimer<=0){
    b.tauntTimer = rand(rngSpawn,7,11);
    ECI.tauntLine(profile, rngSpawn, b.kind).then(line=>{ spawnGlitchText([line]); });
  }

  // projéteis
  for(let i=b.projectiles.length-1;i>=0;i--){
    const p = b.projectiles[i];
    if(p.delay>0){ p.delay -= dt; continue; }
    if(p.homing){
      const dx = player.x-p.x, dy=player.y-p.y, d=Math.hypot(dx,dy)||1;
      p.vx += (dx/d)*0.06; p.vy += (dy/d)*0.06;
      const sp = Math.hypot(p.vx,p.vy);
      const maxSp = 3.2;
      if(sp>maxSp){ p.vx = p.vx/sp*maxSp; p.vy = p.vy/sp*maxSp; }
    }
    p.x += p.vx; p.y += p.vy; p.life -= dt;
    if(p.life<=0 || p.x<-20||p.x>W+20||p.y<-20||p.y>H+20){ b.projectiles.splice(i,1); continue; }
    if(p.targetCentrifuge){
      if(dist(p, p.targetCentrifuge) < 16){
        p.targetCentrifuge.hp = Math.max(0, p.targetCentrifuge.hp-1);
        spawnParticles(p.targetCentrifuge.x, p.targetCentrifuge.y, '#f59e0b', 12, 3);
        screenShake(4,0.15);
        b.projectiles.splice(i,1);
      }
      continue;
    }
    if(player.invuln<=0 && dist(player,p) < player.hitR+8){
      b.projectiles.splice(i,1);
      if(p.disablePower){
        const opts = ['seg','rec','loop'].filter(k=>player.unlocked[k]);
        if(opts.length){ const k = pick(rngSpawn, opts); player.cd[k] = Math.max(player.cd[k]||0, 6); spawnGlitchText(['MACRO CORROMPIDA: '+k.toUpperCase()]); }
      }
      playerTakeHit();
    }
  }

  if(b.kind==='stuxnet' && b.centrifuges.length && b.centrifuges.every(c=>c.hp<=0) && STATE==='PLAYING'){
    endGame(false);
  }
}

function launchBossPattern(pattern, intensity){
  const b = bossState;
  AUDIO.sfxAlert();
  const count = Math.round((10 + intensity*10) * DIFF_MUL);
  if(pattern==='ring'){
    for(let i=0;i<count;i++){
      const a = (i/count)*Math.PI*2 + rand(rngSpawn,0,0.3);
      b.projectiles.push({ x:b.x, y:b.y, vx:Math.cos(a)*2.1, vy:Math.sin(a)*2.1, life:4, delay:0, c:'#ef4444' });
    }
    spawnGlitchText(['RING BURST']);
  } else if(pattern==='sweep'){
    const vertical = rngSpawn()<0.5;
    const gapPos = rand(rngSpawn, 0.15, 0.85);
    const n = 14;
    for(let i=0;i<n;i++){
      const t = i/(n-1);
      if(Math.abs(t-gapPos) < 0.09) continue; // brecha pra passar
      const x = vertical ? t*W : rand(rngSpawn,0,W);
      const y = vertical ? rand(rngSpawn,0,H) : t*H;
      const vx = vertical ? 0 : (rngSpawn()<0.5?2.4:-2.4);
      const vy = vertical ? (rngSpawn()<0.5?2.4:-2.4) : 0;
      b.projectiles.push({ x, y, vx:vertical?0:vx, vy:vertical?vy:0, life:2.6, delay:0.75, c:'#f59e0b' });
    }
    spawnGlitchText(['SWEEP LINE']);
  } else if(pattern==='homing'){
    const n = 3 + Math.round(intensity*3);
    for(let i=0;i<n;i++){
      b.projectiles.push({ x:b.x+rand(rngSpawn,-40,40), y:b.y, vx:0, vy:0.6, life:6, delay:rand(rngSpawn,0,0.6), homing:true, c:'#7dd3fc' });
    }
    spawnGlitchText(['HOMING PULSE']);
  } else if(pattern==='doc_homing'){
    // MELISSA: "documentos" teleguiados que corrompem uma macro (poder) ao acertar
    const n = 2 + Math.round(intensity*2*DIFF_MUL);
    for(let i=0;i<n;i++){
      b.projectiles.push({ x:b.x+rand(rngSpawn,-50,50), y:b.y, vx:0, vy:0.5, life:6.5, delay:rand(rngSpawn,0,0.7), homing:true, disablePower:true, c:'#facc15' });
    }
    spawnGlitchText(['ANEXO.DOC EM ROTA']);
  } else if(pattern==='heart'){
    // ILOVEYOU: rajada em forma de coração que "se reenvia" — cresce a cada disparo
    b.heartBursts = (b.heartBursts||0) + 1;
    const n = Math.round((14 + b.heartBursts*3) * DIFF_MUL);
    for(let i=0;i<n;i++){
      const t = (i/n) * Math.PI*2;
      const hx = 16*Math.pow(Math.sin(t),3);
      const hy = -(13*Math.cos(t) - 5*Math.cos(2*t) - 2*Math.cos(3*t) - Math.cos(4*t));
      const d = Math.hypot(hx,hy)||1;
      b.projectiles.push({ x:b.x, y:b.y, vx:(hx/d)*2.4, vy:(hy/d)*2.4, life:3.6, delay:0, c:'#f472b6' });
    }
    spawnGlitchText(['ILOVEYOU.VBS SE REENVIOU']);
  } else if(pattern==='corrupt'){
    // MICHELANGELO: corrompe a arena inteira, exceto alguns bolsões seguros telegrafados
    const gaps = [];
    for(let i=0;i<3;i++) gaps.push({ x:rand(rngSpawn,80,W-80), y:rand(rngSpawn,80,H-80), r:70 });
    for(let gx=30; gx<W; gx+=48){
      for(let gy=30; gy<H; gy+=48){
        if(gaps.some(g=>Math.hypot(gx-g.x,gy-g.y)<g.r)) continue;
        b.projectiles.push({ x:gx, y:gy, vx:0, vy:0, life:1.5, delay:1.1, c:'#f5f7ff', staticHit:true });
      }
    }
    spawnGlitchText(['6 DE MARÇO — CORRUPÇÃO TOTAL']);
    screenShake(10,0.4);
  }
}

/* ---------------------------------------------------------
   Dano ao jogador
--------------------------------------------------------- */
function playerTakeHit(){
  if(player.shield){
    player.shield = false;
    player.invuln = 0.6;
    spawnParticles(player.x,player.y,'#22d97a',16,4);
    spawnGlitchText(['ESCUDO ABSORVEU O DANO']);
    AUDIO.sfxGlitch();
    return;
  }
  player.hits++;
  player.invuln = 1.2;
  player.ultCharge = Math.min(player.ultMax, player.ultCharge + 15);
  spawnParticles(player.x,player.y,'#ef4444',18,4);
  screenShake(8,0.3);
  flashPulse(0.45);
  AUDIO.sfxHit();
  if(player.hits >= player.maxHits){
    endGame(false);
  }
}


function update(dt){
  elapsed += dt;

  // movimento
  let ax=0, ay=0;
  if(keys['arrowup']||keys['w']) ay -= 1;
  if(keys['arrowdown']||keys['s']) ay += 1;
  if(keys['arrowleft']||keys['a']) ax -= 1;
  if(keys['arrowright']||keys['d']) ax += 1;
  const mag = Math.hypot(ax,ay) || 1;
  player.vx = (ax/mag) * player.speed;
  player.vy = (ay/mag) * player.speed;

  if(player.cd.dash>0) player.cd.dash -= dt;
  if(keys[' '] && player.cd.dash<=0 && (ax||ay)){
    player.vx *= 6.5; player.vy *= 6.5;
    player.invuln = Math.max(player.invuln, 0.25);
    player.cd.dash = 1.9;
    spawnParticles(player.x,player.y,PHASES[phaseIdx].color,12,3.5);
    AUDIO.sfxDash();
  }
  ['seg','rec','loop','exploit'].forEach(k=>{ if(player.cd[k]>0) player.cd[k]-=dt; });

  // campo de lentidão (power-up "slow"): afeta todos os inimigos, não o jogador
  const enemySlowMul = elapsed < globalSlowUntil ? 0.45 : 1;

  // projéteis do EXPLOIT (ataque do jogador)
  for(let i=attacks.length-1;i>=0;i--){
    const atk = attacks[i];
    atk.x += atk.vx; atk.y += atk.vy; atk.life -= dt;
    if(atk.life<=0 || atk.x<-10||atk.x>W+10||atk.y<-10||atk.y>H+10){ attacks.splice(i,1); continue; }
    let consumed = false;
    // acerta minions
    for(let j=minions.length-1;j>=0;j--){
      const m = minions[j];
      if(m.decoy) continue;
      if(dist(atk,m) < 18){
        consumed = true;
        if(m.type==='mirror'){
          // reflete: vira um projétil contra o jogador
          attacks.push({ x:m.x, y:m.y, vx:-atk.vx, vy:-atk.vy, life:0.9, r:8, hostile:true });
          minions.splice(j,1);
          spawnGlitchText(['REFLETIDO']);
        } else {
          m.hp -= 1;
          if(m.hp<=0){
            if(m.type==='forker' && !m.split){
              minions.push(makeMinion('chaser', m.x-10, m.y, 1));
              minions.push(makeMinion('chaser', m.x+10, m.y, 1));
              spawnGlitchText(['FORK()']);
            }
            minions.splice(j,1);
          }
        }
        spawnParticles(atk.x,atk.y,'#f59e0b',8,3);
        break;
      }
    }
    // acerta o boss
    if(!consumed && bossState && dist(atk,bossState) < 46){
      bossState.hp = Math.max(0, bossState.hp - 8);
      spawnParticles(atk.x,atk.y,'#f59e0b',10,3);
      screenShake(3,0.12);
      consumed = true;
    }
    // projétil refletido (hostil) acertando o jogador
    if(atk.hostile && player.invuln<=0 && dist(atk,player) < player.hitR+8){
      consumed = true;
      playerTakeHit();
    }
    if(consumed) attacks.splice(i,1);
  }

  const scale = PHASE_SCALE[phaseIdx];
  const half = 20*scale;
  player.x = clamp(player.x+player.vx, half, W-half);
  player.y = clamp(player.y+player.vy, half, H-half);
  if(ax||ay) player.dir = dirFromVector(player.vx,player.vy,player.dir);
  if(player.invuln>0) player.invuln -= dt;

  // chaser (DEBUG.EXE)
  if(!PHASES[phaseIdx].bossSurvive){
    if(chaser.freeze>0){ chaser.freeze -= dt; }
    else {
      const spd = PHASES[phaseIdx].enemySpeed * enemySlowMul * DIFF_MUL;
      const dx=player.x-chaser.x, dy=player.y-chaser.y, d=Math.hypot(dx,dy)||1;
      chaser.x += (dx/d)*spd; chaser.y += (dy/d)*spd;
    }
    chaser.angle += dt*4;
    if(player.invuln<=0 && dist(player,chaser) < half+16){
      chaser.x = rand(rngEvents,40,W-40); chaser.y = rand(rngEvents,40,H-40);
      playerTakeHit();
    }
  }

  // minions
  for(let i=minions.length-1;i>=0;i--){
    const m = minions[i];
    if(m.decoy){
      m.life -= dt;
      if(m.life<=0){ minions.splice(i,1); continue; }
      continue;
    }
    if(m.freeze>0){ m.freeze -= dt; continue; }
    m.retarget -= dt;
    if(m.type==='fleeing'){
      // TIMEOUT.EXE: sempre foge do jogador, refugiando-se nos cantos
      if(m.retarget<=0){
        const dx=m.x-player.x, dy=m.y-player.y, d=Math.hypot(dx,dy)||1;
        m.tx = clamp(m.x + (dx/d)*160, 30, W-30);
        m.ty = clamp(m.y + (dy/d)*160, 30, H-30);
        m.retarget = rand(rngSpawn,0.5,0.9);
      }
    } else if(m.retarget<=0){
      const distToPlayer = dist(m,player);
      if(distToPlayer < 220){ m.tx = player.x; m.ty = player.y; }
      else { m.tx = rand(rngSpawn,30,W-30); m.ty = rand(rngSpawn,30,H-30); }
      m.retarget = rand(rngSpawn,0.8,1.6);
    }
    const dx=m.tx-m.x, dy=m.ty-m.y, d=Math.hypot(dx,dy)||1;
    const spd = m.speed * enemySlowMul;
    if(d>4){ m.x += (dx/d)*spd; m.y += (dy/d)*spd; }
    if(player.invuln<=0 && dist(player,m) < half+12){
      m.x = rand(rngSpawn,30,W-30); m.y = rand(rngSpawn,30,H-30);
      playerTakeHit();
    }
  }

  // hazards (também usados pelo chefão secreto WANNACRY como "zonas criptografadas")
  const isWannacry = bossState && bossState.kind==='wannacry';
  if(PHASES[phaseIdx].hazards || isWannacry){
    hazards.forEach(hz=>{
      hz.timer += dt;
      if(hz.state==='arming' && hz.timer>1.0){ hz.state='hot'; hz.timer=0; }
      else if(hz.state==='hot' && hz.timer>(isWannacry?1.6:0.9)){ hz.state='gone'; hz.timer=0; }
      if(hz.state==='hot' && player.invuln<=0 && dist(player,hz) < hz.r){
        playerTakeHit();
        if(!isWannacry) hz.state='gone';
      }
    });
    hazards = hazards.filter(hz=>hz.state!=='gone');
    if(!isWannacry && rngEvents() < dt*0.12 && hazards.length<4) spawnHazard();
    if(isWannacry && rngEvents() < dt*0.10*DIFF_MUL && hazards.length<9) spawnHazard();
  }

  // bugs
  if(!PHASES[phaseIdx].bossSurvive){
    for(let i=bugs.length-1;i>=0;i--){
      const bg = bugs[i];
      bg.wob += dt*3;
      if(dist(player,bg) < half+10){
        bugs.splice(i,1);
        const gain = bg.type==='coffee' ? 4 : bg.type==='shield' ? 6 : bg.type==='slow' ? 6 : 10;
        score += gain;
        player.ultCharge = Math.min(player.ultMax, player.ultCharge + (bg.type==='bug'?6:2));
        if(bg.type==='coffee') player.speed = Math.min(5.5, player.speed+0.15);
        if(bg.type==='shield'){ player.shield = true; spawnGlitchText(['ESCUDO CARREGADO']); }
        if(bg.type==='slow'){ globalSlowUntil = elapsed + 5; spawnGlitchText(['CAMPO DE LENTIDÃO']); }
        spawnBug();
        spawnParticles(bg.x,bg.y, bg.type==='shield'?'#22d97a': bg.type==='slow'?'#a78bfa':'#7dd3fc',10,2.5);
        AUDIO.sfxBip();
        if(rngLoot()<0.3) spawnGlitchText();
      }
    }
    if(score >= PHASES[phaseIdx].scoreToNext && phaseIdx < PHASES.length-1){
      const leftPhase = phaseIdx;
      phaseIdx++;
      spawnGlitchText(['NÍVEL ACIMA', PHASES[phaseIdx].name]);
      screenShake(6,0.3);
      applyPhaseUnlocks();
      revealCodewordForPhase(leftPhase);
      ECI.phaseLine(PHASES[phaseIdx].name, profile, rngEvents).then(line=>{ spawnGlitchText([line]); });
    }
  } else {
    updateBoss(dt);
    if(bossState.hp<=0 || bossState.t >= bossState.survive){
      endGame(true);
    }
  }

  // partículas / textos glitch
  for(let i=particles.length-1;i>=0;i--){
    const p = particles[i];
    p.x+=p.vx; p.y+=p.vy; p.life -= dt*1.6;
    if(p.life<=0) particles.splice(i,1);
  }
  for(let i=glitchTexts.length-1;i>=0;i--){ glitchTexts[i].life -= dt*0.55; if(glitchTexts[i].life<=0) glitchTexts.splice(i,1); }
  if(shakeTimer>0) shakeTimer -= dt; else shakeMag = 0;

  updatePowerIcons();

  // ------- sistema de perguntas (IA "aprendendo") -------
  questionTimer += dt;
  if(questionTimer >= nextQuestionAt){
    questionTimer = 0;
    nextQuestionAt = rand(rngQuestions, 22, 34);
    if(rngQuestions() < 0.75) triggerQuestion();
  }

  // ------- sistema de crash aleatório -------
  crashTimer += dt;
  if(crashTimer >= nextCrashCheckAt){
    crashTimer = 0;
    nextCrashCheckAt = rand(rngCrash, 24, 42);
    if(rngCrash() < 0.5) triggerCrash();
  }

  // ------- CAPTCHA falso (easter egg) -------
  captchaTimer += dt;
  if(captchaTimer >= nextCaptchaAt && STATE==='PLAYING'){
    captchaTimer = 0;
    nextCaptchaAt = rand(rngEvents, 45, 75);
    if(rngEvents() < 0.4) triggerCaptcha();
  }
}

/* ---------------------------------------------------------
   Perguntas 
--------------------------------------------------------- */
function triggerQuestion(){
  let idx;
  do { idx = Math.floor(rngQuestions()*QUESTIONS.length); } while(idx===lastQuestionIdx && QUESTIONS.length>1);
  lastQuestionIdx = idx;
  const q = QUESTIONS[idx];
  pendingDialog = q;
  STATE = 'DIALOG';
  dialogTitle.textContent = q.title;
  dialogText.textContent = q.text;
  dialogOptions.innerHTML = '';
  const shuffled = q.opts.slice().sort(()=>rngQuestions()-0.5);
  shuffled.forEach(([label,val])=>{
    const btn = document.createElement('button');
    btn.textContent = '> ' + label;
    btn.addEventListener('click', ()=>answerQuestion(q.key, val));
    dialogOptions.appendChild(btn);
  });
  dialogEl.classList.remove('hidden');
}

function answerQuestion(key,val){
  profile[key] = val;
  dialogEl.classList.add('hidden');
  score += 5;
  player.ultCharge = Math.min(player.ultMax, player.ultCharge + 8);
  spawnGlitchText(['DADO REGISTRADO: '+val.toUpperCase()]);
  STATE = 'PLAYING';
  lastT = performance.now();
  requestAnimationFrame(loop);
  ECI.answerLine(key, val, rngQuestions).then(line=>{ spawnGlitchText([line]); });
}

/* ---------------------------------------------------------
   CAPTCHA falso — easter egg. Sempre quebra de propósito.
   Tem um timeout de segurança: se o jogador ignorar, ele
   "resolve sozinho" (glitchando) pra nunca travar a partida.
--------------------------------------------------------- */
let captchaResolved = false, captchaAutoTimer = null;
function triggerCaptcha(){
  STATE = 'CAPTCHA';
  captchaResolved = false;
  captchaCheckbox.checked = false;
  captchaCheckbox.disabled = false;
  captchaGlitchMsg.classList.add('hidden');
  captchaModal.classList.remove('hidden');
  captchaAutoTimer = setTimeout(()=> resolveCaptcha(true), 6000);
}
function resolveCaptcha(auto){
  if(captchaResolved) return;
  captchaResolved = true;
  clearTimeout(captchaAutoTimer);
  captchaCheckbox.disabled = true;
  AUDIO.sfxCaptcha();
  setTimeout(()=>{
    captchaCheckbox.checked = false;
    captchaGlitchMsg.textContent = pick(rngEvents, auto ? [
      'TEMPO ESGOTADO. presumindo que você é um robô mesmo.',
      'CAPTCHA.EXE desistiu de esperar.',
    ] : [
      'CAPTCHA.EXE PAROU DE FUNCIONAR.',
      'ERRO: você provou que É um robô.',
      'falha na verificação. tente novamente nunca.',
      '"não sou um robô" não compila.',
    ]);
    captchaGlitchMsg.classList.remove('hidden');
    setTimeout(()=>{
      captchaModal.classList.add('hidden');
      STATE = 'PLAYING';
      lastT = performance.now();
      requestAnimationFrame(loop);
    }, 1100);
  }, auto?0:550);
}
captchaCheckbox.addEventListener('change', ()=>{
  if(!captchaCheckbox.checked) return;
  resolveCaptcha(false);
});

function profileLine(){
  const bits = [];
  if(profile.lang) bits.push('linguagem preferida: '+profile.lang);
  if(profile.fuel) bits.push('combustível: '+profile.fuel);
  if(profile.indent) bits.push('indentação: '+profile.indent);
  if(profile.os) bits.push('sistema: '+profile.os);
  if(profile.sleep) bits.push('sono: '+profile.sleep);
  if(bits.length===0) return 'PERFIL DO USUÁRIO: dados insuficientes.';
  return 'PERFIL DO USUÁRIO: ' + pick(rngCrash, bits) + '.';
}

/* ---------------------------------------------------------
   Sistema de crash aleatório
--------------------------------------------------------- */
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function triggerCrash(){
  STATE = 'CRASH';
  screenShake(16, 0.6);
  AUDIO.sfxAlert();
  crashText.textContent = '';
  const hard = rngCrash() < 0.28; // ~28% dos crashes reiniciam tudo
  const step = hard ? 260 : 220;
  const aiLinePromise = ECI.crashLine(profile, rngCrash); // dispara já, corre em paralelo

  const linesBefore = [
    '> compilando estado do processo...',
    '> SEGMENTATION FAULT em 0x' + Math.floor(rngCrash()*0xFFFFFF).toString(16).toUpperCase(),
    '> MEMORY LEAK detectado (' + Math.floor(rand(rngCrash,120,900)) + 'kb)',
    '> ' + profileLine(),
  ];
  if(rngCrash() < 0.35) linesBefore.push('> ' + pick(rngCrash, EASTER_EGG_LINES));
  const linesAfter = hard
    ? ['> tentando corrigir automaticamente...', '> falhou.', '> FALHA CRÍTICA — o processo não pôde ser recuperado.', '> REINICIANDO DO ZERO...']
    : ['> tentando corrigir automaticamente...', '> falhou.', '> processo recompilado. retomando execução...'];

  crashEl.classList.remove('hidden');
  for(const ln of linesBefore){ crashText.textContent += ln + '\n'; updateAiStatus(); await sleep(step); }

  // linha "viva" gerada pela IA (real ou fallback local) — se não responder a
  // tempo, segue com o fallback local pra não travar o ritmo do crash
  const aiLine = await Promise.race([aiLinePromise, sleep(2200).then(()=>null)]);
  const finalAiLine = aiLine || ('> ' + profileLine());
  crashText.textContent += (finalAiLine.startsWith('>') ? finalAiLine : '> '+finalAiLine) + '\n';
  updateAiStatus();
  await sleep(step);

  for(const ln of linesAfter){ crashText.textContent += ln + '\n'; await sleep(step); }
  await sleep(700);
  crashEl.classList.add('hidden');
  if(hard){
    sessionHighScore = Math.max(sessionHighScore, score);
    ECI.memory.bestScore = Math.max(ECI.memory.bestScore||0, sessionHighScore);
    ECI.memory.totalHits = (ECI.memory.totalHits||0) + player.hits;
    ECI.saveMemory();
    hud.classList.add('hidden');
    menuEl.classList.remove('hidden');
    updateMenuMemoryUI();
    STATE = 'MENU';
  } else {
    // crash "suave": empurra ameaças pra longe como misericórdia
    chaser.x = rand(rngEvents,40,W-40); chaser.y = rand(rngEvents,40,H-40);
    minions.forEach(m=>{ m.x = rand(rngEvents,40,W-40); m.y = rand(rngEvents,40,H-40); });
    STATE = 'PLAYING';
    lastT = performance.now();
    requestAnimationFrame(loop);
  }
}

/* ---------------------------------------------------------
   Fim de jogo
--------------------------------------------------------- */
function endGame(won){
  STATE = won ? 'VICTORY' : 'GAMEOVER';
  AUDIO.stopMusic();
  sessionHighScore = Math.max(sessionHighScore, score);
  hud.classList.add('hidden');

  if(secretBossKey){
    endSecretBoss(won);
    return;
  }

  endTitle.textContent = won ? 'VOCÊ EXCEDEU OS LIMITES' : 'SYSTEM RESTORED';
  endText.textContent = won
    ? ECI.name + ' // OVERFLOW sobreviveu ao KERNEL PANIC de DEBUG.EXE // ROOT. o sistema agora te pertence.'
    : 'DEBUG.EXE corrigiu o processo... por enquanto.';
  endScore.textContent = 'SCORE: ' + score + '   ·   RECORDE DA SESSÃO: ' + sessionHighScore;
  endEl.classList.remove('hidden');

  // memória entre sessões: acumula fatos, recorde e execuções
  const m = ECI.memory;
  m.runs = (m.runs||0) + 1;
  m.bestScore = Math.max(m.bestScore||0, score);
  m.totalHits = (m.totalHits||0) + player.hits;
  m.history = Object.assign({}, m.history||{}, profile);
  if(!m.firstSeen) m.firstSeen = Date.now();
  ECI.saveMemory();

  // NG+ e codewords: vitória sobe o ciclo e libera pistas; derrota também dá uma pista
  if(won){
    const wasSecondPlus = ECI.cycles >= 1;
    ECI.bumpCycle();
    revealCodewordById('ILOVEYOU');
    if(wasSecondPlus) revealCodewordById('STUXNET');
    endTitle.textContent += '  ·  NG+' + ECI.cycles;
  } else {
    revealCodewordById('WANNACRY');
  }
  updateSecretBossPanel();

  ECI.runSummary(profile, {score, won}, rngCrash).then(line=>{
    updateAiStatus();
    endText.textContent += '\n\n> ' + line;
  });
}

/* fim de uma luta de chefão secreto — não conta pra NG+ nem histórico normal */
function endSecretBoss(won){
  const v = ECI.VIRUS[secretBossKey.toUpperCase()];
  endTitle.textContent = won ? 'QUARENTENA CONCLUÍDA' : 'INFECÇÃO VENCEU';
  endText.textContent = won
    ? v.name + ' isolado. ' + v.fact
    : v.name + ' escapou da quarentena... tente de novo.';
  endScore.textContent = 'SCORE: ' + score;
  endEl.classList.remove('hidden');
  ECI.bossEventLine(secretBossKey, won?'defeat':'intro', rngCrash).then(line=>{
    endText.textContent += '\n\n> ' + line;
  });
}

/* ---------------------------------------------------------
   Codewords dos chefões secretos
--------------------------------------------------------- */
const REVEAL_ON_PHASE = ['MICHELANGELO','MELISSA','MORRIS']; // índice = fase que o jogador está deixando (0,1,2)
function revealCodewordById(id){
  if(!id || secretBossKey || ECI.isDiscovered(id)) return;
  ECI.revealCodeword(id);
  const v = ECI.VIRUS[id];
  spawnGlitchText(['CODEWORD ENCONTRADA: ' + v.codeword]);
}
function revealCodewordForPhase(leftPhaseIdx){
  revealCodewordById(REVEAL_ON_PHASE[leftPhaseIdx]);
  updateSecretBossPanel();
}

/* ---------------------------------------------------------
   Desenho
--------------------------------------------------------- */
function drawBackground(){
  ctx.fillStyle = '#070a1a';
  ctx.fillRect(0,0,W,H);
  const tint = PHASES[phaseIdx].color;
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = tint;
  ctx.fillRect(0,0,W,H);
  ctx.restore();

  ctx.strokeStyle = 'rgba(37,99,235,0.07)';
  for(let gx=0; gx<W; gx+=30){ ctx.beginPath(); ctx.moveTo(gx,0); ctx.lineTo(gx,H); ctx.stroke(); }
  for(let gy=0; gy<H; gy+=30){ ctx.beginPath(); ctx.moveTo(0,gy); ctx.lineTo(W,gy); ctx.stroke(); }
}

function drawHazards(){
  hazards.forEach(hz=>{
    ctx.save();
    ctx.translate(hz.x,hz.y);
    if(hz.state==='arming'){
      ctx.strokeStyle = 'rgba(245,158,11,0.8)';
      ctx.setLineDash([6,4]);
      ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(0,0,hz.r,0,Math.PI*2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle='#f59e0b'; ctx.font='16px monospace'; ctx.textAlign='center';
      ctx.fillText('!', 0, 5);
    } else if(hz.state==='hot'){
      ctx.fillStyle = 'rgba(239,68,68,0.28)';
      ctx.shadowColor='#ef4444'; ctx.shadowBlur=16;
      ctx.beginPath(); ctx.arc(0,0,hz.r,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
  });
}

function drawBugs(){
  ctx.font='16px monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
  bugs.forEach(bg=>{
    const wobY = Math.sin(bg.wob)*4;
    if(bg.type==='coffee'){
      ctx.fillStyle = '#c88a45'; ctx.shadowColor='#c88a45'; ctx.shadowBlur=10;
      ctx.beginPath(); ctx.arc(bg.x, bg.y+wobY, 9, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle='#f5f7ff'; ctx.fillText('☕', bg.x, bg.y+wobY+1);
    } else if(bg.type==='shield'){
      ctx.fillStyle = '#22d97a'; ctx.shadowColor='#22d97a'; ctx.shadowBlur=12;
      ctx.beginPath(); ctx.arc(bg.x, bg.y+wobY, 9, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle='#0a0e27'; ctx.fillText('◆', bg.x, bg.y+wobY+1);
    } else if(bg.type==='slow'){
      ctx.fillStyle = '#a78bfa'; ctx.shadowColor='#a78bfa'; ctx.shadowBlur=12;
      ctx.beginPath(); ctx.arc(bg.x, bg.y+wobY, 9, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle='#0a0e27'; ctx.fillText('%', bg.x, bg.y+wobY+1);
    } else {
      ctx.fillStyle = '#7dd3fc'; ctx.shadowColor='#7dd3fc'; ctx.shadowBlur=10;
      ctx.beginPath(); ctx.arc(bg.x, bg.y+wobY, 9, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle='#0a0e27'; ctx.fillText('!', bg.x, bg.y+wobY+1);
    }
    ctx.shadowBlur=0;
  });
}

function drawDebugUnit(x,y,angle,size,color){
  color = color || '#ef4444';
  ctx.save();
  ctx.translate(x,y);
  ctx.rotate(angle*0.15);
  ctx.fillStyle = color;
  ctx.shadowColor = color; ctx.shadowBlur = 12;
  ctx.fillRect(-size,-size,size*2,size*2);
  ctx.fillStyle = '#0a0e27';
  ctx.font = 'bold '+Math.round(size*1.1)+'px monospace';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('X', 0, 1);
  ctx.restore();
}

const MINION_COLORS = { chaser:'#ef4444', fleeing:'#f59e0b', forker:'#a78bfa', mirror:'#22d97a' };
function drawMinions(){
  minions.forEach(m=>{
    ctx.save();
    ctx.globalAlpha = m.decoy ? Math.max(0.3, m.life/4) : 1;
    if(m.decoy){
      drawMascot(m.x, m.y, 30, PHASES[phaseIdx].color, 0, 'south');
    } else {
      drawDebugUnit(m.x, m.y, performance.now()/90, 12, MINION_COLORS[m.type]||'#ef4444');
    }
    ctx.restore();
  });
}

function drawAttacks(){
  attacks.forEach(a=>{
    ctx.save();
    ctx.fillStyle = a.hostile ? '#22d97a' : '#f59e0b';
    ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(a.x,a.y, a.r||6, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  });
}

function drawMascot(x,y,size,color,pulse,dir){
  const img = sprites[dir];
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 10 + pulse*8;
  if(img && img.complete && img.naturalWidth>0){
    ctx.drawImage(img, x-size, y-size, size*2, size*2);
  } else {
    // fallback vetorial enquanto a imagem carrega
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x,y,size*0.7,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

const BOSS_VISUAL = {
  root:         { color:'#ef4444', label:'DEBUG.EXE // ROOT', glyph:'X' },
  morris:       { color:'#a78bfa', label:'MORRIS.WORM — 1988', glyph:'W' },
  melissa:      { color:'#facc15', label:'MELISSA.DOC — 1999', glyph:'@' },
  iloveyou:     { color:'#f472b6', label:'ILOVEYOU.VBS — 2000', glyph:'<3' },
  michelangelo: { color:'#38bdf8', label:'MICHELANGELO.BOOT — 1991', glyph:'6/3' },
  wannacry:     { color:'#f87171', label:'WANNACRY.LOCK — 2017', glyph:'$' },
  stuxnet:      { color:'#4ade80', label:'STUXNET.ZERO — 2010', glyph:'?' },
};
function drawBoss(){
  if(!bossState) return;
  const b = bossState;
  const vis = BOSS_VISUAL[b.kind] || BOSS_VISUAL.root;
  const pulse = Math.sin(performance.now()/150)*0.5+0.5;

  // STUXNET fica quase invisível fora da janela de mira; MICHELANGELO "dorme" (baixa opacidade)
  const bodyAlpha = b.kind==='stuxnet' ? (b.cloak<0.6?0.9:0.12) : (b.kind==='michelangelo' && b.dormant ? 0.35 : 1);

  ctx.save();
  ctx.globalAlpha = bodyAlpha;
  ctx.translate(b.x,b.y);
  ctx.fillStyle = b.stunned>0 ? '#475569' : vis.color;
  ctx.shadowColor = vis.color; ctx.shadowBlur = 22+pulse*10;
  const s = 46;
  ctx.beginPath();
  ctx.moveTo(-s, s*0.5);
  ctx.quadraticCurveTo(-s*1.1,-s*0.7,0,-s*1.4);
  ctx.quadraticCurveTo(s*1.1,-s*0.7,s,s*0.5);
  ctx.quadraticCurveTo(0,s*1.1,-s,s*0.5);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle='#0a0e27'; ctx.font='bold 18px monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(vis.glyph, 0, -4);
  ctx.restore();

  // centrífugas (STUXNET) — objetivo de defesa
  b.centrifuges.forEach(c=>{
    ctx.save();
    ctx.translate(c.x,c.y);
    ctx.globalAlpha = c.hp<=0 ? 0.15 : 1;
    ctx.strokeStyle = c.hp<=0 ? '#475569' : '#4ade80';
    ctx.lineWidth = 3; ctx.shadowColor='#4ade80'; ctx.shadowBlur = c.hp>0?10:0;
    ctx.beginPath(); ctx.arc(0,0,16,0,Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0,0,7,0,Math.PI*2); ctx.stroke();
    ctx.restore();
  });

  // chave de descriptografia (WANNACRY)
  if(b.keyBug){
    ctx.save();
    ctx.translate(b.keyBug.x,b.keyBug.y);
    ctx.fillStyle = '#22d97a'; ctx.shadowColor='#22d97a'; ctx.shadowBlur = 12;
    ctx.font='16px monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('key', 0, 0);
    ctx.restore();
  }

  // projéteis
  b.projectiles.forEach(p=>{
    if(p.delay>0) return;
    ctx.save();
    ctx.fillStyle = p.c;
    ctx.shadowColor = p.c; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(p.x,p.y,6,0,Math.PI*2); ctx.fill();
    ctx.restore();
  });
  // telegraph (linhas de aviso amarelas para projéteis com delay)
  b.projectiles.forEach(p=>{
    if(p.delay>0){
      ctx.save();
      ctx.globalAlpha = 0.5 + Math.sin(performance.now()/80)*0.3;
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath(); ctx.arc(p.x,p.y,5,0,Math.PI*2); ctx.fill();
      ctx.restore();
    }
  });

  // barra de HP do boss (dano do EXPLOIT do jogador)
  ctx.save();
  const bw = 360, bx = W/2-bw/2, by = 40;
  const hpProg = clamp(b.hp/b.hpMax,0,1);
  ctx.fillStyle = 'rgba(6,9,20,.8)'; ctx.fillRect(bx-4,by-4,bw+8,18);
  ctx.strokeStyle = vis.color; ctx.strokeRect(bx-4,by-4,bw+8,18);
  ctx.fillStyle = vis.color; ctx.fillRect(bx,by,bw*hpProg,10);
  ctx.fillStyle = '#f5f7ff'; ctx.font = "9px 'Press Start 2P', monospace"; ctx.textAlign='center';
  ctx.fillText(vis.label, W/2, by-8);
  ctx.restore();

  // barra secundária: tempo de sobrevivência (intensidade crescente)
  ctx.save();
  const sProg = clamp(b.t/b.survive,0,1);
  ctx.fillStyle = 'rgba(6,9,20,.7)'; ctx.fillRect(bx-4,by+18,bw+8,7);
  ctx.fillStyle = '#f59e0b'; ctx.fillRect(bx,by+20,bw*sProg,3);
  ctx.restore();

  if(b.kind==='michelangelo' && b.dormant){
    ctx.save();
    ctx.fillStyle='rgba(56,189,248,0.8)'; ctx.font="9px 'Press Start 2P', monospace"; ctx.textAlign='center';
    ctx.fillText('AGUARDANDO 6 DE MARÇO...', W/2, by+42);
    ctx.restore();
  }
}

function drawParticles(){
  particles.forEach(p=>{
    ctx.globalAlpha = Math.max(p.life,0);
    ctx.fillStyle = p.c;
    ctx.fillRect(p.x-2,p.y-2,4,4);
  });
  ctx.globalAlpha = 1;
}

function drawGlitchTexts(){
  glitchTexts.forEach(g=>{
    ctx.save();
    ctx.globalAlpha = Math.max(g.life,0);
    ctx.fillStyle = '#ef4444';
    ctx.font = "10px 'Press Start 2P', monospace";
    ctx.textAlign='left';
    ctx.fillText(g.text, g.x+rand(rngEvents,-2,2), g.y);
    ctx.restore();
  });
}

function draw(){
  ctx.save();
  if(shakeTimer>0){
    ctx.translate(rand(rngEvents,-shakeMag,shakeMag), rand(rngEvents,-shakeMag,shakeMag));
  }
  drawBackground();
  drawHazards();
  drawBugs();
  drawParticles();

  const scale = PHASE_SCALE[phaseIdx];
  const flicker = player.invuln>0 && Math.floor(performance.now()/80)%2===0;
  if(!flicker) drawMascot(player.x, player.y, 34*scale, PHASES[phaseIdx].color, Math.sin(performance.now()/200)*0.5+0.5, player.dir);
  if(player.shield){
    ctx.save();
    ctx.strokeStyle = '#22d97a'; ctx.lineWidth = 2;
    ctx.shadowColor='#22d97a'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(player.x, player.y, 34*scale*1.25, 0, Math.PI*2); ctx.stroke();
    ctx.restore();
  }

  drawMinions();
  drawAttacks();
  if(!PHASES[phaseIdx].bossSurvive) drawDebugUnit(chaser.x, chaser.y, performance.now()/100, 15);
  else drawBoss();

  drawGlitchTexts();
  ctx.restore();
}

/* ---------------------------------------------------------
   HUD
--------------------------------------------------------- */
function updateHud(){
  phaseNameEl.textContent = secretBossKey ? ('CHEFÃO SECRETO — ' + ECI.VIRUS[secretBossKey.toUpperCase()].name) : PHASES[phaseIdx].name;
  const intPct = clamp(12 + phaseIdx*26 + Math.min(score,200)/8, 0, 100);
  const caosPct = clamp(4 + phaseIdx*23 + player.hits*15, 0, 100);
  barInt.style.width = intPct+'%';
  barCaos.style.width = caosPct+'%';
  barUlt.style.width = (player.ultCharge/player.ultMax*100)+'%';
  hScore.textContent = score;
  hTime.textContent = fmtTime(elapsed);
  hCore.textContent = player.hits===0 ? 'STABLE' : player.hits<=2 ? 'OVERCLOCKED' : 'CRITICAL';
  hCore.style.color = player.hits===0 ? '#7dd3fc' : player.hits<=2 ? '#f5f7ff' : '#ef4444';

  hitsRow.innerHTML = '';
  for(let i=0;i<player.maxHits;i++){
    const pip = document.createElement('div');
    pip.className = 'hitpip' + (i<player.hits ? ' lost' : '');
    hitsRow.appendChild(pip);
  }
  ['dash','seg','rec','loop','exploit'].forEach(k=>{
    const el = powEls[k];
    const cdEl = el.querySelector('.cd');
    const cdVal = player.cd[k] || 0;
    const cdMax = k==='dash'?1.9:k==='seg'?6.5:k==='rec'?11:k==='exploit'?0.55:15;
    const wasOnCd = el.dataset.onCd === '1';
    cdEl.style.transform = 'scaleY(' + clamp(cdVal/cdMax,0,1) + ')';
    let numEl = cdEl.querySelector('.cdNum');
    if(!numEl){ numEl = document.createElement('span'); numEl.className='cdNum'; cdEl.appendChild(numEl); }
    numEl.textContent = cdVal>0.05 ? cdVal.toFixed(1) : '';
    if(wasOnCd && cdVal<=0){ el.classList.remove('ready'); void el.offsetWidth; el.classList.add('ready'); }
    el.dataset.onCd = cdVal>0 ? '1' : '0';
  });
  const panicEl = powEls.panic;
  panicEl.querySelector('.cd').style.transform = 'scaleY(' + (1-player.ultCharge/player.ultMax) + ')';
}

/* ---------------------------------------------------------
   Loop principal
--------------------------------------------------------- */
function loop(t){
  if(STATE!=='PLAYING') return;
  const dt = Math.min((t-lastT)/1000, 0.05) || 0;
  lastT = t;
  update(dt);
  draw();
  updateHud();
  requestAnimationFrame(loop);
}

/* inicializa fundo do menu com o jogo "rodando" atrás, parado */
resetRun();
draw();

})();
