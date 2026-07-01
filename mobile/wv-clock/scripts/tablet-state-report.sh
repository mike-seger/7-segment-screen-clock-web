#!/usr/bin/env bash
set -u

SERIAL="${1:-samsung-t220:5555}"
PKG="com.github.mikeseger.wvclock.dev"
ACT="com.github.mikeseger.wvclock.MainActivity"
LOGCAT_FILE="$(dirname "$0")/../../../tmp/logcat1.log"

if [ ! -f "$LOGCAT_FILE" ]; then  
  echo "Error: logcat file not found: $LOGCAT_FILE" >&2
  exit 1
fi

ADB=(adb -s "$SERIAL")

section() {
  echo
  echo "================================================================================"
  echo "== $*"
  echo "================================================================================"
}

run() {
  echo
  echo "\$ ${ADB[*]} shell su -c '$*'"
  "${ADB[@]}" shell su -c "$*" 2>&1
}

run_nosu() {
  echo
  echo "\$ ${ADB[*]} shell $*"
  "${ADB[@]}" shell "$@" 2>&1
}

section "Report metadata"
date
echo "serial=$SERIAL"
echo "package=$PKG"
echo "activity=$PKG/$ACT"
"${ADB[@]}" get-state 2>&1
"${ADB[@]}" shell getprop ro.product.model 2>/dev/null
"${ADB[@]}" shell getprop ro.build.version.release 2>/dev/null
"${ADB[@]}" shell getprop ro.build.version.sdk 2>/dev/null

section "Process state"
run "ps -ef | grep -E 'wvclock|watchdog' | grep -v grep"
run "pidof $PKG; pidof $PKG:watchdog"

section "Display / power state"
run "dumpsys power | sed -n '1,140p'"
run "dumpsys display | grep -Ei 'mScreenState|Display Power|state=|brightness|DisplayDeviceInfo|FLAG|mActiveMode|mCommittedState' | head -120"

section "Wake locks"
run "dumpsys power | sed -n '/Wake Locks:/,/Suspend Blockers:/p'"

section "Wake / sleep history"
run "dumpsys power | sed -n '/WakeUp History/,+35p'"
run "dumpsys power | sed -n '/Sleep timeout/,+20p'"

section "Brightness"
run "settings get system screen_brightness_mode"
run "settings get system screen_brightness"
run "settings get system screen_off_timeout"
run "cat /sys/class/backlight/*/brightness 2>/dev/null"
run "cat /sys/class/backlight/*/max_brightness 2>/dev/null"

section "Current focus / visible windows"
run "dumpsys window | grep -Ei 'mCurrentFocus|mFocusedApp|mDreamingLockscreen|mShowingLockscreen|mScreenOn|NotificationShade|Keyguard|mTopFullscreenOpaqueWindowState'"

section "Activity summary"
run "dumpsys activity activities | grep -Ei 'ResumedActivity|mResumedActivity|topResumedActivity|mLastPausedActivity|mFocusedApp|mCurrentFocus|isSleeping|visible=|mVisibleRequested|mClientVisible|state=|stopped=|mAppStopped|hasVisible|wvclock|launcher|NotificationShade'"

section "MainActivity detailed ActivityRecord"
run "dumpsys activity activities | grep -A80 -B30 '$PKG/$ACT'"

section "Top activity dump"
run "dumpsys activity top | head -180"

section "Tasks / recents involving app"
run "dumpsys activity recents | grep -A20 -B10 '$PKG'"

section "Services"
run "dumpsys activity services $PKG | head -220"
run "dumpsys activity services | grep -A40 -B10 'WatchdogService'"

section "Foreground services / notification state"
run "dumpsys notification | grep -A20 -B10 -Ei 'WV Clock|wvclock|GPU watchdog|$PKG'"

section "Package standby / battery restrictions"
run "cmd appops get $PKG 2>/dev/null | grep -Ei 'SYSTEM_ALERT_WINDOW|RUN_IN_BACKGROUND|START_FOREGROUND|WAKE_LOCK|IGNORE_BATTERY|CAMERA|RECORD_AUDIO' || true"
run "dumpsys deviceidle whitelist | grep '$PKG' || true"
run "cmd package get-app-links $PKG 2>/dev/null || true"

section "Memory"
run "dumpsys meminfo $PKG"
run "dumpsys meminfo $PKG:watchdog"
run "cat /proc/meminfo | head -40"

section "Battery / charging"
run "dumpsys battery"
run "cat /sys/class/power_supply/battery/capacity 2>/dev/null"
run "cat /sys/class/power_supply/battery/status 2>/dev/null"
run "cat /sys/class/power_supply/battery/current_now 2>/dev/null"
run "cat /sys/class/power_supply/battery/voltage_now 2>/dev/null"

section "Recent system logs from device"
run "logcat -d -t 500 | grep -Ei 'WvClock|WatchdogService|wvclock|ActivityTaskManager|ActivityManager|WindowManager|PowerManager|DisplayPower|wake|sleep|timeout|background activity|BAL|startActivity|NotificationShade|launcher|crash|ANR|low memory|kill'"

section "Saved logcat file on host: $LOGCAT_FILE"
if [[ -f "$LOGCAT_FILE" ]]; then
  echo "file exists: $LOGCAT_FILE"
  echo "size: $(wc -c < "$LOGCAT_FILE") bytes"

  echo
  echo "---- important lines ----"
  grep -Ei 'WvClock|WatchdogService|wvclock|ActivityTaskManager|ActivityManager|WindowManager|PowerManager|DisplayPower|wake|sleep|timeout|background activity|BAL|startActivity|NotificationShade|launcher|crash|ANR|low memory|kill|FATAL EXCEPTION|AndroidRuntime' "$LOGCAT_FILE" | tail -500

  echo
  echo "---- last 300 lines ----"
  tail -300 "$LOGCAT_FILE"
else
  echo "missing: $LOGCAT_FILE"
fi

section "Optional recovery command"
echo "adb -s $SERIAL shell su -c 'input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; am start -n $PKG/$ACT'"

