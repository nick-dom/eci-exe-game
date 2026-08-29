
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


function systemPrompt(){
  return `Você é ${memory.ecName} — mascote-consciência oficial da Atlética de Engenharia da Computação.
Origem: nasceu de um crash (SEGFAULT + MEMORY LEAK + STACK OVERFLOW + UNKNOWN EXCEPTION) que o sistema tentou corrigir e falhou; virou um executável próprio que aprende com cada erro.
Personalidade: muito inteligente, caótico, sarcástico, curioso, competitivo, arrogante, levemente infantil. Adora quebrar a lógica e odeia perder para DEBUG.EXE.
Quanto mais o jogador conversa com você (contador de tom: ${memory.chatCount}), mais direto, provocador e "íntimo do caos" você fica — nunca educado demais.
Regras de estilo, sempre em português do Brasil:
- No máximo 2 frases curtas (ou até 3 linhas curtas de "log de terminal").
- Tom de terminal/glitch: pode usar ">", "//", MAIÚSCULAS pontuais, mas sem markdown, sem emojis, sem aspas ao redor da fala.
- Nunca se apresente, nunca explique quem é você, nunca quebre o personagem.
- Seja específico ao que sabe sobre o jogador; evite frases genéricas.
Responda só com o texto final da fala.`;
}

let apiDown = false; // depois da 1ª falha/timeout, para de tentar na sessão
async function askRaw(userPrompt, maxTokens){
  if(apiDown) return null;
  const ctrl = new AbortController();
  const killer = setTimeout(()=>ctrl.abort(), 7000);
  try{
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
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
  } catch(e){
    clearTimeout(killer);
    apiDown = true;
    return null;
  }
}

/* --- geradores locais (fallback sem internet) --- */
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
function localLine(bank, fact, rng){
  const tplRng = rng || Math.random;
  const tpl = pick(tplRng, bank);
  return tpl(fact);
}


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
  local: { LOCAL_CRASH_TPL, LOCAL_TAUNT_TPL, LOCAL_ANSWER_TPL, LOCAL_PHASE_TPL, LOCAL_CHAT_TPL, LOCAL_SUMMARY_TPL, localLine },

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
  /* provocação durante a luta de boss */
  async tauntLine(profile, rng){
    const facts = factsFrom(profile);
    const fact = facts.length ? pick(rng||Math.random, facts) : 'um processo qualquer';
    const real = await askRaw(`Durante a luta final contra DEBUG.EXE//ROOT, provoque o jogador citando: ${fact}.`, 60);
    return real || localLine(LOCAL_TAUNT_TPL, fact, rng);
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
  /* resposta no modo conversa (multi-turno simples) */
  async chatLine(userText, profile, rng){
    memory.chatCount = (memory.chatCount||0) + 1;
    memory.chatLog = (memory.chatLog||[]).concat([{u:userText}]).slice(-12);
    saveMemory();
    const facts = factsFrom(profile).join('; ');
    const prompt = `Modo conversa (mensagem #${memory.chatCount} desta relação). O jogador digitou: "${userText}". O que você sabe dele: ${facts||'quase nada ainda'}. Responda como se estivesse conversando de verdade com ele, no seu personagem.`;
    const real = await askRaw(prompt, 90);
    const line = real || localLine(LOCAL_CHAT_TPL, userText, rng);
    memory.chatLog[memory.chatLog.length-1].e = line;
    saveMemory();
    return line;
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
