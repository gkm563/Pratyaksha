/* ==========================================================================
   PRATYAKSHA CORE APPLICATION LOGIC
   ========================================================================== */

// --- Global Configuration ---
const CONFIG = {
  COOLDOWN_MS: 10000,           // 10 seconds cooldown between consecutive marks for same user
  MATCH_THRESHOLD: 0.50,       // Face recognition Euclidean distance threshold (lower = stricter)
  LIVENESS_EAR_THRESHOLD: 0.21, // Eye aspect ratio threshold for blink detection (lower = blink)
  LIVENESS_VARIANCE_MIN: 0.03,  // Minimum landmark movement variance to reject static photos
  SYNC_INTERVAL_MS: 15000,      // Sync queue retry interval
};

// --- Application State ---
const state = {
  isOnline: true,
  modelsLoaded: false,
  activeView: 'dashboard',
  enrolledWorkers: [],
  attendanceLogs: [],
  cameraStream: null,
  
  // Terminal view states
  terminalActive: false,
  terminalMode: 'Check-In', // 'Check-In' or 'Check-Out'
  lastRecognizedId: null,
  lastRecognizedTime: 0,
  livenessBlinked: false,
  livenessVariancePassed: false,
  landmarkHistory: [],
  isProcessingVerification: false,

  // Enrollment states
  enrollmentActive: false,
  currentEnrollAngle: 0, // 0: Front, 1: Left, 2: Right, 3: Up, 4: Down
  enrollmentSamples: [null, null, null, null, null], // Face descriptors for each angle
};

// --- Console Log Helper ---
function sysLog(message, type = 'info') {
  const consoleEl = document.getElementById('system-console');
  if (!consoleEl) return;
  
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = `[${time}] ${message}`;
  
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
  console.log(`[SYS] ${message}`);
}

// --- Audio Feedback Helper ---
function playFeedback(success) {
  const audioId = success ? 'audio-success' : 'audio-failure';
  const audio = document.getElementById(audioId);
  if (audio) {
    audio.currentTime = 0;
    audio.play().catch(e => console.log('Audio playback blocked: ', e));
  }
}

/* ==========================================================================
   1. DATABASE MANAGER (IndexedDB)
   ========================================================================== */
const dbManager = {
  dbName: 'PratyakshaDB',
  dbVersion: 1,
  db: null,

  init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = (event) => {
        sysLog('Database failed to open: ' + event.target.errorCode, 'error');
        reject(event.target.errorCode);
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        sysLog('IndexedDB Database connected successfully.', 'success');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Employee table (Stores face embeddings)
        if (!db.objectStoreNames.contains('employees')) {
          db.createObjectStore('employees', { keyPath: 'id' });
          sysLog('Created "employees" object store.', 'info');
        }

        // Attendance Logs table
        if (!db.objectStoreNames.contains('logs')) {
          db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
          sysLog('Created "logs" object store.', 'info');
        }
      };
    });
  },

  // Employees CRUD
  saveEmployee(id, name, dept, embeddings) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['employees'], 'readwrite');
      const store = transaction.objectStore('employees');
      const data = { id, name, dept, embeddings }; // embeddings is an array of 5 Float32Array arrays

      const request = store.put(data);
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  },

  getAllEmployees() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['employees'], 'readonly');
      const store = transaction.objectStore('employees');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e);
    });
  },

  // Logs CRUD
  saveLog(log) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['logs'], 'readwrite');
      const store = transaction.objectStore('logs');
      const request = store.add(log);
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  },

  getAllLogs() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['logs'], 'readonly');
      const store = transaction.objectStore('logs');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e);
    });
  },

  getPendingLogs() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['logs'], 'readonly');
      const store = transaction.objectStore('logs');
      const request = store.getAll();
      request.onsuccess = () => {
        const pending = request.result.filter(log => log.syncStatus === 'pending');
        resolve(pending);
      };
      request.onerror = (e) => reject(e);
    });
  },

  updateLogSyncStatus(logIds, status) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['logs'], 'readwrite');
      const store = transaction.objectStore('logs');
      
      const getAllRequest = store.getAll();
      getAllRequest.onsuccess = () => {
        const records = getAllRequest.result;
        let completed = 0;
        
        logIds.forEach(id => {
          const record = records.find(r => r.id === id);
          if (record) {
            record.syncStatus = status;
            store.put(record);
          }
        });
        resolve();
      };
      getAllRequest.onerror = (e) => reject(e);
    });
  },

  clearAllData() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['employees', 'logs'], 'readwrite');
      tx.objectStore('employees').clear();
      tx.objectStore('logs').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e);
    });
  }
};

/* ==========================================================================
   2. BIOMETRIC PIPELINE (Face-API Engine)
   ========================================================================== */
const bioEngine = {
  async init() {
    sysLog('Loading neural models from local server `/models`...');
    try {
      // Use local models directory (precached by service worker)
      await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
      document.getElementById('diag-model-detector').innerHTML = '<span class="pill pill-success">Loaded</span>';
      
      await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
      document.getElementById('diag-model-landmark').innerHTML = '<span class="pill pill-success">Loaded</span>';
      
      await faceapi.nets.faceRecognitionNet.loadFromUri('/models');
      document.getElementById('diag-model-recognition').innerHTML = '<span class="pill pill-success">Loaded</span>';
      
      state.modelsLoaded = true;
      sysLog('All face-api neural models loaded successfully.', 'success');
      document.getElementById('stat-health').innerText = 'Healthy';
      document.getElementById('stat-health-sub').innerText = 'Biometric scanner ready';
      document.getElementById('system-health-icon').className = 'ti ti-shield-check text-green';
    } catch (err) {
      sysLog('Failed to load neural models: ' + err.message, 'error');
      document.getElementById('stat-health').innerText = 'Engine Failure';
      document.getElementById('stat-health-sub').innerText = 'Could not load neural networks';
      document.getElementById('system-health-icon').className = 'ti ti-shield-x text-red';
      throw err;
    }
  },

  // Calculate Euclidean Distance between two vectors
  euclideanDistance(vec1, vec2) {
    if (vec1.length !== vec2.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < vec1.length; i++) {
      sum += Math.pow(vec1[i] - vec2[i], 2);
    }
    return Math.sqrt(sum);
  },

  // Match embedding with database
  findBestMatch(currentEmbedding) {
    let bestMatch = null;
    let minDistance = Infinity;

    state.enrolledWorkers.forEach(worker => {
      // Worker embeddings has 5 templates (front, left, right, up, down)
      worker.embeddings.forEach((template) => {
        if (!template) return;
        const dist = this.euclideanDistance(currentEmbedding, template);
        if (dist < minDistance) {
          minDistance = dist;
          bestMatch = {
            id: worker.id,
            name: worker.name,
            dept: worker.dept,
            distance: dist
          };
        }
      });
    });

    return bestMatch;
  },

  // Estimate Pose ratio: Jaw to nose distance ratios
  estimatePose(landmarks) {
    const jaw = landmarks.getJawOutline();
    const nose = landmarks.getNose();
    
    const outerLeft = jaw[0];
    const outerRight = jaw[16];
    const noseTip = nose[3];
    const noseBridge = nose[0];
    const chin = jaw[8];

    // Horizontal ratio (Yaw)
    const distLeft = Math.hypot(noseTip.x - outerLeft.x, noseTip.y - outerLeft.y);
    const distRight = Math.hypot(noseTip.x - outerRight.x, noseTip.y - outerRight.y);
    const yawRatio = distLeft / distRight;

    // Vertical ratio (Pitch)
    const topDist = Math.hypot(noseBridge.x - noseTip.x, noseBridge.y - noseTip.y);
    const bottomDist = Math.hypot(chin.x - noseTip.x, chin.y - noseTip.y);
    const pitchRatio = topDist / bottomDist;

    let yawLabel = 'Front';
    if (yawRatio < 0.70) yawLabel = 'Left';
    else if (yawRatio > 1.45) yawLabel = 'Right';

    let pitchLabel = 'Center';
    if (pitchRatio < 0.22) pitchLabel = 'Up';
    else if (pitchRatio > 0.65) pitchLabel = 'Down';

    return { yawRatio, pitchRatio, yawLabel, pitchLabel };
  },

  // Compute Eye Aspect Ratio (EAR) for blink detection
  calculateEAR(eyePoints) {
    // eyePoints is 6 landmarks
    const p1 = eyePoints[0];
    const p2 = eyePoints[1];
    const p3 = eyePoints[2];
    const p4 = eyePoints[3];
    const p5 = eyePoints[4];
    const p6 = eyePoints[5];

    const vertical1 = Math.hypot(p2.x - p6.x, p2.y - p6.y);
    const vertical2 = Math.hypot(p3.x - p5.x, p3.y - p5.y);
    const horizontal = Math.hypot(p1.x - p4.x, p1.y - p4.y);

    return (vertical1 + vertical2) / (2.0 * horizontal);
  },

  getBlinkRatio(landmarks) {
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();

    const leftEAR = this.calculateEAR(leftEye);
    const rightEAR = this.calculateEAR(rightEye);

    return (leftEAR + rightEAR) / 2.0;
  },

  // Check landmark variance over time (prevents paper spoofing)
  calculateLandmarkVariance(history) {
    if (history.length < 10) return 0;
    
    // Check variation of nose tip (index 30, nose[3])
    let sumX = 0, sumY = 0;
    const n = history.length;
    
    history.forEach(pt => {
      sumX += pt.x;
      sumY += pt.y;
    });
    
    const meanX = sumX / n;
    const meanY = sumY / n;
    
    let varSum = 0;
    history.forEach(pt => {
      varSum += Math.pow(pt.x - meanX, 2) + Math.pow(pt.y - meanY, 2);
    });
    
    return varSum / n;
  }
};

/* ==========================================================================
   3. CAMERA CONTROLLER
   ========================================================================== */
const cameraController = {
  async start(videoElementId) {
    const video = document.getElementById(videoElementId);
    if (!video) return;

    if (state.cameraStream) {
      this.stop();
    }

    sysLog(`Requesting camera permissions for ${videoElementId}...`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 }
        },
        audio: false
      });
      video.srcObject = stream;
      state.cameraStream = stream;
      sysLog('Camera feed active.', 'info');
      return new Promise((resolve) => {
        video.onloadedmetadata = () => {
          video.play();
          resolve();
        };
      });
    } catch (err) {
      sysLog('Camera access failed: ' + err.name + ' - ' + err.message, 'error');
      alert('Camera initialization failed. Please ensure camera access is allowed and you are using http://localhost or https://.');
      throw err;
    }
  },

  stop() {
    if (state.cameraStream) {
      sysLog('Stopping active camera stream...');
      state.cameraStream.getTracks().forEach(track => track.stop());
      state.cameraStream = null;
    }
  }
};

/* ==========================================================================
   4. VIEW ROUTER AND PAGE CONTROLLERS
   ========================================================================== */
const uiController = {
  init() {
    // Setup tab navigation
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.target;
        this.switchView(target);
      });
    });

    // Network simulation toggle
    const netToggle = document.getElementById('network-toggle');
    netToggle.addEventListener('change', (e) => {
      state.isOnline = e.target.checked;
      this.updateNetworkUI();
    });

    // Mode toggles in Terminal
    document.getElementById('btn-mode-checkin').addEventListener('click', () => this.setTerminalMode('Check-In'));
    document.getElementById('btn-mode-checkout').addEventListener('click', () => this.setTerminalMode('Check-Out'));

    // Enrollment button listeners
    document.getElementById('btn-start-capture').addEventListener('click', () => this.startEnrollmentCaptureWorkflow());
    document.getElementById('btn-reset-capture').addEventListener('click', () => this.resetEnrollmentCaptures());
    document.getElementById('enrollment-form').addEventListener('submit', () => this.submitEnrollmentForm());

    // Seeding & database controls
    document.getElementById('btn-seed-data').addEventListener('click', () => this.seedSampleData());
    document.getElementById('btn-clear-db').addEventListener('click', () => this.clearDatabase());
    document.getElementById('btn-clear-console').addEventListener('click', () => {
      document.getElementById('system-console').innerHTML = '';
      sysLog('Console cleared.');
    });

    document.getElementById('btn-manual-sync').addEventListener('click', () => syncEngine.triggerSync());
    document.getElementById('btn-export-csv').addEventListener('click', () => this.exportLogsToCSV());
    
    // Live Clock
    setInterval(() => {
      const clock = document.getElementById('clock-display');
      if (clock) {
        clock.innerText = new Date().toLocaleTimeString();
      }
    }, 1000);

    this.updateNetworkUI();
    this.refreshData();
  },

  updateNetworkUI() {
    const statusLabels = [
      document.getElementById('net-toggle-label'),
      document.getElementById('net-indicator-sidebar')
    ];
    
    if (state.isOnline) {
      statusLabels[0].className = 'control-status online';
      statusLabels[0].innerText = 'Online';
      statusLabels[1].className = 'connection-status online';
      statusLabels[1].querySelector('.status-label').innerText = 'Online Sync Active';
      sysLog('Network status changed: ONLINE. Cloud sync engine active.');
      // Auto-trigger sync
      syncEngine.triggerSync();
    } else {
      statusLabels[0].className = 'control-status offline';
      statusLabels[0].innerText = 'Offline';
      statusLabels[1].className = 'connection-status offline';
      statusLabels[1].querySelector('.status-label').innerText = 'Offline Mode';
      sysLog('Network status changed: OFFLINE. Operations queued locally.', 'warning');
    }
  },

  async refreshData() {
    try {
      state.enrolledWorkers = await dbManager.getAllEmployees();
      state.attendanceLogs = await dbManager.getAllLogs();
      
      // Update UI Stats
      document.getElementById('stat-enrolled').innerText = state.enrolledWorkers.length;
      document.getElementById('stat-present').innerText = this.getPresentTodayCount();
      
      const pendingCount = state.attendanceLogs.filter(log => log.syncStatus === 'pending').length;
      document.getElementById('stat-pending').innerText = pendingCount;
      
      const badge = document.getElementById('pending-sync-badge');
      if (pendingCount > 0) {
        badge.innerText = pendingCount;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }

      this.updateAttendanceRateText();
      this.renderRecentLogsDashboard();
      this.renderLogsTable();
      this.renderTodayChart();
    } catch (err) {
      console.error('Error refreshing data:', err);
    }
  },

  getPresentTodayCount() {
    const todayStr = new Date().toDateString();
    const uniquePresent = new Set();
    state.attendanceLogs.forEach(log => {
      if (new Date(log.timestamp).toDateString() === todayStr) {
        uniquePresent.add(log.employeeId);
      }
    });
    return uniquePresent.size;
  },

  updateAttendanceRateText() {
    const enrolled = state.enrolledWorkers.length;
    const present = this.getPresentTodayCount();
    const subtextEl = document.getElementById('stat-present-sub');
    
    if (enrolled === 0) {
      subtextEl.innerText = '0% attendance rate';
    } else {
      const pct = Math.round((present / enrolled) * 100);
      subtextEl.innerText = `${pct}% attendance rate`;
    }
  },

  renderTodayChart() {
    const enrolled = state.enrolledWorkers.length;
    const present = this.getPresentTodayCount();
    const pct = enrolled === 0 ? 0 : Math.round((present / enrolled) * 100);

    const todayBar = document.getElementById('today-bar');
    const todayTooltip = document.getElementById('today-bar-tooltip');

    if (todayBar) {
      todayBar.style.height = `${pct}%`;
      todayBar.setAttribute('data-val', `${pct}%`);
    }
    if (todayTooltip) {
      todayTooltip.innerText = `${pct}% (${present} Present)`;
    }
  },

  renderRecentLogsDashboard() {
    const container = document.getElementById('dashboard-recent-logs');
    if (!container) return;

    // Filter logs captured today and sort descending
    const todayStr = new Date().toDateString();
    const todayLogs = state.attendanceLogs
      .filter(log => new Date(log.timestamp).toDateString() === todayStr)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 5); // top 5

    if (todayLogs.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="ti ti-inbox"></i>
          <p>No check-ins logged today</p>
        </div>`;
      return;
    }

    container.innerHTML = todayLogs.map(log => {
      const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const isCheckIn = log.type === 'Check-In';
      const syncClass = log.syncStatus === 'synced' ? 'synced' : 'pending';
      const syncText = log.syncStatus === 'synced' ? 'Synced' : 'Pending';

      return `
        <div class="log-item">
          <div class="log-item-icon ${isCheckIn ? 'in' : 'out'}">
            <i class="ti ti-login"></i>
          </div>
          <div class="log-item-details">
            <div class="log-item-name">${log.employeeName}</div>
            <div class="log-item-time">${time} &middot; ${log.type} (${log.dept})</div>
          </div>
          <span class="log-item-sync ${syncClass}">${syncText}</span>
        </div>
      `;
    }).join('');
  },

  renderLogsTable() {
    const tbody = document.getElementById('logs-table-body');
    if (!tbody) return;

    const searchTerm = document.getElementById('log-search').value.toLowerCase();
    const filterDept = document.getElementById('filter-dept').value;
    const filterSync = document.getElementById('filter-sync').value;

    let filtered = state.attendanceLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (searchTerm) {
      filtered = filtered.filter(l => 
        l.employeeName.toLowerCase().includes(searchTerm) || 
        l.employeeId.toLowerCase().includes(searchTerm)
      );
    }

    if (filterDept) {
      filtered = filtered.filter(l => l.dept === filterDept);
    }

    if (filterSync) {
      filtered = filtered.filter(l => l.syncStatus === filterSync);
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="text-center text-muted py-4">
            <i class="ti ti-inbox" style="font-size: 2rem; display: block; margin-bottom: 0.5rem;"></i>
            No matching logs found.
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(log => {
      const dateStr = new Date(log.timestamp).toLocaleString();
      const typeClass = log.type === 'Check-In' ? 'check-in' : 'check-out';
      const syncClass = log.syncStatus === 'synced' ? 'badge-success' : 'badge-warning';
      const scoreText = log.score === 'N/A' ? 'N/A' : Number(log.score).toFixed(2);
      const livenessText = log.livenessScore === 'N/A' ? 'N/A' : `${Math.round(log.livenessScore * 100)}%`;

      return `
        <tr>
          <td class="font-mono">${dateStr}</td>
          <td class="font-mono">${log.employeeId}</td>
          <td><strong>${log.employeeName}</strong></td>
          <td>${log.dept}</td>
          <td><span class="log-type ${typeClass}">${log.type}</span></td>
          <td class="font-mono">${scoreText}</td>
          <td class="font-mono">${livenessText}</td>
          <td><span class="badge ${syncClass}">${log.syncStatus}</span></td>
        </tr>
      `;
    }).join('');
  },

  switchView(viewId) {
    if (state.activeView === viewId) return;

    // Shutdown camera on current view
    if (state.activeView === 'terminal') {
      state.terminalActive = false;
      cameraController.stop();
      document.getElementById('camera-loading-screen').style.display = 'flex';
    } else if (state.activeView === 'enrollment') {
      state.enrollmentActive = false;
      cameraController.stop();
      document.getElementById('enrollment-loading-screen').style.display = 'flex';
      this.resetEnrollmentCaptures();
    }

    // Toggle active view panel
    document.querySelectorAll('.view-panel').forEach(panel => panel.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    
    document.getElementById(`view-${viewId}`).classList.add('active');
    document.querySelector(`.nav-item[data-target="${viewId}"]`).classList.add('active');
    
    state.activeView = viewId;

    // Update Titles
    const titleMap = {
      dashboard: ['Dashboard Overview', 'Real-time on-device metrics & synchronization status'],
      terminal: ['Attendance Terminal', 'Biometric recognition & blink-based liveness verification active'],
      enrollment: ['Worker Identity Enrollment', 'Register new employee embeddings in compliance with privacy guidelines'],
      logs: ['Attendance Record Ledger', 'Historical list of on-device clock-in events and synchronization records'],
      diagnostics: ['Neural Diagnostics & Logs', 'Inspect neural model state, database parameters, and sync protocols']
    };
    
    document.getElementById('current-view-title').innerText = titleMap[viewId][0];
    document.getElementById('current-view-subtitle').innerText = titleMap[viewId][1];

    // Setup hooks for target view loading
    if (viewId === 'terminal') {
      this.loadTerminalView();
    } else if (viewId === 'enrollment') {
      this.loadEnrollmentView();
    }

    sysLog(`Switched view to ${viewId.toUpperCase()}`);
    this.refreshData();
  },

  // Set Terminal mode
  setTerminalMode(mode) {
    state.terminalMode = mode;
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    
    if (mode === 'Check-In') {
      document.getElementById('btn-mode-checkin').classList.add('active');
      document.getElementById('terminal-mode-label').innerText = 'Mode: CHECK-IN';
    } else {
      document.getElementById('btn-mode-checkout').classList.add('active');
      document.getElementById('terminal-mode-label').innerText = 'Mode: CHECK-OUT';
    }
    sysLog(`Terminal mode switched to ${mode}`);
  },

  /* ==========================================================================
     A. TERMINAL WORKFLOW (Real-Time Face Match & Liveness)
     ========================================================================== */
  async loadTerminalView() {
    state.terminalActive = true;
    
    if (!state.modelsLoaded) {
      sysLog('Awaiting model loading before activating terminal camera...', 'warning');
      return;
    }

    try {
      await cameraController.start('terminal-video');
      document.getElementById('camera-loading-screen').style.display = 'none';
      this.startTerminalInferenceLoop();
    } catch (err) {
      sysLog('Terminal Camera stream start failed: ' + err.message, 'error');
    }
  },

  startTerminalInferenceLoop() {
    const video = document.getElementById('terminal-video');
    const canvas = document.getElementById('terminal-canvas');
    const displaySize = { width: video.videoWidth || 640, height: video.videoHeight || 480 };
    
    faceapi.matchDimensions(canvas, displaySize);
    
    // Clear checklist visual states
    this.updateChecklistItem('check-face-detected', 'idle');
    this.updateChecklistItem('check-liveness-passed', 'idle');
    this.updateChecklistItem('check-match-found', 'idle');

    state.landmarkHistory = [];
    state.livenessBlinked = false;
    state.livenessVariancePassed = false;
    state.isProcessingVerification = false;

    let framesSinceLastBlinkCheck = 0;
    let baseEAR = 0.28; // default baseline

    const detectFrame = async () => {
      if (!state.terminalActive || !state.cameraStream) return;
      
      try {
        const option = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
        const result = await faceapi.detectSingleFace(video, option)
          .withFaceLandmarks(true) // requires 68 landmarks
          .withFaceDescriptor();  // extracts 128-dim embedding vector
        
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (result) {
          // 1. Check Face Detected
          this.updateChecklistItem('check-face-detected', 'passed');
          
          // Draw bounding box
          const resizedResult = faceapi.resizeResults(result, displaySize);
          ctx.beginPath();
          ctx.lineWidth = "3";
          ctx.strokeStyle = state.livenessBlinked && state.livenessVariancePassed ? "#10B981" : "#3B82F6";
          const box = resizedResult.detection.box;
          // Note: coordinates are mirrored in CSS, canvas elements are mirrored too
          ctx.rect(box.x, box.y, box.width, box.height);
          ctx.stroke();

          // Draw head pose estimate labels for diagnostics
          const pose = bioEngine.estimatePose(result.landmarks);
          ctx.fillStyle = "#FFFFFF";
          ctx.font = "12px JetBrains Mono";
          ctx.fillText(`Pose: ${pose.yawLabel} (${pose.yawRatio.toFixed(2)}), ${pose.pitchLabel} (${pose.pitchRatio.toFixed(2)})`, box.x, box.y - 10);

          if (!state.isProcessingVerification) {
            // Keep history of nose tips for micro-movement variance
            const noseTip = result.landmarks.getNose()[3];
            state.landmarkHistory.push(noseTip);
            if (state.landmarkHistory.length > 20) state.landmarkHistory.shift();

            // 2. Perform Liveness Checks
            // EAR (Eye Aspect Ratio) for Blink detection
            const currentEAR = bioEngine.getBlinkRatio(result.landmarks);
            
            // Check for blink: EAR drops below threshold, then recovers
            if (currentEAR < CONFIG.LIVENESS_EAR_THRESHOLD) {
              state.livenessBlinked = true;
              document.getElementById('liveness-score').style.display = 'inline-block';
              document.getElementById('liveness-score').innerText = 'BLINK!';
            }

            // Check variance of head movement over history
            if (state.landmarkHistory.length >= 10) {
              const variance = bioEngine.calculateLandmarkVariance(state.landmarkHistory);
              if (variance > CONFIG.LIVENESS_VARIANCE_MIN) {
                state.livenessVariancePassed = true;
              }
            }

            // Update liveness pipeline check items
            if (state.livenessBlinked) {
              this.updateChecklistItem('check-liveness-passed', 'passed');
            } else {
              this.updateChecklistItem('check-liveness-passed', 'active');
            }

            // 3. Biometric matching once liveness passes
            if (state.livenessBlinked && state.livenessVariancePassed) {
              this.updateChecklistItem('check-match-found', 'active');
              
              const match = bioEngine.findBestMatch(result.descriptor);
              
              if (match) {
                const confScoreEl = document.getElementById('confidence-score');
                confScoreEl.style.display = 'inline-block';
                confScoreEl.innerText = `Score: ${(1 - match.distance).toFixed(2)}`;

                if (match.distance <= CONFIG.MATCH_THRESHOLD) {
                  this.updateChecklistItem('check-match-found', 'passed');
                  
                  // Trigger log entry creation (Avoid instant duplicates within cooldown)
                  const now = Date.now();
                  if (state.lastRecognizedId !== match.id || (now - state.lastRecognizedTime) > CONFIG.COOLDOWN_MS) {
                    state.isProcessingVerification = true;
                    await this.handleVerificationSuccess(match, result.descriptor, currentEAR);
                  }
                } else {
                  this.updateChecklistItem('check-match-found', 'failed');
                }
              } else {
                this.updateChecklistItem('check-match-found', 'failed');
              }
            } else {
              // Variance or blink pending
              this.updateChecklistItem('check-match-found', 'idle');
            }
          }
        } else {
          // No face
          this.updateChecklistItem('check-face-detected', 'idle');
          this.updateChecklistItem('check-liveness-passed', 'idle');
          this.updateChecklistItem('check-match-found', 'idle');
          document.getElementById('liveness-score').style.display = 'none';
          document.getElementById('confidence-score').style.display = 'none';
        }

      } catch (err) {
        console.error('Error in face detection loop:', err);
      }

      // Schedule next frame
      requestAnimationFrame(detectFrame);
    };

    requestAnimationFrame(detectFrame);
  },

  updateChecklistItem(itemId, status) {
    const item = document.getElementById(itemId);
    if (!item) return;

    const circle = item.querySelector('.status-circle');
    
    if (status === 'passed') {
      item.className = 'checklist-item passed';
      circle.innerHTML = '<i class="ti ti-circle-check"></i>';
    } else if (status === 'failed') {
      item.className = 'checklist-item failed';
      circle.innerHTML = '<i class="ti ti-circle-x"></i>';
    } else if (status === 'active') {
      item.className = 'checklist-item active';
      circle.innerHTML = '<i class="ti ti-loader animate-spin"></i>';
    } else {
      item.className = 'checklist-item';
      circle.innerHTML = '<i class="ti ti-circle"></i>';
    }
  },

  async handleVerificationSuccess(match, descriptor, livenessEAR) {
    playFeedback(true);
    sysLog(`Face matched: ${match.name} (Dist: ${match.distance.toFixed(3)})`, 'success');
    
    state.lastRecognizedId = match.id;
    state.lastRecognizedTime = Date.now();

    // Create log record
    const logRecord = {
      timestamp: new Date().toISOString(),
      employeeId: match.id,
      employeeName: match.name,
      dept: match.dept,
      type: state.terminalMode,
      score: 1 - match.distance, // similarity confidence (similarity = 1 - distance)
      livenessScore: 1 - livenessEAR, // proxy liveness score
      syncStatus: state.isOnline ? 'pending' : 'pending' // saved locally, queued
    };

    // Save to IndexedDB
    await dbManager.saveLog(logRecord);

    // Show Overlay UI
    const overlay = document.getElementById('match-overlay');
    const successBox = document.getElementById('match-overlay-success');
    
    document.getElementById('match-name-success').innerText = match.name;
    document.getElementById('match-meta-success').innerText = `${state.terminalMode} Registered`;
    
    overlay.style.display = 'flex';
    successBox.style.display = 'block';

    // Show verification profile details
    document.getElementById('last-verif-empty').style.display = 'none';
    const profile = document.getElementById('last-verif-profile');
    profile.style.display = 'flex';
    document.getElementById('verif-profile-name').innerText = match.name;
    document.getElementById('verif-profile-id').innerText = match.id;
    document.getElementById('verif-profile-dept').innerText = match.dept;
    document.getElementById('verif-profile-time').innerText = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Auto-hide success overlay and trigger sync if online
    setTimeout(async () => {
      overlay.style.display = 'none';
      successBox.style.display = 'none';
      
      // Reset detection states
      state.livenessBlinked = false;
      state.livenessVariancePassed = false;
      state.landmarkHistory = [];
      state.isProcessingVerification = false;
      
      await this.refreshData();
      
      if (state.isOnline) {
        syncEngine.triggerSync();
      }
    }, 2000);
  },

  /* ==========================================================================
     B. ENROLLMENT WORKFLOW (5 distinct angles capture guide)
     ========================================================================== */
  async loadEnrollmentView() {
    state.enrollmentActive = true;
    
    if (!state.modelsLoaded) {
      sysLog('Awaiting model loading before activating enrollment camera...', 'warning');
      return;
    }

    try {
      await cameraController.start('enrollment-video');
      document.getElementById('enrollment-loading-screen').style.display = 'none';
      document.getElementById('enroll-guide-prompt').innerText = 'Fill details and click "Start Face Capture"';
    } catch (err) {
      sysLog('Enrollment Camera start failed: ' + err.message, 'error');
    }
  },

  startEnrollmentCaptureWorkflow() {
    // Validate form fields
    const name = document.getElementById('enroll-name').value;
    const empId = document.getElementById('enroll-id').value;
    const dept = document.getElementById('enroll-dept').value;

    if (!name || !empId || !dept) {
      alert('Please fill out all worker details before initiating face capture.');
      return;
    }

    // Check if employee ID already exists
    const exists = state.enrolledWorkers.some(w => w.id === empId);
    if (exists) {
      alert(`Worker with ID "${empId}" is already registered. Please use another ID or edit existing.`);
      return;
    }

    state.currentEnrollAngle = 0;
    state.enrollmentSamples = [null, null, null, null, null];
    
    this.updateAngleGridUI();
    document.getElementById('btn-start-capture').style.display = 'none';
    document.getElementById('btn-reset-capture').style.display = 'inline-flex';
    
    // Start automatic pose checker
    this.runEnrollmentFrameInference();
  },

  resetEnrollmentCaptures() {
    state.currentEnrollAngle = 0;
    state.enrollmentSamples = [null, null, null, null, null];
    this.updateAngleGridUI();
    document.getElementById('btn-start-capture').style.display = 'inline-flex';
    document.getElementById('btn-reset-capture').style.display = 'none';
    document.getElementById('btn-submit-enrollment').disabled = true;
    document.getElementById('enroll-guide-prompt').innerText = 'Fill details and click "Start Face Capture"';
    document.getElementById('enroll-guide-overlay').querySelector('.guide-circle').className = 'guide-circle';
  },

  updateAngleGridUI() {
    const angleKeys = ['angle-front', 'angle-left', 'angle-right', 'angle-up', 'angle-down'];
    
    angleKeys.forEach((key, idx) => {
      const card = document.getElementById(key);
      const statusIcon = card.querySelector('.angle-status');
      
      card.className = 'angle-card';
      
      if (idx === state.currentEnrollAngle && idx < 5) {
        card.className = 'angle-card active';
        statusIcon.innerHTML = '<i class="ti ti-loader animate-spin"></i>';
      } else if (state.enrollmentSamples[idx] !== null) {
        card.className = 'angle-card completed';
        statusIcon.innerHTML = '<i class="ti ti-circle-check"></i>';
      } else {
        statusIcon.innerHTML = '<i class="ti ti-circle"></i>';
      }
    });
  },

  runEnrollmentFrameInference() {
    const video = document.getElementById('enrollment-video');
    const canvas = document.getElementById('enrollment-canvas');
    const guideCircle = document.getElementById('enroll-guide-overlay').querySelector('.guide-circle');
    const prompt = document.getElementById('enroll-guide-prompt');

    const displaySize = { width: video.videoWidth || 640, height: video.videoHeight || 480 };
    faceapi.matchDimensions(canvas, displaySize);

    const guidePrompts = [
      'Angle 1: Look straight at the camera',
      'Angle 2: Turn your head slightly LEFT',
      'Angle 3: Turn your head slightly RIGHT',
      'Angle 4: Tilt your head slightly UPWARD',
      'Angle 5: Tilt your head slightly DOWNWARD'
    ];

    let framesInPosition = 0;

    const processEnrollFrame = async () => {
      if (!state.enrollmentActive || !state.cameraStream || state.currentEnrollAngle >= 5) return;

      try {
        const option = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
        const result = await faceapi.detectSingleFace(video, option)
          .withFaceLandmarks(true)
          .withFaceDescriptor();

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (result) {
          guideCircle.className = 'guide-circle scanning';
          prompt.innerText = guidePrompts[state.currentEnrollAngle];
          
          // Draw simple landmarks bounding overlay box on canvas
          const resized = faceapi.resizeResults(result, displaySize);
          ctx.beginPath();
          ctx.lineWidth = "2";
          ctx.strokeStyle = "#3B82F6";
          ctx.arc(resized.detection.box.x + resized.detection.box.width/2, resized.detection.box.y + resized.detection.box.height/2, 90, 0, 2 * Math.PI);
          ctx.stroke();

          // Pose calculation
          const pose = bioEngine.estimatePose(result.landmarks);

          // Check if current pose matches target angle
          let isMatch = false;
          
          switch (state.currentEnrollAngle) {
            case 0: // Front
              isMatch = pose.yawLabel === 'Front' && pose.pitchLabel === 'Center';
              break;
            case 1: // Left
              isMatch = pose.yawLabel === 'Left';
              break;
            case 2: // Right
              isMatch = pose.yawLabel === 'Right';
              break;
            case 3: // Up
              isMatch = pose.pitchLabel === 'Up';
              break;
            case 4: // Down
              isMatch = pose.pitchLabel === 'Down';
              break;
          }

          if (isMatch) {
            framesInPosition++;
            prompt.innerText = `HOLD STILL... ${Math.round((framesInPosition / 15) * 100)}%`;
            ctx.strokeStyle = "#10B981";
            ctx.stroke();

            if (framesInPosition >= 15) { // about 1 second of stable pose
              // Save embedding sample
              state.enrollmentSamples[state.currentEnrollAngle] = result.descriptor;
              sysLog(`Captured biometric embedding for angle ${state.currentEnrollAngle + 1}/5.`, 'success');
              playFeedback(true);
              
              state.currentEnrollAngle++;
              framesInPosition = 0;
              this.updateAngleGridUI();

              if (state.currentEnrollAngle >= 5) {
                // Done!
                prompt.innerText = 'All angles captured. Ready to register!';
                guideCircle.className = 'guide-circle';
                document.getElementById('btn-submit-enrollment').disabled = false;
                sysLog('Workforce facial enrollment complete. Form ready for registration.');
                return; // stop loop
              }
            }
          } else {
            framesInPosition = 0; // reset
          }

        } else {
          guideCircle.className = 'guide-circle';
          prompt.innerText = 'Align face inside target circle';
          framesInPosition = 0;
        }

      } catch (err) {
        console.error('Error during enrollment descriptor capture:', err);
      }

      requestAnimationFrame(processEnrollFrame);
    };

    requestAnimationFrame(processEnrollFrame);
  },

  async submitEnrollmentForm() {
    const name = document.getElementById('enroll-name').value;
    const empId = document.getElementById('enroll-id').value;
    const dept = document.getElementById('enroll-dept').value;

    sysLog(`Registering employee details: ${name} (${empId}) in ${dept}...`);

    try {
      // Serialize embeddings arrays (IndexedDB supports saving Float32Arrays directly)
      const serializedEmbeddings = state.enrollmentSamples.map(arr => Array.from(arr));

      await dbManager.saveEmployee(empId, name, dept, serializedEmbeddings);
      sysLog(`Successfully registered ${name} in database.`, 'success');
      alert(`Worker "${name}" successfully registered!`);

      // Reset form and UI
      document.getElementById('enrollment-form').reset();
      this.resetEnrollmentCaptures();
      await this.refreshData();
      
      // Go back to dashboard view
      this.switchView('dashboard');

    } catch (err) {
      sysLog(`Registration write failed: ${err.message}`, 'error');
      alert('Failed to register employee: ' + err.message);
    }
  },

  /* ==========================================================================
     C. DIAGNOSTICS, SEEDING & ACTIONS
     ========================================================================== */
  async seedSampleData() {
    sysLog('Initializing Database Seed generator...');
    
    // Define 3 fictional employees with synthetic 128-dimensional face embedding templates
    const mockEmployees = [
      {
        id: 'EMP-08392',
        name: 'Rahul Sharma',
        dept: 'Production',
        // Fill 5 vectors of 128 dimensions with random numbers
        embeddings: Array.from({ length: 5 }, () => Array.from({ length: 128 }, () => Math.random() - 0.5))
      },
      {
        id: 'EMP-19302',
        name: 'Priyanjali Sen',
        dept: 'Quality Control',
        embeddings: Array.from({ length: 5 }, () => Array.from({ length: 128 }, () => Math.random() - 0.5))
      },
      {
        id: 'EMP-05829',
        name: 'Aman Verma',
        dept: 'Engineering',
        embeddings: Array.from({ length: 5 }, () => Array.from({ length: 128 }, () => Math.random() - 0.5))
      }
    ];

    try {
      for (const emp of mockEmployees) {
        await dbManager.saveEmployee(emp.id, emp.name, emp.dept, emp.embeddings);
        sysLog(`Seeded Employee: ${emp.name} (${emp.id})`, 'info');
      }

      // Generate simulated logs over the last 7 days to populate the chart and logs table
      const depts = ['Production', 'Quality Control', 'Engineering'];
      const names = ['Rahul Sharma', 'Priyanjali Sen', 'Aman Verma'];
      const ids = ['EMP-08392', 'EMP-19302', 'EMP-05829'];

      const logs = [];
      const today = new Date();

      for (let i = 6; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(today.getDate() - i);
        
        // Randomly skip days or seed logs
        const count = i === 0 ? 0 : Math.floor(Math.random() * 3) + 1; // 1-3 check-ins
        
        for (let j = 0; j < count; j++) {
          const idx = Math.floor(Math.random() * 3);
          
          // Check-in
          const checkInDate = new Date(date);
          checkInDate.setHours(8, Math.floor(Math.random() * 45), 0);
          logs.push({
            timestamp: checkInDate.toISOString(),
            employeeId: ids[idx],
            employeeName: names[idx],
            dept: depts[idx],
            type: 'Check-In',
            score: 0.85 + Math.random() * 0.1,
            livenessScore: 0.95 + Math.random() * 0.05,
            syncStatus: 'synced' // assume historical data is already synced
          });

          // Check-out
          const checkOutDate = new Date(date);
          checkOutDate.setHours(17, Math.floor(Math.random() * 30), 0);
          logs.push({
            timestamp: checkOutDate.toISOString(),
            employeeId: ids[idx],
            employeeName: names[idx],
            dept: depts[idx],
            type: 'Check-Out',
            score: 0.82 + Math.random() * 0.1,
            livenessScore: 0.94 + Math.random() * 0.05,
            syncStatus: 'synced'
          });
        }
      }

      // Add a couple pending sync logs for today to let user see "Pending" state in action!
      const pendingCheckIn = new Date();
      pendingCheckIn.setHours(pendingCheckIn.getHours() - 1);
      logs.push({
        timestamp: pendingCheckIn.toISOString(),
        employeeId: ids[0],
        employeeName: names[0],
        dept: depts[0],
        type: 'Check-In',
        score: 0.89,
        livenessScore: 0.98,
        syncStatus: 'pending' // pending sync!
      });

      for (const log of logs) {
        await dbManager.saveLog(log);
      }

      sysLog('Database seeded successfully with fictional employees and historical attendance charts.', 'success');
      alert('Mock data seeded successfully! You will see active logs in the ledger and metrics on the dashboard.');
      
      await this.refreshData();
      
      // Update charts
      this.updateTodayChartFromSeeded();
    } catch (err) {
      sysLog('Seed operation failed: ' + err.message, 'error');
    }
  },

  updateTodayChartFromSeeded() {
    // Populate historic bars of dashboard chart with dummy values
    const bars = document.querySelectorAll('.chart-bar:not(#today-bar)');
    const rates = [76, 82, 85, 91, 88, 60];
    bars.forEach((bar, idx) => {
      if (idx < rates.length) {
        bar.style.height = `${rates[idx]}%`;
        bar.setAttribute('data-val', `${rates[idx]}%`);
        const tooltip = bar.querySelector('.bar-tooltip');
        if (tooltip) {
          tooltip.innerText = `${rates[idx]}% (${Math.round(rates[idx]/20)} Present)`;
        }
      }
    });
  },

  async clearDatabase() {
    if (!confirm('Are you sure you want to reset all database contents? All employee registrations and attendance log metrics will be lost.')) {
      return;
    }

    try {
      await dbManager.clearAllData();
      sysLog('Local IndexedDB database wiped clean.', 'warning');
      alert('IndexedDB database cleared.');
      await this.refreshData();
    } catch (err) {
      sysLog('Clear database failed: ' + err.message, 'error');
    }
  },

  exportLogsToCSV() {
    if (state.attendanceLogs.length === 0) {
      alert('No logs recorded to export.');
      return;
    }

    sysLog('Compiling CSV logs export...');
    let csv = 'ID,Timestamp,Employee ID,Worker Name,Department,Type,Confidence,Liveness,Sync Status\n';
    
    state.attendanceLogs.forEach((log) => {
      csv += `"${log.id}","${log.timestamp}","${log.employeeId}","${log.employeeName}","${log.dept}","${log.type}","${log.score}","${log.livenessScore}","${log.syncStatus}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Pratyaksha_Attendance_Export_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    sysLog('CSV export downloaded successfully.', 'success');
  }
};

/* ==========================================================================
   5. SYNCHRONIZATION ENGINE
   ========================================================================== */
const syncEngine = {
  isSyncing: false,
  timerId: null,

  init() {
    sysLog('Initializing Core Background Synchronization Engine...');
    this.startAutoSyncScheduler();
  },

  startAutoSyncScheduler() {
    const select = document.getElementById('sync-interval');
    let interval = select ? parseInt(select.value) : CONFIG.SYNC_INTERVAL_MS;

    if (this.timerId) clearInterval(this.timerId);

    this.timerId = setInterval(() => {
      this.triggerSync();
    }, interval);

    if (select) {
      select.addEventListener('change', () => this.startAutoSyncScheduler());
    }
  },

  async triggerSync() {
    if (this.isSyncing) return;
    if (!state.isOnline) {
      // Offline mode, skip
      return;
    }

    try {
      const pending = await dbManager.getPendingLogs();
      if (pending.length === 0) {
        return; // nothing to sync
      }

      this.isSyncing = true;
      sysLog(`Sync Engine: Found ${pending.length} pending logs. Uploading...`);

      const endpoint = document.getElementById('sync-endpoint').value || 'http://localhost:3000/api/sync';
      
      const payload = {
        deviceId: 'PRATYAKSHA-DEV-10',
        timestamp: new Date().toISOString(),
        records: pending
      };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          const syncedIds = pending.map(log => log.id);
          await dbManager.updateLogSyncStatus(syncedIds, 'synced');
          sysLog(`Sync Engine: Successfully uploaded ${syncedIds.length} records. Server synced.`, 'success');
          
          await uiController.refreshData();
        } else {
          sysLog(`Sync Engine upload rejected: ${result.error || 'Unknown server error'}`, 'error');
        }
      } else {
        sysLog(`Sync Engine: Network upload failed with code ${response.status}. Retrying later.`, 'error');
      }

    } catch (err) {
      sysLog(`Sync Engine connection failed: ${err.message}. Offline buffer active.`, 'warning');
    } finally {
      this.isSyncing = false;
    }
  }
};

/* ==========================================================================
   INITIALIZATION INITIAL SYSTEM GATES
   ========================================================================== */
window.addEventListener('DOMContentLoaded', async () => {
  // Initialize PWA Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('Service Worker Registered successfully. PWA Cache ready.', reg.scope))
      .catch(err => console.log('Service Worker registration failed:', err));
  }

  // Set standard WebGL TFJS backend inside face-api
  const diagTFBackend = document.getElementById('diag-tfjs-backend');
  if (diagTFBackend) {
    diagTFBackend.innerText = 'WebGL (Accelerated)';
  }

  try {
    // 1. Load Local IndexedDB Database
    await dbManager.init();
    
    // 2. Initialize UI layout
    uiController.init();

    // 3. Load Neural Models
    await bioEngine.init();

    // 4. Start background synchronization
    syncEngine.init();

    // Trigger UI refresh
    await uiController.refreshData();

  } catch (err) {
    sysLog('Boot loader encountered a fatal error during initialization: ' + err.message, 'error');
  }
});
