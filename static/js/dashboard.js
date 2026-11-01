(() => {
  "use strict";

  const FRAME_INTERVAL_MS = 100;
  const MAX_HISTORY_POINTS = 600;
  const video = document.getElementById("camera-video");
  const frameCanvas = document.getElementById("frame-canvas");
  const startButton = document.getElementById("start-button");
  const stopButton = document.getElementById("stop-button");
  const resetButton = document.getElementById("reset-button");
  const exportButton = document.getElementById("export-button");
  const pdfExportButton = document.getElementById("pdf-export-button");
  const connectionStatus = document.getElementById("connection-status");
  const connectionDot = document.getElementById("connection-dot");
  const alertBanner = document.getElementById("alert-banner");
  const errorBanner = document.getElementById("error-banner");
  const cameraPlaceholder = document.getElementById("camera-placeholder");
  const scanOverlay = document.getElementById("scan-overlay");
  const frameContext = frameCanvas.getContext("2d", { alpha: false });

  let cameraStream = null;
  let socket = null;
  let frameTimer = null;
  let sessionTimer = null;
  let sessionStartedAt = 0;
  let lastAlert = "";
  let audioContext = null;
  let latestMetrics = null;
  let currentSecondSamples = [];
  let currentBucketSecond = -1;
  const sessionLog = [];

  const chart = new Chart(document.getElementById("attention-chart"), {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Focus score",
          data: [],
          borderColor: "#67e8f9",
          backgroundColor: "rgba(103,232,249,.12)",
          fill: true,
          tension: 0.32,
          pointRadius: 0,
          borderWidth: 2,
          yAxisID: "score",
        },
        {
          label: "EAR",
          data: [],
          borderColor: "#c4b5fd",
          tension: 0.32,
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "ear",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { labels: { color: "#94a3b8", usePointStyle: true, boxWidth: 7, font: { family: "Manrope", size: 11 } } },
      },
      scales: {
        x: { ticks: { color: "#64748b", maxTicksLimit: 8 }, grid: { color: "rgba(100,116,139,.12)" } },
        score: { min: 0, max: 100, position: "left", ticks: { color: "#64748b" }, grid: { color: "rgba(100,116,139,.12)" } },
        ear: { min: 0, max: 0.6, position: "right", ticks: { color: "#64748b" }, grid: { drawOnChartArea: false } },
      },
    },
  });

  function setConnection(status, tone) {
    connectionStatus.textContent = status;
    connectionDot.className = `h-2 w-2 rounded-full ${tone}`;
  }

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.classList.remove("hidden");
  }

  function clearError() {
    errorBanner.textContent = "";
    errorBanner.classList.add("hidden");
  }

  function resetMetrics() {
    document.getElementById("current-state").textContent = "Waiting";
    document.getElementById("current-state").className = "mt-2 text-2xl font-extrabold text-slate-300";
    document.getElementById("focus-score").textContent = "—";
    document.getElementById("focus-meter").style.width = "0%";
    document.getElementById("metric-ear").textContent = "—";
    document.getElementById("metric-blinks").textContent = "—";
    document.getElementById("metric-gaze").textContent = "—";
    document.getElementById("pose-yaw").textContent = "—";
    document.getElementById("pose-pitch").textContent = "—";
    document.getElementById("pose-roll").textContent = "—";
    document.getElementById("face-detected").textContent = "—";
    document.getElementById("state-icon").textContent = "◎";
    document.getElementById("state-icon").className = "flex h-11 w-11 items-center justify-center rounded-xl bg-slate-800 text-slate-400";
  }

  function formatElapsed(seconds) {
    const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
    const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remainder}`;
  }

  function updateTimer() {
    if (sessionStartedAt) {
      const elapsedSeconds = Math.floor((Date.now() - sessionStartedAt) / 1000);
      document.getElementById("session-timer").textContent = formatElapsed(elapsedSeconds);
      finalizeBucketsBefore(elapsedSeconds);
    }
  }

  function average(samples, key) {
    const values = samples.map((sample) => sample[key]).filter(Number.isFinite);
    return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
  }

  function mostCommon(samples, key, fallback) {
    const counts = new Map();
    samples.forEach((sample) => {
      const value = sample[key];
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || fallback;
  }

  function buildSecondRecord(second, samples) {
    const latest = samples[samples.length - 1] || latestMetrics;
    const poseSamples = samples.map((sample) => sample.head_pose).filter(Boolean);
    const meanPose = (key) => {
      const values = poseSamples.map((pose) => pose[key]).filter(Number.isFinite);
      return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
    };
    return {
      second: second + 1,
      elapsed: formatElapsed(second + 1),
      timestamp: new Date(sessionStartedAt + second * 1000).toISOString(),
      state: mostCommon(samples, "state", latest?.state || "No data"),
      focusScore: average(samples, "focus_score"),
      ear: average(samples, "ear"),
      blinkRate: average(samples, "blink_rate"),
      gaze: mostCommon(samples, "gaze", "Unavailable"),
      yaw: meanPose("yaw"),
      pitch: meanPose("pitch"),
      roll: meanPose("roll"),
      faceDetected: samples.some((sample) => sample.face_detected),
      samples: samples.length,
    };
  }

  function finalizeBucketsBefore(elapsedSecond) {
    while (currentBucketSecond >= 0 && currentBucketSecond < elapsedSecond) {
      sessionLog.push(buildSecondRecord(currentBucketSecond, currentSecondSamples));
      currentBucketSecond += 1;
      currentSecondSamples = [];
      exportButton.disabled = sessionLog.length === 0;
      pdfExportButton.disabled = sessionLog.length === 0;
    }
  }

  function finalizeCurrentSecond() {
    if (sessionStartedAt <= 0) return;
    const elapsedSecond = Math.ceil((Date.now() - sessionStartedAt) / 1000);
    finalizeBucketsBefore(elapsedSecond);
    exportButton.disabled = sessionLog.length === 0;
    pdfExportButton.disabled = sessionLog.length === 0;
  }

  async function getAudioContext() {
    if (!audioContext && window.AudioContext) {
      audioContext = new AudioContext();
    }
    if (audioContext?.state === "suspended") {
      await audioContext.resume();
    }
    return audioContext;
  }

  async function playAlertTone() {
    try {
      const context = await getAudioContext();
      if (!context) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.28);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.3);
    } catch (error) {
      console.warn("Audio alert could not be played.", error);
    }
  }

  function updateState(state) {
    const heading = document.getElementById("current-state");
    const icon = document.getElementById("state-icon");
    heading.textContent = state;
    if (state === "Fatigued/Drowsy") {
      heading.className = "mt-2 text-2xl font-extrabold text-rose-300";
      icon.textContent = "!";
      icon.className = "flex h-11 w-11 items-center justify-center rounded-xl bg-rose-400/10 text-rose-300";
      alertBanner.textContent = "Possible fatigue detected. Consider pausing or taking a break. This heuristic may be wrong.";
      alertBanner.classList.remove("hidden");
      if (lastAlert !== state) playAlertTone();
    } else if (state === "Distracted") {
      heading.className = "mt-2 text-2xl font-extrabold text-amber-200";
      icon.textContent = "↗";
      icon.className = "flex h-11 w-11 items-center justify-center rounded-xl bg-amber-300/10 text-amber-200";
      alertBanner.classList.add("hidden");
      alertBanner.textContent = "";
    } else {
      heading.className = "mt-2 text-2xl font-extrabold text-emerald-300";
      icon.textContent = "✓";
      icon.className = "flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-300/10 text-emerald-200";
      alertBanner.classList.add("hidden");
      alertBanner.textContent = "";
    }
    lastAlert = state;
  }

  function pushChartPoint(timestamp, focusScore, ear) {
    const timeLabel = new Date(timestamp * 1000).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" });
    chart.data.labels.push(timeLabel);
    chart.data.datasets[0].data.push(focusScore);
    chart.data.datasets[1].data.push(ear);
    if (chart.data.labels.length > MAX_HISTORY_POINTS) {
      chart.data.labels.shift();
      chart.data.datasets.forEach((dataset) => dataset.data.shift());
    }
    chart.update("none");
  }

  function updateMetrics(metrics) {
    latestMetrics = metrics;
    updateState(metrics.state);
    document.getElementById("focus-score").textContent = String(metrics.focus_score);
    document.getElementById("focus-meter").style.width = `${Math.max(0, Math.min(100, metrics.focus_score))}%`;
    document.getElementById("focus-meter").className = `h-full rounded-full transition-[width] duration-500 ${metrics.focus_score < 40 ? "bg-rose-300" : metrics.focus_score < 65 ? "bg-amber-300" : "bg-cyan-300"}`;
    document.getElementById("metric-ear").textContent = metrics.ear == null ? "—" : Number(metrics.ear).toFixed(3);
    document.getElementById("metric-blinks").textContent = Number(metrics.blink_rate).toFixed(1);
    document.getElementById("metric-gaze").textContent = metrics.gaze || "—";
    document.getElementById("face-detected").textContent = metrics.face_detected ? "Yes" : "No";
    const pose = metrics.head_pose;
    document.getElementById("pose-yaw").textContent = pose ? `${pose.yaw > 0 ? "+" : ""}${pose.yaw.toFixed(1)}°` : "—";
    document.getElementById("pose-pitch").textContent = pose ? `${pose.pitch > 0 ? "+" : ""}${pose.pitch.toFixed(1)}°` : "—";
    document.getElementById("pose-roll").textContent = pose ? `${pose.roll > 0 ? "+" : ""}${pose.roll.toFixed(1)}°` : "—";
    const elapsedSecond = Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000));
    if (currentBucketSecond === -1) currentBucketSecond = elapsedSecond;
    if (elapsedSecond > currentBucketSecond) {
      finalizeBucketsBefore(elapsedSecond);
      if (currentBucketSecond === -1) currentBucketSecond = elapsedSecond;
    }
    currentSecondSamples.push(metrics);
    exportButton.disabled = false;
    pdfExportButton.disabled = false;
    if (metrics.ear != null) pushChartPoint(metrics.timestamp, metrics.focus_score, metrics.ear);
  }

  function sendFrame() {
    if (!cameraStream || !socket || socket.readyState !== WebSocket.OPEN || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (socket.bufferedAmount > 1_000_000) return;
    try {
      frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
      const jpegData = frameCanvas.toDataURL("image/jpeg", 0.72).split(",", 2)[1];
      socket.send(JSON.stringify({ frame: jpegData }));
    } catch (error) {
      showError("Could not read the camera frame. Check that camera access is still available.");
      console.error("Frame capture failed.", error);
      stopSession();
    }
  }

  function closeSocket() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close(1000, "Session stopped");
    }
    socket = null;
  }

  function stopSession() {
    finalizeCurrentSecond();
    if (frameTimer) window.clearInterval(frameTimer);
    if (sessionTimer) window.clearInterval(sessionTimer);
    frameTimer = null;
    sessionTimer = null;
    closeSocket();
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    video.srcObject = null;
    cameraPlaceholder.classList.remove("hidden");
    scanOverlay.classList.add("hidden");
    setConnection("Offline", "bg-slate-500");
    alertBanner.textContent = "";
    alertBanner.classList.add("hidden");
    startButton.classList.remove("hidden");
    startButton.disabled = false;
    startButton.textContent = "Start session";
    stopButton.classList.add("hidden");
    document.getElementById("session-timer").textContent = "00:00";
    sessionStartedAt = 0;
    lastAlert = "";
  }

  function resetSession() {
    stopSession();
    sessionLog.length = 0;
    currentSecondSamples = [];
    currentBucketSecond = -1;
    latestMetrics = null;
    chart.data.labels = [];
    chart.data.datasets.forEach((dataset) => { dataset.data = []; });
    chart.update("none");
    exportButton.disabled = true;
    pdfExportButton.disabled = true;
    document.getElementById("session-timer").textContent = "00:00";
    resetMetrics();
    clearError();
  }

  function socketUrl() {
    const configuredBase = window.FOCUSPULSE_API_BASE;
    if (!configuredBase && window.location.hostname.endsWith(".github.io")) {
      throw new Error("The dashboard is deployed, but its analysis API is not configured. Deploy the FastAPI service and set the repository Actions variable API_BASE_URL to its HTTPS URL.");
    }
    let api;
    try {
      api = new URL(configuredBase || window.location.origin);
    } catch {
      throw new Error("The configured analysis API URL is invalid.");
    }
    if (api.protocol !== "https:" && api.hostname !== "localhost" && api.hostname !== "127.0.0.1") {
      throw new Error("The analysis API must use HTTPS for a secure camera session.");
    }
    api.protocol = api.protocol === "https:" ? "wss:" : "ws:";
    api.pathname = `${api.pathname.replace(/\/+$/, "")}/ws/analyze`;
    api.search = "";
    api.hash = "";
    return api.toString();
  }

  async function startSession() {
    if (cameraStream || socket) return;
    clearError();
    sessionLog.length = 0;
    chart.data.labels = [];
    chart.data.datasets.forEach((dataset) => { dataset.data = []; });
    chart.update("none");
    exportButton.disabled = true;
    pdfExportButton.disabled = true;
    resetMetrics();
    startButton.disabled = true;
    startButton.textContent = "Starting…";
    try {
      const wsUrl = socketUrl();
      getAudioContext().catch((error) => console.warn("Audio alerts are unavailable.", error));
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access requires HTTPS or localhost in a supported browser.");
      }
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 }, facingMode: "user" },
      });
      video.srcObject = cameraStream;
      await video.play();
      const sessionSocket = new WebSocket(wsUrl);
      socket = sessionSocket;
      sessionSocket.onopen = () => {
        if (socket !== sessionSocket) return;
        sessionStartedAt = Date.now();
        latestMetrics = null;
        currentSecondSamples = [];
        currentBucketSecond = 0;
        sessionTimer = window.setInterval(updateTimer, 1000);
        frameTimer = window.setInterval(sendFrame, FRAME_INTERVAL_MS);
        setConnection("Connected", "bg-emerald-300 pulse-dot");
        startButton.classList.add("hidden");
        stopButton.classList.remove("hidden");
        cameraPlaceholder.classList.add("hidden");
        scanOverlay.classList.remove("hidden");
      };
      sessionSocket.onmessage = (event) => {
        if (socket !== sessionSocket) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "metrics") updateMetrics(message);
          else if (message.type === "error") showError(message.message || "The server rejected a camera frame.");
        } catch (error) {
          console.error("Invalid response from analysis server.", error);
          showError("Received an invalid response from the analysis server.");
        }
      };
      sessionSocket.onerror = () => {
        if (socket === sessionSocket) showError("Could not connect to FocusPulse AI. Confirm the server is running.");
      };
      sessionSocket.onclose = () => {
        if (socket !== sessionSocket) return;
        const wasActive = Boolean(cameraStream);
        socket = null;
        stopSession();
        if (wasActive) showError("The analysis connection closed. Start a new session to reconnect.");
      };
    } catch (error) {
      stopSession();
      const cameraErrorMessages = {
        NotAllowedError: "Camera permission was denied. Allow camera access in your browser and try again.",
        NotFoundError: "No camera was found. Connect a webcam and try again.",
        NotReadableError: "The camera is already in use or unavailable.",
      };
      showError(cameraErrorMessages[error.name] || error.message || "Could not start the session.");
    } finally {
      if (!socket) {
        startButton.disabled = false;
        startButton.textContent = "Start session";
      }
    }
  }

  function csvCell(value) {
    let safeValue = String(value ?? "");
    if (/^[\s]*[=+\-@]/.test(safeValue)) safeValue = `'${safeValue}`;
    return `"${safeValue.replaceAll('"', '""')}"`;
  }

  function exportCsv() {
    const rows = buildReportRows();
    if (rows.length === 0) return;
    const output = [["Second", "Timestamp", "State", "Focus Score", "EAR", "Blinks/min", "Gaze", "Yaw", "Pitch", "Roll", "Face detected", "Samples"]];
    rows.forEach((entry) => output.push([
      entry.second, entry.timestamp, entry.state,
      entry.focusScore == null ? "" : entry.focusScore.toFixed(1),
      entry.ear == null ? "" : entry.ear.toFixed(3),
      entry.blinkRate == null ? "" : entry.blinkRate.toFixed(1),
      entry.gaze,
      entry.yaw == null ? "" : entry.yaw.toFixed(1),
      entry.pitch == null ? "" : entry.pitch.toFixed(1),
      entry.roll == null ? "" : entry.roll.toFixed(1),
      entry.faceDetected ? "Yes" : "No",
      entry.samples,
    ]));
    const csv = output.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `focuspulse-session-${new Date().toISOString().replaceAll(":", "-")}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function buildReportRows() {
    const rows = sessionLog.slice();
    if (currentBucketSecond >= 0) {
      rows.push(buildSecondRecord(currentBucketSecond, currentSecondSamples));
    }
    return rows;
  }

  function formatPdfNumber(value, digits = 1) {
    return Number.isFinite(value) ? value.toFixed(digits) : "N/A";
  }

  function exportPdf() {
    const rows = buildReportRows();
    const PdfDocument = window.jspdf?.jsPDF;
    if (!PdfDocument || rows.length === 0) {
      showError(PdfDocument ? "There is no session activity to export yet." : "PDF export library did not load. Check your connection and reload the page.");
      return;
    }
    const pdf = new PdfDocument({ orientation: "landscape", unit: "mm", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const rowsPerPage = 12;
    const startTime = new Date(sessionStartedAt);
    const meanScore = rows.map((row) => row.focusScore).filter(Number.isFinite);
    const overallMean = meanScore.length
      ? meanScore.reduce((total, value) => total + value, 0) / meanScore.length
      : null;
    const counts = new Map();
    rows.forEach((row) => counts.set(row.state, (counts.get(row.state) || 0) + 1));
    const summary = [...counts.entries()].map(([state, count]) => `${state}: ${count}s`).join("   |   ");

    for (let pageStart = 0; pageStart < rows.length; pageStart += rowsPerPage) {
      if (pageStart > 0) pdf.addPage();
      pdf.setFillColor(8, 13, 24);
      pdf.rect(0, 0, pageWidth, pageHeight, "F");
      pdf.setFillColor(15, 23, 42);
      pdf.roundedRect(12, 10, pageWidth - 24, 27, 4, 4, "F");
      pdf.setTextColor(103, 232, 249);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(18);
      pdf.text("FOCUSPULSE AI", 18, 21);
      pdf.setTextColor(226, 232, 240);
      pdf.setFontSize(10);
      pdf.text("SECOND-BY-SECOND SESSION REPORT", 18, 30);
      pdf.setTextColor(148, 163, 184);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);
      pdf.text(`Started ${startTime.toLocaleString()}   ·   Duration ${formatElapsed(rows.length)}   ·   ${rows.length} activity seconds`, 18, 45);
      pdf.text(`Mean focus ${formatPdfNumber(overallMean, 0)}/100   ·   ${summary}`, 18, 52, { maxWidth: pageWidth - 36 });

      const headerY = 62;
      const columns = [
        ["SEC", 12], ["TIME", 25], ["STATE", 37], ["FOCUS", 23], ["EAR", 22],
        ["BLINKS/M", 25], ["GAZE", 24], ["YAW", 18], ["PITCH", 18],
        ["ROLL", 18], ["FACE", 17], ["SAMPLES", 20],
      ];
      let x = 14;
      pdf.setFillColor(21, 37, 58);
      pdf.roundedRect(12, headerY - 5, pageWidth - 24, 8, 2, 2, "F");
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(6.5);
      pdf.setTextColor(103, 232, 249);
      columns.forEach(([label, columnWidth]) => {
        pdf.text(label, x + 1, headerY);
        x += columnWidth;
      });

      const pageRows = rows.slice(pageStart, pageStart + rowsPerPage);
      pageRows.forEach((row, index) => {
        const y = headerY + 9 + index * 10;
        if (index % 2 === 0) {
          pdf.setFillColor(15, 23, 42);
          pdf.roundedRect(12, y - 5, pageWidth - 24, 8, 1, 1, "F");
        }
        const values = [
          String(row.second), row.elapsed, row.state,
          formatPdfNumber(row.focusScore, 0), formatPdfNumber(row.ear, 3),
          formatPdfNumber(row.blinkRate), row.gaze,
          formatPdfNumber(row.yaw), formatPdfNumber(row.pitch),
          formatPdfNumber(row.roll), row.faceDetected ? "YES" : "NO",
          String(row.samples),
        ];
        let cellX = 14;
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(6.5);
        pdf.setTextColor(row.state === "Fatigued/Drowsy" ? 253 : 203, row.state === "Fatigued/Drowsy" ? 164 : 213, row.state === "Fatigued/Drowsy" ? 175 : 225);
        values.forEach((value, columnIndex) => {
          const columnWidth = columns[columnIndex][1];
          pdf.text(String(value).slice(0, 19), cellX + 1, y, { maxWidth: columnWidth - 2 });
          cellX += columnWidth;
        });
      });
      pdf.setDrawColor(51, 65, 85);
      pdf.line(12, pageHeight - 13, pageWidth - 12, pageHeight - 13);
      pdf.setFontSize(7);
      pdf.setTextColor(100, 116, 139);
      pdf.text("Heuristic wellness estimates only - Not medical, diagnostic, safety, or performance advice", 14, pageHeight - 7);
      pdf.text(`Page ${Math.floor(pageStart / rowsPerPage) + 1} of ${Math.ceil(rows.length / rowsPerPage)}`, pageWidth - 14, pageHeight - 7, { align: "right" });
    }
    pdf.save(`focuspulse-session-${startTime.toISOString().replaceAll(":", "-")}.pdf`);
  }

  startButton.addEventListener("click", startSession);
  stopButton.addEventListener("click", stopSession);
  resetButton.addEventListener("click", resetSession);
  exportButton.addEventListener("click", exportCsv);
  pdfExportButton.addEventListener("click", exportPdf);
  window.addEventListener("pagehide", stopSession);
  resetMetrics();
})();
