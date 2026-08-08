const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const dns = require("dns").promises;
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 4000);

const ROOT = __dirname;
const DOWNLOAD_DIR = path.join(ROOT, "downloads");
const TEMP_DIR = path.join(ROOT, "temp");

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginResourcePolicy: { policy: "same-origin" }
}));
app.use(morgan("tiny"));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));

const jobs = new Map();
const history = [];
const MAX_HISTORY = 50;
const MAX_CONCURRENT = 2;
let activeJobs = 0;

const YTDLP = process.env.YTDLP_PATH || (process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function id() {
  return crypto.randomBytes(8).toString("hex");
}

function cleanName(value) {
  return String(value || "media")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "media";
}

function validUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { ok: false, error: "Enter a valid URL." };
  }

  if (!["http:", "https:"].includes(u.protocol)) {
    return { ok: false, error: "Only HTTP and HTTPS URLs are allowed." };
  }

  if (!u.hostname || u.hostname.includes("..")) {
    return { ok: false, error: "Invalid hostname." };
  }

  const host = u.hostname.toLowerCase();
  const blocked = [
    "localhost",
    "localhost.localdomain",
    "0.0.0.0",
    "127.0.0.1",
    "::1",
    "[::1]"
  ];

  if (blocked.includes(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, error: "Local/internal URLs are not allowed." };
  }

  // Reject obvious private IPv4 literals to reduce SSRF risk.
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [a,b,c,d] = ipv4.slice(1).map(Number);
    const privateIp =
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0 ||
      (a === 169 && b === 254);
    if (privateIp) return { ok: false, error: "Private/internal IP addresses are not allowed." };
  }

  return { ok: true, url: u.toString() };
}

async function assertPublicHostname(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Local/internal hosts are not allowed.");
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return;

  let addresses = [];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    // Let yt-dlp provide the final network error.
    return;
  }

  for (const item of addresses) {
    const ip = item.address;
    if (item.family === 4) {
      const [a,b] = ip.split(".").map(Number);
      if (
        a === 10 || a === 127 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a === 0 || (a === 169 && b === 254)
      ) throw new Error("The URL resolves to a private/internal address.");
    }
    if (item.family === 6 && (ip === "::1" || ip.toLowerCase().startsWith("fc") || ip.toLowerCase().startsWith("fd"))) {
      throw new Error("The URL resolves to a private/internal address.");
    }
  }
}

function parseProgress(line) {
  const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%.*?of\s+~?\s*([0-9.]+\s*[KMG]?i?B).*?at\s+([0-9.]+\s*[KMG]?i?B\/s).*?ETA\s+([0-9:]+)/i);
  if (!m) {
    const p = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    return p ? { percent: Number(p[1]) } : null;
  }
  return {
    percent: Number(m[1]),
    size: m[2],
    speed: m[3],
    eta: m[4]
  };
}

function pushEvent(job, event) {
  job.events.push(event);
  if (job.events.length > 100) job.events.shift();
  for (const res of job.clients) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function outputPathFor(job) {
  const safe = cleanName(job.title || "media");
  return path.join(DOWNLOAD_DIR, `${job.id}-${safe}.%(ext)s`);
}

async function getInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      "--dump-single-json",
      "--js-runtimes", "node",
      "--no-warnings",
      "--skip-download",
      "--no-playlist",
      "--",
      url
    ];
    const child = spawn(YTDLP, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Metadata lookup timed out."));
    }, 30000);

    child.on("error", err => {
      clearTimeout(timer);
      if (err.code === "ENOENT") reject(new Error("yt-dlp was not found. Install it and/or set YTDLP_PATH."));
      else reject(err);
    });

    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || "Could not read media information."));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("yt-dlp returned invalid metadata."));
      }
    });
  });
}

function formatInfo(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const video = formats
    .filter(f => f.vcodec && f.vcodec !== "none" && f.height)
    .sort((a,b) => (b.height || 0) - (a.height || 0));

  const audio = formats
    .filter(f => f.acodec && f.acodec !== "none")
    .sort((a,b) => (b.abr || 0) - (a.abr || 0));

  const heights = [...new Set(video.map(f => f.height).filter(Boolean))].slice(0, 8);

  return {
    id: info.id || "",
    title: info.title || "Untitled media",
    uploader: info.uploader || info.channel || "",
    thumbnail: info.thumbnail || "",
    duration: info.duration || 0,
    webpage_url: info.webpage_url || "",
    extractor: info.extractor_key || info.extractor || "",
    is_live: Boolean(info.is_live),
    type: info._type || "video",
    qualities: heights.map(h => `${h}p`),
    hasAudio: audio.length > 0,
    bestHeight: video[0]?.height || null
  };
}

async function runDownload(job) {
  activeJobs++;
  job.status = "downloading";
  pushEvent(job, { type: "status", status: job.status });

  const title = cleanName(job.info.title);
  job.title = title;
  const output = outputPathFor(job);

  const quality = job.quality || "best";
  let format;
  if (quality === "audio") {
    format = "bestaudio/best";
  } else if (quality === "best") {
    format = "bv*+ba/b";
  } else {
    const h = Number.parseInt(quality, 10);
    if (!Number.isFinite(h)) throw new Error("Invalid quality.");
    format = `bv*[height<=${h}]+ba/b[height<=${h}]/b[height<=${h}]`;
  }

  const args = [
    "--no-playlist",
    "--newline",
    "--js-runtimes", "node",
    "--no-warnings",
    "--restrict-filenames",
    "-f", format,
    "--merge-output-format", "mp4",
    "--retries", "3",
    "--fragment-retries", "3",
    "--concurrent-fragments", "4",
    "-o", output,
    "--",
    job.url
  ];

  if (quality === "audio") {
    args.splice(args.indexOf("--merge-output-format"), 2);
    args.push("-x", "--audio-format", "mp3");
  }

  const child = spawn(YTDLP, args, { windowsHide: true });
  job.process = child;

  let stderr = "";
  let stdout = "";

  const onData = chunk => {
    const text = chunk.toString();
    stdout += text;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const progress = parseProgress(line);
      if (progress) pushEvent(job, { type: "progress", ...progress });
      if (line.trim()) pushEvent(job, { type: "log", message: line.trim().slice(0, 500) });
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", chunk => {
    const text = chunk.toString();
    stderr += text;
    const progress = parseProgress(text);
    if (progress) pushEvent(job, { type: "progress", ...progress });
  });

  await new Promise((resolve, reject) => {
    child.on("error", err => {
      if (err.code === "ENOENT") reject(new Error("yt-dlp was not found. Install it and/or set YTDLP_PATH."));
      else reject(err);
    });
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split("\n").slice(-5).join(" ") || "Download failed."));
    });
  });

  const files = (await fsp.readdir(DOWNLOAD_DIR))
    .filter(name => name.startsWith(`${job.id}-`))
    .map(name => path.join(DOWNLOAD_DIR, name));

  if (!files.length) throw new Error("Download completed but no output file was found.");

  const file = files[0];
  job.file = path.basename(file);
  job.status = "complete";
  job.percent = 100;
  pushEvent(job, {
    type: "complete",
    filename: job.file,
    url: `/api/files/${encodeURIComponent(job.file)}`
  });

  history.unshift({
    id: job.id,
    title: job.title,
    source: job.info.extractor || "Unknown",
    filename: job.file,
    createdAt: new Date().toISOString()
  });
  history.splice(MAX_HISTORY);

  return job;
}

async function pump() {
  for (const job of jobs.values()) {
    if (activeJobs >= MAX_CONCURRENT) break;
    if (job.status === "queued") {
      runDownload(job)
        .catch(err => {
          job.status = "error";
          job.error = err.message;
          pushEvent(job, { type: "error", message: err.message });
        })
        .finally(() => {
          activeJobs--;
          job.process = null;
          pump();
        });
    }
  }
}

app.get("/api/health", async (_req, res) => {
  const result = { ok: true, ytDlp: false, ffmpeg: false, activeJobs, ytDlpPath: YTDLP, ffmpegPath: FFMPEG };
  const checks = [
    ["ytDlp", YTDLP, ["--version"]],
    ["ffmpeg", FFMPEG, ["-version"]]
  ];

  for (const [key, cmd, args] of checks) {
    result[key] = await new Promise(resolve => {
      const p = spawn(cmd, args, { windowsHide: true });
      p.on("error", () => resolve(false));
      p.on("close", code => resolve(code === 0));
    });
  }

  result.ok = result.ytDlp;
  result.message = result.ok
    ? "Downloader engine ready."
    : "yt-dlp is unavailable. Restart the app so the automatic setup can run.";
  res.json(result);
});

app.post("/api/info", async (req, res) => {
  try {
    const checked = validUrl(req.body?.url);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    await assertPublicHostname(new URL(checked.url).hostname);
    const info = await getInfo(checked.url);
    res.json(formatInfo(info));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not inspect this URL." });
  }
});

app.post("/api/download", async (req, res) => {
  try {
    const checked = validUrl(req.body?.url);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    await assertPublicHostname(new URL(checked.url).hostname);

    const info = await getInfo(checked.url);
    const quality = req.body?.quality || "best";

    if (quality !== "best" && quality !== "audio" && !/^\d+p?$/.test(String(quality))) {
      return res.status(400).json({ error: "Invalid quality selection." });
    }

    const job = {
      id: id(),
      url: checked.url,
      info,
      title: info.title,
      quality: String(quality).replace("p", ""),
      status: "queued",
      percent: 0,
      events: [],
      clients: [],
      process: null,
      createdAt: new Date().toISOString()
    };

    jobs.set(job.id, job);
    pushEvent(job, { type: "status", status: "queued" });
    res.json({ jobId: job.id });
    pump();
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not start download." });
  }
});

app.get("/api/jobs/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  for (const event of job.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  job.clients.push(res);
  req.on("close", () => {
    job.clients = job.clients.filter(c => c !== res);
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json({
    id: job.id,
    status: job.status,
    title: job.title,
    percent: job.percent,
    filename: job.file || null,
    error: job.error || null,
    url: job.file ? `/api/files/${encodeURIComponent(job.file)}` : null
  });
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });

  if (job.process) {
    job.process.kill("SIGTERM");
    job.status = "cancelled";
    pushEvent(job, { type: "status", status: "cancelled" });
  } else if (job.status === "queued") {
    job.status = "cancelled";
    pushEvent(job, { type: "status", status: "cancelled" });
  }
  res.json({ ok: true });
});

app.get("/api/files/:name", async (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(DOWNLOAD_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).send("File not found.");

  res.download(file, name.replace(/^[a-f0-9]{16}-/, ""), err => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

app.get("/api/history", (_req, res) => {
  res.json(history);
});

app.delete("/api/history", async (_req, res) => {
  const entries = await fsp.readdir(DOWNLOAD_DIR);
  await Promise.all(entries.map(name => fsp.unlink(path.join(DOWNLOAD_DIR, name)).catch(() => {})));
  history.length = 0;
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`Social Media Downloader running at http://localhost:${PORT}`);
  console.log(`yt-dlp: ${YTDLP}`);
  console.log(`ffmpeg: ${FFMPEG}`);
});
