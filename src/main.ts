import {
  type DegreeNote,
  type Key,
  centsToPitchClass,
  degreeLabel,
  degreeToPitchClass,
  generateMelody,
  hzToMidiFloat,
  semitoneOffset,
} from "./theory";
import { PitchEngine, scheduleClick, scheduleTone } from "./audio";

// --- config -----------------------------------------------------------------
const key: Key = { tonicPc: 0, mode: "major" }; // C major
const TONIC_MIDI = 60; // C4, the octave we sound references in
const LABEL = "numbers" as const;
const COUNT_IN = 4; // beats before the first note
const NOTE_BEATS = 1; // quarter notes
const SEMI_RANGE = 12; // vertical span of the roll, in semitones above tonic

// --- DOM --------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("roll");
const ctx2d = canvas.getContext("2d")!;
const scoreEl = $("score");
const startBtn = $<HTMLButtonElement>("startBtn");
const previewBtn = $<HTMLButtonElement>("previewBtn");
const regenBtn = $<HTMLButtonElement>("regenBtn");
const bpmEl = $<HTMLInputElement>("bpm");
const tolEl = $<HTMLInputElement>("tol");
const holdEl = $<HTMLInputElement>("hold");
const countinDots = Array.from(document.querySelectorAll<HTMLElement>("#countin .dot"));

$("keyline").textContent =
  "Key: C major · sing in any octave · green = hit, red = wrong note, gray = missed";

const bpm = () => +bpmEl.value;
const tol = () => +tolEl.value;
const holdFrames = () => +holdEl.value;
const beatDur = () => 60 / bpm();

for (const [el, span] of [
  [bpmEl, "bpmVal"],
  [tolEl, "tolVal"],
  [holdEl, "holdVal"],
] as const) {
  const out = $(span);
  const sync = () => (out.textContent = el.value);
  el.addEventListener("input", sync);
  sync();
}

// --- audio + engine ---------------------------------------------------------
let audioCtx: AudioContext | undefined;
const engine = new PitchEngine();
function ctx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// --- exercise state ---------------------------------------------------------
type Verdict = "pending" | "hit" | "wrong" | "missed";
let melody: DegreeNote[] = generateMelody(4);
let verdicts: Verdict[] = [];
let sungDeg: (number | null)[] = []; // what we think they actually sang
let running = false;
let startTime = 0;
let latestSemis: number | null = null; // display position of the live dot
let trace: { beat: number; semis: number }[] = []; // sung-pitch contour

// median smoothing of the raw pitch kills single-frame octave spikes that
// otherwise make the guide jump wildly (e.g. on a held "do").
const HZ_WINDOW = 5;
let hzBuf: number[] = [];
function smoothHz(hz: number | null): number | null {
  if (hz == null) {
    hzBuf = [];
    return null;
  }
  hzBuf.push(hz);
  if (hzBuf.length > HZ_WINDOW) hzBuf.shift();
  const sorted = [...hzBuf].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Map a sung pitch to a vertical position, choosing the octave nearest the
// target so flat-of-tonic reads as "just below do" instead of wrapping an
// octave up to the top of the roll.
function displaySemis(hz: number, refSemis: number): number {
  const raw = ((hzToMidiFloat(hz) - key.tonicPc) % 12 + 12) % 12;
  let best = raw;
  for (const cand of [raw - 12, raw, raw + 12]) {
    if (Math.abs(cand - refSemis) < Math.abs(best - refSemis)) best = cand;
  }
  return best;
}

// per-note accumulator
let acc = newAcc(-1);
function newAcc(idx: number) {
  return { idx, consec: 0, maxConsec: 0, frames: 0, degCount: {} as Record<number, number> };
}

function resetExercise() {
  verdicts = melody.map(() => "pending");
  sungDeg = melody.map(() => null);
  trace = [];
  acc = newAcc(-1);
  scoreEl.textContent = "";
}

// nearest scale degree to a sung pitch (for "what did they sing")
function nearestDegree(hz: number): number {
  let best = 1;
  let bestErr = Infinity;
  for (let d = 1; d <= 7; d++) {
    const c = Math.abs(centsToPitchClass(hz, degreeToPitchClass({ degree: d, octave: 0 }, key)));
    if (c < bestErr) {
      bestErr = c;
      best = d;
    }
  }
  return best;
}

// --- scoring (driven per mic frame) -----------------------------------------
function finalize(a: typeof acc) {
  if (a.idx < 0 || a.idx >= melody.length) return;
  const entries = Object.entries(a.degCount);
  const dominant = entries.length
    ? +entries.sort((x, y) => y[1] - x[1])[0][0]
    : null;
  sungDeg[a.idx] = dominant;

  if (a.maxConsec >= holdFrames()) verdicts[a.idx] = "hit";
  else if (a.frames > 3) verdicts[a.idx] = "wrong"; // sang something, not held on target
  else verdicts[a.idx] = "missed";
}

function onSample(s: { hz: number | null }) {
  if (!running) return;

  const hz = smoothHz(s.hz);
  const now = ctx().currentTime;
  const curBeat = (now - startTime) / beatDur();
  const noteIdx = Math.floor(curBeat - COUNT_IN);

  // crossed into a new note window -> finalize the previous one
  if (noteIdx !== acc.idx) {
    finalize(acc);
    acc = newAcc(noteIdx);
  }

  const active = noteIdx >= 0 && noteIdx < melody.length;
  latestSemis = null;

  if (active && hz != null) {
    const target = melody[noteIdx];
    const cents = centsToPitchClass(hz, degreeToPitchClass(target, key));
    acc.frames++;
    acc.degCount[nearestDegree(hz)] = (acc.degCount[nearestDegree(hz)] ?? 0) + 1;
    if (Math.abs(cents) <= tol()) {
      acc.consec++;
      acc.maxConsec = Math.max(acc.maxConsec, acc.consec);
    } else acc.consec = 0;

    // guide is only shown during real measures (count-in tone would pollute it)
    const semis = displaySemis(hz, semitoneOffset(target, key.mode));
    latestSemis = semis;
    trace.push({ beat: curBeat - COUNT_IN, semis }); // note-beat coords
  } else if (active) {
    acc.consec = 0;
  }

  draw(curBeat);

  if (curBeat >= COUNT_IN + melody.length * NOTE_BEATS) finishRun();
}

// --- run control ------------------------------------------------------------
async function startRun() {
  const c = ctx();
  await c.resume(); // ensure the clock is running before we schedule on it
  if (!engine.isLive) await engine.start(c, onSample); // warm mic: start once

  resetExercise();
  startTime = c.currentTime + 0.15;
  const totalBeats = COUNT_IN + melody.length * NOTE_BEATS;
  for (let b = 0; b < totalBeats; b++) {
    scheduleClick(c, startTime + b * beatDur(), b % COUNT_IN === 0);
  }
  // sound the tonic during the count-in so the singer has a reference
  scheduleTone(c, TONIC_MIDI, startTime, beatDur() * COUNT_IN * 0.9);

  running = true;
  setControls(true);
}

function finishRun() {
  if (!running) return;
  finalize(acc);
  running = false; // mic stays warm; we just stop scoring/drawing the run
  hzBuf = [];
  setControls(false);
  const hits = verdicts.filter((v) => v === "hit").length;
  scoreEl.textContent = `Score: ${hits}/${melody.length} correct · ` +
    melody
      .map((n, i) => {
        const tag = { hit: "✓", wrong: "✗", missed: "·", pending: "?" }[verdicts[i]];
        const sang = sungDeg[i] ? ` (sang ${degreeLabel(sungDeg[i]!, LABEL)})` : "";
        return `${degreeLabel(n.degree, LABEL)}${tag}${verdicts[i] === "wrong" ? sang : ""}`;
      })
      .join("  ");
  draw(COUNT_IN + melody.length);
}

function preview() {
  const c = ctx();
  const t0 = c.currentTime + 0.1;
  scheduleTone(c, TONIC_MIDI, t0, 0.4);
  melody.forEach((n, i) => {
    scheduleTone(c, TONIC_MIDI + semitoneOffset(n, key.mode), t0 + 0.5 + i * beatDur(), beatDur() * 0.9);
  });
}

function setControls(run: boolean) {
  startBtn.textContent = run ? "⏹ Stop" : "🎤 Start & sing";
  regenBtn.disabled = run;
  previewBtn.disabled = run;
}

// --- rendering --------------------------------------------------------------
function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const PAD = { l: 34, r: 12, t: 14, b: 14 };
const DEGREE_SEMIS = [0, 2, 4, 5, 7, 9, 11, 12]; // major scale rows + octave

// Light the count-in dots: progressively during the count-in, all on once the
// melody is playing, all off when idle.
function updateCountin(curBeat: number) {
  let lit = 0;
  if (running) lit = curBeat >= COUNT_IN ? COUNT_IN : Math.max(0, Math.floor(curBeat) + 1);
  countinDots.forEach((d, i) => d.classList.toggle("lit", i < lit));
}

function draw(curBeat: number) {
  updateCountin(curBeat);

  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const noteBeats = melody.length * NOTE_BEATS; // graph spans the melody only
  const playBeat = curBeat - COUNT_IN; // beats since the first note
  const xBeat = (b: number) => PAD.l + (b / noteBeats) * plotW;
  const ySemi = (s: number) => PAD.t + (1 - s / SEMI_RANGE) * plotH;

  ctx2d.clearRect(0, 0, W, H);

  // degree gridlines + labels
  ctx2d.font = "11px system-ui";
  for (let i = 0; i < DEGREE_SEMIS.length; i++) {
    const s = DEGREE_SEMIS[i];
    const y = ySemi(s);
    ctx2d.strokeStyle = "#23272f";
    ctx2d.beginPath();
    ctx2d.moveTo(PAD.l, y);
    ctx2d.lineTo(W - PAD.r, y);
    ctx2d.stroke();
    ctx2d.fillStyle = "#6b7280";
    const deg = i === 7 ? 1 : i + 1;
    ctx2d.fillText(degreeLabel(deg, LABEL), 8, y + 4);
  }

  // beat gridlines
  for (let b = 0; b <= noteBeats; b++) {
    ctx2d.strokeStyle = "#1e222a";
    ctx2d.beginPath();
    ctx2d.moveTo(xBeat(b), PAD.t);
    ctx2d.lineTo(xBeat(b), H - PAD.b);
    ctx2d.stroke();
  }

  // target note bars
  const colors: Record<Verdict, string> = {
    pending: "#3b5bdb",
    hit: "#2f9e57",
    wrong: "#c0392b",
    missed: "#555b66",
  };
  const barH = 16;
  melody.forEach((n, i) => {
    const x0 = xBeat(i * NOTE_BEATS) + 2;
    const x1 = xBeat((i + 1) * NOTE_BEATS) - 2;
    const y = ySemi(semitoneOffset(n, key.mode));
    ctx2d.fillStyle = colors[verdicts[i]];
    ctx2d.beginPath();
    ctx2d.roundRect(x0, y - barH / 2, x1 - x0, barH, 5);
    ctx2d.fill();
  });

  // sung-pitch contour (stored in note-beat coords)
  if (trace.length > 1) {
    ctx2d.strokeStyle = "#e8c84a";
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    trace.forEach((p, i) => {
      const x = xBeat(p.beat);
      const y = ySemi(p.semis);
      i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
    });
    ctx2d.stroke();
    ctx2d.lineWidth = 1;
  }

  // live sung dot (latestSemis is null during the count-in, so it stays hidden)
  if (running && latestSemis != null) {
    ctx2d.fillStyle = "#ffd84d";
    ctx2d.beginPath();
    ctx2d.arc(xBeat(playBeat), ySemi(latestSemis), 5, 0, Math.PI * 2);
    ctx2d.fill();
  }

  // playhead (only once the melody is running, i.e. after the count-in)
  if (running && playBeat >= 0) {
    const x = xBeat(Math.min(playBeat, noteBeats));
    ctx2d.strokeStyle = "#9fb4ff";
    ctx2d.beginPath();
    ctx2d.moveTo(x, PAD.t);
    ctx2d.lineTo(x, H - PAD.b);
    ctx2d.stroke();
  }
}

// --- wire up ----------------------------------------------------------------
startBtn.addEventListener("click", () => {
  if (running) finishRun();
  else startRun();
});
previewBtn.addEventListener("click", preview);
regenBtn.addEventListener("click", () => {
  melody = generateMelody(4);
  resetExercise();
  draw(-1);
});

window.addEventListener("resize", () => {
  fitCanvas();
  draw(running ? (ctx().currentTime - startTime) / beatDur() : -1);
});

fitCanvas();
resetExercise();
draw(-1);
