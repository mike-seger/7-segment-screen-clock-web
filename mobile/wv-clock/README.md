# wv-clock — Android WebView wrapper for the 7-segment clock

A minimal Android app that

1. displays the [`web/`](../../web) clock app full-screen in a WebView, and
2. hosts a small embedded HTTP server so the same web app — including its
   configuration menu — can be opened in any browser on the same network and
   **remote-controls the on-device clock in real time**.

The web app's source is reused as-is; the app simply bundles `web/` into its
assets at build time.

## Features

- Fullscreen, immersive WebView (no status / navigation bar).
- The year-click "toggle browser fullscreen" handler is suppressed inside the
  app (no accidental fullscreen toggles).
- Embedded HTTP server (NanoHTTPD) on port `8765` that serves the web app and
  a small sync API.
- Live two-way sync of the configuration state (every `localStorage` key
  prefixed with `screenClock_`) between the WebView and any number of remote
  browsers via Server-Sent Events.
- App icon is generated from [`web/icon.svg`](../../web/icon.svg) (also wired
  up as the web favicon).

## Project layout

```
mobile/wv-clock/
├── build.gradle.kts          # root build
├── settings.gradle.kts
├── gradle.properties
├── gradle/wrapper/gradle-wrapper.properties
└── app/
    ├── build.gradle.kts      # app module + syncWebAssets + deployToDevice
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/
        │   ├── remote-bridge.js          # injected into served index.html
        │   └── web/                      # copied from ../../web at build time
        ├── java/com/github/mikeseger/wvclock/
        │   ├── MainActivity.kt           # WebView + immersive mode
        │   └── ClockServer.kt            # NanoHTTPD server + SSE state sync
        └── res/
            ├── drawable/
            │   ├── ic_launcher_background.xml
            │   └── ic_launcher_foreground.xml   # derived from icon.svg
            ├── mipmap-anydpi-v26/
            │   ├── ic_launcher.xml
            │   └── ic_launcher_round.xml
            └── values/
                ├── strings.xml
                └── themes.xml
```

## Prerequisites

- Android SDK with platform 34 and build-tools installed.
- JDK 17.
- Android device (or emulator) with USB debugging enabled — connected via
  `adb` for the deploy task.
- Gradle 8.5 (the wrapper is configured but the wrapper JAR is **not**
  committed). Bootstrap the wrapper once with a system Gradle, **or** simply
  open the project in Android Studio and let it sync (it will generate the
  wrapper for you).

To bootstrap the wrapper from a command line that already has Gradle ≥ 8.5
installed:

```bash
cd mobile/wv-clock
gradle wrapper
```

After that, all commands below can use `./gradlew` instead of `gradle`.

## Build

```bash
cd mobile/wv-clock
./gradlew assembleDebug
```

The `syncWebAssets` task automatically copies the repository's
[`web/`](../../web) folder into `app/src/main/assets/web/` before each build,
so any change to the web app is picked up by a normal rebuild.

## Run on a connected device

```bash
cd mobile/wv-clock
./gradlew deployToDevice
```

This task:

1. depends on `installDebug`, so it builds and installs the debug APK on the
   single attached device (use `adb devices` to confirm), and
2. launches `com.github.mikeseger.wvclock/.MainActivity`.

If multiple devices are attached, pass an `ANDROID_SERIAL` env var (handled
by `adb`) or use `adb -s <serial> ...` manually.

## Remote-control usage

On startup the app shows a Toast with the URL to use, for example:

```
Remote control: http://192.168.1.42:8765/
```

Open that URL from any browser on the same network:

- The remote browser shows the same clock.
- Opening the configuration menu in the remote browser and changing any
  setting is **immediately reflected on the on-device clock**, and vice
  versa.

### How it works

- `ClockServer` (NanoHTTPD on port 8765) serves the bundled `web/` assets.
- When it serves `index.html` it injects a single `<script src="/remote-bridge.js">`
  tag right before `</head>`.
- `remote-bridge.js` (in [app/src/main/assets/remote-bridge.js](app/src/main/assets/remote-bridge.js)):
  - wraps `localStorage.setItem` / `removeItem` and POSTs every change of a
    `screenClock_*` key to `POST /api/state`;
  - subscribes to `GET /api/events` (SSE) and applies every remote update
    locally, then re-invokes the web app's `loadState()` /
    `applyClockTransform()` if present;
  - on first connect, pulls the current state snapshot via `GET /api/state`;
  - additionally swallows clicks on `#year`, so the "click year ⇒ toggle
    browser fullscreen" handler in `web/index.html` is disabled inside the
    WebView (it would do nothing useful there and could confuse remote
    users).

The server keeps an in-memory snapshot of every `screenClock_*` key it has
seen. That snapshot is sent to every newly connecting SSE client so a fresh
remote browser comes up in the same state as the on-device clock. The
snapshot is lost when the app process is killed; persistence on the device
itself continues to rely on the WebView's own `localStorage`.

## Configuration

| Setting        | Where                                              | Default |
| -------------- | -------------------------------------------------- | ------- |
| HTTP port      | `MainActivity.port`                                | `8765`  |
| Package / app ID | `app/build.gradle.kts` (`applicationId`, `namespace`) | `com.github.mikeseger.wvclock` |
| Min SDK        | `app/build.gradle.kts`                             | 26 (Android 8.0) |

If you change the port, also update any bookmarks pointing at the remote URL.

## Icon

The app icon is an Android adaptive icon (API 26+):

- background: solid black ([ic_launcher_background.xml](app/src/main/res/drawable/ic_launcher_background.xml))
- foreground: the clock arc and hands transcribed from
  [web/icon.svg](../../web/icon.svg) into a `VectorDrawable`
  ([ic_launcher_foreground.xml](app/src/main/res/drawable/ic_launcher_foreground.xml)).

The same `icon.svg` is referenced as the favicon from
[web/index.html](../../web/index.html) and
[web/index-embedded.html](../../web/index-embedded.html).

## Caveats

- The embedded HTTP server is intended for use on a trusted local network. It
  has no authentication; anyone who can reach the device on port 8765 can
  change clock settings.
- `usesCleartextTraffic="true"` is enabled so the WebView can reach
  `http://127.0.0.1:8765/` and remote browsers can reach the device. No HTTPS
  is provided.
- The wrapper JAR is intentionally not checked in; see "Prerequisites" above
  for bootstrapping options.
