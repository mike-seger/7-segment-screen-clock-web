package com.github.mikeseger.wvclock

import android.content.Context
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Lightweight HTTP server that:
 *  - serves the web/ assets bundled into the APK,
 *  - injects a remote-bridge.js into index.html so the configuration UI
 *    on any client (the on-device WebView + any remote browser) shares
 *    state via /api/state + SSE /api/events.
 */
class ClockServer(
    private val context: Context,
    private val port: Int,
    private val lanUrlProvider: () -> String?,
    private val batteryLevelProvider: () -> Int = { -1 },
    private val batteryMilliWattsProvider: () -> Int = { -1 },
    private val macAddressProvider: () -> String? = { null },
    private val wifiLockHeldProvider: () -> Boolean = { false }
) : NanoHTTPD(port) {

    // Last-known persisted state (mirrors localStorage keys that begin with screenClock_).
    val state = ConcurrentHashMap<String, String>()

    // Open SSE subscribers.
    private val sseClients = CopyOnWriteArrayList<SseClient>()

    // Background scheduler for SSE heartbeats.
    private val heartbeat = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "wv-clock-sse-heartbeat").apply { isDaemon = true }
    }

    // Network discovery / clock synchronization states
    // Persisted across restarts so that other devices don't see a new peer entry
    // every time this app is redeployed or restarted.
    private val serverId: String = run {
        val prefs = context.getSharedPreferences("wv_clock_server", android.content.Context.MODE_PRIVATE)
        prefs.getString("server_id", null) ?: java.util.UUID.randomUUID().toString().also { newId ->
            prefs.edit().putString("server_id", newId).apply()
        }
    }
    private val discoveredClocks = ConcurrentHashMap<String, DiscoveredClock>()

    private data class DiscoveredClock(
        val id: String,
        val name: String,
        val url: String,
        val lastSeen: Long,
        val battery: Int = -1,
        val milliWatts: Int = -1,
        val isAsleep: Boolean = false,
        val ipAddress: String = "",
        val macAddress: String = ""
    )

    private var udpSocket: DatagramSocket? = null
    private var udpReceiverThread: Thread? = null
    private val udpSenderExecutor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "wv-clock-udp-sender").apply { isDaemon = true }
    }

    @Volatile
    var calculatedOffsetMs: Long = 0
        private set(value) {
            val changed = field != value
            field = value
            if (changed) {
                onOffsetChangedListener?.invoke(value)
            }
        }

    var onOffsetChangedListener: ((Long) -> Unit)? = null
    var onWakeRequestedListener: (() -> Unit)? = null
    var onSleepRequestedListener: (() -> Unit)? = null
    var onStateChangedListener: ((String, String?) -> Unit)? = null

    @Volatile
    var isScreenAsleep: Boolean = false
        set(value) {
            if (field != value) {
                field = value
                activityEvents.add(ActivityEvent(System.currentTimeMillis(), !value, ActivityType.SCREEN))
                trimActivityEvents()
                saveActivityEventsAsync()
                broadcastClocksUpdate()
            }
        }

    private var p2pSocket: DatagramSocket? = null
    private var p2pThread: Thread? = null

    private data class BatteryPoint(val timestampMs: Long, val batteryPct: Int)
    private data class ThresholdPoint(val timestampMs: Long, val thresholdOnPct: Int, val thresholdOffPct: Int)
    private data class SwitchStatePoint(val timestampMs: Long, val on: Int)
    private data class BatterySettings(
        val enabled: Boolean,
        val switchIp: String,
        val thresholdOnPct: Int,
        val thresholdOffPct: Int
    )

    private val batteryBucketMs = 10L * 60 * 1000
    private val batteryRetentionMs = 7L * 24 * 60 * 60 * 1000
    private val batteryMaxPoints = (batteryRetentionMs / batteryBucketMs).toInt()
    private val minAutomationActionIntervalMs = 5L * 60 * 1000
    private val batteryHistory = java.util.concurrent.CopyOnWriteArrayList<BatteryPoint>()
    private val thresholdHistory = java.util.concurrent.CopyOnWriteArrayList<ThresholdPoint>()
    private val switchStateHistory = java.util.concurrent.CopyOnWriteArrayList<SwitchStatePoint>()
    private val batteryFile = java.io.File(context.filesDir, "battery_events.json")
    private val thresholdFile = java.io.File(context.filesDir, "battery_threshold_events.json")
    private val switchStateFile = java.io.File(context.filesDir, "battery_switch_events.json")
    @Volatile private var lastBatterySampleBucketMs = 0L
    @Volatile private var lastAutomationActionAtMs = 0L
    @Volatile private var lastAutomationAction = ""

    private val serverStartMs = System.currentTimeMillis()
    private val activityEvents = java.util.concurrent.CopyOnWriteArrayList<ActivityEvent>()
    private val activityFile = java.io.File(context.filesDir, "activity_events.json")

    private var lastNtpSyncTime = 0L
    private var lastP2pSyncTime = 0L
    private val syncExecutor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "wv-clock-dynamic-sync").apply { isDaemon = true }
    }

    init {
        loadActivityEvents()
        loadBatteryHistory()
        loadThresholdHistory()
        loadSwitchStateHistory()
        activityEvents.add(ActivityEvent(serverStartMs, true, ActivityType.APP))
        activityEvents.add(ActivityEvent(serverStartMs, true, ActivityType.SCREEN))
        sampleSelfBattery(serverStartMs)
        recordThresholdSnapshot(getBatterySettingsFromState(), serverStartMs)
        heartbeat.scheduleAtFixedRate({
            val bytes = ": ping\n\n".toByteArray()
            for (c in sseClients) c.offer(bytes)
        }, 15, 15, TimeUnit.SECONDS)
        heartbeat.scheduleAtFixedRate({
            try {
                sampleSelfBattery(System.currentTimeMillis())
                evaluateBatteryAutomation()
            } catch (e: Exception) {
                Log.w(TAG, "Battery automation loop failed", e)
            }
        }, 5, 60, TimeUnit.SECONDS)
    }

    override fun start(timeout: Int, daemon: Boolean) {
        super.start(timeout, daemon)
        startUdpDiscovery()
        startP2pServer()
        startDynamicSyncScheduler()
    }

    private fun startUdpDiscovery() {
        try {
            val socket = DatagramSocket(8766).apply {
                reuseAddress = true
                broadcast = true
            }
            udpSocket = socket

            udpReceiverThread = Thread({
                val buffer = ByteArray(2048)
                while (!socket.isClosed) {
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        socket.receive(packet)
                        val message = String(packet.data, 0, packet.length, Charsets.UTF_8)
                        if (message.startsWith("WvClockDiscovery:")) {
                            val jsonStr = message.substring("WvClockDiscovery:".length)
                            val obj = JSONObject(jsonStr)
                            val id = obj.getString("id")
                            if (id != serverId) {
                                val name = obj.getString("name")
                                val url = obj.getString("url")
                                val battery = if (obj.has("battery")) obj.getInt("battery") else -1
                                val milliWatts = if (obj.has("milliWatts")) obj.getInt("milliWatts") else -1
                                val isAsleep = if (obj.has("isAsleep")) obj.getBoolean("isAsleep") else false
                                val ipAddress = if (obj.has("ipAddress")) obj.optString("ipAddress", "") else parseHostFromUrl(url) ?: ""
                                val macAddress = normalizeMacAddress(if (obj.has("macAddress")) obj.optString("macAddress", "") else "")
                                val prev = discoveredClocks[id]
                                val changed = prev == null
                                    || prev.isAsleep != isAsleep
                                    || Math.abs(prev.battery - battery) >= 5
                                discoveredClocks[id] = DiscoveredClock(
                                    id = id,
                                    name = name,
                                    url = url,
                                    lastSeen = System.currentTimeMillis(),
                                    battery = battery,
                                    milliWatts = milliWatts,
                                    isAsleep = isAsleep,
                                    ipAddress = ipAddress,
                                    macAddress = macAddress
                                )
                                if (changed) broadcastClocksUpdate()
                            }
                        }
                    } catch (e: Exception) {
                        if (socket.isClosed) break
                        Log.e(TAG, "UDP receive error", e)
                    }
                }
            }, "wv-clock-udp-receiver").apply { isDaemon = true }.also { it.start() }

            udpSenderExecutor.scheduleAtFixedRate({
                val url = lanUrlProvider()
                if (url != null) {
                    try {
                        val payload = JSONObject().apply {
                            put("id", serverId)
                            put("name", android.os.Build.MODEL)
                            put("url", url)
                            put("battery", batteryLevelProvider())
                            put("milliWatts", batteryMilliWattsProvider())
                            put("ipAddress", parseHostFromUrl(url) ?: "")
                            put("macAddress", normalizeMacAddress(macAddressProvider() ?: ""))
                            put("isAsleep", isScreenAsleep)
                        }
                        val msg = "WvClockDiscovery:$payload"
                        val bytes = msg.toByteArray(Charsets.UTF_8)
                        val address = InetAddress.getByName("255.255.255.255")
                        val packet = DatagramPacket(bytes, bytes.size, address, 8766)
                        socket.send(packet)
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to send UDP broadcast", e)
                    }
                }
            }, 1, 5, TimeUnit.SECONDS)

        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize UDP discovery", e)
        }
    }

    private fun stopUdpDiscovery() {
        try {
            udpSocket?.close()
        } catch (_: Exception) {}
        try {
            udpSenderExecutor.shutdownNow()
        } catch (_: Exception) {}
        udpReceiverThread?.interrupt()
    }

    private fun startP2pServer() {
        try {
            val socket = DatagramSocket(8767).apply {
                reuseAddress = true
            }
            p2pSocket = socket

            p2pThread = Thread({
                val buffer = ByteArray(2048)
                while (!socket.isClosed) {
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        socket.receive(packet)
                        
                        if (isMaster()) {
                            val requestStr = String(packet.data, 0, packet.length, Charsets.UTF_8)
                            val requestJson = JSONObject(requestStr)
                            if (requestJson.optString("type") == "ping") {
                                val t0 = requestJson.getLong("t0")
                                val t1 = System.currentTimeMillis() + calculatedOffsetMs
                                
                                val responseJson = JSONObject().apply {
                                    put("type", "pong")
                                    put("t0", t0)
                                    put("t1", t1)
                                    put("t2", System.currentTimeMillis() + calculatedOffsetMs)
                                }
                                val responseBytes = responseJson.toString().toByteArray(Charsets.UTF_8)
                                val responsePacket = DatagramPacket(
                                    responseBytes, responseBytes.size,
                                    packet.address, packet.port
                                )
                                socket.send(responsePacket)
                            }
                        }
                    } catch (e: Exception) {
                        if (socket.isClosed) break
                        Log.e(TAG, "P2P UDP receive error", e)
                    }
                }
            }, "wv-clock-p2p-receiver").apply { isDaemon = true }.also { it.start() }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start P2P UDP port 8767 server", e)
        }
    }

    private fun stopP2pServer() {
        try {
            p2pSocket?.close()
        } catch (_: Exception) {}
        try {
            p2pThread?.interrupt()
        } catch (_: Exception) {}
    }

    private fun isMaster(): Boolean {
        val masterUrl = state["screenClock_timeMasterUrl"]
        if (masterUrl.isNullOrEmpty()) return true
        val selfUrl = lanUrlProvider() ?: ""
        if (selfUrl.isNotEmpty() && masterUrl.startsWith(selfUrl)) return true
        if (masterUrl.contains("127.0.0.1") || masterUrl.contains("localhost")) return true
        return false
    }

    private fun getSelectedNtpServer(): String {
        val custom = state["screenClock_ntpServer"]
        return if (!custom.isNullOrBlank()) custom.trim() else "pool.ntp.org"
    }

    private fun extractHostFromUrl(url: String?): String? {
        if (url.isNullOrEmpty()) return null
        try {
            var clean = url.substringAfter("://").substringBefore("/")
            if (clean.contains(":")) {
                clean = clean.substringBefore(":")
            }
            return clean
        } catch (e: Exception) {
            Log.e(TAG, "Error parsing host from URL: $url", e)
        }
        return null
    }

    private fun performP2pSync(masterHost: String): Long? {
        var clientSocket: DatagramSocket? = null
        try {
            val address = InetAddress.getByName(masterHost)
            clientSocket = DatagramSocket().apply { soTimeout = 1000 }
            
            val t0 = System.currentTimeMillis()
            val requestJson = JSONObject().apply {
                put("type", "ping")
                put("t0", t0)
            }
            val requestBytes = requestJson.toString().toByteArray(Charsets.UTF_8)
            val requestPacket = DatagramPacket(requestBytes, requestBytes.size, address, 8767)
            clientSocket.send(requestPacket)
            
            val buffer = ByteArray(2048)
            val receivePacket = DatagramPacket(buffer, buffer.size)
            clientSocket.receive(receivePacket)
            val t3 = System.currentTimeMillis()
            
            val responseStr = String(receivePacket.data, 0, receivePacket.length, Charsets.UTF_8)
            val responseJson = JSONObject(responseStr)
            if (responseJson.optString("type") == "pong" && responseJson.optLong("t0") == t0) {
                val t1 = responseJson.getLong("t1")
                val t2 = responseJson.getLong("t2")
                
                var rtt = (t3 - t0) - (t2 - t1)
                if (rtt < 0) rtt = t3 - t0
                
                val offset = ((t1 - t0) + (t2 - t3)) / 2
                Log.d(TAG, "P2P sync successful. RTT: ${rtt}ms, Offset: ${offset}ms")
                return offset
            }
        } catch (e: Exception) {
            Log.w(TAG, "P2P sync to master $masterHost failed")
        } finally {
            clientSocket?.close()
        }
        return null
    }

    private fun startDynamicSyncScheduler() {
        syncExecutor.scheduleAtFixedRate({
            try {
                val now = System.currentTimeMillis()
                val masterUrl = state["screenClock_timeMasterUrl"]
                val isSelf = isMaster()
                
                if (isSelf) {
                    // MASTER MODE: Poll Upstream NTP
                    val interval = 30000L
                    if (now - lastNtpSyncTime >= interval) {
                        val ntpHost = getSelectedNtpServer()
                        val offset = SntpClient.getOffset(ntpHost)
                        if (offset != null) {
                            calculatedOffsetMs = offset
                            lastNtpSyncTime = now
                            Log.i(TAG, "NTP Sync successful. New offset: $calculatedOffsetMs ms")
                        } else {
                            lastNtpSyncTime = now - interval + 5000L // retry in 5s
                        }
                    }
                } else {
                    // SLAVE MODE: Query Master P2P
                    val interval = 5000L
                    if (now - lastP2pSyncTime >= interval) {
                        val host = extractHostFromUrl(masterUrl)
                        if (host != null) {
                            val offset = performP2pSync(host)
                            if (offset != null) {
                                calculatedOffsetMs = offset
                                lastP2pSyncTime = now
                                Log.i(TAG, "P2P Sync successful. New offset: $calculatedOffsetMs ms")
                            } else {
                                lastP2pSyncTime = now - interval + 2000L // retry in 2s
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Dynamic sync scheduler error", e)
            }
        }, 1, 1, TimeUnit.SECONDS)
    }

    // Root-level static assets (not under web/) that the server exposes directly.
    private val rootAssets = mapOf(
        "/remote-bridge.js" to ("remote-bridge.js" to "application/javascript"),
        "/qrcode.min.js" to ("qrcode.min.js" to "application/javascript")
    )

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri ?: "/"
        
        // CORS preflight requests
        if (session.method == Method.OPTIONS) {
            return newFixedLengthResponse(Response.Status.OK, "text/plain", "").apply {
                addHeader("Access-Control-Allow-Origin", "*")
                addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                addHeader("Access-Control-Allow-Headers", "Content-Type")
            }
        }

        val response = try {
            when {
                uri == "/api/clocks" && session.method == Method.GET -> handleGetClocks()
                uri == "/api/info" && session.method == Method.GET -> handleGetInfo()
                uri == "/api/time" && session.method == Method.GET -> handleGetTime()
                uri == "/api/state" && session.method == Method.GET -> handleGetState()
                uri == "/api/state" && session.method == Method.POST -> handlePostState(session)
                uri == "/api/wake" && session.method == Method.POST -> handlePostWake()
                uri == "/api/sleep" && session.method == Method.POST -> handlePostSleep()
                uri == "/api/battery-switch/state" && session.method == Method.GET -> handleBatterySwitchState(session)
                uri == "/api/battery-switch/on" && session.method == Method.POST -> handleBatterySwitchAction(session, "Power On", "ON")
                uri == "/api/battery-switch/off" && session.method == Method.POST -> handleBatterySwitchAction(session, "Power Off", "OFF")
                uri == "/api/events" && session.method == Method.GET -> handleSse()
                uri == "/api/url" && session.method == Method.GET -> handleGetUrl()
                rootAssets.containsKey(uri) -> {
                    val (assetPath, mime) = rootAssets.getValue(uri)
                    rootAssetResponse(assetPath, mime)
                }
                else -> serveAsset(uri)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "serve error for $uri", t)
            newFixedLengthResponse(
                Response.Status.INTERNAL_ERROR,
                "text/plain",
                t.message ?: "error"
            )
        }

        // Add CORS to any /api/ endpoint responses
        if (uri.startsWith("/api/")) {
            response.addHeader("Access-Control-Allow-Origin", "*")
            response.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            response.addHeader("Access-Control-Allow-Headers", "Content-Type")
        }
        return response
    }

    private fun handleGetClocks(): Response {
        val now = System.currentTimeMillis()
        val list = discoveredClocks.values.filter { now - it.lastSeen < 15000 }
        val array = JSONArray()
        for (clk in list) {
            val obj = JSONObject().apply {
                put("id", clk.id)
                put("name", clk.name)
                put("url", clk.url)
                put("isSelf", false)
                put("battery", clk.battery)
                put("milliWatts", clk.milliWatts)
                put("ipAddress", if (clk.ipAddress.isNotBlank()) clk.ipAddress else (parseHostFromUrl(clk.url) ?: ""))
                put("macAddress", normalizeMacAddress(clk.macAddress))
                put("isAsleep", clk.isAsleep)
            }
            array.put(obj)
        }
        val selfUrl = lanUrlProvider() ?: "http://127.0.0.1:$port/"
        val selfObj = JSONObject().apply {
            put("id", serverId)
            put("name", android.os.Build.MODEL + " (This Clock)")
            put("url", selfUrl)
            put("isSelf", true)
            put("battery", batteryLevelProvider())
            put("milliWatts", batteryMilliWattsProvider())
            put("ipAddress", parseHostFromUrl(selfUrl) ?: "")
            put("macAddress", normalizeMacAddress(macAddressProvider() ?: ""))
            put("isAsleep", isScreenAsleep)
        }
        array.put(selfObj)

        return newFixedLengthResponse(Response.Status.OK, "application/json", array.toString()).apply {
            addHeader("Cache-Control", "no-store")
        }
    }

    // ---------------- state ----------------

    private fun handleGetTime(): Response {
        val t1 = System.currentTimeMillis() + calculatedOffsetMs
        val json = JSONObject().apply {
            put("t1", t1)
            put("t2", System.currentTimeMillis() + calculatedOffsetMs)
            put("now", t1) // legacy field for older bridge versions
        }.toString()
        return newFixedLengthResponse(Response.Status.OK, "application/json", json).apply {
            addHeader("Cache-Control", "no-store")
        }
    }

    private fun parseHostFromUrl(url: String?): String? {
        if (url.isNullOrBlank()) return null
        return try {
            java.net.URI(url).host
        } catch (_: Exception) {
            null
        }
    }

    private fun normalizeMacAddress(raw: String): String {
        val normalized = raw.trim().replace('-', ':').uppercase()
        if (!Regex("^([0-9A-F]{2}:){5}[0-9A-F]{2}$").matches(normalized)) return ""
        if (normalized == "00:00:00:00:00:00") return ""
        return normalized
    }

    private fun resolveInfoIpAddress(): String {
        val fromLanUrl = parseHostFromUrl(lanUrlProvider())
        if (!fromLanUrl.isNullOrBlank()) return fromLanUrl

        try {
            val wm = context.applicationContext.getSystemService(android.content.Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
            @Suppress("DEPRECATION")
            val ipInt = wm?.connectionInfo?.ipAddress ?: 0
            if (ipInt != 0) {
                val b1 = ipInt and 0xff
                val b2 = ipInt shr 8 and 0xff
                val b3 = ipInt shr 16 and 0xff
                val b4 = ipInt shr 24 and 0xff
                val wifiIp = "$b1.$b2.$b3.$b4"
                if (wifiIp != "0.0.0.0") return wifiIp
            }
        } catch (_: Exception) {}

        return try {
            val interfaces = java.net.NetworkInterface.getNetworkInterfaces()
            val it = interfaces?.toList().orEmpty()
            val preferred = listOf("wlan0", "wifi0", "eth0")
            fun findIpFor(ifName: String): String? {
                val ni = it.firstOrNull { n ->
                    n != null && n.name.equals(ifName, ignoreCase = true) && n.isUp && !n.isLoopback
                } ?: return null
                return ni.inetAddresses
                    ?.toList()
                    ?.firstOrNull { a -> a is java.net.Inet4Address && !a.isLoopbackAddress }
                    ?.hostAddress
            }

            for (name in preferred) {
                val ip = findIpFor(name)
                if (!ip.isNullOrBlank()) return ip
            }

            it.asSequence()
                .filter { n -> n != null && n.isUp && !n.isLoopback }
                .flatMap { n -> n.inetAddresses?.toList().orEmpty().asSequence() }
                .firstOrNull { a -> a is java.net.Inet4Address && !a.isLoopbackAddress }
                ?.hostAddress
                ?: ""
        } catch (_: Exception) {
            ""
        }
    }

    private fun handleGetState(): Response {
        val json = JSONObject(state as Map<*, *>).toString()
        return newFixedLengthResponse(Response.Status.OK, "application/json", json).apply {
            addHeader("Cache-Control", "no-store")
        }
    }

    private fun handlePostState(session: IHTTPSession): Response {
        val files = HashMap<String, String>()
        session.parseBody(files)
        val raw = files["postData"] ?: session.parms["postData"] ?: ""
        val obj = JSONObject(raw)
        val key = obj.getString("key")
        val value: String? = if (obj.isNull("value")) null else obj.optString("value", "")
        if (value == null) state.remove(key) else state[key] = value

        if (key == "screenClock_timeMasterUrl" || key == "screenClock_ntpServer") {
            lastNtpSyncTime = 0L
            lastP2pSyncTime = 0L
        }
        if (key == "screenClock_state") {
            recordThresholdSnapshot(getBatterySettingsFromState(), System.currentTimeMillis())
        }

        broadcast(key, value)
        onStateChangedListener?.invoke(key, value)
        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}")
    }

    private fun clampPct(value: Int, fallback: Int): Int {
        return value.coerceIn(0, 100)
    }

    private fun getBatterySettingsFromState(): BatterySettings {
        val fallback = BatterySettings(false, "", 40, 85)
        return try {
            val raw = state["screenClock_state"] ?: return fallback
            val parsed = JSONObject(raw)
            val src = if (parsed.has("batterySettings")) parsed.optJSONObject("batterySettings") else null
            val enabled = src?.optBoolean("enabled", false) ?: false
            val switchIp = (src?.optString("switchIp", "") ?: "").trim()
            var thresholdOnPct = clampPct(src?.optInt("thresholdOnPct", 40) ?: 40, 40)
            val thresholdOffPct = clampPct(src?.optInt("thresholdOffPct", 85) ?: 85, 85)
            if (thresholdOnPct >= thresholdOffPct) thresholdOnPct = (thresholdOffPct - 1).coerceAtLeast(0)
            BatterySettings(enabled, switchIp, thresholdOnPct, thresholdOffPct)
        } catch (_: Exception) {
            fallback
        }
    }

    private fun trimBatteryHistory(nowMs: Long = System.currentTimeMillis()) {
        val cutoff = nowMs - batteryRetentionMs
        val filtered = batteryHistory.filter { it.timestampMs >= cutoff }.sortedBy { it.timestampMs }
        batteryHistory.clear()
        val keep = if (filtered.size > batteryMaxPoints) filtered.takeLast(batteryMaxPoints) else filtered
        batteryHistory.addAll(keep)
    }

    private fun trimThresholdHistory(nowMs: Long = System.currentTimeMillis()) {
        val cutoff = nowMs - batteryRetentionMs
        val sorted = thresholdHistory.sortedBy { it.timestampMs }
        if (sorted.isEmpty()) return
        var firstIdx = sorted.indexOfFirst { it.timestampMs >= cutoff }
        if (firstIdx < 0) firstIdx = sorted.size - 1
        val keepFrom = (firstIdx - 1).coerceAtLeast(0)
        thresholdHistory.clear()
        thresholdHistory.addAll(sorted.subList(keepFrom, sorted.size))
    }

    private fun trimSwitchStateHistory(nowMs: Long = System.currentTimeMillis()) {
        val cutoff = nowMs - batteryRetentionMs
        val sorted = switchStateHistory.filter { it.timestampMs >= cutoff }.sortedBy { it.timestampMs }
        if (sorted.isEmpty()) {
            switchStateHistory.clear()
            return
        }
        var keepFrom = 0
        val firstInWindow = sorted.indexOfFirst { it.timestampMs >= cutoff }
        if (firstInWindow > 0) keepFrom = firstInWindow - 1
        switchStateHistory.clear()
        switchStateHistory.addAll(sorted.subList(keepFrom, sorted.size))
    }

    private fun loadBatteryHistory() {
        try {
            if (!batteryFile.exists()) return
            val arr = JSONArray(batteryFile.readText())
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                batteryHistory.add(BatteryPoint(obj.getLong("ts"), obj.getInt("battery")))
            }
            trimBatteryHistory()
        } catch (e: Exception) {
            Log.w(TAG, "Could not load battery history", e)
        }
    }

    private fun saveBatteryHistory() {
        try {
            trimBatteryHistory()
            val arr = JSONArray()
            batteryHistory.sortedBy { it.timestampMs }.forEach { p ->
                arr.put(JSONObject().put("ts", p.timestampMs).put("battery", p.batteryPct))
            }
            batteryFile.writeText(arr.toString())
        } catch (e: Exception) {
            Log.w(TAG, "Could not save battery history", e)
        }
    }

    private fun loadThresholdHistory() {
        try {
            if (!thresholdFile.exists()) return
            val arr = JSONArray(thresholdFile.readText())
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                thresholdHistory.add(
                    ThresholdPoint(
                        obj.getLong("ts"),
                        obj.getInt("thresholdOnPct"),
                        obj.getInt("thresholdOffPct")
                    )
                )
            }
            trimThresholdHistory()
        } catch (e: Exception) {
            Log.w(TAG, "Could not load threshold history", e)
        }
    }

    private fun loadSwitchStateHistory() {
        try {
            if (!switchStateFile.exists()) return
            val arr = JSONArray(switchStateFile.readText())
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                switchStateHistory.add(SwitchStatePoint(obj.getLong("ts"), if (obj.optInt("on", 0) != 0) 1 else 0))
            }
            trimSwitchStateHistory()
        } catch (e: Exception) {
            Log.w(TAG, "Could not load switch state history", e)
        }
    }

    private fun saveThresholdHistory() {
        try {
            trimThresholdHistory()
            val arr = JSONArray()
            thresholdHistory.sortedBy { it.timestampMs }.forEach { p ->
                arr.put(
                    JSONObject()
                        .put("ts", p.timestampMs)
                        .put("thresholdOnPct", p.thresholdOnPct)
                        .put("thresholdOffPct", p.thresholdOffPct)
                )
            }
            thresholdFile.writeText(arr.toString())
        } catch (e: Exception) {
            Log.w(TAG, "Could not save threshold history", e)
        }
    }

    private fun saveSwitchStateHistory() {
        try {
            trimSwitchStateHistory()
            val arr = JSONArray()
            switchStateHistory.sortedBy { it.timestampMs }.forEach { p ->
                arr.put(JSONObject().put("ts", p.timestampMs).put("on", p.on))
            }
            switchStateFile.writeText(arr.toString())
        } catch (e: Exception) {
            Log.w(TAG, "Could not save switch state history", e)
        }
    }

    private fun recordSwitchState(power: String?, nowMs: Long = System.currentTimeMillis()) {
        val on = if ((power ?: "").uppercase() == "ON") 1 else 0
        val prev = switchStateHistory.lastOrNull()
        if (prev != null && prev.on == on) return
        switchStateHistory.add(SwitchStatePoint(nowMs, on))
        saveSwitchStateHistory()
    }

    private fun sampleSelfBattery(nowMs: Long = System.currentTimeMillis()) {
        val level = batteryLevelProvider()
        if (level < 0) return
        val bucket = (nowMs / batteryBucketMs) * batteryBucketMs
        if (bucket == lastBatterySampleBucketMs) return
        lastBatterySampleBucketMs = bucket
        batteryHistory.add(BatteryPoint(bucket, clampPct(level, 0)))
        saveBatteryHistory()
    }

    private fun recordThresholdSnapshot(settings: BatterySettings, nowMs: Long = System.currentTimeMillis()) {
        val next = ThresholdPoint(nowMs, settings.thresholdOnPct, settings.thresholdOffPct)
        val prev = thresholdHistory.lastOrNull()
        if (prev != null && prev.thresholdOnPct == next.thresholdOnPct && prev.thresholdOffPct == next.thresholdOffPct) {
            return
        }
        thresholdHistory.add(next)
        saveThresholdHistory()
    }

    private fun normalizeSwitchHost(input: String): String {
        val raw = input.trim()
        if (raw.isEmpty()) return ""
        return try {
            val full = if (raw.startsWith("http://") || raw.startsWith("https://")) raw else "http://$raw"
            val uri = java.net.URI(full)
            if (uri.port > 0) "${uri.host}:${uri.port}" else (uri.host ?: raw)
        } catch (_: Exception) {
            raw.removePrefix("http://").removePrefix("https://").trimEnd('/')
        }
    }

    private fun tasmotaCommand(hostInput: String, command: String): JSONObject {
        val host = normalizeSwitchHost(hostInput)
        if (host.isBlank()) throw IllegalArgumentException("Missing switch host")
        val encoded = java.net.URLEncoder.encode(command, "UTF-8")
        val url = URL("http://$host/cm?cmnd=$encoded")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 4000
            readTimeout = 4000
        }
        return try {
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            try {
                JSONObject(body)
            } catch (_: Exception) {
                JSONObject().put("raw", body)
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun normalizedPower(payload: JSONObject?): String? {
        if (payload == null) return null
        val any = when {
            payload.has("POWER") -> payload.opt("POWER")
            payload.has("Power") -> payload.opt("Power")
            payload.has("power") -> payload.opt("power")
            else -> null
        }
        return when (any) {
            is String -> when (any.uppercase()) {
                "ON" -> "ON"
                "OFF" -> "OFF"
                else -> null
            }
            is Number -> if (any.toInt() == 0) "OFF" else "ON"
            is Boolean -> if (any) "ON" else "OFF"
            else -> null
        }
    }

    private fun evaluateBatteryAutomation() {
        val settings = getBatterySettingsFromState()
        recordThresholdSnapshot(settings, System.currentTimeMillis())
        if (!settings.enabled || settings.switchIp.isBlank()) return
        val battery = batteryLevelProvider()
        if (battery < 0) return
        val desiredAction = when {
            battery >= settings.thresholdOffPct -> "off"
            battery <= settings.thresholdOnPct -> "on"
            else -> ""
        }
        if (desiredAction.isBlank()) return

        val now = System.currentTimeMillis()
        if (desiredAction == lastAutomationAction && now - lastAutomationActionAtMs < minAutomationActionIntervalMs) {
            return
        }
        try {
            val raw = tasmotaCommand(settings.switchIp, if (desiredAction == "on") "Power On" else "Power Off")
            val power = normalizedPower(raw) ?: if (desiredAction == "on") "ON" else "OFF"
            recordSwitchState(power)
            lastAutomationAction = desiredAction
            lastAutomationActionAtMs = now
        } catch (e: Exception) {
            Log.w(TAG, "Battery automation command failed", e)
        }
    }

    private fun parseBatterySwitchIp(session: IHTTPSession): String {
        return session.parms["ip"]?.trim().orEmpty().ifBlank {
            try {
                val files = HashMap<String, String>()
                session.parseBody(files)
                val raw = files["postData"] ?: session.parms["postData"] ?: ""
                if (raw.isBlank()) "" else JSONObject(raw).optString("ip", "").trim()
            } catch (_: Exception) {
                ""
            }
        }
    }

    private fun handleBatterySwitchState(session: IHTTPSession): Response {
        val host = parseBatterySwitchIp(session)
        if (host.isBlank()) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, "application/json", JSONObject().put("ok", false).put("error", "Missing ip").toString())
        }
        return try {
            val raw = tasmotaCommand(host, "Power")
            val power = normalizedPower(raw)
            if (power != null) recordSwitchState(power)
            val out = JSONObject().put("ok", true).put("power", power).put("raw", raw)
            newFixedLengthResponse(Response.Status.OK, "application/json", out.toString())
        } catch (e: Exception) {
            val out = JSONObject().put("ok", false).put("error", e.message ?: "Switch query failed")
            newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json", out.toString())
        }
    }

    private fun handleBatterySwitchAction(session: IHTTPSession, command: String, fallbackPower: String): Response {
        val host = parseBatterySwitchIp(session)
        if (host.isBlank()) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, "application/json", JSONObject().put("ok", false).put("error", "Missing ip").toString())
        }
        return try {
            val raw = tasmotaCommand(host, command)
            val power = normalizedPower(raw) ?: fallbackPower
            recordSwitchState(power)
            val out = JSONObject().put("ok", true).put("power", power).put("raw", raw)
            newFixedLengthResponse(Response.Status.OK, "application/json", out.toString())
        } catch (e: Exception) {
            val out = JSONObject().put("ok", false).put("error", e.message ?: "Switch command failed")
            newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json", out.toString())
        }
    }

    private fun handlePostWake(): Response {
        broadcastClocksUpdate()
        onWakeRequestedListener?.invoke()
        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}").apply {
            addHeader("Cache-Control", "no-store")
        }
    }

    private fun handlePostSleep(): Response {
        broadcastClocksUpdate()
        onSleepRequestedListener?.invoke()
        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}").apply {
            addHeader("Cache-Control", "no-store")
        }
    }

    // ---------------- URL ----------------

    private fun handleGetUrl(): Response {
        val url = lanUrlProvider() ?: "http://127.0.0.1:$port/"
        val json = JSONObject().put("url", url).toString()
        return newFixedLengthResponse(Response.Status.OK, "application/json", json).apply {
            addHeader("Cache-Control", "no-store")
        }
    }

    // ---------------- SSE ----------------

    /**
     * Streams server-sent events to a single client. Backed by a
     * LinkedBlockingQueue so that writes from arbitrary request threads can
     * be safely funnelled into a single chunked HTTP response without the
     * "Write end dead" pitfalls of PipedInputStream/PipedOutputStream.
     */
    private class SseClient : InputStream() {
        private val queue = LinkedBlockingQueue<ByteArray>()
        private var current: ByteArray? = null
        private var pos = 0
        @Volatile private var closed = false

        fun offer(data: ByteArray) {
            if (closed || data.isEmpty()) return
            queue.offer(data)
        }

        private fun ensureChunk(): Boolean {
            while (current == null || pos >= (current?.size ?: 0)) {
                if (closed && queue.isEmpty()) return false
                val next = try {
                    queue.poll(30, TimeUnit.SECONDS)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return false
                } ?: continue
                current = next
                pos = 0
            }
            return true
        }

        override fun read(): Int {
            if (!ensureChunk()) return -1
            val buf = current!!
            val b = buf[pos].toInt() and 0xFF
            pos++
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            if (!ensureChunk()) return -1
            val buf = current!!
            val n = minOf(len, buf.size - pos)
            System.arraycopy(buf, pos, b, off, n)
            pos += n
            return n
        }

        override fun close() {
            closed = true
            queue.offer(ByteArray(0)) // unblock any pending poll
        }
    }

    private fun handleSse(): Response {
        val client = SseClient()
        sseClients.add(client)

        // Opening comment + initial snapshot.
        client.offer(": connected\n\n".toByteArray())
        val snapshot = JSONObject(state as Map<*, *>).toString()
        client.offer("event: snapshot\ndata: $snapshot\n\n".toByteArray())

        val r = newChunkedResponse(Response.Status.OK, "text/event-stream", client)
        r.addHeader("Cache-Control", "no-cache")
        r.addHeader("Connection", "keep-alive")
        r.addHeader("X-Accel-Buffering", "no")
        return r
    }

    private fun broadcast(key: String, value: String?) {
        val payload = JSONObject().apply {
            put("key", key)
            if (value == null) put("value", JSONObject.NULL) else put("value", value)
        }.toString()
        val bytes = "event: state\ndata: $payload\n\n".toByteArray()
        for (c in sseClients) c.offer(bytes)
    }

    private fun broadcastClocksUpdate() {
        val bytes = "event: clocks\ndata: \n\n".toByteArray()
        for (c in sseClients) c.offer(bytes)
    }

    override fun stop() {
        stopUdpDiscovery()
        stopP2pServer()
        try { syncExecutor.shutdownNow() } catch (_: Exception) {}
        try { heartbeat.shutdownNow() } catch (_: Exception) {}
        for (c in sseClients) try { c.close() } catch (_: IOException) {}
        sseClients.clear()
        super.stop()
    }

    // ---------------- assets ----------------

    private fun serveAsset(uriIn: String): Response {
        val path = if (uriIn == "/" || uriIn.isEmpty()) "/index.html" else uriIn
        val assetPath = "web$path"

        // Inject bridge into the main page.
        if (path == "/index.html") {
            val bytes = readAsset(assetPath)
                ?: return newFixedLengthResponse(
                    Response.Status.NOT_FOUND, "text/plain", "not found: $assetPath"
                )
            val injected = String(bytes, Charsets.UTF_8).replace(
                "</head>",
                "<script src=\"/qrcode.min.js\"></script>" +
                    "<script src=\"/remote-bridge.js\"></script></head>"
            )
            return newFixedLengthResponse(
                Response.Status.OK, "text/html; charset=utf-8", injected
            ).apply { addHeader("Cache-Control", "no-store") }
        }

        return try {
            val ins = context.assets.open(assetPath)
            newChunkedResponse(Response.Status.OK, mimeFor(path), ins)
        } catch (e: IOException) {
            newFixedLengthResponse(
                Response.Status.NOT_FOUND, "text/plain", "not found: $assetPath"
            )
        }
    }

    private fun rootAssetResponse(assetPath: String, mime: String): Response {
        val bytes = readAsset(assetPath)
            ?: return newFixedLengthResponse(
                Response.Status.NOT_FOUND, "text/plain", "missing $assetPath"
            )
        return newFixedLengthResponse(
            Response.Status.OK, mime, String(bytes, Charsets.UTF_8)
        ).apply { addHeader("Cache-Control", "no-store") }
    }

    private fun readAsset(assetPath: String): ByteArray? = try {
        context.assets.open(assetPath).use { it.readBytes() }
    } catch (e: IOException) {
        null
    }

    private fun mimeFor(path: String): String = when {
        path.endsWith(".html") -> "text/html; charset=utf-8"
        path.endsWith(".css") -> "text/css"
        path.endsWith(".js") || path.endsWith(".mjs") -> "application/javascript"
        path.endsWith(".json") -> "application/json"
        path.endsWith(".svg") -> "image/svg+xml"
        path.endsWith(".png") -> "image/png"
        path.endsWith(".jpg") || path.endsWith(".jpeg") -> "image/jpeg"
        path.endsWith(".gif") -> "image/gif"
        path.endsWith(".woff") -> "font/woff"
        path.endsWith(".woff2") -> "font/woff2"
        path.endsWith(".ttf") -> "font/ttf"
        path.endsWith(".otf") -> "font/otf"
        path.endsWith(".eot") -> "application/vnd.ms-fontobject"
        else -> "application/octet-stream"
    }

    private enum class ActivityType { APP, SCREEN }
    private data class ActivityEvent(val timestampMs: Long, val isActive: Boolean, val type: ActivityType)

    fun notifyAppResumed() {
        activityEvents.add(ActivityEvent(System.currentTimeMillis(), true, ActivityType.APP))
        trimActivityEvents()
        saveActivityEventsAsync()
    }

    fun notifyAppPaused() {
        activityEvents.add(ActivityEvent(System.currentTimeMillis(), false, ActivityType.APP))
        trimActivityEvents()
        saveActivityEventsAsync()
    }

    private fun lastActivityTimestamp(type: ActivityType, active: Boolean): Long? {
        return activityEvents.toList().asReversed().firstOrNull { it.type == type && it.isActive == active }?.timestampMs
    }

    private fun loadActivityEvents() {
        try {
            if (!activityFile.exists()) return
            val arr = JSONArray(activityFile.readText())
            val cutoff = System.currentTimeMillis() - 7L * 24 * 3600 * 1000
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val ts = obj.getLong("ts")
                if (ts < cutoff - 3_600_000L) continue // skip events older than 7d+1h
                val type = try { ActivityType.valueOf(obj.getString("type")) } catch (e: Exception) { ActivityType.SCREEN }
                activityEvents.add(ActivityEvent(ts, obj.getBoolean("active"), type))
            }
            Log.i(TAG, "Loaded ${activityEvents.size} activity events from disk")
        } catch (e: Exception) { Log.w(TAG, "Could not load activity events", e) }
    }

    private fun saveActivityEvents() {
        try {
            val arr = JSONArray()
            activityEvents.toList().forEach { ev ->
                arr.put(JSONObject().put("ts", ev.timestampMs).put("active", ev.isActive).put("type", ev.type.name))
            }
            activityFile.writeText(arr.toString())
        } catch (e: Exception) { Log.w(TAG, "Could not save activity events", e) }
    }

    private fun saveActivityEventsAsync() { heartbeat.execute { saveActivityEvents() } }

    private fun trimActivityEvents() {
        val cutoff = System.currentTimeMillis() - 7L * 24 * 3600 * 1000
        val snapshot = activityEvents.toList()
        // Keep one anchor event per type before the cutoff for continuity
        val appAnchor = snapshot.indexOfLast { it.type == ActivityType.APP && it.timestampMs <= cutoff }
        val screenAnchor = snapshot.indexOfLast { it.type == ActivityType.SCREEN && it.timestampMs <= cutoff }
        val keepFrom = maxOf(0, minOf(
            if (appAnchor > 0) appAnchor else Int.MAX_VALUE,
            if (screenAnchor > 0) screenAnchor else Int.MAX_VALUE
        ))
        if (keepFrom > 0 && keepFrom != Int.MAX_VALUE) activityEvents.subList(0, keepFrom).clear()
    }

    private fun computeActiveFraction(bucketStart: Long, bucketEnd: Long, type: ActivityType): Double {
        val events = activityEvents.filter { it.type == type }
        if (events.isEmpty()) return 0.0
        var stateAtStart = false
        for (ev in events) { if (ev.timestampMs <= bucketStart) stateAtStart = ev.isActive else break }
        var segStart = bucketStart; var currentState = stateAtStart; var activeDuration = 0L
        for (ev in events) {
            if (ev.timestampMs <= bucketStart) continue
            if (ev.timestampMs >= bucketEnd) break
            if (currentState) activeDuration += ev.timestampMs - segStart
            segStart = ev.timestampMs; currentState = ev.isActive
        }
        if (currentState) activeDuration += bucketEnd - segStart
        return activeDuration.toDouble() / (bucketEnd - bucketStart)
    }

    private fun buildBatterySeries(bucketZeroMs: Long, bucketCount: Int, bucketMs: Long): List<Int?> {
        val points = batteryHistory.sortedBy { it.timestampMs }
        if (points.isEmpty()) return List(bucketCount) { null }
        val out = MutableList<Int?>(bucketCount) { null }
        var idx = 0
        var last: Int? = null
        while (idx < points.size && points[idx].timestampMs < bucketZeroMs) {
            last = points[idx].batteryPct
            idx++
        }
        for (i in 0 until bucketCount) {
            val t = bucketZeroMs + i * bucketMs
            while (idx < points.size && points[idx].timestampMs <= t) {
                last = points[idx].batteryPct
                idx++
            }
            out[i] = last
        }
        return out
    }

    private fun buildThresholdSeries(bucketZeroMs: Long, bucketCount: Int, bucketMs: Long, useOn: Boolean, fallback: Int): List<Int> {
        val points = thresholdHistory.sortedBy { it.timestampMs }
        val out = MutableList(bucketCount) { fallback }
        var idx = 0
        var last = fallback
        while (idx < points.size && points[idx].timestampMs < bucketZeroMs) {
            last = if (useOn) points[idx].thresholdOnPct else points[idx].thresholdOffPct
            idx++
        }
        for (i in 0 until bucketCount) {
            val t = bucketZeroMs + i * bucketMs
            while (idx < points.size && points[idx].timestampMs <= t) {
                last = if (useOn) points[idx].thresholdOnPct else points[idx].thresholdOffPct
                idx++
            }
            out[i] = last
        }
        return out
    }

    private fun buildSwitchSeries(bucketZeroMs: Long, bucketCount: Int, bucketMs: Long): List<Int> {
        val points = switchStateHistory.sortedBy { it.timestampMs }
        val out = MutableList(bucketCount) { 0 }
        if (points.isEmpty()) return out
        var idx = 0
        var last = 0
        while (idx < points.size && points[idx].timestampMs < bucketZeroMs) {
            last = if (points[idx].on != 0) 1 else 0
            idx++
        }
        for (i in 0 until bucketCount) {
            val t = bucketZeroMs + i * bucketMs
            while (idx < points.size && points[idx].timestampMs <= t) {
                last = if (points[idx].on != 0) 1 else 0
                idx++
            }
            out[i] = last
        }
        return out
    }

    private fun handleGetInfo(): Response {
        val now = System.currentTimeMillis()
        val infoIpAddress = resolveInfoIpAddress()
        val infoMacAddress = normalizeMacAddress(macAddressProvider() ?: "")
        val nowAppActive = activityEvents.filter { it.type == ActivityType.APP }.maxByOrNull { it.timestampMs }?.isActive ?: true
        val nowScreenAwake = !isScreenAsleep
        val powerManager = context.getSystemService(android.content.Context.POWER_SERVICE) as? android.os.PowerManager
        val batteryOptimizationIgnored = powerManager?.isIgnoringBatteryOptimizations(context.packageName) == true
        val lastAppResumeMs = lastActivityTimestamp(ActivityType.APP, true)
        val lastAppPauseMs = lastActivityTimestamp(ActivityType.APP, false)
        val lastScreenOnMs = lastActivityTimestamp(ActivityType.SCREEN, true)
        val lastScreenOffMs = lastActivityTimestamp(ActivityType.SCREEN, false)
        val bucketMs = batteryBucketMs
        val bucketCount = batteryMaxPoints
        val bucketZero = now - (bucketCount - 1) * bucketMs
        val appActive = (0 until bucketCount).map { i ->
            val bs = bucketZero + i * bucketMs
            computeActiveFraction(bs, bs + bucketMs, ActivityType.APP)
        }
        val screenAwake = (0 until bucketCount).map { i ->
            val bs = bucketZero + i * bucketMs
            computeActiveFraction(bs, bs + bucketMs, ActivityType.SCREEN)
        }
        val settings = getBatterySettingsFromState()
        sampleSelfBattery(now)
        recordThresholdSnapshot(settings, now)
        val battery = buildBatterySeries(bucketZero, bucketCount, bucketMs)
        val thresholdOn = buildThresholdSeries(bucketZero, bucketCount, bucketMs, true, settings.thresholdOnPct)
        val thresholdOff = buildThresholdSeries(bucketZero, bucketCount, bucketMs, false, settings.thresholdOffPct)
        val switchOn = buildSwitchSeries(bucketZero, bucketCount, bucketMs)
        val buildInfo = try {
            val bytes = context.assets.open("build_info.json").readBytes()
            JSONObject(String(bytes, Charsets.UTF_8))
        } catch (e: Exception) { JSONObject() }
        val buildTimeRaw = buildInfo.optString("buildTime", "unknown")
        val buildTimeDisplay = try {
            val parser = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
                .also { it.timeZone = java.util.TimeZone.getTimeZone("UTC") }
            val fmt = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US)
            val parsed = parser.parse(buildTimeRaw)
            if (parsed != null) fmt.format(parsed) else buildTimeRaw
        } catch (e: Exception) { buildTimeRaw }
        val uptimeMs = android.os.SystemClock.elapsedRealtime()
        fun fmtUptime(ms: Long): String {
            val totalS = ms / 1000; val m = totalS / 60 % 60; val h = totalS / 3600 % 24; val d = totalS / 86400
            return if (d > 0) "${d}d ${h}h ${m}m" else if (h > 0) "${h}h ${m}m" else "${m}m ${totalS % 60}s"
        }
        fun fmtAgo(timestampMs: Long?): String {
            if (timestampMs == null) return "never"
            val deltaMs = (now - timestampMs).coerceAtLeast(0L)
            val totalS = deltaMs / 1000
            val m = totalS / 60 % 60
            val h = totalS / 3600 % 24
            val d = totalS / 86400
            return if (d > 0) "${d}d ${h}h ${m}m ago" else if (h > 0) "${h}h ${m}m ago" else if (m > 0) "${m}m ${totalS % 60}s ago" else "${totalS % 60}s ago"
        }
        val deviceId = android.provider.Settings.Secure.getString(
            context.contentResolver, android.provider.Settings.Secure.ANDROID_ID)
        val serial = if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q) {
            try { android.os.Build.getSerial() } catch (e: Exception) { "-" }
        } else { "-" }
        val attrs = JSONArray().apply {
            fun row(label: String, value: String) = put(JSONObject().put("label", label).put("value", value))
            val dm = android.util.DisplayMetrics().also {
                (context.getSystemService(android.content.Context.WINDOW_SERVICE) as android.view.WindowManager)
                    .defaultDisplay.getRealMetrics(it)
            }
            row("Brand / Model", "${android.os.Build.BRAND}  /  ${android.os.Build.MODEL}")
            row("OS", "Android ${android.os.Build.VERSION.RELEASE}")
            row("IP Address", if (infoIpAddress.isNotBlank()) infoIpAddress else "-")
            row("MAC Address", if (infoMacAddress.isNotBlank()) infoMacAddress else "-")
            row("Resolution (w \u00d7 h)", "${dm.widthPixels} \u00d7 ${dm.heightPixels}")
            row("Density (DPI)", "${dm.densityDpi}")
            row("Serial", serial)
            row("Android ID", deviceId ?: "unknown")
            row("Build", buildTimeDisplay)
            row("Git commit", buildInfo.optString("gitCommit", "unknown"))
            row("Uptime", fmtUptime(uptimeMs))
            row("App uptime", fmtUptime(System.currentTimeMillis() - serverStartMs))
            row("Battery optimization", if (batteryOptimizationIgnored) "ignored" else "not ignored")
            row("Wi-Fi lock", if (wifiLockHeldProvider()) "held" else "not held")
            row("Last app resume", fmtAgo(lastAppResumeMs))
            row("Last app pause", fmtAgo(lastAppPauseMs))
            row("Last screen on", fmtAgo(lastScreenOnMs))
            row("Last screen off", fmtAgo(lastScreenOffMs))
            // Battery temperature
            val battIntent = context.registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
            val tempTenths = battIntent?.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE) ?: Int.MIN_VALUE
            if (tempTenths != Int.MIN_VALUE) row("Battery temp", "%.1f \u00b0C".format(tempTenths / 10f))
            // RAM
            val am = context.getSystemService(android.content.Context.ACTIVITY_SERVICE) as android.app.ActivityManager
            val mi = android.app.ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
            val usedMb = (mi.totalMem - mi.availMem) / 1_048_576L
            val totalMb = mi.totalMem / 1_048_576L
            row("RAM used / total", "$usedMb / $totalMb MB")
            // Wi-Fi RSSI
            val wm = context.applicationContext.getSystemService(android.content.Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
            @Suppress("DEPRECATION") val rssi = wm?.connectionInfo?.rssi
            if (rssi != null && rssi != -127) {
                val bars = android.net.wifi.WifiManager.calculateSignalLevel(rssi, 5)
                row("Wi-Fi signal", "$rssi dBm  ($bars/4 bars)")
            }
        }
        val json = JSONObject().apply {
            put("attrs", attrs)
            put("serverStartMs", serverStartMs)
            put("nowMs", now)
            put("power", JSONObject().apply {
                put("batteryOptimizationIgnored", batteryOptimizationIgnored)
                put("wifiLockHeld", wifiLockHeldProvider())
                put("appActive", nowAppActive)
                put("screenAwake", nowScreenAwake)
                put("lastAppResumeMs", lastAppResumeMs ?: JSONObject.NULL)
                put("lastAppPauseMs", lastAppPauseMs ?: JSONObject.NULL)
                put("lastScreenOnMs", lastScreenOnMs ?: JSONObject.NULL)
                put("lastScreenOffMs", lastScreenOffMs ?: JSONObject.NULL)
            })
            put("chart", JSONObject().apply {
                put("bucketMs", bucketMs)
                put("bucketZeroMs", bucketZero)
                put("appActive", JSONArray(appActive))
                put("screenAwake", JSONArray(screenAwake))
                put("battery", JSONArray(battery))
                put("thresholdOn", JSONArray(thresholdOn))
                put("thresholdOff", JSONArray(thresholdOff))
                put("switchOn", JSONArray(switchOn))
                put("nowBattery", batteryLevelProvider())
                put("nowThresholdOn", settings.thresholdOnPct)
                put("nowThresholdOff", settings.thresholdOffPct)
                put("nowAppActive", nowAppActive)
                put("nowScreenAwake", nowScreenAwake)
            })
        }
        return newFixedLengthResponse(Response.Status.OK, "application/json", json.toString()).apply {
            addHeader("Cache-Control", "no-store")
        }
    }

    companion object {
        private const val TAG = "ClockServer"
    }
}

object SntpClient {
    private const val NTP_PORT = 123
    private const val NTP_PACKET_SIZE = 48
    private const val OFFSET_1900_TO_1970 = 2208988800L
    private const val TAG = "SntpClient"

    fun getOffset(host: String, timeoutMs: Int = 3000): Long? {
        var socket: DatagramSocket? = null
        try {
            socket = DatagramSocket().apply { soTimeout = timeoutMs }
            val address = InetAddress.getByName(host)
            val buffer = ByteArray(NTP_PACKET_SIZE)
            
            // Set LI = 0, VN = 3, Mode = 3 (Client)
            buffer[0] = 0x1B
            
            val t0 = System.currentTimeMillis()
            writeTimestamp(buffer, 40, t0) // Transmit timestamp
            
            val packet = DatagramPacket(buffer, buffer.size, address, NTP_PORT)
            socket.send(packet)
            
            val responsePacket = DatagramPacket(buffer, buffer.size)
            socket.receive(responsePacket)
            val t3 = System.currentTimeMillis()
            
            val t1 = readTimestamp(buffer, 32)
            val t2 = readTimestamp(buffer, 40)
            
            // Calculate RTT: (t3 - t0) - (t2 - t1)
            var rtt = (t3 - t0) - (t2 - t1)
            if (rtt < 0) rtt = t3 - t0
            
            val offset = ((t1 - t0) + (t2 - t3)) / 2
            Log.i(TAG, "NTP synchronization complete. RTT: ${rtt}ms, Offset: ${offset}ms")
            return offset
        } catch (e: Exception) {
            Log.w(TAG, "NTP sync to $host failed: ${e.message}")
            return null
        } finally {
            socket?.close()
        }
    }

    private fun writeTimestamp(buffer: ByteArray, offset: Int, timeMs: Long) {
        val seconds = timeMs / 1000L + OFFSET_1900_TO_1970
        val ms = timeMs % 1000L
        val fraction = (ms * 0x100000000L / 1000L)
        
        // Write seconds
        buffer[offset] = (seconds shr 24).toByte()
        buffer[offset + 1] = (seconds shr 16).toByte()
        buffer[offset + 2] = (seconds shr 8).toByte()
        buffer[offset + 3] = seconds.toByte()
        
        // Write fraction
        buffer[offset + 4] = (fraction shr 24).toByte()
        buffer[offset + 5] = (fraction shr 16).toByte()
        buffer[offset + 6] = (fraction shr 8).toByte()
        buffer[offset + 7] = fraction.toByte()
    }

    private fun readTimestamp(buffer: ByteArray, offset: Int): Long {
        val s0 = buffer[offset].toLong() and 0xFF
        val s1 = buffer[offset + 1].toLong() and 0xFF
        val s2 = buffer[offset + 2].toLong() and 0xFF
        val s3 = buffer[offset + 3].toLong() and 0xFF
        val seconds = (s0 shl 24) or (s1 shl 16) or (s2 shl 8) or s3

        val f0 = buffer[offset + 4].toLong() and 0xFF
        val f1 = buffer[offset + 5].toLong() and 0xFF
        val f2 = buffer[offset + 6].toLong() and 0xFF
        val f3 = buffer[offset + 7].toLong() and 0xFF
        val fraction = (f0 shl 24) or (f1 shl 16) or (f2 shl 8) or f3

        val ms = (fraction * 1000L) shr 32
        return (seconds - OFFSET_1900_TO_1970) * 1000L + ms
    }
}
