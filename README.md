# yt-download

YouTube metadata and browser-download app built with Express and Vite.

## Local development

```bash
npm install
npm run dev
```

The frontend runs through Vite, and the backend runs through `server.js`.

## Production runtime

The production server serves the built frontend from `dist` and listens on:

- `HOST=0.0.0.0`
- `PORT=3000`

It also expects:

- `yt-dlp` installed on the server/container
- `ffmpeg` installed for merged audio/video downloads
- `DOWNLOAD_DIR` set to a writable directory, recommended: `/app/.runtime/completed`

## Docker

Build locally:

```bash
docker build -t yt-download .
docker run --rm -p 3000:3000 -e PORT=3000 -e HOST=0.0.0.0 -e DOWNLOAD_DIR=/app/.runtime/completed yt-download
```

Verify the container:

```bash
curl http://localhost:3000/config
```

Expected result includes `toolAvailability.ytDlp: true`.

## Coolify deployment

Create this app as a Git-based **Application** in Coolify and use the **Dockerfile** build pack.

### New Resource flow

1. Open your project in Coolify.
2. Click `+ New` or `Create New Resource`.
3. Choose `Public Repository` if the GitHub repo is public, otherwise connect the private repo through GitHub App or deploy key.
4. Select your EC2 server.
5. Paste the GitHub repository URL and click `Check Repository`.
6. Change the build pack from `Nixpacks` to `Dockerfile`.
7. Keep `Base Directory` as `/`.
8. Keep the Dockerfile path as `Dockerfile`.
9. Continue to network settings and expose port `3000`.
10. Leave domain empty for now if you do not have one yet; use the generated Coolify URL or server IP for first access.

### Environment variables

Set these in Coolify:

```env
PORT=3000
HOST=0.0.0.0
DOWNLOAD_DIR=/app/.runtime/completed
```

### Persistent storage

Recommended: mount persistent storage to:

```text
/app/.runtime/completed
```

This keeps completed downloads available across container restarts.

### Post-deploy checks

After deployment:

1. Open the logs and confirm:
   - `Server running on http://...:3000`
   - `yt-dlp: yes`
2. Open the app URL and verify the UI loads.
3. Call `/config` and confirm `toolAvailability.ytDlp` is `true`.
4. Test `/info?url=<youtube-url>`.
5. Test the download flow and confirm `/downloads/:token` serves the file.

### Domain later

When you get a domain:

1. Point an `A` record to the EC2 public IP.
2. Add the domain in Coolify, for example `yt.yourdomain.com`.
3. Enable SSL / Let's Encrypt in Coolify.
