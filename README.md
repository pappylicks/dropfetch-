# DropFetch — Social Media Media Downloader

A clean local web app that accepts a public media URL, analyzes it, lets you choose a quality, downloads the available media with yt-dlp, and stores the result in the local `downloads/` folder.

## What it includes

- URL analyzer / media preview
- Best available quality
- Resolution selection when yt-dlp exposes those formats
- Audio-only MP3 mode when audio is available
- Automatic video + audio merging to MP4 when needed
- Progress percentage, speed and ETA
- Cancel queued/running jobs
- Local download history
- Health check for yt-dlp and FFmpeg
- Basic SSRF protections for local/private addresses
- No cloud upload: files remain on the machine running the app
- Responsive desktop/mobile UI

## Important limitation

This app does **not** magically remove a watermark that is baked into the pixels of a source video. It downloads the media representation that the site's extractor exposes. If a platform only exposes a watermarked copy, the resulting file can still contain that watermark.

Use the app only for content you have permission/right to download and in accordance with the platform's rules.

## Requirements

- Node.js 20+
- yt-dlp
- FFmpeg

yt-dlp's supported extractors change over time, so a URL that works today can stop working when a platform changes its website. The app intentionally delegates extraction to the current yt-dlp build instead of maintaining brittle platform-specific scrapers.

## Windows setup

1. Install Node.js 20 or newer.
2. Open a terminal in this project folder.
3. Run:

```powershell
npm install
npm start
```

**The app now automatically downloads its own local copies of yt-dlp and FFmpeg if they are missing.** They are placed in the project's `tools/` directory, so you do not need to configure `PATH`, `YTDLP_PATH`, or `FFMPEG_PATH` manually.

The bootstrap uses the current official yt-dlp Windows release and the current FFmpeg Windows essentials build. The first launch may take a little longer because the tools are downloaded once.

4. Open:

6. Open:

```text
http://localhost:4000
```

### If yt-dlp or FFmpeg is not in PATH

Set the executable paths before starting:

```powershell
$env:YTDLP_PATH="C:\tools\yt-dlp\yt-dlp.exe"
$env:FFMPEG_PATH="C:\tools\ffmpeg\bin\ffmpeg.exe"
npm start
```

Or create a `.env` equivalent in your own shell/startup process. This project intentionally does not bundle executable binaries.

## macOS / Linux

Install Node.js 20+, yt-dlp and FFmpeg, then:

```bash
npm install
npm start
```

If the commands are not in PATH:

```bash
YTDLP_PATH=/path/to/yt-dlp FFMPEG_PATH=/path/to/ffmpeg npm start
```

## Project structure

```text
social-media-downloader/
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ downloads/
├─ temp/
├─ package.json
├─ server.js
├─ .gitignore
└─ README.md
```

## Production notes

For a public deployment, add authentication, rate limiting, persistent job storage, disk quotas, a worker queue, HTTPS, and stronger outbound network controls. Do not expose an unrestricted downloader endpoint to the public internet.

## Updating yt-dlp

Keep yt-dlp current. Its official documentation notes that supported sites can break as websites change, and the supported-site list itself warns that not every listed extractor is guaranteed to work.

Official documentation:
- https://github.com/yt-dlp/yt-dlp
- https://github.com/yt-dlp/yt-dlp/wiki/Installation
- https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md


## Automatic dependency setup

On Windows, `npm start` runs `bootstrap.js` first. It:

1. Checks for a local `tools/yt-dlp.exe`.
2. Checks for yt-dlp on PATH.
3. Downloads the official yt-dlp executable if neither exists.
4. Checks for a local `tools/ffmpeg.exe`.
5. Checks for FFmpeg on PATH.
6. Downloads the FFmpeg essentials ZIP if neither exists.
7. Extracts only `ffmpeg.exe` into `tools/`.
8. Starts the web server with the discovered executable paths.

This removes the previous `yt-dlp was not found` failure caused by relying on the user's PATH.

The bootstrap URLs are the official yt-dlp release endpoint and the current Windows FFmpeg essentials build listed by Gyan's FFmpeg builds page.
