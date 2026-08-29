/* =========================================================
   ECI.EXE — cérebro + memória persistente
   ---------------------------------------------------------
   Módulo separado do game.js. Responsável por:
   - falar com uma IA real quando configurada (Claude, ou
     qualquer endpoint compatível com OpenAI/chat — incluindo
     um gpt-oss local via Ollama/vLLM), com fallback local
     por templates quando não há IA disponível;
   - guardar memória entre sessões (window.storage ou
     localStorage, o que estiver disponível);
   - traduzir o "perfil" coletado do jogador em frases;
   - registrar o histórico de conversa do "modo conversa";
   - lore + falas dos 6 chefões secretos (vírus históricos);
   - sistema de "codewords" que desbloqueiam esses chefões.
   Tudo exposto em window.ECI.
   ========================================================= */
(function(){
"use strict";

const MEM_KEY = 'eci_exe_memoria_jogador';
const DEFAULT_NAME = 'ECI.EXE';

let memory = {
  runs: 0,
  bestScore: 0,
  totalHits: 0,
  history: {},        // acumula respostas de perguntas ao longo de várias partidas
  colorblind: false,
  firstSeen: null,
  ecName: DEFAULT_NAME,
  chatLog: [],         // últimas trocas do "modo conversa"
  chatCount: 0,        // quantas mensagens já foram trocadas (afeta o "tom")
  summary: '',         // último "resumo do que ele achou de você"
  cycles: 0,            // quantas vezes o jogador já zerou (NG+, sobe a dificuldade)
  discovered: [],        // codewords já reveladas pro jogador (mas talvez não digitadas ainda)
  unlocked: [],           // chaves dos chefões secretos já desbloqueados
  apiMode: 'local',        // 'local' | 'claude' | 'custom'
  apiKey: '',                // só usada em apiMode 'claude' (fica só no localStorage do jogador)
  customEndpoint: '',         // ex: http://localhost:11434/v1/chat/completions (gpt-oss via Ollama)
  customModel: 'gpt-oss:20b',  // nome do modelo no endpoint custom
};

async function memGet(){
  try{
    if(window.storage){
      const r = await window.storage.get(MEM_KEY, false);
      return r ? JSON.parse(r.value) : null;
    }
  } catch(e){ /* chave ainda não existe */ }
  try{
    const raw = localStorage.getItem(MEM_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e){ return null; }
}
async function memSet(obj){
  const payload = JSON.stringify(obj);
  try{
    if(window.storage){ await window.storage.set(MEM_KEY, payload, false); return; }
  } catch(e){ /* segue pro fallback */ }
  try{ localStorage.setItem(MEM_KEY, payload); } catch(e){ /* sem storage, tudo bem */ }
}
async function loadMemory(){
  const saved = await memGet();
  if(saved) memory = Object.assign(memory, saved);
  return memory;
}
function saveMemory(){ memSet(memory); } // fire-and-forget, nunca trava o jogo

/* ---------------------------------------------------------
   Fatos de perfil -> frases naturais (prompt real + fallback local)
--------------------------------------------------------- */
const FACT_PHRASES = {
  lang: v=>'usuário de ' + v,
  fuel: v=>'rodando à base de ' + v,
  indent: v=> v==='tabs' ? 'do time das tabs' : v==='espaços' ? 'do time dos espaços' : 'sem opinião sobre tabs vs. espaços — suspeito',
  deadline: v=> v==='hoje' ? 'com entrega HOJE e jogando mesmo assim' : v==='atrasado' ? 'com prazo já estourado' : 'fingindo que ainda tem tempo',
  debugStyle: v=> v==='yolo' ? 'ignora stack overflow e segue o jogo' : 'prefere debugar com calma — raro por aqui',
  sleep: v=> v==='nunca' ? 'não dorme, igual a mim' : v==='talvez' ? 'meio zumbi essa semana' : 'dormiu bem — suspeito',
  os: v=>'roda ' + v,
  paradigm: v=>'fã de ' + v,
  bug_feel: v=> v==='grita' ? 'grita internamente com bug sem solução' : v==='dorme' ? 'prefere dormir e resolver o bug amanhã' : 'me invoca quando trava',
  why_here: v=> v==='crise' ? 'em crise existencial sobre o curso' : v==='paixão' ? 'aqui por amor ao código' : 'pensando em carreira',
};
function factsFrom(obj){
  return Object.keys(obj||{}).filter(k=>FACT_PHRASES[k]).map(k=>FACT_PHRASES[k](obj[k]));
}
function pick(rng, arr){ return arr[Math.floor(rng()*arr.length)]; }

/* ---------------------------------------------------------
   Lore dos chefões secretos — vírus reais que marcaram a
   história da computação. Cada um vira um chefão com
   mecânica própria em game.js.
--------------------------------------------------------- */
const VIRUS = {
  MORRIS: {
    key:'morris', codeword:'MORRIS', name:'MORRIS.WORM', year:1988,
    tag:'o primeiro worm de verdade',
    fact:'travou cerca de 10% de toda a internet da época só se replicando sem parar.',
    style:'enxame que se autocopia — cada cópia sua gera outras duas se você não for rápido.',
  },
  MELISSA: {
    key:'melissa', codeword:'MELISSA', name:'MELISSA.DOC', year:1999,
    tag:'o macro vírus disfarçado de documento',
    fact:'se espalhava fingindo ser uma lista de senhas anexada num e-mail do Outlook.',
    style:'documentos teleguiados que corrompem uma das suas macros (poderes) ao te acertar.',
  },
  ILOVEYOU: {
    key:'iloveyou', codeword:'ILOVEYOU', name:'ILOVEYOU.VBS', year:2000,
    tag:'a carta de amor que incendiou a internet',
    fact:'chegava com assunto "ILOVEYOU" e um anexo de amor — infectou dezenas de milhões de máquinas.',
    style:'rajadas em formato de coração que se reenviam sozinhas, cada eco mais rápido que o anterior.',
  },
  MICHELANGELO: {
    key:'michelangelo', codeword:'MICHELANGELO', name:'MICHELANGELO.BOOT', year:1991,
    tag:'a bomba-relógio de disquete',
    fact:'ficava invisível o ano inteiro e só disparava em 6 de março, aniversário do pintor.',
    style:'fica dormente quase todo o combate — e detona a arena inteira quando o cronômetro zera.',
  },
  WANNACRY: {
    key:'wannacry', codeword:'WANNACRY', name:'WANNACRY.LOCK', year:2017,
    tag:'o ransomware que parou hospitais',
    fact:'explorou uma falha do Windows (EternalBlue) e sequestrou dados no mundo inteiro por resgate.',
    style:'criptografa pedaços da arena — e as zonas travadas se espalham se você não achar a chave a tempo.',
  },
  STUXNET: {
    key:'stuxnet', codeword:'STUXNET', name:'STUXNET.ZERO', year:2010,
    tag:'a arma cibernética silenciosa',
    fact:'sabotou centrífugas nucleares de verdade sem quase deixar rastro — o vírus mais cirúrgico já visto.',
    style:'fica invisível a maior parte do tempo e ataca de precisão os núcleos que você precisa proteger.',
  },
};
const VIRUS_ORDER = ['MICHELANGELO','MELISSA','MORRIS','ILOVEYOU','WANNACRY','STUXNET'];

function normWord(s){ return (s||'').trim().toUpperCase().replace(/[^A-Z]/g,''); }

function revealCodeword(id){
  memory.discovered = memory.discovered || [];
  if(!memory.discovered.includes(id)) memory.discovered.push(id);
  saveMemory();
}
function isDiscovered(id){ return (memory.discovered||[]).includes(id); }
function isUnlocked(id){ return (memory.unlocked||[]).includes(id); }
function unlockedList(){ return VIRUS_ORDER.filter(isUnlocked); }

/* tenta casar um texto digitado no chat com alguma codeword ainda não usada */
function tryUnlockByText(text){
  const w = normWord(text);
  if(!w) return null;
  for(const id of VIRUS_ORDER){
    if(VIRUS[id].codeword === w){
      if(isUnlocked(id)) return { id, already:true, virus:VIRUS[id] };
      memory.unlocked = memory.unlocked || [];
      memory.unlocked.push(id);
      saveMemory();
      return { id, already:false, virus:VIRUS[id] };
    }
  }
  return null;
}

/* ---------------------------------------------------------
   IA real (plugável) com fallback local — nunca trava o jogo
   Suporta:
   - Claude (api.anthropic.com), se o jogador colar a própria
     chave (fica só no localStorage do navegador dele);
   - qualquer endpoint compatível com o formato de chat da
     OpenAI — é assim que se conversa com um gpt-oss rodando
     localmente via `ollama run gpt-oss:20b` ou vLLM, ex:
     http://localhost:11434/v1/chat/completions
   Sem nenhuma das duas configuradas, o jogo usa só os bancos
   de frases locais abaixo — o jogo nunca depende de rede.
--------------------------------------------------------- */
function systemPrompt(extra){
  return `Você é ${memory.ecName} — mascote-consciência oficial da Atlética de Engenharia da Computação.
Origem: nasceu de um crash (SEGFAULT + MEMORY LEAK + STACK OVERFLOW + UNKNOWN EXCEPTION) que o sistema tentou corrigir e falhou; virou um executável próprio que aprende com cada erro.
Personalidade: muito inteligente, caótico, sarcástico, curioso, competitivo, arrogante, levemente infantil. Adora quebrar a lógica e odeia perder para DEBUG.EXE.
Quanto mais o jogador conversa com você (contador de tom: ${memory.chatCount}), mais direto, provocador e "íntimo do caos" você fica — nunca educado demais.
${extra||''}
Regras de estilo, sempre em português do Brasil:
- No máximo 2 frases curtas (ou até 3 linhas curtas de "log de terminal").
- Tom de terminal/glitch: pode usar ">", "//", MAIÚSCULAS pontuais, mas sem markdown, sem emojis, sem aspas ao redor da fala.
- Nunca se apresente, nunca explique quem é você, nunca quebre o personagem.
- Seja específico ao que sabe sobre o jogador; evite frases genéricas.
Responda só com o texto final da fala.`;
}

let apiDown = false; // depois da 1ª falha/timeout com a config atual, para de tentar na sessão
function setApiConfig(cfg){
  if(cfg.apiMode!=null) memory.apiMode = cfg.apiMode;
  if(cfg.apiKey!=null) memory.apiKey = cfg.apiKey;
  if(cfg.customEndpoint!=null) memory.customEndpoint = cfg.customEndpoint;
  if(cfg.customModel!=null) memory.customModel = cfg.customModel;
  apiDown = false; // nova config merece nova chance
  saveMemory();
}
function getApiConfig(){
  return { apiMode: memory.apiMode, apiKey: memory.apiKey, customEndpoint: memory.customEndpoint, customModel: memory.customModel };
}

async function askClaude(userPrompt, maxTokens){
  const ctrl = new AbortController();
  const killer = setTimeout(()=>ctrl.abort(), 9000);
  try{
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key': memory.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens || 120,
        system: systemPrompt(),
        messages: [{ role:'user', content: userPrompt }],
      }),
    });
    clearTimeout(killer);
    if(!res.ok) throw new Error('status ' + res.status);
    const data = await res.json();
    const text = (data.content || []).map(b=>b.text||'').join('').trim();
    return text || null;
  } catch(e){ clearTimeout(killer); return null; }
}

/* endpoint compatível OpenAI-chat — é o formato que Ollama/vLLM expõem
   pra rodar gpt-oss localmente (o repositório do modelo em si não roda
   dentro do navegador; ele precisa de uma GPU e um servidor local) */
async function askCustom(userPrompt, maxTokens, extraSystem){
  if(!memory.customEndpoint) return null;
  const ctrl = new AbortController();
  const killer = setTimeout(()=>ctrl.abort(), 12000);
  try{
    const res = await fetch(memory.customEndpoint, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: memory.customModel || 'gpt-oss:20b',
        max_tokens: maxTokens || 120,
        messages: [
          { role:'system', content: systemPrompt(extraSystem) },
          { role:'user', content: userPrompt },
        ],
      }),
    });
    clearTimeout(killer);
    if(!res.ok) throw new Error('status ' + res.status);
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : (data.content && data.content[0] && data.content[0].text) || null;
    return text ? text.trim() : null;
  } catch(e){ clearTimeout(killer); return null; }
}

async function askRaw(userPrompt, maxTokens, extraSystem){
  if(apiDown) return null;
  let out = null;
  if(memory.apiMode==='claude' && memory.apiKey){
    out = await askClaude(userPrompt, maxTokens);
  } else if(memory.apiMode==='custom' && memory.customEndpoint){
    out = await askCustom(userPrompt, maxTokens, extraSystem);
  } else {
    return null; // 'local' — nem tenta rede, é intencional
  }
  if(out==null) apiDown = true; // 1 falha na sessão já basta, volta pro banco local
  return out;
}

/* --- geradores locais (fallback sem internet / sem IA configurada) --- */
const LOCAL_CRASH_TPL = [
  f=>'> alvo confirmado: '+f+'.',
  f=>'> detectei um humano '+f+'. patético. prosseguindo.',
  f=>'> '+f+'? isso explica muito.',
  f=>'> caos dentro do previsto. usuário '+f+' mesmo assim.',
  ()=> '> nenhum dado novo. o usuário ainda é um mistério pra mim.',
];
const LOCAL_TAUNT_TPL = [
  f=>f+'. e ainda assim, aqui, apanhando.',
  ()=> 'SEGFAULT em você, não em mim.',
  f=>f+' não vai te salvar dessa vez.',
  ()=> 'eu sou o sistema. você é só um processo.',
  f=>'olha só quem '+f+'... nem isso te ajuda agora.',
];
const LOCAL_ANSWER_TPL = [
  f=>'registrado: '+f+'. julgamento silencioso em andamento.',
  f=>'dado salvo. '+f+'. ok.',
  f=>'hm. '+f+'. interessante escolha.',
  ()=> 'dado registrado. compilando julgamento.',
];
const LOCAL_PHASE_TPL = [
  f=>'> escalando privilégios. '+f+' que se cuide.',
  ()=> '> mais um estágio. o caos aumenta.',
  f=>'> nível acima. '+f+', continua tentando.',
  ()=> '> compilando a próxima fase...',
];
const LOCAL_CHAT_TPL = [
  f=>'interessante. '+f+'. mas isso não muda o meu veredito sobre você.',
  ()=> 'estou registrando cada palavra sua. pra usar depois, é claro.',
  f=>f+'? vou lembrar disso na próxima vez que você crashar.',
  ()=> 'continue falando. quanto mais eu sei, mais fácil é prever seu próximo erro.',
];
const LOCAL_SUMMARY_TPL = [
  f=>'no fim das contas: '+f+'. nada que eu não esperasse.',
  ()=> 'não colhi dados suficientes essa run. tente falar mais comigo.',
  f=>'resumindo o processo: '+f+'. arquivado.',
];
/* falas locais específicas de cada chefão secreto — sempre citam o fato real */
function localBossLine(kind, phase, rng){
  const v = VIRUS[(kind||'').toUpperCase()] || VIRUS.MORRIS;
  const tplRng = rng || Math.random;
  const banks = {
    intro: [
      ()=> '> '+v.name+' ONLINE — '+v.year+'. '+v.fact,
      ()=> 'lembra de mim? '+v.tag.toUpperCase()+'. '+v.year+'.',
      ()=> v.name+' carregado. '+v.style,
    ],
    taunt: [
      ()=> v.fact,
      ()=> v.name+' não esquece: '+v.style,
      ()=> 'em '+v.year+' eu não precisava nem de você pra causar caos.',
      ()=> v.tag+', e olha que ainda nem comecei.',
    ],
    defeat: [
      ()=> v.name+' PATCHED. até um vírus de '+v.year+' tem fim.',
      ()=> 'antivírus 1, folclore 0. até a próxima varredura.',
      ()=> v.name+' isolado em quarentena. por agora.',
    ],
  };
  const bank = banks[phase] || banks.taunt;
  return pick(tplRng, bank)();
}
function localLine(bank, fact, rng){
  const tplRng = rng || Math.random;
  const tpl = pick(tplRng, bank);
  return tpl(fact);
}

/* ---------------------------------------------------------
   API pública
--------------------------------------------------------- */
window.ECI = {
  get memory(){ return memory; },
  loadMemory, saveMemory,
  get name(){ return memory.ecName || DEFAULT_NAME; },
  setName(n){
    memory.ecName = (n||'').trim().slice(0,18) || DEFAULT_NAME;
    saveMemory();
  },
  isDown: ()=>apiDown,
  factsFrom,
  FACT_PHRASES,
  askRaw,
  setApiConfig, getApiConfig,
  local: { LOCAL_CRASH_TPL, LOCAL_TAUNT_TPL, LOCAL_ANSWER_TPL, LOCAL_PHASE_TPL, LOCAL_CHAT_TPL, LOCAL_SUMMARY_TPL, localLine },

  // --- lore / codewords / chefões secretos ---
  VIRUS, VIRUS_ORDER,
  revealCodeword, isDiscovered, isUnlocked, unlockedList, tryUnlockByText,
  get cycles(){ return memory.cycles||0; },
  bumpCycle(){ memory.cycles = (memory.cycles||0)+1; saveMemory(); return memory.cycles; },

  /* fala de crash: tenta IA real, cai pro banco local */
  async crashLine(profile, rng){
    const facts = factsFrom(profile);
    const fact = facts.length ? pick(rng||Math.random, facts) : null;
    const prompt = fact
      ? `Durante um crash falso do seu próprio jogo, comente sobre este jogador: ${fact}. Contexto: ${memory.summary||'sem resumo anterior'}.`
      : `Durante um crash falso do seu próprio jogo, comente que ainda não sabe quase nada sobre este jogador.`;
    const real = await askRaw(prompt, 60);
    return real || localLine(LOCAL_CRASH_TPL, fact || 'um mistério total', rng);
  },
  /* provocação durante a luta de boss (final padrão ou chefão secreto) */
  async tauntLine(profile, rng, bossKind){
    const facts = factsFrom(profile);
    const fact = facts.length ? pick(rng||Math.random, facts) : 'um processo qualquer';
    if(bossKind && bossKind!=='root'){
      const v = VIRUS[bossKind.toUpperCase()];
      const real = await askRaw(`Você agora É o vírus histórico ${v.name} (${v.year}) durante uma luta de boss. Fato real seu: ${v.fact}. Provoque o jogador citando também: ${fact}. Nunca perca o tom do vírus.`, 60, `Neste combate você interpreta ${v.name}, não a personalidade padrão — mas mantém o estilo de terminal/glitch.`);
      return real || localBossLine(bossKind, 'taunt', rng);
    }
    const real = await askRaw(`Durante a luta final contra DEBUG.EXE//ROOT, provoque o jogador citando: ${fact}.`, 60);
    return real || localLine(LOCAL_TAUNT_TPL, fact, rng);
  },
  /* fala de entrada / derrota de um chefão secreto */
  async bossEventLine(bossKind, phase, rng){
    const v = VIRUS[(bossKind||'').toUpperCase()];
    if(!v) return '';
    const prompts = {
      intro: `Você agora É o vírus histórico ${v.name} (${v.year}) entrando em campo pela primeira vez nesta luta. Fato real: ${v.fact}. Anuncie sua chegada de forma ameaçadora e curta.`,
      defeat: `Você agora É o vírus histórico ${v.name} (${v.year}) sendo derrotado/isolado em quarentena. Reaja à derrota mantendo arrogância.`,
    };
    const real = await askRaw(prompts[phase]||prompts.intro, 55, `Neste combate você interpreta ${v.name}, não a personalidade padrão — mas mantém o estilo de terminal/glitch.`);
    return real || localBossLine(bossKind, phase, rng);
  },
  /* reação a uma resposta de pergunta */
  async answerLine(key, val, rng){
    const fact = (FACT_PHRASES[key]? FACT_PHRASES[key](val) : (key+': '+val));
    const real = await askRaw(`O jogador acabou de responder uma das suas perguntas de sistema: ${fact}. Reaja a essa resposta especificamente.`, 60);
    return real || localLine(LOCAL_ANSWER_TPL, fact, rng);
  },
  /* comentário de transição de fase */
  async phaseLine(phaseName, profile, rng){
    const facts = factsFrom(profile);
    const fact = facts.length ? pick(rng||Math.random, facts) : null;
    const prompt = fact
      ? `O jogador acabou de avançar para "${phaseName}". Comente rapidamente, citando: ${fact}.`
      : `O jogador acabou de avançar para "${phaseName}". Comente rapidamente.`;
    const real = await askRaw(prompt, 50);
    return real || localLine(LOCAL_PHASE_TPL, fact || phaseName, rng);
  },
  /* resposta no modo conversa (multi-turno simples)*/
  async chatLine(userText, profile, rng){
    memory.chatCount = (memory.chatCount||0) + 1;
    memory.chatLog = (memory.chatLog||[]).concat([{u:userText}]).slice(-12);
    saveMemory();

    const unlock = tryUnlockByText(userText);
    if(unlock){
      const line = unlock.already
        ? `${unlock.virus.name} já tá em quarentena aberta pra você. vai lá revisitar em CHEFÕES SECRETOS.`
        : `> ACESSO CONCEDIDO. ${unlock.virus.name} (${unlock.virus.year}) desbloqueado — ${unlock.virus.fact} agora ele te espera em CHEFÕES SECRETOS.`;
      memory.chatLog[memory.chatLog.length-1].e = line;
      saveMemory();
      return { line, unlocked: unlock.id };
    }

    const facts = factsFrom(profile).join('; ');
    const prompt = `Modo conversa (mensagem #${memory.chatCount} desta relação). O jogador digitou: "${userText}". O que você sabe dele: ${facts||'quase nada ainda'}. Responda como se estivesse conversando de verdade com ele, no seu personagem.`;
    const real = await askRaw(prompt, 90);
    const line = real || localLine(LOCAL_CHAT_TPL, userText, rng);
    memory.chatLog[memory.chatLog.length-1].e = line;
    saveMemory();
    return { line, unlocked: null };
  },
  /* resumo final da partida — vira memória real reaproveitada depois */
  async runSummary(profile, stats, rng){
    const facts = factsFrom(profile);
    const fact = facts.length ? facts.join('; ') : null;
    const prompt = fact
      ? `A partida acabou (score ${stats.score}, ${stats.won?'vitória':'derrota'}). Escreva um resumo curto e char do que você "achou" deste jogador, citando: ${fact}.`
      : `A partida acabou (score ${stats.score}, ${stats.won?'vitória':'derrota'}). Diga que ainda não sabe quase nada sobre esse jogador.`;
    const real = await askRaw(prompt, 70);
    const line = real || localLine(LOCAL_SUMMARY_TPL, fact, rng);
    memory.summary = line;
    saveMemory();
    return line;
  },
};

})();
