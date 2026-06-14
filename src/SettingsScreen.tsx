import { type Settings, DEFAULT_SETTINGS } from "./settings";
import { degreeLabel, NOTE_NAMES } from "./theory";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

export function SettingsScreen({ settings, onChange }: Props) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });

  const toggleDegree = (d: number) => {
    const has = settings.degreePool.includes(d);
    const next = has
      ? settings.degreePool.filter((x) => x !== d)
      : [...settings.degreePool, d].sort((a, b) => a - b);
    if (next.length === 0) return; // keep at least one degree
    set("degreePool", next);
  };

  const toggleKey = (pc: number) => {
    const has = settings.keyPool.includes(pc);
    const next = has
      ? settings.keyPool.filter((x) => x !== pc)
      : [...settings.keyPool, pc].sort((a, b) => a - b);
    set("keyPool", next); // may be emptied via Clear; falls back to C when used
  };

  return (
    <div className="settings">
      <Slider
        label="Tempo"
        unit="BPM"
        min={40}
        max={120}
        step={5}
        value={settings.bpm}
        onChange={(v) => set("bpm", v)}
      />
      <Slider
        label="Pitch tolerance"
        unit="¢"
        min={10}
        max={100}
        step={5}
        value={settings.toleranceCents}
        onChange={(v) => set("toleranceCents", v)}
      />
      <Slider
        label="Hold"
        unit="frames"
        min={1}
        max={40}
        step={1}
        value={settings.holdFrames}
        onChange={(v) => set("holdFrames", v)}
      />
      <Slider
        label="Melody length"
        unit="notes"
        min={2}
        max={8}
        step={1}
        value={settings.melodyLength}
        onChange={(v) => set("melodyLength", v)}
      />

      <div className="field">
        <label>Scale degrees in use</label>
        <div className="degree-toggles">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <button
              key={d}
              className={`toggle${settings.degreePool.includes(d) ? " on" : ""}`}
              onClick={() => toggleDegree(d)}
            >
              {degreeLabel(d, "numbers")}
            </button>
          ))}
        </div>
        <p className="muted small">Melodies are built from the highlighted degrees.</p>
      </div>

      <div className="field">
        <label>Keys</label>
        <div className="degree-toggles">
          {NOTE_NAMES.map((name, pc) => (
            <button
              key={pc}
              className={`toggle${settings.keyPool.includes(pc) ? " on" : ""}`}
              onClick={() => toggleKey(pc)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="row">
          <button className="secondary" onClick={() => set("keyPool", NOTE_NAMES.map((_, i) => i))}>
            Select all
          </button>
          <button className="secondary" onClick={() => set("keyPool", [])}>
            Clear
          </button>
        </div>
        <p className="muted small">
          Each exercise picks a random key from the selected set — narrow it to your vocal range.
        </p>
      </div>

      <div className="field">
        <label>Key reference</label>
        <div className="degree-toggles">
          <button
            className={`toggle wide${settings.playCadence ? " on" : ""}`}
            onClick={() => set("playCadence", !settings.playCadence)}
          >
            Cadence (I–IV–V–I)
          </button>
          <button
            className={`toggle wide${settings.playDrone ? " on" : ""}`}
            onClick={() => set("playDrone", !settings.playDrone)}
          >
            Tonic drone (headphones needed)
          </button>
        </div>
      </div>

      <button className="secondary" onClick={() => onChange({ ...DEFAULT_SETTINGS })}>
        Reset to defaults
      </button>
    </div>
  );
}

interface SliderProps {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}
function Slider({ label, unit, min, max, step, value, onChange }: SliderProps) {
  return (
    <div className="field">
      <label>
        {label} <span className="val">{value}</span> {unit}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
      />
    </div>
  );
}
