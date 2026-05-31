package com.github.mikeseger.wvclock

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class ClockDeviceAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        Log.i("WvClock", "Device admin enabled — full backlight-off sleep is now active")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        Log.i("WvClock", "Device admin disabled — sleep will fall back to dim mode")
    }
}
