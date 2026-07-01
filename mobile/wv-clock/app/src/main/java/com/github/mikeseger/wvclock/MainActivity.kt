package com.github.mikeseger.wvclock

import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.MediaRecorder
import android.net.wifi.WifiManager
import android.opengl.EGL14
import android.opengl.GLES20
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.PermissionRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import java.io.File
import java.net.BindException
import java.net.NetworkInterface
import kotlin.math.abs
import kotlin.math.sqrt

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var server: ClockServer? = null
    private val preferredPort = 8765
    private var serverPort = preferredPort
    private var homeUrlOverride: String? = null
    private var multicastLock: android.net.wifi.WifiManager.MulticastLock? = null
        private var wifiLock: WifiManager.WifiLock? = null

    private var sleepOverlayView: View? = null
    private var pendingWebPermissionRequest: PermissionRequest? = null
    private var pendingWebPermissionResources: Array<String> = emptyArray()

    private var nativePresenceEnabled = false
    private var nativeAudioSensitivity = 0.22f
    private var nativeMotionSensitivity = 0.18f
    private var nativeLightSensitivity = 0.2f
    private var nativeDecayMs = 1400L
    private var nativeLastEmitTs = 0L

    private val nativePresenceHandler = Handler(Looper.getMainLooper())
    private var nativeAudioRecorder: MediaRecorder? = null
    private var nativeAudioFile: File? = null
    private var nativeAudioBaseline = 200f
    private var nativeLightBaseline = -1f
    private var nativeMotionBaseline = 0f

    private var sensorManager: SensorManager? = null
    private var lightSensor: Sensor? = null
    private var motionSensor: Sensor? = null
    private var nativeSensorsRegistered = false

    private val nativeSensorListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent?) {
            if (!nativePresenceEnabled || event == null) return
            when (event.sensor?.type) {
                Sensor.TYPE_LIGHT -> handleNativeLight(event.values)
                Sensor.TYPE_GYROSCOPE,
                Sensor.TYPE_ACCELEROMETER,
                Sensor.TYPE_ROTATION_VECTOR -> handleNativeMotion(event.values)
            }
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        }
    }

    private val nativeAudioPoll = object : Runnable {
        override fun run() {
            if (!nativePresenceEnabled) return
            try {
                val amp = nativeAudioRecorder?.maxAmplitude?.toFloat() ?: 0f
                if (amp > 0f) {
                    if (nativeAudioBaseline <= 0f) nativeAudioBaseline = amp
                    nativeAudioBaseline = nativeAudioBaseline * 0.92f + amp * 0.08f

                    val ratio = if (nativeAudioBaseline > 1f) amp / nativeAudioBaseline else 0f
                    val ratioThreshold = 2.2f - nativeAudioSensitivity * 1.5f
                    val absThreshold = 4500f - nativeAudioSensitivity * 3200f
                    if (ratio > ratioThreshold || amp > absThreshold) {
                        maybeEmitNativePresence("audio")
                    }
                }
            } catch (_: Exception) {
            } finally {
                nativePresenceHandler.postDelayed(this, 160)
            }
        }
    }

    // Set to true once the background EGL probe confirms a PowerVR GPU.
    private var isPowerVR = false

    // Dynamically registered so it only lives while the main process is alive.
    // Receives ACTION_KILL_FOR_RESTART from WatchdogService (:watchdog process)
    // and immediately kills this process, resetting the PowerVR CBUF counter
    // (the kernel driver tracks CBUF budget per OS PID).
    private val restartReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            Log.w(TAG, "restartReceiver: killing main process for PowerVR CBUF reset (wasAsleep=$isAsleep)")
            // Persist sleep state so the fresh process can restore it.
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(PREFS_KEY_WAS_ASLEEP, isAsleep)
                .commit()  // commit() not apply() — must flush before killProcess
            Process.killProcess(Process.myPid())
        }
    }

    private var sleepTimeoutMinutes = 0
    private var isAsleep = false
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val sleepRunnable = Runnable {
        Log.i(TAG, "Auto-sleep timer expired. Putting screen to sleep.")
        sleepScreen()
    }

    override fun dispatchTouchEvent(ev: android.view.MotionEvent?): Boolean {
        if (isAsleep) {
            wakeScreen()
        } else {
            resetSleepTimer()
        }
        return super.dispatchTouchEvent(ev)
    }

    override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent?): Boolean {
        if (isAsleep) {
            wakeScreen()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    fun resetSleepTimer() {
        handler.removeCallbacks(sleepRunnable)
        if (sleepTimeoutMinutes > 0 && !isAsleep) {
            val delayMs = sleepTimeoutMinutes * 60 * 1000L
            handler.postDelayed(sleepRunnable, delayMs)
            Log.d(TAG, "Reset auto-sleep timer: screen will sleep in $sleepTimeoutMinutes min")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            setBackgroundColor(0xFF000000.toInt())
            addJavascriptInterface(WvBridge(), "Android")
            webChromeClient = object : android.webkit.WebChromeClient() {
                override fun onConsoleMessage(msg: android.webkit.ConsoleMessage): Boolean {
                    Log.w(TAG, "JS: ${msg.message()} [${msg.sourceId()}:${msg.lineNumber()}]")
                    return true
                }

                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread {
                        handleWebPermissionRequest(request)
                    }
                }
            }
            webViewClient = object : WebViewClient() {
                override fun onRenderProcessGone(
                    view: WebView?,
                    detail: android.webkit.RenderProcessGoneDetail?
                ): Boolean {
                    Log.e(TAG, "WebView renderer gone (crashed=${detail?.didCrash()}), reloading")
                    view?.loadUrl(homeUrl())
                    return true
                }
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    val offset = server?.calculatedOffsetMs ?: 0L
                    view?.evaluateJavascript("window.__timeMasterOffsetMs = $offset;", null)

                    try {
                        val stateStr = server?.state?.get("screenClock_state")
                        if (stateStr != null) {
                            val obj = org.json.JSONObject(stateStr)
                            sleepTimeoutMinutes = obj.optInt("sleepTimeout", 0)
                            applyNativePresenceFromStateObject(obj)
                            Log.i(TAG, "Initial sleep timeout loaded: $sleepTimeoutMinutes minutes")
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Error parsing initial state json", e)
                    }

                    // Restore sleep state persisted by the watchdog kill receiver.
                    // A touch will wake the clock immediately via dispatchTouchEvent.
                    val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    if (prefs.getBoolean(PREFS_KEY_WAS_ASLEEP, false)) {
                        Log.w(TAG, "onPageFinished: restoring sleep state after watchdog restart")
                        prefs.edit().remove(PREFS_KEY_WAS_ASLEEP).apply()
                        sleepScreen()
                    } else {
                        resetSleepTimer()
                    }
                }
            }
        }
        setContentView(webView)

        // Keep the screen on permanently while the application is in the foreground
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
        try {
            multicastLock = wifiManager?.createMulticastLock("WvClockMulticastLock")?.apply {
                setReferenceCounted(true)
                acquire()
            }
                wifiLock = wifiManager?.createWifiLock(
                    WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                    "WvClockWifiLock"
                )?.apply {
                    setReferenceCounted(false)
                    acquire()
                }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire multicast lock", e)
        }

        startServer()

        // Start the PowerVR CBUF watchdog in a background thread so GPU
        // detection (EGL probe) doesn't block the main thread.
        Thread { startPvrWatchdogIfNeeded() }.start()

        webView.loadUrl(homeUrl())

        applyImmersive()

        // Request READ_PHONE_STATE so Build.getSerial() is available for the info overlay
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            checkSelfPermission(android.Manifest.permission.READ_PHONE_STATE) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.READ_PHONE_STATE), 1)
        }

        ensureMediaRuntimePermissions()

        // Helpful one-time hint with the LAN URL for remote control.
        val ip = getWifiIpv4()
        if (ip != null) {
            Toast.makeText(
                this,
                "Remote control: http://$ip:$serverPort/",
                Toast.LENGTH_LONG
            ).show()
            Log.i(TAG, "Remote control URL: http://$ip:$serverPort/")
        } else {
            Log.i(TAG, "Server listening on port $serverPort (no Wi-Fi IP detected)")
        }

        maybeRequestBatteryOptimizationExemption()
    }

    private fun ensureMediaRuntimePermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val needed = mutableListOf<String>()
        if (checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            needed.add(android.Manifest.permission.CAMERA)
        }
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed.add(android.Manifest.permission.RECORD_AUDIO)
        }
        if (needed.isNotEmpty()) {
            requestPermissions(needed.toTypedArray(), REQUEST_MEDIA_PERMISSIONS)
        }
    }

    private fun hasRuntimePermission(permission: String): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun handleWebPermissionRequest(request: PermissionRequest) {
        val resources = request.resources ?: emptyArray()
        if (resources.isEmpty()) {
            request.deny()
            return
        }

        val requiredPermissions = mutableSetOf<String>()
        if (resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
            requiredPermissions.add(android.Manifest.permission.CAMERA)
        }
        if (resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
            requiredPermissions.add(android.Manifest.permission.RECORD_AUDIO)
        }

        val missing = requiredPermissions.filterNot { hasRuntimePermission(it) }
        if (missing.isNotEmpty()) {
            pendingWebPermissionRequest?.deny()
            pendingWebPermissionRequest = request
            pendingWebPermissionResources = resources
            requestPermissions(missing.toTypedArray(), REQUEST_WEBVIEW_MEDIA_PERMISSION_REQUEST)
            return
        }

        try {
            request.grant(resources)
        } catch (e: Exception) {
            Log.e(TAG, "Failed granting WebView permission request", e)
            request.deny()
        }
    }

    private val screenOnReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_SCREEN_ON && isAsleep) {
                wakeScreen()
            }
        }
    }

    override fun onResume() {
        super.onResume()

        // Reassert these every time the activity becomes active.
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        applyImmersive()
        webView.onResume()

        registerReceiver(screenOnReceiver, IntentFilter(Intent.ACTION_SCREEN_ON))
        // Re-register the restart receiver (may have been unregistered on pause).
        @Suppress("UnspecifiedRegisterReceiverFlag")
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(
                restartReceiver,
                IntentFilter(WatchdogService.ACTION_KILL_FOR_RESTART),
                Context.RECEIVER_NOT_EXPORTED
            )
        } else {
            registerReceiver(restartReceiver, IntentFilter(WatchdogService.ACTION_KILL_FOR_RESTART))
        }
        maybeStartWatchdog()
        server?.notifyAppResumed()
        if (nativePresenceEnabled) {
            startNativePresenceFallback()
        }

        if (!isAsleep) resetSleepTimer()
    }

    override fun onPause() {
        super.onPause()

        webView.onPause()

        server?.notifyAppPaused()
        stopNativePresenceFallback()
        try { unregisterReceiver(screenOnReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(restartReceiver) } catch (_: Exception) {}
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)

        if (requestCode == REQUEST_WEBVIEW_MEDIA_PERMISSION_REQUEST) {
            val request = pendingWebPermissionRequest
            val resources = pendingWebPermissionResources
            pendingWebPermissionRequest = null
            pendingWebPermissionResources = emptyArray()

            if (request == null) return

            val allGranted = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }
            if (allGranted) {
                try {
                    request.grant(resources)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed granting deferred WebView permission request", e)
                    request.deny()
                }
            } else {
                request.deny()
            }
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
                wifiLock?.let {
                    if (it.isHeld) it.release()
                }
        } catch (_: Exception) {}
        multicastLock = null
            wifiLock = null
        stopNativePresenceFallback()
        super.onDestroy()
    }

    private fun maybeEmitNativePresence(type: String) {
        if (!nativePresenceEnabled) return
        val now = System.currentTimeMillis()
        if (now - nativeLastEmitTs < nativeDecayMs) return
        nativeLastEmitTs = now
        publishNativePresenceStatus()
        webView.post {
            webView.evaluateJavascript("window.PresenceService && window.PresenceService.forceWake('${type}')", null)
        }
    }

    private fun publishNativePresenceStatus() {
        val payload = org.json.JSONObject()
        payload.put("enabled", nativePresenceEnabled)
        payload.put("audio", nativeAudioRecorder != null)
        payload.put("sensors", nativeSensorsRegistered)
        payload.put("ts", System.currentTimeMillis())
        val jsValue = org.json.JSONObject.quote(payload.toString())
        webView.post {
            webView.evaluateJavascript("try{localStorage.setItem('screenClock_presenceNativeStatus', ${jsValue});}catch(e){}", null)
        }
    }

    private fun handleNativeLight(values: FloatArray?) {
        if (values == null || values.isEmpty()) return
        val lux = values[0]
        if (!lux.isFinite()) return

        if (nativeLightBaseline < 0f) nativeLightBaseline = lux
        val baseline = nativeLightBaseline
        val delta = abs(lux - baseline)

        val deltaThreshold = 18f - nativeLightSensitivity * 14f
        val brightThreshold = 120f - nativeLightSensitivity * 90f
        if (delta > deltaThreshold || lux > brightThreshold) {
            maybeEmitNativePresence("light")
        }
        nativeLightBaseline = baseline * 0.88f + lux * 0.12f
    }

    private fun handleNativeMotion(values: FloatArray?) {
        if (values == null || values.size < 3) return
        val x = values[0]
        val y = values[1]
        val z = values[2]
        if (!x.isFinite() || !y.isFinite() || !z.isFinite()) return

        val mag = sqrt(x * x + y * y + z * z)
        if (!mag.isFinite()) return

        if (nativeMotionBaseline <= 0f) nativeMotionBaseline = mag
        val delta = abs(mag - nativeMotionBaseline)
        val motionThreshold = 0.9f - nativeMotionSensitivity * 0.65f
        if (delta > motionThreshold || mag > (1.4f - nativeMotionSensitivity * 0.9f)) {
            maybeEmitNativePresence("gyro")
        }
        nativeMotionBaseline = nativeMotionBaseline * 0.9f + mag * 0.1f
    }

    private fun startNativeAudioFallback() {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
        if (nativeAudioRecorder != null) return

        try {
            val outFile = File(cacheDir, "presence-native-audio.3gp")
            nativeAudioFile = outFile
            val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(this)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.THREE_GPP)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AMR_NB)
            recorder.setOutputFile(outFile.absolutePath)
            recorder.prepare()
            recorder.start()
            nativeAudioRecorder = recorder
            nativeAudioBaseline = 200f
            nativePresenceHandler.removeCallbacks(nativeAudioPoll)
            nativePresenceHandler.post(nativeAudioPoll)
        } catch (e: Exception) {
            Log.w(TAG, "Native audio fallback unavailable", e)
            stopNativeAudioFallback()
        }
    }

    private fun stopNativeAudioFallback() {
        nativePresenceHandler.removeCallbacks(nativeAudioPoll)
        try {
            nativeAudioRecorder?.stop()
        } catch (_: Exception) {
        }
        try {
            nativeAudioRecorder?.release()
        } catch (_: Exception) {
        }
        nativeAudioRecorder = null
    }

    private fun startNativeSensorFallback() {
        if (nativeSensorsRegistered) return
        val sm = sensorManager ?: getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        sensorManager = sm
        if (sm == null) return

        lightSensor = sm.getDefaultSensor(Sensor.TYPE_LIGHT)
        motionSensor = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
            ?: sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
            ?: sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)

        var registeredAny = false
        lightSensor?.let {
            registeredAny = sm.registerListener(nativeSensorListener, it, SensorManager.SENSOR_DELAY_NORMAL) || registeredAny
        }
        motionSensor?.let {
            registeredAny = sm.registerListener(nativeSensorListener, it, SensorManager.SENSOR_DELAY_GAME) || registeredAny
        }
        nativeSensorsRegistered = registeredAny
    }

    private fun stopNativeSensorFallback() {
        if (!nativeSensorsRegistered) return
        try {
            sensorManager?.unregisterListener(nativeSensorListener)
        } catch (_: Exception) {
        }
        nativeSensorsRegistered = false
    }

    private fun startNativePresenceFallback() {
        if (!nativePresenceEnabled) return
        startNativeSensorFallback()
        startNativeAudioFallback()
        publishNativePresenceStatus()
    }

    private fun stopNativePresenceFallback() {
        stopNativeAudioFallback()
        stopNativeSensorFallback()
        publishNativePresenceStatus()
    }

    private fun applyNativePresenceFromStateObject(root: org.json.JSONObject) {
        try {
            val ps = root.optJSONObject("presenceSettings") ?: root
            nativePresenceEnabled = ps.optBoolean("enabled", nativePresenceEnabled)
            nativeAudioSensitivity = ps.optDouble("audioSensitivity", nativeAudioSensitivity.toDouble()).toFloat().coerceIn(0f, 1f)
            nativeMotionSensitivity = ps.optDouble("cameraSensitivity", nativeMotionSensitivity.toDouble()).toFloat().coerceIn(0f, 1f)
            nativeLightSensitivity = ps.optDouble("lightSensitivity", nativeLightSensitivity.toDouble()).toFloat().coerceIn(0f, 1f)
            val decaySec = ps.optDouble("decaySec", nativeDecayMs.toDouble() / 1000.0)
            nativeDecayMs = (decaySec * 1000.0).toLong().coerceIn(200L, 10000L)

            if (nativePresenceEnabled) {
                startNativePresenceFallback()
            } else {
                stopNativePresenceFallback()
            }
            publishNativePresenceStatus()
        } catch (e: Exception) {
            Log.w(TAG, "applyNativePresenceFromStateObject failed", e)
        }
    }

    private fun startServer() {
        try {
            val s = ClockServer(
                context = applicationContext,
                port = preferredPort,
                lanUrlProvider = { getWifiIpv4()?.let { "http://$it:$preferredPort/" } },
                batteryLevelProvider = {
                    val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                    val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
                    val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
                    if (level >= 0 && scale > 0) (level * 100 / scale) else -1
                },
                batteryMilliWattsProvider = {
                    try {
                        val bm = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
                        val uA = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW) ?: Int.MIN_VALUE
                        val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                        val uV = intent?.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1) ?: -1
                        // uA is signed (negative = discharging); uV in millivolts
                        if (uA != Int.MIN_VALUE && uV > 0) {
                            // milliwatts = |mA| * V  = |uA/1000| * uV/1000
                            Math.abs(uA.toLong() * uV / 1_000_000L).toInt()
                        } else -1
                    } catch (e: Exception) { -1 }
                },
                    macAddressProvider = { getWifiMacAddress() },
                    wifiLockHeldProvider = { wifiLock?.isHeld == true }
            )
            s.onOffsetChangedListener = { offset ->
                webView.post {
                    webView.evaluateJavascript("window.__timeMasterOffsetMs = $offset;", null)
                }
            }
            s.onStateChangedListener = { key, value ->
                if (key == "screenClock_state" && value != null) {
                    try {
                        val obj = org.json.JSONObject(value)
                        val timeout = obj.optInt("sleepTimeout", 0)
                        applyNativePresenceFromStateObject(obj)
                        runOnUiThread {
                            if (sleepTimeoutMinutes != timeout) {
                                sleepTimeoutMinutes = timeout
                                Log.i(TAG, "Sleep timeout updated to: $sleepTimeoutMinutes minutes")
                                resetSleepTimer()
                            }
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Error parsing state json for sleepTimeout", e)
                    }
                } else if (key == "screenClock_presenceSettings" && value != null) {
                    try {
                        applyNativePresenceFromStateObject(org.json.JSONObject(value))
                    } catch (e: Exception) {
                        Log.e(TAG, "Error parsing presence settings json", e)
                    }
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
            serverPort = preferredPort
            homeUrlOverride = null
            Log.i(TAG, "ClockServer started on $serverPort")
        } catch (t: Throwable) {
            if (isAddressInUse(t)) {
                server = null
                serverPort = preferredPort
                homeUrlOverride = "http://127.0.0.1:$preferredPort/"
                Log.w(TAG, "ClockServer port $preferredPort is busy; using existing instance instead of starting a second one")
                return
            }
            Log.e(TAG, "Failed to start ClockServer", t)
            Toast.makeText(this, "Server failed: ${t.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun isAddressInUse(t: Throwable?): Boolean {
        var cursor = t
        while (cursor != null) {
            if (cursor is BindException) return true
            val msg = cursor.message ?: ""
            if (msg.contains("EADDRINUSE", ignoreCase = true) || msg.contains("Address already in use", ignoreCase = true)) {
                return true
            }
            cursor = cursor.cause
        }
        return false
    }

    private fun homeUrl(): String {
        homeUrlOverride?.let { return it }
        return if (server != null) {
            "http://127.0.0.1:$serverPort/"
        } else {
            "file:///android_asset/web/index.html"
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

                // Remove native black overlay
                sleepOverlayView?.let {
                    (it.parent as? android.view.ViewGroup)?.removeView(it)
                }
                sleepOverlayView = null

                val lp = window.attributes
                lp.screenBrightness = android.view.WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                window.attributes = lp

                isAsleep = false
                server?.isScreenAsleep = false
                resetSleepTimer()

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

                isAsleep = true
                server?.isScreenAsleep = true
                handler.removeCallbacks(sleepRunnable)

                // Set backlight to zero while keeping FLAG_KEEP_SCREEN_ON.
                // This cuts the LCD backlight on Samsung hardware without letting
                // the OS sleep the display, so touch events and remote wake both
                // work immediately without any special permissions.
                val lp = window.attributes
                lp.screenBrightness = 0.0f
                window.attributes = lp

                // Add native black overlay for instant visual blackout
                if (sleepOverlayView == null) {
                    val overlay = View(this)
                    overlay.setBackgroundColor(0xFF000000.toInt())
                    overlay.isClickable = true
                    addContentView(
                        overlay,
                        android.view.ViewGroup.LayoutParams(
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT
                        )
                    )
                    sleepOverlayView = overlay
                }

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
            if (ipInt != 0) {
                return String.format(
                    "%d.%d.%d.%d",
                    ipInt and 0xff,
                    ipInt shr 8 and 0xff,
                    ipInt shr 16 and 0xff,
                    ipInt shr 24 and 0xff
                )
            }

            val preferred = listOf("wlan0", "wifi0", "eth0", "rmnet0")
            val all = mutableListOf<NetworkInterface>()
            val enumeration = NetworkInterface.getNetworkInterfaces()
            while (enumeration != null && enumeration.hasMoreElements()) {
                all.add(enumeration.nextElement())
            }
            val ordered = (preferred.mapNotNull { name -> all.find { it.name.equals(name, ignoreCase = true) } }
                + all.filter { it.name.lowercase() !in preferred }).distinctBy { it.name }

            for (iface in ordered) {
                if (!iface.isUp || iface.isLoopback) continue
                val address = iface.inetAddresses
                    ?.toList()
                    ?.firstOrNull { it is java.net.Inet4Address && !it.isLoopbackAddress }
                    ?.hostAddress
                if (!address.isNullOrBlank()) return address
            }
            null
        } catch (e: Exception) {
            null
        }
    }

    private fun getWifiMacAddress(): String? {
        return try {
            val preferred = listOf("wlan0", "wifi0", "eth0")
            val all = mutableListOf<NetworkInterface>()
            val enumeration = NetworkInterface.getNetworkInterfaces()
            while (enumeration != null && enumeration.hasMoreElements()) {
                all.add(enumeration.nextElement())
            }
            val ordered = (preferred.mapNotNull { name -> all.find { it.name.equals(name, ignoreCase = true) } }
                + all.filter { it.name.lowercase() !in preferred }).distinctBy { it.name }

            for (iface in ordered) {
                val mac = iface.hardwareAddress ?: continue
                if (mac.size != 6) continue
                val normalized = mac.joinToString(":") { b -> "%02X".format(b.toInt() and 0xFF) }
                if (normalized != "00:00:00:00:00:00") return normalized
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun maybeRequestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return

        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (prefs.getBoolean(PREFS_KEY_BATTERY_PROMPTED, false)) return

        val powerManager = getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager
        if (powerManager?.isIgnoringBatteryOptimizations(packageName) == true) return

        prefs.edit().putBoolean(PREFS_KEY_BATTERY_PROMPTED, true).apply()
        Log.w(TAG, "Requesting battery optimization exemption for $packageName")
        Toast.makeText(
            this,
            "Allow battery optimization exemption to keep LAN discovery stable.",
            Toast.LENGTH_LONG
        ).show()

        try {
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    android.net.Uri.parse("package:$packageName")
                )
            )
        } catch (e: Exception) {
            Log.e(TAG, "Could not launch battery optimization settings", e)
        }
    }

    // ------------------------------------------------------------------ GPU watchdog

    /**
     * Queries GL_RENDERER via a short-lived EGL pbuffer context (no CBUF cost
     * because it's immediately destroyed) and starts WatchdogService only on
     * PowerVR hardware.  Must be called off the main thread.
     */
    private fun startPvrWatchdogIfNeeded() {
        if (isPowerVRGpu()) {
            isPowerVR = true
            Log.w(TAG, "PowerVR GPU detected — CBUF watchdog needed")
            runOnUiThread { maybeStartWatchdog() }
        }
    }

    /**
     * Starts WatchdogService if PowerVR is detected AND SYSTEM_ALERT_WINDOW
     * is granted.  If permission is missing, opens the system settings page
     * for the user to grant it.  Safe to call from onResume() — it picks up
     * the permission after the user returns from the settings screen.
     */
    private fun maybeStartWatchdog() {
        if (!isPowerVR) return
        if (Settings.canDrawOverlays(this)) {
            Log.w(TAG, "PowerVR watchdog: overlay permission granted — starting service")
            startService(Intent(this, WatchdogService::class.java))
        } else {
            // Permission not yet granted.  Show a one-time notification that
            // deeplinks to the Settings page — the clock stays visible and
            // fully functional; the user can grant it at their convenience.
            // Without it the watchdog simply won't run, and the 30-min JS
            // reload (watchdog B4) remains as a partial safety net.
            val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            if (!prefs.getBoolean(PREFS_KEY_OVERLAY_PROMPTED, false)) {
                prefs.edit().putBoolean(PREFS_KEY_OVERLAY_PROMPTED, true).apply()
                Log.w(TAG, "PowerVR watchdog: SYSTEM_ALERT_WINDOW not granted — showing one-time prompt")
                Toast.makeText(
                    this,
                    "To prevent GPU crashes: Settings → Apps → WV Clock → Appear on top → Allow",
                    Toast.LENGTH_LONG
                ).show()
            } else {
                Log.w(TAG, "PowerVR watchdog: SYSTEM_ALERT_WINDOW not granted (prompt already shown)")
            }
        }
    }

    private fun isPowerVRGpu(): Boolean {
        return try {
            val display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
            if (display == EGL14.EGL_NO_DISPLAY) return false
            EGL14.eglInitialize(display, null, 0, null, 0)

            val cfgAttribs = intArrayOf(
                EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                EGL14.EGL_NONE
            )
            val configs = arrayOfNulls<android.opengl.EGLConfig>(1)
            val numCfg = IntArray(1)
            if (!EGL14.eglChooseConfig(display, cfgAttribs, 0, configs, 0, 1, numCfg, 0)
                || numCfg[0] == 0) {
                EGL14.eglTerminate(display)
                return false
            }

            val ctxAttribs = intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE)
            val ctx = EGL14.eglCreateContext(display, configs[0]!!, EGL14.EGL_NO_CONTEXT, ctxAttribs, 0)
            if (ctx == EGL14.EGL_NO_CONTEXT) {
                EGL14.eglTerminate(display)
                return false
            }

            val pbufAttribs = intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE)
            val pbuf = EGL14.eglCreatePbufferSurface(display, configs[0]!!, pbufAttribs, 0)
            EGL14.eglMakeCurrent(display, pbuf, pbuf, ctx)

            val renderer = GLES20.glGetString(GLES20.GL_RENDERER) ?: ""
            Log.i(TAG, "GPU renderer: $renderer")

            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            EGL14.eglDestroySurface(display, pbuf)
            EGL14.eglDestroyContext(display, ctx)
            EGL14.eglTerminate(display)

            renderer.contains("PowerVR", ignoreCase = true)
        } catch (e: Exception) {
            Log.e(TAG, "GPU detection failed", e)
            false
        }
    }

    /** JS-callable bridge — methods run on the JS thread, use runOnUiThread for UI ops. */
    inner class WvBridge {
        @android.webkit.JavascriptInterface
        fun hardRestart() {
            Log.w(TAG, "JS requested hardRestart — reloading clock page")
            runOnUiThread {
                webView.loadUrl(homeUrl())
            }
        }

        @android.webkit.JavascriptInterface
        fun configureNativePresence(configJson: String?) {
            runOnUiThread {
                try {
                    val obj = org.json.JSONObject(configJson ?: "{}")
                    nativePresenceEnabled = obj.optBoolean("enabled", false)
                    nativeAudioSensitivity = obj.optDouble("audioSensitivity", 0.22).toFloat().coerceIn(0f, 1f)
                    nativeMotionSensitivity = obj.optDouble("cameraSensitivity", 0.18).toFloat().coerceIn(0f, 1f)
                    nativeLightSensitivity = obj.optDouble("lightSensitivity", 0.2).toFloat().coerceIn(0f, 1f)
                    val decaySec = obj.optDouble("decaySec", 1.4)
                    nativeDecayMs = (decaySec * 1000.0).toLong().coerceIn(200L, 10000L)

                    if (nativePresenceEnabled) startNativePresenceFallback() else stopNativePresenceFallback()
                    publishNativePresenceStatus()
                } catch (e: Exception) {
                    Log.w(TAG, "configureNativePresence failed", e)
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun getNativePresenceStatus(): String {
            val audio = if (nativeAudioRecorder != null) "on" else "off"
            val sensors = if (nativeSensorsRegistered) "on" else "off"
            return "native(enabled=${nativePresenceEnabled},audio=${audio},sensors=${sensors})"
        }
    }

    companion object {
        private const val TAG = "WvClock"
        private const val REQUEST_MEDIA_PERMISSIONS = 2001
        private const val REQUEST_WEBVIEW_MEDIA_PERMISSION_REQUEST = 2002
        private const val PREFS_NAME = "wvclock_prefs"
        private const val PREFS_KEY_WAS_ASLEEP = "watchdog_was_asleep"
        private const val PREFS_KEY_OVERLAY_PROMPTED = "overlay_permission_prompted"
        private const val PREFS_KEY_BATTERY_PROMPTED = "battery_optimization_prompted"
    }
}
