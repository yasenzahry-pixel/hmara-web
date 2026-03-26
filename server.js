const express = require('express');
const { spawn, exec, execFile } = require('child_process');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const fsp = fs.promises;
const app = express();
const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const TEMP_PREFIX = '__yt_root_tmp__';
const FILEPATH_MARKER = '__FILEPATH__:';
const PROGRESS_MARKER = '__PROGRESS__:';
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
const THUMBNAIL_CONTENT_TYPES = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const MP4_FAMILY_FORMATS = new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2']);

let ffmpegEncodersPromise = null;

app.use(cors());
app.use(express.static(DIST_DIR));
app.use(express.static(ROOT_DIR));

function resolveDestinationPath(downloadPath) {
  if (!downloadPath) {
    return ROOT_DIR;
  }

  return path.isAbsolute(downloadPath)
    ? downloadPath
    : path.resolve(ROOT_DIR, downloadPath);
}

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

async function findDownloadedFileFallback(prefix = TEMP_PREFIX) {
  const entries = await fsp.readdir(ROOT_DIR);
  const prefixedFiles = entries.filter((entry) => entry.startsWith(prefix));

  if (prefixedFiles.length === 0) {
    return null;
  }

  const detailed = await Promise.all(
    prefixedFiles.map(async (entry) => {
      const fullPath = path.join(ROOT_DIR, entry);
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

function execFileCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function getFfmpegEncoders() {
  if (!ffmpegEncodersPromise) {
    ffmpegEncodersPromise = execFileCapture(
      'ffmpeg',
      ['-hide_banner', '-encoders'],
      { maxBuffer: 1024 * 1024 * 2 }
    )
      .then(({ stdout }) => {
        const encoders = new Set();

        stdout.split(/\r?\n/).forEach((line) => {
          const match = line.match(/^\s*[A-Z.]{6}\s+([^\s]+)/);
          if (match) {
            encoders.add(match[1]);
          }
        });

        return encoders;
      })
      .catch(() => new Set());
  }

  return ffmpegEncodersPromise;
}

async function getPreferredVideoEncoder() {
  const encoders = await getFfmpegEncoders();
  return encoders.has('h264_videotoolbox') ? 'h264_videotoolbox' : 'libx264';
}

async function getPreferredAudioEncoder() {
  const encoders = await getFfmpegEncoders();
  return encoders.has('aac_at') ? 'aac_at' : 'aac';
}

async function probeMedia(inputPath) {
  const { stdout } = await execFileCapture(
    'ffprobe',
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_entries',
      'format=format_name:stream=index,codec_type,codec_name,pix_fmt,width,height',
      inputPath,
    ],
    { maxBuffer: 1024 * 1024 * 2 }
  );

  return JSON.parse(stdout);
}

function getPrimaryStream(metadata, codecType) {
  return Array.isArray(metadata.streams)
    ? metadata.streams.find((stream) => stream.codec_type === codecType) || null
    : null;
}

function isEvenDimension(value) {
  return !Number.isFinite(value) || value % 2 === 0;
}

function isMp4FamilyFormat(formatName) {
  return String(formatName || '')
    .split(',')
    .some((format) => MP4_FAMILY_FORMATS.has(format.trim()));
}

function isQuickTimeReadyVideo(stream) {
  return Boolean(
    stream &&
      stream.codec_name === 'h264' &&
      (!stream.pix_fmt || stream.pix_fmt.startsWith('yuv420')) &&
      isEvenDimension(stream.width) &&
      isEvenDimension(stream.height)
  );
}

function isQuickTimeReadyAudio(stream) {
  return !stream || stream.codec_name === 'aac';
}

async function planQuickTimeOptimization(inputPath) {
  const metadata = await probeMedia(inputPath);
  const videoStream = getPrimaryStream(metadata, 'video');
  const audioStream = getPrimaryStream(metadata, 'audio');
  const containerReady = isMp4FamilyFormat(metadata.format?.format_name);
  const videoReady = isQuickTimeReadyVideo(videoStream);
  const audioReady = isQuickTimeReadyAudio(audioStream);

  if (!videoStream) {
    throw new Error('Downloaded file does not contain a video stream');
  }

  if (videoReady && audioReady && containerReady) {
    return {
      mode: 'passthrough',
      message: 'Source already Apple-compatible. Skipping conversion.',
      inputPath,
      outputPath: inputPath,
      hasAudio: Boolean(audioStream),
    };
  }

  const parsed = path.parse(inputPath);
  const outputPath = path.join(parsed.dir, `${parsed.name}__qt.mp4`);

  if (videoReady) {
    return {
      mode: audioReady ? 'remux' : 'audio-transcode',
      message: audioReady
        ? 'Fast MP4 remux in progress...'
        : 'Copying video and converting audio only...',
      inputPath,
      outputPath,
      hasAudio: Boolean(audioStream),
    };
  }

  const videoEncoder = await getPreferredVideoEncoder();
  const audioEncoder = audioReady || !audioStream ? null : await getPreferredAudioEncoder();

  return {
    mode: 'full-transcode',
    message:
      videoEncoder === 'h264_videotoolbox'
        ? 'Hardware-accelerated MP4 conversion in progress...'
        : 'Fast MP4 conversion in progress...',
    inputPath,
    outputPath,
    hasAudio: Boolean(audioStream),
    videoEncoder,
    audioEncoder,
    copyAudio: audioReady,
  };
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
  const entries = await fsp.readdir(ROOT_DIR);
  const matchingEntries = entries.filter((entry) => entry.startsWith(prefix));

  if (matchingEntries.length === 0) {
    return 0;
  }

  const stats = await Promise.all(
    matchingEntries.map(async (entry) => {
      const fullPath = path.join(ROOT_DIR, entry);
      const detail = await fsp.stat(fullPath);
      return detail.isFile() ? detail.size : 0;
    })
  );

  return stats.reduce((total, size) => total + size, 0);
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const detail = stderr.trim().split('\n').slice(-6).join(' | ');
      reject(new Error(detail || `${command} exited with code ${code}`));
    });
  });
}

async function convertToQuickTimeMp4(inputPath, existingPlan = null) {
  const plan = existingPlan || await planQuickTimeOptimization(inputPath);

  if (plan.mode === 'passthrough') {
    return plan;
  }

  const ffmpegArgs = ['-y', '-i', inputPath, '-map', '0:v:0', '-map', '0:a:0?'];

  if (plan.mode === 'remux') {
    ffmpegArgs.push('-c:v', 'copy', '-c:a', 'copy');
  } else if (plan.mode === 'audio-transcode') {
    const audioEncoder = await getPreferredAudioEncoder();
    ffmpegArgs.push('-c:v', 'copy', '-c:a', audioEncoder, '-b:a', '160k');
  } else {
    ffmpegArgs.push('-c:v', plan.videoEncoder);

    if (plan.videoEncoder === 'h264_videotoolbox') {
      ffmpegArgs.push('-allow_sw', '1', '-realtime', 'true', '-b:v', '6000k', '-maxrate', '8000k', '-bufsize', '12000k');
    } else {
      ffmpegArgs.push('-preset', 'ultrafast', '-crf', '23');
    }

    ffmpegArgs.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p');

    if (!plan.hasAudio) {
      ffmpegArgs.push('-an');
    } else if (plan.copyAudio) {
      ffmpegArgs.push('-c:a', 'copy');
    } else {
      ffmpegArgs.push('-c:a', plan.audioEncoder, '-b:a', '160k');
    }
  }

  ffmpegArgs.push('-movflags', '+faststart', plan.outputPath);

  await runProcess('ffmpeg', ffmpegArgs);
  await fsp.unlink(inputPath);

  return plan;
}

app.get('/', (req, res) => {
  const entry = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(entry)) {
    return res.sendFile(entry);
  }

  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.get('/config', (req, res) => {
  res.json({ rootDir: ROOT_DIR });
});

app.get('/info', (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'URL required' });
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

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Thumbnail download failed:', error);
    res.status(500).json({ error: 'Failed to download thumbnail' });
  }
});

app.get('/browse', (req, res) => {
  exec(
    `osascript -e 'POSIX path of (choose folder with prompt "Select Download Destination")'`,
    (error, stdout) => {
      if (error) {
        return res.status(500).json({ error: 'Folder selection cancelled or failed' });
      }

      res.json({ path: stdout.trim() });
    }
  );
});

app.get('/download', (req, res) => {
  const url = req.query.url;
  const requestedPath = req.query.path;

  if (!url) {
    return res.status(400).end();
  }

  const destinationDir = resolveDestinationPath(requestedPath);
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
    ROOT_DIR,
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

  const ytdlp = spawn('yt-dlp', args, { cwd: ROOT_DIR });

  expectedBytesPromise.then((value) => {
    expectedBytes = value;
  });

  req.on('close', () => {
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
        res.write(
          `data: ${JSON.stringify({
            progress: Math.max(0, Math.min(100, progress)),
            speed: speed && speed !== 'N/A' ? speed : undefined,
          })}\n\n`
        );
      }
      return;
    }

    const progressMatch = line.match(/(\d+(?:\.\d+)?)%.*?at\s+(\S+)/);
    if (progressMatch) {
      const progress = parseFloat(progressMatch[1]);
      const speed = progressMatch[2];
      lastProgress = Math.max(lastProgress, progress);
      res.write(`data: ${JSON.stringify({ progress, speed })}\n\n`);
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
        res.write(`data: ${JSON.stringify({ progress: estimatedProgress })}\n\n`);
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
    res.write(`data: ${JSON.stringify({ error: 'Failed to start yt-dlp' })}\n\n`);
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
        res.write(`data: ${JSON.stringify({ error: 'Download failed' })}\n\n`);
        return res.end();
      }

      if (!downloadedFilePath) {
        downloadedFilePath = await findDownloadedFileFallback(requestPrefix);
      }

      if (!downloadedFilePath) {
        res.write(`data: ${JSON.stringify({ error: 'Downloaded file was not found in the project root' })}\n\n`);
        return res.end();
      }

      await fsp.mkdir(destinationDir, { recursive: true });

      const conversionPlan = await planQuickTimeOptimization(downloadedFilePath);

      res.write(
        `data: ${JSON.stringify({
          progress: 99,
          message: conversionPlan.message,
        })}\n\n`
      );

      const conversionResult = await convertToQuickTimeMp4(downloadedFilePath, conversionPlan);
      const sourceName = path.basename(conversionResult.outputPath);
      const finalName = sourceName.startsWith(requestPrefix)
        ? sourceName.slice(requestPrefix.length).replace(/__qt\.mp4$/i, '.mp4')
        : sourceName.replace(/__qt\.mp4$/i, '.mp4');
      const targetPath = await buildUniquePath(path.join(destinationDir, finalName));

      await moveFile(conversionResult.outputPath, targetPath);

      res.write(
        `data: ${JSON.stringify({
          progress: 100,
          done: true,
          optimizationMode: conversionResult.mode,
          rootPath: path.join(ROOT_DIR, sourceName),
          finalPath: targetPath,
        })}\n\n`
      );
      res.end();
    } catch (error) {
      clearInterval(heartbeat);
      clearInterval(sizeFallbackInterval);
      console.error('Post-download handling failed:', error);
      res.write(`data: ${JSON.stringify({ error: 'Download finished but the file could not be moved' })}\n\n`);
      res.end();
    }
  });
});

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
