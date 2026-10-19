# Upgrading

Back up first ([backup.md](backup.md)). Then read the [version notes](#version-notes) for everything newer than
what you run now.

## Docker

```bash
git pull
docker compose up -d --build
```

The `api` container runs the database migrations and `collectstatic` before it starts serving.

## Without Docker

```bash
cd /opt/doory
sudo -u doory git pull
cd backend
sudo -u doory .venv/bin/pip install -r requirements.txt
manage migrate
manage collectstatic --noinput
cd ../frontend
sudo -u doory npm ci && sudo -u doory npm run build
sudo systemctl restart doory-api doory-realtime    # and doory-mcp, doory-ai-server if you use them
```

(`manage` is the helper from [manual.md](manual.md#3-the-api).)

If `deploy/nginx.conf` or a file in `deploy/*.service` changed, copy it again. Keep your own edits, such as
`server_name`, then reload:

```bash
git diff ORIG_HEAD -- deploy/        # what changed in this pull
sudo systemctl daemon-reload && sudo nginx -t && sudo systemctl reload nginx
```

## Version notes

Changes that need you to do something, newest first. Changes that need nothing aren't listed here.

### 2026-10-19: video uploads (opt-in)

- New setting `VIDEO_ASSETS_ENABLED` (off by default) and the build argument `INSTALL_FFMPEG` (off by
  default, adds about 250 MB to the API image). Nothing changes unless you turn video uploads on; see
  [configuration.md](configuration.md#video-assets).
- **Without Docker:** install ffmpeg on the machine (`apt-get install ffmpeg`) before turning it on.

### 2026-10-18: separate storage for server-side image exports

- **Docker:** a new `exports` volume and `EXPORT_STORAGE_ROOT=/app/exports`. `docker compose up -d` creates them.
- **Without Docker:** exports go to `backend/exports` (`EXPORT_STORAGE_ROOT`). Make sure the `doory` user can
  write there.

### 2026-10-18: server-side image export (opt-in)

- New settings `SERVER_IMAGE_EXPORT_ENABLED` and `EXPORT_RENDER_PAGE_URL`. The `web` service gets the network
  alias `doory-web`. Nothing changes unless you turn image export on; see [image-export.md](image-export.md).

### 2026-10-16: MCP server (opt-in)

- **Docker:** a new `mcp` service, started only with `COMPOSE_PROFILES=mcp`.
- **Without Docker:** a new `deploy/doory-mcp.service` and an `/mcp` block in `deploy/nginx.conf`. Copy the new
  `nginx.conf` even if you don't turn MCP on, so `/mcp` isn't served as the app's index page.
- See [mcp.md](mcp.md).

### Size presets from a file

- New settings `DOORY_SIZE_PRESETS_FILE` and `DOORY_SIZE_PRESETS_MODE`. Nothing to do unless you use them; see
  [content.md](content.md#size-presets).
