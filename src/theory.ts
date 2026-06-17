// ---------------------------------------------------------------------------
// Scale-degree music theory core.
//
// This is the abstraction the whole app rests on. Exercises are stored as
// scale DEGREES (1..7) relative to a key center + mode -- never as absolute
// notes. Transposing keys, switching modes, or relabeling (numbers vs
// movable-do vs la-based minor) therefore only touches the small translation
// functions below; the exercise data itself never changes.
// ---------------------------------------------------------------------------

export const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

// A mode is just the semitone offsets of its 7 degrees from the tonic.
// Adding Dorian/Aeolian/etc. later is a one-line addition here.
export const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  // naturalMinor: [0, 2, 3, 5, 7, 8, 10],
} as const;
export type ModeName = keyof typeof MODES;

export type Accidental = -1 | 0 | 1; // flat / natural / sharp

export interface DegreeNote {
  degree: number; // 1..7
  octave: number; // relative octave offset; 0 = the tonic's octave
  accidental?: Accidental;
  /** beats; rhythm is here so the data model is ready for it, ignored in v0 */
  duration?: number;
}

export interface Key {
  /** pitch class of the tonic: 0 = C, 1 = C#, ... 11 = B */
  tonicPc: number;
  mode: ModeName;
}

// --- frequency <-> midi helpers ---------------------------------------------

export const midiToHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);
export const hzToMidiFloat = (hz: number): number =>
  69 + 12 * Math.log2(hz / 440);

// --- degree <-> pitch class -------------------------------------------------

/** Pitch class (0..11) of a scale degree in a given key, octave-agnostic. */
export function degreeToPitchClass(note: DegreeNote, key: Key): number {
  const semis = MODES[key.mode][note.degree - 1] + (note.accidental ?? 0);
  return (((key.tonicPc + semis) % 12) + 12) % 12;
}

/**
 * Signed cents error between a sung frequency and a target pitch class,
 * OCTAVE-AGNOSTIC: the nearest octave of the target is chosen automatically,
 * so an octave-doubling detector error (E3 read as E4) still scores correctly.
 * Returns a value in (-600, 600]; 0 = perfectly in tune.
 */
export function centsToPitchClass(hz: number, targetPc: number): number {
  const diff = hzToMidiFloat(hz) - targetPc;
  let r = ((diff % 12) + 12) % 12; // 0..12
  if (r > 6) r -= 12; // fold to (-6, 6] semitones
  return r * 100;
}

/** Signed semitone offset of a degree note from the tonic, octave-aware. */
export function semitoneOffset(note: DegreeNote, mode: ModeName): number {
  return MODES[mode][note.degree - 1] + (note.accidental ?? 0) + 12 * note.octave;
}

/** Sung frequency -> semitones above the tonic, folded into one octave [0,12). */
export function foldedSemitones(hz: number, tonicPc: number): number {
  return (((hzToMidiFloat(hz) - tonicPc) % 12) + 12) % 12;
}

/**
 * Scale positions from the low root (tonic an octave down) to the high root
 * (tonic an octave up), used to bound the pitch range of generated notes by
 * scale step. Index 7 is the root (degree 1, octave 0).
 */
export const RANGE_LADDER: { degree: number; octave: number; semi: number }[] = (() => {
  const ladder: { degree: number; octave: number; semi: number }[] = [];
  for (const octave of [-1, 0]) {
    for (let degree = 1; degree <= 7; degree++) {
      ladder.push({ degree, octave, semi: semitoneOffset({ degree, octave }, "major") });
    }
  }
  ladder.push({ degree: 1, octave: 1, semi: 12 }); // high root
  return ladder;
})();

/**
 * Random melody for practice: `length` notes drawn from `pool` (scale degrees),
 * spanning pitches between `lowSemi` and `highSemi` (semitones from the tonic).
 * Notes are picked by walking the pitch-sorted candidate set within ±2 positions
 * so motion stays stepwise even across octaves.
 */
export function generateMelody(
  length = 4,
  pool = [1, 2, 3, 4, 5],
  lowSemi = 0,
  highSemi = 12,
): DegreeNote[] {
  const candidates: DegreeNote[] = [];
  for (let octave = -1; octave <= 1; octave++) {
    for (const degree of pool) {
      const semi = semitoneOffset({ degree, octave }, "major");
      if (semi >= lowSemi && semi <= highSemi) candidates.push({ degree, octave });
    }
  }
  // fall back to the tonic-octave pool if the range/pool combination is empty
  if (candidates.length === 0) for (const degree of pool) candidates.push({ degree, octave: 0 });
  candidates.sort((a, b) => semitoneOffset(a, "major") - semitoneOffset(b, "major"));

  const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
  let idx = Math.floor(Math.random() * candidates.length);
  const out: DegreeNote[] = [{ ...candidates[idx] }];
  for (let i = 1; i < length; i++) {
    const near: number[] = [];
    for (let j = Math.max(0, idx - 2); j <= Math.min(candidates.length - 1, idx + 2); j++) {
      if (j !== idx) near.push(j);
    }
    idx = near.length ? pick(near) : idx;
    out.push({ ...candidates[idx] });
  }
  return out;
}

// --- labels (pure display layer) --------------------------------------------

export type LabelStyle = "numbers" | "movableDo";

const MOVABLE_DO = ["do", "re", "mi", "fa", "sol", "la", "ti"];

export function degreeLabel(degree: number, style: LabelStyle): string {
  return style === "numbers" ? String(degree) : MOVABLE_DO[degree - 1];
}
