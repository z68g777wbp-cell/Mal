// Mal-Lernspiel (DENKAVO). Grundlage: GitHub-Repo „Mal“.
// Änderungen gegenüber dem Original sind mit „DENKAVO:“ markiert.
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const gameEl      = $("#game");
const boardPanel  = $("#animArea");
const resultPanel = $("#resultPanel");
const pointsField = $("#pointsField");
const pointsWrap  = $("#pointsWrap");
const redFrame    = $("#redFrame");
const redFrame2   = $("#redFrame2"); // DENKAVO: zweiter Rahmen für die zweite Kernaufgabe
const labelA      = $("#labelA");
const labelB      = $("#labelB");

const taskText = $("#taskText");
const answerInput = $("#answerInput");
const homeBtn = $("#homeBtn");
const fullscreenBtn = $("#fullscreenBtn");

let okCount = 0;
let badCount = 0;

let currentLevel = 1;
let queue = [];
let idx = 0;

// Level-Run
let levelSolved = 0;
let levelWrong = 0;
let levelTotal = 0;
let doneTasks = 0; // erledigte Erstaufgaben (Fortschrittspunkte)
let scoredTasks = 0, sessionCorrect = 0, sessionWrong = 0, sessionStart = 0, sessionFinished = false;

// Retry: falsch gelöste Aufgaben sollen nach 2 weiteren Aufgaben wieder auftauchen
let pendingRetries = []; // { task, remaining }

// DENKAVO: Während Rückmeldung/Hilfe ist keine Eingabe möglich.
let inputLocked = false;
function setLocked(v){ inputLocked = v; answerInput.readOnly = v; }

// Timer / Token (verhindert „Hilfe für falsche Aufgabe“)
let checkTimer = null;
let resultTimer = null;
let runId = 0;
function bumpRun(){ runId++; return runId; }
function isRun(activeId){ return activeId === runId; }
function clearCheckTimer(){
  if(checkTimer){ clearTimeout(checkTimer); checkTimer = null; }
}

/* =========================
   DENKAVO: Lernplattform-Brücke
   Das Spiel sendet nur Ereignisse an die umgebende Plattform (gleicher Ursprung).
   Es enthält keine Datenbankzugänge und kennt keine Schüler-IDs. Läuft das Spiel
   eigenständig, wird nichts gesendet.
   ========================= */
const ROUND_TASKS = 20;
const pendingLearningEvents = [];
let platformBridgeReady = false, platformSessionActive = false;
let taskAttemptCount = 0, helpUsedThisTask = [], taskStartAt = 0;
window.addEventListener("message", event => {
  if(event.origin !== window.location.origin || event.source !== window.parent) return;
  if(event.data && event.data.source === "denkavo-platform" && event.data.type === "ready"){
    platformBridgeReady = true;
    while(pendingLearningEvents.length) window.parent.postMessage(pendingLearningEvents.shift(), window.location.origin);
  }
});
function emitLearning(type, payload = {}){
  try{
    if(!window.parent || window.parent === window) return;
    const event = { source: "denkavo-mal", type, ...payload };
    if(platformBridgeReady) window.parent.postMessage(event, window.location.origin);
    else pendingLearningEvents.push(event);
  }catch(e){ /* Statistik darf das Spiel nie stören. */ }
}
function addHelp(name){ if(!helpUsedThisTask.includes(name)) helpUsedThisTask.push(name); }
function taskInfo(t){ return { taskKey: `L${currentLevel}-${t.a}-${t.b}`, taskLabel: `${t.a} · ${t.b}`, expectedAnswer: String(t.a * t.b) }; }
function startPlatformSession(){
  endPlatformSession();
  platformSessionActive = true;
  emitLearning("session-start", { level: currentLevel, roundTaskCount: ROUND_TASKS, startedAt: sessionStart });
}
function endPlatformSession(){
  if(!platformSessionActive) return;
  emitLearning("session-end", { startedAt: sessionStart });
  platformSessionActive = false;
}

/* ===== DENKAVO: Vollbild (wie Plus) ===== */
function fullscreenElement(){ return document.fullscreenElement || document.webkitFullscreenElement || null; }
function fullscreenSupported(){ return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled); }
async function toggleFullscreen(){
  try{
    if(fullscreenElement()) await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
    else { const root = document.documentElement; await (root.requestFullscreen ? root.requestFullscreen() : root.webkitRequestFullscreen()); }
  }catch(e){ /* Browser hat Vollbild abgelehnt – Spiel läuft normal weiter. */ }
}
function updateFullscreenButton(){
  if(!fullscreenBtn) return;
  fullscreenBtn.hidden = !fullscreenSupported();
  const active = !!fullscreenElement();
  fullscreenBtn.classList.toggle("active", active);
  fullscreenBtn.setAttribute("aria-pressed", String(active));
  fullscreenBtn.title = active ? "Vollbild beenden" : "Vollbild";
  fullscreenBtn.querySelector(".fs-label").textContent = active ? "Verlassen" : "Vollbild";
  requestAnimationFrame(fitBoard);
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
    prepareVoices();
    speechSynthesis.onvoiceschanged = () => prepareVoices();
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

// DENKAVO: Punktgröße an das Feld anpassen. Der Fünferabstand ist deutlich
// größer als der Abstand zwischen zwei Punkten (1,7 × Punkt statt 0,5 × Punkt).
const DOT_GAP = 0.5, BLOCK_GAP = 1.7, FIELD_PAD = 0.7;
function fitBoard(){
  const r = boardPanel.getBoundingClientRect();
  if(!r.width || !r.height) return;
  const avail = Math.min(r.width, r.height) - 28;
  const units = 10 + 8 * DOT_GAP + BLOCK_GAP + 2 * FIELD_PAD;
  const d = Math.max(6, Math.min(44, Math.floor(avail / units)));
  const root = document.documentElement.style;
  root.setProperty("--dot", d + "px");
  root.setProperty("--dotGap", Math.round(d * DOT_GAP) + "px");
  root.setProperty("--blockGap", Math.round(d * BLOCK_GAP) + "px");
  root.setProperty("--fieldPad", Math.round(d * FIELD_PAD) + "px");
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
  // DENKAVO: Rand an den Punktabstand angepasst, damit zwei Rahmen
  // nebeneinander (zwei Kernaufgaben) sich nicht überlappen.
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dotGap")) || 12;
  const pad = Math.max(4, Math.min(10, gap * 0.42));

  const left = start.left - pad;
  const top  = start.top - pad;
  const width  = (end.right - start.left) + 2 * pad;
  const height = (end.bottom - start.top) + 2 * pad;

  return { left, top, width, height };
}

function showFrame(el, rowStart, rowCount, colStart, colCount){
  const r = getRectPx(rowStart, rowCount, colStart, colCount);
  el.style.left = r.left + "px";
  el.style.top  = r.top + "px";
  el.style.width  = r.width + "px";
  el.style.height = r.height + "px";
  el.style.opacity = "1";
}
function showRedFrame(rowStart, rowCount, colStart, colCount){ showFrame(redFrame, rowStart, rowCount, colStart, colCount); }
function showRedFrame2(rowStart, rowCount, colStart, colCount){ showFrame(redFrame2, rowStart, rowCount, colStart, colCount); }
function hideRedFrame(){ redFrame.style.opacity = "0"; redFrame2.style.opacity = "0"; }

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
    if(s.m === 8 && b === 6) return derivedTask(8, 6, { type:"special86" });
    if(s.m === 8 && b === 7) return derivedTask(8, 7, { type:"special87" });
    return derivedTask(s.m, b, mode);
  });

  return shuffle(out);
}

/* Level 8: Neuner */
function buildNinesLevel(){
  const others = [3,4,6,7,8];
  const out = [];
  for(const n of others){
    out.push({ a:9, b:n, kind:"derived", strategy:{ type:"minus", axis:"rows", base:10, sub:1, nine:true } }); // 9·n = 10·n - 1·n
    out.push({ a:n, b:9, kind:"derived", strategy:{ type:"minus", axis:"cols", base:10, sub:1, nine:true } }); // n·9 = n·10 - n·1
  }
  return shuffle(out);
}

/* Level 9: NUR schwere Aufgaben (keine Kernaufgaben) */
function buildLevel9HardMixed(){
  const rows = [3,4,6,7,8];
  const heavyMultipliers = [3,4,6,7,8,9];
  const out = [];

  const modeFor = (m, row) => {
    if(m === 3) return (Math.random() < 0.5)
      ? {type:"plus", p1:2, p2:1}
      : {type:"minus", axis:"rows", base:5, sub:2};

    if(m === 4) return (Math.random() < 0.5)
      ? {type:"plus", p1:2, p2:2}
      : {type:"minus", axis:"rows", base:5, sub:1};

    if(m === 6) return {type:"plus", p1:5, p2:1};
    if(m === 7) return {type:"plus", p1:5, p2:2};
    if(m === 8 && row === 6) return {type:"special86"};
    if(m === 8 && row === 7) return {type:"special87"};
    if(m === 8) return {type:"minus", axis:"rows", base:10, sub:2};
    if(m === 9) return {type:"minus", axis:"rows", base:10, sub:1};

    return {type:"core"};
  };

  for(const b of rows){
    for(const m of heavyMultipliers){
      out.push(derivedTask(m, b, modeFor(m, b)));
    }
  }

  for(const b of rows){
    out.push({ a:b, b:9, kind:"derived", strategy:{ type:"minus", axis:"cols", base:10, sub:1, nine:true } });
  }

  return shuffle(out);
}

/* ===== Queue ===== */
function rebuildQueue(){
  idx = 0;
  levelSolved = 0;
  levelWrong = 0;
  pendingRetries = [];

  if(currentLevel === 1) queue = buildLevel1();
  else if(currentLevel === 2) queue = buildLevel2();
  else if([3,4,5,6,7].includes(currentLevel)) queue = buildDerivedLevels();
  else if(currentLevel === 8) queue = buildNinesLevel();
  else queue = buildLevel9HardMixed();

  // Jede Runde besteht aus genau 20 Aufgaben beim ersten Versuch.
  if(queue.length > 20) queue = queue.slice(0, 20);
  else if(queue.length > 0){
    const source = shuffle(queue.slice());
    while(queue.length < 20){
      const batch = shuffle(source.map(task => ({...task, strategy:{...task.strategy}})));
      queue.push(...batch.slice(0, Math.min(batch.length, 20 - queue.length)));
    }
  }
  levelTotal = queue.length;
  scoredTasks = 0; sessionCorrect = 0; sessionWrong = 0; sessionStart = Date.now(); sessionFinished = false;
  doneTasks = 0; renderProgress();
  startPlatformSession(); // DENKAVO
}

// Leere Punkte, die mit jeder erledigten Aufgabe gefüllt werden (Wiederholungen zählen nicht).
function renderProgress(){
  const el = document.getElementById("progressDots");
  if(!el) return;
  const total = ROUND_TASKS, done = Math.min(total, doneTasks);
  if(el.children.length !== total){
    el.innerHTML = "";
    for(let i=0;i<total;i++) el.appendChild(document.createElement("span"));
  }
  [...el.children].forEach((d,i) => d.classList.toggle("done", i < done));
  el.setAttribute("aria-label", `${done} von ${total} Aufgaben erledigt`);
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

// DENKAVO: Plus-Rechenwege (z. B. 7·b = 5·b + 2·b, 8·7 = 8·5 + 8·2) zeigen
// beide Kernaufgaben mit rotem Rahmen. Die Rahmen bleiben stehen.
function plusParts(t){
  if(t.strategy.type === "plus"){
    const { p1, p2 } = t.strategy;
    return { first: [1, p1, 1, t.b], second: [p1 + 1, p2, 1, t.b], end: [p1 + p2, t.b], firstRect: [p1, t.b],
      firstValue: p1 * t.b, secondValue: p2 * t.b };
  }
  // 8·6 = 8·5 + 8·1 und 8·7 = 8·5 + 8·2 (Aufteilung nach Spalten)
  const part = t.strategy.type === "special86" ? 1 : 2;
  return { first: [1, t.a, 1, 5], second: [1, t.a, 6, part], end: [t.a, 5 + part], firstRect: [t.a, 5],
    firstValue: t.a * 5, secondValue: t.a * part, columns: true };
}
function isPlusStrategy(t){ return ["plus","special86","special87"].includes(t.strategy.type); }

async function animatePlus(t, myRun, withLabels){
  const p = plusParts(t);
  setVisibleRect(...p.firstRect);
  if(p.columns){ await sleep(T.step); if(!isRun(myRun)) return; }
  showRedFrame(...p.first);
  if(withLabels){ placeLabel(labelA, ...p.first, String(p.firstValue)); labelB.style.opacity = "0"; }
  await sleep(T.frame);
  if(!isRun(myRun)) return;

  setVisibleRect(...p.end);
  if(p.columns){ await sleep(T.step); if(!isRun(myRun)) return; }
  showRedFrame2(...p.second);
  if(withLabels) placeLabel(labelB, ...p.second, (p.columns ? "+" : "") + String(p.secondValue));
  await sleep(T.after);
}

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

  if(isPlusStrategy(t)){ await animatePlus(t, myRun, false); return; }

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

  if(isPlusStrategy(t)){ await animatePlus(t, myRun, true); return; }

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
    addHelp("hilfe-verdoppeln");
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
    addHelp("hilfe-halbieren");
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
  const due = pendingRetries.filter(x => x.remaining <= 0);
  if(!due.length) return;

  pendingRetries = pendingRetries.filter(x => x.remaining > 0);
  for(const d of due){
    queue.splice(idx, 0, { ...d.task, wrongRecorded: false, isRetry: true });
  }
  levelTotal = queue.length;
}
function tickRetriesAfterShowingTask(){
  for(const p of pendingRetries){
    p.remaining -= 1;
  }
}

function formatElapsed(){
  const elapsed = Math.max(0, Math.floor((Date.now()-sessionStart)/1000));
  const hours = Math.floor(elapsed/3600);
  const minutes = Math.floor((elapsed%3600)/60);
  const seconds = String(elapsed%60).padStart(2,"0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2,"0")}:${seconds}` : `${minutes}:${seconds}`;
}

// DENKAVO: Rundenergebnis als eigene Fläche (wie Plus) statt im Aufgabenfeld.
function showSessionResult(manualEnd = false){
  if(sessionFinished) return;
  sessionFinished = true;
  setLocked(false);
  clearCheckTimer();
  if(resultTimer){ clearTimeout(resultTimer); resultTimer = null; }
  bumpRun();
  hideLabels();
  hideRedFrame();
  try{ window.speechSynthesis && window.speechSynthesis.cancel(); }catch(e){}
  endPlatformSession();

  const total = manualEnd ? scoredTasks : 20;
  resultPanel.innerHTML = "";
  const score = document.createElement("div");
  score.className = "resultScore";
  score.textContent = `${sessionCorrect} von ${total} Aufgaben richtig.`;
  const time = document.createElement("div");
  time.className = "resultTime";
  time.textContent = `Zeit: ${formatElapsed()}`;
  resultPanel.append(score, time);

  let rain = null;
  if(!manualEnd && sessionCorrect >= 19){
    rain = document.createElement("div");
    rain.className = "starRain";
    rain.setAttribute("aria-hidden", "true");
    for(let i=0; i<32; i++){
      const star = document.createElement("span");
      star.textContent = "★";
      star.style.left = `${(i * 37) % 100}%`;
      star.style.animationDelay = `${(i % 8) * -0.2}s`;
      star.style.animationDuration = `${1.4 + (i % 4) * 0.35}s`;
      star.style.fontSize = `${16 + (i % 4) * 7}px`;
      rain.appendChild(star);
    }
    resultPanel.appendChild(rain);
  } else if(!manualEnd && sessionCorrect >= 17){
    const icon = document.createElement("div");
    icon.className = "celebrationIcon";
    icon.textContent = "👍";
    icon.setAttribute("aria-hidden", "true");
    resultPanel.prepend(icon);
  }

  gameEl.hidden = true;
  resultPanel.hidden = false;

  const showActions = () => {
    if(resultPanel.hidden) return;
    const actions = document.createElement("div");
    actions.className = "resultActions";

    const continueBtn = document.createElement("button");
    continueBtn.className = "resultActionBtn";
    continueBtn.type = "button";
    continueBtn.textContent = "Weiter";
    continueBtn.addEventListener("click", () => {
      if(resultTimer){ clearTimeout(resultTimer); resultTimer = null; }
      rebuildQueue();
      idx = 0;
      nextTask();
    });

    const endBtn = document.createElement("button");
    endBtn.className = "resultActionBtn secondary";
    endBtn.type = "button";
    endBtn.textContent = "Ende";
    endBtn.addEventListener("click", () => {
      if(resultTimer){ clearTimeout(resultTimer); resultTimer = null; }
      actions.remove();
    });

    actions.append(continueBtn, endBtn);
    resultPanel.appendChild(actions);
  };

  if(rain){
    resultTimer = setTimeout(() => {
      rain.remove();
      resultTimer = null;
      showActions();
    }, 3000);
  } else {
    showActions();
  }
}

function showGame(){
  resultPanel.hidden = true;
  resultPanel.innerHTML = "";
  gameEl.hidden = false;
  requestAnimationFrame(fitBoard);
}

/* ===== Task / Level flow ===== */
function nextTask(){
  const myRun = bumpRun();
  clearCheckTimer();
  setLocked(false);

  if(sessionFinished) return;
  if(resultTimer){ clearTimeout(resultTimer); resultTimer = null; }
  if(gameEl.hidden) showGame();
  clearAnswerStyles();
  hideLabels();
  hideRedFrame();

  applyRetriesDue();

  if(sessionFinished || scoredTasks >= 20){ showSessionResult(); return; }
  if(idx >= queue.length){
    if(scoredTasks >= 20){ showSessionResult(); return; }
    rebuildQueue();
    idx = 0;
    nextTask();
    return;
  }

  const t = queue[idx];
  renderTask(t);

  answerInput.value = "";
  answerInput.focus({ preventScroll: true });

  // DENKAVO: Lernstatistik je Aufgabe
  taskAttemptCount = 0;
  helpUsedThisTask = t.isRetry ? ["wiederholung"] : [];
  taskStartAt = Date.now();

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
    if(raw === "" || !t) return;

    const got = Number(raw);
    const exp = expectedResult(t);
    const right = Number.isFinite(got) && got === exp;

    // DENKAVO: jede Eingabe an die Lernstatistik
    taskAttemptCount++;
    emitLearning("attempt", { ...taskInfo(t), givenAnswer: raw, isCorrect: right, attemptNumber: taskAttemptCount,
      durationMs: Math.max(0, Date.now() - taskStartAt), calculationSteps: [], helpUsed: [...helpUsedThisTask] });

    if(right){
      setLocked(true);
      if(!t.isRetry){
        if(!t.wrongRecorded){ scoredTasks++; sessionCorrect++; okCount++; }
        doneTasks++; renderProgress();
        // Eine abgeschlossene Aufgabe je Erstaufgabe: rot, wenn vorher falsch eingegeben wurde.
        emitLearning("task-complete", { ...taskInfo(t), isCorrect: !t.wrongRecorded, attemptNumber: taskAttemptCount,
          durationMs: Math.max(0, Date.now() - taskStartAt), calculationSteps: [], helpUsed: [...helpUsedThisTask] });
      }
      answerInput.classList.add("ok");

      levelSolved++;
      idx++;

      await sleep(1000);
      if(!isRun(myRun)) return;
      if(scoredTasks >= 20){ showSessionResult(); return; }
      nextTask();
      return;
    }

    // FALSCH – die Aufgabe bleibt stehen, bis sie richtig gelöst ist (DENKAVO).
    setLocked(true);
    if(!t.isRetry && !t.wrongRecorded){
      t.wrongRecorded = true;
      scoredTasks++; sessionWrong++; badCount++; levelWrong++;
      pendingRetries.push({ task: t, remaining: 2 });
    }

    answerInput.classList.add("bad");

    // 2 s rot, dann leeren und Hilfe zur aktuellen Aufgabe starten
    await sleep(2000);
    if(!isRun(myRun)) return;

    answerInput.value = "";

    const myRun2 = bumpRun();

    if(currentLevel === 1){
      const did = await level1WrongCoaching(t, myRun2);
      if(!did){ addHelp("hilfe-animation"); await animateTask(t, myRun2); }
    }else{
      addHelp("hilfe-animation");
      await helpAnimationWithLabels(t, myRun2);
      await sleep(2000);
      if(isRun(myRun2)) hideLabels();
    }

    // DENKAVO: Nach der Hilfe wird das Ergebnisfeld zurückgesetzt; dieselbe
    // Rechnung bleibt, eine neue kommt erst nach einem richtigen Ergebnis.
    if(isRun(myRun2)){
      answerInput.classList.remove("bad");
      answerInput.value = "";
      setLocked(false);
      answerInput.focus({ preventScroll: true });
    }
  }, 1000);
}

/* ===== UI ===== */
function bindUI(){
  const unlock = () => unlockSpeechOnce();
  document.addEventListener("pointerdown", unlock, { once:true });
  document.addEventListener("keydown", unlock, { once:true });

  $$(".lvlBtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      bumpRun();
      clearCheckTimer();
      if(resultTimer){ clearTimeout(resultTimer); resultTimer = null; }
      currentLevel = +btn.dataset.level;
      setLevelActiveButton();
      rebuildQueue();
      idx = 0;
      nextTask();
    });
  });

  // Ende: Runde beenden, Ergebnis und Zeit anzeigen.
  $("#endRoundBtn").addEventListener("click", () => showSessionResult(true));

  // DENKAVO: Haus-Knopf (nur in der Plattform sichtbar) – Sitzung beenden, zur Übersicht.
  if(homeBtn){
    // Außerhalb der Plattform (eigenständiges Spiel) ist der Haus-Knopf ausgegraut.
    if(window.parent === window){ homeBtn.disabled = true; homeBtn.title = "Nur in DENKAVO verfügbar"; }
    homeBtn.addEventListener("click", () => {
      if(homeBtn.disabled) return;
      bumpRun(); clearCheckTimer();
      if(resultTimer){ clearTimeout(resultTimer); resultTimer = null; }
      try{ window.speechSynthesis && window.speechSynthesis.cancel(); }catch(e){}
      endPlatformSession();
      emitLearning("exit", {});
    });
  }
  if(fullscreenBtn){
    fullscreenBtn.addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", updateFullscreenButton);
    document.addEventListener("webkitfullscreenchange", updateFullscreenButton);
    updateFullscreenButton();
  }

  answerInput.addEventListener("input", ()=>{
    if(inputLocked || sessionFinished) return;
    const cleaned = answerInput.value.replace(/[^\d]/g, "").slice(0, 2);
    if(cleaned !== answerInput.value) answerInput.value = cleaned;
    const t = queue[idx];
    if(t && cleaned.length >= String(expectedResult(t)).length) scheduleCheck(); else clearCheckTimer();
  });
  let lastTouchKeyAt = 0;
  const pressKey = (btn) => {
    if(sessionFinished || inputLocked) return;
    const key = btn.dataset.key;
    if(key === "clear") answerInput.value = "";
    else if(key === "back") answerInput.value = answerInput.value.slice(0,-1);
    else if(answerInput.value.length < 2) answerInput.value += key;
    answerInput.dispatchEvent(new Event("input", {bubbles:true}));
  };
  $$(".keyBtn").forEach(btn => {
    btn.addEventListener("touchstart", event => { event.preventDefault(); }, {passive:false});
    btn.addEventListener("touchend", event => {
      event.preventDefault();
      lastTouchKeyAt = Date.now();
      pressKey(btn);
    }, {passive:false});
    btn.addEventListener("click", () => {
      if(Date.now() - lastTouchKeyAt < 700) return;
      pressKey(btn);
    });
  });

  window.addEventListener("resize", () => requestAnimationFrame(fitBoard), { passive:true });
  window.addEventListener("orientationchange", () => setTimeout(fitBoard, 100), { passive:true });
  if(window.visualViewport) window.visualViewport.addEventListener("resize", () => requestAnimationFrame(fitBoard), { passive:true });
}

// Testhilfe für automatische Prüfungen (verändert kein Spielverhalten).
window.__malQA = {
  state(){
    const vis = $$(".dot.visible").map(d => [+d.dataset.r, +d.dataset.c]);
    const rows = vis.length ? Math.max(...vis.map(v => v[0])) : 0, cols = vis.length ? Math.max(...vis.map(v => v[1])) : 0;
    return { task: queue[idx] && { a: queue[idx].a, b: queue[idx].b, s: queue[idx].strategy.type, retry: !!queue[idx].isRetry },
      visible: vis.length, rows, cols, frames: [redFrame, redFrame2].map(f => f.style.opacity === "1"),
      input: answerInput.value, cls: answerInput.className, locked: inputLocked, scored: scoredTasks, correct: sessionCorrect,
      result: !resultPanel.hidden, done: doneTasks, filled: $$('#progressDots span.done').length, resultText: resultPanel.textContent };
  },
  async run(a, b, strategy, help = false){
    const t = { a, b, strategy };
    const id = bumpRun();
    if(help) await helpAnimationWithLabels(t, id); else await animateTask(t, id);
  },
  frameRects(){ return [redFrame, redFrame2].map(f => ({ on: f.style.opacity === "1", l: parseFloat(f.style.left), t: parseFloat(f.style.top), w: parseFloat(f.style.width), h: parseFloat(f.style.height) })); }
};

/* ===== Init ===== */
function init(){
  buildPointsField();
  fitBoard();
  rebuildQueue();
  bindUI();
  nextTask();
}

init();
