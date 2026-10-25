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
const resultPanel = $("#resultPanel");
let roundDone = false;

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

/* Exactly 20 unique tasks per round */
function uniqueTasks(pairs){const seen=new Set(),out=[];for(const [a,b] of pairs){const k=`${a}x${b}`;if(!seen.has(k)){seen.add(k);out.push(coreTask(a,b));}}return shuffle(out).slice(0,20);}
function buildLevel1(){const p=[];for(const a of [1,2,5,10])for(const b of [3,4,6,7,8])p.push([a,b]);return uniqueTasks(p);}
function buildLevel2(){const p=[];for(const a of [1,2,5,10])for(const b of [3,4,6,7,8])p.push([a,b],[b,a]);return uniqueTasks(p);}
function buildTableLevel(n){const p=[];for(let b=1;b<=10;b++)p.push([n,b],[b,n]);return uniqueTasks(p);}
function buildLevel9HardMixed(){const p=[];for(const a of [3,4,6,7,8,9])for(let b=2;b<=10;b++)p.push([a,b],[b,a]);return uniqueTasks(p);}
function buildQueueForLevel(){if(currentLevel===1)return buildLevel1();if(currentLevel===2)return buildLevel2();if(currentLevel===3)return buildTableLevel(3);if(currentLevel===4)return buildTableLevel(4);if(currentLevel===5)return buildTableLevel(6);if(currentLevel===6)return buildTableLevel(8);if(currentLevel===7)return buildTableLevel(7);if(currentLevel===8)return buildTableLevel(9);return buildLevel9HardMixed();}
function rebuildQueue(){idx=0;levelSolved=0;levelWrong=0;pendingRetries=[];queue=buildQueueForLevel();levelTotal=20;roundDone=false;if(resultPanel)resultPanel.hidden=true;}
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
function nextTask(){
  const myRun = bumpRun();
  clearCheckTimer();

  clearAnswerStyles();
  hideLabels();
  hideRedFrame();

  // fällige Retries vor dem Anzeigen einschieben
  applyRetriesDue();

  if(idx >= 20){
    roundDone=true; taskText.textContent="Fertig!"; answerInput.value="";
    answerInput.disabled=true; $("#keypad").style.display="none";
    resultPanel.hidden=false; resultPanel.textContent=`${levelSolved} von 20 richtig · ${levelWrong} falsch`;
    return;
  }
  answerInput.disabled=false; $("#keypad").style.display="grid";

    const t = queue[idx];
  renderTask(t);

  answerInput.value = "";
  answerInput.focus();

  // jetzt zählen wir „diese Aufgabe wurde gezeigt“ für Retry-Delay
  tickRetriesAfterShowingTask();

  animateTask(t, myRun);
}

/* ===== Check logic ===== */
function scheduleCheck(){
  clearCheckTimer();

  const myRun = bumpRun();

  checkTimer = setTimeout(async ()=>{
    if(!isRun(myRun)) return;

    const t = queue[idx];
    const raw = answerInput.value.trim();
    if(raw === "") return;

    const got = Number(raw);
    const exp = expectedResult(t);

    if(Number.isFinite(got) && got === exp){
      okCount++;
      okCountEl.textContent = String(okCount);
      answerInput.classList.add("ok");

      levelSolved++;
      idx++;

      await sleep(350);
      if(!isRun(myRun)) return;
      nextTask();
      return;
    }

    badCount++; badCountEl.textContent=String(badCount); levelWrong++;
    answerInput.classList.add("bad");
    await sleep(700); if(!isRun(myRun)) return;
    answerInput.value="";
    const myRun2=bumpRun();
    await helpAnimationWithLabels(t,myRun2);
    await sleep(500); if(!isRun(myRun2)) return;
    hideLabels(); answerInput.classList.remove("bad");
    idx++; nextTask();
  }, 250);
}

/* ===== UI ===== */
function bindUI(){
  // Speech unlock bei erster Interaktion
  const unlock = () => unlockSpeechOnce();
  document.addEventListener("pointerdown", unlock, { once:true });
  document.addEventListener("keydown", unlock, { once:true });

  $$(".lvlBtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      currentLevel = +btn.dataset.level;
      setLevelActiveButton();
      rebuildQueue();
      answerInput.disabled = false;
      nextTask();
    });
  });

  $("#nextBtn").addEventListener("click", ()=>{
    idx = Math.min(idx + 1, queue.length);
    nextTask();
  });

  $("#resetBtn").addEventListener("click", ()=>{
    okCount = 0; badCount = 0;
    okCountEl.textContent = "0";
    badCountEl.textContent = "0";
    rebuildQueue();
    answerInput.disabled = false;
    nextTask();
  });

  $$(".keyBtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const key=btn.dataset.key;
      if(key==="enter"){scheduleCheck();return;}
      if(key==="clear") answerInput.value=answerInput.value.slice(0,-1);
      else answerInput.value+=key;
      answerInput.dispatchEvent(new Event("input",{bubbles:true}));
    });
  });
  answerInput.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();scheduleCheck();}});
  answerInput.addEventListener("input", ()=>{
    const cleaned = answerInput.value.replace(/[^\d]/g, "");
    if(cleaned !== answerInput.value) answerInput.value = cleaned;
    scheduleCheck();
  });
}

/* ===== Init ===== */
function init(){
  buildPointsField();
  rebuildQueue();
  bindUI();
  nextTask();
}

init();