import org.gradle.api.tasks.Copy
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone

val debugApplicationId = "com.github.mikeseger.wvclock.dev"
val appMinSdk = 26

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.github.mikeseger.wvclock"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.github.mikeseger.wvclock"
        minSdk = appMinSdk
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("androidx.webkit:webkit:1.12.1")
}

// --- Copy the repository's web/ directory into assets so the embedded
//     HTTP server (and the WebView via that server) can serve it.
//     rootProject.projectDir is mobile/wv-clock/, so the repo's web/ lives
//     two levels up.
val webSrcDir = rootProject.file("../../web")
val webAssetsDir = layout.projectDirectory.dir("src/main/assets/web")

val syncWebAssets by tasks.registering(Copy::class) {
    group = "build"
    description = "Sync ../../web into app/src/main/assets/web"
    doFirst {
        require(webSrcDir.isDirectory) {
            "Expected web source folder at ${webSrcDir.absolutePath}"
        }
    }
    from(webSrcDir) {
        exclude("**/.DS_Store")
        exclude("**/tmp/**")
    }
    into(webAssetsDir)
}

val writeBuildInfo by tasks.registering {
    outputs.upToDateWhen { false }
    doLast {
        val gitCommit = try {
            ProcessBuilder("git", "rev-parse", "--short", "HEAD")
                .directory(rootProject.projectDir)
                .redirectErrorStream(true)
                .start().inputStream.bufferedReader().readLine()?.trim() ?: "unknown"
        } catch (e: Exception) { "unknown" }
        val buildTime = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'")
                .apply { timeZone = TimeZone.getTimeZone("UTC") }
                .format(Date())
        val outFile = layout.projectDirectory.file("src/main/assets/build_info.json").asFile
        outFile.parentFile.mkdirs()
        outFile.writeText("""{"buildTime":"$buildTime","gitCommit":"$gitCommit"}""")
    }
}

tasks.named("preBuild").configure { dependsOn(syncWebAssets, writeBuildInfo) }

// --- Convenience deploy task: install on attached device and launch.
fun resolveAdbSerials(): List<String> {
    val explicit = findProperty("device")?.toString()
    val output = ProcessBuilder("adb", "devices")
        .redirectErrorStream(true)
        .start().inputStream.bufferedReader().readLines()
    val allDevices = output.drop(1)
        .map { it.trim() }
        .filter { it.isNotEmpty() && it.endsWith("\tdevice") }
        .map { it.substringBefore("\t") }
    if (allDevices.isEmpty()) error("No connected adb devices found.")
    return when (explicit) {
        null  -> listOf(allDevices.first())
        "-"   -> allDevices
        else  -> listOf(explicit)
    }
}

tasks.register<Exec>("deployToDevice") {
    group = "deploy"
    description = "Build, install and launch the debug APK. -Pdevice=<serial> targets one device; -Pdevice=- targets all."
    dependsOn("assembleDebug")
    doFirst {
        val failOnAnyError = findProperty("deployFailOnAnyError")?.toString()?.toBoolean() == true
        val serials = resolveAdbSerials()
        val apk = layout.buildDirectory.file("outputs/apk/debug/app-debug.apk").get().asFile
        val successful = mutableListOf<String>()
        val failed = mutableListOf<Pair<String, String>>()

        serials.forEach { serial ->
            val adb = listOf("adb", "-s", serial)
            logger.lifecycle("Deploying to device: $serial")

            val sdkOutput = ByteArrayOutputStream()
            val sdkResult = project.exec {
                commandLine(adb + listOf("shell", "getprop", "ro.build.version.sdk"))
                isIgnoreExitValue = true
                standardOutput = sdkOutput
                errorOutput = sdkOutput
            }
            if (sdkResult.exitValue == 0) {
                val deviceSdk = sdkOutput.toString().trim().toIntOrNull()
                if (deviceSdk != null && deviceSdk < appMinSdk) {
                    val reason = "Device SDK $deviceSdk is lower than app minSdk $appMinSdk (INSTALL_FAILED_OLDER_SDK)."
                    logger.warn("Skipping $serial: $reason")
                    failed += serial to reason
                    return@forEach
                }
            }

            val installOutput = ByteArrayOutputStream()
            val installResult = project.exec {
                commandLine(adb + listOf("install", "-r", "-d", apk.absolutePath))
                isIgnoreExitValue = true
                standardOutput = installOutput
                errorOutput = installOutput
            }
            val installText = installOutput.toString().trim()
            val installLooksBad = installText.contains("Failure", ignoreCase = true) ||
                installText.contains("failed to install", ignoreCase = true)
            val installLooksGood = installText.contains("Success", ignoreCase = true)
            if (installResult.exitValue != 0 || installLooksBad || !installLooksGood) {
                val reason = installText.ifEmpty { "adb install failed" }
                logger.warn("Install failed on $serial: $reason")
                failed += serial to reason
                return@forEach
            }

            // Grant SYSTEM_ALERT_WINDOW (overlay permission) so the PowerVR watchdog
            // can add its invisible 1x1 BAL-exemption window.  This permission is
            // normally granted once by the user via Settings; pre-grant it here so
            // dev installs never redirect to the Settings screen on launch.
            project.exec {
                commandLine(adb + listOf("shell", "appops", "set", debugApplicationId, "SYSTEM_ALERT_WINDOW", "allow"))
                isIgnoreExitValue = true
            }

            val startOutput = ByteArrayOutputStream()
            val startResult = project.exec {
                commandLine(adb + listOf("shell", "am", "start", "-W", "-n", "$debugApplicationId/com.github.mikeseger.wvclock.MainActivity"))
                isIgnoreExitValue = true
                standardOutput = startOutput
                errorOutput = startOutput
            }

            val startText = startOutput.toString().trim()
            val startLooksBad = startText.contains("Error type", ignoreCase = true) ||
                startText.contains("does not exist", ignoreCase = true) ||
                startText.contains("Exception", ignoreCase = true)
            val startLooksGood = startText.contains("Status: ok", ignoreCase = true) ||
                startText.contains("Starting: Intent", ignoreCase = true)
            if (startResult.exitValue != 0 || startLooksBad || !startLooksGood) {
                val reason = if (startText.isNotEmpty()) startText else "install ok, launch failed"
                logger.warn("Launch failed on $serial: $reason")
                failed += serial to reason
                return@forEach
            }

            successful += serial
        }

        logger.lifecycle("Deploy summary: ${successful.size}/${serials.size} device(s) succeeded")
        if (successful.isNotEmpty()) {
            logger.lifecycle("Successful: ${successful.joinToString(", ")}")
        }
        if (failed.isNotEmpty()) {
            failed.forEach { (serial, reason) ->
                logger.warn("Failed: $serial -> $reason")
            }
            if (successful.isEmpty() || failOnAnyError) {
                error("Deployment failed for ${failed.size} device(s).")
            }
            logger.warn("Some devices failed. Continuing because at least one device deployed successfully. Set -PdeployFailOnAnyError=true to fail the task when any device fails.")
        }
    }
    commandLine("true")
}
