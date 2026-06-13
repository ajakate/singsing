import { useEffect, useState } from "react";
import { type Settings, loadSettings, saveSettings } from "./settings";
import { PracticeScreen } from "./PracticeScreen";
import { SettingsScreen } from "./SettingsScreen";

type Screen = "practice" | "settings";

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [screen, setScreen] = useState<Screen>("practice");

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  return (
    <main>
      <header className="topbar">
        <h1>
          singsing <span className="muted">— sight-singing practice</span>
        </h1>
        {screen === "practice" ? (
          <button className="secondary" onClick={() => setScreen("settings")}>
            ⚙ Settings
          </button>
        ) : (
          <button className="secondary" onClick={() => setScreen("practice")}>
            ← Back
          </button>
        )}
      </header>

      {screen === "practice" ? (
        <PracticeScreen settings={settings} />
      ) : (
        <SettingsScreen settings={settings} onChange={setSettings} />
      )}
    </main>
  );
}
