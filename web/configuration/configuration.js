

// ---------------- FORM / UI BINDING ----------------

const FONT_CORRECTION = {
    // AlarmClock: { size: 1.2, baseline: 0 },
    "/^DSEG7/": { colonMargin: -0.3 },
   // "Automata": { colonMarginLeft: -0.2, colonMargin: 0 },
    "/^Automate/": { colonMarginLeft: -0.2, colonMargin: -0.16 },
    "/^Automata/": { colonMargin: 0, colonMarginLeft: -0.2 },
    // DSEG7ClassicMini: { size: 0.75, baseline: 0.06 },
    "/^DSEG14/": { colonMargin: -0.3, o40: true },
    Digital7Mono: { colonMargin: -0.10, letterSpacing: 0.02, excludeMonoTweaks: true },
    // SevenSegment: { size: 1.1, baseline: -0.09 },
    LCDDot: { o40: true, colonMarginLeft: -0.09 },
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

    // 1. Try exact normalized match
    for (const [k, v] of Object.entries(FONT_CORRECTION)) {
        if (normalizeFontName(k) === name) {
            return { ...defaults, ...v };
        }
    }

    // 2. Try regex keys — key must start with / and end with /[flags]
    for (const [k, v] of Object.entries(FONT_CORRECTION)) {
        const m = k.match(/^\/(.+)\/([gimsuy]*)$/);
        if (!m) continue;
        try {
            if (new RegExp(m[1], m[2]).test(fontName)) {
                return { ...defaults, ...v };
            }
        } catch (e) {
            // ignore malformed regex keys
        }
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
        multiFont:         document.getElementById("multiFont"),
        alphaFontSelect:   document.getElementById("alphaFontSelect"),
        alphaFontLabel:    document.getElementById("alphaFontLabel"),
        colonFontSelect:   document.getElementById("colonFontSelect"),
        colonFontLabel:    document.getElementById("colonFontLabel"),
        numericScale:      document.getElementById("numericScale"),
        alphaScale:        document.getElementById("alphaScale"),
        alphaScaleLabel:   document.getElementById("alphaScaleLabel"),
        colonScale:        document.getElementById("colonScale"),
        colonScaleLabel:   document.getElementById("colonScaleLabel"),
        numericOffset:     document.getElementById("numericOffset"),
        alphaOffset:       document.getElementById("alphaOffset"),
        alphaOffsetLabel:  document.getElementById("alphaOffsetLabel"),
        colonOffset:       document.getElementById("colonOffset"),
        colonOffsetLabel:  document.getElementById("colonOffsetLabel"),
        weightGap:         document.getElementById("weightGap"),
        fr:                document.getElementById("fr"),

        numericScaleValue: document.getElementById("numericScaleValue"),
        alphaScaleValue:   document.getElementById("alphaScaleValue"),
        colonScaleValue:   document.getElementById("colonScaleValue"),
        numericOffsetValue:document.getElementById("numericOffsetValue"),
        alphaOffsetValue:  document.getElementById("alphaOffsetValue"),
        colonOffsetValue:  document.getElementById("colonOffsetValue"),
        weightGapValue:    document.getElementById("weightGapValue"),
        frValue:           document.getElementById("frValue"),

        dateColor:         document.getElementById("dateColor"),

        timeColor:         document.getElementById("timeColor"),
        colonColor:        document.getElementById("colonColor"),
        colonColorLabel:   document.getElementById("colonColorLabel"),
        inheritColonColor: document.getElementById("inheritColonColor"),
        inheritColonColorLabel: document.getElementById("inheritColonColorLabel"),

        secColor:          document.getElementById("secColor"),
        secFontFactor:     document.getElementById("secFontFactor"),
        secFontFactorValue:document.getElementById("secFontFactorValue"),
        secColonDistance:  document.getElementById("secColonDistance"),
        secColonDistanceValue: document.getElementById("secColonDistanceValue"),
        secOffset:         document.getElementById("secOffset"),
        secOffsetValue:    document.getElementById("secOffsetValue"),

        showDebug:              document.getElementById("showDebug"),
        containerEnabled:       document.getElementById("containerEnabled"),
        containerScale:         document.getElementById("containerScale"),
        containerScaleValue:    document.getElementById("containerScaleValue"),
        containerControls:      document.getElementById("containerControls"),
        containerSizeHint:      document.getElementById("containerSizeHint"),
        glowEnabled:            document.getElementById("glowEnabled"),
        glowAmount:             document.getElementById("glowAmount"),
        glowAmountValue:        document.getElementById("glowAmountValue"),
        glowIntensity:          document.getElementById("glowIntensity"),
        glowIntensityValue:     document.getElementById("glowIntensityValue"),
        glowControls:           document.getElementById("glowControls"),
        sizeBudget:        document.getElementById("sizeBudget"),
        sizeBudgetValue:   document.getElementById("sizeBudgetValue"),
        ntpServer:         document.getElementById("ntpServerInput"),
        sleepTimeoutSelect:document.getElementById("sleepTimeoutSelect"),
        padHours:          document.getElementById("padHours"),
        recenterLeadingOne:document.getElementById("recenterLeadingOne"),

        profileName:       document.getElementById("profileName"),
        profileSelect:     document.getElementById("profileSelect"),
        saveProfileBtn:      document.getElementById("saveProfileBtn"),
        deleteProfileBtn:    document.getElementById("deleteProfileBtn"),
        downloadProfileBtn:  document.getElementById("downloadProfileBtn")
    };

    function updateBadgesFromState() {
        els.numericScaleValue.textContent = state.numericScale + "%";
        els.alphaScaleValue.textContent   = state.alphaScale + "%";
        if (els.colonScaleValue) els.colonScaleValue.textContent = state.colonScale + "%";
        els.numericOffsetValue.textContent = state.numericOffset.toFixed(2) + "x";
        els.alphaOffsetValue.textContent   = state.alphaOffset.toFixed(2) + "x";
        if (els.colonOffsetValue) els.colonOffsetValue.textContent = state.colonOffset.toFixed(2) + "x";
        const sizing = computeSizingWeights(state.weightGap, state.fr);
        state.weightGap = sizing.weightGap;
        state.fr = sizing.fr;
        els.weightGapValue.textContent    = sizing.weightGap.toFixed(2) + "x";
        els.frValue.textContent           = sizing.fr.toFixed(2) + "x";
        els.secFontFactorValue.textContent = state.secFontFactor.toFixed(2) + "x";
        if (els.secColonDistanceValue) {
            els.secColonDistanceValue.textContent = state.secColonDistance.toFixed(2) + "em";
        }
        if (els.secOffsetValue) {
            els.secOffsetValue.textContent = (state.secOffset || 0).toFixed(2) + "x";
        }
        if (els.sizeBudgetValue) els.sizeBudgetValue.textContent = (state.sizeBudget * 100).toFixed(0) + "%";
        if (els.glowAmountValue) els.glowAmountValue.textContent = state.glowAmount != null ? state.glowAmount : 5;
        if (els.containerScaleValue) {
            const sc = state.container && state.container.scale != null ? state.container.scale : 4;
            els.containerScaleValue.textContent = sc + "px";
        }
    }

    function syncMultiFontUi() {
        const multiEnabled = state.multiFont !== false;
        if (els.multiFont) {
            els.multiFont.checked = multiEnabled;
        }
        if (els.alphaFontSelect) {
            els.alphaFontSelect.disabled = !multiEnabled;
            els.alphaFontSelect.style.display = multiEnabled ? '' : 'none';
        }
        if (els.alphaFontLabel) {
            els.alphaFontLabel.style.display = multiEnabled ? '' : 'none';
        }
        if (els.alphaScale) {
            els.alphaScale.style.display = multiEnabled ? '' : 'none';
        }
        if (els.alphaScaleLabel) {
            els.alphaScaleLabel.style.display = multiEnabled ? '' : 'none';
        }
        if (els.alphaOffset) {
            els.alphaOffset.style.display = multiEnabled ? '' : 'none';
        }
        if (els.alphaOffsetLabel) {
            els.alphaOffsetLabel.style.display = multiEnabled ? '' : 'none';
        }

        // Colon separate configurations compatibility/flexibility
        if (els.colonFontSelect) {
            els.colonFontSelect.disabled = !multiEnabled;
            els.colonFontSelect.style.display = multiEnabled ? '' : 'none';
        }
        if (els.colonFontLabel) {
            els.colonFontLabel.style.display = multiEnabled ? '' : 'none';
        }
        if (els.colonScale) {
            els.colonScale.style.display = multiEnabled ? '' : 'none';
        }
        if (els.colonScaleLabel) {
            els.colonScaleLabel.style.display = multiEnabled ? '' : 'none';
        }
        if (els.colonOffset) {
            els.colonOffset.style.display = multiEnabled ? '' : 'none';
        }
        if (els.colonOffsetLabel) {
            els.colonOffsetLabel.style.display = multiEnabled ? '' : 'none';
        }
        if (els.colonColorLabel) {
            els.colonColorLabel.style.display = (multiEnabled && !state.inheritColonColor) ? '' : 'none';
        }
        if (els.inheritColonColorLabel) {
            els.inheritColonColorLabel.style.display = multiEnabled ? '' : 'none';
        }

        if (!multiEnabled) {
            state.alphaFont = state.numericFont;
            state.colonFont = state.numericFont;
            state.alphaScale = state.numericScale;
            state.colonScale = state.numericScale;
            state.alphaOffset = state.numericOffset;
            state.colonOffset = state.numericOffset;
            state.colonColor = state.timeColor;
            if (els.alphaFontSelect && els.numericFontSelect) {
                els.alphaFontSelect.value = els.numericFontSelect.value;
            }
            if (els.colonFontSelect && els.numericFontSelect) {
                els.colonFontSelect.value = els.numericFontSelect.value;
            }
            if (els.colonColor && els.timeColor) {
                els.colonColor.value = els.timeColor.value;
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

    function updateContainerSizeHint() {
        if (!els.containerSizeHint || !els.containerEnabled) return;
        const c = state.container || {};
        if (!c.enabled) { els.containerSizeHint.textContent = ""; return; }
        const sc = c.scale || 4;
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        const vw = Math.round(winW / sc);
        const vh = Math.round(winH / sc);
        els.containerSizeHint.textContent = `Virtual: ${vw}×${vh} px  (${winW}×${winH} real, ${sc}px/virtual px)`;
    }
    window.updateContainerSizeHint = updateContainerSizeHint;

    function initFormFromState() {
        state.multiFont = state.multiFont !== false;
        state.numericOffset = normalizeOffsetFactor(state.numericOffset);
        state.alphaOffset = normalizeOffsetFactor(state.alphaOffset);
        state.colonOffset = normalizeOffsetFactor(state.colonOffset);
        state.secOffset = normalizeOffsetFactor(state.secOffset);
        state.weightGap = normalizeSizingWeight(state.weightGap, 0.12);
        state.fr = normalizeSizingWeight(state.fr, 0.07);
        state.secFontFactor = normalizeSecFontFactor(state.secFontFactor);

        els.numericScale.value  = state.numericScale;
        els.alphaScale.value    = state.alphaScale;
        if (els.colonScale) els.colonScale.value = state.colonScale;
        els.numericOffset.value = state.numericOffset;
        els.alphaOffset.value   = state.alphaOffset;
        if (els.colonOffset) els.colonOffset.value = state.colonOffset;
        if (els.secOffset) els.secOffset.value = state.secOffset;
        els.weightGap.value     = state.weightGap;
        els.fr.value            = state.fr;

        els.dateColor.value     = state.dateColor;
        els.timeColor.value     = state.timeColor;
        if (els.colonColor) els.colonColor.value = state.colonColor;

        els.secColor.value      = state.secColor;
        els.secFontFactor.value = state.secFontFactor;
        if (els.secColonDistance) {
            els.secColonDistance.value = state.secColonDistance || 0;
        }
        if (els.inheritColonColor) {
            els.inheritColonColor.checked = state.inheritColonColor === true;
        }
        if (els.showDebug) els.showDebug.checked = state.showDebug === true;
        // Container mode
        if (els.containerEnabled) {
            const c = state.container || {};
            els.containerEnabled.checked = !!c.enabled;
            if (els.containerScale)    els.containerScale.value    = c.scale != null ? c.scale : 4;
            if (els.containerScaleValue) els.containerScaleValue.textContent = (c.scale != null ? c.scale : 4) + "px";
            if (els.containerControls) els.containerControls.style.display = c.enabled ? "" : "none";
            updateContainerSizeHint();
        }
        if (els.glowEnabled) els.glowEnabled.checked = !!state.glowEnabled;
        if (els.glowAmount) els.glowAmount.value = state.glowAmount != null ? state.glowAmount : 5;
        if (els.glowAmountValue) els.glowAmountValue.textContent = state.glowAmount != null ? state.glowAmount : 5;
        if (els.glowIntensity) els.glowIntensity.value = state.glowIntensity != null ? state.glowIntensity : 3;
        if (els.glowIntensityValue) els.glowIntensityValue.textContent = state.glowIntensity != null ? state.glowIntensity : 3;
        if (els.glowControls) els.glowControls.style.display = state.glowEnabled ? "" : "none";
        if (els.sizeBudget) els.sizeBudget.value = state.sizeBudget;
        if (els.ntpServer) els.ntpServer.value = state.ntpServer || "";
        if (els.sleepTimeoutSelect) els.sleepTimeoutSelect.value = state.sleepTimeout || 0;
        if (els.padHours) els.padHours.checked = state.padHours === true;
        if (els.recenterLeadingOne) els.recenterLeadingOne.checked = state.recenterLeadingOne === true;

        // Font selects: set whenever fonts are already populated (e.g. profile switch).
        // On first load populateFontSelects() handles this; setting here is harmless
        // if options aren't ready yet (no matching option → value stays unchanged).
        if (els.numericFontSelect) els.numericFontSelect.value = state.numericFont;
        if (els.alphaFontSelect)   els.alphaFontSelect.value   = state.alphaFont;
        if (els.colonFontSelect)   els.colonFontSelect.value   = state.colonFont;

        syncMultiFontUi();

        updateBadgesFromState();
    }

    function readFormIntoState() {
        state.multiFont = els.multiFont ? els.multiFont.checked : true;
        state.numericScale  = Number(els.numericScale.value);
        state.alphaScale    = Number(els.alphaScale.value);
        if (els.colonScale) state.colonScale = Number(els.colonScale.value);
        state.numericOffset = normalizeOffsetFactor(els.numericOffset.value);
        state.alphaOffset   = normalizeOffsetFactor(els.alphaOffset.value);
        if (els.colonOffset) state.colonOffset = normalizeOffsetFactor(els.colonOffset.value);
        if (els.secOffset) state.secOffset = normalizeOffsetFactor(els.secOffset.value);
        state.weightGap     = normalizeSizingWeight(els.weightGap.value, state.weightGap);
        state.fr            = normalizeSizingWeight(els.fr.value, state.fr);

        state.dateColor     = els.dateColor.value;
        state.timeColor     = els.timeColor.value;
        if (els.colonColor) state.colonColor = els.colonColor.value;

        state.secColor      = els.secColor.value;
        state.secFontFactor = normalizeSecFontFactor(els.secFontFactor.value);
        if (els.secColonDistance) {
            state.secColonDistance = Math.min(1, Math.max(0, Number(els.secColonDistance.value) || 0));
        }
        if (els.inheritColonColor) {
            state.inheritColonColor = els.inheritColonColor.checked;
        }
        if (els.sizeBudget) state.sizeBudget = Math.min(1, Math.max(0.1, Number(els.sizeBudget.value) || 0.95));
        if (els.ntpServer) state.ntpServer = els.ntpServer.value || "";
        if (els.sleepTimeoutSelect) state.sleepTimeout = Number(els.sleepTimeoutSelect.value) || 0;
        if (els.padHours) state.padHours = els.padHours.checked;
        if (els.recenterLeadingOne) state.recenterLeadingOne = els.recenterLeadingOne.checked;
        if (els.glowEnabled) state.glowEnabled = els.glowEnabled.checked;
        if (els.glowAmount) state.glowAmount = Math.min(20, Math.max(1, Number(els.glowAmount.value) || 5));
        if (els.glowIntensity) state.glowIntensity = Math.min(20, Math.max(1, Number(els.glowIntensity.value) || 3));

        if (els.numericFontSelect.value) {
            state.numericFont = els.numericFontSelect.value;
        }
        if (state.multiFont && els.alphaFontSelect.value) {
            state.alphaFont = els.alphaFontSelect.value;
        } else {
            state.alphaFont = state.numericFont;
        }
        if (state.multiFont && els.colonFontSelect.value) {
            state.colonFont = els.colonFontSelect.value;
        } else {
            state.colonFont = state.numericFont;
        }

        syncMultiFontUi();

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
        const colonCorrectionMeta = getFontCorrection(state.colonFont);

        const numericCorrection = numericCorrectionMeta.size;
        const alphaCorrection = alphaCorrectionMeta.size;
        const colonCorrection = colonCorrectionMeta.size;

        const numericBaselineOffset = numericCorrectionMeta.baseline;
        const alphaBaselineOffset = alphaCorrectionMeta.baseline;
        const colonBaselineOffset = colonCorrectionMeta.baseline;

        const numericLetterSpacing = numericCorrectionMeta.letterSpacing;
        const alphaLetterSpacing = alphaCorrectionMeta.letterSpacing;
        const colonLetterSpacing = colonCorrectionMeta.letterSpacing;

        const numericColonMargin = colonCorrectionMeta.colonMargin;
        const numericColonMarginLeft = colonCorrectionMeta.colonMarginLeft ?? numericColonMargin;
        const numericColon = colonCorrectionMeta.colon || ":";
        const sizing = computeSizingWeights(state.weightGap, state.fr);

        // Share active correction factors with the main auto-fit scaler.
        window.clockSizeCorrection = {
            numeric: numericCorrection,
            alpha: alphaCorrection,
            colon: colonCorrection,
            numericBaseline: numericBaselineOffset,
            alphaBaseline: alphaBaselineOffset,
            colonBaseline: colonBaselineOffset,
            gapAdjust: numericCorrectionMeta.gapAdjust,
            excludeMonoTweaks: numericCorrectionMeta.excludeMonoTweaks,
            o40: numericCorrectionMeta.o40,
            alphaO40: alphaCorrectionMeta.o40
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

        let colonMinColor = state.timeColor;
        let colonSecColor = state.secColor;
        if (state.multiFont) {
            if (state.inheritColonColor) {
                colonMinColor = state.timeColor;
                colonSecColor = state.secColor;
            } else {
                colonMinColor = state.colonColor;
                colonSecColor = state.colonColor;
            }
        }

        colonMinEl.style.color = colonMinColor;

        secEl.style.color      = state.secColor;
        colonSecEl.style.color = colonSecColor;
        colonMinEl.textContent = numericColon;
        colonSecEl.textContent = numericColon;

        // numeric vs alpha vs colon groups
        const dateNumericScale = (state.numericScale / 100) * (numericCorrection / Math.max(alphaCorrection, 0.01));
        const dateNumericOffset = (state.numericOffset + numericBaselineOffset) * (state.numericScale / 100);
        const alphaOffset = (state.alphaOffset + alphaBaselineOffset) * (state.alphaScale / 100);

        const colonScale = state.multiFont ? state.colonScale : state.numericScale;
        const colonOffsetVal = state.multiFont ? state.colonOffset : state.numericOffset;
        const colonOffsetEm = (colonOffsetVal + colonBaselineOffset) * (colonScale / 100);
        const colonScaleVal = (colonScale / 100);

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

        document.querySelectorAll(".colon-group").forEach(el => {
            el.style.fontFamily = `"${state.colonFont}", monospace`;
            el.style.letterSpacing = `${colonLetterSpacing}em`;
            el.style.transform = `translateY(${colonOffsetEm}em) scale(${colonScaleVal})`;
        });

        if (colonSecEl) {
            const secColonOffsetEm = (colonOffsetVal + (state.secOffset || 0) + colonBaselineOffset) * (colonScale / 100);
            colonSecEl.style.transform = `translateY(${secColonOffsetEm}em) scale(${colonScaleVal})`;
        }

        if (secEl) {
            const secOffsetEm = ((state.secOffset || 0) + numericBaselineOffset) * (state.numericScale / 100);
            secEl.style.transform = `translateY(${secOffsetEm}em)`;
        }

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

        // Apply glow effect: text-shadow proportional to font size (amount * 0.005em), stacked intensity times
        const glowStyle = (state.glowEnabled && state.glowAmount > 0)
            ? Array(Math.round((state.glowIntensity || 3) / 2)).fill(`0 0 ${(state.glowAmount * 0.005).toFixed(3)}em currentColor`).join(", ")
            : "";
        document.querySelectorAll(".numeric-group, .alpha-group, .colon-group").forEach(el => {
            el.style.textShadow = glowStyle;
        });

        if (typeof window.requestLayoutAfterFonts === "function" && (state.numericFont || state.alphaFont || state.colonFont)) {
            window.requestLayoutAfterFonts([state.numericFont, state.alphaFont, state.colonFont]);
        } else if (typeof window.applyClockTransform === "function") {
            window.applyClockTransform();
        }
    }

    function attachFormListeners() {
        const inputs = [
            els.numericScale, els.alphaScale, els.colonScale,
            els.numericOffset, els.alphaOffset, els.colonOffset,
            els.weightGap, els.fr,
            els.dateColor,
            els.timeColor, els.colonColor,
            els.secColor, els.secFontFactor, els.secColonDistance, els.secOffset,
            els.numericFontSelect, els.alphaFontSelect, els.colonFontSelect,
            els.multiFont,
            els.inheritColonColor,
            els.sizeBudget,
            els.ntpServer,
            els.sleepTimeoutSelect,
            els.padHours,
            els.recenterLeadingOne
        ].filter(Boolean);

        function attachSelectArrowKeys(selectEl) {
            if (!selectEl) return;
            if (selectEl.dataset.arrowKeysAttached) return;
            selectEl.dataset.arrowKeysAttached = "true";
            selectEl.addEventListener("keydown", (e) => {
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                e.preventDefault();    // prevent native macOS popup
                e.stopPropagation();   // prevent window keydown handler from also firing
                const dir = e.key === "ArrowDown" ? 1 : -1;
                const next = Math.max(0, Math.min(selectEl.options.length - 1, selectEl.selectedIndex + dir));
                if (next === selectEl.selectedIndex) return;
                selectEl.selectedIndex = next;
                selectEl.dispatchEvent(new Event("input", { bubbles: true }));
                selectEl.dispatchEvent(new Event("change", { bubbles: true }));
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
                // Sync debug outline on container
                if (typeof applyContainerMode === "function") applyContainerMode();
            });
        }

        function readContainerFromForm() {
            if (!els.containerEnabled) return;
            const sc = parseFloat(els.containerScale ? els.containerScale.value : 4);
            state.container = {
                enabled: els.containerEnabled.checked,
                scale:   Number.isFinite(sc) && sc >= 1 ? sc : 4,
            };
            if (typeof saveContainer === "function") saveContainer(state.container);
        }

        if (els.containerEnabled) {
            els.containerEnabled.addEventListener("change", () => {
                readContainerFromForm();
                if (els.containerControls) els.containerControls.style.display = state.container.enabled ? "" : "none";
                updateContainerSizeHint();
                if (typeof applyContainerMode === "function") applyContainerMode();
            });
        }

        [els.containerScale].forEach(el => {
            if (!el) return;
            el.addEventListener("input", () => {
                if (els.containerScaleValue) els.containerScaleValue.textContent = el.value + "px";
                readContainerFromForm();
                updateContainerSizeHint();
                if (typeof applyContainerMode === "function") applyContainerMode();
            });
        });

        if (els.glowEnabled) {
            els.glowEnabled.addEventListener("change", () => {
                if (els.glowControls) els.glowControls.style.display = els.glowEnabled.checked ? "" : "none";
                readFormIntoState();
                applyState();
                saveCurrentState();
            });
        }

        if (els.glowAmount) {
            els.glowAmount.addEventListener("input", () => {
                if (els.glowAmountValue) els.glowAmountValue.textContent = els.glowAmount.value;
                readFormIntoState();
                applyState();
                saveCurrentState();
            });
        }

        if (els.glowIntensity) {
            els.glowIntensity.addEventListener("input", () => {
                if (els.glowIntensityValue) els.glowIntensityValue.textContent = els.glowIntensity.value;
                readFormIntoState();
                applyState();
                saveCurrentState();
            });
        }

        const updateProfileButtons = () => {
            const selected = (els.profileSelect.value || "").trim();
            const isBuiltin = typeof isBuiltinProfile === "function" && isBuiltinProfile(selected);
            els.deleteProfileBtn.disabled = isBuiltin;
        };

        attachSelectArrowKeys(els.numericFontSelect);
        attachSelectArrowKeys(els.alphaFontSelect);
        attachSelectArrowKeys(els.colonFontSelect);
        attachSelectArrowKeys(els.profileSelect);
        attachSelectArrowKeys(els.sleepTimeoutSelect);

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
            delete data.container;
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
                showProfileToast(name);
            }
            updateProfileButtons();
        });
        updateProfileButtons();
    }

    function showProfileToast(name) {
        let toast = document.getElementById("profileSwitchToast");
        if (!toast) {
            toast = document.createElement("div");
            toast.id = "profileSwitchToast";
            document.body.appendChild(toast);
        }
        toast.textContent = name;
        toast.classList.add("visible");
        clearTimeout(toast._hideTimer);
        toast._hideTimer = setTimeout(() => {
            toast.classList.remove("visible");
        }, 1500);
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
        // Restore previous selection or fall back to flagged default / first profile
        const defaultName = (typeof getDefaultProfileName === "function") ? getDefaultProfileName() : "";
        const preferred = prev && names.includes(prev) ? prev
            : (defaultName && names.includes(defaultName)) ? defaultName
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
        const colonSel   = els.colonFontSelect;

        const mergedFonts = [...new Set([
            "Digital7Mono",
            state.numericFont,
            state.alphaFont,
            state.colonFont,
            ...fontList
        ].filter(Boolean))].sort((a, b) => a.localeCompare(b));

        numericSel.innerHTML = "";
        alphaSel.innerHTML   = "";
        if (colonSel) colonSel.innerHTML = "";

        mergedFonts.forEach(font => {
            const o1 = document.createElement("option");
            o1.value = font;
            o1.textContent = font;
            numericSel.appendChild(o1);

            const o2 = document.createElement("option");
            o2.value = font;
            o2.textContent = font;
            alphaSel.appendChild(o2);

            if (colonSel) {
                const o3 = document.createElement("option");
                o3.value = font;
                o3.textContent = font;
                colonSel.appendChild(o3);
            }
        });

        // set selected values from state (if present in fonts list)
        if (mergedFonts.includes(state.numericFont)) {
            numericSel.value = state.numericFont;
        }
        if (mergedFonts.includes(state.alphaFont)) {
            alphaSel.value = state.alphaFont;
        }
        if (colonSel && mergedFonts.includes(state.colonFont)) {
            colonSel.value = state.colonFont;
        }

        if (state.multiFont === false) {
            state.alphaFont = state.numericFont;
            state.colonFont = state.numericFont;
            alphaSel.value = numericSel.value;
            if (colonSel) colonSel.value = numericSel.value;
        }

        // ensure state uses whatever select currently shows
        state.numericFont = numericSel.value || state.numericFont;
        state.alphaFont   = state.multiFont === false
            ? state.numericFont
            : (alphaSel.value || state.alphaFont);
        state.colonFont   = state.multiFont === false
            ? state.numericFont
            : ((colonSel && colonSel.value) || state.colonFont);

        syncMultiFontUi();

        applyState();
    }

    window.configurationFontsReady = false;
    window.configurationFontsReadyPromise = fetch("fonts/fonts.css")
        .then(r => r.text())
        .then(cssText => {
            const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
            const fontFamilies = Array.from(stripped.matchAll(/font-family:\s*["']([^"']+)["']/g))
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

    // Expose a single entry point that re-reads localStorage (e.g. after a
    // remote control client pushed a new state) and refreshes both the
    // configuration form and the live clock to match.
    window.refreshFromStoredState = function () {
        try { loadCurrentState(); } catch (e) {}
        try { initFormFromState(); } catch (e) {}
        try { applyState(); } catch (e) {}
    };
}