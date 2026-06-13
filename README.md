# singsing

A browser-based **sight-singing** trainer. Read a short melody of scale degrees,
sing it, and get scored note-by-note on pitch — all client-side, no server.

It's built to deploy as a free, open-source PWA on GitHub Pages.

## How it works

- **Pitch detection** runs entirely in the browser via the Web Audio API and
  [`pitchy`](https://github.com/ianprime0509/pitchy) (McLeod pitch method) — no
  WebAssembly, no ML model, no backend.
- **Scoring is octave-agnostic**: you sing in whatever octave is comfortable and
  are scored by scale degree, so the same exercise works for any voice.
- Exercises are stored as **scale degrees** relative to a key + mode, which keeps
  the door open for other modes, accidentals, and movable-do vs. number labels.

The practice loop plays a metronome with a 4-beat count-in, then sweeps a playhead
across a piano-roll of target notes. Each note's time window is scored as a hit,
a wrong note, or a miss, with your live sung pitch drawn over the roll.

## Develop

```bash
npm install
npm run dev      # local dev server
npm run build    # production build to dist/
```

## Status

Early prototype: C major, random ≤4-note melodies, live sliders for tempo, pitch
tolerance, and hold time.

## License

MIT
