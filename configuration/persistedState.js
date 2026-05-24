// ---------------- STATE ----------------

const DEFAULT_STATE = {
    numericFont: "Digital7Mono",
    alphaFont: "Digital7Mono",
    numericScale: 100,
    alphaScale: 100,
    numericOffset: 0,
    alphaOffset: 0,
    rowGapFactor: 0.5,
    dateColor: "#fb04ad",
    dateFontSize: 60,
    timeColor: "#04fb62",
    timeFontSize: 400,
    secColor: "#00aaff",
    secFontSize: 250
};

let state = { ...DEFAULT_STATE };

const STORAGE_KEY_CURRENT  = "screenClock_state";
const STORAGE_KEY_PROFILES = "screenClock_profiles";   // JSON array of names
const PROFILE_PREFIX       = "screenClock_profile_";
const DEFAULT_PROFILE_NAME = "Default";

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

function loadCurrentState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_CURRENT);
        if (raw) {
            const parsed = JSON.parse(raw);
            state = { ...state, ...parsed };
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
    try {
        const raw = localStorage.getItem(STORAGE_KEY_PROFILES);
        const parsed = raw ? JSON.parse(raw) : [];
        const custom = Array.isArray(parsed)
            ? parsed.filter(name => typeof name === "string" && name && !isDefaultProfile(name))
            : [];
        return [DEFAULT_PROFILE_NAME, ...custom];
    } catch {
        return [DEFAULT_PROFILE_NAME];
    }
}

function saveProfileNames(list) {
    try {
        const custom = Array.isArray(list)
            ? list.filter(name => typeof name === "string" && name && !isDefaultProfile(name))
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
    if (isDefaultProfile(name)) {
        state = { ...DEFAULT_STATE };
        applyLoadedStateUI();
        saveCurrentState();
        return;
    }
    const key = PROFILE_PREFIX + name;
    const raw = localStorage.getItem(key);
    if (!raw) return;
    try {
        const parsed = JSON.parse(raw);
        state = { ...DEFAULT_STATE, ...parsed };
        applyLoadedStateUI();
        saveCurrentState();
    } catch (e) {
        console.warn("Failed to load profile", e);
    }
}

function deleteProfile(name) {
    if (!name) return;
    if (isDefaultProfile(name)) return;
    const key = PROFILE_PREFIX + name;
    localStorage.removeItem(key);
    let names = loadProfileNames().filter(n => n !== name);
    saveProfileNames(names);
    refreshProfileSelectUI();
}
