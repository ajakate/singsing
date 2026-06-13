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
import type { Settings } from "./settings";

const KEY: Key = { tonicPc: 0, mode: "major" }; // C major (fixed for now)
const TONIC_MIDI = 60; // C4, reference octave
const LABEL = "numbers" as const;
const COUNT_IN = 4; // beats before the first note
const NOTE_BEATS = 1; // quarter notes
const SEMI_RANGE = 12; // vertical span of the roll, in semitones above tonic
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
}

const PAD = { l: 34, r: 12, t: 14, b: 14 };
const DEGREE_SEMIS = [0, 2, 4, 5, 7, 9, 11, 12]; // major-scale rows + octave
const COLORS: Record<Verdict, string> = {
  pending: "#3b5bdb",
  hit: "#2f9e57",
  wrong: "#c0392b",
  missed: "#555b66",
};

export class PracticeController {
  private ctx2d: CanvasRenderingContext2D;
  private engine = new PitchEngine();
  private audioCtx?: AudioContext;

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
    this.engine.stop();
    this.audioCtx?.close();
  }

  // --- settings accessors ---
  private get bpm() { return this.getSettings().bpm; }
  private get tol() { return this.getSettings().toleranceCents; }
  private get holdFrames() { return this.getSettings().holdFrames; }
  private get beatDur() { return 60 / this.bpm; }

  private ctx(): AudioContext {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    return this.audioCtx;
  }

  private curBeat() {
    return (this.ctx().currentTime - this.startTime) / this.beatDur;
  }

  // --- public actions ---
  regenerate() {
    const { melodyLength, degreePool } = this.getSettings();
    this.melody = generateMelody(melodyLength, [...degreePool].sort((a, b) => a - b));
    this.resetRun();
    this.cb.onResult(null);
    this.draw(-1);
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
    const c = this.ctx();
    await c.resume();
    if (!this.engine.isLive) await this.engine.start(c, (s) => this.onSample(s.hz));

    this.resetRun();
    this.cb.onResult(null);
    this.startTime = c.currentTime + 0.15;
    const totalBeats = COUNT_IN + this.melody.length * NOTE_BEATS;
    for (let b = 0; b < totalBeats; b++) {
      scheduleClick(c, this.startTime + b * this.beatDur, b % COUNT_IN === 0);
    }
    scheduleTone(c, TONIC_MIDI, this.startTime, this.beatDur * COUNT_IN * 0.9);

    this.running = true;
    this.cb.onRunning(true);
  }

  stop() {
    this.finishRun();
  }

  preview() {
    const c = this.ctx();
    c.resume();
    const t0 = c.currentTime + 0.1;
    scheduleTone(c, TONIC_MIDI, t0, 0.4);
    this.melody.forEach((n, i) => {
      scheduleTone(c, TONIC_MIDI + semitoneOffset(n, KEY.mode), t0 + 0.5 + i * this.beatDur, this.beatDur * 0.9);
    });
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
      const cents = centsToPitchClass(hz, degreeToPitchClass(target, KEY));
      this.acc.frames++;
      const d = this.nearestDegree(hz);
      this.acc.degCount[d] = (this.acc.degCount[d] ?? 0) + 1;
      if (Math.abs(cents) <= this.tol) {
        this.acc.consec++;
        this.acc.maxConsec = Math.max(this.acc.maxConsec, this.acc.consec);
      } else this.acc.consec = 0;

      const semis = this.displaySemis(hz, semitoneOffset(target, KEY.mode));
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
    const raw = ((hzToMidiFloat(hz) - KEY.tonicPc) % 12 + 12) % 12;
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
      const c = Math.abs(centsToPitchClass(hz, degreeToPitchClass({ degree: d, octave: 0 }, KEY)));
      if (c < bestErr) {
        bestErr = c;
        best = d;
      }
    }
    return best;
  }

  // --- rendering ---
  private fitCanvas() {
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
    const ySemi = (s: number) => PAD.t + (1 - s / SEMI_RANGE) * plotH;

    g.clearRect(0, 0, W, H);

    g.font = "11px system-ui";
    for (let i = 0; i < DEGREE_SEMIS.length; i++) {
      const y = ySemi(DEGREE_SEMIS[i]);
      g.strokeStyle = "#23272f";
      g.beginPath();
      g.moveTo(PAD.l, y);
      g.lineTo(W - PAD.r, y);
      g.stroke();
      g.fillStyle = "#6b7280";
      g.fillText(degreeLabel(i === 7 ? 1 : i + 1, LABEL), 8, y + 4);
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
      const y = ySemi(semitoneOffset(n, KEY.mode));
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
