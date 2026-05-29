package com.github.mikeseger.wvclock

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var server: ClockServer? = null
    private val port = 8765
    private var multicastLock: android.net.wifi.WifiManager.MulticastLock? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            setBackgroundColor(0xFF000000.toInt())
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    val offset = server?.calculatedOffsetMs ?: 0L
                    view?.evaluateJavascript("window.__timeMasterOffsetMs = $offset;", null)
                }
            }
        }
        setContentView(webView)

        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
        try {
            multicastLock = wifiManager?.createMulticastLock("WvClockMulticastLock")?.apply {
                setReferenceCounted(true)
                acquire()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire multicast lock", e)
        }

        startServer()

        webView.loadUrl("http://127.0.0.1:$port/")

        applyImmersive()

        // Helpful one-time hint with the LAN URL for remote control.
        val ip = getWifiIpv4()
        if (ip != null) {
            Toast.makeText(
                this,
                "Remote control: http://$ip:$port/",
                Toast.LENGTH_LONG
            ).show()
            Log.i(TAG, "Remote control URL: http://$ip:$port/")
        } else {
            Log.i(TAG, "Server listening on port $port (no Wi-Fi IP detected)")
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    override fun onDestroy() {
        server?.stop()
        server = null
        try {
            multicastLock?.let {
                if (it.isHeld) it.release()
            }
        } catch (_: Exception) {}
        multicastLock = null
        super.onDestroy()
    }

    private fun startServer() {
        try {
            val s = ClockServer(
                context = applicationContext,
                port = port,
                lanUrlProvider = { getWifiIpv4()?.let { "http://$it:$port/" } }
            )
            s.onOffsetChangedListener = { offset ->
                webView.post {
                    webView.evaluateJavascript("window.__timeMasterOffsetMs = $offset;", null)
                }
            }
            s.start(/* timeout */ 5000, /* daemon */ true)
            server = s
            Log.i(TAG, "ClockServer started on $port")
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to start ClockServer", t)
            Toast.makeText(this, "Server failed: ${t.message}", Toast.LENGTH_LONG).show()
        }
    }

    @Suppress("DEPRECATION")
    private fun applyImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let { c ->
                c.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                c.systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                )
        }
    }

    private fun getWifiIpv4(): String? {
        return try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val ipInt = wm?.connectionInfo?.ipAddress ?: 0
            if (ipInt == 0) null
            else String.format(
                "%d.%d.%d.%d",
                ipInt and 0xff,
                ipInt shr 8 and 0xff,
                ipInt shr 16 and 0xff,
                ipInt shr 24 and 0xff
            )
        } catch (e: Exception) {
            null
        }
    }

    companion object {
        private const val TAG = "WvClock"
    }
}
