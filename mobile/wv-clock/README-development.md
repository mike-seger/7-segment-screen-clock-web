# wv-clock development setup

This document captures the local setup that was verified to build the Android
wrapper on macOS.

## Requirements

- JDK 17
- Android SDK platform 34
- Android build-tools 34.0.0
- Android platform-tools
- Android SDK command-line tools (current)

## SDK setup

Use the same SDK root that Gradle resolves via `local.properties` or the
`ANDROID_SDK_ROOT` environment variable. On macOS with Android Studio, that is
usually:

```bash
$HOME/Library/Android/sdk
```

Install the SDK components used by this project into that SDK root:

```bash
source "$HOME/.sdkman/bin/sdkman-init.sh"
sdk use java 17.0.19-librca
yes | sdkmanager --sdk_root="$HOME/Library/Android/sdk" --licenses >/dev/null
sdkmanager --sdk_root="$HOME/Library/Android/sdk" \
  "cmdline-tools;latest" \
  "platform-tools" \
  "platforms;android-34" \
  "build-tools;34.0.0"
```

If you prefer a Homebrew-managed SDK, use that path consistently for both the
SDK packages and `sdk.dir`. Mixing an older `sdkmanager` with newer SDK package
metadata is what typically produces the SDK XML version warning.

## Project SDK path

Gradle needs a `local.properties` file in this directory with:

```properties
sdk.dir=/Users/<you>/Library/Android/sdk
```

If you move the SDK, update this path or set `ANDROID_HOME` / `ANDROID_SDK_ROOT`.

## Build

From this directory:

```bash
source "$HOME/.sdkman/bin/sdkman-init.sh"
sdk use java 17.0.19-librca
./gradlew assembleDebug
```

## Deploy to a device

```bash
source "$HOME/.sdkman/bin/sdkman-init.sh"
sdk use java 17.0.19-librca
./gradlew deployToDevice -Pdevice=-
```

Use `-Pdevice=<serial>` to target one device explicitly.

If you remove the app first with `adb uninstall com.github.mikeseger.wvclock`,
`adb` may report `Unknown package` when the app is already gone. That is
harmless and does not block the next deploy.

## Notes

- The repo README still describes the broader project layout and runtime
  behavior.
- The build on this machine resolves the SDK from `ANDROID_SDK_ROOT` when it is
  set, even if `local.properties` is absent.
- If Gradle prints `This version only understands SDK XML versions up to 3 but
  an SDK XML file of version 4 was encountered`, the build can still succeed,
  but the local SDK installation is stale or mixed-version. Install
  `cmdline-tools;latest` into the active SDK root, or update Android Studio and
  let it refresh the SDK components there.