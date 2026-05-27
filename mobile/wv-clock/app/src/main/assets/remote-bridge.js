/*
 * remote-bridge.js — injected by the embedded ClockServer into index.html.
 *
 * Purpose:
 *  - Sync the web app's localStorage state (keys prefixed with "screenClock_")
 *    between the on-device WebView and any remote browsers pointing at the
 *    same server, so the configuration menu in a remote browser acts as a
 *    real remote control of the on-device clock.
 *  - Neutralize the "click the year to toggle fullscreen" handler (the
 *    WebView is already fullscreen and the browser fullscreen API is not
 *    needed for the remote-control use case).
 */
(function () {
  "use strict";

  var SYNC_PREFIX = "screenClock_";
  var suppress = false;

  // A "remote" client is any browser pointing at the embedded server from a
  // different host than loopback (i.e. not the on-device WebView). Remote
  // clients can act as pure remote controls while still rendering their local
  // preview of the clock mirroring the target.
  var host = (window.location.hostname || "").toLowerCase();
  var IS_REMOTE = !(host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "");

  var LOG = "[wv-bridge]";
  try { console.log(LOG, "loaded; host=", host, "IS_REMOTE=", IS_REMOTE); } catch (e) {}

  function autoOpenMenuIfRemote() {
    if (!IS_REMOTE) return;
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (typeof window.openMenuPanel === "function") {
        clearInterval(iv);
        try { window.openMenuPanel(); } catch (e) {}
      } else if (tries > 100) {
        clearInterval(iv);
      }
    }, 50);
  }

  // screenClock_menuOpen is a pure UI state (which panel is open) and must
  // NOT be synced: a remote browser always has its menu open, which would
  // make the device open its menu too.
  var EXCLUDE_KEYS = { "screenClock_menuOpen": true };

  function isSyncedKey(k) {
    return typeof k === "string" && k.indexOf(SYNC_PREFIX) === 0 && !EXCLUDE_KEYS[k];
  }

  // ---- localStorage hook: forward local writes to the server ----
  var origSet = Storage.prototype.setItem;
  var origRemove = Storage.prototype.removeItem;

  Storage.prototype.setItem = function (k, v) {
    origSet.apply(this, arguments);
    if (this === window.localStorage && !suppress && isSyncedKey(k)) {
      postChange(k, String(v));
    }
  };
  Storage.prototype.removeItem = function (k) {
    origRemove.apply(this, arguments);
    if (this === window.localStorage && !suppress && isSyncedKey(k)) {
      postChange(k, null);
    }
  };

  function postChange(key, value) {
    try {
      console.log(LOG, "POST /api/state", key, value && value.length ? "(len=" + value.length + ")" : value);
      fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key, value: value })
      }).then(function (r) {
        console.log(LOG, "POST /api/state ->", r.status);
      }).catch(function (e) {
        console.log(LOG, "POST /api/state failed", String(e));
      });
    } catch (e) { console.log(LOG, "POST throw", String(e)); }
  }

  // ---- Apply a remote-originated change to local state ----
  var refreshTimer = null;
  function doRefresh() {
    if (typeof window.refreshFromStoredState === "function") {
      try { window.refreshFromStoredState(); console.log(LOG, "refreshFromStoredState OK"); }
      catch (e) { console.log(LOG, "refreshFromStoredState threw", String(e)); }
    } else if (typeof ensureConfigurationInitialized === "function") {
      // initConfiguration() hasn't run yet on the device (menu never opened).
      // Initialise it silently (panel stays hidden) so refreshFromStoredState
      // becomes available, then apply.
      console.log(LOG, "calling ensureConfigurationInitialized");
      try {
        Promise.resolve(ensureConfigurationInitialized()).then(function () {
          if (typeof window.refreshFromStoredState === "function") {
            try { window.refreshFromStoredState(); console.log(LOG, "refreshFromStoredState OK (after init)"); }
            catch (e) { console.log(LOG, "refreshFromStoredState threw", String(e)); }
          }
        }).catch(function (e) { console.log(LOG, "ensureConfigurationInitialized rejected", String(e)); });
      } catch (e) { console.log(LOG, "ensureConfigurationInitialized threw", String(e)); }
    } else if (typeof window.applyClockTransform === "function") {
      try { window.applyClockTransform(); } catch (e) {}
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      console.log(LOG, "refresh tick; refreshFromStoredState?", typeof window.refreshFromStoredState === "function");
      doRefresh();
    }, 30);
  }

  function applyRemote(key, value) {
    suppress = true;
    try {
      if (value === null || value === undefined) {
        if (window.localStorage.getItem(key) !== null) {
          window.localStorage.removeItem(key);
        }
      } else if (window.localStorage.getItem(key) !== value) {
        window.localStorage.setItem(key, value);
      }
    } finally {
      suppress = false;
    }
    // Best-effort: notify any naive storage-event listeners as well.
    try {
      window.dispatchEvent(new StorageEvent("storage", {
        key: key,
        newValue: value === null ? null : String(value),
        storageArea: window.localStorage
      }));
    } catch (e) { /* ignore */ }
    scheduleRefresh();
  }

  function applySnapshot(obj) {
    if (!obj || typeof obj !== "object") return;
    Object.keys(obj).forEach(function (k) {
      if (isSyncedKey(k)) applyRemote(k, obj[k]);
    });
  }

  // ---- Initial pull + SSE (primary) / polling (fallback) ----
  var pollingStarted = false;

  function startEventStream() {
    try {
      console.log(LOG, "opening EventSource /api/events");
      var es = new EventSource("/api/events");
      es.onopen = function () { console.log(LOG, "SSE open"); };
      es.addEventListener("snapshot", function (ev) {
        console.log(LOG, "SSE snapshot len=", (ev.data || "").length);
        try { applySnapshot(JSON.parse(ev.data)); } catch (e) { console.log(LOG, "snapshot parse err", String(e)); }
      });
      es.addEventListener("state", function (ev) {
        console.log(LOG, "SSE state ev", ev.data);
        try {
          var msg = JSON.parse(ev.data);
          if (msg && typeof msg.key === "string") applyRemote(msg.key, msg.value);
        } catch (e) { console.log(LOG, "state parse err", String(e)); }
      });
      es.onerror = function () {
        console.log(LOG, "SSE error; readyState=", es.readyState);
      };
    } catch (e) {
      console.log(LOG, "SSE not supported:", String(e));
    }
  }

  // Last seen serialised state for change detection in the poll loop.
  var lastPolledState = null;

  function startPolling() {
    if (pollingStarted) return;
    pollingStarted = true;
    console.log(LOG, "starting poll loop");
    setInterval(function () {
      fetch("/api/state")
        .then(function (r) { return r.json(); })
        .then(function (obj) {
          var serialised = JSON.stringify(obj);
          if (serialised === lastPolledState) return;
          lastPolledState = serialised;
          console.log(LOG, "poll: state changed, applying snapshot");
          applySnapshot(obj);
        })
        .catch(function () {});
    }, 400);
  }

  function initialPull() {
    fetch("/api/state")
      .then(function (r) { return r.json(); })
      .then(function (obj) {
        lastPolledState = JSON.stringify(obj);
        applySnapshot(obj);
      })
      .catch(function () {})
      .finally(function () {
        startEventStream();          // always try SSE
        if (!IS_REMOTE) startPolling(); // device: also poll as reliable fallback
      });
  }

  // ---- Year-click QR overlay ----
  // Replaces the web app's "click year ⇒ toggle browser fullscreen" handler
  // with a centered QR code + URL for accessing this server from a remote
  // browser. Clicking outside the QR (on the backdrop) closes it.
  var OVERLAY_ID = "__wvclock_qr_overlay__";

  function hideQrOverlay() {
    var el = document.getElementById(OVERLAY_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function renderQrOverlay(url) {
    hideQrOverlay();

    var backdrop = document.createElement("div");
    backdrop.id = OVERLAY_ID;
    backdrop.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.88);" +
      "display:flex;align-items:center;justify-content:center;" +
      "z-index:2147483647;cursor:pointer;";

    var box = document.createElement("div");
    box.style.cssText =
      "background:#fff;padding:24px;border-radius:12px;" +
      "display:flex;flex-direction:column;align-items:center;gap:16px;" +
      "max-width:90vmin;cursor:default;box-shadow:0 8px 32px rgba(0,0,0,0.5);";
    box.addEventListener("click", function (e) { e.stopPropagation(); });

    var qrHolder = document.createElement("div");
    qrHolder.style.cssText = "background:#fff;line-height:0;";

    if (typeof window.qrcode === "function") {
      try {
        var qr = window.qrcode(0, "M");
        qr.addData(url);
        qr.make();
        var modules = qr.getModuleCount();
        var target = Math.min(window.innerWidth, window.innerHeight) * 0.6;
        var cell = Math.max(3, Math.floor(target / modules));
        qrHolder.innerHTML = qr.createSvgTag({ cellSize: cell, margin: 2 });
        var svg = qrHolder.querySelector("svg");
        if (svg) {
          svg.style.display = "block";
          svg.style.maxWidth = "70vmin";
          svg.style.height = "auto";
        }
      } catch (e) {
        qrHolder.textContent = "QR generation failed";
      }
    } else {
      qrHolder.textContent = "QR library not loaded";
    }
    box.appendChild(qrHolder);

    var urlEl = document.createElement("div");
    urlEl.textContent = url;
    urlEl.style.cssText =
      "font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;" +
      "color:#000;word-break:break-all;text-align:center;user-select:all;";
    box.appendChild(urlEl);

    backdrop.appendChild(box);
    backdrop.addEventListener("click", hideQrOverlay);

    // Esc closes too.
    var onKey = function (e) {
      if (e.key === "Escape") { hideQrOverlay(); document.removeEventListener("keydown", onKey, true); }
    };
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(backdrop);
  }

  function showQrOverlay() {
    // Toggle if already open.
    if (document.getElementById(OVERLAY_ID)) { hideQrOverlay(); return; }
    try {
      fetch("/api/url")
        .then(function (r) { return r.json(); })
        .then(function (obj) {
          var url = obj && obj.url
            ? obj.url
            : (window.location.origin + "/");
          renderQrOverlay(url);
        })
        .catch(function () {
          renderQrOverlay(window.location.origin + "/");
        });
    } catch (e) {
      renderQrOverlay(window.location.origin + "/");
    }
  }

  // Intercept the year click before the page's own listener runs and
  // open the QR overlay instead. Only on the on-device WebView — remote
  // browsers don't show the clock at all.
  if (!IS_REMOTE) {
    document.addEventListener("click", function (e) {
      var t = e.target;
      if (!t) return;
      if (t.id === "year" || (t.closest && t.closest("#year"))) {
        e.stopImmediatePropagation();
        e.preventDefault();
        showQrOverlay();
      }
    }, true);
  }

  function bootstrap() {
    initialPull();
    autoOpenMenuIfRemote();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
