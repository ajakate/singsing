// User settings, persisted to localStorage. These are the knobs that used to be
// live sliders on the practice screen; defaults match the tuned prototype.

export interface Settings {
  bpm: number; // tempo
  toleranceCents: number; // how close to a target pitch counts as in tune
  holdFrames: number; // frames the target must be held to score a hit
  degreePool: number[]; // which scale degrees (1..7) melodies may use
  melodyLength: number; // notes per exercise
  // pitch range as indices into RANGE_LADDER (0 = low root, 7 = root, 14 = high
  // root). Scoring stays octave-agnostic; this only affects which actual pitches
  // get generated/previewed/shown.
  rangeLowIdx: number; // 0..7
  rangeHighIdx: number; // 7..14
  keyPool: number[]; // tonic pitch classes (0..11) to pick from each exercise
  playDrone: boolean; // sustain a tonic drone through the exercise
}

export const DEFAULT_SETTINGS: Settings = {
  bpm: 60,
  toleranceCents: 50,
  holdFrames: 12,
  degreePool: [1, 2, 3, 4, 5],
  melodyLength: 4,
  rangeLowIdx: 7, // root
  rangeHighIdx: 14, // high root
  keyPool: [0], // C only by default
  playDrone: false,
};

const STORAGE_KEY = "singsing.settings";

const clamp = (v: number, lo: number, hi: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo;

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    // guard against corrupt pools (degreePool must be non-empty; keyPool may be
    // empty via "Clear" and is guarded at use, but must still be an array)
    if (!Array.isArray(merged.degreePool) || merged.degreePool.length === 0) {
      merged.degreePool = [...DEFAULT_SETTINGS.degreePool];
    }
    if (!Array.isArray(merged.keyPool)) {
      merged.keyPool = [...DEFAULT_SETTINGS.keyPool];
    }
    merged.rangeLowIdx = clamp(merged.rangeLowIdx, 0, 7);
    merged.rangeHighIdx = clamp(merged.rangeHighIdx, 7, 14);
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}
