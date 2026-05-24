

// ---------------- FORM / UI BINDING ----------------

const FONT_CORRECTION = {
    Digital7Mono: { size: 1.0, baseline: 0.00, letterSpacing: 0.09, colonMargin: -0.22, colon: ":" },
    DSEG7Classic: { size: 0.65, baseline: 0.17, letterSpacing: 0.12, colonMargin: -0.12, colon: ":" },
    DSEG14Classic: { size: 0.65, baseline: 0.17, letterSpacing: 0.14, colonMargin: -0.08, colon: ":" },
    LCDDot: { size: 1.5, baseline: 0.00, letterSpacing: 0.00, colonMargin: -0.02, colon: ":" },
    FourteenSegment: { size: 1.0, baseline: 0.00, letterSpacing: 0.10, colonMargin: 0.00, colon: "-" }
};

function normalizeFontName(value) {
    return String(value || "")
        .trim()
        .replace(/^['"]|['"]$/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

function getFontCorrection(fontName) {
    const defaults = { size: 1, baseline: 0, letterSpacing: 0.09, colonMargin: -0.22, colon: ":" };
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

function initConfiguration() {
    const els = {
        numericFontSelect: document.getElementById("numericFontSelect"),
        alphaFontSelect:   document.getElementById("alphaFontSelect"),
        numericScale:      document.getElementById("numericScale"),
        alphaScale:        document.getElementById("alphaScale"),
        numericOffset:     document.getElementById("numericOffset"),
        alphaOffset:       document.getElementById("alphaOffset"),
        rowGapFactor:      document.getElementById("rowGapFactor"),

        numericScaleValue: document.getElementById("numericScaleValue"),
        alphaScaleValue:   document.getElementById("alphaScaleValue"),
        numericOffsetValue:document.getElementById("numericOffsetValue"),
        alphaOffsetValue:  document.getElementById("alphaOffsetValue"),
        rowGapFactorValue: document.getElementById("rowGapFactorValue"),

        dateColor:         document.getElementById("dateColor"),
        dateFontSize:      document.getElementById("dateFontSize"),
        dateFontSizeValue: document.getElementById("dateFontSizeValue"),

        timeColor:         document.getElementById("timeColor"),
        timeFontSize:      document.getElementById("timeFontSize"),
        timeFontSizeValue: document.getElementById("timeFontSizeValue"),

        secColor:          document.getElementById("secColor"),
        secFontSize:       document.getElementById("secFontSize"),
        secFontSizeValue:  document.getElementById("secFontSizeValue"),

        profileName:       document.getElementById("profileName"),
        profileSelect:     document.getElementById("profileSelect"),
        saveProfileBtn:    document.getElementById("saveProfileBtn"),
        deleteProfileBtn:  document.getElementById("deleteProfileBtn")
    };

    function updateBadgesFromState() {
        els.numericScaleValue.textContent = state.numericScale + "%";
        els.alphaScaleValue.textContent   = state.alphaScale + "%";
        els.numericOffsetValue.textContent = state.numericOffset.toFixed(2) + "x";
        els.alphaOffsetValue.textContent   = state.alphaOffset.toFixed(2) + "x";
        els.rowGapFactorValue.textContent  = (Number(state.rowGapFactor) || 0).toFixed(2) + "x";
        els.dateFontSizeValue.textContent = state.dateFontSize + "px";
        els.timeFontSizeValue.textContent = state.timeFontSize + "px";
        els.secFontSizeValue.textContent  = state.secFontSize + "px";
    }

    function normalizeOffsetFactor(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        // Backward compatibility: old values were px in roughly [-100..100].
        if (Math.abs(n) > 2) return n / 100;
        return n;
    }

    function normalizeRowGapFactor(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0.5;
        return Math.max(0, n);
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

        state.dateFontSize = Math.round(parseFloat(dateStyle.fontSize) || state.dateFontSize);
        state.timeFontSize = Math.round(parseFloat(hourStyle.fontSize) || state.timeFontSize);
        state.secFontSize = Math.round(parseFloat(secStyle.fontSize) || state.secFontSize);

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
        state.numericOffset = normalizeOffsetFactor(state.numericOffset);
        state.alphaOffset = normalizeOffsetFactor(state.alphaOffset);
        state.rowGapFactor = normalizeRowGapFactor(state.rowGapFactor);

        els.numericScale.value  = state.numericScale;
        els.alphaScale.value    = state.alphaScale;
        els.numericOffset.value = state.numericOffset;
        els.alphaOffset.value   = state.alphaOffset;
        els.rowGapFactor.value  = state.rowGapFactor;

        els.dateColor.value     = state.dateColor;
        els.dateFontSize.value  = state.dateFontSize;

        els.timeColor.value     = state.timeColor;
        els.timeFontSize.value  = state.timeFontSize;

        els.secColor.value      = state.secColor;
        els.secFontSize.value   = state.secFontSize;

        updateBadgesFromState();

        // font selects are set after fonts are loaded (see populateFontSelects)
    }

    function readFormIntoState() {
        state.numericScale  = Number(els.numericScale.value);
        state.alphaScale    = Number(els.alphaScale.value);
        state.numericOffset = normalizeOffsetFactor(els.numericOffset.value);
        state.alphaOffset   = normalizeOffsetFactor(els.alphaOffset.value);
        state.rowGapFactor  = normalizeRowGapFactor(els.rowGapFactor.value);

        state.dateColor     = els.dateColor.value;
        state.dateFontSize  = Number(els.dateFontSize.value);

        state.timeColor     = els.timeColor.value;
        state.timeFontSize  = Number(els.timeFontSize.value);

        state.secColor      = els.secColor.value;
        state.secFontSize   = Number(els.secFontSize.value);

        if (els.numericFontSelect.value) {
            state.numericFont = els.numericFontSelect.value;
        }
        if (els.alphaFontSelect.value) {
            state.alphaFont = els.alphaFontSelect.value;
        }

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
        const numericColon = numericCorrectionMeta.colon || ":";
        const rowGapFactor = normalizeRowGapFactor(state.rowGapFactor);

        // Share active correction factors with the main auto-fit scaler.
        window.clockSizeCorrection = {
            numeric: numericCorrection,
            alpha: alphaCorrection
        };

        dateLine.style.color     = state.dateColor;
        dateLine.style.fontSize  = (state.dateFontSize * alphaCorrection) + "px";
        dateLine.dataset.baseFontSizePx = String(state.dateFontSize * alphaCorrection);
        dateLine.dataset.rowGapFactor = String(rowGapFactor);
        dateLine.style.transform = "";
        dateLine.style.marginBottom = "0px";
        if (timeLine) {
            timeLine.style.marginTop = "0px";
        }

        hourEl.style.color     = state.timeColor;
        hourEl.style.fontSize  = (state.timeFontSize * numericCorrection) + "px";

        minEl.style.color     = state.timeColor;
        minEl.style.fontSize  = (state.timeFontSize * numericCorrection) + "px";

        colonMinEl.style.color     = state.timeColor;
        colonMinEl.style.fontSize  = (state.timeFontSize * numericCorrection) + "px";

        secEl.style.color        = state.secColor;
        secEl.style.fontSize     = (state.secFontSize * numericCorrection) + "px";

        colonSecEl.style.color        = state.secColor;
        colonSecEl.style.fontSize     = (state.secFontSize * numericCorrection) + "px";
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
            el.style.margin = `0 ${numericColonMargin}em`;
        });

        const probeColonMinEl = document.querySelector("#timeScaleProbe .probe-colon-min");
        const probeColonSecEl = document.querySelector("#timeScaleProbe .probe-colon-sec");

        const probeMainChars = document.querySelectorAll("#timeScaleProbe .numeric-group:not(.probe-sec)");
        probeMainChars.forEach(el => {
            el.style.fontSize = (state.timeFontSize * numericCorrection) + "px";
        });

        const probeSecChars = document.querySelectorAll("#timeScaleProbe .probe-sec");
        probeSecChars.forEach(el => {
            el.style.fontSize = (state.secFontSize * numericCorrection) + "px";
        });

        if (probeColonMinEl) probeColonMinEl.textContent = numericColon;
        if (probeColonSecEl) probeColonSecEl.textContent = numericColon;

        [probeColonMinEl, probeColonSecEl].forEach(el => {
            if (!el) return;
            el.style.margin = `0 ${numericColonMargin}em`;
        });

        if (typeof window.applyClockTransform === "function") {
            window.applyClockTransform();
        }
    }

    function attachFormListeners() {
        const inputs = [
            els.numericScale, els.alphaScale,
            els.numericOffset, els.alphaOffset,
            els.rowGapFactor,
            els.dateColor, els.dateFontSize,
            els.timeColor, els.timeFontSize,
            els.secColor, els.secFontSize,
            els.numericFontSelect, els.alphaFontSelect
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

        const updateProfileButtons = () => {
            const selected = (els.profileSelect.value || "").trim();
            const isDefault = typeof isDefaultProfile === "function" && isDefaultProfile(selected);
            els.deleteProfileBtn.disabled = isDefault;
        };

        attachSelectArrowKeys(els.numericFontSelect);
        attachSelectArrowKeys(els.alphaFontSelect);
        attachSelectArrowKeys(els.profileSelect);

        els.saveProfileBtn.onclick = () => {
            const name = els.profileName.value.trim();
            if (name) {
                if (typeof isDefaultProfile === "function" && isDefaultProfile(name)) {
                    return;
                }
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

        els.profileSelect.addEventListener("change", () => {
            const name = els.profileSelect.value;
            if (name) {
                loadProfile(name);
            }
            updateProfileButtons();
        });
        updateProfileButtons();
    }

    function populateProfileSelect() {
        const names = loadProfileNames();
        els.profileSelect.innerHTML = "";
        names.forEach(name => {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            els.profileSelect.appendChild(opt);
        });
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

        // ensure state uses whatever select currently shows
        state.numericFont = numericSel.value || state.numericFont;
        state.alphaFont   = alphaSel.value || state.alphaFont;

        applyState();
    }

    fetch("fonts/fonts.css")
        .then(r => r.text())
        .then(cssText => {
            const fontFamilies = Array.from(cssText.matchAll(/font-family:\s*["']([^"']+)["']/g))
                                    .map(m => m[1]);
            const unique = [...new Set(fontFamilies)];
            populateFontSelects(unique);
        })
        .catch(err => {
            console.warn("Could not load fonts.css for font discovery", err);
        });

    // ---------------- INITIALIZATION ----------------

    console.log("loaded configuration.js");

    loadCurrentState();
    syncStateFromDom();
    initFormFromState();
    attachFormListeners();
    populateProfileSelect();
    applyState();
    saveCurrentState();
}