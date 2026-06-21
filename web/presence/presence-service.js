(function () {
  "use strict";

  const DEFAULT_CONFIG = {
    enabled: false,
    audioSensitivity: 0.22,
    cameraSensitivity: 0.18,
    lightSensitivity: 0.2,
    dimTimeoutSec: 45,
    darkTimeoutSec: 180,
    decaySec: 1.4,
    historyMax: 1600,
    historyRetentionMs: 7 * 24 * 60 * 60 * 1000
  };

  const HISTORY_STORAGE_KEY = "screenClock_presenceHistory";
  const LOCATION_HOST = (window.location && window.location.hostname ? window.location.hostname : "").toLowerCase();
  const IS_REMOTE_CLIENT = !(LOCATION_HOST === "127.0.0.1" || LOCATION_HOST === "localhost" || LOCATION_HOST === "::1" || LOCATION_HOST === "");
  const ZOOM_LEVELS_DAYS = [0.125, 0.25, 0.5, 1, 3, 5, 7];

  let config = { ...DEFAULT_CONFIG };
  let history = [];
  let displayState = "bright";
  let lastActivityTs = Date.now();
  let lastTriggerTs = 0;

  let started = false;
  let sensorsStarting = false;

  let stateTimer = null;
  let graphTimer = null;

  let micStream = null;
  let audioContext = null;
  let audioAnalyser = null;
  let audioData = null;
  let audioTimer = null;
  let audioRmsBaseline = 0.015;

  let cameraStream = null;
  let videoEl = null;
  let cameraCanvas = null;
  let cameraCtx = null;
  let cameraTimer = null;
  let prevFrame = null;
  let prevLuma = 0.5;
  let prevLumaRaw = 0.5;
  let sensorsRetryTick = 0;

  const sensorHealth = {
    audio: "idle",
    camera: "idle",
    gyro: "idle"
  };

  let touchSensorActive = false;
  let touchListener = null;
  let pointerTouchListener = null;

  let gyroSensorActive = false;
  let gyroNeedsPermission = false;
  let gyroPermissionPending = false;
  let motionListener = null;
  let orientationListener = null;
  let gyroMotionBaseline = 0;
  let lastOrientation = null;
  let resumeAudioListenerBound = false;

  const typeColor = {
    audio: "#ff7e67",
    camera: "#4ecdc4",
    light: "#ffd166",
    touch: "#f8961e",
    gyro: "#00bbf9",
    "state-bright": "#66dc80",
    "state-dim": "#8899aa",
    "state-dark": "#404850",
    manual: "#9b7bff"
  };

  function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function hasLegacyGetUserMedia() {
    return !!(navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia);
  }

  function getUserMediaCompat(constraints) {
    if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") {
      return navigator.mediaDevices.getUserMedia(constraints);
    }
    const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
    if (!legacy) {
      return Promise.reject(new Error("getUserMedia unsupported"));
    }
    return new Promise((resolve, reject) => {
      legacy.call(navigator, constraints, resolve, reject);
    });
  }

  function supportsDeviceMotionEvents() {
    return (
      typeof window.DeviceMotionEvent !== "undefined"
      || typeof window.ondevicemotion !== "undefined"
    );
  }

  function supportsDeviceOrientationEvents() {
    return (
      typeof window.DeviceOrientationEvent !== "undefined"
      || typeof window.ondeviceorientation !== "undefined"
    );
  }

  function sanitizeConfig(input) {
    const src = input && typeof input === "object" ? input : {};
    const decayFromMs = Number(src.cooldownMs) / 1000;
    const decayFallback = Number.isFinite(decayFromMs) && decayFromMs > 0
      ? decayFromMs
      : DEFAULT_CONFIG.decaySec;
    const next = {
      enabled: !!src.enabled,
      audioSensitivity: clamp(src.audioSensitivity, 0, 1, DEFAULT_CONFIG.audioSensitivity),
      cameraSensitivity: clamp(src.cameraSensitivity, 0, 1, DEFAULT_CONFIG.cameraSensitivity),
      lightSensitivity: clamp(src.lightSensitivity, 0, 1, DEFAULT_CONFIG.lightSensitivity),
      dimTimeoutSec: Math.round(clamp(src.dimTimeoutSec, 5, 3600, DEFAULT_CONFIG.dimTimeoutSec)),
      darkTimeoutSec: Math.round(clamp(src.darkTimeoutSec, 10, 7200, DEFAULT_CONFIG.darkTimeoutSec)),
      decaySec: clamp(src.decaySec, 0.2, 10, decayFallback),
      historyMax: Math.round(clamp(src.historyMax, 100, 5000, DEFAULT_CONFIG.historyMax)),
      historyRetentionMs: Math.round(clamp(src.historyRetentionMs, 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000, DEFAULT_CONFIG.historyRetentionMs))
    };

    if (next.darkTimeoutSec <= next.dimTimeoutSec) {
      next.darkTimeoutSec = next.dimTimeoutSec + 5;
    }

    return next;
  }

  function pruneHistory() {
    const now = Date.now();
    const minTs = now - config.historyRetentionMs;
    history = history.filter(evt => evt && Number(evt.ts) >= minTs);
    if (history.length > config.historyMax) {
      history.splice(0, history.length - config.historyMax);
    }
  }

  function saveHistory(forceWrite) {
    if (!forceWrite && IS_REMOTE_CLIENT) {
      return;
    }
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch (_) {
      // Ignore quota/persistence failures.
    }
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      history = parsed
        .filter(evt => evt && typeof evt === "object")
        .map(evt => ({
          ts: Number(evt.ts) || 0,
          type: String(evt.type || "unknown"),
          value: Number.isFinite(Number(evt.value)) ? Number(evt.value) : null
        }))
        .filter(evt => evt.ts > 0);
    } catch (_) {
      history = [];
    }
    pruneHistory();
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (_) {
      // Ignore dispatch errors in restricted runtimes.
    }
  }

  function setSensorHealth(name, state) {
    if (!name) return;
    sensorHealth[name] = String(state || "unknown");
  }

  function updateBodyDisplayClass() {
    const body = document.body;
    if (!body) return;
    body.classList.remove("presence-display-bright", "presence-display-dim", "presence-display-dark");
    body.classList.add(`presence-display-${displayState}`);
  }

  function pushEvent(type, value) {
    const evt = {
      ts: Date.now(),
      type: String(type || "unknown"),
      value: Number.isFinite(Number(value)) ? Number(value) : null
    };
    history.push(evt);
    pruneHistory();
    saveHistory();
    emit("presence-service-event", {
      event: evt,
      displayState,
      lastActivityTs
    });
  }

  function setDisplayState(nextState, reasonType) {
    const normalized = nextState === "dark" ? "dark" : (nextState === "dim" ? "dim" : "bright");
    if (normalized === displayState) return;
    displayState = normalized;
    updateBodyDisplayClass();
    pushEvent(`state-${displayState}`, null);
    emit("presence-service-state", {
      displayState,
      reason: reasonType || "timer",
      lastActivityTs
    });
  }

  function evaluateDisplayState() {
    if (!config.enabled) {
      if (displayState !== "bright") setDisplayState("bright", "disabled");
      return;
    }

    const inactiveMs = Date.now() - lastActivityTs;
    if (inactiveMs >= config.darkTimeoutSec * 1000) {
      setDisplayState("dark", "timeout");
      return;
    }
    if (inactiveMs >= config.dimTimeoutSec * 1000) {
      setDisplayState("dim", "timeout");
      return;
    }
    setDisplayState("bright", "activity");
  }

  function registerActivity(type, strength) {
    if (!config.enabled) return false;
    const now = Date.now();
    if (now - lastTriggerTs < config.decaySec * 1000) return false;
    lastTriggerTs = now;
    lastActivityTs = now;
    if (displayState !== "bright") {
      setDisplayState("bright", type);
    }
    pushEvent(type, strength);
    return true;
  }

  function teardownAudio() {
    if (audioTimer) {
      clearInterval(audioTimer);
      audioTimer = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(track => {
        try { track.stop(); } catch (_) {}
      });
      micStream = null;
    }
    if (audioContext) {
      try { audioContext.close(); } catch (_) {}
      audioContext = null;
    }
    audioAnalyser = null;
    audioData = null;
    audioRmsBaseline = 0.015;
    if (resumeAudioListenerBound) {
      window.removeEventListener("pointerdown", tryResumeAudioContext, { passive: true });
      window.removeEventListener("touchstart", tryResumeAudioContext, { passive: true });
      window.removeEventListener("visibilitychange", handleVisibilityAudioResume);
      resumeAudioListenerBound = false;
    }
  }

  function handleVisibilityAudioResume() {
    if (document.visibilityState === "visible") {
      void tryResumeAudioContext();
    }
  }

  async function tryResumeAudioContext() {
    if (!audioContext || typeof audioContext.resume !== "function") return;
    if (audioContext.state === "running") return;
    try {
      await audioContext.resume();
    } catch (_) {
      // Ignore resume failures caused by browser autoplay policies.
    }
  }

  async function startAudio() {
    if (!navigator.mediaDevices && !hasLegacyGetUserMedia()) {
      setSensorHealth("audio", "unsupported:mediaDevices");
      return;
    }
    if (micStream || audioTimer) return;

    try {
      setSensorHealth("audio", "starting");
      micStream = await getUserMediaCompat({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        setSensorHealth("audio", "unsupported:AudioContext");
        return;
      }

      audioContext = new Ctx();
      await tryResumeAudioContext();
      const source = audioContext.createMediaStreamSource(micStream);
      audioAnalyser = audioContext.createAnalyser();
      audioAnalyser.fftSize = 1024;
      audioAnalyser.smoothingTimeConstant = 0.35;
      audioData = new Uint8Array(audioAnalyser.fftSize);
      source.connect(audioAnalyser);

      if (!resumeAudioListenerBound) {
        window.addEventListener("pointerdown", tryResumeAudioContext, { passive: true });
        window.addEventListener("touchstart", tryResumeAudioContext, { passive: true });
        window.addEventListener("visibilitychange", handleVisibilityAudioResume);
        resumeAudioListenerBound = true;
      }

      audioTimer = setInterval(() => {
        if (!audioAnalyser || !audioData) return;
        if (audioContext && audioContext.state !== "running") {
          void tryResumeAudioContext();
          return;
        }
        audioAnalyser.getByteTimeDomainData(audioData);

        let sum = 0;
        for (let i = 0; i < audioData.length; i++) {
          const centered = (audioData[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / audioData.length);
        audioRmsBaseline = audioRmsBaseline * 0.94 + rms * 0.06;

        const relativeSpike = audioRmsBaseline > 0.0001 ? (rms - audioRmsBaseline) / audioRmsBaseline : 0;
        const triggerThreshold = 1.2 - config.audioSensitivity * 1.05;
        const absoluteDelta = Math.max(0, rms - audioRmsBaseline);
        const absoluteThreshold = 0.012 - config.audioSensitivity * 0.009;
        const absoluteRmsThreshold = 0.026 - config.audioSensitivity * 0.018;

        if (rms > 0.008 && (relativeSpike > triggerThreshold || absoluteDelta > absoluteThreshold || rms > absoluteRmsThreshold)) {
          registerActivity("audio", Number(relativeSpike.toFixed(3)));
        }
      }, 120);
      setSensorHealth("audio", "on");
    } catch (_) {
      const errName = _ && _.name ? String(_.name) : "error";
      setSensorHealth("audio", `off:${errName}`);
      teardownAudio();
    }
  }

  function teardownCamera() {
    if (cameraTimer) {
      clearInterval(cameraTimer);
      cameraTimer = null;
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => {
        try { track.stop(); } catch (_) {}
      });
      cameraStream = null;
    }
    if (videoEl) {
      try { videoEl.pause(); } catch (_) {}
      videoEl.srcObject = null;
      videoEl = null;
    }
    cameraCanvas = null;
    cameraCtx = null;
    prevFrame = null;
    prevLuma = 0.5;
    prevLumaRaw = 0.5;
  }

  async function startCamera() {
    if (!navigator.mediaDevices && !hasLegacyGetUserMedia()) {
      setSensorHealth("camera", "unsupported:mediaDevices");
      return;
    }
    if (cameraStream || cameraTimer) return;

    try {
      setSensorHealth("camera", "starting");
      const requestCamera = async (facingMode) => {
        return getUserMediaCompat({
          video: {
            facingMode,
            width: { ideal: 320 },
            height: { ideal: 240 }
          },
          audio: false
        });
      };

      try {
        cameraStream = await requestCamera("user");
      } catch (_) {
        cameraStream = await requestCamera("environment");
      }

      videoEl = document.createElement("video");
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.autoplay = true;
      videoEl.srcObject = cameraStream;
      await videoEl.play();

      cameraCanvas = document.createElement("canvas");
      cameraCanvas.width = 64;
      cameraCanvas.height = 36;
      cameraCtx = cameraCanvas.getContext("2d", { willReadFrequently: true });
      if (!cameraCtx) {
        setSensorHealth("camera", "off:no-2d-context");
        return;
      }

      cameraTimer = setInterval(() => {
        if (!cameraCtx || !videoEl || videoEl.readyState < 2) return;

        cameraCtx.drawImage(videoEl, 0, 0, cameraCanvas.width, cameraCanvas.height);
        const frame = cameraCtx.getImageData(0, 0, cameraCanvas.width, cameraCanvas.height).data;

        let lumaSum = 0;
        let motionSum = 0;
        let brightPixels = 0;
        let count = 0;

        for (let i = 0; i < frame.length; i += 16) {
          const r = frame[i];
          const g = frame[i + 1];
          const b = frame[i + 2];
          const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          lumaSum += luma;
          if (luma >= 0.82) brightPixels++;

          if (prevFrame) {
            const dr = Math.abs(r - prevFrame[i]);
            const dg = Math.abs(g - prevFrame[i + 1]);
            const db = Math.abs(b - prevFrame[i + 2]);
            motionSum += (dr + dg + db) / (3 * 255);
          }

          count++;
        }

        if (count === 0) return;

        const avgLuma = lumaSum / count;
        const motion = prevFrame ? (motionSum / count) : 0;
        const lightDelta = Math.abs(avgLuma - prevLuma);
        const lightStepUp = Math.max(0, avgLuma - prevLumaRaw);
        const brightFraction = brightPixels / count;

        const cameraThreshold = 0.09 - config.cameraSensitivity * 0.07;
        const lightThreshold = 0.03 - config.lightSensitivity * 0.028;
        const brightSceneThreshold = 0.62 - config.lightSensitivity * 0.22;
        const brightFractionThreshold = 0.55 - config.lightSensitivity * 0.35;
        const flashStepThreshold = 0.04 - config.lightSensitivity * 0.035;

        let triggered = false;
        if (motion > cameraThreshold) {
          triggered = registerActivity("camera", Number(motion.toFixed(3)));
        }
        if (!triggered && lightDelta > lightThreshold) {
          triggered = registerActivity("light", Number(lightDelta.toFixed(3)));
        }
        if (!triggered && lightStepUp > flashStepThreshold) {
          triggered = registerActivity("light", Number(lightStepUp.toFixed(3)));
        }
        if (!triggered && avgLuma > brightSceneThreshold && brightFraction > brightFractionThreshold) {
          triggered = registerActivity("light", Number(avgLuma.toFixed(3)));
        }

        prevLuma = prevLuma * 0.7 + avgLuma * 0.3;
        prevLumaRaw = avgLuma;
        prevFrame = new Uint8ClampedArray(frame);
      }, 260);
      setSensorHealth("camera", "on");
    } catch (_) {
      const errName = _ && _.name ? String(_.name) : "error";
      setSensorHealth("camera", `off:${errName}`);
      teardownCamera();
    }
  }

  function teardownTouch() {
    if (touchListener) {
      window.removeEventListener("touchstart", touchListener, { passive: true });
      touchListener = null;
    }
    if (pointerTouchListener) {
      window.removeEventListener("pointerdown", pointerTouchListener, { passive: true });
      pointerTouchListener = null;
    }
    touchSensorActive = false;
  }

  function normalizeAngleDelta(next, prev) {
    let delta = Math.abs(next - prev);
    if (delta > 180) delta = 360 - delta;
    return delta;
  }

  function teardownGyro() {
    if (motionListener) {
      window.removeEventListener("devicemotion", motionListener, { passive: true });
      motionListener = null;
    }
    if (orientationListener) {
      window.removeEventListener("deviceorientation", orientationListener, { passive: true });
      orientationListener = null;
    }
    gyroSensorActive = false;
    gyroMotionBaseline = 0;
    lastOrientation = null;
  }

  function evaluateGyroSignal(score) {
    if (!Number.isFinite(score) || score <= 0) return;
    const threshold = 1.7 - config.cameraSensitivity * 1.2;
    if (score > threshold) {
      registerActivity("gyro", Number(score.toFixed(3)));
    }
  }

  function attachGyroListeners() {
    teardownGyro();

    if (supportsDeviceMotionEvents()) {
      motionListener = (evt) => {
        const src = evt && (evt.acceleration || evt.accelerationIncludingGravity);
        const rotation = evt && evt.rotationRate;

        let rotationScore = 0;
        if (rotation) {
          const ra = Number(rotation.alpha);
          const rb = Number(rotation.beta);
          const rg = Number(rotation.gamma);
          if (Number.isFinite(ra) || Number.isFinite(rb) || Number.isFinite(rg)) {
            const a = Number.isFinite(ra) ? Math.abs(ra) : 0;
            const b = Number.isFinite(rb) ? Math.abs(rb) : 0;
            const g = Number.isFinite(rg) ? Math.abs(rg) : 0;
            rotationScore = (a + b + g) / 200;
            evaluateGyroSignal(rotationScore);
          }
        }

        if (!src) return;

        const ax = Number(src.x);
        const ay = Number(src.y);
        const az = Number(src.z);
        if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) return;

        const motionMag = Math.sqrt(ax * ax + ay * ay + az * az);
        if (!Number.isFinite(motionMag)) return;

        if (gyroMotionBaseline <= 0) gyroMotionBaseline = motionMag;
        gyroMotionBaseline = gyroMotionBaseline * 0.9 + motionMag * 0.1;
        const delta = Math.max(0, motionMag - gyroMotionBaseline);
        evaluateGyroSignal(Math.max(delta, rotationScore));
      };
      window.addEventListener("devicemotion", motionListener, { passive: true });
    }

    if (supportsDeviceOrientationEvents()) {
      orientationListener = (evt) => {
        const alpha = Number(evt && evt.alpha);
        const beta = Number(evt && evt.beta);
        const gamma = Number(evt && evt.gamma);
        if (!Number.isFinite(alpha) || !Number.isFinite(beta) || !Number.isFinite(gamma)) return;

        if (!lastOrientation) {
          lastOrientation = { alpha, beta, gamma };
          return;
        }

        const da = normalizeAngleDelta(alpha, lastOrientation.alpha);
        const db = Math.abs(beta - lastOrientation.beta);
        const dg = Math.abs(gamma - lastOrientation.gamma);
        lastOrientation = { alpha, beta, gamma };

        const rotationScore = (da + db + dg) / 90;
        evaluateGyroSignal(rotationScore);
      };
      window.addEventListener("deviceorientation", orientationListener, { passive: true });
    }

    gyroSensorActive = !!(motionListener || orientationListener);
  }

  async function maybeRequestGyroPermission() {
    if (!gyroNeedsPermission || gyroPermissionPending || gyroSensorActive) return;

    const canRequestMotion = typeof window.DeviceMotionEvent !== "undefined"
      && typeof window.DeviceMotionEvent.requestPermission === "function";
    const canRequestOrientation = typeof window.DeviceOrientationEvent !== "undefined"
      && typeof window.DeviceOrientationEvent.requestPermission === "function";
    if (!canRequestMotion && !canRequestOrientation) {
      gyroNeedsPermission = false;
      attachGyroListeners();
      emit("presence-service-sensors", getStatus());
      return;
    }

    gyroPermissionPending = true;
    try {
      let granted = false;

      if (canRequestMotion) {
        try {
          const motionPermission = await window.DeviceMotionEvent.requestPermission();
          granted = granted || motionPermission === "granted";
        } catch (_) {
          // Ignore permission request failures.
        }
      }

      if (canRequestOrientation) {
        try {
          const orientationPermission = await window.DeviceOrientationEvent.requestPermission();
          granted = granted || orientationPermission === "granted";
        } catch (_) {
          // Ignore permission request failures.
        }
      }

      if (granted) {
        gyroNeedsPermission = false;
        attachGyroListeners();
      }
    } finally {
      gyroPermissionPending = false;
      emit("presence-service-sensors", getStatus());
    }
  }

  function startTouch() {
    if (touchSensorActive) return;

    touchListener = () => {
      void maybeRequestGyroPermission();
      registerActivity("touch", 1);
    };
    window.addEventListener("touchstart", touchListener, { passive: true });

    if (typeof window.PointerEvent !== "undefined") {
      pointerTouchListener = (evt) => {
        if (evt && evt.pointerType && evt.pointerType !== "touch") return;
        void maybeRequestGyroPermission();
        registerActivity("touch", 1);
      };
      window.addEventListener("pointerdown", pointerTouchListener, { passive: true });
    }

    touchSensorActive = true;
  }

  function startGyro() {
    if (gyroSensorActive) return;

    const hasDeviceMotion = supportsDeviceMotionEvents();
    const hasDeviceOrientation = supportsDeviceOrientationEvents();
    if (!hasDeviceMotion && !hasDeviceOrientation) {
      setSensorHealth("gyro", "unsupported:no-api");
      return;
    }

    const needsPermission =
      (hasDeviceMotion && typeof window.DeviceMotionEvent.requestPermission === "function")
      || (hasDeviceOrientation && typeof window.DeviceOrientationEvent.requestPermission === "function");

    if (needsPermission) {
      gyroNeedsPermission = true;
      setSensorHealth("gyro", "needs-user-gesture");
      return;
    }

    gyroNeedsPermission = false;
    attachGyroListeners();
    setSensorHealth("gyro", gyroSensorActive ? "on" : "off:no-listener");
  }

  async function ensureSensors() {
    if (sensorsStarting) return;
    sensorsStarting = true;
    try {
      await Promise.allSettled([startAudio(), startCamera(), startTouch(), startGyro()]);
    } finally {
      sensorsStarting = false;
      emit("presence-service-sensors", getStatus());
    }
  }

  function stopSensors() {
    teardownAudio();
    teardownCamera();
    teardownTouch();
    teardownGyro();
    emit("presence-service-sensors", getStatus());
  }

  function start() {
    if (started) return;
    started = true;
    lastActivityTs = Date.now();
    lastTriggerTs = 0;
    setDisplayState("bright", "start");

    if (stateTimer) clearInterval(stateTimer);
    stateTimer = setInterval(evaluateDisplayState, 1000);

    if (graphTimer) clearInterval(graphTimer);
    graphTimer = setInterval(() => {
      sensorsRetryTick++;
      if (config.enabled && sensorsRetryTick % 3 === 0) {
        if (!micStream || !cameraStream || !gyroSensorActive) {
          ensureSensors();
        }
      }
      emit("presence-service-tick", getStatus());
    }, 1000);

    ensureSensors();
  }

  function stop() {
    started = false;
    if (stateTimer) {
      clearInterval(stateTimer);
      stateTimer = null;
    }
    if (graphTimer) {
      clearInterval(graphTimer);
      graphTimer = null;
    }
    stopSensors();
    setSensorHealth("audio", "idle");
    setSensorHealth("camera", "idle");
    setSensorHealth("gyro", "idle");
    setDisplayState("bright", "stop");
  }

  function setConfig(partial) {
    const merged = sanitizeConfig({ ...config, ...(partial || {}) });
    const enabledChanged = merged.enabled !== config.enabled;
    config = merged;

    if (config.enabled) {
      if (!started) {
        start();
      } else {
        ensureSensors();
        evaluateDisplayState();
      }
    } else if (enabledChanged || started) {
      stop();
    }

    pruneHistory();
    saveHistory();

    emit("presence-service-config", { config: { ...config } });
  }

  function forceWake(sourceType) {
    const source = sourceType || "manual";
    if (!config.enabled) return false;
    const now = Date.now();
    lastTriggerTs = now - config.decaySec * 1000;
    return registerActivity(source, 1);
  }

  function getHistory(windowMs) {
    const span = Number(windowMs);
    if (!Number.isFinite(span) || span <= 0) return history.slice();
    const minTs = Date.now() - span;
    return history.filter(evt => evt.ts >= minTs);
  }

  function clearHistory() {
    history = [];
    lastTriggerTs = 0;
    saveHistory(true);
    emit("presence-service-history-cleared", getStatus());
    emit("presence-service-tick", getStatus());
  }

  function reloadHistoryFromStorage() {
    loadHistory();
  }

  function getStatus() {
    return {
      enabled: !!config.enabled,
      displayState,
      lastActivityTs,
      lastEvent: history.length ? history[history.length - 1] : null,
      sensors: {
        audio: !!micStream,
        camera: !!cameraStream,
        touch: !!touchSensorActive,
        gyro: !!gyroSensorActive
      },
      sensorHealth: {
        ...sensorHealth
      },
      config: { ...config }
    };
  }

  function renderGraph(canvas, options) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const parentW = canvas.parentElement && canvas.parentElement.clientWidth ? canvas.parentElement.clientWidth : 320;
    const width = Math.max(280, parentW - 4);
    const height = 146;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    pruneHistory();

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const eventTs = history.map(evt => Number(evt.ts)).filter(ts => Number.isFinite(ts));
    const earliestTs = eventTs.length ? Math.min(...eventTs) : now;
    const collectedSpanMs = Math.max(0, now - earliestTs);
    const collectedDays = collectedSpanMs / dayMs;

    let visibleDays = ZOOM_LEVELS_DAYS[0];
    for (const d of ZOOM_LEVELS_DAYS) {
      if (collectedDays >= d) visibleDays = d;
    }

    const windowMs = visibleDays * dayMs;
    const startTs = now - windowMs;
    const bucketCount = Math.max(90, Math.min(320, Math.floor((width - 72) / 2)));
    const buckets = new Array(bucketCount).fill(null).map(() => ({}));

    for (const evt of history) {
      if (!evt || evt.ts < startTs || evt.ts > now) continue;
      const ratio = (evt.ts - startTs) / windowMs;
      const idx = Math.max(0, Math.min(bucketCount - 1, Math.floor(ratio * bucketCount)));
      buckets[idx][evt.type] = true;
    }

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0c1017";
    ctx.fillRect(0, 0, width, height);

    const padL = 58;
    const padR = 10;
    const padT = 8;
    const padB = 22;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const labelColorDefault = "#8ca1b7";
    const labelColorOn = "#66dc80";
    const labelColorWarn = "#ffd166";
    const labelColorOff = "#ff7e67";
    const labelColorUnsupported = "#6f8396";

    function sensorLaneColor(lane) {
      const healthKey = lane === "light" ? "camera" : lane;
      const isOn = lane === "audio"
        ? !!micStream
        : lane === "camera"
          ? !!cameraStream
          : lane === "light"
            ? !!cameraStream
            : lane === "touch"
              ? !!touchSensorActive
              : lane === "gyro"
                ? !!gyroSensorActive
                : false;

      if (isOn) return labelColorOn;

      const h = String(sensorHealth[healthKey] || "off");
      if (h.startsWith("needs-")) return labelColorWarn;
      if (h.startsWith("unsupported:")) return labelColorUnsupported;
      if (h.startsWith("off:")) return labelColorOff;
      return labelColorDefault;
    }

    function laneLabelColor(lane) {
      if (lane === "state-bright" || lane === "state-dim" || lane === "state-dark") {
        return lane === `state-${displayState}`
          ? (typeColor[lane] || "#dbe7f2")
          : "#6f8396";
      }
      return sensorLaneColor(lane);
    }

    const lanes = ["audio", "camera", "light", "touch", "gyro", "state-bright", "state-dim", "state-dark"];
    const laneH = plotH / lanes.length;

    ctx.strokeStyle = "#213043";
    ctx.lineWidth = 1;
    for (let i = 0; i <= lanes.length; i++) {
      const y = padT + i * laneH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
    }

    ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "right";
    lanes.forEach((lane, idx) => {
      const y = padT + idx * laneH + laneH * 0.68;
      const label = lane.replace("state-", "");
      ctx.fillStyle = laneLabelColor(lane);
      ctx.fillText(label, padL - 6, y);
    });

    const barW = plotW / bucketCount;
    for (let i = 0; i < bucketCount; i++) {
      const bucket = buckets[i];
      if (!bucket) continue;
      const x = padL + i * barW;
      lanes.forEach((lane, laneIdx) => {
        if (!bucket[lane]) return;
        const y0 = padT + laneIdx * laneH + 1;
        const h = Math.max(2, laneH - 2);
        ctx.fillStyle = typeColor[lane] || "#d0d0d0";
        ctx.fillRect(x, y0, Math.max(1, Math.ceil(barW)), h);
      });
    }

    const visibleStartMs = startTs;
    const visibleEndMs = now;
    const visibleSpanMs = Math.max(1, visibleEndMs - visibleStartMs);

    ctx.save();
    ctx.strokeStyle = "#1e2e42";
    ctx.fillStyle = "#8ca1b7";
    ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
    let majorTickMs;
    if (visibleDays < 0.25) {
      majorTickMs = 30 * 60 * 1000;
    } else if (visibleDays < 0.5) {
      majorTickMs = 60 * 60 * 1000;
    } else if (visibleDays < 1) {
      majorTickMs = 2 * 60 * 60 * 1000;
    } else if (visibleDays <= 1) {
      majorTickMs = 3 * 60 * 60 * 1000;
    } else {
      majorTickMs = dayMs;
    }
    const maxTickMarks = 8;
    const maxTickLabels = 3;
    const highestValidTickMs = Math.floor(visibleEndMs / majorTickMs) * majorTickMs;
    const ticksInRange = highestValidTickMs >= visibleStartMs
      ? Math.floor((highestValidTickMs - visibleStartMs) / majorTickMs) + 1
      : 0;
    const stepMultiplier = ticksInRange > maxTickMarks
      ? Math.ceil(ticksInRange / maxTickMarks)
      : 1;
    const tickStepMs = majorTickMs * stepMultiplier;
    const tickTimesDesc = [];
    if (ticksInRange > 0) {
      for (let t = highestValidTickMs; t >= visibleStartMs && tickTimesDesc.length < maxTickMarks; t -= tickStepMs) {
        tickTimesDesc.push(t);
      }
    }
    const tickTimes = tickTimesDesc.reverse();
    if (!tickTimes.length) tickTimes.push(visibleEndMs);
    const labelCount = Math.min(maxTickLabels, tickTimes.length);
    const labelIndices = new Set();
    if (labelCount === 1) {
      labelIndices.add(tickTimes.length - 1);
    } else {
      const step = Math.ceil(tickTimes.length / labelCount);
      for (let i = 0; i < labelCount; i++) {
        labelIndices.add(tickTimes.length - 1 - i * step);
      }
    }

    for (let tickIndex = 0; tickIndex < tickTimes.length; tickIndex++) {
      const ts = tickTimes[tickIndex];
      const ratio = Math.max(0, Math.min(1, (ts - visibleStartMs) / visibleSpanMs));
      const x = padL + ratio * plotW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      if (labelIndices.has(tickIndex)) {
        const d = new Date(ts);
        const label = visibleDays <= 1
          ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
          : `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
        const labelX = Math.max(padL + 14, Math.min(padL + plotW - 14, x));
        ctx.textAlign = "center";
        ctx.fillText(label, labelX, height - 6);
      }
    }
    ctx.restore();

    ctx.strokeStyle = "#334a64";
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
  }

  window.PresenceService = {
    init(initialConfig) {
      loadHistory();
      setConfig({ ...DEFAULT_CONFIG, ...(initialConfig || {}) });
      updateBodyDisplayClass();
      evaluateDisplayState();
      return getStatus();
    },
    setConfig,
    forceWake,
    getConfig() {
      return { ...config };
    },
    getStatus,
    getHistory,
    clearHistory,
    reloadHistoryFromStorage,
    renderGraph,
    stop
  };
})();
