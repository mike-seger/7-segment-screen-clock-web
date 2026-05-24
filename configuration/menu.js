// ------------- MENU LAZY-LOAD -------------

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

        // inject at end of body (or into #menuPlaceholder)
        document.body.insertAdjacentHTML('beforeend', html);
        const panel = document.getElementById('menuPanel');
        if (panel) panel.style.display = 'none';
        menuLoaded = true;

        // if you have menu-init logic, call it here:
        // initMenuControls();
    } catch (e) {
        console.error('Error loading menu.html', e);
    }
}

async function ensureConfigurationInitialized() {
    if (configurationInitialized) return;
    await loadMenuPanel();
    if (typeof initConfiguration === 'function') {
        initConfiguration();
        configurationInitialized = true;
    }
}

async function toggleMenuPanel() {
    if (!menuButton || menuButton.style.display === "none") return;

    await ensureConfigurationInitialized();

    const panel = document.getElementById('menuPanel');
    if (!panel) return;

    loadMenuCSS();
    panel.style.display = (panel.style.display === "block" ? "none" : "block");
}

if (menuButton) {
    menuButton.addEventListener('click', toggleMenuPanel);
}

// Apply persisted configuration immediately, even before entering configuration mode.
ensureConfigurationInitialized();
