import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from './api';

const emptyInfo = {
  title: '',
  description: '',
  tags: [],
  thumbnail: '',
  thumbnails: [],
  channel: '',
  view_count: null,
};

function formatNumber(value) {
  return value == null ? '--' : Number(value).toLocaleString();
}

function isSupportedVideoUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    return [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtu.be',
      'www.youtu.be',
    ].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function safeFilename(value, fallback = 'metadata') {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || fallback;
}

function inferExtensionFromContentType(contentType) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();

  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';

  return '.jpg';
}

function parseFilenameFromDisposition(value) {
  const disposition = String(value || '');
  const utfMatch = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);

  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1]);
    } catch {
      return utfMatch[1];
    }
  }

  const plainMatch = disposition.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  return plainMatch?.[1] || plainMatch?.[2] || '';
}

function getInitial(value) {
  const match = String(value || '').trim().match(/[A-Za-z0-9]/);
  return match ? match[0].toUpperCase() : 'Y';
}

function BrandWordmark({ compact = false, stacked = false }) {
  return (
    <span className={`brand-wordmark ${compact ? 'compact' : ''} ${stacked ? 'stacked' : ''}`} aria-label="YouTube Download Hub">
      <span className="brand-wordmark-line brand-wordmark-line-youtube">
        <span className="brand-word brand-word-blue">YouTube</span>
      </span>
      <span className="brand-wordmark-line brand-wordmark-line-download">
        <span className="brand-word brand-word-red">Download</span>
        <span className="brand-word brand-word-gold">Hub</span>
      </span>
    </span>
  );
}

async function resolveErrorMessage(error, fallback) {
  const responseData = error?.response?.data;

  if (responseData instanceof Blob) {
    try {
      const text = await responseData.text();
      if (!text) return fallback;

      try {
        const parsed = JSON.parse(text);
        return parsed?.error || fallback;
      } catch {
        return text;
      }
    } catch {
      return fallback;
    }
  }

  if (typeof responseData === 'string') {
    return responseData;
  }

  if (typeof responseData?.error === 'string') {
    return responseData.error;
  }

  return error?.message || fallback;
}

export default function App() {
  const [screen, setScreen] = useState('landing');
  const [url, setUrl] = useState('');
  const [toolAvailability, setToolAvailability] = useState({
    ytDlp: true,
  });
  const [status, setStatus] = useState('Paste a YouTube URL to continue');
  const [statusTone, setStatusTone] = useState('info');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [info, setInfo] = useState(emptyInfo);
  const [active, setActive] = useState(false);
  const [thumbnailBusy, setThumbnailBusy] = useState(false);
  const infoTimerRef = useRef(null);
  const infoRequestRef = useRef(0);
  const downloadSourceRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    api.get('/config').then((res) => {
      if (cancelled) return;

      if (res.data?.toolAvailability) {
        setToolAvailability({
          ytDlp: Boolean(res.data.toolAvailability.ytDlp),
        });
      }

      if (res.data?.toolAvailability?.ytDlp === false) {
        setStatus('yt-dlp is missing on the server');
        setStatusTone('error');
      }
    }).catch(() => {});

    return () => {
      cancelled = true;
      if (infoTimerRef.current) {
        clearTimeout(infoTimerRef.current);
      }
      if (downloadSourceRef.current) {
        downloadSourceRef.current.close();
      }
    };
  }, []);

  const hasInfo = useMemo(() => Boolean(info.title || info.description || info.tags.length), [info]);
  const thumbnailUrl = useMemo(
    () => info.thumbnail || info.thumbnails?.[0]?.url || '',
    [info]
  );
  const progressValue = useMemo(
    () => Math.max(0, Math.min(100, Number(progress) || 0)),
    [progress]
  );

  async function fetchInfo(nextUrl, requestId) {
    setBusy(true);
    setStatus('Scanning target...');
    setStatusTone('info');

    try {
      const res = await api.get('/info', { params: { url: nextUrl } });
      if (requestId !== infoRequestRef.current) return;

      setInfo({
        title: res.data?.title || '',
        description: res.data?.description || '',
        tags: Array.isArray(res.data?.tags) ? res.data.tags : [],
        thumbnail: res.data?.thumbnail || '',
        thumbnails: Array.isArray(res.data?.thumbnails) ? res.data.thumbnails : [],
        channel: res.data?.channel || '',
        view_count: res.data?.view_count ?? null,
      });
      setActive(true);
      setStatus('Ready');
      setStatusTone('info');
    } catch (error) {
      if (requestId !== infoRequestRef.current) return;
      setInfo(emptyInfo);
      setActive(false);
      setStatus(error?.response?.data?.error || error.message || 'Scan failed');
      setStatusTone('error');
    } finally {
      if (requestId === infoRequestRef.current) {
        setBusy(false);
      }
    }
  }

  function handleUrlChange(value) {
    setUrl(value);
    setInfo(emptyInfo);
    setActive(false);
    setProgress(0);

    if (infoTimerRef.current) {
      clearTimeout(infoTimerRef.current);
    }

    infoRequestRef.current += 1;
    const requestId = infoRequestRef.current;

    if (!value.trim()) {
      setScreen('landing');
      setStatus('Paste a YouTube URL to continue');
      setStatusTone('info');
      return;
    }

    if (isSupportedVideoUrl(value)) {
      setScreen('details');
      infoTimerRef.current = window.setTimeout(() => fetchInfo(value, requestId), 260);
      return;
    }

    setScreen('landing');
  }

  function resetToLanding() {
    if (infoTimerRef.current) {
      clearTimeout(infoTimerRef.current);
    }

    if (downloadSourceRef.current) {
      downloadSourceRef.current.close();
      downloadSourceRef.current = null;
    }

    infoRequestRef.current += 1;
    setScreen('landing');
    setUrl('');
    setInfo(emptyInfo);
    setActive(false);
    setBusy(false);
    setThumbnailBusy(false);
    setProgress(0);
    setStatus('Paste a YouTube URL to continue');
    setStatusTone('info');
  }

  function copyText(text, label) {
    navigator.clipboard.writeText(text).then(() => {
      setStatus(`${label} copied`);
      setStatusTone('info');
    }).catch(() => {
      setStatus('Clipboard access failed');
      setStatusTone('error');
    });
  }

  function downloadBlob(content, fileName, mimeType) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function downloadFromServer(urlValue, fileName) {
    const anchor = document.createElement('a');
    anchor.href = urlValue;
    anchor.download = fileName || '';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function downloadMetadata() {
    downloadBlob(
      `Title: ${info.title || 'N/A'}\n\nDescription:\n${info.description || 'N/A'}\n\nTags: ${(info.tags || []).join(', ') || 'N/A'}\n`,
      `${safeFilename(info.title || 'video-metadata')}.txt`,
      'text/plain;charset=utf-8'
    );
  }

  async function downloadThumbnail() {
    if (!thumbnailUrl || thumbnailBusy) return;

    setThumbnailBusy(true);
    setStatus('Preparing thumbnail download...');
    setStatusTone('info');

    try {
      const res = await api.get('/download-thumbnail', {
        params: {
          url: thumbnailUrl,
          title: info.title || 'thumbnail',
          label: 'HD',
        },
        responseType: 'blob',
      });

      const contentDisposition = res.headers['content-disposition'];
      const headerFileName = res.headers['x-download-filename'];
      const contentType = res.headers['content-type'] || 'application/octet-stream';
      const fallbackName = `${safeFilename(
        [info.title, 'HD'].filter(Boolean).join(' ') || 'thumbnail',
        'thumbnail'
      )}${inferExtensionFromContentType(contentType)}`;
      const fileName = parseFilenameFromDisposition(contentDisposition) || headerFileName || fallbackName;

      downloadBlob(res.data, fileName, contentType);
      setStatus(`Thumbnail ready: ${fileName}`);
      setStatusTone('info');
    } catch (error) {
      setStatus(await resolveErrorMessage(error, 'Thumbnail download failed'));
      setStatusTone('error');
    } finally {
      setThumbnailBusy(false);
    }
  }

  function startDownload() {
    if (!url || !isSupportedVideoUrl(url)) {
      setStatus('Enter a valid YouTube URL');
      setStatusTone('error');
      return;
    }

    if (!toolAvailability.ytDlp) {
      setStatus('yt-dlp is missing on the server');
      setStatusTone('error');
      return;
    }

    if (downloadSourceRef.current) {
      downloadSourceRef.current.close();
      downloadSourceRef.current = null;
    }

    setBusy(true);
    setStatus('Download in progress...');
    setStatusTone('info');
    setProgress(0);

    const params = new URLSearchParams({ url });
    const source = new EventSource(`/download?${params.toString()}`);
    let completed = false;

    downloadSourceRef.current = source;

    const closeSource = () => {
      if (downloadSourceRef.current === source) {
        downloadSourceRef.current = null;
      }
      source.close();
    };

    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.progress != null) setProgress(Number(data.progress) || 0);
      if (data.message) setStatus(data.message);
      if (data.error) {
        setStatus(data.error);
        setStatusTone('error');
        setBusy(false);
        closeSource();
      }
      if (data.done) {
        completed = true;
        setProgress(100);
        setStatus(data.message || `Complete: ${data.fileName || 'ready'}`);
        setStatusTone('info');
        setBusy(false);
        if (data.downloadUrl) {
          downloadFromServer(data.downloadUrl, data.fileName);
        }
        closeSource();
      }
    };

    source.onerror = () => {
      if (completed) return;
      setStatus('Connection lost');
      setStatusTone('error');
      setBusy(false);
      closeSource();
    };
  }

  return (
    <div className="app-shell">
      <div className="background-grid" />
      <div className="background-orb orb-a" />
      <div className="background-orb orb-b" />

      <main className={`app-frame ${screen === 'details' ? 'app-frame-wide' : ''}`}>
        {screen === 'landing' ? (
          <section className="surface-card landing-card">
            <h1 className="landing-title"><BrandWordmark stacked /></h1>
            <p>Paste a YouTube URL to preview metadata, download the video, and keep the flow clean.</p>

            <label className="landing-input">
              <input
                autoFocus
                value={url}
                onChange={(event) => handleUrlChange(event.target.value)}
                placeholder="Paste a YouTube URL..."
              />
            </label>

            <div className="landing-chips" aria-hidden="true">
              <span className="landing-chip">Video</span>
              <span className="landing-chip">Thumbnail</span>
              <span className="landing-chip">Metadata</span>
            </div>
          </section>
        ) : (
          <section className="detail-shell">
            <header className="surface-card detail-header">
              <div className="detail-brand">
                <h1 className="detail-header-title"><BrandWordmark compact /></h1>
              </div>

              <button className="back-button detail-header-button" onClick={resetToLanding}>
                Add New URL
              </button>
            </header>

            <div className="detail-grid">
              <section className="surface-card preview-card">
                <div className={`visual-stage ${thumbnailUrl ? 'has-media' : 'empty'}`}>
                  {thumbnailUrl ? (
                    <img src={thumbnailUrl} alt={info.title || 'Thumbnail preview'} />
                  ) : (
                    <div className="visual-placeholder">
                      <div className="placeholder-mark">{getInitial(info.title)}</div>
                    </div>
                  )}
                </div>

                <div className="preview-meta">
                  <div className="meta-chip">
                    <span>Channel</span>
                    <strong>{info.channel || '--'}</strong>
                  </div>
                  <div className="meta-chip">
                    <span>Views</span>
                    <strong>{formatNumber(info.view_count)}</strong>
                  </div>
                </div>

                <article className={`status-panel ${statusTone}`}>
                  <div className="status-top">
                    <span className="field-label">Status</span>
                    <div className="progress-pill">{Math.round(progressValue)}%</div>
                  </div>
                  <p>{status}</p>
                  <div className="progress-track">
                    <span style={{ width: `${progressValue}%` }} />
                  </div>
                </article>
              </section>

              <section className="surface-card details-card">
                <div className="details-section">
                  <div className="details-head">
                    <span className="field-label">Title</span>
                    <button className="mini-action" onClick={() => copyText(info.title, 'Title')} disabled={!info.title}>
                      Copy
                    </button>
                  </div>
                  <p className="details-text details-title">
                    {info.title || 'Title will appear here after validation.'}
                  </p>
                </div>

                <div className="details-section">
                  <div className="details-head">
                    <span className="field-label">Description</span>
                    <button
                      className="mini-action"
                      onClick={() => copyText(info.description, 'Description')}
                      disabled={!info.description}
                    >
                      Copy
                    </button>
                  </div>
                  <p className="details-scroll">
                    {info.description || 'Description will appear here after validation.'}
                  </p>
                </div>

                <div className="details-section">
                  <div className="details-head">
                    <span className="field-label">Tags</span>
                    <button
                      className="mini-action"
                      onClick={() => copyText((info.tags || []).join(', '), 'Tags')}
                      disabled={!info.tags.length}
                    >
                      Copy
                    </button>
                  </div>
                  <div className="tag-cloud">
                    {info.tags.length ? (
                      info.tags.map((tag) => (
                        <span key={tag} className="tag-pill">{tag}</span>
                      ))
                    ) : (
                      <span className="tag-pill tag-pill-empty">No tags</span>
                    )}
                  </div>
                </div>
              </section>
            </div>

            <div className="detail-actions">
              <button
                className="button button-primary"
                onClick={startDownload}
                disabled={busy || !url || !toolAvailability.ytDlp}
              >
                Video Download
              </button>
              <button
                className="button button-secondary"
                onClick={downloadThumbnail}
                disabled={!thumbnailUrl || thumbnailBusy}
              >
                {thumbnailBusy ? 'Preparing...' : 'Thumbnail Download'}
              </button>
              <button
                className="button button-tertiary"
                onClick={downloadMetadata}
                disabled={!hasInfo}
              >
                Metadata Download
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
