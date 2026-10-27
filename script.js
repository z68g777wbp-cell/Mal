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
let scoredTasks = 0, sessionCorrect = 0, sessionWrong = 0, sessionStart = 0, sessionFinished = false;

// Retry: falsch gelöste Aufgaben sollen nach 2 weiteren Aufgaben wieder auftauchen
let pendingRetries = []; // { task, remaining }

// Timer / Token (verhindert „Hilfe für falsche Aufgabe“)
let checkTimer = null;
let resultTimer = null;
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
    if(s.m === 8 && b === 6) return derivedTask(8, 6, { type:"special86" });
    if(s.m === 8 && b === 7) return derivedTask(8, 7, { type:"special87" });
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

  // Aufgaben m·Reihe (z.B. 3·7, 8·6, 9·4 …)
  for(const b of rows){
    for(const m of heavyMultipliers){
      out.push(derivedTask(m, b, modeFor(m, b)));
    }
  }

  // zusätzlich: Neuner-Umkehr (b·9) als schwere Form
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
  else queue = buildLevel9HardMixed(); // ✅ neu: nur schwere

  // Jede Runde besteht aus genau 20 Aufgaben beim ersten Versuch.
  // Kürzere Aufgabenpools werden wiederholt, ohne spätere Wiederholungen zu werten.
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
    // Der Kernfaktor (2er- oder 5er-Anteil) wird von Anfang an eingerahmt.
    setVisibleRect(t.strategy.p1, t.b);
    showRedFrame(1, t.strategy.p1, 1, t.b);
    await sleep(T.frame);
    if(!isRun(myRun)) return;

    hideRedFrame();
    setVisibleRect(t.strategy.p1 + t.strategy.p2, t.b);
    await sleep(T.after);
    return;
  }

  if(t.strategy.type === "special86" || t.strategy.type === "special87"){
    const part = t.strategy.type === "special86" ? 1 : 2;
    setVisibleRect(8, 5); await sleep(T.step); if(!isRun(myRun)) return;
    showRedFrame(1, 8, 1, 5); await sleep(T.frame); if(!isRun(myRun)) return;
    hideRedFrame(); setVisibleRect(8, 6); await sleep(T.step); if(!isRun(myRun)) return;
    showRedFrame(1, 8, 6, part); await sleep(T.frame); if(!isRun(myRun)) return;
    hideRedFrame(); setVisibleRect(8, 6); await sleep(T.after); return;
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
    showRedFrame(1, p1, 1, t.b);
    placeLabel(labelA, 1, p1, 1, t.b, String(p1 * t.b));
    labelB.style.opacity = "0";
    await sleep(T.frame);
    if(!isRun(myRun)) return;

    hideRedFrame();
    setVisibleRect(p1 + p2, t.b);
    placeLabel(labelB, p1 + 1, p2, 1, t.b, String(p2 * t.b));
    await sleep(T.after);
    return;
  }

  if(t.strategy.type === "special86" || t.strategy.type === "special87"){
    const part = t.strategy.type === "special86" ? 1 : 2;
    setVisibleRect(8, 5); await sleep(T.step); if(!isRun(myRun)) return;
    showRedFrame(1, 8, 1, 5); await sleep(T.frame); if(!isRun(myRun)) return;
    hideRedFrame(); setVisibleRect(8, 6); await sleep(T.step); if(!isRun(myRun)) return;
    showRedFrame(1, 8, 6, part); await sleep(T.frame); if(!isRun(myRun)) return;
    hideRedFrame(); setVisibleRect(8, 6);
    placeLabel(labelA, 1, 8, 1, 5, "40"); placeLabel(labelB, 1, 8, 6, part, "+" + String(8*part));
    await sleep(T.after); return;
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
  // Alle fälligen Wiederholungen an der aktuellen Position einfügen.
  const due = pendingRetries.filter(x => x.remaining <= 0);
  if(!due.length) return;

  pendingRetries = pendingRetries.filter(x => x.remaining > 0);
  for(const d of due){
    queue.splice(idx, 0, { ...d.task, isRetry: true });
  }
  // Die Wiederholung ergänzt die Runde; Erstversuchs-Aufgaben und Zeit bleiben erhalten.
  levelTotal = queue.length;
}
function tickRetriesAfterShowingTask(){
  // nach jeder "gezeigten" Aufgabe wird remaining-- (damit nach 2 weiteren Aufgaben wieder kommt)
  for(const p of pendingRetries){
    p.remaining -= 1;
  }
}

function showSessionResult(manualEnd = false){
  if(sessionFinished) return;
  sessionFinished = true;
  clearCheckTimer();
  if(resultTimer){ clearTimeout(resultTimer); resultTimer = null; }
  bumpRun();
  hideLabels();
  hideRedFrame();
  pointsField.style.visibility = "hidden";
  taskText.textContent = "";
  answerInput.style.display = "none";
  document.querySelector(".eq").style.display = "none";
  const old = document.getElementById("sessionResult");
  if(old) old.remove();

  const box = document.createElement("div");
  box.id = "sessionResult";
  const elapsed = Math.max(0, Math.floor((Date.now()-sessionStart)/1000));
  const hours = Math.floor(elapsed/3600);
  const minutes = Math.floor((elapsed%3600)/60);
  const seconds = String(elapsed%60).padStart(2,"0");
  const timeText = hours > 0 ? `${hours}:${String(minutes).padStart(2,"0")}:${seconds}` : `${minutes}:${seconds}`;
  const total = manualEnd ? scoredTasks : 20;
  box.innerHTML = `<div class="resultScore">${sessionCorrect} von ${total} Aufgaben richtig.</div><div class="resultTime">Zeit: ${timeText}</div>`;

  let rain = null;
  if(!manualEnd && sessionCorrect >= 19){
    box.classList.add("celebrate-stars");
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
    box.appendChild(rain);
  } else if(!manualEnd && sessionCorrect >= 17){
    box.classList.add("celebrate-thumb");
    const icon = document.createElement("div");
    icon.className = "celebrationIcon";
    icon.textContent = "👍";
    icon.setAttribute("aria-hidden", "true");
    box.prepend(icon);
  }

  document.querySelector("#taskArea").prepend(box);
  const showActions = () => {
    if(!box.isConnected) return;
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
    endBtn.className = "resultActionBtn";
    endBtn.type = "button";
    endBtn.textContent = "Ende";
    endBtn.addEventListener("click", () => {
      if(resultTimer){ clearTimeout(resultTimer); resultTimer = null; }
      actions.remove();
    });

    actions.append(continueBtn, endBtn);
    box.appendChild(actions);
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

/* ===== Task / Level flow ===== */
function nextTask(){
  const myRun = bumpRun();
  clearCheckTimer();

  if(sessionFinished) return;
  if(resultTimer){ clearTimeout(resultTimer); resultTimer = null; }
  const resultBox = document.getElementById("sessionResult"); if(resultBox) resultBox.remove();
  pointsField.style.visibility = "visible"; answerInput.style.display = ""; document.querySelector(".eq").style.display = "";
  clearAnswerStyles();
  hideLabels();
  hideRedFrame();

  // fällige Retries vor dem Anzeigen einschieben
  applyRetriesDue();

  if(sessionFinished || scoredTasks >= 20){ showSessionResult(); return; }
  // Ende?
  if(idx >= queue.length){
    // Sicherheitsnetz, falls eine Aufgabe manuell übersprungen wurde.
    if(scoredTasks >= 20){ showSessionResult(); return; }
    // Es sollten 20 Erstversuchs-Aufgaben vorhanden sein; falls eine durch
    // manuelles Überspringen fehlt, wird die Runde sauber neu gestartet.
    rebuildQueue();
    idx = 0;
    nextTask();
    return;
  }

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
      if(!t.isRetry){ scoredTasks++; sessionCorrect++; }
      okCount++;
      okCountEl.textContent = String(okCount);
      answerInput.classList.add("ok");

      levelSolved++;
      idx++;

      await sleep(1000);
      if(!isRun(myRun)) return;
      if(scoredTasks >= 20){ showSessionResult(); return; }
      nextTask();
      return;
    }

    // FALSCH
    if(!t.isRetry){
      scoredTasks++; sessionWrong++; badCount++; badCountEl.textContent = String(badCount); levelWrong++;
      pendingRetries.push({ task: t, remaining: 2 });
    }

    // Rot
    answerInput.classList.add("bad");

    // 2s warten, dann leeren, Hilfe starten (zur aktuellen Aufgabe t!)
    await sleep(2000);
    if(!isRun(myRun)) return;

    answerInput.value = "";

    const myRun2 = bumpRun();

    if(currentLevel === 1){
      const did = await level1WrongCoaching(t, myRun2);
      if(!did) await animateTask(t, myRun2);
    }else{
      await helpAnimationWithLabels(t, myRun2);
      await sleep(2000);
      if(isRun(myRun2)) hideLabels();
    }

    // nach Hilfe: Rot wieder weg
    if(isRun(myRun2)) answerInput.classList.remove("bad");

    // UND: zur nächsten Aufgabe weitergehen (damit Retry später wiederkommt)
    if(isRun(myRun2)){
      idx++;
      if(scoredTasks >= 20) showSessionResult(); else nextTask();
    }
  }, 1000);
}

/* ===== UI ===== */
function bindUI(){
  // Speech unlock bei erster Interaktion
  const unlock = () => unlockSpeechOnce();
  document.addEventListener("pointerdown", unlock, { once:true });
  document.addEventListener("keydown", unlock, { once:true });

  $$(".lvlBtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      // Ein Levelwechsel ist jederzeit möglich und beendet laufende Animationen/Hilfen.
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

  $("#endRoundBtn").addEventListener("click", () => {
    if(scoredTasks === 0){
      // Eine Runde kann auch vor der ersten gewerteten Antwort beendet werden.
      showSessionResult(true);
      return;
    }
    showSessionResult(true);
  });

  answerInput.addEventListener("input", ()=>{
    const cleaned = answerInput.value.replace(/[^\d]/g, "").slice(0, 2);
    if(cleaned !== answerInput.value) answerInput.value = cleaned;
    const t = queue[idx];
    if(t && cleaned.length >= String(expectedResult(t)).length) scheduleCheck(); else clearCheckTimer();
  });
  // Ziffernfeld: Touch-Eingaben selbst verarbeiten, damit iPad-Safari
  // beim Fokussieren eines Buttons nicht die Seite verschiebt.
  let lastTouchKeyAt = 0;
  const pressKey = (btn) => {
    if(sessionFinished) return;
    const key = btn.dataset.key;
    if(key === "clear") answerInput.value = "";
    else if(key === "back") answerInput.value = answerInput.value.slice(0,-1);
    else if(answerInput.value.length < 2) answerInput.value += key;
    answerInput.dispatchEvent(new Event("input", {bubbles:true}));
  };
  $$(".keyBtn").forEach(btn => {
    btn.addEventListener("touchstart", event => {
      // Verhindert den nativen Fokus-/Scroll-Effekt beim ersten Antippen.
      event.preventDefault();
    }, {passive:false});
    btn.addEventListener("touchend", event => {
      event.preventDefault();
      lastTouchKeyAt = Date.now();
      pressKey(btn);
    }, {passive:false});
    btn.addEventListener("click", () => {
      // iOS kann nach touchend zusätzlich einen synthetischen click auslösen.
      if(Date.now() - lastTouchKeyAt < 700) return;
      pressKey(btn);
    });
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