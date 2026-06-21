// ---------------- STATE ----------------

const DEFAULT_STATE = {
    numericFont: "Digital7Mono",
    alphaFont: "Digital7Mono",
    colonFont: "Digital7Mono",
    multiFont: true,
    numericScale: 100,
    alphaScale: 100,
    colonScale: 100,
    numericOffset: 0,
    alphaOffset: 0,
    colonOffset: 0,
    weightGap: 0.12,
    fr: 0.07,
    dateColor: "#fb04ad",
    timeColor: "#04fb62",
    colonColor: "#04fb62",
    inheritColonColor: true,
    secColor: "#00aaff",
    secFontFactor: 0.625,
    secColonDistance: 0,
    secOffset: 0,
    sizeBudget: 0.95,
    ntpServer: "",
    sleepTimeout: 0,
    padHours: false,
    recenterLeadingOne: false,
    glowEnabled: false,
    glowAmount: 5,
    glowIntensity: 3,
    visibility: {
        weekday: true, day: true, month: true, year: true,
        hour: true, minute: true, seconds: true, millis: false
    },
    millisDecimals: 3,
    batterySettings: {
        enabled: false,
        switchIp: "",
        thresholdOffPct: 85,
        thresholdOnPct: 40
    },
    presenceSettings: {
        enabled: false,
        audioSensitivity: 0.22,
        cameraSensitivity: 0.18,
        lightSensitivity: 0.2,
        dimTimeoutSec: 45,
        darkTimeoutSec: 180,
        decaySec: 1.4
    }
};

function getDefaultBuiltinProfile() {
    if (!Array.isArray(window.BUILTIN_PROFILES) || window.BUILTIN_PROFILES.length === 0) return null;
    return window.BUILTIN_PROFILES.find(p => p && p.default === true)
        || window.BUILTIN_PROFILES[0]
        || null;
}

function getDefaultProfileName() {
    const p = getDefaultBuiltinProfile();
    return (p && p.name) ? p.name : "";
}

{
    const _b = getDefaultBuiltinProfile();
    if (_b && _b.data) Object.assign(DEFAULT_STATE, _b.data);
}

let state = { ...DEFAULT_STATE };

const STORAGE_KEY_CURRENT  = "screenClock_state";
const STORAGE_KEY_PROFILES = "screenClock_profiles";   // JSON array of names
const STORAGE_KEY_DEBUG     = "screenClock_debug";
const STORAGE_KEY_GPU_INFO  = "screenClock_gpuInfo";
const STORAGE_KEY_CONTAINER = "screenClock_container";
const STORAGE_KEY_BATTERY_SETTINGS = "screenClock_batterySettings";
const STORAGE_KEY_PRESENCE_SETTINGS = "screenClock_presenceSettings";
const PROFILE_PREFIX        = "screenClock_profile_";


const MIN_WEIGHT = 0;
const MAX_WEIGHT = 0.99;

function normalizeWeight(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, n));
}

function clampPercent(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeBatterySettings(value) {
    const src = (value && typeof value === "object") ? value : {};
    const fallback = DEFAULT_STATE.batterySettings;

    let thresholdOffPct = clampPercent(src.thresholdOffPct, fallback.thresholdOffPct);
    let thresholdOnPct = clampPercent(src.thresholdOnPct, fallback.thresholdOnPct);
    if (thresholdOnPct >= thresholdOffPct) {
        thresholdOnPct = Math.max(0, thresholdOffPct - 1);
    }

    return {
        enabled: !!src.enabled,
        switchIp: String(src.switchIp || "").trim(),
        thresholdOffPct,
        thresholdOnPct
    };
}

function normalizePresenceSettings(value) {
    const src = (value && typeof value === "object") ? value : {};
    const fallback = DEFAULT_STATE.presenceSettings;

    const decaySecFromMs = Number(src.cooldownMs) / 1000;
    const decaySecFallback = Number.isFinite(decaySecFromMs) && decaySecFromMs > 0
        ? decaySecFromMs
        : fallback.decaySec;

    const normalized = {
        enabled: !!src.enabled,
        audioSensitivity: Math.max(0, Math.min(1, Number.isFinite(Number(src.audioSensitivity)) ? Number(src.audioSensitivity) : fallback.audioSensitivity)),
        cameraSensitivity: Math.max(0, Math.min(1, Number.isFinite(Number(src.cameraSensitivity)) ? Number(src.cameraSensitivity) : fallback.cameraSensitivity)),
        lightSensitivity: Math.max(0, Math.min(1, Number.isFinite(Number(src.lightSensitivity)) ? Number(src.lightSensitivity) : fallback.lightSensitivity)),
        dimTimeoutSec: Math.round(Math.max(5, Math.min(3600, Number.isFinite(Number(src.dimTimeoutSec)) ? Number(src.dimTimeoutSec) : fallback.dimTimeoutSec))),
        darkTimeoutSec: Math.round(Math.max(10, Math.min(7200, Number.isFinite(Number(src.darkTimeoutSec)) ? Number(src.darkTimeoutSec) : fallback.darkTimeoutSec))),
        decaySec: Math.max(0.2, Math.min(10, Number.isFinite(Number(src.decaySec)) ? Number(src.decaySec) : decaySecFallback))
    };

    if (normalized.darkTimeoutSec <= normalized.dimTimeoutSec) {
        normalized.darkTimeoutSec = normalized.dimTimeoutSec + 5;
    }

    return normalized;
}

function normalizeSizingState(inputState) {
    const source = inputState && typeof inputState === "object" ? inputState : {};
    const next = { ...DEFAULT_STATE, ...source };

    next.multiFont = Object.prototype.hasOwnProperty.call(source, "multiFont")
        ? source.multiFont
        : (source.dualFont !== false);

    next.colonFont = source.colonFont || source.numericFont || "Digital7Mono";
    next.colonScale = Number.isFinite(source.colonScale) ? Number(source.colonScale) : 100;
    next.colonOffset = Number.isFinite(source.colonOffset) ? Number(source.colonOffset) : 0;
    next.secOffset = Number.isFinite(source.secOffset) ? Number(source.secOffset) : 0;
    next.colonColor = source.colonColor || source.timeColor || "#04fb62";
    next.inheritColonColor = Object.prototype.hasOwnProperty.call(source, "inheritColonColor")
        ? !!source.inheritColonColor
        : true;
    next.sleepTimeout = Number.isFinite(source.sleepTimeout) ? Number(source.sleepTimeout) : 0;

    const legacyDateFontSize = Number(source.dateFontSize);
    const legacyTimeFontSize = Number(source.timeFontSize);
    const legacyRowGapFactor = Number(source.rowGapFactor);
    const legacySecFontSize = Number(source.secFontSize);

    if (!Object.prototype.hasOwnProperty.call(source, "fr")) {
        if (Number.isFinite(legacyDateFontSize) && Number.isFinite(legacyTimeFontSize) && legacyDateFontSize > 0 && legacyTimeFontSize > 0) {
            next.fr = normalizeWeight(legacyDateFontSize / legacyTimeFontSize, DEFAULT_STATE.fr);
        }
    }

    if (!Object.prototype.hasOwnProperty.call(source, "weightGap")) {
        if (Number.isFinite(legacyDateFontSize) && Number.isFinite(legacyTimeFontSize) && legacyDateFontSize > 0 && legacyTimeFontSize > 0 && Number.isFinite(legacyRowGapFactor) && legacyRowGapFactor >= 0) {
            const derivedFr = normalizeWeight(next.fr, DEFAULT_STATE.fr);
            const gapShare = (legacyRowGapFactor * derivedFr) / (derivedFr + 1 + legacyRowGapFactor * derivedFr);
            next.weightGap = normalizeWeight(gapShare, DEFAULT_STATE.weightGap);
        }
    }

    next.weightGap = normalizeWeight(next.weightGap, DEFAULT_STATE.weightGap);
    next.fr = normalizeWeight(next.fr, DEFAULT_STATE.fr);

    if (!Object.prototype.hasOwnProperty.call(source, "secFontFactor")) {
        if (Number.isFinite(legacySecFontSize) && Number.isFinite(legacyTimeFontSize) && legacySecFontSize > 0 && legacyTimeFontSize > 0) {
            next.secFontFactor = legacySecFontSize / legacyTimeFontSize;
        }
    }

    const nextSecFontFactor = Number(next.secFontFactor);
    next.secFontFactor = Number.isFinite(nextSecFontFactor) && nextSecFontFactor > 0 ? nextSecFontFactor : DEFAULT_STATE.secFontFactor;

    const nextSizeBudget = Number(next.sizeBudget);
    next.sizeBudget = Number.isFinite(nextSizeBudget) && nextSizeBudget > 0 && nextSizeBudget <= 1 ? nextSizeBudget : DEFAULT_STATE.sizeBudget;

    delete next.rowGapFactor;
    delete next.dateFontSize;
    delete next.timeFontSize;
    delete next.secFontSize;

    next.glowEnabled = !!source.glowEnabled;
    const _glowAmt = Number(source.glowAmount);
    next.glowAmount = Number.isFinite(_glowAmt) && _glowAmt >= 1 && _glowAmt <= 20 ? _glowAmt : DEFAULT_STATE.glowAmount;
    const _glowInt = Number(source.glowIntensity);
    next.glowIntensity = Number.isFinite(_glowInt) && _glowInt >= 1 && _glowInt <= 20 ? _glowInt : DEFAULT_STATE.glowIntensity;

    const _vis = (source.visibility && typeof source.visibility === 'object') ? source.visibility : {};
    next.visibility = {
        weekday:  _vis.weekday  !== false,
        day:      _vis.day      !== false,
        month:    _vis.month    !== false,
        year:     _vis.year     !== false,
        hour:     _vis.hour     !== false,
        minute:   _vis.minute   !== false,
        seconds:  _vis.seconds  !== false,
        millis:   _vis.millis   === true,
    };

    const _msDec = Number(source.millisDecimals);
    next.millisDecimals = Number.isFinite(_msDec) && _msDec >= 1 && _msDec <= 3 ? Math.round(_msDec) : 3;

    const batterySettingsSource = source.batterySettings || {
        enabled: source.batterySettingsEnabled,
        switchName: source.batterySwitchName,
        switchIp: source.batterySwitchIp,
        thresholdOffPct: source.batteryThresholdOffPct,
        thresholdOnPct: source.batteryThresholdOnPct
    };
    next.batterySettings = normalizeBatterySettings(batterySettingsSource);
    next.presenceSettings = normalizePresenceSettings(source.presenceSettings);

    return next;
}

function refreshProfileSelectUI() {
    if (typeof window.refreshProfileSelect === "function") {
        window.refreshProfileSelect();
    }
}

function applyLoadedStateUI() {
    if (typeof window.applyLoadedStateToUi === "function") {
        window.applyLoadedStateToUi();
    }
}

function isDefaultProfile(name) {
    return String(name || "").trim() === getDefaultProfileName();
}

function isBuiltinProfile(name) {
    return Array.isArray(window.BUILTIN_PROFILES)
        && window.BUILTIN_PROFILES.some(p => p.name === String(name || "").trim());
}

const DEFAULT_CONTAINER = { enabled: false, scale: 4, width: 240, height: 135 };

function loadContainer() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_CONTAINER);
        if (raw) {
            const parsed = JSON.parse(raw);
            const sc = Number(parsed.scale);
            const w = Number(parsed.width);
            const h = Number(parsed.height);
            return {
                enabled: false,  // never restore enabled state — always start fresh
                scale:   Number.isFinite(sc) && sc >= 1 ? sc : DEFAULT_CONTAINER.scale,
                width:   Number.isFinite(w) && w >= 10 ? Math.round(w) : DEFAULT_CONTAINER.width,
                height:  Number.isFinite(h) && h >= 10 ? Math.round(h) : DEFAULT_CONTAINER.height,
            };
        }
    } catch {}
    return { ...DEFAULT_CONTAINER };
}

function saveContainer(val) {
    try {
        // Do not persist the enabled flag — simulation is off by default on every page load.
        const toSave = { scale: val.scale, width: val.width, height: val.height };
        localStorage.setItem(STORAGE_KEY_CONTAINER, JSON.stringify(toSave));
    } catch {}
}

function loadCurrentState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_CURRENT);
        if (raw) {
            const parsed = JSON.parse(raw);
            state = normalizeSizingState({ ...state, ...parsed });
        }
    } catch (e) {
        console.warn("Failed to load stored state", e);
    }
    // Battery and presence settings are per-device and stored separately so
    // they are never overwritten by cross-device state sync.
    try {
        const bsRaw = localStorage.getItem(STORAGE_KEY_BATTERY_SETTINGS);
        if (bsRaw) {
            const bsParsed = JSON.parse(bsRaw);
            state.batterySettings = normalizeBatterySettings(bsParsed);
        }
    } catch (e) {
        console.warn("Failed to load battery settings", e);
    }
    try {
        const psRaw = localStorage.getItem(STORAGE_KEY_PRESENCE_SETTINGS);
        if (psRaw) {
            const psParsed = JSON.parse(psRaw);
            state.presenceSettings = normalizePresenceSettings(psParsed);
        }
    } catch (e) {
        console.warn("Failed to load presence settings", e);
    }
    state.showDebug = loadShowDebug();
    state.showGpuInfo = loadShowGpuInfo();
    state.container = loadContainer();
}

function saveCurrentState() {
    try {
        const batterySettings = normalizeBatterySettings(state.batterySettings || {});
        const presenceSettings = normalizePresenceSettings(state.presenceSettings || {});
        try {
            localStorage.setItem(STORAGE_KEY_BATTERY_SETTINGS, JSON.stringify(batterySettings));
        } catch (_) {}
        try {
            localStorage.setItem(STORAGE_KEY_PRESENCE_SETTINGS, JSON.stringify(presenceSettings));
        } catch (_) {}

        if (typeof fetch === "function") {
            fetch("/api/state", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: STORAGE_KEY_PRESENCE_SETTINGS, value: JSON.stringify(presenceSettings) })
            }).catch(() => {});
        }

        const toSave = { ...state };
        delete toSave.showDebug;
        delete toSave.showGpuInfo;
        delete toSave.container;
        delete toSave.batterySettings;
        delete toSave.presenceSettings;
        const serialized = JSON.stringify(toSave);
        localStorage.setItem(STORAGE_KEY_CURRENT, serialized);
        // Fallback direct sync for cases where bridge localStorage hooks are not
        // active yet during early initialization.
        if (typeof fetch === "function") {
            fetch("/api/state", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: STORAGE_KEY_CURRENT, value: serialized })
            }).catch(() => {});
        }
    } catch (e) {
        console.warn("Failed to save state", e);
    }
}

function saveBatterySettings() {
    try {
        const bs = (state.batterySettings && typeof state.batterySettings === "object")
            ? state.batterySettings
            : {};
        localStorage.setItem(STORAGE_KEY_BATTERY_SETTINGS, JSON.stringify(normalizeBatterySettings(bs)));
    } catch (e) {
        console.warn("Failed to save battery settings", e);
    }
}

function savePresenceSettings() {
    try {
        const ps = (state.presenceSettings && typeof state.presenceSettings === "object")
            ? state.presenceSettings
            : {};
        const normalized = normalizePresenceSettings(ps);
        localStorage.setItem(STORAGE_KEY_PRESENCE_SETTINGS, JSON.stringify(normalized));
        if (typeof fetch === "function") {
            fetch("/api/state", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: STORAGE_KEY_PRESENCE_SETTINGS, value: JSON.stringify(normalized) })
            }).catch(() => {});
        }
    } catch (e) {
        console.warn("Failed to save presence settings", e);
    }
}

function loadShowDebug() {
    try { return localStorage.getItem(STORAGE_KEY_DEBUG) === "true"; } catch { return false; }
}

function saveShowDebug(val) {
    try { localStorage.setItem(STORAGE_KEY_DEBUG, val ? "true" : "false"); } catch {}
}

function loadShowGpuInfo() {
    try { return localStorage.getItem(STORAGE_KEY_GPU_INFO) === "true"; } catch { return false; }
}

function saveShowGpuInfo(val) {
    try { localStorage.setItem(STORAGE_KEY_GPU_INFO, val ? "true" : "false"); } catch {}
}

function loadProfileNames() {
    const builtinNames = Array.isArray(window.BUILTIN_PROFILES)
        ? window.BUILTIN_PROFILES.map(p => p.name).filter(Boolean)
        : (getDefaultProfileName() ? [getDefaultProfileName()] : []);
    try {
        const raw = localStorage.getItem(STORAGE_KEY_PROFILES);
        const parsed = raw ? JSON.parse(raw) : [];
        const custom = Array.isArray(parsed)
            ? parsed.filter(name => typeof name === "string" && name && !isBuiltinProfile(name))
            : [];
        return [...builtinNames, ...custom];
    } catch {
        return builtinNames;
    }
}

function saveProfileNames(list) {
    try {
        const custom = Array.isArray(list)
            ? list.filter(name => typeof name === "string" && name && !isBuiltinProfile(name))
            : [];
        localStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(custom));
    } catch {}
}

function saveProfile(name) {
    if (!name) return;
    if (isDefaultProfile(name)) return;
    const key = PROFILE_PREFIX + name;
    const toSave = { ...state };
    delete toSave.showDebug;
    delete toSave.showGpuInfo;
    delete toSave.container;
    delete toSave.batterySettings;
    delete toSave.presenceSettings;
    localStorage.setItem(key, JSON.stringify(toSave));
    let names = loadProfileNames();
    if (!names.includes(name)) {
        names.push(name);
        saveProfileNames(names);
    }
    refreshProfileSelectUI();
}

function loadProfile(name) {
    if (!name) return;
    const builtin = Array.isArray(window.BUILTIN_PROFILES)
        ? window.BUILTIN_PROFILES.find(p => p.name === name)
        : null;
    if (builtin) {
        state = normalizeSizingState({ ...DEFAULT_STATE, ...builtin.data });
        state.showDebug = loadShowDebug();
        state.showGpuInfo = loadShowGpuInfo();
        state.container = loadContainer();
        // Preserve per-device battery/presence settings — never overwrite with profile/default values.
        try {
            const bsRaw = localStorage.getItem(STORAGE_KEY_BATTERY_SETTINGS);
            if (bsRaw) state.batterySettings = normalizeBatterySettings(JSON.parse(bsRaw));
        } catch (_) {}
        try {
            const psRaw = localStorage.getItem(STORAGE_KEY_PRESENCE_SETTINGS);
            if (psRaw) state.presenceSettings = normalizePresenceSettings(JSON.parse(psRaw));
        } catch (_) {}
        applyLoadedStateUI();
        saveCurrentState();
        return;
    }
    const key = PROFILE_PREFIX + name;
    const raw = localStorage.getItem(key);
    if (!raw) return;
    try {
        const parsed = JSON.parse(raw);
        state = normalizeSizingState({ ...DEFAULT_STATE, ...parsed });
        state.showDebug = loadShowDebug();
        state.showGpuInfo = loadShowGpuInfo();
        state.container = loadContainer();
        // Preserve per-device battery/presence settings — never overwrite with profile/default values.
        try {
            const bsRaw = localStorage.getItem(STORAGE_KEY_BATTERY_SETTINGS);
            if (bsRaw) state.batterySettings = normalizeBatterySettings(JSON.parse(bsRaw));
        } catch (_) {}
        try {
            const psRaw = localStorage.getItem(STORAGE_KEY_PRESENCE_SETTINGS);
            if (psRaw) state.presenceSettings = normalizePresenceSettings(JSON.parse(psRaw));
        } catch (_) {}
        applyLoadedStateUI();
        saveCurrentState();
    } catch (e) {
        console.warn("Failed to load profile", e);
    }
}

function deleteProfile(name) {
    if (!name) return;
    if (isBuiltinProfile(name)) return;
    const key = PROFILE_PREFIX + name;
    localStorage.removeItem(key);
    let names = loadProfileNames().filter(n => n !== name);
    saveProfileNames(names);
    refreshProfileSelectUI();
}
