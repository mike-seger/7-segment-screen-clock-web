# Presence Detection Requirements

## Goal

Provide near-instant presence detection for the clock display so the screen can:

- brighten immediately when someone is likely nearby,
- dim after a period of inactivity,
- eventually go fully dark after prolonged silence/inactivity.

The intent is presence approximation, not strict identity or keyword recognition.

## Architecture Direction

The presence-detection feature should be implemented as a distinct module with clear internal separation.

Expected architectural direction:

- keep the presence-detection logic separated from unrelated clock and battery logic,
- integrate the feature fully into the main app and the `Presence Service` settings tab,
- keep module boundaries clean enough that the feature could later be extracted into a separate app if desired.

This means the implementation should favor separable responsibilities such as:

- sensor input collection,
- event detection and normalization,
- history recording,
- display-state decisions,
- UI configuration and visualization.

The goal is not to build a separate app now, but to avoid coupling the implementation so tightly to the current app structure that later extraction becomes difficult.

## Primary Wake Triggers

The system should react quickly to any of these environmental changes:

- sudden lighting change,
- change in the environment image seen by the camera,
- sudden louder audio signal,
- user touch interaction with the screen,
- device motion detected from gyro/orientation sensors.

No specific spoken keyword is required. Any sudden voice or noise can count as a wake trigger.

Examples of valid audio wake events:

- hand clap,
- finger snap,
- a spoken word,
- any other sudden loud transient.

## Audio Requirements

Audio detection is especially important when the camera does not see change at night.

Expected behavior:

- if the environment is visually static at night, a clap, snap, or spoken word should still brighten the clock immediately,
- long silence should gradually reduce the display state from bright to dim and then to fully dark,
- no keyword spotting is required; threshold-based sudden noise detection is acceptable.

## Camera / Visual Requirements

The camera may be used to detect environmental image change as a presence hint.

Expected behavior:

- if the camera sees a meaningful scene change, the clock should brighten immediately,
- if there is no visible change, especially at night, the audio path must still be able to wake the display.

This is motion / scene-change detection, not face recognition.

## Light Change Requirements

Ambient lighting change may also be used as an instant wake hint.

Expected behavior:

- sudden light changes can brighten the display,
- light change is a presence heuristic, not the only source of truth.

## Display State Behavior

The display should support at least these states:

- bright,
- dim,
- fully dark.

Expected behavior:

- presence trigger -> brighten immediately,
- inactivity / silence for some time -> dim,
- longer inactivity / silence -> fully dark,
- a new valid trigger while dim or dark -> wake immediately.

Exact timeout values have not been finalized yet.

## Configuration UI Requirements

Presence detection should have its own dedicated settings tab in the configuration UI.

Expected tab requirements:

- tab title: `Presence Service`,
- tab icon glyph: `nest_wake_on_approach`,
- main enable control: a top-level checkbox labeled `Enable`.

Expected behavior:

- when the main checkbox is unchecked, presence detection should be disabled,
- when disabled, related tuning controls should be visually disabled or greyed out,
- when enabled, the service-specific tuning controls should become active.

## Tuning Parameter Requirements

The `Presence Service` tab should expose tuning parameters for the detection logic.

At minimum, the UI should be designed to host configurable thresholds and timeouts for:

- audio trigger sensitivity,
- camera / image-change sensitivity,
- ambient light change sensitivity,
- dim timeout,
- dark / screen-off timeout,
- any debounce or cooldown values needed to suppress trigger spam.

Exact parameter names and defaults have not been finalized yet, but the UI should be built around tuneable rather than hardcoded behavior.

## Presence Event History Requirements

Presence detection should maintain a history of sensor-trigger events.

Unlike the battery graph, this history is event-based rather than sampled at a fixed interval.

The recorded history should include different sensor-originated events such as:

- audio triggers,
- camera / scene-change triggers,
- light-change triggers,
- touch triggers,
- gyro / orientation-motion triggers,
- optionally display-state transitions such as dim or dark.

## Presence Graph Requirements

The `Presence Service` tab should include a graph similar in spirit to the battery history graph.

Expected graph behavior:

- show presence-related event history over time,
- distinguish different event sources visually,
- render short-lived events as spikes even if the event duration is much shorter than the visible time resolution,
- preserve visibility of transient events even when zoomed out.

This graph should represent event occurrence, not continuous sampled values only.

## Event Aggregation / Visualization Notes

Because presence events may be brief and irregular, the history model should not depend solely on fixed-frequency sampling.

Expected handling:

- event timestamps should be recorded when triggers happen,
- rendering should ensure that short events are still visible at coarse zoom levels,
- if events are aggregated into time buckets for display, the bucket should retain the fact that at least one event occurred,
- short-lived events should not disappear merely because they fall below the nominal graph time resolution.

## Platform / Permission Constraints

Root is not required for the discussed approach.

The design should work on a normal Android device using standard app permissions such as:

- microphone access for audio-trigger detection,
- camera access for scene-change detection.

Root would only be relevant for deeper system-level control or bypassing standard Android restrictions, but it is not a functional requirement for the presence-detection feature itself.

## Non-Requirements So Far

The following are explicitly not required based on the discussion so far:

- a specific wake word,
- user identification,
- face recognition,
- exact occupancy measurement,
- root-only implementation.

## Suggested Service Responsibility

A background Android component can own this feature and:

- monitor microphone input for sudden audio spikes,
- monitor camera frames for scene change,
- optionally monitor light changes,
- maintain last-activity timing,
- control or signal the display brightness state.

This was previously referred to as a custom `PresenceService`, meaning an app-defined background service rather than a built-in Android class.

---

## Implementation Status (2026-06-20)

### Completed Features

✅ **Core Presence Service** (`web/presence/presence-service.js` + `MainActivity.kt`)
- Audio, camera, touch, gyro, and light-change detection
- Event history recording with timestamps
- Display state management (bright, dim, dark)
- Dimming and darkening timeouts with configurable sensitivity

✅ **Native Fallback Sensors** (Android fallback when web APIs unavailable)
- Native audio recording with level-based presence detection
- Native gyro/accelerometer motion sensing
- Native light sensor monitoring
- Automatic fallback activation on remote browsers with unsupported Web APIs

✅ **Settings Panel** (`web/configuration/configuration.js` + UI)
- Dedicated "Presence Service" tab with enable/disable checkbox
- Real-time sensor status display (audio on/off, camera on/off, touch on/off, gyro on/off)
- Configurable sensitivity sliders for audio, camera, light, and motion
- Dim/dark timeout controls
- Clear spikes button for history reset
- Live last-trigger event display with timestamp

✅ **Presence Graph**
- Timeline graph showing event spikes by type (audio, light, camera, motion, touch)
- Color-coded event visualization
- Preserves transient events in graph rendering
- Automatic history synchronization between app and remote browsers

✅ **Cross-Client State Sync**
- Device app syncs presence history to shared server state
- Remote browsers poll and receive history updates via bridge
- Native sensor status published to shared localStorage for remote UI feedback
- Immediate UI refresh when history arrives (no multi-minute delays)

### Recent Fixes (2026-06-20)

**Remote Client Sync Issues**
- ✅ Added guard to prevent remote clients from overwriting device-captured sensor history
  - `mobile/wv-clock/app/src/main/assets/remote-bridge.js:334` — blocks presence history POST from remote
- ✅ Added immediate UI refresh on history sync
  - `mobile/wv-clock/app/src/main/assets/remote-bridge.js:407-416` — reloads and re-renders on history update
- ✅ Enabled polling fallback for all clients (not just device)
  - `mobile/wv-clock/app/src/main/assets/remote-bridge.js:475` — all clients poll as reliability fallback
- ✅ Prevented remote clients from auto-saving generated state history
  - `web/presence/presence-service.js:16-20` — remote save guard with force-write for clear actions

**Native Sensor Status Sharing**
- ✅ Published native presence status into shared localStorage after config changes
  - `mobile/wv-clock/app/src/main/java/com/github/mikeseger/wvclock/MainActivity.kt:432-442` — publish method
  - Lifecycle hooks updated at: lines 426, 556, 562, 580, 978

**UI Rendering Issues**
- ✅ Remote sensors now show native-fallback indicator when shared status is available
  - `web/configuration/configuration.js:526-550` — shared native status lookup and fallback rendering

**Clock Layout Stability**
- ✅ Fixed unstable clock x-position when seconds digits change
  - `web/index.html:1667` — fixed time-line width using worst-case measurement
  - `web/index.html:1759-1788` — disabled horizontal offset recalculation (hOffsetVp = 0)
  - Result: clock x-position stays stable regardless of digit width changes

**Display Darkness Recovery**
- ✅ Added direct user-interaction wake path
  - `web/index.html:92-98` — `wakePresenceFromInteraction()` function
  - `web/index.html:99-102` — wake listeners on pointer/mouse/touch/wheel events
  - Result: display cannot get stuck in dark mode from missing sensor events

### Known Limitations

- History sync latency depends on polling interval (~5-10 seconds) when SSE is unavailable
- Remote browsers receive sensor status updates asynchronously; status may lag by a few seconds
- Native sensor availability depends on Android device capabilities (microphone, gyro, light sensor permissions required)

## Agreed UI/Graph Adjustments

The following adjustments are part of the implemented requirements:

- Presence graph window is dynamic and follows the same zoom strategy and time-axis labeling behavior as the battery graph.
- Presence history persistence targets the same long-span retention window as the battery graph (multi-day history, not short-lived session-only data).
- The presence graph no longer uses a manual graph-window slider.
- Presence graph category labels use plain names (`bright`, `dim`, `dark`) without a `state:` prefix.
- The presence graph is placed near the top of the tab, directly after the main `Enable` checkbox.
- Presence sliders are rendered in single-line rows with labels on the left.
- Slider rows are aligned so all slider tracks begin at a shared x-position.
- UI text abbreviates `sensitivity` as `sens.`.
- UI text replaces `cooldown` with `decay`.
- Trigger decay is configured in seconds with default `1.4s`.
- Presence graph should not render explicit window-size caption text (for example `3h window`); only timeline axis labels should communicate time context.
- Presence tuning includes presets in a single dropdown on the right side of the `TUNING` header (`Min`, `Medium`, `Max`, with `Custom` when manually tuned).
- Presence graph includes a clear action that removes current spikes and clears persisted presence history so manual tests can be visually reset immediately.