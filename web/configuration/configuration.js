

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

        visWeekday:  document.getElementById("visWeekday"),
        visDay:      document.getElementById("visDay"),
        visMonth:    document.getElementById("visMonth"),
        visYear:     document.getElementById("visYear"),
        visHour:     document.getElementById("visHour"),
        visMinute:   document.getElementById("visMinute"),
        visSeconds:  document.getElementById("visSeconds"),
        visMillis:   document.getElementById("visMillis"),

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
        showGpuInfo:            document.getElementById("showGpuInfo"),
        containerEnabled:       document.getElementById("containerEnabled"),
        containerScale:         document.getElementById("containerScale"),
        containerScaleValue:    document.getElementById("containerScaleValue"),
        containerWidth:         document.getElementById("containerWidth"),
        containerWidthValue:    document.getElementById("containerWidthValue"),
        containerHeight:        document.getElementById("containerHeight"),
        containerHeightValue:   document.getElementById("containerHeightValue"),
        containerControls:      document.getElementById("containerControls"),
        containerSizeHint:      document.getElementById("containerSizeHint"),
        glowEnabled:            document.getElementById("glowEnabled"),
        glowAmount:             document.getElementById("glowAmount"),
        glowAmountValue:        document.getElementById("glowAmountValue"),
        glowIntensity:          document.getElementById("glowIntensity"),
        glowIntensityValue:     document.getElementById("glowIntensityValue"),
        glowControls:           document.getElementById("glowControls"),
        millisDecimals:         document.getElementById("millisDecimals"),
        millisDecimalsValue:    document.getElementById("millisDecimalsValue"),
        sizeBudget:        document.getElementById("sizeBudget"),
        sizeBudgetValue:   document.getElementById("sizeBudgetValue"),
        ntpServer:         document.getElementById("ntpServerInput"),
        sleepTimeoutSelect:document.getElementById("sleepTimeoutSelect"),
        padHours:          document.getElementById("padHours"),
        recenterLeadingOne:document.getElementById("recenterLeadingOne"),

        batterySettingsEnabled: document.getElementById("batterySettingsEnabled"),
        batterySwitchHostGroup: document.getElementById("batterySwitchHostGroup"),
        batterySwitchIp:        document.getElementById("batterySwitchIp"),
        batteryThresholdOn:     document.getElementById("batteryThresholdOn"),
        batteryThresholdOff:    document.getElementById("batteryThresholdOff"),
        batteryThresholdOnValue: document.getElementById("batteryThresholdOnValue"),
        batteryThresholdOffValue: document.getElementById("batteryThresholdOffValue"),
        batteryThresholdControls: document.getElementById("batteryThresholdControls"),
        batterySwitchRefreshBtn: document.getElementById("batterySwitchRefreshBtn"),
        batterySwitchToggleBtn: document.getElementById("batterySwitchToggleBtn"),
        batteryHistoryCanvas: document.getElementById("batteryHistoryCanvas"),

        batteryLiveCharge:   document.getElementById("batteryLiveCharge"),
        batteryLiveCharging: document.getElementById("batteryLiveCharging"),

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
        if (els.batteryThresholdOffValue) {
            const bs = state.batterySettings || {};
            els.batteryThresholdOffValue.textContent = `${bs.thresholdOffPct != null ? bs.thresholdOffPct : 85}%`;
        }
        if (els.batteryThresholdOnValue) {
            const bs = state.batterySettings || {};
            els.batteryThresholdOnValue.textContent = `${bs.thresholdOnPct != null ? bs.thresholdOnPct : 40}%`;
        }
    }

    let batterySwitchPower = null;

    function clampBatteryThreshold(value, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(0, Math.min(100, Math.round(n)));
    }

    function normalizeBatterySettingsState(changedBy) {
        if (!state.batterySettings || typeof state.batterySettings !== "object") {
            state.batterySettings = {
                enabled: false,
                switchIp: "",
                thresholdOffPct: 85,
                thresholdOnPct: 40
            };
        }

        const bs = state.batterySettings;
        bs.enabled = !!bs.enabled;
        bs.switchIp = String(bs.switchIp || "").trim();
        bs.thresholdOffPct = clampBatteryThreshold(bs.thresholdOffPct, 85);
        bs.thresholdOnPct = clampBatteryThreshold(bs.thresholdOnPct, 40);

        if (bs.thresholdOnPct >= bs.thresholdOffPct) {
            if (changedBy === "thresholdOn") {
                bs.thresholdOffPct = Math.min(100, bs.thresholdOnPct + 1);
            } else {
                bs.thresholdOnPct = Math.max(0, bs.thresholdOffPct - 1);
            }
        }
    }

    let batteryAutomationSyncTimer = null;

    async function syncBatteryAutomationConfigToServer() {
        const bs = state && state.batterySettings ? state.batterySettings : {};
        const payload = {
            enabled: !!bs.enabled,
            switchIp: String(bs.switchIp || "").trim(),
            thresholdOffPct: clampBatteryThreshold(bs.thresholdOffPct, 85),
            thresholdOnPct: clampBatteryThreshold(bs.thresholdOnPct, 40)
        };
        try {
            await fetch("/api/battery-automation/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        } catch (_) {
            // Non-fatal: automation still has fallback config paths.
        }
    }

    function scheduleBatteryAutomationConfigSync() {
        if (batteryAutomationSyncTimer) {
            clearTimeout(batteryAutomationSyncTimer);
        }
        batteryAutomationSyncTimer = setTimeout(() => {
            batteryAutomationSyncTimer = null;
            syncBatteryAutomationConfigToServer();
        }, 120);
    }

    function isBatteryAutomationEnabled() {
        return !!(state.batterySettings && state.batterySettings.enabled);
    }

    function getBatterySwitchHost() {
        return String(state.batterySettings && state.batterySettings.switchIp || "").trim();
    }

    function isBatterySwitchInteractionEnabled() {
        return isBatteryAutomationEnabled() && !!getBatterySwitchHost();
    }

    function setBatterySwitchDisabledState(note) {
        batterySwitchPower = null;
        if (!els.batterySwitchToggleBtn) return;
        const btn = els.batterySwitchToggleBtn;
        btn.classList.remove("is-on", "is-off", "is-unknown");
        btn.classList.add("is-disabled");
        btn.textContent = note ? `Switch: ${note}` : "Switch: Disabled";
    }

    function syncBatteryUi() {
        normalizeBatterySettingsState();
        const bs = state.batterySettings;
        const isEnabled = isBatteryAutomationEnabled();
        const hasSwitchHost = !!getBatterySwitchHost();

        if (els.batterySettingsEnabled) {
            els.batterySettingsEnabled.checked = isEnabled;
        }
        if (els.batterySwitchHostGroup) {
            els.batterySwitchHostGroup.classList.toggle("is-disabled", !isEnabled);
        }
        if (els.batterySwitchIp) {
            els.batterySwitchIp.value = bs.switchIp || "";
            els.batterySwitchIp.disabled = !isEnabled;
        }
        if (els.batteryThresholdOff) {
            els.batteryThresholdOff.value = bs.thresholdOffPct;
            els.batteryThresholdOff.disabled = !isEnabled;
        }
        if (els.batteryThresholdOn) {
            els.batteryThresholdOn.value = bs.thresholdOnPct;
            els.batteryThresholdOn.disabled = !isEnabled;
        }
        if (els.batteryThresholdControls) {
            els.batteryThresholdControls.classList.toggle("is-disabled", !isEnabled);
        }
        const switchActionsEnabled = isEnabled && hasSwitchHost;
        if (els.batterySwitchRefreshBtn) {
            els.batterySwitchRefreshBtn.disabled = !switchActionsEnabled;
        }
        if (els.batterySwitchToggleBtn) {
            els.batterySwitchToggleBtn.disabled = !switchActionsEnabled;
        }
        if (els.batterySwitchToggleBtn && !switchActionsEnabled) {
            els.batterySwitchToggleBtn.classList.add("is-disabled");
        }
        if (els.batterySwitchToggleBtn) {
            els.batterySwitchToggleBtn.classList.toggle("is-disabled", !switchActionsEnabled);
        }
        if (els.batterySwitchRefreshBtn) {
            els.batterySwitchRefreshBtn.classList.toggle("is-disabled", !switchActionsEnabled);
        }
        if (els.batterySwitchToggleBtn && !isEnabled) {
            setBatterySwitchDisabledState("Disabled");
        } else if (els.batterySwitchToggleBtn && !hasSwitchHost) {
            setBatterySwitchDisabledState("Unconfigured");
        } else if (els.batterySwitchToggleBtn && batterySwitchPower == null) {
            setBatterySwitchState(null);
        }
        const switchControlsDisabled = !switchActionsEnabled;
        const switchControls = document.querySelector(".battery-switch-controls");
        if (switchControls) {
            switchControls.classList.toggle("is-disabled", switchControlsDisabled);
        }
    }

    function setBatterySwitchState(power, note) {
        const up = typeof power === "string" ? power.toUpperCase() : null;
        batterySwitchPower = (up === "ON" || up === "OFF") ? up : null;
        if (!els.batterySwitchToggleBtn) return;
        const btn = els.batterySwitchToggleBtn;
        btn.classList.remove("is-on", "is-off", "is-unknown", "is-disabled");
        if (batterySwitchPower === "ON") {
            btn.classList.add("is-on");
            btn.textContent = note ? `Switch: ON (${note})` : "Switch: ON";
            return;
        }
        if (batterySwitchPower === "OFF") {
            btn.classList.add("is-off");
            btn.textContent = note ? `Switch: OFF (${note})` : "Switch: OFF";
            return;
        }
        btn.classList.add("is-unknown");
        btn.textContent = note ? `Switch: Unknown (${note})` : "Switch: Unknown";
    }

    function computeBatteryChargeTrend(chart) {
        const series = Array.isArray(chart && chart.battery) ? chart.battery : [];
        const values = series
            .map(v => Number(v))
            .filter(v => Number.isFinite(v));
        if (values.length < 2) return null;

        const movingAverage = (arr) => arr.reduce((sum, value) => sum + value, 0) / arr.length;
        const windowSize = Math.min(3, Math.max(1, Math.floor(values.length / 2)));
        const recent = values.slice(-windowSize);
        const previous = values.slice(-(windowSize * 2), -windowSize);

        if (previous.length === windowSize) {
            const delta = movingAverage(recent) - movingAverage(previous);
            if (delta > 0.05) return "rising";
            if (delta < -0.05) return "falling";
            return "flat";
        }

        const delta = values[values.length - 1] - values[0];
        if (delta > 0) return "rising";
        if (delta < 0) return "falling";
        return "flat";
    }

    async function batterySwitchRequest(path, options) {
        const bs = state.batterySettings || {};
        const ip = String(bs.switchIp || "").trim();
        if (!ip) throw new Error("No switch IP configured");

        const opts = Object.assign({ method: "GET", headers: {} }, options || {});
        if (opts.body && typeof opts.body !== "string") {
            opts.headers["Content-Type"] = "application/json";
            opts.body = JSON.stringify(opts.body);
        }
        const url = path.indexOf("?") >= 0 ? path : `${path}?ip=${encodeURIComponent(ip)}`;
        const resp = await fetch(url, opts);
        let payload = {};
        try {
            payload = await resp.json();
        } catch (_) {}
        if (!resp.ok || payload.ok === false) {
            throw new Error(payload.error || `Request failed (${resp.status})`);
        }
        return payload;
    }

    async function refreshBatterySwitchState(options) {
        const opts = options || {};
        if (!isBatteryAutomationEnabled()) {
            setBatterySwitchDisabledState("Disabled");
            return false;
        }
        if (!getBatterySwitchHost()) {
            setBatterySwitchDisabledState("Unconfigured");
            return false;
        }
        try {
            setBatterySwitchState(null, "Checking");
            const payload = await batterySwitchRequest("/api/battery-switch/state");
            setBatterySwitchState(payload.power);
            return true;
        } catch (e) {
            if (opts.suppressError) {
                if (opts.fallbackPower) {
                    setBatterySwitchState(opts.fallbackPower, opts.fallbackNote || "State check pending");
                }
                return false;
            }
            setBatterySwitchState(null, `Error: ${e.message}`);
            return false;
        }
    }

    async function sendBatterySwitchAction(action) {
        const endpoint = action === "on" ? "/api/battery-switch/on" : "/api/battery-switch/off";
        if (!isBatteryAutomationEnabled()) {
            setBatterySwitchDisabledState("Disabled");
            return;
        }
        const bs = state.batterySettings || {};
        const ip = String(bs.switchIp || "").trim();
        if (!ip) {
            setBatterySwitchDisabledState("Unconfigured");
            return;
        }
        try {
            setBatterySwitchState(batterySwitchPower, `Sending ${action.toUpperCase()}`);
            const payload = await batterySwitchRequest(endpoint, { method: "POST", body: { ip } });
            const reportedPower = payload && typeof payload.power === "string" ? payload.power.toUpperCase() : null;
            const fallbackPower = (reportedPower === "ON" || reportedPower === "OFF")
                ? reportedPower
                : (action === "on" ? "ON" : "OFF");
            setBatterySwitchState(fallbackPower, "Applied");
            await refreshBatterySwitchState({
                suppressError: true,
                fallbackPower,
                fallbackNote: "Applied"
            });
        } catch (e) {
            setBatterySwitchState(null, `Error: ${e.message}`);
        }
    }

    async function toggleBatterySwitchState() {
        if (!isBatterySwitchInteractionEnabled()) {
            if (!isBatteryAutomationEnabled()) setBatterySwitchDisabledState("Disabled");
            else setBatterySwitchDisabledState("Unconfigured");
            return;
        }
        if (batterySwitchPower == null) {
            await refreshBatterySwitchState({ suppressError: true });
        }
        const nextAction = batterySwitchPower === "ON" ? "off" : "on";
        await sendBatterySwitchAction(nextAction);
    }

    function drawBatteryHistoryGraph(chart) {
        const canvas = els.batteryHistoryCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const parentW = canvas.parentElement && canvas.parentElement.clientWidth ? canvas.parentElement.clientWidth : 320;
        const width = Math.max(280, parentW - 4);
        const height = 140;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = "#0c1017";
        ctx.fillRect(0, 0, width, height);

        const padL = 30;
        const padR = 30;
        const padT = 8;
        const padB = 24;
        const plotW = width - padL - padR;
        const plotH = height - padT - padB;

        const drawHorizontalGrid = (dataPlotHeight) => {
            ctx.strokeStyle = "#1d2a3a";
            ctx.lineWidth = 1;
            for (let pct = 0; pct <= 100; pct += 25) {
                const y = padT + ((100 - pct) / 100) * dataPlotHeight;
                ctx.beginPath();
                ctx.moveTo(padL, y);
                ctx.lineTo(padL + plotW, y);
                ctx.stroke();
                ctx.fillStyle = "#7f93a7";
                ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
                ctx.textAlign = "right";
                ctx.fillText(`${pct}%`, padL - 4, y + 3);
            }
        };

        const battery = Array.isArray(chart && chart.battery) ? chart.battery : [];
        const thresholdOn = Array.isArray(chart && chart.thresholdOn) ? chart.thresholdOn : [];
        const thresholdOff = Array.isArray(chart && chart.thresholdOff) ? chart.thresholdOff : [];
        const switchOn = Array.isArray(chart && chart.switchOn) ? chart.switchOn : [];
        const n = Math.max(2, battery.length, thresholdOn.length, thresholdOff.length, switchOn.length);
        const bucketZeroMs = Number(chart && chart.bucketZeroMs) || (Date.now() - (n - 1) * 10 * 60 * 1000);
        const bucketMs = Number(chart && chart.bucketMs) || (10 * 60 * 1000);

        const zoomLevelsDays = [0.125, 0.25, 0.5, 1, 3, 5, 7];
        const dayMs = 24 * 60 * 60 * 1000;
        let firstDataIdx = -1;
        let lastDataIdx = -1;
        for (let i = 0; i < n; i++) {
            const v = i < battery.length ? Number(battery[i]) : NaN;
            if (!Number.isFinite(v)) continue;
            if (firstDataIdx < 0) firstDataIdx = i;
            lastDataIdx = i;
        }

        let visibleDays = zoomLevelsDays[0];
        if (firstDataIdx >= 0 && lastDataIdx >= firstDataIdx) {
            const sampleSpanFromChart = Number(chart && chart.batterySampleSpanMs);
            const sampleCountFromChart = Number(chart && chart.batterySampleCount);
            const fallbackPoints = battery.reduce((acc, v) => {
                const n = Number(v);
                return acc + (Number.isFinite(n) ? 1 : 0);
            }, 0);
            let collectedSpanMs = 0;
            if (Number.isFinite(sampleSpanFromChart) && sampleSpanFromChart > 0) {
                collectedSpanMs = sampleSpanFromChart;
            } else if (Number.isFinite(sampleCountFromChart) && sampleCountFromChart > 0) {
                collectedSpanMs = Math.max(bucketMs, sampleCountFromChart * bucketMs);
            } else if (fallbackPoints > 0) {
                collectedSpanMs = Math.max(bucketMs, fallbackPoints * bucketMs);
            }
            const collectedDays = collectedSpanMs > 0 ? (collectedSpanMs / dayMs) : 0;
            visibleDays = zoomLevelsDays[0];
            for (const d of zoomLevelsDays) {
                if (collectedDays >= d) visibleDays = d;
            }
        }

        const visibleBuckets = Math.max(2, Math.min(n, Math.ceil((visibleDays * dayMs) / bucketMs)));
        const startIdx = Math.max(0, n - visibleBuckets);
        const nVis = Math.max(2, n - startIdx);
        const visibleBucketZeroMs = bucketZeroMs + startIdx * bucketMs;
        const visibleStartMs = visibleBucketZeroMs;
        const visibleEndMs = visibleBucketZeroMs + Math.max(bucketMs, (nVis - 1) * bucketMs);
        const visibleSpanMs = Math.max(bucketMs, visibleEndMs - visibleStartMs);

        const valueAt = (arr, i, fallback = null) => {
            if (!Array.isArray(arr) || !arr.length) return fallback;
            if (i < arr.length) return arr[i];
            return arr[arr.length - 1];
        };
        const sliceSeries = (arr, fallback = null) => {
            const out = [];
            for (let i = startIdx; i < n; i++) {
                out.push(valueAt(arr, i, fallback));
            }
            return out;
        };

        const batteryVis = sliceSeries(battery, null);
        const thresholdOnVis = sliceSeries(thresholdOn, 40);
        const thresholdOffVis = sliceSeries(thresholdOff, 85);
        const switchOnVis = sliceSeries(switchOn, 0).map(v => Number(v) > 0 ? 1 : 0);
        const chargingOnRaw = Array.isArray(chart && chart.chargingOn) ? chart.chargingOn : [];
        let chargingOnVis;
        if (chargingOnRaw.length) {
            chargingOnVis = sliceSeries(chargingOnRaw, 0).map(v => Number(v) > 0 ? 1 : 0);
        } else {
            const derived = new Array(nVis).fill(0);
            let prevBattery = null;
            for (let i = 0; i < nVis; i++) {
                const v = Number(batteryVis[i]);
                if (Number.isFinite(v)) {
                    if (prevBattery != null) derived[i] = v > prevBattery ? 1 : 0;
                    prevBattery = v;
                }
            }
            chargingOnVis = derived;
        }

        const toX = (i) => nVis <= 1 ? padL : padL + (i / (nVis - 1)) * plotW;
        const barsTotalH = Math.max(16, Math.round(plotH * 0.16));
        const barsGap = 2;
        const barsH = Math.max(5, Math.floor((barsTotalH - barsGap) / 2));
        const dataPlotH = Math.max(40, plotH - barsTotalH - 2);
        const toY = (v) => padT + ((100 - Math.max(0, Math.min(100, Number(v)))) / 100) * dataPlotH;

        drawHorizontalGrid(dataPlotH);

        ctx.save();
        ctx.strokeStyle = "#1e2e42";
        ctx.fillStyle = "#8ca1b7";
        ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
        let majorTickMs;
        if (visibleDays < 0.25) {
            majorTickMs = 30 * 60 * 1000;  // 30 min for 0-6 hours
        } else if (visibleDays < 0.5) {
            majorTickMs = 60 * 60 * 1000;  // 1 hour for 6-12 hours
        } else if (visibleDays < 1) {
            majorTickMs = 2 * 60 * 60 * 1000;  // 2 hours for 12-24 hours
        } else if (visibleDays <= 1) {
            majorTickMs = 3 * 60 * 60 * 1000;  // 3 hours for 1 day
        } else {
            majorTickMs = dayMs;  // 1 day for multi-day views
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
            ctx.lineTo(x, padT + dataPlotH);
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

        const chargingRowY = padT + dataPlotH + 1;
        const switchRowY = chargingRowY + barsH + barsGap;
        const drawStateRow = (label, y, rowValues, fillStyle) => {
            ctx.save();
            ctx.fillStyle = "rgba(19, 31, 46, 0.9)";
            ctx.fillRect(padL, y, plotW, barsH);
            ctx.strokeStyle = "#223449";
            ctx.lineWidth = 1;
            ctx.strokeRect(padL, y, plotW, barsH);
            ctx.fillStyle = fillStyle;
            for (let i = 0; i < nVis; i++) {
                if (Number(rowValues[i]) <= 0) continue;
                const x0 = toX(i);
                const x1 = i < nVis - 1 ? toX(i + 1) : (padL + plotW);
                const w = Math.max(1, x1 - x0);
                ctx.fillRect(x0, y, w, barsH);
            }
            ctx.fillStyle = "#8ca1b7";
            ctx.font = "9px ui-monospace, Menlo, Consolas, monospace";
            ctx.textAlign = "left";
            ctx.fillText(label, padL + 2, y + barsH - 2);
            ctx.restore();
        };

        drawStateRow("charging on", chargingRowY, chargingOnVis, "rgba(78, 205, 196, 0.62)");
        drawStateRow("switch on", switchRowY, switchOnVis, "rgba(102, 220, 128, 0.66)");

        const drawStep = (arr, color, dash) => {
            if (!arr.length) return;
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.4;
            if (dash) ctx.setLineDash(dash);
            ctx.beginPath();
            let prevY = toY(arr[0]);
            ctx.moveTo(toX(0), prevY);
            for (let i = 1; i < nVis; i++) {
                const val = i < arr.length ? arr[i] : arr[arr.length - 1];
                const y = toY(val);
                const x = toX(i);
                ctx.lineTo(x, prevY);
                if (y !== prevY) {
                    ctx.lineTo(x, y);
                    prevY = y;
                }
            }
            ctx.stroke();
            ctx.restore();
        };

        if (state.batterySettings && state.batterySettings.enabled) {
            drawStep(thresholdOffVis, "rgba(255, 126, 103, 0.72)");
            drawStep(thresholdOnVis, "rgba(78, 205, 196, 0.72)");
        }

        if (batteryVis.length) {
            ctx.save();
            ctx.strokeStyle = "#f2d66b";
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < nVis; i++) {
                const v = batteryVis[i];
                if (v == null || !Number.isFinite(Number(v))) continue;
                const x = toX(i);
                const y = toY(v);
                if (!started) {
                    ctx.moveTo(x, y);
                    started = true;
                } else {
                    ctx.lineTo(x, y);
                }
            }
            if (started) ctx.stroke();
            ctx.restore();
        }

        const nowBattery = Number(chart && chart.nowBattery);
        if (Number.isFinite(nowBattery)) {
            const nowMsRaw = Number(chart && chart.nowMs);
            const nowMs = Number.isFinite(nowMsRaw) ? nowMsRaw : visibleEndMs;
            const ratioNow = Math.max(0, Math.min(1, (nowMs - visibleStartMs) / visibleSpanMs));
            const xNow = padL + ratioNow * plotW;
            const yNow = toY(nowBattery);

            ctx.save();
            ctx.fillStyle = "#f2d66b";
            ctx.strokeStyle = "rgba(242, 214, 107, 0.35)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(xNow, yNow, 3.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }

    }

    async function refreshBatteryGraphFromInfo() {
        try {
            const r = await fetch("/api/info", { cache: "no-store" });
            if (!r.ok) return;
            const payload = await r.json();
            drawBatteryHistoryGraph(payload && payload.chart ? payload.chart : {});
            // Update live status row
            const chart = payload && payload.chart ? payload.chart : {};
            const nowBattery = Number(chart.nowBattery);
            if (els.batteryLiveCharge) {
                els.batteryLiveCharge.textContent = Number.isFinite(nowBattery) && nowBattery >= 0
                    ? `${nowBattery}%`
                    : "—%";
            }
            if (els.batteryLiveCharging) {
                const automationEnabled = isBatteryAutomationEnabled();
                const switchSeries = Array.isArray(chart.switchOn) ? chart.switchOn : [];
                const switchFromChart = switchSeries.length ? (Number(switchSeries[switchSeries.length - 1]) > 0 ? "ON" : "OFF") : null;
                const switchPower = automationEnabled ? (batterySwitchPower || switchFromChart) : null;
                const chargeTrend = computeBatteryChargeTrend(chart);

                const mW = payload && payload.milliWatts != null ? Number(payload.milliWatts)
                    : (payload && payload.power && payload.power.milliWatts != null ? Number(payload.power.milliWatts) : NaN);

                let chargingText = "Charging: —";
                let chargingColor = "#7f93a7";

                if (automationEnabled && switchPower === "OFF") {
                    chargingText = "Charging: NO (switch OFF)";
                    chargingColor = "#7f93a7";
                } else if (chargeTrend === "rising") {
                    chargingText = "Charging: YES ▲";
                    chargingColor = "#4ecdc4";
                } else if (chargeTrend === "flat" || chargeTrend === "falling") {
                    if (automationEnabled && switchPower === "ON") {
                        chargingText = "Charging: WAIT";
                        chargingColor = "#f2d66b";
                    } else {
                        chargingText = "Charging: NO";
                        chargingColor = "#7f93a7";
                    }
                } else if (Number.isFinite(mW) && mW > 0) {
                    chargingText = "Charging: YES ▲";
                    chargingColor = "#4ecdc4";
                }

                els.batteryLiveCharging.textContent = chargingText;
                els.batteryLiveCharging.style.color = chargingColor;
            }
        } catch (_) {}
    }

    async function requestBatterySampleNow() {
        try {
            await fetch("/api/battery/sample", { method: "POST", cache: "no-store" });
        } catch (_) {}
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
        const vw = Number.isFinite(c.width) ? c.width : 240;
        const vh = Number.isFinite(c.height) ? c.height : 135;
        const realW = Math.round(vw * sc);
        const realH = Math.round(vh * sc);
        els.containerSizeHint.textContent = `Virtual: ${vw}×${vh} px  (${realW}×${realH} real, ${sc}px/virtual px)`;
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
        if (els.showGpuInfo) els.showGpuInfo.checked = state.showGpuInfo === true;
        // Show simulation section only for clients that support real popout windows
        const simSection = document.getElementById("simulatedDisplaySection");
        if (simSection) {
            const supportsPopup = typeof prefersExternalSimulationPopup === "function" && prefersExternalSimulationPopup();
            simSection.style.display = supportsPopup ? "" : "none";
        }
        // Container mode
        if (els.containerEnabled) {
            const c = state.container || {};
            els.containerEnabled.checked = !!c.enabled;
            if (els.containerScale)    els.containerScale.value    = c.scale != null ? c.scale : 4;
            if (els.containerScaleValue) els.containerScaleValue.textContent = (c.scale != null ? c.scale : 4) + "px";
            const initW = c.width != null ? c.width : 320;
            const initH = c.height != null ? c.height : 240;
            if (els.containerWidth) {
                els.containerWidth.value = initW;
                els.containerWidth.step = initW > 300 ? 10 : 2;
            }
            if (els.containerWidthValue) els.containerWidthValue.textContent = initW + "px";
            if (els.containerHeight) {
                els.containerHeight.value = initH;
                els.containerHeight.step = initH > 300 ? 10 : 2;
            }
            if (els.containerHeightValue) els.containerHeightValue.textContent = initH + "px";
            if (els.containerControls) els.containerControls.style.display = c.enabled ? "" : "none";
            updateContainerSizeHint();
        }
        if (els.glowEnabled) els.glowEnabled.checked = !!state.glowEnabled;
        if (els.glowAmount) els.glowAmount.value = state.glowAmount != null ? state.glowAmount : 5;
        if (els.glowAmountValue) els.glowAmountValue.textContent = state.glowAmount != null ? state.glowAmount : 5;
        if (els.glowIntensity) els.glowIntensity.value = state.glowIntensity != null ? state.glowIntensity : 3;
        if (els.glowIntensityValue) els.glowIntensityValue.textContent = state.glowIntensity != null ? state.glowIntensity : 3;
        if (els.glowControls) els.glowControls.style.display = state.glowEnabled ? "" : "none";
        const _vis = state.visibility || {};
        if (els.visWeekday)  els.visWeekday.checked  = _vis.weekday  !== false;
        if (els.visDay)      els.visDay.checked      = _vis.day      !== false;
        if (els.visMonth)    els.visMonth.checked    = _vis.month    !== false;
        if (els.visYear)     els.visYear.checked     = _vis.year     !== false;
        if (els.visHour)     els.visHour.checked     = _vis.hour     !== false;
        if (els.visMinute)   els.visMinute.checked   = _vis.minute   !== false;
        if (els.visSeconds)  els.visSeconds.checked  = _vis.seconds  !== false;
        if (els.visMillis)   els.visMillis.checked   = _vis.millis   === true;
        if (els.millisDecimals) els.millisDecimals.value = state.millisDecimals != null ? state.millisDecimals : 3;
        if (els.millisDecimalsValue) els.millisDecimalsValue.textContent = state.millisDecimals != null ? state.millisDecimals : 3;
        if (els.sizeBudget) els.sizeBudget.value = state.sizeBudget;
        if (els.ntpServer) els.ntpServer.value = state.ntpServer || "";
        if (els.sleepTimeoutSelect) els.sleepTimeoutSelect.value = state.sleepTimeout || 0;
        if (els.padHours) els.padHours.checked = state.padHours === true;
        if (els.recenterLeadingOne) els.recenterLeadingOne.checked = state.recenterLeadingOne === true;

        normalizeBatterySettingsState();
        syncBatteryUi();

        // Font selects: set whenever fonts are already populated (e.g. profile switch).
        // On first load populateFontSelects() handles this; setting here is harmless
        // if options aren't ready yet (no matching option → value stays unchanged).
        if (els.numericFontSelect) els.numericFontSelect.value = state.numericFont;
        if (els.alphaFontSelect)   els.alphaFontSelect.value   = state.alphaFont;
        if (els.colonFontSelect)   els.colonFontSelect.value   = state.colonFont;

        syncMultiFontUi();

        updateBadgesFromState();
    }

    function readFormIntoState(changedBy) {
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

        const prevEnabled = !!(state.batterySettings && state.batterySettings.enabled);
        state.batterySettings = {
            enabled: els.batterySettingsEnabled ? !!els.batterySettingsEnabled.checked : prevEnabled,
            switchIp: els.batterySwitchIp ? (els.batterySwitchIp.value || "") : "",
            thresholdOffPct: els.batteryThresholdOff ? Number(els.batteryThresholdOff.value) : 85,
            thresholdOnPct: els.batteryThresholdOn ? Number(els.batteryThresholdOn.value) : 40
        };
        normalizeBatterySettingsState(changedBy);
        syncBatteryUi();

        state.visibility = {
            weekday:  els.visWeekday  ? els.visWeekday.checked  : true,
            day:      els.visDay      ? els.visDay.checked      : true,
            month:    els.visMonth    ? els.visMonth.checked    : true,
            year:     els.visYear     ? els.visYear.checked     : true,
            hour:     els.visHour     ? els.visHour.checked     : true,
            minute:   els.visMinute   ? els.visMinute.checked   : true,
            seconds:  els.visSeconds  ? els.visSeconds.checked  : true,
            millis:   els.visMillis   ? els.visMillis.checked   : false,
        };
        if (els.millisDecimals) state.millisDecimals = Math.min(3, Math.max(1, Number(els.millisDecimals.value) || 3));

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
        const colonMillisEl = document.getElementById("colon-millis");

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

        // colon-millis uses seconds font/color/offset (it's a '.' separator, not a colon)
        if (colonMillisEl) {
            const secOffsetEm = ((state.secOffset || 0) + numericBaselineOffset) * (state.numericScale / 100);
            colonMillisEl.style.fontFamily = `"${state.numericFont}", monospace`;
            colonMillisEl.style.letterSpacing = `${numericLetterSpacing}em`;
            colonMillisEl.style.transform = `translateY(${secOffsetEm}em)`;
            colonMillisEl.style.color = state.secColor;
            colonMillisEl.textContent = ".";
        }
        const millisEl = document.getElementById("millis");
        if (millisEl) millisEl.style.color = state.secColor;

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
            els.recenterLeadingOne,
            els.batterySettingsEnabled,
            els.batterySwitchIp,
            els.batteryThresholdOn,
            els.batteryThresholdOff
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
                let changedBy = null;
                if (input === els.batteryThresholdOn) changedBy = "thresholdOn";
                if (input === els.batteryThresholdOff) changedBy = "thresholdOff";
                readFormIntoState(changedBy);
                applyState();
                saveCurrentState();
                if (input === els.batterySettingsEnabled ||
                    input === els.batterySwitchIp ||
                    input === els.batteryThresholdOn ||
                    input === els.batteryThresholdOff) {
                    if (typeof saveBatterySettings === "function") saveBatterySettings();
                    scheduleBatteryAutomationConfigSync();
                }
            });
        });

        if (els.batterySwitchRefreshBtn) {
            els.batterySwitchRefreshBtn.addEventListener("click", async () => {
                await requestBatterySampleNow();
                await refreshBatteryGraphFromInfo();
                await refreshBatterySwitchState();
            });
        }
        if (els.batterySwitchToggleBtn) {
            els.batterySwitchToggleBtn.addEventListener("click", () => {
                toggleBatterySwitchState();
            });
        }

        if (els.showDebug) {
            els.showDebug.addEventListener("change", () => {
                state.showDebug = els.showDebug.checked;
                if (typeof saveShowDebug === "function") saveShowDebug(state.showDebug);
                if (typeof scheduleRowCoordinateDisplayUpdate === "function") scheduleRowCoordinateDisplayUpdate();
                // Sync debug outline on container
                if (typeof applyContainerMode === "function") applyContainerMode();
            });
        }

        if (els.showGpuInfo) {
            els.showGpuInfo.addEventListener("change", () => {
                state.showGpuInfo = els.showGpuInfo.checked;
                if (typeof saveShowGpuInfo === "function") saveShowGpuInfo(state.showGpuInfo);
                if (typeof scheduleGpuHealthOverlayUpdate === "function") scheduleGpuHealthOverlayUpdate();
            });
        }

        function readContainerFromForm() {
            if (!els.containerEnabled) return;
            const sc = parseFloat(els.containerScale ? els.containerScale.value : 4);
            const w = parseInt(els.containerWidth ? els.containerWidth.value : 240, 10);
            const h = parseInt(els.containerHeight ? els.containerHeight.value : 135, 10);
            state.container = {
                enabled: els.containerEnabled.checked,
                scale:   Number.isFinite(sc) && sc >= 1 ? sc : 4,
                width:   Number.isFinite(w) && w >= 10 ? Math.round(w) : 240,
                height:  Number.isFinite(h) && h >= 10 ? Math.round(h) : 135,
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

        [els.containerScale, els.containerWidth, els.containerHeight].forEach(el => {
            if (!el) return;
            // Live badge/step updates while dragging — do NOT reopen the popup mid-drag.
            el.addEventListener("input", () => {
                if (el === els.containerScale && els.containerScaleValue) {
                    els.containerScaleValue.textContent = el.value + "px";
                }
                if (el === els.containerWidth) {
                    const v = parseInt(el.value, 10);
                    el.step = v > 300 ? 10 : 2;
                    if (els.containerWidthValue) els.containerWidthValue.textContent = v + "px";
                }
                if (el === els.containerHeight) {
                    const v = parseInt(el.value, 10);
                    el.step = v > 300 ? 10 : 2;
                    if (els.containerHeightValue) els.containerHeightValue.textContent = v + "px";
                }
                readContainerFromForm();
                updateContainerSizeHint();
                // Popup reopen deferred to "change" (thumb released / key-up).
            });
            // Reopen popup with new dimensions after the thumb is released or a key is released.
            el.addEventListener("change", () => {
                readContainerFromForm();
                updateContainerSizeHint();
                if (typeof closeExternalSimulationPopup === "function") closeExternalSimulationPopup();
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

        [els.visWeekday, els.visDay, els.visMonth, els.visYear,
         els.visHour, els.visMinute, els.visSeconds, els.visMillis].filter(Boolean).forEach(el => {
            el.addEventListener("change", () => {
                readFormIntoState();
                if (typeof window.applyClockPartsVisibility === "function") window.applyClockPartsVisibility();
                applyState();
                saveCurrentState();
            });
        });

        if (els.millisDecimals) {
            els.millisDecimals.addEventListener("input", () => {
                if (els.millisDecimalsValue) els.millisDecimalsValue.textContent = els.millisDecimals.value;
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
            delete data.showGpuInfo;
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
    scheduleBatteryAutomationConfigSync();

    refreshBatteryGraphFromInfo();
    refreshBatterySwitchState();
    setInterval(() => {
        refreshBatteryGraphFromInfo();
    }, 60 * 1000);
    setInterval(() => {
        refreshBatterySwitchState();
    }, 60 * 1000);

    // Expose a single entry point that re-reads localStorage (e.g. after a
    // remote control client pushed a new state) and refreshes both the
    // configuration form and the live clock to match.
    window.refreshFromStoredState = function () {
        try { loadCurrentState(); } catch (e) {}
        try { initFormFromState(); } catch (e) {}
        try { applyState(); } catch (e) {}
    };
}