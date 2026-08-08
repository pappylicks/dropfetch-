const $ = s => document.querySelector(s);

const form = $("#urlForm");
const urlInput = $("#url");
const inspectBtn = $("#inspectBtn");
const preview = $("#preview");
const thumb = $("#thumb");
const source = $("#source");
const title = $("#title");
const meta = $("#meta");
const quality = $("#quality");
const downloadBtn = $("#downloadBtn");
const previewError = $("#previewError");

const progressPanel = $("#progressPanel");
const progressBar = $("#progressBar");
const percent = $("#percent");
const speed = $("#speed");
const eta = $("#eta");
const jobTitle = $("#jobTitle");
const log = $("#log");
const cancelBtn = $("#cancelBtn");
const fileBtn = $("#fileBtn");

let currentInfo = null;
let currentJob = null;
let eventSource = null;

function showError(el, message) {
  el.textContent = message;
  el.classList.remove("hidden");
}
function clearError(el) {
  el.textContent = "";
  el.classList.add("hidden");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function health() {
  const h = $("#health");
  const dot = h.querySelector(".dot");
  try {
    const data = await api("/api/health");
    dot.className = `dot ${data.ok ? "ok" : "bad"}`;
    h.lastChild.textContent = data.ok
      ? " Ready"
      : (data.ytDlp ? " FFmpeg missing" : " Downloader setup needed");
  } catch {
    dot.className = "dot bad";
    h.lastChild.textContent = " Offline";
  }
}

form.addEventListener("submit", async e => {
  e.preventDefault();
  clearError(previewError);
  preview.classList.add("hidden");

  const url = urlInput.value.trim();
  if (!url) return;

  inspectBtn.disabled = true;
  inspectBtn.textContent = "Analyzing…";

  try {
    currentInfo = await api("/api/info", {
      method: "POST",
      body: JSON.stringify({ url })
    });

    source.textContent = currentInfo.extractor || "Media";
    title.textContent = currentInfo.title;
    const bits = [];
    if (currentInfo.uploader) bits.push(currentInfo.uploader);
    if (currentInfo.duration) bits.push(formatDuration(currentInfo.duration));
    if (currentInfo.bestHeight) bits.push(`up to ${currentInfo.bestHeight}p`);
    meta.textContent = bits.join(" • ") || "Media ready";

    if (currentInfo.thumbnail) {
      thumb.src = currentInfo.thumbnail;
      thumb.parentElement.classList.remove("hidden");
    } else {
      thumb.removeAttribute("src");
    }

    quality.innerHTML = "";
    const opts = [["best", "Best available"]];
    if (currentInfo.qualities?.length) {
      currentInfo.qualities.forEach(q => opts.push([q, q]));
    }
    if (currentInfo.hasAudio) opts.push(["audio", "Audio only (MP3)"]);
    for (const [value, label] of opts) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      quality.appendChild(o);
    }

    preview.classList.remove("hidden");
    preview.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (err) {
    showError(previewError, err.message);
    preview.classList.remove("hidden");
    title.textContent = "Could not analyze link";
    source.textContent = "";
    meta.textContent = "";
    quality.innerHTML = "";
    thumb.removeAttribute("src");
  } finally {
    inspectBtn.disabled = false;
    inspectBtn.textContent = "Analyze link";
  }
});

downloadBtn.addEventListener("click", async () => {
  if (!currentInfo) return;

  downloadBtn.disabled = true;
  downloadBtn.textContent = "Starting…";
  progressPanel.classList.remove("hidden");
  jobTitle.textContent = currentInfo.title;
  progressBar.style.width = "0%";
  percent.textContent = "0%";
  speed.textContent = "Starting…";
  eta.textContent = "";
  log.textContent = "";
  fileBtn.classList.add("hidden");

  try {
    const result = await api("/api/download", {
      method: "POST",
      body: JSON.stringify({
        url: currentInfo.webpage_url || urlInput.value.trim(),
        quality: quality.value
      })
    });
    currentJob = result.jobId;
    connectEvents(currentJob);
    progressPanel.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (err) {
    showError(previewError, err.message);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = "Download";
  }
});

function connectEvents(jobId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/jobs/${jobId}/events`);

  eventSource.onmessage = e => {
    const event = JSON.parse(e.data);

    if (event.type === "progress") {
      const p = Math.min(100, Math.max(0, event.percent || 0));
      progressBar.style.width = `${p}%`;
      percent.textContent = `${p.toFixed(1)}%`;
      if (event.speed) speed.textContent = event.speed;
      if (event.eta) eta.textContent = `ETA ${event.eta}`;
    }

    if (event.type === "status") {
      if (event.status === "queued") speed.textContent = "Queued…";
      if (event.status === "downloading") speed.textContent = "Downloading…";
      if (["cancelled", "error"].includes(event.status)) eventSource.close();
    }

    if (event.type === "log") {
      const line = document.createElement("div");
      line.textContent = event.message;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    }

    if (event.type === "complete") {
      progressBar.style.width = "100%";
      percent.textContent = "100%";
      speed.textContent = "Complete";
      fileBtn.href = event.url;
      fileBtn.classList.remove("hidden");
      eventSource.close();
      loadHistory();
    }

    if (event.type === "error") {
      showError(previewError, event.message);
      eventSource.close();
    }
  };
}

cancelBtn.addEventListener("click", async () => {
  if (!currentJob) return;
  try {
    await api(`/api/jobs/${currentJob}/cancel`, { method: "POST" });
    speed.textContent = "Cancelled";
    cancelBtn.disabled = true;
  } catch {}
});

function formatDuration(sec) {
  sec = Math.round(Number(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

async function loadHistory() {
  const box = $("#history");
  try {
    const items = await api("/api/history");
    if (!items.length) {
      box.innerHTML = '<div class="empty">No downloads yet.</div>';
      return;
    }
    box.innerHTML = "";
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "history-item";
      const left = document.createElement("div");
      left.style.minWidth = "0";
      const t = document.createElement("div");
      t.className = "history-title";
      t.textContent = item.title;
      const m = document.createElement("div");
      m.className = "history-meta";
      m.textContent = `${item.source} • ${new Date(item.createdAt).toLocaleString()}`;
      left.append(t, m);
      const a = document.createElement("a");
      a.href = `/api/files/${encodeURIComponent(item.filename)}`;
      a.download = "";
      a.textContent = "Save";
      row.append(left, a);
      box.appendChild(row);
    }
  } catch {}
}

$("#clearHistory").addEventListener("click", async () => {
  if (!confirm("Delete all locally stored downloads and clear the library?")) return;
  await api("/api/history", { method: "DELETE" });
  loadHistory();
});

health();
loadHistory();
setInterval(health, 15000);
