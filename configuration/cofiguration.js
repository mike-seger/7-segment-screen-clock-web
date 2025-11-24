

// ---------------- FORM / UI BINDING ----------------

function initConfiguration() {
    const els = {
        numericFontSelect: document.getElementById("numericFontSelect"),
        alphaFontSelect:   document.getElementById("alphaFontSelect"),
        numericScale:      document.getElementById("numericScale"),
        alphaScale:        document.getElementById("alphaScale"),
        numericOffset:     document.getElementById("numericOffset"),
        alphaOffset:       document.getElementById("alphaOffset"),

        numericScaleValue: document.getElementById("numericScaleValue"),
        alphaScaleValue:   document.getElementById("alphaScaleValue"),
        numericOffsetValue:document.getElementById("numericOffsetValue"),
        alphaOffsetValue:  document.getElementById("alphaOffsetValue"),

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
        deleteProfileBtn:  document.getElementById("deleteProfileBtn"),
        loadProfileBtn:    document.getElementById("loadProfileBtn")
    };

    function updateBadgesFromState() {
        els.numericScaleValue.textContent = state.numericScale + "%";
        els.alphaScaleValue.textContent   = state.alphaScale + "%";
        els.numericOffsetValue.textContent = state.numericOffset + "px";
        els.alphaOffsetValue.textContent   = state.alphaOffset + "px";
        els.dateFontSizeValue.textContent = state.dateFontSize + "px";
        els.timeFontSizeValue.textContent = state.timeFontSize + "px";
        els.secFontSizeValue.textContent  = state.secFontSize + "px";
    }

    function initFormFromState() {
        els.numericScale.value  = state.numericScale;
        els.alphaScale.value    = state.alphaScale;
        els.numericOffset.value = state.numericOffset;
        els.alphaOffset.value   = state.alphaOffset;

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
        state.numericOffset = Number(els.numericOffset.value);
        state.alphaOffset   = Number(els.alphaOffset.value);

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
        const colonMinEl = document.getElementById("colon-min");
        const secEl = document.getElementById("sec");
        const colonSecEl = document.getElementById("colon-sec");

        dateLine.style.color     = state.dateColor;
        dateLine.style.fontSize  = state.dateFontSize + "px";

        hourEl.style.color     = state.timeColor;
        hourEl.style.fontSize  = state.timeFontSize + "px";

        minEl.style.color     = state.timeColor;
        minEl.style.fontSize  = state.timeFontSize + "px";

        colonMinEl.style.color     = state.timeColor;
        colonMinEl.style.fontSize  = state.timeFontSize + "px";

        secEl.style.color        = state.secColor;
        secEl.style.fontSize     = state.secFontSize + "px";

        colonSecEl.style.color        = state.secColor;
        colonSecEl.style.fontSize     = state.secFontSize + "px";

        // numeric vs alpha groups
        document.querySelectorAll("#dateLine > .numeric-group").forEach(el => {
            el.style.transform  =
                `translateY(${state.numericOffset}px) scale(${state.numericScale/100})`;
        });
        
        document.querySelectorAll(".numeric-group").forEach(el => {
            el.style.fontFamily = `"${state.numericFont}", monospace`;
        });

        document.querySelectorAll(".alpha-group").forEach(el => {
            el.style.fontFamily = `"${state.alphaFont}", monospace`;
            el.style.transform  =
                `translateY(${state.alphaOffset}px) scale(${state.alphaScale/100})`;
        });
    }

    function attachFormListeners() {
        const inputs = [
            els.numericScale, els.alphaScale,
            els.numericOffset, els.alphaOffset,
            els.dateColor, els.dateFontSize,
            els.timeColor, els.timeFontSize,
            els.secColor, els.secFontSize,
            els.numericFontSelect, els.alphaFontSelect
        ];

        inputs.forEach(input => {
            input.addEventListener("input", () => {
                readFormIntoState();
                applyState();
                saveCurrentState();
            });
        });

        els.saveProfileBtn.onclick = () => {
            const name = els.profileName.value.trim();
            if (name) {
                readFormIntoState();
                applyState();
                saveCurrentState();
                saveProfile(name);
            }
        };

        els.deleteProfileBtn.onclick = () => {
            const name = els.profileSelect.value;
            if (name) {
                deleteProfile(name);
            }
        };

        els.loadProfileBtn.onclick = () => {
            const name = els.profileSelect.value;
            if (name) {
                loadProfile(name);
            }
        };
    }

    function populateProfileSelect() {
        const names = loadProfileNames();
        els.profileSelect.innerHTML = "";
        if (names.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "(no profiles)";
            els.profileSelect.appendChild(opt);
            return;
        }
        names.forEach(name => {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            els.profileSelect.appendChild(opt);
        });
    }

    // ---------------- DYNAMIC FONT DISCOVERY ----------------
    // Load fonts.css as text and extract each font-family

    function populateFontSelects(fontList) {
        const numericSel = els.numericFontSelect;
        const alphaSel   = els.alphaFontSelect;

        numericSel.innerHTML = "";
        alphaSel.innerHTML   = "";

        fontList.forEach(font => {
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
        if (fontList.includes(state.numericFont)) {
            numericSel.value = state.numericFont;
        }
        if (fontList.includes(state.alphaFont)) {
            alphaSel.value = state.alphaFont;
        }

        // ensure state uses whatever select currently shows
        state.numericFont = numericSel.value || state.numericFont;
        state.alphaFont   = alphaSel.value || state.alphaFont;

        applyState();
    }

    fetch("../fonts/fonts.css")
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
    initFormFromState();
    attachFormListeners();
    populateProfileSelect();
    applyState();
}