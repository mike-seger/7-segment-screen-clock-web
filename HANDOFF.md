# Handoff: 7-Segment Screen Clock — Project State

## Project Overview
A 7-segment clock deployed across three platforms from a shared web codebase:

| Platform | Location | Entry point |
|---|---|---|
| Web (browser) | `web/` | `web/index.html` |
| Android (WebView wrapper) | `mobile/wv-clock/` | `MainActivity.kt` |
| Desktop (Electron wrapper) | `desktop/` | `main.js` |

Active branch: **`main`**

---

## Repository Structure

```
web/                        Web clock app (source of truth for UI)
  index.html                Clock rendering, layout transforms, simulation mode
  style.css
  no-cache-server.py        Dev server (Python 3, used by web-test runner too)
  configuration/
    configuration.js        Form bindings, state↔UI sync, applyState()
    persistedState.js       DEFAULT_STATE, normalizeSizingState(), profiles
    menu.html               Lazy-loaded config menu fragment
    menu.js                 Menu open/close logic
    menu.css
    profiles/profiles.js    Built-in profile definitions

mobile/wv-clock/            Android app
  app/src/main/
    java/.../MainActivity.kt   Activity: WebView host, screen wake/sleep control
    java/.../ClockServer.kt    NanoHTTPD server: REST + SSE + state sync
    assets/
      remote-bridge.js        State sync: localStorage ↔ ClockServer
      qrcode.min.js
      web/                    Mirror of web/configuration/ (kept in sync manually)

desktop/
  main.js                   Electron main process
  package.json

web-test/
  gap-contract-runner.mjs   Playwright layout test: gap ratio across viewports
  package.json              { "scripts": { "ui:gap:test": "node gap-contract-runner.mjs" } }
```

---

## Key Architecture

### Layout model (`web/index.html`)
- `applyClockTransform()` — single-pass layout pipeline:
  1. Clear transforms, measure worst-case probe width
  2. Fit date row width = `baseTimeWidth * fr / (fr + 1)`
  3. Set gap between rows via `weightGap` × time-row height
  4. Scale whole clock block to fill viewport
- State params: `weightGap` (default `0.12`), `fr` (default `0.07`), `sizeBudget` (default `0.95`), `secFontFactor` (default `0.625`)
- Old `rowGapFactor` is migrated to `weightGap`/`fr` on load via `normalizeSizingState()`

### State & profiles (`web/configuration/persistedState.js`)
- `DEFAULT_STATE` keys: `numericFont`, `alphaFont`, `colonFont`, `dualFont`, `weightGap`, `fr`, `secFontFactor`, `sizeBudget`, `rotation`, `sleepTimeout`, plus color/brightness settings
- Profiles: built-in undeletable `Default` plus user-created; stored in `localStorage` as `screenClock_profiles`
- State key prefix for sync: `screenClock_`

### Android ClockServer (`ClockServer.kt`)
REST endpoints served on a local port (default 8080):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/clocks` | List discovered clocks on the network |
| GET | `/api/state` | Return current full state map |
| POST | `/api/state` | Update one or more state keys; fires SSE + `onStateChangedListener` |
| POST | `/api/wake` | Wake the screen |
| POST | `/api/sleep` | Put the screen to sleep |
| GET | `/api/events` | SSE stream for real-time state push |

### State sync (`remote-bridge.js`)
- Monkey-patches `localStorage.setItem` to POST `screenClock_*` keys to `/api/state`
- Excluded from sync: `screenClock_menuOpen`, `screenClock_controlledClocks`, `screenClock_timeMasterUrl`
- Listens to `/api/events` (SSE) for incoming state updates and writes them to `localStorage`
- Falls back to polling if SSE is unavailable

### Time master sync (`remote-bridge.js`)
- `screenClock_timeMasterUrl` — URL of clock to treat as NTP master (empty = use local time)
- Algorithm: mini-NTP / Cristian's algorithm with EMA-smoothed offset and rolling best-RTT selection
- Runs an initial burst of probes then switches to a steady-state interval

### Android screen control (`MainActivity.kt`)
- `FLAG_KEEP_SCREEN_ON` keeps display on while app is in foreground
- `wakeScreen()` — restores full brightness + re-enables keep-awake flag + resets sleep timer
- `sleepScreen()` — sets brightness to 0 + clears keep-awake flag + cancels sleep timer
- `POST /api/wake` and `POST /api/sleep` from the web UI or remote control trigger these
- `onStateChangedListener` in `startServer()` parses `screenClock_state` JSON and updates `sleepTimeoutMinutes` on the main thread

### Auto-sleep timer (`MainActivity.kt`)
- Configurable via "Power & Sleep" section in the config menu (`sleepTimeoutSelect`)
- Options: Never / 1 / 2 / 5 / 10 / 60 minutes
- `dispatchTouchEvent` resets the countdown on every touch
- State key `sleepTimeout` (integer, minutes) is synced remotely like all other state

---

## Running Locally

### Web dev server
```bash
python3 web/no-cache-server.py
# or: cd web && python3 -m http.server 8000
```

### Android build
```bash
cd mobile/wv-clock
./gradlew assembleDebug
```

### Electron desktop
```bash
cd desktop
npm install
npm start
```

### Layout gap-contract tests
```bash
cd web-test
npm install
npx playwright install chromium   # first time only
npm run ui:gap:test
# Report written to web/screens/gap-contract-report.json
```

---

## Keeping Mobile Assets in Sync
`mobile/wv-clock/app/src/main/assets/web/configuration/` is a **manual mirror** of `web/configuration/`.  
After editing any file under `web/configuration/`, copy it to the corresponding path under `mobile/wv-clock/app/src/main/assets/web/configuration/`.

---

## Known Open Items
- No unresolved bugs at time of writing.
- The `multi-font` and `new` branches still exist remotely; they may be stale and safe to delete.

---

## Notes for Next Model
- The layout pipeline is single-pass and order-stable; avoid adding extra measurement or re-flow passes.
- `remote-bridge.js` is the sole sync mechanism on Android — do not duplicate sync logic in native code.
- When adding new persisted state keys, add them to `DEFAULT_STATE` in **both** `web/configuration/persistedState.js` and the mobile mirror, and handle migration in `normalizeSizingState()`.
- The `web-test/` directory is self-contained; its `package.json` is separate from any root package.json (there is none).
