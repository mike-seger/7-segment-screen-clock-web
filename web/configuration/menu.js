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
// menu.css and symbols.css are preloaded in index.html <head>, so no dynamic injection needed.
let menuCssLoaded = true;

function loadMenuCSS() {
    if (menuCssLoaded) return;

    const symLink = document.createElement("link");
    symLink.rel = "stylesheet";
    symLink.href = "symbols.css";
    document.head.appendChild(symLink);

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "configuration/menu.css";
    document.head.appendChild(link);
    menuCssLoaded = true;
}

let menuLoaded = false;
let configurationInitialized = false;

function initMenuEvents() {
    const panel = document.getElementById('menuPanel');
    if (!panel) return;

    // ---- DRAG AND DROP POSITION PERSISTENCE ----
    const closeBtn = document.getElementById('menuCloseBtn');
    let dragging = false;
    let dragOffX = 0, dragOffY = 0;

    function isInteractiveTarget(target) {
        if (!target || !(target instanceof Element)) return false;
        return !!target.closest(
            '#menuCloseBtn, .menuTab, button, input, select, textarea, label, a, [role="button"], [contenteditable="true"]'
        );
    }

    // Restore Position
    try {
        const storedPos = localStorage.getItem('screenClock_menuPosition');
        if (storedPos) {
            const pos = JSON.parse(storedPos);
            if (pos.top !== undefined && pos.left !== undefined) {
                panel.style.top = pos.top;
                panel.style.left = pos.left;
                panel.style.right = 'auto';
            }
        }
    } catch (e) {
        console.warn('Failed to restore menu position:', e);
    }

    // Drag (Mouse)
    panel.addEventListener('mousedown', (e) => {
        if (e.target === closeBtn || e.target.closest('#menuCloseBtn')) return; // Don't drag if clicking close button
        if (isInteractiveTarget(e.target)) return;
        if (e.button !== 0) return; // Left click only
        dragging = true;
        const rect = panel.getBoundingClientRect();
        dragOffX = e.clientX - rect.left;
        dragOffY = e.clientY - rect.top;
        panel.style.cursor = 'grabbing';
        e.preventDefault();
    });

    const onMouseMove = (e) => {
        if (!dragging) return;
        const left = Math.max(0, Math.min(e.clientX - dragOffX, window.innerWidth - panel.offsetWidth)) + 'px';
        const top = Math.max(0, Math.min(e.clientY - dragOffY, window.innerHeight - panel.offsetHeight)) + 'px';
        panel.style.left = left;
        panel.style.top = top;
        panel.style.right = 'auto';
        try {
            localStorage.setItem('screenClock_menuPosition', JSON.stringify({ top, left }));
        } catch (e) {}
    };

    const onMouseUp = () => {
        if (dragging) {
            dragging = false;
            panel.style.cursor = '';
        }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Drag (Touch)
    panel.addEventListener('touchstart', (e) => {
        if (e.target === closeBtn || e.target.closest('#menuCloseBtn')) return;
        if (isInteractiveTarget(e.target)) return;
        const t = e.touches[0];
        dragging = true;
        const rect = panel.getBoundingClientRect();
        dragOffX = t.clientX - rect.left;
        dragOffY = t.clientY - rect.top;
        e.preventDefault();
    }, { passive: false });

    const onTouchMove = (e) => {
        if (!dragging) return;
        const t = e.touches[0];
        const left = Math.max(0, Math.min(t.clientX - dragOffX, window.innerWidth - panel.offsetWidth)) + 'px';
        const top = Math.max(0, Math.min(t.clientY - dragOffY, window.innerHeight - panel.offsetHeight)) + 'px';
        panel.style.left = left;
        panel.style.top = top;
        panel.style.right = 'auto';
        try {
            localStorage.setItem('screenClock_menuPosition', JSON.stringify({ top, left }));
        } catch (e) {}
        e.preventDefault();
    };

    const onTouchEnd = () => {
        dragging = false;
    };

    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);

    // ---- TAB SWITCHING ----
    const tabs = panel.querySelectorAll('.menuTab');
    const contents = panel.querySelectorAll('.menu-tab-content');

    const selectTab = (tabId) => {
        tabs.forEach(tab => {
            const isTarget = tab.getAttribute('data-tab') === tabId;
            tab.classList.toggle('active', isTarget);
        });
        contents.forEach(content => {
            const isTarget = content.id === `tab-${tabId}`;
            content.style.display = isTarget ? 'block' : 'none';
        });
        try {
            localStorage.setItem('screenClock_selectedTab', tabId);
        } catch (e) {}
    };

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabId = tab.getAttribute('data-tab');
            selectTab(tabId);
        });
    });

    // Restore Tab
    try {
        const lastTab = localStorage.getItem('screenClock_selectedTab') || 'fonts';
        selectTab(lastTab);
    } catch (e) {
        selectTab('fonts');
    }

    // ---- CLOSE BUTTON ----
    if (closeBtn) {
        closeBtn.addEventListener('click', toggleMenuPanel);
    }
}

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

        initMenuEvents();
    } catch (e) {
        console.error('Error loading menu.html', e);
    }
}

function constrainMenuPosition() {
    const panel = document.getElementById('menuPanel');
    if (!panel || panel.style.display !== "flex") return;

    const width = panel.offsetWidth || 380;
    const height = panel.offsetHeight || 550;

    const leftVal = parseFloat(panel.style.left);
    const topVal = parseFloat(panel.style.top);

    if (Number.isFinite(leftVal) && Number.isFinite(topVal)) {
        const left = Math.max(0, Math.min(leftVal, window.innerWidth - width)) + 'px';
        const top = Math.max(0, Math.min(topVal, window.innerHeight - height)) + 'px';
        panel.style.left = left;
        panel.style.top = top;
        panel.style.right = 'auto';
        try {
            localStorage.setItem('screenClock_menuPosition', JSON.stringify({ top, left }));
        } catch (e) {}
    }
}

window.addEventListener('resize', constrainMenuPosition);

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
    await ensureConfigurationInitialized();

    const panel = document.getElementById('menuPanel');
    if (!panel) return;

    loadMenuCSS();
    const isOpen = panel.style.display !== "flex";
    panel.style.display = isOpen ? "flex" : "none";
    if (isOpen) {
        requestAnimationFrame(constrainMenuPosition);
    }
    saveMenuOpenState(isOpen);
}

if (menuButton) {
    menuButton.addEventListener('click', toggleMenuPanel);
}

window.openMenuPanel = async function() {
    await ensureConfigurationInitialized();
    const panel = document.getElementById('menuPanel');
    if (!panel) return;
    saveMenuOpenState(true);
    loadMenuCSS();
    panel.style.display = "flex";
    requestAnimationFrame(constrainMenuPosition);
};

window.toggleConfigUI = async function() {
    const panel = document.getElementById('menuPanel');
    const panelVisible = panel && panel.style.display === "flex";

    if (panelVisible) {
        panel.style.display = "none";
        saveMenuOpenState(false);
    } else {
        await ensureConfigurationInitialized();
        const p = document.getElementById('menuPanel');
        if (!p) return;
        loadMenuCSS();
        p.style.display = "flex";
        requestAnimationFrame(constrainMenuPosition);
        saveMenuOpenState(true);
    }
};

// Apply persisted configuration immediately, even before entering configuration mode.
ensureConfigurationInitialized();

// Restore menu open state on page load
(async function restoreMenuState() {
    const wasOpen = loadMenuOpenState();
    if (wasOpen) {
        await ensureConfigurationInitialized();
        const panel = document.getElementById('menuPanel');
        if (panel) {
            loadMenuCSS();
            panel.style.display = "flex";
            requestAnimationFrame(constrainMenuPosition);
        }
    }
})();
