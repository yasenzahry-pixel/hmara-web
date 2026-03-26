import React, { useEffect, useMemo, useState } from 'react';
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

function safeFilename(value, fallback = 'metadata') {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || fallback;
}

export default function App() {
  const [url, setUrl] = useState('');
  const [downloadPath, setDownloadPath] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [status, setStatus] = useState('Ready');
  const [statusTone, setStatusTone] = useState('info');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [info, setInfo] = useState(emptyInfo);
  const [active, setActive] = useState(false);

  useEffect(() => {
    api.get('/config').then((res) => {
      if (res.data?.rootDir) {
        setRootDir(res.data.rootDir);
      }
    }).catch(() => {});
  }, []);

  const hasInfo = useMemo(() => Boolean(info.title || info.description || info.tags.length), [info]);

  async function fetchInfo(nextUrl) {
    setBusy(true);
    setStatus('Scanning target...');
    setStatusTone('info');
    try {
      const res = await api.get('/info', { params: { url: nextUrl } });
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
      setStatus('Target locked');
      setStatusTone('info');
    } catch (err) {
      setInfo(emptyInfo);
      setActive(false);
      setStatus(err?.response?.data?.error || err.message || 'Scan failed');
      setStatusTone('error');
    } finally {
      setBusy(false);
    }
  }

  function handleUrlChange(value) {
    setUrl(value);
    setActive(false);
    setInfo(emptyInfo);
    setProgress(0);

    if (value.includes('youtube.com') || value.includes('youtu.be')) {
      clearTimeout(window.__ytTimer);
      window.__ytTimer = setTimeout(() => fetchInfo(value), 550);
    }
  }

  async function browseFolder() {
    try {
      const res = await api.get('/browse');
      if (res.data?.path) {
        setDownloadPath(res.data.path);
      }
    } catch {
      setStatus('Folder selection failed');
      setStatusTone('error');
    }
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
    const blob = new Blob([content], { type: mimeType });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(href);
  }

  function downloadMetadata() {
    downloadBlob(
      `Title: ${info.title || 'N/A'}\n\nDescription:\n${info.description || 'N/A'}\n\nTags: ${(info.tags || []).join(', ') || 'N/A'}\n`,
      `${safeFilename(info.title || 'video-metadata')}.txt`,
      'text/plain;charset=utf-8'
    );
  }

  function downloadThumbnail() {
    const thumb = info.thumbnail || info.thumbnails?.[0]?.url;
    if (!thumb) return;
    const a = document.createElement('a');
    a.href = `/download-thumbnail?url=${encodeURIComponent(thumb)}&title=${encodeURIComponent(info.title || 'thumbnail')}&label=${encodeURIComponent('HD')}`;
    a.click();
  }

  function startDownload() {
    if (!url) return;
    setBusy(true);
    setStatus('Download in progress...');
    setStatusTone('info');
    setProgress(0);

    const params = new URLSearchParams({ url });
    if (downloadPath) params.set('path', downloadPath);
    const source = new EventSource(`/download?${params.toString()}`);

    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.progress != null) setProgress(Number(data.progress) || 0);
      if (data.message) setStatus(data.message);
      if (data.error) {
        setStatus(data.error);
        setStatusTone('error');
        setBusy(false);
        source.close();
      }
      if (data.done) {
        setStatus(`Complete: ${data.finalPath || rootDir || 'ready'}`);
        setStatusTone('info');
        setBusy(false);
        source.close();
      }
    };

    source.onerror = () => {
      setStatus('Connection lost');
      setStatusTone('error');
      setBusy(false);
      source.close();
    };
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <main className="layout">
        <section className="panel controls">
          <div className="brand-block">
            <div className="chip-row">
              <span className="chip">Desktop tuned</span>
              <span className="chip">Mobile tuned</span>
            </div>
            <h1>Next-Gen Media Extraction</h1>
            <p>Production-style Vite + React rebuild with Express backend, axios API calls, and Replit-friendly layout.</p>
          </div>

          <div className="field-card">
            <label>Target URL</label>
            <input value={url} onChange={(e) => handleUrlChange(e.target.value)} placeholder="Paste a YouTube URL..." />
          </div>

          <div className="field-card">
            <label>Extraction Destination</label>
            <div className="inline-row">
              <input value={downloadPath} onChange={(e) => setDownloadPath(e.target.value)} placeholder={rootDir || 'Default path'} />
              <button className="secondary" onClick={browseFolder}>Browse</button>
            </div>
          </div>

          <button className="primary" onClick={startDownload} disabled={busy || !url}>
            {busy ? 'Working...' : 'Extract Media'}
          </button>

          <div className={`status ${statusTone}`}>
            <span>{status}</span>
            <div className="progress">
              <div style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
            </div>
          </div>
        </section>

        <section className={`panel preview ${active ? 'visible' : ''}`}>
          <div className="preview-head">
            <div>
              <div className="eyebrow">Target Locked</div>
              <h2>{info.title || 'Waiting for target'}</h2>
              <div className="channel-pill">{info.channel || 'Unknown channel'}</div>
            </div>
            <span className="verified">Verified</span>
          </div>

          <div className="preview-grid">
            <div className="visual">
              <img src={info.thumbnail || ''} alt="Thumbnail" />
              <button className="mini" onClick={downloadThumbnail} disabled={!info.thumbnail}>Download HD Thumbnail</button>
              <div className="stats">
                <div className="metric"><span>Views</span><strong>{formatNumber(info.view_count)}</strong></div>
                <div className="metric"><span>Tags</span><strong>{info.tags.length}</strong></div>
              </div>
            </div>

            <div className="details">
              <div className="card">
                <div className="card-head">
                  <span>Title</span>
                  <button className="mini" onClick={() => copyText(info.title, 'Title')} disabled={!info.title}>Copy</button>
                </div>
                <p className="clamp">{info.title || 'No title loaded yet.'}</p>
                <button className="mini full" onClick={downloadMetadata} disabled={!hasInfo}>Download Metadata TXT</button>
              </div>

              <div className="card">
                <div className="card-head">
                  <span>Description</span>
                  <button className="mini" onClick={() => copyText(info.description, 'Description')} disabled={!info.description}>Copy</button>
                </div>
                <p className="scroll-text">{info.description || 'No description returned.'}</p>
              </div>

              <div className="card">
                <div className="card-head">
                  <span>Tags</span>
                  <button className="mini" onClick={() => copyText((info.tags || []).join(', '), 'Tags')} disabled={!info.tags.length}>Copy</button>
                </div>
                <div className="tags">
                  {info.tags.length ? info.tags.map((tag) => <span key={tag} className="tag">{tag}</span>) : <span className="tag ghost">No tags loaded yet.</span>}
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
