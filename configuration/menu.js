// ------------- MENU LAZY-LOAD -------------

// ---------------- MENU STATE PERSISTENCE ----------------

const STORAGE_KEY_MENU_OPEN = "screenClock_menuOpen";

function loadMenuOpenState() {
    try {
        return localStorage.getItem(STORAGE_KEY_MENU_OPEN) === "true";
    } catch {
        return false;
    }
}

function saveMenuOpenState(isOpen) {
    try {
        localStorage.setItem(STORAGE_KEY_MENU_OPEN, isOpen ? "true" : "false");
    } catch (e) {
        console.warn("Failed to save menu state", e);
    }
}

// ---------------- MENU TOGGLE ----------------

const menuButton = document.getElementById("menuButton");
let menuCssLoaded = false;

function loadMenuCSS() {
    if (menuCssLoaded) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "configuration/menu.css";
    document.head.appendChild(link);
    menuCssLoaded = true;
}

let menuLoaded = false;
let configurationInitialized = false;

async function loadMenuPanel() {
    if (menuLoaded) return;

    try {
        const resp = await fetch('configuration/menu.html');
        if (!resp.ok) {
            console.error('Failed to load menu.html', resp.status);
            return;
        }
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const panel = doc.getElementById('menuPanel');
        if (!panel) {
            console.error('menuPanel not found in menu.html');
            return;
        }

        const host = document.getElementById('menuPlaceholder') || document.body;
        host.appendChild(panel);
        panel.style.display = 'none';
        menuLoaded = true;

        // if you have menu-init logic, call it here:
        // initMenuControls();
    } catch (e) {
        console.error('Error loading menu.html', e);
    }
}

let initializationPromise = null;

async function ensureConfigurationInitialized() {
    if (configurationInitialized) return;
    if (initializationPromise) {
        return initializationPromise;
    }
    initializationPromise = (async () => {
        await loadMenuPanel();
        if (typeof initConfiguration === 'function') {
            initConfiguration();
            configurationInitialized = true;
        }
    })();
    return initializationPromise;
}

async function toggleMenuPanel() {
    if (!menuButton || menuButton.style.display === "none") return;

    await ensureConfigurationInitialized();

    const panel = document.getElementById('menuPanel');
    if (!panel) return;

    loadMenuCSS();
    const isOpen = panel.style.display !== "block";
    panel.style.display = isOpen ? "block" : "none";
    saveMenuOpenState(isOpen);
}

if (menuButton) {
    menuButton.addEventListener('click', toggleMenuPanel);
}

window.openMenuPanel = async function() {
    if (menuButton) menuButton.style.display = "block";
    await ensureConfigurationInitialized();
    const panel = document.getElementById('menuPanel');
    if (!panel) return;
    saveMenuOpenState(true);
    loadMenuCSS();
    panel.style.display = "block";
};

window.toggleConfigUI = async function() {
    const panel = document.getElementById('menuPanel');
    const panelVisible = panel && panel.style.display === "block";

    if (panelVisible) {
        panel.style.display = "none";
        if (menuButton) menuButton.style.display = "none";
        saveMenuOpenState(false);
    } else {
        if (menuButton) menuButton.style.display = "block";
        await ensureConfigurationInitialized();
        const p = document.getElementById('menuPanel');
        if (!p) return;
        loadMenuCSS();
        p.style.display = "block";
        saveMenuOpenState(true);
    }
};

// Apply persisted configuration immediately, even before entering configuration mode.
ensureConfigurationInitialized();

// Restore menu open state on page load
(async function restoreMenuState() {
    const wasOpen = loadMenuOpenState();
    if (wasOpen) {
        if (menuButton) menuButton.style.display = "block";
        await ensureConfigurationInitialized();
        const panel = document.getElementById('menuPanel');
        if (panel) {
            loadMenuCSS();
            panel.style.display = "block";
        }
    }
})();
