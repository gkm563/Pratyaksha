# Pratyaksha (प्रत्यक्ष) — Offline Biometric Attendance Platform

**Pratyaksha** is a fully functional, premium Progressive Web App (PWA) that runs a complete facial recognition attendance pipeline entirely client-side. Built to handle low-connectivity remote environments (Tier 2/3 cities, remote project sites, factory yards), it captures attendance, performs active liveness detection, and queues synchronization logs for cloud dispatch upon network restoration.

---

## 🌟 Key Features

1. **On-Device Facial Recognition**: Uses `@vladmandic/face-api` (built on TensorFlow.js with WebGL hardware acceleration) to run face detection, landmarks, and 128-dimensional embedding comparisons locally.
2. **Active Blink & Motion Liveness Detection**: Employs mathematical landmarks verification (Eye Aspect Ratio and coordinate variance) to reject static photo/video spoofing attacks.
3. **5-Angle Biometric Enrollment**: A detailed guidance wizard capturing Front, Left, Right, Up, and Down angles to build a comprehensive, highly accurate facial template.
4. **Encrypted Local Storage (IndexedDB)**: Stores employee identities and attendance ledger logs client-side. Operates for days or weeks completely disconnected without data loss.
5. **Smart Auto-Sync Engine**: Toggles dynamically between Online/Offline modes. Periodically batch uploads pending records to the server endpoint with automatic retry, deduplication, and backing queue indicator badges.
6. **Real-time Diagnostic Terminal Console**: Tracks boot sequences, model load latency, IndexedDB state, and synchronization transactions live.

---

## ⚙️ Architecture and Technologies

* **Frontend**: HTML5, Vanilla CSS3 (glassmorphic grid designs), Sora & JetBrains Mono typography, Tabler Icons.
* **Biometrics**: TensorFlow.js + `@vladmandic/face-api` (FaceNet / SSD-Mobilenet).
* **Storage**: Browser IndexedDB API.
* **Server & Mock DB**: Native Node.js HTTP server serving assets and handling synchronization POST payloads.
* **Service Worker**: Caches the application shell and Face-API neural network model weights for true offline operation.

---

## 🚀 Quick Setup & Run

Follow these commands to fire up the system locally.

### 1. Prerequisites
Ensure you have **Node.js (v18+)** installed. Check your version with:
```bash
node -v
```

### 2. Install Dependencies
This project uses native Node.js APIs for downloading and serving files, so there are **zero external dependencies** required to run!

### 3. Pre-Download Model Weights
We host Face-API model weights locally to enable 100% offline startup. Run the following command to download the quantized neural weights (~7MB total) from the CDN into your `/models` folder:
```bash
node download-models.js
```

### 4. Fire up the Local Server
Start the static file server and synchronization endpoint:
```bash
node server.js
```
The server will boot up and display:
```text
=======================================================
  Pratyaksha local server is running at:
  👉 http://localhost:3000
  To test on another device on the same network, open:
  👉 http://<YOUR_LOCAL_IP>:3000
=======================================================
```

---

## 📱 Testing on a Mobile Phone (Secure Context Camera Rule)

Modern browsers enforce strict security guidelines: **Camera access (`getUserMedia`) is blocked unless running in a Secure Context** (either `localhost` or an `https://` domain).

To test Pratyaksha on your mobile phone over local Wi-Fi, choose one of the following methods:

### Method A: Browser Flags (Recommended & Easiest)
1. Find your computer's local IP address (e.g. `192.168.1.15`).
2. Open **Chrome** on your Android/iOS phone and type the following in the URL bar:
   ```text
   chrome://flags/#unsafely-treat-insecure-origin-as-secure
   ```
3. Enable the flag and input your computer's local URL in the text box:
   `http://192.168.1.15:3000`
4. Relaunch Chrome. Open `http://192.168.1.15:3000` on your phone. Camera access will be successfully granted!

### Method B: Port Forwarding (Android)
If your phone is connected to your computer via USB:
1. Open Chrome on your computer and navigate to: `chrome://inspect`
2. Click **Port forwarding...**
3. Add port `3000` mapping to `localhost:3000` and check "Enable port forwarding".
4. Open Chrome on your Android phone and navigate to `http://localhost:3000`. It treats this as local host and grants camera access directly!

---

## 🔍 Step-by-Step Testing Guide

1. **Dashboard Boot**: Open the application. Wait a few seconds for the neural models to load (indicated by green success pills on the Dashboard status card).
2. **Seed Mock Data**: Go to the **Diagnostics & System** tab and click **Seed Sample Employees**. This populates the database with 3 fictional workers and 7 days of historical logs to populate the charts.
3. **Register Yourself**:
   * Go to **Worker Enrollment**.
   * Enter your name, ID, and select a department.
   * Click **Start Face Capture** and look at the camera.
   * Follow the prompt guidance: look straight, look left, look right, look up, look down. Maintain each position for 1 second until the progress reaches 100%.
   * Click **Save & Register Employee**.
4. **Mark Attendance**:
   * Switch to the **Attendance Terminal** tab.
   * Stand in front of the camera. The system will detect your face.
   * To pass **Liveness Check**, blink your eyes. Once a blink is detected, the liveness step turns green.
   * The system will match your face descriptor against the database. If matched, a green overlay check-in chime sound plays and registers your log.
5. **Simulate Offline Sync**:
   * Toggle the **Network Sync** switch in the top bar to **Offline**.
   * Perform another check-in in the terminal.
   * Go to **Attendance Logs**. Notice the record shows **Pending (Local)** in amber.
   * Toggle the **Network Sync** switch back to **Online**.
   * The sync engine will trigger automatically. Watch the **Real-time System Logs** console in the Diagnostics view to see the payload batch transmission details. The sync logs in the server terminal will also output:
     ```text
     [Cloud DB] Received sync payload from device: PRATYAKSHA-DEV-10
     [Cloud DB] Processing 1 attendance records...
     - [Record Sync] Employee: Rahul Sharma (EMP-08392) | Type: Check-In | Status: Success
     ```
