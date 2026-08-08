const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = __dirname;
const TOOLS = path.join(ROOT, "tools");
const TMP = path.join(ROOT, ".bootstrap-tmp");
const isWin = process.platform === "win32";

const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

function commandExists(cmd) {
  const r = spawnSync(isWin ? "where.exe" : "which", [cmd], { stdio: "ignore" });
  return r.status === 0;
}

function localYtDlp() {
  const candidates = isWin
    ? [path.join(TOOLS, "yt-dlp.exe"), path.join(ROOT, "yt-dlp.exe")]
    : [path.join(TOOLS, "yt-dlp"), path.join(ROOT, "yt-dlp")];
  return candidates.find(fs.existsSync) || null;
}

function localFfmpeg() {
  const candidates = isWin
    ? [
        path.join(TOOLS, "ffmpeg.exe"),
        path.join(ROOT, "ffmpeg.exe"),
        path.join(TOOLS, "ffmpeg", "bin", "ffmpeg.exe")
      ]
    : [path.join(TOOLS, "ffmpeg"), path.join(ROOT, "ffmpeg")];
  return candidates.find(fs.existsSync) || null;
}

async function downloadFile(url, destination) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const data = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destination, data);
}

async function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", windowsHide: true });
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)));
  });
}

async function findFfmpegExtracted(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === (isWin ? "ffmpeg.exe" : "ffmpeg")) return full;
    }
  }
  return null;
}

async function ensureTools() {
  await fsp.mkdir(TOOLS, { recursive: true });
  await fsp.mkdir(TMP, { recursive: true });

  let yt = localYtDlp();
  if (!yt && commandExists(isWin ? "yt-dlp.exe" : "yt-dlp")) {
    yt = isWin ? "yt-dlp.exe" : "yt-dlp";
  }

  let ff = localFfmpeg();
  if (!ff && commandExists(isWin ? "ffmpeg.exe" : "ffmpeg")) {
    ff = isWin ? "ffmpeg.exe" : "ffmpeg";
  }

  if (!yt) {
    console.log("[setup] yt-dlp not found. Downloading the current official Windows release...");
    if (!isWin) throw new Error("Automatic yt-dlp bootstrap currently targets Windows. Install yt-dlp on this OS.");
    const target = path.join(TOOLS, "yt-dlp.exe");
    await downloadFile(YTDLP_URL, target);
    yt = target;
  }

  if (!ff) {
    if (!isWin) {
      console.warn("[setup] FFmpeg was not found. Install FFmpeg and restart.");
    } else {
      console.log("[setup] FFmpeg not found. Downloading the current essentials build...");
      const zip = path.join(TMP, "ffmpeg.zip");
      const extract = path.join(TMP, "ffmpeg-extracted");
      await fsp.rm(extract, { recursive: true, force: true });
      await downloadFile(FFMPEG_URL, zip);
      await run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${extract.replace(/'/g, "''")}' -Force`
      ]);
      const found = await findFfmpegExtracted(extract);
      if (!found) throw new Error("FFmpeg downloaded, but ffmpeg.exe was not found inside the archive.");
      await fsp.copyFile(found, path.join(TOOLS, "ffmpeg.exe"));
      ff = path.join(TOOLS, "ffmpeg.exe");
    }
  }

  await fsp.rm(TMP, { recursive: true, force: true });

  console.log(`[setup] yt-dlp: ${yt}`);
  console.log(`[setup] FFmpeg:  ${ff || "not found"}`);

  return { yt, ff };
}

(async () => {
  try {
    const { yt, ff } = await ensureTools();
    const env = {
      ...process.env,
      YTDLP_PATH: yt,
      FFMPEG_PATH: ff || process.env.FFMPEG_PATH || "ffmpeg"
    };
    const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      env,
      stdio: "inherit",
      windowsHide: false
    });
    child.on("exit", code => process.exit(code ?? 0));
  } catch (err) {
    console.error("\n[setup] Could not prepare the downloader dependencies.");
    console.error(err.message);
    process.exit(1);
  }
})();
