const express = require('express');
const { spawn, execFile } = require('child_process');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const fsp = fs.promises;
const app = express();
const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const RUNTIME_DIR = path.join(ROOT_DIR, '.runtime');
const WORK_DIR = path.join(RUNTIME_DIR, 'work');
const COMPLETED_DIR = path.isAbsolute(process.env.DOWNLOAD_DIR || '')
  ? process.env.DOWNLOAD_DIR
  : path.resolve(ROOT_DIR, process.env.DOWNLOAD_DIR || path.join('.runtime', 'completed'));
const TEMP_PREFIX = '__yt_root_tmp__';
const FILEPATH_MARKER = '__FILEPATH__:';
const PROGRESS_MARKER = '__PROGRESS__:';
const DOWNLOAD_TTL_MS = 1000 * 60 * 60;
const YTDLP_NETWORK_ARGS = ['--force-ipv4'];
const VIDEO_FORMAT_SELECTOR = [
  'bestvideo[vcodec^=avc1][height<=1080]+bestaudio[acodec^=mp4a]',
  'bestvideo[vcodec^=avc1][height<=1080]+bestaudio[ext=m4a]',
  'best[ext=mp4][vcodec^=avc1][acodec^=mp4a][height<=1080]',
  'bestvideo[vcodec^=avc1][ext=mp4][height<=1080]+bestaudio[ext=m4a]',
  'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
].join('/');
const YTDLP_METADATA_ARGS = [
  '--no-playlist',
  '--socket-timeout',
  '15',
  '--retries',
  '1',
  '--extractor-retries',
  '1',
];
const YTDLP_METADATA_TIMEOUT_MS = 30000;
const VIDEO_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);
const THUMBNAIL_HOST_SUFFIXES = ['ytimg.com', 'googleusercontent.com', 'ggpht.com'];
const THUMBNAIL_CONTENT_TYPES = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

let toolAvailabilityPromise = null;
const completedDownloads = new Map();

app.use(cors());
app.use(express.static(DIST_DIR));

async function fileExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function buildUniquePath(targetPath) {
  if (!(await fileExists(targetPath))) {
    return targetPath;
  }

  const parsed = path.parse(targetPath);
  let index = 1;

  while (true) {
    const nextPath = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!(await fileExists(nextPath))) {
      return nextPath;
    }
    index += 1;
  }
}

async function moveFile(sourcePath, destinationPath) {
  try {
    await fsp.rename(sourcePath, destinationPath);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }

    await fsp.copyFile(sourcePath, destinationPath);
    await fsp.unlink(sourcePath);
  }
}

async function ensureDirectory(targetPath) {
  await fsp.mkdir(targetPath, { recursive: true });
}

async function findDownloadedFileFallback(baseDir, prefix = TEMP_PREFIX) {
  const entries = await fsp.readdir(baseDir);
  const prefixedFiles = entries.filter((entry) => entry.startsWith(prefix));

  if (prefixedFiles.length === 0) {
    return null;
  }

  const detailed = await Promise.all(
    prefixedFiles.map(async (entry) => {
      const fullPath = path.join(baseDir, entry);
      const stats = await fsp.stat(fullPath);
      return { fullPath, mtimeMs: stats.mtimeMs };
    })
  );

  detailed.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return detailed[0].fullPath;
}

function readPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseUrlValue(value) {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
}

function isAllowedProtocol(parsedUrl) {
  return Boolean(parsedUrl && (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:'));
}

function isAllowedVideoUrl(value) {
  const parsedUrl = parseUrlValue(value);
  if (!isAllowedProtocol(parsedUrl)) {
    return false;
  }

  return VIDEO_HOSTS.has(parsedUrl.hostname.toLowerCase());
}

function isAllowedThumbnailUrl(value) {
  const parsedUrl = parseUrlValue(value);
  if (!isAllowedProtocol(parsedUrl)) {
    return false;
  }

  const host = parsedUrl.hostname.toLowerCase();
  return THUMBNAIL_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function normalizeExternalUrl(value) {
  const parsedUrl = parseUrlValue(value);
  return parsedUrl ? parsedUrl.toString() : '';
}

function sanitizeFileSegment(value, fallback = 'file') {
  const sanitized = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

  return sanitized || fallback;
}

function collectThumbnailCandidates(metadata) {
  const rawThumbnails = Array.isArray(metadata.thumbnails) ? metadata.thumbnails : [];
  const seen = new Set();
  const combined = [];

  for (const item of rawThumbnails) {
    const url = typeof item?.url === 'string' ? item.url.trim() : '';
    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    combined.push({
      url,
      id: item.id || null,
      width: readPositiveNumber(item.width),
      height: readPositiveNumber(item.height),
      preference: Number.isFinite(Number(item.preference)) ? Number(item.preference) : null,
    });
  }

  if (metadata.thumbnail && !seen.has(metadata.thumbnail)) {
    combined.push({
      url: metadata.thumbnail,
      id: 'primary',
      width: null,
      height: null,
      preference: null,
    });
  }

  combined.sort((left, right) => {
    const leftScore = (left.width || 0) * (left.height || 0);
    const rightScore = (right.width || 0) * (right.height || 0);

    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }

    return (right.preference || 0) - (left.preference || 0);
  });

  return combined;
}

function isHdThumbnail(thumbnail) {
  const width = thumbnail.width || 0;
  const height = thumbnail.height || 0;
  const marker = `${thumbnail.id || ''} ${thumbnail.url || ''}`.toLowerCase();

  return (
    width >= 1280 ||
    height >= 720 ||
    marker.includes('maxres') ||
    marker.includes('hqdefault') ||
    marker.includes('sddefault')
  );
}

function formatThumbnailLabel(thumbnail, index) {
  if (thumbnail.width && thumbnail.height) {
    return `${thumbnail.width}x${thumbnail.height}`;
  }

  if (thumbnail.id) {
    return thumbnail.id.toUpperCase();
  }

  return `THUMB ${index + 1}`;
}

function buildVideoInfoPayload(metadata) {
  const thumbnails = collectThumbnailCandidates(metadata);
  const hdThumbnails = thumbnails.filter(isHdThumbnail);
  const surfacedThumbnails = (hdThumbnails.length > 0 ? hdThumbnails : thumbnails).slice(0, 6);
  const primaryThumbnail = surfacedThumbnails[0] || null;
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : [];

  return {
    id: metadata.id || null,
    title: metadata.title || '',
    description: metadata.description || '',
    tags,
    view_count: metadata.view_count ?? null,
    channel: metadata.channel || metadata.uploader || '',
    thumbnail: primaryThumbnail?.url || metadata.thumbnail || '',
    thumbnails: surfacedThumbnails.map((thumbnail, index) => ({
      url: thumbnail.url,
      width: thumbnail.width,
      height: thumbnail.height,
      label: formatThumbnailLabel(thumbnail, index),
    })),
  };
}

function inferThumbnailExtension(url, contentType) {
  const normalizedType = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (THUMBNAIL_CONTENT_TYPES[normalizedType]) {
    return THUMBNAIL_CONTENT_TYPES[normalizedType];
  }

  try {
    const parsed = new URL(url);
    const extension = path.extname(parsed.pathname);
    return extension && extension.length <= 5 ? extension : '.jpg';
  } catch {
    return '.jpg';
  }
}

function probeCommandAvailability(command, args = ['--version']) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (error) => {
      resolve(!error);
    });
  });
}

async function getToolAvailability() {
  if (!toolAvailabilityPromise) {
    toolAvailabilityPromise = probeCommandAvailability('yt-dlp', ['--version']).then((ytDlp) => ({
      ytDlp,
    }));
  }

  return toolAvailabilityPromise;
}

function extractExpectedBytes(metadata) {
  const requestedFormats = Array.isArray(metadata.requested_formats)
    ? metadata.requested_formats
    : Array.isArray(metadata.requested_downloads)
      ? metadata.requested_downloads
      : [];

  const summedRequestedBytes = requestedFormats.reduce((total, format) => {
    const size = readPositiveNumber(format.filesize) ?? readPositiveNumber(format.filesize_approx);
    return size ? total + size : total;
  }, 0);

  if (summedRequestedBytes > 0) {
    return summedRequestedBytes;
  }

  return readPositiveNumber(metadata.filesize) ?? readPositiveNumber(metadata.filesize_approx) ?? null;
}

function fetchExpectedDownloadBytes(url) {
  return new Promise((resolve) => {
    execFile(
      'yt-dlp',
      [...YTDLP_NETWORK_ARGS, '-J', ...YTDLP_METADATA_ARGS, '-f', VIDEO_FORMAT_SELECTOR, url],
      { maxBuffer: 1024 * 1024 * 10, timeout: YTDLP_METADATA_TIMEOUT_MS },
      (error, stdout) => {
        if (error || !stdout) {
          return resolve(null);
        }

        try {
          const metadata = JSON.parse(stdout);
          resolve(extractExpectedBytes(metadata));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

async function measurePrefixedDownloadBytes(prefix) {
  const entries = await fsp.readdir(WORK_DIR);
  const matchingEntries = entries.filter((entry) => entry.startsWith(prefix));

  if (matchingEntries.length === 0) {
    return 0;
  }

  const stats = await Promise.all(
    matchingEntries.map(async (entry) => {
      const fullPath = path.join(WORK_DIR, entry);
      const detail = await fsp.stat(fullPath);
      return detail.isFile() ? detail.size : 0;
    })
  );

  return stats.reduce((total, size) => total + size, 0);
}

function buildDeliveredFileName(outputPath, requestPrefix) {
  const sourceName = path.basename(outputPath);
  const strippedPrefix = sourceName.startsWith(requestPrefix)
    ? sourceName.slice(requestPrefix.length)
    : sourceName;

  return strippedPrefix;
}

function registerCompletedDownload(filePath, fileName) {
  const token = crypto.randomUUID();
  const cleanupTimer = setTimeout(async () => {
    completedDownloads.delete(token);
    try {
      await fsp.unlink(filePath);
    } catch {
      // Ignore cleanup failures for expired downloads.
    }
  }, DOWNLOAD_TTL_MS);

  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  completedDownloads.set(token, {
    filePath,
    fileName,
    createdAt: Date.now(),
    cleanupTimer,
  });

  return token;
}

function buildAttachmentDisposition(fileName) {
  const originalName = String(fileName || 'download');
  const asciiFallback = sanitizeFileSegment(originalName, 'download').replace(/[^\x20-\x7E]/g, '_') || 'download';
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(originalName)}`;
}

app.get('/', (req, res) => {
  const entry = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(entry)) {
    return res.sendFile(entry);
  }

  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.get('/config', async (req, res) => {
  const toolAvailability = await getToolAvailability();

  res.json({
    deliveryMode: 'browser-download',
    storagePath: COMPLETED_DIR,
    browseSupported: false,
    toolAvailability,
  });
});

app.get('/info', async (req, res) => {
  const url = normalizeExternalUrl(req.query.url);
  if (!url || !isAllowedVideoUrl(url)) {
    return res.status(400).json({ error: 'A valid YouTube URL is required' });
  }

  const toolAvailability = await getToolAvailability();
  if (!toolAvailability.ytDlp) {
    return res.status(503).json({ error: 'yt-dlp is not installed on the server' });
  }

  execFile(
    'yt-dlp',
    [...YTDLP_NETWORK_ARGS, '-J', ...YTDLP_METADATA_ARGS, url],
    { maxBuffer: 1024 * 1024 * 10, timeout: YTDLP_METADATA_TIMEOUT_MS },
    (error, stdout, stderr) => {
      if (error) {
        console.error(error);
        const isTimeout = error.killed || error.signal === 'SIGTERM';
        const detail = String(stderr || '').trim().split('\n').slice(-3).join(' | ');
        return res.status(500).json({
          error: isTimeout
            ? 'Metadata request timed out. Try again.'
            : detail || 'Failed to fetch info',
        });
      }

      try {
        const data = JSON.parse(stdout);
        res.json(buildVideoInfoPayload(data));
      } catch {
        res.status(500).json({ error: 'Failed to parse info' });
      }
    }
  );
});

app.get('/download-thumbnail', async (req, res) => {
  const thumbnailUrl = String(req.query.url || '').trim();
  const title = String(req.query.title || '').trim();
  const label = String(req.query.label || '').trim();

  if (!thumbnailUrl) {
    return res.status(400).json({ error: 'Thumbnail URL required' });
  }

  if (!isAllowedThumbnailUrl(thumbnailUrl)) {
    return res.status(400).json({ error: 'Thumbnail host is not allowed' });
  }

  try {
    const response = await fetch(thumbnailUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Thumbnail request failed with ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const extension = inferThumbnailExtension(thumbnailUrl, contentType);
    const fileName = `${sanitizeFileSegment(
      [title, label].filter(Boolean).join(' ') || 'thumbnail',
      'thumbnail'
    )}${extension}`;
    const buffer = Buffer.from(await response.arrayBuffer());

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Download-Filename, Content-Type');
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Download-Filename', fileName);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Thumbnail download failed:', error);
    res.status(500).json({ error: 'Failed to download thumbnail' });
  }
});

app.get('/browse', (req, res) => {
  res.status(501).json({ error: 'Server-side folder browsing is disabled in browser-download mode' });
});

app.get('/downloads/:token', async (req, res) => {
  const download = completedDownloads.get(req.params.token);

  if (!download) {
    return res.status(404).json({ error: 'Download expired or not found' });
  }

  if (!(await fileExists(download.filePath))) {
    clearTimeout(download.cleanupTimer);
    completedDownloads.delete(req.params.token);
    return res.status(404).json({ error: 'Download file is no longer available' });
  }

  try {
    const stats = await fsp.stat(download.filePath);

    if (!stats.isFile()) {
      throw new Error('Resolved download path is not a file');
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(stats.size));
    res.setHeader('Content-Disposition', buildAttachmentDisposition(download.fileName));

    const stream = fs.createReadStream(download.filePath);

    stream.on('error', (error) => {
      console.error('Download stream failed:', download.filePath, error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream download file' });
      } else {
        res.destroy(error);
      }
    });

    stream.pipe(res);
  } catch (error) {
    console.error('Download file could not be opened:', download.filePath, error);
    clearTimeout(download.cleanupTimer);
    completedDownloads.delete(req.params.token);
    return res.status(404).json({ error: 'Download file is no longer available' });
  }
});

app.get('/download', async (req, res) => {
  const url = normalizeExternalUrl(req.query.url);
  const toolAvailability = await getToolAvailability();

  if (!url || !isAllowedVideoUrl(url)) {
    return res.status(400).json({ error: 'A valid YouTube URL is required' });
  }

  if (!toolAvailability.ytDlp) {
    return res.status(503).json({ error: 'yt-dlp is not installed on the server' });
  }

  await ensureDirectory(WORK_DIR);
  await ensureDirectory(COMPLETED_DIR);

  const requestPrefix = `${TEMP_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
  const outputTemplate = `${requestPrefix}%(title).150B [%(id)s].%(ext)s`;
  const expectedBytesPromise = fetchExpectedDownloadBytes(url);
  const args = [
    ...YTDLP_NETWORK_ARGS,
    '--newline',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_MARKER}%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress._speed_str)s`,
    '--print',
    `after_move:${FILEPATH_MARKER}%(filepath)s`,
    '-f',
    VIDEO_FORMAT_SELECTOR,
    '-P',
    WORK_DIR,
    '-o',
    outputTemplate,
    url,
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ progress: 0 })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  let downloadedFilePath = null;
  let expectedBytes = null;
  let lastProgress = 0;
  let sizePollInFlight = false;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let clientClosed = false;

  const ytdlp = spawn('yt-dlp', args, { cwd: WORK_DIR });

  expectedBytesPromise.then((value) => {
    expectedBytes = value;
  });

  const sendEvent = (payload) => {
    if (clientClosed || res.writableEnded) {
      return;
    }

    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  req.on('close', () => {
    clientClosed = true;
    clearInterval(heartbeat);
    clearInterval(sizeFallbackInterval);
    if (!ytdlp.killed) {
      ytdlp.kill('SIGTERM');
    }
  });

  const handleLine = (line) => {
    if (!line) {
      return;
    }

    if (line.includes(FILEPATH_MARKER)) {
      downloadedFilePath = line.slice(line.indexOf(FILEPATH_MARKER) + FILEPATH_MARKER.length).trim();
      return;
    }

    if (line.includes(PROGRESS_MARKER)) {
      const payload = line.slice(line.indexOf(PROGRESS_MARKER) + PROGRESS_MARKER.length).trim();
      const [
        percentRaw = '',
        downloadedRaw = '',
        totalRaw = '',
        estimateRaw = '',
        speedRaw = '',
      ] = payload.split('|');
      const directProgress = parseFloat(percentRaw.replace(/[^\d.]/g, ''));
      const downloadedBytes = Number(downloadedRaw);
      const totalBytes = Number(totalRaw);
      const estimatedTotalBytes = Number(estimateRaw);
      const fallbackTotalBytes = totalBytes > 0 ? totalBytes : estimatedTotalBytes;
      const progress = Number.isFinite(directProgress)
        ? directProgress
        : downloadedBytes > 0 && fallbackTotalBytes > 0
          ? (downloadedBytes / fallbackTotalBytes) * 100
          : NaN;
      const speed = speedRaw.trim();

      if (Number.isFinite(progress)) {
        lastProgress = Math.max(lastProgress, progress);
        sendEvent({
          progress: Math.max(0, Math.min(100, progress)),
          speed: speed && speed !== 'N/A' ? speed : undefined,
        });
      }
      return;
    }

    const progressMatch = line.match(/(\d+(?:\.\d+)?)%.*?at\s+(\S+)/);
    if (progressMatch) {
      const progress = parseFloat(progressMatch[1]);
      const speed = progressMatch[2];
      lastProgress = Math.max(lastProgress, progress);
      sendEvent({ progress, speed });
    }
  };

  const sizeFallbackInterval = setInterval(async () => {
    if (sizePollInFlight || !expectedBytes || lastProgress >= 99) {
      return;
    }

    sizePollInFlight = true;

    try {
      const downloadedBytes = await measurePrefixedDownloadBytes(requestPrefix);
      if (downloadedBytes <= 0) {
        return;
      }

      const estimatedProgress = Math.min(99, (downloadedBytes / expectedBytes) * 100);
      if (estimatedProgress > lastProgress + 0.2) {
        lastProgress = estimatedProgress;
        sendEvent({ progress: estimatedProgress });
      }
    } catch {
      // Ignore fallback polling failures and continue with yt-dlp-driven updates.
    } finally {
      sizePollInFlight = false;
    }
  }, 1000);

  const consumeChunk = (chunk, streamName) => {
    const text = chunk.toString();
    const buffer = streamName === 'stdout' ? stdoutBuffer + text : stderrBuffer + text;
    const lines = buffer.split(/[\r\n]+/);
    const remainder = lines.pop() || '';

    for (const line of lines) {
      handleLine(line.trim());
    }

    if (streamName === 'stdout') {
      stdoutBuffer = remainder;
    } else {
      stderrBuffer = remainder;
    }
  };

  ytdlp.stdout.on('data', (chunk) => consumeChunk(chunk, 'stdout'));
  ytdlp.stderr.on('data', (chunk) => consumeChunk(chunk, 'stderr'));

  ytdlp.on('error', () => {
    clearInterval(heartbeat);
    clearInterval(sizeFallbackInterval);
    sendEvent({ error: 'Failed to start yt-dlp' });
    res.end();
  });

  ytdlp.on('close', async (code) => {
    try {
      if (stdoutBuffer.trim()) {
        handleLine(stdoutBuffer.trim());
      }
      if (stderrBuffer.trim()) {
        handleLine(stderrBuffer.trim());
      }

      clearInterval(heartbeat);
      clearInterval(sizeFallbackInterval);

      if (code !== 0) {
        const detail = stderrBuffer.trim().split('\n').slice(-4).join(' | ');
        sendEvent({ error: detail || 'Download failed' });
        return res.end();
      }

      if (!downloadedFilePath) {
        downloadedFilePath = await findDownloadedFileFallback(WORK_DIR, requestPrefix);
      }

      if (!downloadedFilePath) {
        sendEvent({ error: 'Downloaded file was not found in the working directory' });
        return res.end();
      }

      sendEvent({
        progress: 99,
        message: 'Preparing browser download...',
      });

      const finalName = buildDeliveredFileName(downloadedFilePath, requestPrefix);
      const targetPath = await buildUniquePath(path.join(COMPLETED_DIR, finalName));

      await moveFile(downloadedFilePath, targetPath);
      const downloadToken = registerCompletedDownload(targetPath, path.basename(targetPath));
      const completionMessage = `Browser download ready: ${path.basename(targetPath)}`;

      sendEvent({
        progress: 100,
        done: true,
        fileName: path.basename(targetPath),
        message: completionMessage,
        downloadUrl: `/downloads/${downloadToken}`,
      });
      res.end();
    } catch (error) {
      clearInterval(heartbeat);
      clearInterval(sizeFallbackInterval);
      console.error('Post-download handling failed:', error);
      sendEvent({
        error: error?.message || 'Download finished but the file could not be prepared for browser delivery',
      });
      res.end();
    }
  });
});

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, HOST, async () => {
  await ensureDirectory(WORK_DIR);
  await ensureDirectory(COMPLETED_DIR);
  const toolAvailability = await getToolAvailability();
  const localNetworkLabel = HOST === '0.0.0.0' ? os.hostname() : HOST;

  console.log(`Server running on http://${localNetworkLabel}:${PORT}`);
  console.log(
    `yt-dlp: ${toolAvailability.ytDlp ? 'yes' : 'no'}`
  );
});
