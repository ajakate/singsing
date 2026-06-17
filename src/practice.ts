import {
  type DegreeNote,
  type Key,
  NOTE_NAMES,
  RANGE_LADDER,
  centsToPitchClass,
  degreeLabel,
  degreeToPitchClass,
  generateMelody,
  hzToMidiFloat,
  semitoneOffset,
} from "./theory";
import {
  type DroneHandle,
  PitchEngine,
  schedulePiano,
  scheduleClick,
  scheduleDrone,
  startDrone,
} from "./audio";
import type { Settings } from "./settings";

const MODE = "major" as const;
const LABEL = "numbers" as const;
const COUNT_IN = 4; // beats before the first note
const NOTE_BEATS = 1; // quarter notes
const HZ_WINDOW = 5; // median smoothing window for the pitch guide

export type Verdict = "pending" | "hit" | "wrong" | "missed";

export interface NoteResult {
  degree: number;
  verdict: Verdict;
  sang: number | null; // dominant degree actually sung (for wrong notes)
}
export interface RunResult {
  hits: number;
  total: number;
  notes: NoteResult[];
}

export interface PracticeCallbacks {
  onLit: (lit: number) => void; // count-in dots lit (0..COUNT_IN)
  onRunning: (running: boolean) => void;
  onResult: (result: RunResult | null) => void;
  onKey: (name: string) => void; // e.g. "D major"
}

const PAD = { l: 34, r: 12, t: 14, b: 14 };
const COLORS: Record<Verdict, string> = {
  pending: "#3b5bdb",
  hit: "#2f9e57",
  wrong: "#c0392b",
  missed: "#555b66",
};

// I–IV–V–I voiced as semitone offsets above the tonic, each with its root
// doubled an octave below (the leading negative offset) for a fuller bottom.
const CADENCE: number[][] = [
  [-12, 0, 4, 7, 12], // I
  [-7, 5, 9, 12], // IV
  [-5, 7, 11, 14], // V
  [-12, 0, 4, 7, 12], // I
];

// One AudioContext for the whole page. Creating a new one per controller (e.g.
// on every dev hot-reload remount) churns through the browser's context limit
// and makes freshly-scheduled audio — like the count-in clicks — get dropped.
let sharedCtx: AudioContext | undefined;
function sharedAudioContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext();
  return sharedCtx;
}

export class PracticeController {
  private ctx2d: CanvasRenderingContext2D;
  private engine = new PitchEngine();

  private master?: GainNode; // all scheduled audio routes through this so stop() can cut it
  private heldDrone?: DroneHandle; // press-and-hold reference drone
  private key: Key = { tonicPc: 0, mode: MODE };
  private tonicMidi = 60; // C4; recomputed per key, kept in a singable octave
  private melody: DegreeNote[] = [];
  private verdicts: Verdict[] = [];
  private sungDeg: (number | null)[] = [];
  private running = false;
  private startTime = 0;
  private latestSemis: number | null = null;
  private trace: { beat: number; semis: number }[] = [];
  private hzBuf: number[] = [];
  private lastLit = -1;
  private acc = newAcc(-1);

  private readonly onResize = () => {
    this.fitCanvas();
    this.draw(this.running ? this.curBeat() : -1);
  };

  constructor(
    private canvas: HTMLCanvasElement,
    private getSettings: () => Settings,
    private cb: PracticeCallbacks,
  ) {
    this.ctx2d = canvas.getContext("2d")!;
    window.addEventListener("resize", this.onResize);
    this.fitCanvas();
    this.regenerate();
  }

  dispose() {
    window.removeEventListener("resize", this.onResize);
    this.stopHeldDrone();
    this.stopAllAudio();
    this.engine.stop();
    // intentionally do NOT close the shared AudioContext — it's reused across
    // controller remounts for the lifetime of the page.
  }

  // Press-and-hold reference drone: tonic across three octaves until released.
  // The octave *up* carries on phone speakers (which roll off the low end),
  // while the lower octaves add body on headphones/good speakers.
  startHeldDrone() {
    if (this.running || this.heldDrone) return;
    const c = this.ctx();
    c.resume();
    const t = this.tonicMidi;
    // triangle (richer than sine) at a higher level so it's as present as the
    // cadence, especially on phone speakers
    this.heldDrone = startDrone(c, [t - 12, t, t + 12], this.out(), 0.18, "triangle");
  }

  stopHeldDrone() {
    this.heldDrone?.stop();
    this.heldDrone = undefined;
  }

  // Output node for all scheduled audio; cutting it stops everything at once.
  private out(): GainNode {
    const c = this.ctx();
    if (!this.master) {
      this.master = c.createGain();
      this.master.connect(c.destination);
    }
    return this.master;
  }

  // Immediately silence any scheduled clicks / cadence / drone. Already-scheduled
  // oscillators keep running but are disconnected from output, so they're silent.
  private stopAllAudio() {
    if (this.master) {
      try {
        this.master.disconnect();
      } catch {
        /* already disconnected */
      }
      this.master = undefined;
    }
  }

  // --- settings accessors ---
  private get tol() { return this.getSettings().toleranceCents; }
  private get holdFrames() { return this.getSettings().holdFrames; }
  private get beatDur() { return 60 / this.getSettings().bpm; }

  private ctx(): AudioContext {
    return sharedAudioContext();
  }

  private curBeat() {
    return (this.ctx().currentTime - this.startTime) / this.beatDur;
  }

  // --- public actions ---
  regenerate() {
    this.pickKey();
    const { melodyLength, degreePool, rangeLowIdx, rangeHighIdx } = this.getSettings();
    this.melody = generateMelody(
      melodyLength,
      [...degreePool].sort((a, b) => a - b),
      RANGE_LADDER[rangeLowIdx].semi,
      RANGE_LADDER[rangeHighIdx].semi,
    );
    this.resetRun();
    this.cb.onResult(null);
    this.fitCanvas(); // range may have changed the canvas height
    this.draw(-1);
  }

  private pickKey() {
    const pool = this.getSettings().keyPool;
    const choices = pool.length ? pool : [0]; // empty selection falls back to C
    const pc = choices[Math.floor(Math.random() * choices.length)];
    this.key = { tonicPc: pc, mode: MODE };
    // keep the tonic within ~a tritone of C4 so cadences stay singable
    this.tonicMidi = 60 + (pc <= 6 ? pc : pc - 12);
    this.cb.onKey(`${NOTE_NAMES[pc]} ${MODE}`);
  }

  private resetRun() {
    this.verdicts = this.melody.map(() => "pending");
    this.sungDeg = this.melody.map(() => null);
    this.trace = [];
    this.hzBuf = [];
    this.acc = newAcc(-1);
    this.lastLit = -1;
  }

  async start() {
    this.stopHeldDrone(); // in case it was held when the run began
    const c = this.ctx();
    await c.resume();
    if (!this.engine.isLive) await this.engine.start(c, (s) => this.onSample(s.hz));

    this.resetRun();
    this.cb.onResult(null);

    const { playDrone } = this.getSettings();
    const outNode = this.out();
    this.startTime = c.currentTime + 0.25; // lead so the first count-in click isn't clipped

    const totalBeats = COUNT_IN + this.melody.length * NOTE_BEATS;
    for (let b = 0; b < totalBeats; b++) {
      scheduleClick(c, this.startTime + b * this.beatDur, b % COUNT_IN === 0, outNode);
    }
    if (playDrone) {
      // Soft tonic an octave below the sung range, sustained through the whole
      // exercise (count-in + all notes) as a steady reference.
      scheduleDrone(c, [this.tonicMidi - 12], this.startTime, this.beatDur * totalBeats, 0.1, outNode);
    }

    this.running = true;
    this.cb.onRunning(true);
  }

  stop() {
    this.finishRun();
  }

  // Play a I–IV–V–I cadence in the current key, on demand, so the singer can
  // hear the tonic before an exercise.
  playCadence() {
    const c = this.ctx();
    c.resume();
    const t0 = c.currentTime + 0.08;
    const step = this.beatDur; // one chord per beat, following the tempo setting
    CADENCE.forEach((chord, i) => {
      const last = i === CADENCE.length - 1;
      this.scheduleChord(c, chord, t0 + i * step, step * (last ? 1.9 : 1.3));
    });
  }

  preview() {
    const c = this.ctx();
    c.resume();
    const out = this.out();
    const t0 = c.currentTime + 0.1;
    this.melody.forEach((n, i) => {
      const dur = Math.min(this.beatDur * 0.95, 0.8);
      schedulePiano(c, this.tonicMidi + semitoneOffset(n, MODE), t0 + i * this.beatDur, dur, out, 0.22);
    });
  }

  private scheduleChord(c: AudioContext, semis: number[], at: number, dur: number) {
    for (const s of semis) schedulePiano(c, this.tonicMidi + s, at, dur, this.out(), 0.11);
  }

  // --- per-frame scoring ---
  private onSample(rawHz: number | null) {
    if (!this.running) return;

    const hz = this.smoothHz(rawHz);
    const curBeat = this.curBeat();
    const noteIdx = Math.floor(curBeat - COUNT_IN);

    if (noteIdx !== this.acc.idx) {
      this.finalizeNote(this.acc);
      this.acc = newAcc(noteIdx);
    }

    const active = noteIdx >= 0 && noteIdx < this.melody.length;
    this.latestSemis = null;

    if (active && hz != null) {
      const target = this.melody[noteIdx];
      const cents = centsToPitchClass(hz, degreeToPitchClass(target, this.key));
      this.acc.frames++;
      const d = this.nearestDegree(hz);
      this.acc.degCount[d] = (this.acc.degCount[d] ?? 0) + 1;
      if (Math.abs(cents) <= this.tol) {
        this.acc.consec++;
        this.acc.maxConsec = Math.max(this.acc.maxConsec, this.acc.consec);
      } else this.acc.consec = 0;

      const semis = this.displaySemis(hz, semitoneOffset(target, MODE));
      this.latestSemis = semis;
      this.trace.push({ beat: curBeat - COUNT_IN, semis });
    } else if (active) {
      this.acc.consec = 0;
    }

    this.draw(curBeat);

    if (curBeat >= COUNT_IN + this.melody.length * NOTE_BEATS) this.finishRun();
  }

  private finalizeNote(a: Accumulator) {
    if (a.idx < 0 || a.idx >= this.melody.length) return;
    const entries = Object.entries(a.degCount);
    const dominant = entries.length ? +entries.sort((x, y) => y[1] - x[1])[0][0] : null;
    this.sungDeg[a.idx] = dominant;
    if (a.maxConsec >= this.holdFrames) this.verdicts[a.idx] = "hit";
    else if (a.frames > 3) this.verdicts[a.idx] = "wrong";
    else this.verdicts[a.idx] = "missed";
  }

  private finishRun() {
    if (!this.running) return;
    this.finalizeNote(this.acc);
    this.running = false;
    this.hzBuf = [];
    this.stopAllAudio(); // kill any in-flight clicks / cadence / drone
    this.cb.onRunning(false);
    this.draw(COUNT_IN + this.melody.length);
    this.cb.onResult({
      hits: this.verdicts.filter((v) => v === "hit").length,
      total: this.melody.length,
      notes: this.melody.map((n, i) => ({
        degree: n.degree,
        verdict: this.verdicts[i],
        sang: this.sungDeg[i],
      })),
    });
  }

  // --- helpers ---
  private smoothHz(hz: number | null): number | null {
    if (hz == null) {
      this.hzBuf = [];
      return null;
    }
    this.hzBuf.push(hz);
    if (this.hzBuf.length > HZ_WINDOW) this.hzBuf.shift();
    const sorted = [...this.hzBuf].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private displaySemis(hz: number, refSemis: number): number {
    const raw = ((hzToMidiFloat(hz) - this.key.tonicPc) % 12 + 12) % 12;
    let best = raw;
    for (const cand of [raw - 12, raw, raw + 12]) {
      if (Math.abs(cand - refSemis) < Math.abs(best - refSemis)) best = cand;
    }
    return best;
  }

  private nearestDegree(hz: number): number {
    let best = 1;
    let bestErr = Infinity;
    for (let d = 1; d <= 7; d++) {
      const c = Math.abs(centsToPitchClass(hz, degreeToPitchClass({ degree: d, octave: 0 }, this.key)));
      if (c < bestErr) {
        bestErr = c;
        best = d;
      }
    }
    return best;
  }

  // --- rendering ---
  private fitCanvas() {
    // grow the canvas with the pitch range so rows keep a comfortable spacing
    const { rangeLowIdx, rangeHighIdx } = this.getSettings();
    const span = RANGE_LADDER[rangeHighIdx].semi - RANGE_LADDER[rangeLowIdx].semi || 12;
    const h = Math.max(260, Math.min(560, Math.round(PAD.t + PAD.b + span * 21)));
    this.canvas.style.height = `${h}px`;

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private emitLit(curBeat: number) {
    let lit = 0;
    if (this.running) lit = curBeat >= COUNT_IN ? COUNT_IN : Math.max(0, Math.floor(curBeat) + 1);
    if (lit !== this.lastLit) {
      this.lastLit = lit;
      this.cb.onLit(lit);
    }
  }

  redraw() {
    this.draw(this.running ? this.curBeat() : -1);
  }

  private draw(curBeat: number) {
    this.emitLit(curBeat);
    const g = this.ctx2d;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    const noteBeats = this.melody.length * NOTE_BEATS;
    const playBeat = curBeat - COUNT_IN;
    const xBeat = (b: number) => PAD.l + (b / noteBeats) * plotW;

    // vertical range spans the configured low..high pitch bounds
    const { rangeLowIdx, rangeHighIdx } = this.getSettings();
    const semiMin = RANGE_LADDER[rangeLowIdx].semi;
    const semiMax = RANGE_LADDER[rangeHighIdx].semi;
    const span = semiMax - semiMin || 12;
    const ySemi = (s: number) => PAD.t + (1 - (s - semiMin) / span) * plotH;

    g.clearRect(0, 0, W, H);

    // scale-degree gridlines for every ladder position within the range
    g.font = "11px system-ui";
    for (const pos of RANGE_LADDER) {
      if (pos.semi < semiMin || pos.semi > semiMax) continue;
      const y = ySemi(pos.semi);
      g.strokeStyle = "#23272f";
      g.beginPath();
      g.moveTo(PAD.l, y);
      g.lineTo(W - PAD.r, y);
      g.stroke();
      g.fillStyle = "#6b7280";
      g.fillText(degreeLabel(pos.degree, LABEL), 8, y + 4);
    }

    for (let b = 0; b <= noteBeats; b++) {
      g.strokeStyle = "#1e222a";
      g.beginPath();
      g.moveTo(xBeat(b), PAD.t);
      g.lineTo(xBeat(b), H - PAD.b);
      g.stroke();
    }

    const barH = 16;
    this.melody.forEach((n, i) => {
      const x0 = xBeat(i * NOTE_BEATS) + 2;
      const x1 = xBeat((i + 1) * NOTE_BEATS) - 2;
      const y = ySemi(semitoneOffset(n, MODE));
      g.fillStyle = COLORS[this.verdicts[i]];
      g.beginPath();
      g.roundRect(x0, y - barH / 2, x1 - x0, barH, 5);
      g.fill();
    });

    if (this.trace.length > 1) {
      g.strokeStyle = "#e8c84a";
      g.lineWidth = 2;
      g.beginPath();
      this.trace.forEach((p, i) => {
        const x = xBeat(p.beat);
        const y = ySemi(p.semis);
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      });
      g.stroke();
      g.lineWidth = 1;
    }

    if (this.running && this.latestSemis != null) {
      g.fillStyle = "#ffd84d";
      g.beginPath();
      g.arc(xBeat(playBeat), ySemi(this.latestSemis), 5, 0, Math.PI * 2);
      g.fill();
    }

    if (this.running && playBeat >= 0) {
      const x = xBeat(Math.min(playBeat, noteBeats));
      g.strokeStyle = "#9fb4ff";
      g.beginPath();
      g.moveTo(x, PAD.t);
      g.lineTo(x, H - PAD.b);
      g.stroke();
    }
  }
}

interface Accumulator {
  idx: number;
  consec: number;
  maxConsec: number;
  frames: number;
  degCount: Record<number, number>;
}
function newAcc(idx: number): Accumulator {
  return { idx, consec: 0, maxConsec: 0, frames: 0, degCount: {} };
}

export { LABEL, COUNT_IN };
