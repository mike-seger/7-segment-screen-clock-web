package com.github.mikeseger.wvclock

import android.content.Context
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
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
    private val lanUrlProvider: () -> String?
) : NanoHTTPD(port) {

    // Last-known persisted state (mirrors localStorage keys that begin with screenClock_).
    private val state = ConcurrentHashMap<String, String>()

    // Open SSE subscribers.
    private val sseClients = CopyOnWriteArrayList<SseClient>()

    // Background scheduler for SSE heartbeats.
    private val heartbeat = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "wv-clock-sse-heartbeat").apply { isDaemon = true }
    }

    init {
        heartbeat.scheduleAtFixedRate({
            val bytes = ": ping\n\n".toByteArray()
            for (c in sseClients) c.offer(bytes)
        }, 15, 15, TimeUnit.SECONDS)
    }

    // Root-level static assets (not under web/) that the server exposes directly.
    private val rootAssets = mapOf(
        "/remote-bridge.js" to ("remote-bridge.js" to "application/javascript"),
        "/qrcode.min.js" to ("qrcode.min.js" to "application/javascript")
    )

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri ?: "/"
        return try {
            when {
                uri == "/api/state" && session.method == Method.GET -> handleGetState()
                uri == "/api/state" && session.method == Method.POST -> handlePostState(session)
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
    }

    // ---------------- state ----------------

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
        broadcast(key, value)
        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}")
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

    override fun stop() {
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
