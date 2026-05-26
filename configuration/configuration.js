

// ---------------- FORM / UI BINDING ----------------

const FONT_CORRECTION = {
    // AlarmClock: { size: 1.2, baseline: 0 },
    DSEG7Classic: { colonMargin: -0.3 },
    DSEG7ClassicMini: { colonMargin: -0.3 },
    "Automata": { colonMarginLeft: -0.2, colonMargin: 0 },
    "Automate Regular W00 Regular": { colonMargin: -0.2 },
    // DSEG7ClassicMini: { size: 0.75, baseline: 0.06 },
    DSEG14Classic: { colonMargin: -0.3, o40: true },
    Digital7Mono: { colonMargin: -0.10, letterSpacing: 0.02, excludeMonoTweaks: true },
    // SevenSegment: { size: 1.1, baseline: -0.09 },
    LCDDot: { o40: true, colonMarginLeft: 0.1 },
    MatrixSansRaster: { o40: true },
    MatrixSansScreen: { o40: true },
    RepetitionScrolling: { colonMarginLeft: -0.1, colonMargin: -0.2, excludeMonoTweaks: true  },
};

function normalizeFontName(value) {
    return String(value || "")
        .trim()
        .replace(/^['"]|['"]$/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

function getFontCorrection(fontName) {
    const defaults = { size: 1, baseline: 0, letterSpacing: 0.09, colonMargin: -0.12, colonMarginLeft: null, colon: ":", gapAdjust: 1, excludeMonoTweaks: false, o40: false };
    const name = normalizeFontName(fontName);
    if (!name) return { ...defaults };

    const normalizedMap = {};
    Object.entries(FONT_CORRECTION).forEach(([k, v]) => {
        normalizedMap[normalizeFontName(k)] = v;
    });

    if (Object.prototype.hasOwnProperty.call(normalizedMap, name)) {
        return { ...defaults, ...normalizedMap[name] };
    }

    // DSEG7Classic is the renamed family backing the previous Digital7Mono entry.
    if (name === "dseg7classic" && Object.prototype.hasOwnProperty.call(normalizedMap, "digital7mono")) {
        return { ...defaults, ...normalizedMap.digital7mono };
    }

    return { ...defaults };
}

const CONFIG_MIN_WEIGHT = 0;
const CONFIG_MAX_WEIGHT = 0.99;

function normalizeSizingWeight(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(CONFIG_MAX_WEIGHT, Math.max(CONFIG_MIN_WEIGHT, n));
}

function computeSizingWeights(weightGap, fr) {
    const normalizedGap = normalizeSizingWeight(weightGap, 0.12);
    const normalizedFr = normalizeSizingWeight(fr, 0.07);
    const remaining = Math.max(0, 1 - normalizedGap);
    const weightTime = remaining / (normalizedFr + 1);
    const weightDate = normalizedFr * weightTime;

    return {
        weightGap: normalizedGap,
        fr: normalizedFr,
        weightDate,
        weightTime
    };
}

function initConfiguration() {
    const els = {
        numericFontSelect: document.getElementById("numericFontSelect"),
        dualFont:         document.getElementById("dualFont"),
        alphaFontSelect:   document.getElementById("alphaFontSelect"),
        alphaFontLabel:    document.getElementById("alphaFontLabel"),
        numericScale:      document.getElementById("numericScale"),
        alphaScale:        document.getElementById("alphaScale"),
        alphaScaleLabel:   document.getElementById("alphaScaleLabel"),
        numericOffset:     document.getElementById("numericOffset"),
        alphaOffset:       document.getElementById("alphaOffset"),
        alphaOffsetLabel:  document.getElementById("alphaOffsetLabel"),
        weightGap:         document.getElementById("weightGap"),
        fr:                document.getElementById("fr"),

        numericScaleValue: document.getElementById("numericScaleValue"),
        alphaScaleValue:   document.getElementById("alphaScaleValue"),
        numericOffsetValue:document.getElementById("numericOffsetValue"),
        alphaOffsetValue:  document.getElementById("alphaOffsetValue"),
        weightGapValue:    document.getElementById("weightGapValue"),
        frValue:           document.getElementById("frValue"),

        dateColor:         document.getElementById("dateColor"),

        timeColor:         document.getElementById("timeColor"),

        secColor:          document.getElementById("secColor"),
        secFontFactor:     document.getElementById("secFontFactor"),
        secFontFactorValue:document.getElementById("secFontFactorValue"),
        secColonDistance:  document.getElementById("secColonDistance"),
        secColonDistanceValue: document.getElementById("secColonDistanceValue"),

        showDebug:         document.getElementById("showDebug"),
        sizeBudget:        document.getElementById("sizeBudget"),
        sizeBudgetValue:   document.getElementById("sizeBudgetValue"),

        profileName:       document.getElementById("profileName"),
        profileSelect:     document.getElementById("profileSelect"),
        saveProfileBtn:      document.getElementById("saveProfileBtn"),
        deleteProfileBtn:    document.getElementById("deleteProfileBtn"),
        downloadProfileBtn:  document.getElementById("downloadProfileBtn")
    };

    function updateBadgesFromState() {
        els.numericScaleValue.textContent = state.numericScale + "%";
        els.alphaScaleValue.textContent   = state.alphaScale + "%";
        els.numericOffsetValue.textContent = state.numericOffset.toFixed(2) + "x";
        els.alphaOffsetValue.textContent   = state.alphaOffset.toFixed(2) + "x";
        const sizing = computeSizingWeights(state.weightGap, state.fr);
        state.weightGap = sizing.weightGap;
        state.fr = sizing.fr;
        els.weightGapValue.textContent    = sizing.weightGap.toFixed(2) + "x";
        els.frValue.textContent           = sizing.fr.toFixed(2) + "x";
        els.secFontFactorValue.textContent = state.secFontFactor.toFixed(2) + "x";
        if (els.secColonDistanceValue) {
            els.secColonDistanceValue.textContent = state.secColonDistance.toFixed(2) + "em";
        }
        if (els.sizeBudgetValue) els.sizeBudgetValue.textContent = (state.sizeBudget * 100).toFixed(0) + "%";
    }

    function syncDualFontUi() {
        const dualEnabled = state.dualFont !== false;
        if (els.dualFont) {
            els.dualFont.checked = dualEnabled;
        }
        if (els.alphaFontSelect) {
            els.alphaFontSelect.disabled = !dualEnabled;
            els.alphaFontSelect.style.display = dualEnabled ? '' : 'none';
        }
        if (els.alphaFontLabel) {
            els.alphaFontLabel.style.display = dualEnabled ? '' : 'none';
        }
        if (els.alphaScale) {
            els.alphaScale.style.display = dualEnabled ? '' : 'none';
        }
        if (els.alphaScaleLabel) {
            els.alphaScaleLabel.style.display = dualEnabled ? '' : 'none';
        }
        if (els.alphaOffset) {
            els.alphaOffset.style.display = dualEnabled ? '' : 'none';
        }
        if (els.alphaOffsetLabel) {
            els.alphaOffsetLabel.style.display = dualEnabled ? '' : 'none';
        }
        if (!dualEnabled) {
            state.alphaFont = state.numericFont;
            if (els.alphaFontSelect && els.numericFontSelect) {
                els.alphaFontSelect.value = els.numericFontSelect.value;
            }
        }
    }

    function normalizeSecFontFactor(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return 0.625;
        return n;
    }

    function normalizeOffsetFactor(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        // Backward compatibility: old values were px in roughly [-100..100].
        if (Math.abs(n) > 2) return n / 100;
        return n;
    }

    function colorToHex(colorValue) {
        const v = (colorValue || "").trim();
        if (!v) return "#000000";
        if (v.startsWith("#")) return v;

        const m = v.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (!m) return v;

        const r = Number(m[1]).toString(16).padStart(2, "0");
        const g = Number(m[2]).toString(16).padStart(2, "0");
        const b = Number(m[3]).toString(16).padStart(2, "0");
        return `#${r}${g}${b}`;
    }

    function firstFamily(fontFamilyValue) {
        const raw = (fontFamilyValue || "").split(",")[0] || "";
        return raw.trim().replace(/^['"]|['"]$/g, "");
    }

    function parseScaleOffsetFromTransform(transformValue) {
        if (!transformValue || transformValue === "none") {
            return { scalePct: 100, offsetPx: 0 };
        }

        const m2d = transformValue.match(/^matrix\(([^)]+)\)$/);
        if (!m2d) {
            return { scalePct: 100, offsetPx: 0 };
        }

        const parts = m2d[1].split(",").map(v => Number(v.trim()));
        if (parts.length !== 6 || parts.some(Number.isNaN)) {
            return { scalePct: 100, offsetPx: 0 };
        }

        const a = parts[0];
        const d = parts[3];
        const ty = parts[5];
        const scale = Math.abs((Math.abs(a) + Math.abs(d)) / 2) || 1;
        return {
            scalePct: Math.round(scale * 100),
            offsetPx: Math.round(ty)
        };
    }

    function syncStateFromDom() {
        const dateLine = document.getElementById("dateLine");
        const hourEl = document.getElementById("hour");
        const secEl = document.getElementById("sec");
        const numericSample = document.querySelector("#dateLine > .numeric-group");
        const alphaSample = document.querySelector("#dateLine > .alpha-group");

        if (!dateLine || !hourEl || !secEl || !numericSample || !alphaSample) return;

        const dateStyle = getComputedStyle(dateLine);
        const hourStyle = getComputedStyle(hourEl);
        const secStyle = getComputedStyle(secEl);
        const numericStyle = getComputedStyle(numericSample);
        const alphaStyle = getComputedStyle(alphaSample);

        state.dateColor = colorToHex(dateStyle.color);
        state.timeColor = colorToHex(hourStyle.color);
        state.secColor = colorToHex(secStyle.color);
        const hourFontSize = parseFloat(hourStyle.fontSize);
        const secFontSize = parseFloat(secStyle.fontSize);
        if (Number.isFinite(hourFontSize) && hourFontSize > 0 && Number.isFinite(secFontSize) && secFontSize > 0) {
            state.secFontFactor = normalizeSecFontFactor(secFontSize / hourFontSize);
        }

        state.numericFont = firstFamily(numericStyle.fontFamily) || state.numericFont;
        state.alphaFont = firstFamily(alphaStyle.fontFamily) || state.alphaFont;

        const numericTransform = parseScaleOffsetFromTransform(numericStyle.transform);
        const alphaTransform = parseScaleOffsetFromTransform(alphaStyle.transform);
        state.numericScale = numericTransform.scalePct;
        state.numericOffset = numericTransform.offsetPx;
        state.alphaScale = alphaTransform.scalePct;
        state.alphaOffset = alphaTransform.offsetPx;
    }

    function initFormFromState() {
        state.dualFont = state.dualFont !== false;
        state.numericOffset = normalizeOffsetFactor(state.numericOffset);
        state.alphaOffset = normalizeOffsetFactor(state.alphaOffset);
        state.weightGap = normalizeSizingWeight(state.weightGap, 0.12);
        state.fr = normalizeSizingWeight(state.fr, 0.07);
        state.secFontFactor = normalizeSecFontFactor(state.secFontFactor);

        els.numericScale.value  = state.numericScale;
        els.alphaScale.value    = state.alphaScale;
        els.numericOffset.value = state.numericOffset;
        els.alphaOffset.value   = state.alphaOffset;
        els.weightGap.value     = state.weightGap;
        els.fr.value            = state.fr;

        els.dateColor.value     = state.dateColor;

        els.timeColor.value     = state.timeColor;

        els.secColor.value      = state.secColor;
        els.secFontFactor.value = state.secFontFactor;
        if (els.secColonDistance) {
            els.secColonDistance.value = state.secColonDistance || 0;
        }
        if (els.showDebug) els.showDebug.checked = state.showDebug === true;
        if (els.sizeBudget) els.sizeBudget.value = state.sizeBudget;

        syncDualFontUi();

        updateBadgesFromState();

        // font selects are set after fonts are loaded (see populateFontSelects)
    }

    function readFormIntoState() {
        state.dualFont = els.dualFont ? els.dualFont.checked : true;
        state.numericScale  = Number(els.numericScale.value);
        state.alphaScale    = Number(els.alphaScale.value);
        state.numericOffset = normalizeOffsetFactor(els.numericOffset.value);
        state.alphaOffset   = normalizeOffsetFactor(els.alphaOffset.value);
        state.weightGap     = normalizeSizingWeight(els.weightGap.value, state.weightGap);
        state.fr            = normalizeSizingWeight(els.fr.value, state.fr);

        state.dateColor     = els.dateColor.value;

        state.timeColor     = els.timeColor.value;

        state.secColor      = els.secColor.value;
        state.secFontFactor = normalizeSecFontFactor(els.secFontFactor.value);
        if (els.secColonDistance) {
            state.secColonDistance = Math.min(1, Math.max(0, Number(els.secColonDistance.value) || 0));
        }
        if (els.sizeBudget) state.sizeBudget = Math.min(1, Math.max(0.1, Number(els.sizeBudget.value) || 0.95));

        if (els.numericFontSelect.value) {
            state.numericFont = els.numericFontSelect.value;
        }
        if (state.dualFont && els.alphaFontSelect.value) {
            state.alphaFont = els.alphaFontSelect.value;
        } else {
            state.alphaFont = state.numericFont;
        }

        syncDualFontUi();

        updateBadgesFromState();
    }

    function applyState() {
        // date/time containers
        const dateLine = document.getElementById("dateLine");
        const hourEl = document.getElementById("hour");
        const minEl = document.getElementById("minute");
        const timeLine = document.getElementById("timeLine");
        const colonMinEl = document.getElementById("colon-min");
        const secEl = document.getElementById("sec");
        const colonSecEl = document.getElementById("colon-sec");

        const numericCorrectionMeta = getFontCorrection(state.numericFont);
        const alphaCorrectionMeta = getFontCorrection(state.alphaFont);
        const numericCorrection = numericCorrectionMeta.size;
        const alphaCorrection = alphaCorrectionMeta.size;
        const numericBaselineOffset = numericCorrectionMeta.baseline;
        const alphaBaselineOffset = alphaCorrectionMeta.baseline;
        const numericLetterSpacing = numericCorrectionMeta.letterSpacing;
        const alphaLetterSpacing = alphaCorrectionMeta.letterSpacing;
        const numericColonMargin = numericCorrectionMeta.colonMargin;
        const numericColonMarginLeft = numericCorrectionMeta.colonMarginLeft ?? numericColonMargin;
        const numericColon = numericCorrectionMeta.colon || ":";
        const sizing = computeSizingWeights(state.weightGap, state.fr);

        // Share active correction factors with the main auto-fit scaler.
        window.clockSizeCorrection = {
            numeric: numericCorrection,
            alpha: alphaCorrection,
            numericBaseline: numericBaselineOffset,
            alphaBaseline: alphaBaselineOffset,
            gapAdjust: numericCorrectionMeta.gapAdjust,
            excludeMonoTweaks: numericCorrectionMeta.excludeMonoTweaks,
            o40: numericCorrectionMeta.o40
        };

        dateLine.style.color     = state.dateColor;
        dateLine.style.transform = "";
        dateLine.style.marginBottom = "0px";
        dateLine.dataset.weightGap = String(sizing.weightGap);
        dateLine.dataset.fr = String(sizing.fr);
        // Row gap and both row sizes are applied deterministically inside
        // applyClockTransform() using weightGap and fr.
        if (timeLine) {
            timeLine.style.marginTop = "0px";
        }

        hourEl.style.color     = state.timeColor;
        minEl.style.color     = state.timeColor;
        colonMinEl.style.color     = state.timeColor;

        secEl.style.color        = state.secColor;
        colonSecEl.style.color        = state.secColor;
        colonMinEl.textContent = numericColon;
        colonSecEl.textContent = numericColon;

        // numeric vs alpha groups
        const dateNumericScale = (state.numericScale / 100) * (numericCorrection / Math.max(alphaCorrection, 0.01));
        const dateNumericOffset = (state.numericOffset + numericBaselineOffset) * (state.numericScale / 100);
        const alphaOffset = (state.alphaOffset + alphaBaselineOffset) * (state.alphaScale / 100);
        document.querySelectorAll("#dateLine > .numeric-group").forEach(el => {
            el.style.transform  =
            `translateY(${dateNumericOffset}em) scale(${dateNumericScale})`;
        });
        
        document.querySelectorAll(".numeric-group").forEach(el => {
            el.style.fontFamily = `"${state.numericFont}", monospace`;
            el.style.letterSpacing = `${numericLetterSpacing}em`;
        });

        document.querySelectorAll(".alpha-group").forEach(el => {
            el.style.fontFamily = `"${state.alphaFont}", monospace`;
            el.style.letterSpacing = `${alphaLetterSpacing}em`;
            el.style.transform  =
                `translateY(${alphaOffset}em) scale(${state.alphaScale/100})`;
        });

        [colonMinEl, colonSecEl].forEach(el => {
            if (!el) return;
            el.style.marginTop = "0";
            el.style.marginBottom = "0";
            el.style.marginLeft = `${numericColonMarginLeft}em`;
            el.style.marginRight = `${numericColonMargin}em`;
        });

        // Apply additional padding to seconds colon based on secColonDistance
        if (colonSecEl && typeof state.secColonDistance === "number") {
            const baseMargin = numericColonMargin;
            const additionalDistance = state.secColonDistance;
            colonSecEl.style.paddingLeft = `${additionalDistance}em`;
            colonSecEl.style.paddingRight = `${additionalDistance}em`;
        }

        const probeColonMinEl = document.querySelector("#timeScaleProbe .probe-colon-min");
        const probeColonSecEl = document.querySelector("#timeScaleProbe .probe-colon-sec");

        if (probeColonMinEl) probeColonMinEl.textContent = numericColon;
        if (probeColonSecEl) probeColonSecEl.textContent = numericColon;

        [probeColonMinEl, probeColonSecEl].forEach(el => {
            if (!el) return;
            el.style.marginTop = "0";
            el.style.marginBottom = "0";
            el.style.marginLeft = `${numericColonMarginLeft}em`;
            el.style.marginRight = `${numericColonMargin}em`;
        });

        // Apply additional padding to probe seconds colon
        if (probeColonSecEl && typeof state.secColonDistance === "number") {
            const additionalDistance = state.secColonDistance;
            probeColonSecEl.style.paddingLeft = `${additionalDistance}em`;
            probeColonSecEl.style.paddingRight = `${additionalDistance}em`;
        }

        if (typeof window.requestLayoutAfterFonts === "function" && (state.numericFont || state.alphaFont)) {
            window.requestLayoutAfterFonts([state.numericFont, state.alphaFont]);
        } else if (typeof window.applyClockTransform === "function") {
            window.applyClockTransform();
        }
    }

    function attachFormListeners() {
        const inputs = [
            els.numericScale, els.alphaScale,
            els.numericOffset, els.alphaOffset,
            els.weightGap, els.fr,
            els.dateColor,
            els.timeColor,
            els.secColor, els.secFontFactor, els.secColonDistance,
            els.numericFontSelect, els.alphaFontSelect,
            els.dualFont,
            els.sizeBudget
        ];

        function attachSelectArrowKeys(selectEl) {
            if (!selectEl) return;
            selectEl.addEventListener("keydown", (e) => {
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                const dir = e.key === "ArrowDown" ? 1 : -1;
                const next = Math.max(0, Math.min(selectEl.options.length - 1, selectEl.selectedIndex + dir));
                if (next === selectEl.selectedIndex) {
                    e.preventDefault();
                    return;
                }

                selectEl.selectedIndex = next;
                selectEl.dispatchEvent(new Event("input", { bubbles: true }));
                e.preventDefault();
            });
        }

        inputs.forEach(input => {
            input.addEventListener("input", () => {
                readFormIntoState();
                applyState();
                saveCurrentState();
            });
        });

        if (els.showDebug) {
            els.showDebug.addEventListener("change", () => {
                state.showDebug = els.showDebug.checked;
                if (typeof saveShowDebug === "function") saveShowDebug(state.showDebug);
                if (typeof scheduleRowCoordinateDisplayUpdate === "function") scheduleRowCoordinateDisplayUpdate();
            });
        }

        const updateProfileButtons = () => {
            const selected = (els.profileSelect.value || "").trim();
            const isBuiltin = typeof isBuiltinProfile === "function" && isBuiltinProfile(selected);
            els.deleteProfileBtn.disabled = isBuiltin;
        };

        attachSelectArrowKeys(els.numericFontSelect);
        attachSelectArrowKeys(els.alphaFontSelect);
        attachSelectArrowKeys(els.profileSelect);

        els.saveProfileBtn.onclick = () => {
            const name = els.profileName.value.trim();
            if (name) {
                if (typeof isBuiltinProfile === "function" && isBuiltinProfile(name)) return;
                readFormIntoState();
                applyState();
                saveCurrentState();
                saveProfile(name);
                updateProfileButtons();
            }
        };

        els.deleteProfileBtn.onclick = () => {
            const name = els.profileSelect.value;
            if (name) {
                deleteProfile(name);
                updateProfileButtons();
            }
        };

        els.downloadProfileBtn.onclick = () => {
            readFormIntoState();
            const name = (els.profileName.value.trim() || els.profileSelect.value || "profile");
            const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
            const data = { ...state };
            delete data.showDebug;
            if (els.sizeBudget) data.sizeBudget = Math.min(1, Math.max(0.5, Number(els.sizeBudget.value) || 0.95));
            const entry = { name, data };
            const js = `${JSON.stringify(entry, null, 2)}\n`;
            const blob = new Blob([js], { type: "text/javascript" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `screen-clock-profile-${safeName}.js`;
            a.click();
            URL.revokeObjectURL(url);
        };

        els.profileSelect.addEventListener("change", () => {
            const name = els.profileSelect.value;
            if (name) {
                els.profileName.value = name;
                loadProfile(name);
            }
            updateProfileButtons();
        });
        updateProfileButtons();
    }

    function populateProfileSelect() {
        const names = loadProfileNames();
        const prev = els.profileSelect.value;
        els.profileSelect.innerHTML = "";
        names.forEach(name => {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            els.profileSelect.appendChild(opt);
        });
        // Restore previous selection or fall back to Default
        const preferred = prev && names.includes(prev) ? prev
            : names.includes(DEFAULT_PROFILE_NAME) ? DEFAULT_PROFILE_NAME
            : names[0] || "";
        els.profileSelect.value = preferred;
        els.profileName.value = preferred;
    }

    // Bridge for profile persistence helpers defined in persistedState.js.
    window.refreshProfileSelect = populateProfileSelect;
    window.applyLoadedStateToUi = () => {
        initFormFromState();
        applyState();
    };

    // ---------------- DYNAMIC FONT DISCOVERY ----------------
    // Load fonts.css as text and extract each font-family

    function populateFontSelects(fontList) {
        const numericSel = els.numericFontSelect;
        const alphaSel   = els.alphaFontSelect;

        const mergedFonts = [...new Set([
            "Digital7Mono",
            state.numericFont,
            state.alphaFont,
            ...fontList
        ].filter(Boolean))];

        numericSel.innerHTML = "";
        alphaSel.innerHTML   = "";

        mergedFonts.forEach(font => {
            const o1 = document.createElement("option");
            o1.value = font;
            o1.textContent = font;
            numericSel.appendChild(o1);

            const o2 = document.createElement("option");
            o2.value = font;
            o2.textContent = font;
            alphaSel.appendChild(o2);
        });

        // set selected values from state (if present in fonts list)
        if (mergedFonts.includes(state.numericFont)) {
            numericSel.value = state.numericFont;
        }
        if (mergedFonts.includes(state.alphaFont)) {
            alphaSel.value = state.alphaFont;
        }

        if (state.dualFont === false) {
            state.alphaFont = state.numericFont;
            alphaSel.value = numericSel.value;
        }

        // ensure state uses whatever select currently shows
        state.numericFont = numericSel.value || state.numericFont;
        state.alphaFont   = state.dualFont === false
            ? state.numericFont
            : (alphaSel.value || state.alphaFont);

        syncDualFontUi();

        applyState();
    }

    window.configurationFontsReady = false;
    window.configurationFontsReadyPromise = fetch("fonts/fonts.css")
        .then(r => r.text())
        .then(cssText => {
            const fontFamilies = Array.from(cssText.matchAll(/font-family:\s*["']([^"']+)["']/g))
                                    .map(m => m[1]);
            const unique = [...new Set(fontFamilies)];
            populateFontSelects(unique);
        })
        .catch(err => {
            console.warn("Could not load fonts.css for font discovery", err);
        })
        .finally(() => {
            window.configurationFontsReady = true;
        });

    // ---------------- INITIALIZATION ----------------

    console.log("loaded configuration.js");

    loadCurrentState();
    initFormFromState();
    attachFormListeners();
    populateProfileSelect();
    applyState();
    saveCurrentState();
}