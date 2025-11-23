// ------------- MENU LAZY-LOAD -------------

// ---------------- MENU TOGGLE ----------------

document.getElementById("menuButton").style.display = "block";

function loadMenuCSS() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "menu.css";        // relative path allowed
    document.head.appendChild(link);
}

let menuLoaded = false;

async function loadMenuPanel() {
    if (menuLoaded) return;

    try {
        const resp = await fetch('menu.html');
        if (!resp.ok) {
            console.error('Failed to load menu.html', resp.status);
            return;
        }
        const html = await resp.text();

        // inject at end of body (or into #menuPlaceholder)
        document.body.insertAdjacentHTML('beforeend', html);
        menuLoaded = true;

        // if you have menu-init logic, call it here:
        // initMenuControls();
    } catch (e) {
        console.error('Error loading menu.html', e);
    }
}

// Toggle panel visibility when ≡ is clicked
document.getElementById('menuButton').addEventListener('click', async () => {
    if (!menuLoaded) {
        await loadMenuPanel();
        initConfiguration()
    }

    const panel = document.getElementById('menuPanel');
    if (!panel) return;

    loadMenuCSS();
    document.getElementById("menuButton").onclick = () => {
        const p = document.getElementById("menuPanel");
        p.style.display = (p.style.display === "block" ? "none" : "block");
    };
    panel.classList.toggle('open');   // style .open in your CSS (e.g. right:0 vs right:-300px)
});
