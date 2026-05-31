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
  var discoveredClocksList = [];
  var clockSleepStates = {}; // Tracks url -> boolean (true: asleep, false: awake)
  // Optimistic toggle state: url -> expected isAsleep value while the real
  // server-side change is still propagating through UDP. Prevents the seed
  // loop from overwriting an in-flight toggle with stale server data.
  var pendingClockToggles = {};

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
  // screenClock_controlledClocks is local to this client's control preferences and
  // should not be synchronized across clocks.
  var EXCLUDE_KEYS = {
    "screenClock_menuOpen": true,
    "screenClock_controlledClocks": true,
    "screenClock_timeMasterUrl": true
  };

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

      sendToControlledClocks(key, value);
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
      es.addEventListener("clocks", function () {
        updateNetworkClocksUi();
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

  // ---- Controlled clocks sync helper ----
  function sendToControlledClocks(key, value) {
    try {
      var raw = localStorage.getItem("screenClock_controlledClocks");
      if (!raw) return;
      var urls = JSON.parse(raw);
      if (!Array.isArray(urls)) return;
      urls.forEach(function (url) {
        if (!url) return;
        var fetchUrl = url;
        if (fetchUrl.lastIndexOf("/") !== fetchUrl.length - 1) fetchUrl += "/";
        fetch(fetchUrl + "api/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, value: value })
        }).catch(function (e) {
          console.warn(LOG, "Sync failed to remote clock:", url, e);
        });
      });
    } catch (err) {
      console.error(LOG, "sendToControlledClocks error", err);
    }
  }

  function pushFullStateToClock(targetUrl) {
    try {
      var fetchUrl = targetUrl;
      if (fetchUrl.lastIndexOf("/") !== fetchUrl.length - 1) fetchUrl += "/";
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (isSyncedKey(k)) {
          var v = localStorage.getItem(k);
          fetch(fetchUrl + "api/state", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: k, value: v })
          }).catch(function () {});
        }
      }
    } catch (e) {
      console.error(LOG, "Failed pushing full state to", targetUrl, e);
    }
  }

  // ---- Time master sync ----
  // localStorage: screenClock_timeMasterUrl = "" (self/local) or URL of master clock.
  // window.__timeMasterOffsetMs is read by web/index.html updateClock().
  //
  // Algorithm (mini-NTP / Cristian's):
  //   For each sample:
  //     t0 = client send time
  //     t1 = server receive time  (from /api/time { t1, t2 })
  //     t2 = server send time     (from /api/time { t1, t2 })
  //     t3 = client receive time
  //     rtt    = (t3 - t0) - (t2 - t1)         // excludes server processing
  //     offset = ((t1 - t0) + (t2 - t3)) / 2   // NTP-classic
  //   (If only `now` is returned, fall back to t1 = t2 = now.)
  //
  //   We discard samples with rtt > RTT_MAX_MS, then pick the sample with the
  //   minimum RTT (its asymmetric-jitter error is bounded by rtt/2).
  //
  //   Lock-on strategy:
  //     1. TCP warm-up: one throwaway request so the kernel opens the
  //        connection (Android WebView fetch may use HTTP/1.1 with
  //        connection reuse; the first request pays the SYN cost).
  //     2. Aggressive initial burst (LARGE) for fast convergence.
  //     3. Backoff re-sync schedule: 1s, 2s, 5s, 10s, then SYNC_INTERVAL_MS.
  //     4. Rolling min-RTT window across recent bursts to ride out the
  //        occasional Wi-Fi blip without losing lock.
  var timeSyncTimer = null;
  var timeSyncTimeoutId = null;
  var lastGoodOffsetMs = null;
  window.__timeMasterOffsetMs = window.__timeMasterOffsetMs || 0;

  var INITIAL_BURST_SIZE = 20;       // aggressive initial lock
  var STEADY_BURST_SIZE = 8;
  var BURST_GAP_MS = 30;             // tight spacing inside a burst
  var RTT_MAX_MS = 400;              // discard slower samples
  var SYNC_INTERVAL_MS = 30000;      // steady-state cadence
  var BACKOFF_SCHEDULE_MS = [1000, 2000, 5000, 10000];
  var EMA_ALPHA = 0.5;               // weight of new offset vs running
  var JUMP_THRESHOLD_MS = 150;       // above this, snap
  var ROLLING_WINDOW_SIZE = 12;      // remember last N best samples
  var rollingBest = [];              // array of { rtt, offset, time }
  var ROLLING_MAX_AGE_MS = 120000;   // discard older than 2 minutes
  var backoffStep = 0;

  function getTimeMasterUrl() {
    try { return localStorage.getItem("screenClock_timeMasterUrl") || ""; }
    catch (_) { return ""; }
  }

  function singleSample(fetchUrl) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      fetch(fetchUrl + "api/time", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (obj) {
          var t3 = Date.now();
          if (!obj) { resolve(null); return; }
          // Prefer NTP-style t1/t2 timestamps; fall back to single `now`.
          var t1 = typeof obj.t1 === "number" ? obj.t1
                  : (typeof obj.now === "number" ? obj.now : null);
          var t2 = typeof obj.t2 === "number" ? obj.t2 : t1;
          if (t1 === null) { resolve(null); return; }
          var rtt = (t3 - t0) - (t2 - t1);
          if (rtt < 0) rtt = t3 - t0; // server clock skew safety net
          var offset = ((t1 - t0) + (t2 - t3)) / 2;
          resolve({ rtt: rtt, offset: offset });
        })
        .catch(function () { resolve(null); });
    });
  }

  function pruneRolling() {
    var cutoff = Date.now() - ROLLING_MAX_AGE_MS;
    rollingBest = rollingBest.filter(function (s) { return s.time >= cutoff; });
    if (rollingBest.length > ROLLING_WINDOW_SIZE) {
      // Keep the N smallest-RTT samples.
      rollingBest.sort(function (a, b) { return a.rtt - b.rtt; });
      rollingBest = rollingBest.slice(0, ROLLING_WINDOW_SIZE);
    }
  }

  function applyOffset(newOffset) {
    var prev = window.__timeMasterOffsetMs || 0;
    if (lastGoodOffsetMs === null) {
      window.__timeMasterOffsetMs = Math.round(newOffset);
      lastGoodOffsetMs = newOffset;
      return;
    }
    var delta = newOffset - prev;
    if (Math.abs(delta) > JUMP_THRESHOLD_MS) {
      window.__timeMasterOffsetMs = Math.round(newOffset);
    } else {
      var smoothed = prev + EMA_ALPHA * delta;
      window.__timeMasterOffsetMs = Math.round(smoothed);
    }
    lastGoodOffsetMs = newOffset;
  }

  function runBurst(fetchUrl, size) {
    var samples = [];
    var p = Promise.resolve();
    for (var i = 0; i < size; i++) {
      (function (idx) {
        p = p.then(function () {
          return singleSample(fetchUrl).then(function (s) {
            if (s && s.rtt <= RTT_MAX_MS) samples.push(s);
          });
        });
        if (idx < size - 1) {
          p = p.then(function () {
            return new Promise(function (r) { setTimeout(r, BURST_GAP_MS); });
          });
        }
      })(i);
    }
    return p.then(function () { return samples; });
  }

  function syncTimeFromMaster(burstSize) {
    var masterUrl = getTimeMasterUrl();
    if (!masterUrl) {
      window.__timeMasterOffsetMs = 0;
      lastGoodOffsetMs = null;
      rollingBest = [];
      return Promise.resolve();
    }
    var fetchUrl = masterUrl;
    if (fetchUrl.lastIndexOf("/") !== fetchUrl.length - 1) fetchUrl += "/";

    var size = burstSize || STEADY_BURST_SIZE;

    // TCP/HTTP warm-up: a throwaway request so the kernel-level connection
    // (and any HTTP/1.1 keep-alive socket) is hot before we measure.
    return singleSample(fetchUrl).then(function () {
      return runBurst(fetchUrl, size);
    }).then(function (samples) {
      if (!samples.length) return;
      var now = Date.now();
      samples.forEach(function (s) {
        rollingBest.push({ rtt: s.rtt, offset: s.offset, time: now });
      });
      pruneRolling();
      // Choose the smallest-RTT sample from the entire rolling window — its
      // offset is the most reliable estimate we currently have.
      var best = rollingBest.reduce(function (a, b) {
        return (a === null || b.rtt < a.rtt) ? b : a;
      }, null);
      if (best) applyOffset(best.offset);
    });
  }

  function scheduleNextSync() {
    if (timeSyncTimeoutId) clearTimeout(timeSyncTimeoutId);
    var delay;
    if (backoffStep < BACKOFF_SCHEDULE_MS.length) {
      delay = BACKOFF_SCHEDULE_MS[backoffStep++];
    } else {
      delay = SYNC_INTERVAL_MS;
    }
    timeSyncTimeoutId = setTimeout(function () {
      syncTimeFromMaster(STEADY_BURST_SIZE).then(scheduleNextSync);
    }, delay);
  }

  function startTimeSync() {
    if (!IS_REMOTE) return; // Native handles time sync on local device
    if (timeSyncTimer) return;
    timeSyncTimer = true;
    backoffStep = 0;
    // Initial aggressive burst now; follow with backoff schedule.
    syncTimeFromMaster(INITIAL_BURST_SIZE).then(scheduleNextSync);
  }

  function forceResyncSoon() {
    if (!IS_REMOTE) return; // Native handles time sync on local device
    // Called after the user picks a new master. Reset smoothing + rolling
    // window and run an aggressive burst to lock onto the new master.
    lastGoodOffsetMs = null;
    rollingBest = [];
    backoffStep = 0;
    if (timeSyncTimeoutId) clearTimeout(timeSyncTimeoutId);
    syncTimeFromMaster(INITIAL_BURST_SIZE).then(scheduleNextSync);
  }

  // ---- Network clocks list rendering ----
  var clocksScanTimer = null;
  function updateNetworkClocksUi() {
    var section = document.getElementById("networkSyncSection");
    var listContainer = document.getElementById("networkClocksList");
    if (!section || !listContainer) return;

    fetch("/api/clocks")
      .then(function (r) { return r.json(); })
      .then(function (clocks) {
        if (!Array.isArray(clocks) || clocks.length === 0) {
          section.style.display = "none";
          return;
        }

        // Deduplicate by URL — guards against stale UUID entries during restarts
        var seenUrls = {};
        clocks = clocks.filter(function (clk) {
          if (!clk.url || seenUrls[clk.url]) return false;
          seenUrls[clk.url] = true;
          return true;
        });

        section.style.display = "block";
        listContainer.innerHTML = "";
        discoveredClocksList = clocks;

        // Seed sleep states from the real isAsleep value reported by each clock
        clocks.forEach(function (clk) {
          if (!clk.isSelf && typeof clk.isAsleep === "boolean") {
            if (clk.url in pendingClockToggles) {
              // Server confirmed the toggled state — clear the pending lock
              if (clk.isAsleep === pendingClockToggles[clk.url]) {
                delete pendingClockToggles[clk.url];
              }
              // Don't overwrite our optimistic value until server confirms
            } else {
              clockSleepStates[clk.url] = clk.isAsleep;
            }
          }
        });

        // Recreate global controls block on each render to avoid stale closure references and ensure perfect sync
        var controlsGroup = document.getElementById("globalClockPowerControls");
        if (controlsGroup) {
          controlsGroup.parentNode.removeChild(controlsGroup);
        }

        controlsGroup = document.createElement("div");
        controlsGroup.id = "globalClockPowerControls";
        controlsGroup.style.cssText = "display: flex; gap: 8px; margin-bottom: 12px;";

        var wakeAllBtn = document.createElement("button");
        wakeAllBtn.style.cssText = "flex: 1; font-size: 10px; font-weight: bold; border-radius: 4px; padding: 4px 10px; border: 1px solid #00ff66; background: #1a3a21; color: #00ff66; cursor: pointer; text-transform: uppercase; transition: background 0.1s, opacity 0.1s;";
        wakeAllBtn.textContent = "Wake All";
        wakeAllBtn.addEventListener("mouseover", function () { wakeAllBtn.style.background = "#244d2e"; });
        wakeAllBtn.addEventListener("mouseout", function () { wakeAllBtn.style.background = "#1a3a21"; });
        wakeAllBtn.addEventListener("click", function () {
          wakeAllBtn.disabled = true;
          wakeAllBtn.style.opacity = "0.5";
          var targets = discoveredClocksList.filter(function (clk) { return !clk.isSelf; });
          var promises = targets.map(function (clk) {
            clockSleepStates[clk.url] = false;
            var targetWakeUrl = clk.url;
            if (targetWakeUrl.lastIndexOf("/") !== targetWakeUrl.length - 1) targetWakeUrl += "/";
            return fetch(targetWakeUrl + "api/wake", {
              method: "POST",
              headers: { "Content-Type": "application/json" }
            }).catch(function () {});
          });
          Promise.all(promises).then(function() {
            wakeAllBtn.textContent = "All Woken!";
            setTimeout(function () {
              wakeAllBtn.disabled = false;
              wakeAllBtn.style.opacity = "1";
              wakeAllBtn.textContent = "Wake All";
              updateNetworkClocksUi();
            }, 1500);
          });
        });

        var sleepAllBtn = document.createElement("button");
        sleepAllBtn.style.cssText = "flex: 1; font-size: 10px; font-weight: bold; border-radius: 4px; padding: 4px 10px; border: 1px solid #ff3333; background: #3a1a1a; color: #ff3333; cursor: pointer; text-transform: uppercase; transition: background 0.1s, opacity 0.1s;";
        sleepAllBtn.textContent = "Sleep All";
        sleepAllBtn.addEventListener("mouseover", function () { sleepAllBtn.style.background = "#4d2424"; });
        sleepAllBtn.addEventListener("mouseout", function () { sleepAllBtn.style.background = "#3a1a1a"; });
        sleepAllBtn.addEventListener("click", function () {
          sleepAllBtn.disabled = true;
          sleepAllBtn.style.opacity = "0.5";
          var targets = discoveredClocksList.filter(function (clk) { return !clk.isSelf; });
          var promises = targets.map(function (clk) {
            clockSleepStates[clk.url] = true;
            var targetSleepUrl = clk.url;
            if (targetSleepUrl.lastIndexOf("/") !== targetSleepUrl.length - 1) targetSleepUrl += "/";
            return fetch(targetSleepUrl + "api/sleep", {
              method: "POST",
              headers: { "Content-Type": "application/json" }
            }).catch(function () {});
          });
          Promise.all(promises).then(function() {
            sleepAllBtn.textContent = "All Asleep!";
            setTimeout(function () {
              sleepAllBtn.disabled = false;
              sleepAllBtn.style.opacity = "1";
              sleepAllBtn.textContent = "Sleep All";
              updateNetworkClocksUi();
            }, 1500);
          });
        });

        controlsGroup.appendChild(wakeAllBtn);
        controlsGroup.appendChild(sleepAllBtn);
        section.insertBefore(controlsGroup, listContainer);

        // Get currently controlled clock URLs from localStorage
        var controlledUrls = [];
        try {
          var raw = localStorage.getItem("screenClock_controlledClocks");
          controlledUrls = raw ? JSON.parse(raw) : [];
          if (!Array.isArray(controlledUrls)) controlledUrls = [];
        } catch (_) {}

        var masterUrl = getTimeMasterUrl();

        // Header row labels
        var header = document.createElement("div");
        header.style.cssText = "display: grid; grid-template-columns: auto auto 1fr auto; gap: 8px; align-items: center; font-size: 11px; color: #888; margin-bottom: 4px;";
        header.innerHTML = "<span>Ctrl</span><span>Time</span><span>Device</span><span>Action</span>";
        listContainer.appendChild(header);

        clocks.forEach(function (clk) {
          var row = document.createElement("div");
          row.style.cssText = "display: grid; grid-template-columns: auto auto 1fr auto; gap: 8px; align-items: center; margin-bottom: 6px;";

          // Control checkbox
          var checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.value = clk.url;
          checkbox.style.cssText = "margin: 0; width: 18px; height: 18px; cursor: pointer;";

          if (clk.isSelf) {
            checkbox.checked = true;
            checkbox.disabled = true;
          } else {
            checkbox.checked = controlledUrls.indexOf(clk.url) !== -1;
            checkbox.addEventListener("change", function () {
              var currentUrls = [];
              try {
                var r = localStorage.getItem("screenClock_controlledClocks");
                currentUrls = r ? JSON.parse(r) : [];
              } catch (_) {}
              if (!Array.isArray(currentUrls)) currentUrls = [];

              if (checkbox.checked) {
                if (currentUrls.indexOf(clk.url) === -1) {
                  currentUrls.push(clk.url);
                  // Push current state to the checked clock immediately
                  pushFullStateToClock(clk.url);
                }
              } else {
                var idx = currentUrls.indexOf(clk.url);
                if (idx !== -1) {
                  currentUrls.splice(idx, 1);
                }
              }
              localStorage.setItem("screenClock_controlledClocks", JSON.stringify(currentUrls));
            });
          }

          // Time master radio (single selection across rows)
          var radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "timeMasterRadio";
          radio.style.cssText = "margin: 0; width: 16px; height: 16px; cursor: pointer;";
          // Self is selected when no master URL is set.
          if (clk.isSelf) {
            radio.checked = !masterUrl;
          } else {
            radio.checked = masterUrl === clk.url;
          }
          radio.addEventListener("change", function () {
            if (!radio.checked) return;
            try {
              if (clk.isSelf) {
                localStorage.setItem("screenClock_timeMasterUrl", "");
                window.__timeMasterOffsetMs = 0;
                lastGoodOffsetMs = null;
              } else {
                localStorage.setItem("screenClock_timeMasterUrl", clk.url);
                forceResyncSoon();
              }
            } catch (_) {}
          });

          var span = document.createElement("span");
          span.style.cssText = "font-size: 14px; color: " + (clk.isSelf ? "#888" : "#fff") + ";";
          span.textContent = clk.name;

          // Action buttons container
          var actionContainer = document.createElement("div");
          actionContainer.style.cssText = "display: flex; gap: 4px; justify-content: flex-end; align-items: center;";

          // Watt badge (shown when device reports current draw)
          if (typeof clk.milliWatts === "number" && clk.milliWatts >= 0) {
            var watt = document.createElement("span");
            var w = (clk.milliWatts / 1000).toFixed(1);
            watt.style.cssText = "font-size: 10px; font-weight: bold; color: #aaaaff; background: rgba(0,0,0,0.35); border: 1px solid #aaaaff; border-radius: 3px; padding: 1px 4px; white-space: nowrap;";
            watt.textContent = w + "W";
            actionContainer.appendChild(watt);
          }

          // Battery badge (shown for all entries that report battery)
          if (typeof clk.battery === "number" && clk.battery >= 0) {
            var bat = document.createElement("span");
            var pct = clk.battery;
            var batColor = pct <= 15 ? "#ff3333" : pct <= 40 ? "#ffaa00" : "#00cc55";
            bat.style.cssText = "font-size: 10px; font-weight: bold; color: " + batColor + "; background: rgba(0,0,0,0.35); border: 1px solid " + batColor + "; border-radius: 3px; padding: 1px 4px; white-space: nowrap;";
            bat.textContent = "⚡" + pct + "%";
            actionContainer.appendChild(bat);
          }

          if (!clk.isSelf) {
            // Combined toggle button
            var toggleBtn = document.createElement("button");
            var isCurrentlyAsleep = !!clockSleepStates[clk.url];

            if (isCurrentlyAsleep) {
              toggleBtn.style.cssText = "font-size: 10px; font-weight: bold; border-radius: 4px; padding: 2px 0; border: 1px solid #00ff66; background: #1a3a21; color: #00ff66; cursor: pointer; text-transform: uppercase; transition: background 0.1s; width: 54px; box-sizing: border-box; text-align: center;";
              toggleBtn.textContent = "Wake";
              toggleBtn.addEventListener("mouseover", function () { toggleBtn.style.background = "#244d2e"; });
              toggleBtn.addEventListener("mouseout", function () { toggleBtn.style.background = "#1a3a21"; });
            } else {
              toggleBtn.style.cssText = "font-size: 10px; font-weight: bold; border-radius: 4px; padding: 2px 0; border: 1px solid #ff3333; background: #3a1a1a; color: #ff3333; cursor: pointer; text-transform: uppercase; transition: background 0.1s; width: 54px; box-sizing: border-box; text-align: center;";
              toggleBtn.textContent = "Sleep";
              toggleBtn.addEventListener("mouseover", function () { toggleBtn.style.background = "#4d2424"; });
              toggleBtn.addEventListener("mouseout", function () { toggleBtn.style.background = "#3a1a1a"; });
            }

            toggleBtn.addEventListener("click", function () {
              toggleBtn.disabled = true;
              toggleBtn.style.opacity = "0.5";

              var endpoint = isCurrentlyAsleep ? "api/wake" : "api/sleep";
              var targetUrl = clk.url;
              if (targetUrl.lastIndexOf("/") !== targetUrl.length - 1) targetUrl += "/";

              fetch(targetUrl + endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" }
              }).then(function (r) {
                console.log(LOG, "POST " + clk.url + endpoint + " ->", r.status);
                // Record optimistic state and update UI immediately
                var newState = !isCurrentlyAsleep;
                pendingClockToggles[clk.url] = newState;
                clockSleepStates[clk.url] = newState;
                updateNetworkClocksUi();
              }).catch(function (e) {
                console.warn(LOG, "POST " + clk.url + endpoint + " failed", e);
                toggleBtn.disabled = false;
                toggleBtn.style.opacity = "1";
              });
            });

            actionContainer.appendChild(toggleBtn);
          }

          // Info badge — circled ⓘ shows device details + 7-day activity chart
          var infoBtn = document.createElement("button");
          infoBtn.textContent = "\u24d8";
          infoBtn.title = "Device info";
          infoBtn.style.cssText = "font-size:13px;background:none;border:none;color:#6699cc;cursor:pointer;padding:0 2px;line-height:1;opacity:0.75;";
          infoBtn.addEventListener("mouseover", function() { this.style.opacity = "1"; });
          infoBtn.addEventListener("mouseout", function() { this.style.opacity = "0.75"; });
          infoBtn.addEventListener("click", function(e) { e.stopPropagation(); fetchAndShowInfo(clk, infoBtn); });
          actionContainer.appendChild(infoBtn);

          row.appendChild(checkbox);
          row.appendChild(radio);
          row.appendChild(span);
          row.appendChild(actionContainer);
          listContainer.appendChild(row);
        });
      })
      .catch(function () {
        // Hide if api is unavailable or fails (e.g. static dev server)
        section.style.display = "none";
      });
  }

  // ---- Device info overlay ----

  var INFO_OVERLAY_ID = "__wvclock_info_overlay__";

  function hideInfoOverlay() {
    var el = document.getElementById(INFO_OVERLAY_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function formatBuildTime(buildTime) {
    if (!buildTime || buildTime === "unknown") return "unknown";
    try {
      var d = new Date(buildTime);
      if (isNaN(d.getTime())) return buildTime;
      var p = function(n) { return n < 10 ? "0" + n : "" + n; };
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
        " " + p(d.getHours()) + ":" + p(d.getMinutes());
    } catch (e) { return buildTime; }
  }

  function formatUptime(ms) {
    if (!ms || ms < 0) return "?";
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    s %= 60; var h = Math.floor(m / 60); m %= 60;
    var d = Math.floor(h / 24); h %= 24;
    if (d > 0) return d + "d " + h + "h " + m + "m";
    if (h > 0) return h + "h " + m + "m";
    return m + "m " + s + "s";
  }

  function renderInfoChart(container, chart) {
    var appActive = chart.appActive || [];
    var screenAwake = chart.screenAwake || [];
    var n = appActive.length;
    if (!n) return;

    var legend = document.createElement("div");
    legend.style.cssText = "display:flex;gap:12px;margin-bottom:4px;font-size:10px;";
    var l1 = document.createElement("span"); l1.style.color = "#ffdd55"; l1.textContent = "\u25cf App active";
    var l2 = document.createElement("span"); l2.style.color = "#55ddff"; l2.textContent = "\u25cf Screen awake";
    legend.appendChild(l1); legend.appendChild(l2);
    container.appendChild(legend);

    var canvas = document.createElement("canvas");
    canvas.width = 336; canvas.height = 72;
    canvas.style.cssText = "width:100%;height:72px;display:block;border:1px solid #333;border-radius:3px;";
    container.appendChild(canvas);

    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    var W = 336, H = 72, pl = 2, pr = 2, pt = 4, pb = 16;
    var cw = W - pl - pr, ch = H - pt - pb;
    ctx.fillStyle = "#111"; ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "#2a2a2a"; ctx.lineWidth = 0.5;
    for (var dg = 0; dg <= 7; dg++) {
      var gx = pl + (dg * 24 / n) * cw;
      ctx.beginPath(); ctx.moveTo(gx, pt); ctx.lineTo(gx, pt + ch); ctx.stroke();
    }

    function drawLine(data, color) {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      for (var i = 0; i < data.length; i++) {
        var x = pl + (n > 1 ? i / (n - 1) : 0) * cw;
        var y = pt + (1 - Math.min(1, Math.max(0, data[i]))) * ch;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    drawLine(appActive, "#ffdd55");
    drawLine(screenAwake, "#55ddff");

    ctx.fillStyle = "#555"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    for (var dl = 0; dl < 7; dl++) {
      var lx = pl + ((dl * 24 + 12) / n) * cw;
      var labelMs = (chart.bucketZeroMs || 0) + dl * 24 * 3600000;
      try {
        ctx.fillText(new Date(labelMs).toLocaleDateString(undefined, { weekday: "short" }), lx, H - 3);
      } catch (e) {}
    }
  }

  function renderInfoOverlay(clk, info) {
    hideInfoOverlay();
    var backdrop = document.createElement("div");
    backdrop.id = INFO_OVERLAY_ID;
    backdrop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.72);" +
      "display:flex;align-items:center;justify-content:center;z-index:2147483646;cursor:pointer;";
    var box = document.createElement("div");
    box.style.cssText = "background:#1a1a1a;border:1px solid #444;border-radius:8px;" +
      "padding:14px 16px;width:360px;max-width:92vw;cursor:default;" +
      "font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#eee;" +
      "box-shadow:0 8px 32px rgba(0,0,0,0.6);";
    box.addEventListener("click", function(e) { e.stopPropagation(); });

    var title = document.createElement("div");
    title.style.cssText = "font-size:13px;font-weight:bold;color:#ccc;margin-bottom:10px;";
    title.textContent = clk.name;
    box.appendChild(title);

    if (info) {
      var osLine = info.androidVersion
        ? ("Android " + info.androidVersion)
        : (info.platform || "desktop");
      var fields = [
        ["Brand / Model", (info.brand || "?") + "  /  " + (info.model || "?")],
        ["OS", osLine],
        ["Build", formatBuildTime(info.buildTime)],
        ["Git commit", info.gitCommit || "?"],
        ["Uptime", formatUptime(info.uptimeMs)]
      ];
      var grid = document.createElement("div");
      grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:3px 10px;margin-bottom:12px;line-height:1.5;";
      fields.forEach(function(f) {
        var lbl = document.createElement("span"); lbl.style.color = "#777"; lbl.textContent = f[0];
        var val = document.createElement("span"); val.style.color = "#ddd"; val.textContent = f[1];
        grid.appendChild(lbl); grid.appendChild(val);
      });
      box.appendChild(grid);
      if (info.chart) renderInfoChart(box, info.chart);
    } else {
      var err = document.createElement("div");
      err.style.cssText = "color:#666;padding:8px 0;";
      err.textContent = "Device info unavailable.";
      box.appendChild(err);
    }

    var closeBtn = document.createElement("button");
    closeBtn.style.cssText = "margin-top:10px;width:100%;padding:4px 0;background:#2a2a2a;" +
      "border:1px solid #444;border-radius:4px;color:#999;cursor:pointer;font-size:11px;";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", hideInfoOverlay);
    box.appendChild(closeBtn);
    backdrop.appendChild(box);
    backdrop.addEventListener("click", hideInfoOverlay);
    var onKey = function(e) { if (e.key === "Escape") { hideInfoOverlay(); document.removeEventListener("keydown", onKey, true); } };
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);
  }

  function fetchAndShowInfo(clk, btnEl) {
    var base = clk.url;
    if (base.charAt(base.length - 1) !== "/") base += "/";
    var prevText = btnEl.textContent;
    btnEl.textContent = "\u23f3";
    btnEl.disabled = true;
    fetch(base + "api/info", { cache: "no-store" })
      .then(function(r) { return r.json(); })
      .then(function(info) { btnEl.textContent = prevText; btnEl.disabled = false; renderInfoOverlay(clk, info); })
      .catch(function() { btnEl.textContent = prevText; btnEl.disabled = false; renderInfoOverlay(clk, null); });
  }

  function startClocksScanning() {
    if (clocksScanTimer) return;
    updateNetworkClocksUi();
    // Slow safety-net poll; primary updates come via the 'clocks' SSE event.
    clocksScanTimer = setInterval(updateNetworkClocksUi, 30000);
  }

  function bootstrap() {
    initialPull();
    autoOpenMenuIfRemote();
    startClocksScanning();
    startTimeSync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
