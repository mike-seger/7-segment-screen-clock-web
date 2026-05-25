// ---------------- STATE ----------------

const DEFAULT_STATE = {
    numericFont: "Digital7Mono",
    alphaFont: "Digital7Mono",
    dualFont: true,
    numericScale: 100,
    alphaScale: 100,
    numericOffset: 0,
    alphaOffset: 0,
    weightGap: 0.12,
    fr: 0.07,
    dateColor: "#fb04ad",
    timeColor: "#04fb62",
    secColor: "#00aaff",
    secFontFactor: 0.625,
    showDebug: false
};

{
    const _b = Array.isArray(window.BUILTIN_PROFILES)
        ? window.BUILTIN_PROFILES.find(p => p.name === "Default")
        : null;
    if (_b && _b.data) Object.assign(DEFAULT_STATE, _b.data);
}

let state = { ...DEFAULT_STATE };

const STORAGE_KEY_CURRENT  = "screenClock_state";
const STORAGE_KEY_PROFILES = "screenClock_profiles";   // JSON array of names
const PROFILE_PREFIX       = "screenClock_profile_";
const DEFAULT_PROFILE_NAME = "Default";

const MIN_WEIGHT = 0.01;
const MAX_WEIGHT = 0.99;

function normalizeWeight(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, n));
}

function normalizeSizingState(inputState) {
    const source = inputState && typeof inputState === "object" ? inputState : {};
    const next = { ...DEFAULT_STATE, ...source };

    next.dualFont = source.dualFont !== false;

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

    delete next.rowGapFactor;
    delete next.dateFontSize;
    delete next.timeFontSize;
    delete next.secFontSize;

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
    return String(name || "").trim() === DEFAULT_PROFILE_NAME;
}

function isBuiltinProfile(name) {
    return Array.isArray(window.BUILTIN_PROFILES)
        && window.BUILTIN_PROFILES.some(p => p.name === String(name || "").trim());
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
}

function saveCurrentState() {
    try {
        localStorage.setItem(STORAGE_KEY_CURRENT, JSON.stringify(state));
    } catch (e) {
        console.warn("Failed to save state", e);
    }
}

function loadProfileNames() {
    const builtinNames = Array.isArray(window.BUILTIN_PROFILES)
        ? window.BUILTIN_PROFILES.map(p => p.name).filter(Boolean)
        : [DEFAULT_PROFILE_NAME];
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
    localStorage.setItem(key, JSON.stringify(state));
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
