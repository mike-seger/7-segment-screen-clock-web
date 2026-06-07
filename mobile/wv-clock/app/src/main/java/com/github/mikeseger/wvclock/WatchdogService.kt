package com.github.mikeseger.wvclock

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager

/**
 * Runs in the :watchdog process (separate PID from MainActivity).
 *
 * Every RESTART_INTERVAL_MS it:
 *  1. Adds a 1×1 transparent TYPE_APPLICATION_OVERLAY window via WindowManager.
 *     This makes the :watchdog UID "visible" to Android's BAL enforcement,
 *     granting an unconditional startActivity() exemption — including on
 *     Samsung One UI which blocks every other BAL path.
 *  2. Broadcasts ACTION_KILL_FOR_RESTART — the main process kills itself via
 *     Process.killProcess(), resetting the PowerVR CBUF kernel counter (which
 *     is tracked per-OS-PID by the PowerVR driver).
 *  3. After LAUNCH_DELAY_MS, calls startActivity(MainActivity) while the
 *     overlay window is still visible.
 *  4. Removes the overlay 2 s later.
 *
 * Requires SYSTEM_ALERT_WINDOW ("Appear on top") permission — granted once
 * by the user via Settings.  Only started on PowerVR GPU devices.
 *
 * Returns START_STICKY so Android re-creates this service if ever killed.
 */
class WatchdogService : Service() {

    private val handler = Handler(Looper.getMainLooper())

    private val restartRunnable = Runnable { triggerRestart() }

    // ------------------------------------------------------------------ lifecycle

    override fun onCreate() {
        super.onCreate()
        Log.w(TAG, "WatchdogService created in :watchdog process (pid=${android.os.Process.myPid()})")
        startForegroundCompat()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Reset the countdown every time MainActivity starts us — gives a fresh
        // RESTART_INTERVAL_MS window after each process restart.
        handler.removeCallbacks(restartRunnable)
        handler.postDelayed(restartRunnable, RESTART_INTERVAL_MS)
        Log.w(TAG, "WatchdogService: CBUF restart scheduled in ${RESTART_INTERVAL_MS / 60_000} min")
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacks(restartRunnable)
        super.onDestroy()
    }

    // ------------------------------------------------------------------ logic

    private fun triggerRestart() {
        Log.w(TAG, "WatchdogService: triggering PowerVR CBUF reset (process kill + relaunch)")

        if (!Settings.canDrawOverlays(this)) {
            Log.e(TAG, "WatchdogService: SYSTEM_ALERT_WINDOW not granted — cannot restart")
            handler.postDelayed(restartRunnable, RESTART_INTERVAL_MS)
            return
        }

        // Add a 1×1 invisible overlay window.  Having any visible window makes
        // our UID exempt from Android BAL restrictions, so startActivity() will
        // succeed even from a background/FGS process on Samsung One UI.
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val overlayView = View(this).apply { alpha = 0f }
        val params = WindowManager.LayoutParams(
            1, 1,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.START or Gravity.TOP
            x = 0; y = 0
        }
        try {
            wm.addView(overlayView, params)
            Log.w(TAG, "WatchdogService: overlay window added (BAL exemption active)")
        } catch (e: Exception) {
            Log.e(TAG, "WatchdogService: failed to add overlay", e)
            handler.postDelayed(restartRunnable, RESTART_INTERVAL_MS)
            return
        }

        // Kill the main process — this resets the PowerVR CBUF kernel counter
        // which is tracked per-OS-PID by the driver.
        sendBroadcast(Intent(ACTION_KILL_FOR_RESTART).apply { setPackage(packageName) })

        // After the main process has died, launch MainActivity while the
        // overlay is still present to satisfy the BAL visibility requirement.
        handler.postDelayed({
            try {
                val launch = Intent(this, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                }
                startActivity(launch)
                Log.w(TAG, "WatchdogService: startActivity(MainActivity) via overlay BAL exemption")
            } catch (e: Exception) {
                Log.e(TAG, "WatchdogService: startActivity failed", e)
            }
            // Remove overlay 2 s after launch — plenty of time for BAL check.
            handler.postDelayed({
                try { wm.removeView(overlayView) } catch (_: Exception) {}
                Log.w(TAG, "WatchdogService: overlay window removed")
            }, 2000L)
        }, LAUNCH_DELAY_MS)

        // Re-arm.  Also cancelled+reset by onStartCommand when the freshly
        // launched MainActivity calls startService() again.
        handler.postDelayed(restartRunnable, RESTART_INTERVAL_MS)
    }

    // ------------------------------------------------------------------ foreground notification

    private fun startForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "GPU Watchdog", NotificationManager.IMPORTANCE_MIN)
                        .also { it.setShowBadge(false) }
                )
            }
        }
        val notif = android.app.Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("WV Clock")
            .setContentText("GPU watchdog active")
            .setSmallIcon(android.R.drawable.ic_menu_rotate)
            .build()
        startForeground(NOTIF_ID, notif)
    }

    // ------------------------------------------------------------------ constants

    companion object {
        private const val TAG = "WvClock"
        const val ACTION_KILL_FOR_RESTART = "com.github.mikeseger.wvclock.ACTION_KILL_FOR_RESTART"
        private const val RESTART_INTERVAL_MS = 25 * 60 * 1000L
        private const val LAUNCH_DELAY_MS = 1500L
        private const val CHANNEL_ID = "wvclock_watchdog"
        private const val NOTIF_ID = 42
    }
}
