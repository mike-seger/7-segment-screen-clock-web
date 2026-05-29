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
