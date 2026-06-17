import { PitchDetector } from "pitchy";
import { midiToHz } from "./theory";

export interface PitchSample {
  hz: number | null; // null when no confident pitch this frame
  clarity: number; // 0..1 confidence from MPM
  rms: number; // signal level, for the energy gate / VU meter
}

// Thresholds tuned from the cdedc.wav experiment: clarity rejects unvoiced
// frames, the RMS gate rejects breaths/silence that otherwise get junk pitches.
const MIN_CLARITY = 0.9;
const MIN_RMS = 0.01;

export class PitchEngine {
  private raf = 0;
  private stream?: MediaStream;
  private live = false;
  get isLive(): boolean {
    return this.live;
  }

  /**
   * Attach mic pitch tracking to an existing (shared) AudioContext so the
   * detector clock matches the metronome/playhead clock. Does NOT own the
   * context; the caller closes it.
   */
  async start(ctx: AudioContext, onSample: (s: PitchSample) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      },
    });

    const source = ctx.createMediaStreamSource(this.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    const detector = PitchDetector.forFloat32Array(analyser.fftSize);
    detector.minVolumeDecibels = -30;
    const sampleRate = ctx.sampleRate;
    this.live = true;

    const tick = () => {
      if (!this.live) return; // guard: don't reschedule after stop()
      analyser.getFloatTimeDomainData(buf);

      let sumSq = 0;
      for (const v of buf) sumSq += v * v;
      const rms = Math.sqrt(sumSq / buf.length);

      const [hz, clarity] = detector.findPitch(buf, sampleRate);
      const confident = clarity >= MIN_CLARITY && rms >= MIN_RMS;
      onSample({ hz: confident ? hz : null, clarity, rms });

      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(): void {
    this.live = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
  }
}

/** Schedule a metronome click at AudioContext time `at`. */
export function scheduleClick(
  ctx: AudioContext,
  at: number,
  accent = false,
  out: AudioNode = ctx.destination,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = accent ? 1500 : 900;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.4 : 0.2, at + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + 0.08);
}

/**
 * Schedule a sustained drone (steady level, not the decaying envelope of
 * scheduleTone) for one or more midi notes — used to hold the tonic under an
 * exercise. Kept quiet by default to limit speaker bleed into the mic.
 */
export function scheduleDrone(
  ctx: AudioContext,
  midis: number[],
  at: number,
  dur: number,
  level = 0.1,
  out: AudioNode = ctx.destination,
): void {
  const attack = 0.1;
  const release = 0.3;
  const sustainUntil = Math.max(at + attack, at + dur - release);
  for (const midi of midis) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = midiToHz(midi);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + attack);
    gain.gain.setValueAtTime(level, sustainUntil);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }
}

/**
 * Schedule a piano-ish note: a few decaying harmonics through a lowpass that
 * closes over the note, with a struck envelope (fast attack, exponential decay
 * to a low sustain, release). Warmer and less buzzy than scheduleTone, and
 * rings longer so chords don't sound staccato. No samples / dependencies.
 */
export function schedulePiano(
  ctx: AudioContext,
  midi: number,
  at: number,
  dur: number,
  out: AudioNode = ctx.destination,
  level = 0.25,
): void {
  const freq = midiToHz(midi);
  const env = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(Math.min(freq * 7, 9000), at);
  filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 2.5, 900), at + dur);
  filter.connect(env).connect(out);

  // fundamental + a few quieter harmonics gives a warmer, bell-to-mellow tone
  const partials: [number, number][] = [
    [1, 1],
    [2, 0.45],
    [3, 0.18],
    [4, 0.08],
  ];
  const oscs: OscillatorNode[] = [];
  for (const [mult, g] of partials) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq * mult;
    const gain = ctx.createGain();
    gain.gain.value = g;
    osc.connect(gain).connect(filter);
    oscs.push(osc);
  }

  const attack = 0.006;
  const sustain = Math.max(level * 0.2, 0.0001);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(level, at + attack);
  env.gain.exponentialRampToValueAtTime(sustain, at + Math.min(dur * 0.6, 0.8));
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);

  for (const osc of oscs) {
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }
}

export interface DroneHandle {
  stop: () => void;
}

/**
 * Start an open-ended drone that plays until the returned handle's stop() is
 * called (for a press-and-hold button). Fades in/out to avoid clicks.
 */
export function startDrone(
  ctx: AudioContext,
  midis: number[],
  out: AudioNode = ctx.destination,
  level = 0.1,
): DroneHandle {
  const now = ctx.currentTime;
  const voices = midis.map((midi) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = midiToHz(midi);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + 0.08);
    osc.connect(gain).connect(out);
    osc.start(now);
    return { osc, gain };
  });
  return {
    stop() {
      const t = ctx.currentTime;
      for (const { osc, gain } of voices) {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
        osc.stop(t + 0.13);
      }
    },
  };
}

/** Schedule a pitched tone (reference / melody preview) at time `at`. */
export function scheduleTone(
  ctx: AudioContext,
  midi: number,
  at: number,
  dur = 0.5,
  out: AudioNode = ctx.destination,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = midiToHz(midi);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}
