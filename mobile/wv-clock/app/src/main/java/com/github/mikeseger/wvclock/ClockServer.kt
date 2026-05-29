package com.github.mikeseger.wvclock

import android.content.Context
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
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
    private val batteryLevelProvider: () -> Int = { -1 }
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
        val isAsleep: Boolean = false
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
                broadcastClocksUpdate()
            }
        }

    private var p2pSocket: DatagramSocket? = null
    private var p2pThread: Thread? = null

    private var lastNtpSyncTime = 0L
    private var lastP2pSyncTime = 0L
    private val syncExecutor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "wv-clock-dynamic-sync").apply { isDaemon = true }
    }

    init {
        heartbeat.scheduleAtFixedRate({
            val bytes = ": ping\n\n".toByteArray()
            for (c in sseClients) c.offer(bytes)
        }, 15, 15, TimeUnit.SECONDS)
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
                                val isAsleep = if (obj.has("isAsleep")) obj.getBoolean("isAsleep") else false
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
                                    isAsleep = isAsleep
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
                uri == "/api/time" && session.method == Method.GET -> handleGetTime()
                uri == "/api/state" && session.method == Method.GET -> handleGetState()
                uri == "/api/state" && session.method == Method.POST -> handlePostState(session)
                uri == "/api/wake" && session.method == Method.POST -> handlePostWake()
                uri == "/api/sleep" && session.method == Method.POST -> handlePostSleep()
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

        broadcast(key, value)
        onStateChangedListener?.invoke(key, value)
        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}")
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
