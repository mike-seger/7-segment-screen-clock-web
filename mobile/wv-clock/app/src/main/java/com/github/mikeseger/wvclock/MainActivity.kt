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
            s.onWakeRequestedListener = {
                wakeScreen()
            }
            s.onSleepRequestedListener = {
                sleepScreen()
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

    fun wakeScreen() {
        runOnUiThread {
            try {
                Log.i(TAG, "Attempting to wake screen programmatically")
                val lp = window.attributes
                lp.screenBrightness = android.view.WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                window.attributes = lp

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    setShowWhenLocked(true)
                    setTurnScreenOn(true)
                } else {
                    @Suppress("DEPRECATION")
                    window.addFlags(
                        android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                        android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                        android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    )
                }

                val pm = applicationContext.getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager
                val wl = pm?.newWakeLock(
                    @Suppress("DEPRECATION")
                    (android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP),
                    "WvClock:ScreenWake"
                )
                wl?.acquire(3000)
                applyImmersive()

                webView.post {
                    webView.evaluateJavascript("document.body.style.opacity = '1'; document.body.style.background = '';", null)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error waking screen", e)
            }
        }
    }

    fun sleepScreen() {
        runOnUiThread {
            try {
                Log.i(TAG, "Attempting to put screen to sleep programmatically")
                val lp = window.attributes
                lp.screenBrightness = 0.01f // ultra-dim / off
                window.attributes = lp

                webView.post {
                    webView.evaluateJavascript("document.body.style.opacity = '0'; document.body.style.background = '#000000';", null)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error putting screen to sleep", e)
            }
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
