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
  // screenClock_selectedTab + screenClock_menuPosition are per-client UI navigation
  // state; syncing them would let any other client yank our visible tab/position.
  var EXCLUDE_KEYS = {
    "screenClock_menuOpen": true,
    "screenClock_controlledClocks": true,
    "screenClock_timeMasterUrl": true,
    "screenClock_batteryAutomation": true,
    "screenClock_batterySettings": true,
    "screenClock_presenceSettings": true,
    "screenClock_presenceNativeStatus": true,
    "screenClock_selectedTab": true,
    "screenClock_menuPosition": true
  };

  function isSyncedKey(k) {
    return typeof k === "string" && k.indexOf(SYNC_PREFIX) === 0 && !EXCLUDE_KEYS[k];
  }

  function parseIpFromUrl(url) {
    if (!url) return "";
    try {
      var parsed = new URL(url);
      return (parsed.hostname || "").trim();
    } catch (_) {
      // Fallback for schemeless hosts like "192.168.1.20:8765".
      var raw = String(url).trim();
      if (!raw) return "";
      var noScheme = raw.replace(/^[a-z]+:\/\//i, "");
      var hostPart = noScheme.split("/")[0] || "";
      var host = hostPart.replace(/^\[/, "").replace(/\]$/, "").split(":")[0] || "";
      return host.trim();
    }
  }

  function getAttrValue(attrs, label) {
    if (!attrs || !attrs.length) return "";
    for (var i = 0; i < attrs.length; i++) {
      var row = attrs[i];
      if (!row || typeof row !== "object") continue;
      if (String(row.label || "").toLowerCase() === String(label || "").toLowerCase()) {
        var v = row.value;
        return typeof v === "string" ? v.trim() : (v == null ? "" : String(v).trim());
      }
    }
    return "";
  }

  function normalizeMacAddress(raw) {
    if (typeof raw !== "string") return "";
    var compact = raw.trim();
    if (!compact) return "";
    compact = compact.replace(/-/g, ":").toUpperCase();
    return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(compact) ? compact : "";
  }

  function getClockIpAddress(clk) {
    if (clk && typeof clk.ipAddress === "string" && clk.ipAddress.trim()) {
      return clk.ipAddress.trim();
    }
    return parseIpFromUrl(clk && clk.url ? clk.url : "");
  }

  function getClockMacAddress(clk) {
    var mac = normalizeMacAddress(clk && clk.macAddress ? clk.macAddress : "");
    if (mac) return mac;
    return normalizeMacAddress(clk && clk.mac ? clk.mac : "");
  }

  var IP_CACHE_KEY = "screenClock_ipCacheByAndroidId";
  var URL_ANDROID_ID_KEY = "screenClock_androidIdByClockUrl";
  var INFO_CACHE_KEY = "screenClock_infoCacheByIp";
  var CACHE_STALE_MS = 10 * 60 * 1000;

  function loadJsonCache(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveJsonCache(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value || {})); } catch (_) {}
  }

  var ipCacheByAndroidId = loadJsonCache(IP_CACHE_KEY);
  var androidIdByClockUrl = loadJsonCache(URL_ANDROID_ID_KEY);
  var infoCacheByIp = loadJsonCache(INFO_CACHE_KEY);

  function normalizeAndroidId(raw) {
    if (typeof raw !== "string") return "";
    return raw.trim().toLowerCase();
  }

  function getDiscoveryIpAddress(clk) {
    if (clk && typeof clk.ipAddress === "string" && clk.ipAddress.trim()) {
      return clk.ipAddress.trim();
    }
    return "";
  }

  function cacheAndroidIdForClock(url, androidId) {
    if (!url || !androidId) return;
    androidIdByClockUrl[url] = androidId;
    saveJsonCache(URL_ANDROID_ID_KEY, androidIdByClockUrl);
  }

  function cacheIpForAndroidId(androidId, ip, source) {
    if (!androidId || !ip) return;
    ipCacheByAndroidId[androidId] = {
      ip: ip,
      updatedAt: Date.now(),
      source: source || "unknown"
    };
    saveJsonCache(IP_CACHE_KEY, ipCacheByAndroidId);
  }

  function cloneAttrs(attrs) {
    return (Array.isArray(attrs) ? attrs : []).map(function(a) {
      return {
        label: String(a && a.label ? a.label : "").trim(),
        value: a && a.value != null ? String(a.value) : ""
      };
    }).filter(function(a) { return a.label; });
  }

  function normalizeInfoTimestampMs(info) {
    var nowMs = info && Number(info.nowMs);
    if (Number.isFinite(nowMs) && nowMs > 0) return nowMs;
    return Date.now();
  }

  function formatBuildLikeTimestamp(ms) {
    var d = new Date(Number(ms) || Date.now());
    var pad = function(n) { return n < 10 ? "0" + n : String(n); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function attrsToMap(attrs) {
    var map = {};
    cloneAttrs(attrs).forEach(function(a) { map[a.label] = a.value; });
    return map;
  }

  function mapToAttrs(map, preferredOrder) {
    var order = Array.isArray(preferredOrder) ? preferredOrder.slice() : [];
    Object.keys(map || {}).forEach(function(k) {
      if (order.indexOf(k) === -1) order.push(k);
    });
    return order.map(function(label) {
      return { label: label, value: map && map[label] != null ? String(map[label]) : "" };
    });
  }

  function desktopOsName(value) {
    return String(value || "").toLowerCase();
  }

  function isDesktopLikeOs(value) {
    var osText = desktopOsName(value);
    return /windows|darwin|macos|linux/.test(osText);
  }

  function mergeInfoRows(currentInfo, cachedInfo) {
    var currentAttrs = cloneAttrs(currentInfo && currentInfo.attrs);
    var cachedAttrs = cloneAttrs(cachedInfo && cachedInfo.attrs);
    var currentMap = attrsToMap(currentAttrs);
    var cachedMap = attrsToMap(cachedAttrs);
    var mergedMap = {};
    var order = [];

    function addValue(label, value) {
      if (!label) return;
      if (order.indexOf(label) === -1) order.push(label);
      mergedMap[label] = value;
    }

    currentAttrs.forEach(function(a) {
      var value = a.value != null ? String(a.value) : "";
      if (value) {
        addValue(a.label, value);
      } else if (cachedMap[a.label]) {
        addValue(a.label, cachedMap[a.label]);
      } else {
        addValue(a.label, "");
      }
    });

    cachedAttrs.forEach(function(a) {
      if (order.indexOf(a.label) !== -1) return;
      addValue(a.label, a.value != null ? String(a.value) : "");
    });

    var infoAsOfMs = normalizeInfoTimestampMs(currentInfo) || (cachedInfo && cachedInfo.infoAsOfMs) || Date.now();
    addValue("Information as of", formatBuildLikeTimestamp(infoAsOfMs));

    var chart = (currentInfo && currentInfo.chart) || (cachedInfo && cachedInfo.chart) || null;
    var androidId = normalizeAndroidId((currentMap["Android ID"] || cachedMap["Android ID"] || ""));
    var brandModel = currentMap["Brand / Model"] || cachedMap["Brand / Model"] || "device";

    var merged = {
      attrs: mapToAttrs(mergedMap, order),
      chart: chart,
      infoAsOfMs: infoAsOfMs,
      androidId: androidId,
      brandModel: brandModel
    };
    return merged;
  }

  function getCachedInfoForIp(ip) {
    return ip && infoCacheByIp[ip] ? infoCacheByIp[ip] : null;
  }

  function storeInfoCacheForIp(ip, info) {
    if (!ip || !info) return;
    infoCacheByIp[ip] = {
      attrs: cloneAttrs(info.attrs),
      chart: info.chart || null,
      infoAsOfMs: info.infoAsOfMs || Date.now(),
      androidId: normalizeAndroidId(info.androidId || ""),
      brandModel: info.brandModel || "device"
    };
    saveJsonCache(INFO_CACHE_KEY, infoCacheByIp);
  }

  function resolveClockIpForDisplay(clk, info) {
    var infoAttrs = info && info.attrs ? info.attrs : null;
    var androidId = normalizeAndroidId(getAttrValue(infoAttrs, "Android ID") || androidIdByClockUrl[clk && clk.url ? clk.url : ""] || "");
    var discoveryIp = getDiscoveryIpAddress(clk);
    var parsedIp = parseIpFromUrl(clk && clk.url ? clk.url : "");
    var infoIp = getAttrValue(infoAttrs, "IP Address");

    if (androidId && clk && clk.url) {
      cacheAndroidIdForClock(clk.url, androidId);
    }

    if (androidId && discoveryIp) {
      cacheIpForAndroidId(androidId, discoveryIp, "discovery");
      return { ip: discoveryIp, fromCache: false, androidId: androidId };
    }

    if (androidId && ipCacheByAndroidId[androidId] && ipCacheByAndroidId[androidId].ip) {
      var cacheEntry = ipCacheByAndroidId[androidId];
      var age = Date.now() - (Number(cacheEntry.updatedAt) || 0);
      var suffix = age > CACHE_STALE_MS ? " c" : "";
      return { ip: cacheEntry.ip + suffix, fromCache: true, androidId: androidId, ageMs: age };
    }

    if (parsedIp) {
      return { ip: parsedIp, fromCache: false, androidId: androidId };
    }

    if (infoIp) {
      return { ip: infoIp, fromCache: false, androidId: androidId };
    }

    return { ip: "", fromCache: false, androidId: androidId };
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
    if (IS_REMOTE && key === "screenClock_presenceHistory") {
      return;
    }
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

    if (key === "screenClock_presenceHistory") {
      try {
        if (window.PresenceService && typeof window.PresenceService.reloadHistoryFromStorage === "function") {
          window.PresenceService.reloadHistoryFromStorage();
        }
      } catch (e) { /* ignore */ }
    }
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
        startPolling();              // poll for all clients as reliability fallback
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

  function copyTextToClipboard(text) {
    if (!text) return Promise.reject(new Error("empty text"));
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var helper = document.createElement("textarea");
        helper.value = text;
        helper.setAttribute("readonly", "readonly");
        helper.style.position = "fixed";
        helper.style.left = "-9999px";
        helper.style.top = "0";
        document.body.appendChild(helper);
        helper.select();
        var ok = document.execCommand("copy");
        if (helper.parentNode) helper.parentNode.removeChild(helper);
        if (ok) resolve(); else reject(new Error("copy failed"));
      } catch (err) {
        reject(err);
      }
    });
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

    var title = document.createElement("div");
    title.textContent = "Remote pairing";
    title.style.cssText = "font:600 14px ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:0.04em;text-transform:uppercase;color:#12202f;";
    box.appendChild(title);

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
      "font-family:ui-monospace,Menlo,Consolas,monospace;font-size:16px;" +
      "color:#000;word-break:break-all;text-align:center;user-select:all;";
    box.appendChild(urlEl);

    var statusEl = document.createElement("div");
    statusEl.style.cssText = "font:500 12px ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;color:#314055;text-align:center;max-width:min(70vmin,560px);line-height:1.35;";
    statusEl.textContent = IS_REMOTE ? "Remote browser session active" : "This clock is ready to share";
    box.appendChild(statusEl);

    var actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;justify-content:center;";

    var copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = "Copy URL";
    copyBtn.style.cssText = "background:#12202f;border:1px solid #12202f;color:#fff;border-radius:999px;padding:8px 14px;font:600 12px ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;";
    copyBtn.addEventListener("click", function () {
      copyTextToClipboard(url).then(function () {
        copyBtn.textContent = "Copied";
        window.setTimeout(function () {
          copyBtn.textContent = "Copy URL";
        }, 1400);
      }).catch(function () {
        urlEl.focus && urlEl.focus();
      });
    });
    actions.appendChild(copyBtn);

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.style.cssText = "background:#fff;border:1px solid #c3ced9;color:#12202f;border-radius:999px;padding:8px 14px;font:600 12px ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;";
    closeBtn.addEventListener("click", hideQrOverlay);
    actions.appendChild(closeBtn);

    box.appendChild(actions);

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

        var infoAllBtn = document.createElement("button");
        infoAllBtn.style.cssText = "flex: 0 0 auto; min-width: 74px; font-size: 10px; font-weight: bold; border-radius: 4px; padding: 4px 10px; border: 1px solid #31c8ff; background: #042235; color: #31c8ff; cursor: pointer; text-transform: uppercase; letter-spacing: 0.04em; transition: background 0.1s, box-shadow 0.1s; box-shadow: 0 0 8px rgba(49,200,255,0.35);";
        infoAllBtn.textContent = "Info";
        infoAllBtn.addEventListener("mouseover", function () {
          infoAllBtn.style.background = "#0a3450";
          infoAllBtn.style.boxShadow = "0 0 12px rgba(49,200,255,0.55)";
        });
        infoAllBtn.addEventListener("mouseout", function () {
          infoAllBtn.style.background = "#042235";
          infoAllBtn.style.boxShadow = "0 0 8px rgba(49,200,255,0.35)";
        });
        infoAllBtn.addEventListener("click", function () {
          toggleConsolidatedInfoOverlay(infoAllBtn);
        });

        controlsGroup.appendChild(wakeAllBtn);
        controlsGroup.appendChild(sleepAllBtn);
        controlsGroup.appendChild(infoAllBtn);
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

          var nameContainer = document.createElement("div");
          nameContainer.style.cssText = "display: flex; flex-direction: column; min-width: 0; cursor: pointer; user-select: none;";

          var nameSpan = document.createElement("span");
          nameSpan.style.cssText = "font-size: 14px; color: " + (clk.isSelf ? "#888" : "#fff") + "; line-height: 1.2; cursor: pointer; user-select: none; transition: color 0.15s;";
          nameSpan.textContent = clk.name;

          var detailsSpan = document.createElement("span");
          detailsSpan.style.cssText = "font-size: 10px; color: #7f8794; line-height: 1.2; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; user-select: none;";
          var detailsText = [];
          var macAddress = getClockMacAddress(clk);
          if (macAddress) detailsText.push("MAC " + macAddress);
          detailsSpan.textContent = detailsText.join("   ");

          nameContainer.appendChild(nameSpan);
          nameContainer.appendChild(detailsSpan);
          nameContainer.title = "Click to copy: " + (clk.url || "");
          nameContainer.addEventListener("click", function () {
            if (!clk.url) return;
            var originalName = nameSpan.textContent;
            var originalColor = nameSpan.style.color;
            copyTextToClipboard(clk.url).then(function () {
              nameSpan.textContent = "Copied!";
              nameSpan.style.color = "#00cc66";
              window.setTimeout(function () {
                nameSpan.textContent = originalName;
                nameSpan.style.color = originalColor;
              }, 1200);
            }).catch(function () {
              nameSpan.textContent = "Copy failed";
              nameSpan.style.color = "#ff4444";
              window.setTimeout(function () {
                nameSpan.textContent = originalName;
                nameSpan.style.color = originalColor;
              }, 1200);
            });
          });

          // Action buttons container
          var actionContainer = document.createElement("div");
          actionContainer.style.cssText = "display: flex; gap: 4px; justify-content: flex-end; align-items: center;";

          // Watt badge (shown when device reports current draw)
          if (typeof clk.milliWatts === "number" && clk.milliWatts >= 0) {
            var watt = document.createElement("span");
            var w = (clk.milliWatts / 1000).toFixed(1);
            watt.style.cssText = "font-size: 10px; font-weight: bold; color: #aaaaff; background: rgba(0,0,0,0.35); border: 1px solid #aaaaff; border-radius: 3px; padding: 0 4px; height: 20px; line-height: 20px; box-sizing: border-box; white-space: nowrap; display: inline-flex; align-items: center;";
            watt.textContent = w + "W";
            actionContainer.appendChild(watt);
          }

          // Battery badge (shown for all entries that report battery)
          if (typeof clk.battery === "number" && clk.battery >= 0) {
            var bat = document.createElement("span");
            var pct = clk.battery;
            var batColor = pct <= 15 ? "#ff3333" : pct <= 40 ? "#ffaa00" : "#00cc55";
            bat.style.cssText = "font-size: 10px; font-weight: bold; color: " + batColor + "; background: rgba(0,0,0,0.35); border: 1px solid " + batColor + "; border-radius: 3px; padding: 0 4px; height: 20px; line-height: 20px; box-sizing: border-box; white-space: nowrap; display: inline-flex; align-items: center;";
            bat.textContent = "⚡" + pct + "%";
            actionContainer.appendChild(bat);
          }

          if (!clk.isSelf) {
            // Combined toggle span (not <button> to avoid UA stylesheet height overrides)
            var toggleBtn = document.createElement("span");
            var isCurrentlyAsleep = !!clockSleepStates[clk.url];
            var toggleDisabled = false;

            var toggleBaseStyle = "font-size: 10px; font-weight: bold; border-radius: 4px; border-style: solid; border-width: 1px; cursor: pointer; text-transform: uppercase; width: 54px; height: 20px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; user-select: none; transition: background 0.1s; vertical-align: middle;";
            if (isCurrentlyAsleep) {
              toggleBtn.style.cssText = toggleBaseStyle + "border-color: #00ff66; background: #1a3a21; color: #00ff66;";
              toggleBtn.textContent = "Wake";
              toggleBtn.addEventListener("mouseover", function () { if (!toggleDisabled) toggleBtn.style.background = "#244d2e"; });
              toggleBtn.addEventListener("mouseout",  function () { if (!toggleDisabled) toggleBtn.style.background = "#1a3a21"; });
            } else {
              toggleBtn.style.cssText = toggleBaseStyle + "border-color: #ff3333; background: #3a1a1a; color: #ff3333;";
              toggleBtn.textContent = "Sleep";
              toggleBtn.addEventListener("mouseover", function () { if (!toggleDisabled) toggleBtn.style.background = "#4d2424"; });
              toggleBtn.addEventListener("mouseout",  function () { if (!toggleDisabled) toggleBtn.style.background = "#3a1a1a"; });
            }

            toggleBtn.addEventListener("click", function () {
              if (toggleDisabled) return;
              toggleDisabled = true;
              toggleBtn.style.opacity = "0.5";

              var endpoint = isCurrentlyAsleep ? "api/wake" : "api/sleep";
              var targetUrl = clk.url;
              if (targetUrl.lastIndexOf("/") !== targetUrl.length - 1) targetUrl += "/";

              fetch(targetUrl + endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" }
              }).then(function (r) {
                console.log(LOG, "POST " + clk.url + endpoint + " ->", r.status);
                var newState = !isCurrentlyAsleep;
                pendingClockToggles[clk.url] = newState;
                clockSleepStates[clk.url] = newState;
                updateNetworkClocksUi();
              }).catch(function (e) {
                console.warn(LOG, "POST " + clk.url + endpoint + " failed", e);
                toggleDisabled = false;
                toggleBtn.style.opacity = "1";
              });
            });

            actionContainer.appendChild(toggleBtn);
          }

          row.appendChild(checkbox);
          row.appendChild(radio);
          row.appendChild(nameContainer);
          row.appendChild(actionContainer);
          listContainer.appendChild(row);
        });
      })
      .catch(function () {
        // Hide if api is unavailable or fails (e.g. static dev server)
        section.style.display = "none";
      });
  }

  // ---- Consolidated device info overlay ----

  var INFO_OVERLAY_ID = "__wvclock_info_overlay__";
  var INFO_OVERLAY_SCROLL_CLASS = "wvclock-info-overlay-scroll";
  var INFO_OVERLAY_SCROLL_STYLE_ID = "wvclock-info-overlay-scroll-style";
  var consolidatedInfoRefreshTimer = null;
  var CONSOLIDATED_INFO_STATE_KEY = "screenClock_consolidatedInfoState";
  var consolidatedInfoState = loadJsonCache(CONSOLIDATED_INFO_STATE_KEY);
  if (typeof consolidatedInfoState.localCollapsed !== "boolean") {
    consolidatedInfoState.localCollapsed = true;
    saveJsonCache(CONSOLIDATED_INFO_STATE_KEY, consolidatedInfoState);
  }

  function ensureInfoOverlayScrollStyles() {
    if (document.getElementById(INFO_OVERLAY_SCROLL_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = INFO_OVERLAY_SCROLL_STYLE_ID;
    style.textContent =
      "." + INFO_OVERLAY_SCROLL_CLASS + "{scrollbar-color:#2e3f52 #0e141d;scrollbar-width:thin;}" +
      "." + INFO_OVERLAY_SCROLL_CLASS + "::-webkit-scrollbar{height:12px;width:12px;background:#0e141d;}" +
      "." + INFO_OVERLAY_SCROLL_CLASS + "::-webkit-scrollbar-track{background:#0e141d;}" +
      "." + INFO_OVERLAY_SCROLL_CLASS + "::-webkit-scrollbar-thumb{background:#2e3f52;border:2px solid #0e141d;border-radius:10px;}" +
      "." + INFO_OVERLAY_SCROLL_CLASS + "::-webkit-scrollbar-thumb:hover{background:#39526a;}";
    (document.head || document.documentElement).appendChild(style);
  }

  function removeInfoOverlay() {
    var existing = document.getElementById(INFO_OVERLAY_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (consolidatedInfoRefreshTimer) {
      clearInterval(consolidatedInfoRefreshTimer);
      consolidatedInfoRefreshTimer = null;
    }
  }

  function fetchInfoForClock(clk) {
    var base = clk && clk.url ? clk.url : "";
    if (!base) return Promise.resolve({ clk: clk, info: null });
    if (base.charAt(base.length - 1) !== "/") base += "/";
    return fetch(base + "api/info", { cache: "no-store" })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(info) {
        var attrs = info && Array.isArray(info.attrs) ? info.attrs : [];
        var androidId = normalizeAndroidId(getAttrValue(attrs, "Android ID"));
        if (androidId && clk && clk.url) cacheAndroidIdForClock(clk.url, androidId);
        var resolvedIp = resolveClockIpForDisplay(clk, info).ip;
        if (resolvedIp && androidId && getDiscoveryIpAddress(clk)) {
          cacheIpForAndroidId(androidId, getDiscoveryIpAddress(clk), "discovery");
        }
        return {
          clk: clk,
          info: info,
          attrs: attrs,
          androidId: androidId,
          ipDisplay: resolvedIp,
          brandModel: getAttrValue(attrs, "Brand / Model") || (clk && clk.name ? clk.name : "device")
        };
      })
      .catch(function() {
        return {
          clk: clk,
          info: null,
          attrs: [],
          androidId: normalizeAndroidId(androidIdByClockUrl[clk && clk.url ? clk.url : ""] || ""),
          ipDisplay: resolveClockIpForDisplay(clk, null).ip,
          brandModel: clk && clk.name ? clk.name : "device"
        };
      });
  }

  function uniqueAttrLabels(deviceInfos) {
    var resolutionLabel = "Resolution (w x h)";
    var hidden = {
      "MAC Address": true,
      "Serial": true,
      "Information as of": true
    };
    function canonicalizeLabel(label) {
      if (!label) return "";
      var trimmed = String(label).trim();
      if (!trimmed) return "";
      if (/^Resolution \(w .* h\)$/.test(trimmed)) return resolutionLabel;
      return trimmed;
    }
    var preferred = [
      "Brand / Model", "IP Address", "OS", resolutionLabel, "Density (DPI)",
      "Android ID", "Build", "Git commit", "Uptime", "App uptime",
      "Battery temp", "RAM used / total", "Wi-Fi signal"
    ];
    var seen = {};
    var labels = [];
    preferred.forEach(function(label) { seen[label] = true; labels.push(label); });
    deviceInfos.forEach(function(d) {
      (d.attrs || []).forEach(function(a) {
        var label = canonicalizeLabel(a && a.label ? a.label : "");
        if (!label || hidden[label] || seen[label]) return;
        seen[label] = true;
        labels.push(label);
      });
    });
    return labels;
  }

  function normalizeResolutionValue(valueText) {
    var raw = valueText == null ? "" : String(valueText).trim();
    if (!raw || raw === "-") return "-";
    var parts = raw.match(/(\d+)\D+(\d+)/);
    if (parts) return parts[1] + " x " + parts[2];
    return raw.replace(/\u00d7/g, "x");
  }

  function getConsolidatedValue(d, label, overlayState) {
    if (label === "Brand / Model") {
      return getAttrValue(d.attrs, label) || getAttrValue(d.cachedAttrs, label) || d.brandModel || "device";
    }
    if (label === "IP Address") {
      return d.ipDisplay || "-";
    }
    if (label === "Resolution (w x h)") {
      var resolutionValue = getAttrValue(d.attrs, "Resolution (w \u00d7 h)") ||
        getAttrValue(d.cachedAttrs, "Resolution (w \u00d7 h)") ||
        getAttrValue(d.attrs, "Resolution (w x h)") ||
        getAttrValue(d.cachedAttrs, "Resolution (w x h)") || "-";
      return normalizeResolutionValue(resolutionValue);
    }
    if (label === "Information as of") {
      return d.infoAsOf || ((overlayState && overlayState.infoAsOf) || formatBuildLikeTimestamp(Date.now()));
    }
    return getAttrValue(d.attrs, label) || getAttrValue(d.cachedAttrs, label) || "-";
  }

  function drawLogicSegment(ctx, data, nowState, color, x0, yTop, w, h) {
    var n = data.length;
    if (!n) return;
    var hiY = yTop + 2;
    var loY = yTop + h - 2;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    for (var i = 0; i <= n; i++) {
      var isHigh = i < n ? (data[i] > 0) : !!nowState;
      var x = x0 + (i / n) * w;
      var y = isHigh ? hiY : loY;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        var prevHigh = (i - 1) < n ? (data[i - 1] > 0) : !!nowState;
        if (isHigh !== prevHigh) {
          ctx.lineTo(x, prevHigh ? hiY : loY);
          ctx.lineTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
    }
    ctx.stroke();
  }

  function chooseTimeTickStepMs(totalMs, targetTicks) {
    var minStep = 30 * 60 * 1000;
    var ideal = Math.max(minStep, totalMs / Math.max(1, targetTicks || 4));
    var steps = [
      30 * 60 * 1000,
      60 * 60 * 1000,
      2 * 60 * 60 * 1000,
      3 * 60 * 60 * 1000,
      4 * 60 * 60 * 1000,
      6 * 60 * 60 * 1000,
      8 * 60 * 60 * 1000,
      12 * 60 * 60 * 1000,
      24 * 60 * 60 * 1000
    ];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] >= ideal) return steps[i];
    }
    return steps[steps.length - 1];
  }

  function formatTimeTickLabel(ms) {
    var dte = new Date(ms);
    var hh = dte.getHours();
    var mm = dte.getMinutes();
    return (hh < 10 ? "0" + hh : String(hh)) + ":" + (mm < 10 ? "0" + mm : String(mm));
  }

  function drawConsolidatedChartForDevice(canvas, deviceInfo) {
    if (!canvas) return;
    var chart = (deviceInfo && deviceInfo.info && deviceInfo.info.chart) || (deviceInfo && deviceInfo.chart) || null;
    if (!chart) return;

    var fixedWidth = 240;
    var rowHeight = 66;
    var paddingX = 4;
    var targetWidth = fixedWidth;
    canvas.width = targetWidth;
    canvas.height = rowHeight;
    canvas.style.width = canvas.width + "px";
    canvas.style.height = canvas.height + "px";

    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0f141b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var plotX = paddingX;
    var plotW = Math.max(120, canvas.width - plotX - paddingX);
    var appActive = Array.isArray(chart.appActive) ? chart.appActive.slice() : [];
    var screenAwake = Array.isArray(chart.screenAwake) ? chart.screenAwake.slice() : [];
    var n = Math.max(appActive.length, screenAwake.length, 2);
    while (appActive.length < n) appActive.push(0);
    while (screenAwake.length < n) screenAwake.push(0);
    var nowApp = chart.nowAppActive !== undefined ? !!chart.nowAppActive : appActive[n - 1] > 0;
    var nowScr = chart.nowScreenAwake !== undefined ? !!chart.nowScreenAwake : screenAwake[n - 1] > 0;

    ctx.strokeStyle = "#22303c";
    ctx.lineWidth = 1;
    ctx.strokeRect(1, 1, canvas.width - 2, rowHeight - 2);

    var plotY = 6;
    var plotH = rowHeight - 20;
    var midY = plotY + Math.floor(plotH / 2);

    ctx.strokeStyle = "#1f2a34";
    ctx.beginPath();
    ctx.moveTo(plotX, midY);
    ctx.lineTo(plotX + plotW, midY);
    ctx.stroke();

    for (var gi = 0; gi <= 4; gi++) {
      var gx = plotX + (gi / 4) * plotW;
      ctx.strokeStyle = "#18212a";
      ctx.beginPath();
      ctx.moveTo(gx, plotY);
      ctx.lineTo(gx, plotY + plotH);
      ctx.stroke();
    }

    drawLogicSegment(ctx, screenAwake, nowScr, "#55ddff", plotX, plotY, plotW, Math.floor(plotH / 2));
    drawLogicSegment(ctx, appActive, nowApp, "#ffdd55", plotX, midY, plotW, Math.floor(plotH / 2));

    var bucketZeroMs = Number(chart.bucketZeroMs) || Date.now() - (n * 3600000);
    var bucketMs = Number(chart.bucketMs) || 3600000;
    var totalMs = Math.max(1, n * bucketMs);
    var endMs = bucketZeroMs + totalMs;
    var stepMs = chooseTimeTickStepMs(totalMs, 5);
    var firstTick = Math.ceil(bucketZeroMs / stepMs) * stepMs;
    var ticks = [];
    for (var t = firstTick; t <= endMs; t += stepMs) ticks.push(t);
    if (!ticks.length) ticks = [bucketZeroMs, endMs];

    var maxLabels = Math.max(2, Math.floor(plotW / 56));
    if (ticks.length > maxLabels) {
      var stride = Math.ceil(ticks.length / maxLabels);
      ticks = ticks.filter(function(_, idx) { return idx % stride === 0; });
    }
    if (ticks[ticks.length - 1] !== endMs) ticks.push(endMs);

    ctx.fillStyle = "#7e94a8";
    ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
    ticks.forEach(function(tMs, idx) {
      var pos = (tMs - bucketZeroMs) / totalMs;
      if (pos < 0 || pos > 1) return;
      var tx = plotX + pos * plotW;
      ctx.textAlign = idx === 0 ? "left" : (idx === ticks.length - 1 ? "right" : "center");
      ctx.fillText(formatTimeTickLabel(tMs), tx, rowHeight - 4);
    });
    ctx.textAlign = "left";
  }

  function exportConsolidatedInfoTsv(deviceInfos, labels, overlayState) {
    if (!Array.isArray(deviceInfos) || !deviceInfos.length) return;
    var header = ["Field"].concat(deviceInfos.map(function(d) {
      return (d.ipDisplay || "-") + " | " + (d.brandModel || "device");
    }));
    var rows = [header.join("\t")];
    labels.forEach(function(label) {
      var cols = [label];
      deviceInfos.forEach(function(d) {
        var val = "-";
          val = getConsolidatedValue(d, label, overlayState);
        cols.push(String(val).replace(/[\t\n\r]+/g, " "));
      });
      rows.push(cols.join("\t"));
    });
    var blob = new Blob([rows.join("\n")], { type: "text/tab-separated-values;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "network-device-info-" + formatBuildLikeTimestamp(Date.now()).replace(/[ :]/g, "-") + ".tsv";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
      URL.revokeObjectURL(a.href);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 0);
  }

  function renderConsolidatedInfoOverlay(deviceInfos, overlayState) {
    removeInfoOverlay();
    ensureInfoOverlayScrollStyles();

    var overlay = document.createElement("div");
    overlay.id = INFO_OVERLAY_ID;
    overlay.style.cssText = "position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483642;background:#11151c;border:none;border-radius:0;color:#d8e8f7;font-family:ui-monospace,Menlo,Consolas,monospace;box-shadow:none;display:flex;flex-direction:column;";

    var header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid #273443;";
    var title = document.createElement("div");
    title.textContent = "Network Device Info | Information as of " + ((overlayState && overlayState.infoAsOf) || formatBuildLikeTimestamp(Date.now()));
    title.style.cssText = "font-size:13px;font-weight:bold;color:#9fd8ff;letter-spacing:0.04em;text-transform:uppercase;";
    var closeBtn = document.createElement("button");
    closeBtn.textContent = "\u00d7";
    closeBtn.style.cssText = "background:transparent;border:none;color:#8ea5ba;font-size:22px;cursor:pointer;line-height:1;padding:0 4px;";
    closeBtn.addEventListener("click", removeInfoOverlay);
    var titleWrap = document.createElement("div");
    titleWrap.appendChild(title);
    header.appendChild(titleWrap);

    var actions = document.createElement("div");
    actions.style.cssText = "display:flex;align-items:center;gap:8px;";

    var localVisible = deviceInfos.some(function(d) { return d && d.isLocal; });
    if (localVisible) {
      var localToggle = document.createElement("button");
      localToggle.type = "button";
      localToggle.textContent = overlayState && overlayState.localCollapsed ? "show local" : "hide local";
      localToggle.style.cssText = "background:#17202a;border:1px solid #314055;color:#9fd8ff;border-radius:999px;padding:4px 10px;font:inherit;cursor:pointer;";
      localToggle.addEventListener("click", function() {
        consolidatedInfoState.localCollapsed = !consolidatedInfoState.localCollapsed;
        saveJsonCache(CONSOLIDATED_INFO_STATE_KEY, consolidatedInfoState);
        loadConsolidatedInfo(null);
      });
      actions.appendChild(localToggle);
    }
    var exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.textContent = "export";
    exportBtn.style.cssText = "background:#17202a;border:1px solid #314055;color:#9fd8ff;border-radius:999px;padding:4px 10px;font:inherit;cursor:pointer;";
    actions.appendChild(exportBtn);
    actions.appendChild(closeBtn);
    header.appendChild(actions);
    overlay.appendChild(header);

    var body = document.createElement("div");
    body.className = INFO_OVERLAY_SCROLL_CLASS;
    body.style.cssText = "flex:1;overflow:auto;padding:12px;";

    var visibleInfos = deviceInfos.filter(function(info) {
      return !(overlayState && overlayState.localCollapsed && info && info.isLocal);
    });
    var labels = uniqueAttrLabels(visibleInfos);
    var grid = document.createElement("div");
    grid.style.cssText = "display:grid;gap:4px 1.5em;align-items:start;grid-template-columns:max-content repeat(" + visibleInfos.length + ", max-content);width:max-content;";

    labels.forEach(function(label) {
      var lbl = document.createElement("div");
      lbl.textContent = label;
      lbl.style.cssText = "color:#7f93a6;font-size:12px;padding:2px 0;border-bottom:1px dashed #1d2a36;";
      grid.appendChild(lbl);

      visibleInfos.forEach(function(d) {
        var valText = getConsolidatedValue(d, label, overlayState);
        var val = document.createElement("div");
        val.textContent = valText;
        val.style.cssText = "color:#dbe7f2;font-size:12px;padding:2px 0;border-bottom:1px dashed #1d2a36;word-break:break-word;overflow-wrap:anywhere;";
        grid.appendChild(val);
      });
    });
    body.appendChild(grid);
    exportBtn.addEventListener("click", function() {
      exportConsolidatedInfoTsv(visibleInfos, labels, overlayState);
    });

    if (visibleInfos.length) {
      var chartLabel = document.createElement("div");
      chartLabel.innerHTML = "Activity<br><span style='color:#55ddff'>\u25cf Screen awake</span><br><span style='color:#ffdd55'>\u25cf App active</span>";
      chartLabel.style.cssText = "color:#7f93a6;font-size:12px;padding:2px 0;line-height:1.35;";
      grid.appendChild(chartLabel);

      var graphCards = [];
      visibleInfos.forEach(function(d) {
        var graphWrap = document.createElement("div");
        graphWrap.style.cssText = "width:240px;overflow:hidden;border:1px solid #263543;border-radius:6px;background:#0f141b;";
        var canvas = document.createElement("canvas");
        graphWrap.appendChild(canvas);
        grid.appendChild(graphWrap);
        graphCards.push({ canvas: canvas, info: d });
      });

      requestAnimationFrame(function() {
        graphCards.forEach(function(entry) {
          drawConsolidatedChartForDevice(entry.canvas, entry.info);
        });
      });
    }

    overlay.appendChild(body);
    document.body.appendChild(overlay);

    var onEsc = function(e) {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", onEsc, true);
        removeInfoOverlay();
      }
    };
    document.addEventListener("keydown", onEsc, true);
  }

  function loadConsolidatedInfo(btnEl) {
    var clocks = (discoveredClocksList || []).slice();
    if (!clocks.length) return Promise.resolve();
    var prevText = btnEl ? btnEl.textContent : "";
    if (btnEl) {
      btnEl.textContent = "Loading";
      btnEl.style.pointerEvents = "none";
    }

    return Promise.all(clocks.map(fetchInfoForClock)).then(function(rows) {
      var deviceInfos = rows.map(function(row) {
        var clk = row && row.clk ? row.clk : null;
        var resolved = resolveClockIpForDisplay(clk, row && row.info ? row.info : null);
        var ip = resolved && resolved.ip ? resolved.ip : "";
        var cacheEntry = getCachedInfoForIp(ip);
        var merged = mergeInfoRows(row && row.info ? row.info : row, cacheEntry);
        merged.ipDisplay = ip || (row && row.ipDisplay) || "";
        merged.brandModel = merged.brandModel || (row && row.brandModel) || "device";
        merged.isLocal = isDesktopLikeOs(getAttrValue(merged.attrs, "OS") || merged.brandModel) || !!(row && row.isLocal);
        merged.cachedAttrs = cacheEntry && cacheEntry.attrs ? cacheEntry.attrs : [];
        merged.infoAsOf = formatBuildLikeTimestamp(merged.infoAsOfMs || Date.now());
        merged.chart = (row && row.info && row.info.chart) || (cacheEntry && cacheEntry.chart) || null;
        merged.info = row && row.info ? row.info : (cacheEntry && cacheEntry.chart ? { chart: cacheEntry.chart } : null);
        merged.clk = clk;
        if (ip) storeInfoCacheForIp(ip, merged);
        return merged;
      }).filter(function(info) {
        return !!(info && (info.ipDisplay || info.brandModel));
      });
      consolidatedInfoState.infoAsOf = formatBuildLikeTimestamp(Date.now());
      saveJsonCache(CONSOLIDATED_INFO_STATE_KEY, consolidatedInfoState);
      renderConsolidatedInfoOverlay(deviceInfos, consolidatedInfoState);
      if (btnEl) {
        btnEl.textContent = prevText;
        btnEl.style.pointerEvents = "";
      }
    }).catch(function() {
      if (btnEl) {
        btnEl.textContent = prevText;
        btnEl.style.pointerEvents = "";
      }
    });
  }

  function toggleConsolidatedInfoOverlay(btnEl) {
    var existing = document.getElementById(INFO_OVERLAY_ID);
    if (existing) {
      removeInfoOverlay();
      return;
    }
    loadConsolidatedInfo(btnEl).then(function() {
      if (consolidatedInfoRefreshTimer) clearInterval(consolidatedInfoRefreshTimer);
      consolidatedInfoRefreshTimer = setInterval(function() {
        if (!document.getElementById(INFO_OVERLAY_ID)) {
          clearInterval(consolidatedInfoRefreshTimer);
          consolidatedInfoRefreshTimer = null;
          return;
        }
        loadConsolidatedInfo(null);
      }, 60000);
    });
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
