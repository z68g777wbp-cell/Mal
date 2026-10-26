const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const pointsField = $("#pointsField");
const pointsWrap  = $("#pointsWrap");
const redFrame    = $("#redFrame");
const labelA      = $("#labelA");
const labelB      = $("#labelB");

const taskText = $("#taskText");
const answerInput = $("#answerInput");

const okCountEl = $("#okCount");
const badCountEl = $("#badCount");

let okCount = 0;
let badCount = 0;

let currentLevel = 1;
let queue = [];
let idx = 0;

// Level-Run
let levelSolved = 0;
let levelWrong = 0;
let levelTotal = 0;

// Retry: falsch gelöste Aufgaben sollen nach 2 weiteren Aufgaben wieder auftauchen
let pendingRetries = []; // { task, remaining }

// Timer / Token (verhindert „Hilfe für falsche Aufgabe“)
let checkTimer = null;
let runId = 0;
function bumpRun(){ runId++; return runId; }
function isRun(activeId){ return activeId === runId; }
function clearCheckTimer(){
  if(checkTimer){ clearTimeout(checkTimer); checkTimer = null; }
}

/* ===== Speech Unlock (Browser braucht User-Geste) ===== */
let speechUnlocked = false;
let speechVoicesReady = false;

function prepareVoices(){
  try{
    const v = speechSynthesis.getVoices();
    if(v && v.length) speechVoicesReady = true;
  }catch(e){}
}

function unlockSpeechOnce(){
  if(speechUnlocked) return;
  speechUnlocked = true;

  try{
    // Stimmen laden
    prepareVoices();
    speechSynthesis.onvoiceschanged = () => prepareVoices();

    // Mini-Utterance direkt auf User-Geste (wird von Browsern als „erlaubt“ gewertet)
    const u = new SpeechSynthesisUtterance(" ");
    u.lang = "de-DE";
    u.volume = 0.0;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }catch(e){}
}

function speak(word){
  try{
    if(!("speechSynthesis" in window)) return;
    if(!speechUnlocked) return; // erst nach User-Geste sprechen
    speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(word);
    u.lang = "de-DE";
    u.rate = 0.95;

    // wenn möglich deutsche Stimme wählen
    const voices = speechSynthesis.getVoices();
    const deVoice = voices.find(v => (v.lang || "").toLowerCase().startsWith("de"));
    if(deVoice) u.voice = deVoice;

    speechSynthesis.speak(u);
  }catch(e){}
}

/* =========================
   Hunderterfeld: 4 Blöcke à 5x5
   ========================= */
function buildPointsField(){
  pointsField.innerHTML = "";

  const quads = [];
  for(let i=0;i<4;i++){
    const q = document.createElement("div");
    q.className = "quad";
    quads.push(q);
    pointsField.appendChild(q);
  }

  for(let r=1; r<=10; r++){
    for(let c=1; c<=10; c++){
      const d = document.createElement("div");
      d.className = "dot dimmed";
      d.dataset.r = r;
      d.dataset.c = c;

      const top = r <= 5;
      const left = c <= 5;
      const quadIndex =
        top && left  ? 0 :
        top && !left ? 1 :
        !top && left ? 2 : 3;

      quads[quadIndex].appendChild(d);
    }
  }
}

function setVisibleRect(rows, cols){
  const dots = $$(".dot");
  for(const d of dots){
    const r = +d.dataset.r;
    const c = +d.dataset.c;
    const visible = (r <= rows && c <= cols);
    d.classList.toggle("visible", visible);
    d.classList.toggle("dimmed", !visible);
  }
}

/* ===== Pixel-Rect helpers (mit colStart) ===== */
function getDotRect(r, c){
  const stageRect = pointsWrap.getBoundingClientRect();
  const dot = pointsField.querySelector(`.dot[data-r="${r}"][data-c="${c}"]`);
  const dr = dot.getBoundingClientRect();
  return {
    left: dr.left - stageRect.left,
    top: dr.top - stageRect.top,
    right: dr.right - stageRect.left,
    bottom: dr.bottom - stageRect.top,
  };
}

function getRectPx(rowStart, rowCount, colStart, colCount){
  const start = getDotRect(rowStart, colStart);
  const end   = getDotRect(rowStart + rowCount - 1, colStart + colCount - 1);

  const left = start.left - 10;
  const top  = start.top - 10;
  const width  = (end.right - start.left) + 20;
  const height = (end.bottom - start.top) + 20;

  return { left, top, width, height };
}

function showRedFrame(rowStart, rowCount, colStart, colCount){
  const r = getRectPx(rowStart, rowCount, colStart, colCount);
  redFrame.style.left = r.left + "px";
  redFrame.style.top  = r.top + "px";
  redFrame.style.width  = r.width + "px";
  redFrame.style.height = r.height + "px";
  redFrame.style.opacity = "1";
}
function hideRedFrame(){ redFrame.style.opacity = "0"; }

function hideLabels(){
  labelA.style.opacity = "0";
  labelB.style.opacity = "0";
}
function placeLabel(el, rowStart, rowCount, colStart, colCount, text){
  const r = getRectPx(rowStart, rowCount, colStart, colCount);
  el.textContent = text;
  el.style.left = (r.left + r.width/2) + "px";
  el.style.top  = (r.top  + r.height/2) + "px";
  el.style.opacity = "1";
}

/* ===== Aufgabenmodell ===== */
function coreTask(a,b){ return { a, b, kind:"core", strategy:{type:"core"} }; }
function swapTask(a,b){ return { a:b, b:a, kind:"swap", strategy:{type:"core"} }; }
function derivedTask(mult, rowLen, mode){ return { a: mult, b: rowLen, kind:"derived", strategy: mode }; }

function shuffle(arr){
  for(let i=arr.length-1; i>0; i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* Level 1: fix */
function buildLevel1(){
  const rows = [3,4,6,8,7];
  const seq = [1,2,10,5];
  const out = [];
  for(const b of rows){
    for(const a of seq) out.push(coreTask(a,b));
  }
  return out;
}

/* Level 2..8 wie gehabt */
function buildLevel2(){
  const rows = [3,4,6,7,8];
  const core = [1,2,5,10];
  const out = [];
  for(const b of rows){
    for(const a of core){
      out.push(coreTask(a,b));
      out.push(swapTask(a,b));
    }
  }
  return shuffle(out);
}

function buildDerivedLevels(){
  const rowByLevel = { 3:3, 4:4, 5:6, 6:8, 7:7 };
  const b = rowByLevel[currentLevel];

  const specs = [
    { m:3, modes:[ {type:"plus", p1:2, p2:1}, {type:"minus", axis:"rows", base:5, sub:2} ]},
    { m:4, modes:[ {type:"plus", p1:2, p2:2}, {type:"minus", axis:"rows", base:5, sub:1} ]},
    { m:6, modes:[ {type:"plus", p1:5, p2:1} ]},
    { m:7, modes:[ {type:"plus", p1:5, p2:2} ]},
    { m:8, modes:[ {type:"minus", axis:"rows", base:10, sub:2} ]},
    { m:9, modes:[ {type:"minus", axis:"rows", base:10, sub:1} ]},
  ];

  const out = specs.map(s => {
    const mode = s.modes[Math.floor(Math.random()*s.modes.length)];
    return derivedTask(s.m, b, mode);
  });

  return shuffle(out);
}

/* Level 8: Neuner (korrekt) */
function buildNinesLevel(){
  const others = [3,4,6,7,8];
  const out = [];
  for(const n of others){
    out.push({ a:9, b:n, kind:"derived", strategy:{ type:"minus", axis:"rows", base:10, sub:1, nine:true } }); // 9·n = 10·n - 1·n
    out.push({ a:n, b:9, kind:"derived", strategy:{ type:"minus", axis:"cols", base:10, sub:1, nine:true } }); // n·9 = n·10 - n·1
  }
  return shuffle(out);
}

/* ✅ Level 9: NUR schwere Aufgaben (keine Kernaufgaben) */
function buildLevel9HardMixed(){
  const rows = [3,4,6,7,8];
  const heavyMultipliers = [3,4,6,7,8,9]; // keine 1/2/5/10
  const out = [];

  const modeFor = (m) => {
    if(m === 3) return (Math.random() < 0.5)
      ? {type:"plus", p1:2, p2:1}
      : {type:"minus", axis:"rows", base:5, sub:2};

    if(m === 4) return (Math.random() < 0.5)
      ? {type:"plus", p1:2, p2:2}
      : {type:"minus", axis:"rows", base:5, sub:1};

    if(m === 6) return {type:"plus", p1:5, p2:1};
    if(m === 7) return {type:"plus", p1:5, p2:2};
    if(m === 8) return {type:"minus", axis:"rows", base:10, sub:2};
    if(m === 9) return {type:"minus", axis:"rows", base:10, sub:1};

    return {type:"core"};
  };

  // Aufgaben m·Reihe (z.B. 3·7, 8·6, 9·4 …)
  for(const b of rows){
    for(const m of heavyMultipliers){
      out.push(derivedTask(m, b, modeFor(m)));
    }
  }

  // zusätzlich: Neuner-Umkehr (b·9) als schwere Form
  for(const b of rows){
    out.push({ a:b, b:9, kind:"derived", strategy:{ type:"minus", axis:"cols", base:10, sub:1, nine:true } });
  }

  return shuffle(out);
}

/* ===== Queue: genau 20 unterschiedliche Aufgaben pro Durchgang ===== */
function strategyForTask(a, b, level){
  // Umgekehrte Aufgaben werden als Rechteck dargestellt; die passende
  // Strategie wird nur verwendet, wenn der Strategie-Faktor links steht.
  const target = ({3:3,4:4,5:6,6:8,7:7,8:9})[level];
  if(level === 1 || level === 2 || [1,2,5,10].includes(a) || [1,2,5,10].includes(b) || (target && a !== target))
    return {a,b,kind:"core",strategy:{type:"core"}};
  if(a === 3) return {a,b,kind:"derived",strategy:(Math.random()<0.5 ? {type:"plus",p1:2,p2:1} : {type:"minus",axis:"rows",base:5,sub:2})};
  if(a === 4) return {a,b,kind:"derived",strategy:(Math.random()<0.5 ? {type:"plus",p1:2,p2:2} : {type:"minus",axis:"rows",base:5,sub:1})};
  if(a === 6) return {a,b,kind:"derived",strategy:{type:"plus",p1:5,p2:1}};
  if(a === 7) return {a,b,kind:"derived",strategy:{type:"plus",p1:5,p2:2}};
  if(a === 8) return {a,b,kind:"derived",strategy:{type:"minus",axis:"rows",base:10,sub:2}};
  if(a === 9) return {a,b,kind:"derived",strategy:{type:"minus",axis:"rows",base:10,sub:1,nine:true}};
  return {a,b,kind:"core",strategy:{type:"core"}};
}
function uniqueTasks(list){
  const seen = new Set();
  return list.filter(t => { const k = `${t.a}x${t.b}`; if(seen.has(k)) return false; seen.add(k); return true; });
}
function buildRoundTasks(){
  let all=[];
  if(currentLevel === 1){
    const rows=[3,4,6,8,7], factors=[1,2,10,5];
    for(const b of rows) for(const a of factors) all.push(coreTask(a,b));
  } else if(currentLevel === 2){
    // Kern-Mix: gemischte Kernaufgaben, ohne doppelte Rechnung.
    for(let a=1;a<=10;a++) for(let b=1;b<=10;b++) if([1,2,5,10].includes(a)||[1,2,5,10].includes(b)) all.push(coreTask(a,b));
  } else if(currentLevel >= 3 && currentLevel <= 8){
    const target=({3:3,4:4,5:6,6:8,7:7,8:9})[currentLevel];
    for(let n=1;n<=10;n++){
      all.push(strategyForTask(target,n,currentLevel));
      if(n!==target) all.push(strategyForTask(n,target,currentLevel));
    }
    // Eine Nullaufgabe ergänzt die Tabelle auf 20 unterschiedliche Rechnungen.
    all.push(coreTask(0,target));
  } else {
    // Mal-Mix: breite Mischung aus Kern- und schwierigeren Malaufgaben.
    for(let a=1;a<=10;a++) for(let b=1;b<=10;b++) all.push(strategyForTask(a,b,9));
  }
  all=uniqueTasks(all);
  shuffle(all);
  // Genau 20 Aufgaben. Bei einem kleineren Pool wird mit weiteren, noch nicht
  // verwendeten Aufgaben aus dem Einmaleins aufgefüllt.
  if(all.length<20){
    const used=new Set(all.map(t=>`${t.a}x${t.b}`));
    const extras=[];
    for(let a=0;a<=10;a++) for(let b=1;b<=10;b++) if(!used.has(`${a}x${b}`)) extras.push(strategyForTask(a,b,currentLevel));
    shuffle(extras); all.push(...extras.slice(0,20-all.length));
  }
  return all.slice(0,20);
}
function rebuildQueue(){
  idx=0; levelSolved=0; levelWrong=0; pendingRetries=[];
  queue=buildRoundTasks();
  levelTotal=20;
}

function formatTask(a,b){ return `${a} · ${b}`; }
function renderTask(t){ taskText.textContent = formatTask(t.a, t.b); }
function expectedResult(t){ return t.a * t.b; }

function clearAnswerStyles(){
  answerInput.classList.remove("ok","bad");
}
function setLevelActiveButton(){
  $$(".lvlBtn").forEach(b => b.classList.toggle("active", +b.dataset.level === currentLevel));
}

/* ===== Animation timings ===== */
const T = { start: 320, step: 1200, frame: 950, after: 900 };

async function animateTask(t, myRun){
  hideRedFrame();
  hideLabels();

  setVisibleRect(0,0);
  await sleep(T.start);
  if(!isRun(myRun)) return;

  if(t.strategy.type === "core"){
    setVisibleRect(t.a, t.b);
    await sleep(T.after);
    return;
  }

  if(t.strategy.type === "plus"){
    setVisibleRect(t.strategy.p1, t.b);
    await sleep(T.step);
    if(!isRun(myRun)) return;

    showRedFrame(1, t.strategy.p1, 1, t.b);
    await sleep(T.frame);
    if(!isRun(myRun)) return;

    hideRedFrame();
    setVisibleRect(t.strategy.p1 + t.strategy.p2, t.b);
    await sleep(T.after);
    return;
  }

  if(t.strategy.type === "minus"){
    const axis = t.strategy.axis || "rows";
    const base = t.strategy.base;
    const sub  = t.strategy.sub;

    if(axis === "rows"){
      setVisibleRect(base, t.b);
      await sleep(T.step);
      if(!isRun(myRun)) return;

      const subStartRow = base - sub + 1;
      showRedFrame(subStartRow, sub, 1, t.b);
      await sleep(T.frame);
      if(!isRun(myRun)) return;

      hideRedFrame();
      setVisibleRect(base - sub, t.b);
      await sleep(T.after);
      return;
    }

    // axis === "cols"
    setVisibleRect(t.a, base);
    await sleep(T.step);
    if(!isRun(myRun)) return;

    const subStartCol = base - sub + 1;
    showRedFrame(1, t.a, subStartCol, sub);
    await sleep(T.frame);
    if(!isRun(myRun)) return;

    hideRedFrame();
    setVisibleRect(t.a, base - sub);
    await sleep(T.after);
    return;
  }
}

/* Hilfe mit Labels (Level 2–9) */
async function helpAnimationWithLabels(t, myRun){
  hideRedFrame();
  hideLabels();

  setVisibleRect(0,0);
  await sleep(T.start);
  if(!isRun(myRun)) return;

  if(t.strategy.type === "core"){
    setVisibleRect(t.a, t.b);
    placeLabel(labelA, 1, t.a, 1, t.b, String(t.a * t.b));
    labelB.style.opacity = "0";
    await sleep(T.after);
    return;
  }

  if(t.strategy.type === "plus"){
    const p1 = t.strategy.p1;
    const p2 = t.strategy.p2;

    setVisibleRect(p1, t.b);
    placeLabel(labelA, 1, p1, 1, t.b, String(p1 * t.b));
    labelB.style.opacity = "0";
    await sleep(T.step);
    if(!isRun(myRun)) return;

    showRedFrame(1, p1, 1, t.b);
    await sleep(T.frame);
    if(!isRun(myRun)) return;

    hideRedFrame();
    setVisibleRect(p1 + p2, t.b);
    placeLabel(labelB, p1 + 1, p2, 1, t.b, String(p2 * t.b));
    await sleep(T.after);
    return;
  }

  if(t.strategy.type === "minus"){
    const axis = t.strategy.axis || "rows";
    const base = t.strategy.base;
    const sub  = t.strategy.sub;

    if(axis === "rows"){
      setVisibleRect(base, t.b);
      placeLabel(labelA, 1, base, 1, t.b, String(base * t.b));
      labelB.style.opacity = "0";
      await sleep(T.step);
      if(!isRun(myRun)) return;

      const subStartRow = base - sub + 1;
      showRedFrame(subStartRow, sub, 1, t.b);
      placeLabel(labelB, subStartRow, sub, 1, t.b, "−" + String(sub * t.b));
      await sleep(T.frame);
      if(!isRun(myRun)) return;

      hideRedFrame();
      setVisibleRect(base - sub, t.b);
      await sleep(T.after);
      return;
    }

    // axis === "cols"
    setVisibleRect(t.a, base);
    placeLabel(labelA, 1, t.a, 1, base, String(t.a * base));
    labelB.style.opacity = "0";
    await sleep(T.step);
    if(!isRun(myRun)) return;

    const subStartCol = base - sub + 1;
    showRedFrame(1, t.a, subStartCol, sub);
    placeLabel(labelB, 1, t.a, subStartCol, sub, "−" + String(t.a * sub));
    await sleep(T.frame);
    if(!isRun(myRun)) return;

    hideRedFrame();
    setVisibleRect(t.a, base - sub);
    await sleep(T.after);
    return;
  }
}

/* Level 1 Coaching-only bei Fehler (2x/5x) */
async function level1WrongCoaching(t, myRun){
  if(currentLevel !== 1) return false;
  if(t.strategy.type !== "core") return false;
  if(!(t.a === 2 || t.a === 5)) return false;

  hideRedFrame();
  hideLabels();

  if(t.a === 2){
    setVisibleRect(1, t.b);
    await sleep(950);
    if(!isRun(myRun)) return true;
    speak("verdoppeln");
    await sleep(900);
    if(!isRun(myRun)) return true;
    setVisibleRect(2, t.b);
    await sleep(1100);
    return true;
  }

  if(t.a === 5){
    setVisibleRect(10, t.b);
    await sleep(950);
    if(!isRun(myRun)) return true;
    speak("halbieren");
    await sleep(950);
    if(!isRun(myRun)) return true;
    setVisibleRect(5, t.b);
    await sleep(1100);
    return true;
  }

  return false;
}

/* ===== Retry handling: nach 2 Aufgaben wieder einfügen ===== */
function applyRetriesDue(){
  // alle fälligen (remaining <= 0) werden an aktueller Position eingeschoben
  const due = pendingRetries.filter(x => x.remaining <= 0);
  if(!due.length) return;

  // rausfiltern
  pendingRetries = pendingRetries.filter(x => x.remaining > 0);

  // in stabiler Reihenfolge einfügen
  for(const d of due){
    queue.splice(idx, 0, d.task);
  }
  levelTotal = queue.length;
}

function tickRetriesAfterShowingTask(){
  // nach jeder "gezeigten" Aufgabe wird remaining-- (damit nach 2 weiteren Aufgaben wieder kommt)
  for(const p of pendingRetries){
    p.remaining -= 1;
  }
}

/* ===== Task / Level flow ===== */
let roundFinished = false;
function finishRound(){
  roundFinished=true;
  clearCheckTimer();
  clearAnswerStyles();
  hideLabels(); hideRedFrame(); setVisibleRect(0,0);
  taskText.textContent=`Fertig! ${okCount} richtig`;
  answerInput.value="";
  answerInput.disabled=true;
  $$('.keyBtn').forEach(b=>b.disabled=true);
  $('#nextBtn').textContent='↻';
  $('#nextBtn').title='Neue Runde';
}
function nextTask(){
  const myRun=bumpRun(); clearCheckTimer(); clearAnswerStyles(); hideLabels(); hideRedFrame();
  if(roundFinished){
    roundFinished=false; okCount=0; badCount=0;
    okCountEl.textContent='0'; badCountEl.textContent='0';
    answerInput.disabled=false; $$('.keyBtn').forEach(b=>b.disabled=false);
    $('#nextBtn').textContent='▶'; $('#nextBtn').title='Nächste Aufgabe';
    rebuildQueue();
  }
  if(idx>=20){ finishRound(); return; }
  const t=queue[idx];
  if(!t){ finishRound(); return; }
  renderTask(t); answerInput.value=''; answerInput.focus();
  animateTask(t,myRun);
}
function scheduleCheck(){
  clearCheckTimer();
  const myRun=bumpRun();
  checkTimer=setTimeout(async()=>{
    if(!isRun(myRun) || roundFinished) return;
    const t=queue[idx]; if(!t) return;
    const raw=answerInput.value.trim(); if(raw==='') return;
    const got=Number(raw), exp=expectedResult(t);
    if(Number.isFinite(got) && got===exp){
      okCount++; okCountEl.textContent=String(okCount); levelSolved++;
      answerInput.classList.add('ok'); idx++;
      await sleep(350); if(!isRun(myRun)) return; nextTask();
    }else{
      badCount++; badCountEl.textContent=String(badCount); levelWrong++;
      answerInput.classList.add('bad');
      await sleep(700); if(!isRun(myRun)) return;
      answerInput.value=''; answerInput.classList.remove('bad');
      // Zeige eine kurze Hilfsanimation, ohne die 20-Aufgaben-Grenze zu verändern.
      const helpRun=bumpRun();
      await helpAnimationWithLabels(t,helpRun);
      if(!isRun(helpRun)) return;
      hideLabels(); idx++; nextTask();
    }
  },250);
}

/* ===== UI ===== */
function bindUI(){
  const unlock=()=>unlockSpeechOnce();
  document.addEventListener('pointerdown',unlock,{once:true});
  document.addEventListener('keydown',unlock,{once:true});
  $$('.lvlBtn').forEach(btn=>btn.addEventListener('click',()=>{
    currentLevel=+btn.dataset.level; setLevelActiveButton(); roundFinished=false;
    okCount=0; badCount=0; okCountEl.textContent='0'; badCountEl.textContent='0';
    answerInput.disabled=false; $$('.keyBtn').forEach(b=>b.disabled=false);
    $('#nextBtn').textContent='▶'; $('#nextBtn').title='Nächste Aufgabe';
    rebuildQueue(); nextTask();
  }));
  $('#nextBtn').addEventListener('click',()=>{
    if(roundFinished){ nextTask(); return; }
    clearCheckTimer(); idx++; nextTask();
  });
  $('#resetBtn').addEventListener('click',()=>{
    okCount=0; badCount=0; okCountEl.textContent='0'; badCountEl.textContent='0';
    roundFinished=false; answerInput.disabled=false; $$('.keyBtn').forEach(b=>b.disabled=false);
    $('#nextBtn').textContent='▶'; $('#nextBtn').title='Nächste Aufgabe';
    rebuildQueue(); nextTask();
  });
  $$('.keyBtn').forEach(btn=>btn.addEventListener('click',()=>{
    if(answerInput.disabled || roundFinished) return;
    const v=btn.dataset.key;
    if(v==='clear') answerInput.value='';
    else if(v==='back') answerInput.value=answerInput.value.slice(0,-1);
    else answerInput.value+=v;
    answerInput.dispatchEvent(new Event('input',{bubbles:true}));
  }));
  answerInput.addEventListener('input',()=>{
    const cleaned=answerInput.value.replace(/[^\d]/g,'');
    if(cleaned!==answerInput.value) answerInput.value=cleaned;
    scheduleCheck();
  });
}
function init(){
  buildPointsField();
  // Zähler werden im Hintergrund behalten, aber nicht angezeigt.
  const counts=$('#countsWrap'); if(counts) counts.setAttribute('aria-hidden','true');
  rebuildQueue(); bindUI(); setLevelActiveButton(); nextTask();
}
init();
