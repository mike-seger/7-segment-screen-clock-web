# 7-Segment Screen Clock - Desktop App

This directory contains the desktop wrapper for the 7-Segment Screen Clock, built with Electron. It features direct background-level time synchronization (via raw NTP/SNTP UDP socket calls on Port 123) and high-fidelity local peer-to-peer clock synchronization (via Cristian's algorithm on Port 8767, serving updates to local subnet receivers).

---

## Getting Started

### 1. Prerequisites
Ensure you have [Node.js](https://nodejs.org/) (Version 18 or higher recommended) installed.

### 2. Install Dependencies
Navigate to the `desktop` directory and install the necessary npm packages:
```bash
cd desktop
npm install
```

### 3. Run the App
Launch the clock in Electron direct-run environment:
```bash
npm start
```

---

## Creating a Native macOS Executable

The app is pre-configured with `electron-builder` to package code into standalone binaries.

### Build and Package (Mac/Current OS)
Run the package script:
```bash
npm run package
```

This compiles, bundles, and outputs a native executable app (e.g., a `.app` bundle and inside a `.dmg` installer or zip depending on default configuration) within a new `dist/` folder:
- **Location**: `desktop/dist/`
- **Output**: `7-segment-screen-clock-desktop-1.0.0.dmg` and `7-segment-screen-clock-desktop.app`

### Advanced macOS Package Constraints
If you want to package specifically for macOS architectures:
* **Intel Macs**:
  ```bash
  npx electron-builder --mac --x64
  ```
* **Apple Silicon (M1/M2/M3/M4) Macs**:
  ```bash
  npx electron-builder --mac --arm64
  ```
* **Universal (support both architectures)**:
  ```bash
  npx electron-builder --mac --universal
  ```

> **Note**: For standard localized development builds, running `npm run package` detects your host macOS architecture and outputs a matching native package automatically.

---

## Local Network Discovery & Remote Screen Wake-Up

The 7-Segment Screen Clock features auto-discovery and synchronization across all local installations (Android apps, Desktop Electron hosts, or web interfaces pointing at local servers).

### 1. UDP Multicast Discovery
- **Port**: `8766`
- **Behavior**: Active clock servers (like Android's webview server or this Electron host) periodically emit UDP packets containing their configuration details and server URL. Local peers listen on this port to build a real-time list of available nodes without manual address configuration.

### 2. Remote Control Interface
When opening the configuration panel in a browser of any remote client connected to a clock server:
- The **Network Synchronisation** list displays all available devices identified in the subnet.
- You can toggle-control individual devices to match your settings or configure any device to act as the master reference clock.

### 3. Wake & Sleep Screen Cycle
Discovered device rows include dedicated **Wake** and **Sleep** action buttons.
- **Android Target**:
  - Clicking **Wake** fires a POST request to `/api/wake`. This uses high-priority system wake locks (`ACQUIRE_CAUSES_WAKEUP` + bypassing secure keyguards) to wake up the screen and turns the WebView elements back to full visibility.
  - Clicking **Sleep** fires a POST request to `/api/sleep` which dynamically overrides window screen brightness attributes to minimum (`0.01f`) while adding an absolute pitch-black layout backdrop over the clock elements, mimicking physical standby and saving considerable backlight power cleanly.
- **macOS/Desktop Target**:
  - Sending a POST request to `/api/wake` runs `caffeinate -u -t 2` to wake the displays.
  - Sending a POST request to `/api/sleep` runs `pmset displaysleepnow` to put macOS displays straight to sleep immediately.

### 4. Global Broadcast Actions
- Two prominent buttons **Wake All Devices** and **Sleep All Screens** are generated dynamically inside the panel.
- Clicking either button broadcasts the respective wake or sleep trigger across all active subnet nodes discovered by the UDP Multicast service in parallel, letting you toggle entire display arrays on or off dynamically.
