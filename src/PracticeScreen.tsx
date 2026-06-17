import { useEffect, useRef, useState } from "react";
import { COUNT_IN, PracticeController, type RunResult } from "./practice";
import { degreeLabel } from "./theory";
import type { Settings } from "./settings";

const VERDICT_TAG = { hit: "✓", wrong: "✗", missed: "·", pending: "?" } as const;

export function PracticeScreen({ settings }: { settings: Settings }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<PracticeController | null>(null);
  // keep latest settings reachable by the imperative controller
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [lit, setLit] = useState(0);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [keyName, setKeyName] = useState("C major");

  // create the controller once
  useEffect(() => {
    const ctrl = new PracticeController(canvasRef.current!, () => settingsRef.current, {
      onLit: setLit,
      onRunning: setRunning,
      onResult: setResult,
      onKey: setKeyName,
    });
    ctrlRef.current = ctrl;
    return () => ctrl.dispose();
  }, []);

  // regenerate the exercise when the degree pool, length, or key set changes
  useEffect(() => {
    ctrlRef.current?.regenerate();
  }, [settings.melodyLength, settings.degreePool.join(","), settings.keyPool.join(",")]);

  return (
    <>
      <p className="muted">
        Key: <strong>{keyName}</strong> · sing in any octave · green = hit, red = wrong, gray = missed
      </p>

      <div className="countin">
        {Array.from({ length: COUNT_IN }, (_, i) => (
          <div key={i} className={`dot${i < lit ? " lit" : ""}`}>
            {i + 1}
          </div>
        ))}
      </div>

      <canvas ref={canvasRef} id="roll" />

      <div className="controls">
        <button
          className="secondary"
          disabled={running}
          onClick={() => ctrlRef.current?.regenerate()}
        >
          🎲 New melody
        </button>
        <button
          className="secondary"
          disabled={running}
          onClick={() => ctrlRef.current?.playCadence()}
        >
          🎹 Cadence
        </button>
        <button
          className="secondary"
          disabled={running}
          onClick={() => ctrlRef.current?.preview()}
        >
          🔊 Preview
        </button>
        <button
          className="secondary hold"
          disabled={running}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            ctrlRef.current?.startHeldDrone();
          }}
          onPointerUp={() => ctrlRef.current?.stopHeldDrone()}
          onPointerCancel={() => ctrlRef.current?.stopHeldDrone()}
        >
          🎵 Hold for tonic drone
        </button>
        <button
          onClick={() => (running ? ctrlRef.current?.stop() : ctrlRef.current?.start())}
        >
          {running ? "⏹ Stop" : "🎤 Start & sing"}
        </button>
      </div>

      <div className="score">
        {result && (
          <>
            <strong>
              Score: {result.hits}/{result.total} correct
            </strong>{" "}
            ·{" "}
            {result.notes.map((n, i) => (
              <span key={i} className={`tag ${n.verdict}`}>
                {degreeLabel(n.degree, "numbers")}
                {VERDICT_TAG[n.verdict]}
                {n.verdict === "wrong" && n.sang ? ` (sang ${n.sang})` : ""}
                {i < result.notes.length - 1 ? "  " : ""}
              </span>
            ))}
          </>
        )}
      </div>
    </>
  );
}
