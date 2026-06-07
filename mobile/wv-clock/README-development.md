# wv-clock development setup

This document captures the local setup that was verified to build the Android
wrapper on macOS.

## Requirements

- JDK 17
- Android SDK platform 34
- Android build-tools 34.0.0
- Android platform-tools

## Homebrew setup

Install the Android command-line tools:

```bash
brew install --cask android-commandlinetools
```

The cask installs the SDK root at:

```bash
/opt/homebrew/share/android-commandlinetools
```

Install the SDK components used by this project:

```bash
source "$HOME/.sdkman/bin/sdkman-init.sh"
sdk use java 17.0.19-librca
yes | sdkmanager --sdk_root=/opt/homebrew/share/android-commandlinetools --licenses >/dev/null
sdkmanager --sdk_root=/opt/homebrew/share/android-commandlinetools "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

## Project SDK path

Gradle needs a `local.properties` file in this directory with:

```properties
sdk.dir=/opt/homebrew/share/android-commandlinetools
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

## Notes

- The repo README still describes the broader project layout and runtime
  behavior.
- The current setup works with the Homebrew SDK root above and JDK 17 from
  SDKMAN.
- Gradle may print a warning about SDK XML version differences; the build still
  succeeds.