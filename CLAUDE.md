# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

M4Brew is a self-hosted, containerised web app for batch-converting audiobook folders into single-file M4B format. It runs on Unraid and is accessed via a browser at `http://<unraid-ip>:8586`.

**Stack:** Flask (Python) web UI + Bash processing engine, deployed as a Docker container via `docker-compose.yml`.

**Status:** v1.7.6 — actively maintained. Changes should be focused and conservative.

---

## Repository Layout

```
m4brew/
├── app/
│   ├── web.py              # Flask server — all routes, job management, persistence
│   ├── templates/          # Jinja2 HTML templates
│   │   ├── base.html       # Shared layout, nav, theme bootstrap
│   │   ├── index.html      # Tasks page (main UI)
│   │   ├── about.html      # About page (donate link lives here only)
│   │   ├── settings.html   # Settings form
│   │   ├── history.html    # Job history list
│   │   └── history_detail.html
│   └── static/
│       ├── theme.css       # 12 themes via CSS custom properties
│       ├── tasks.js        # Live polling UI
│       ├── about.css       # About page styles
│       └── images/         # Logo variants (see Unraid Icon section)
├── scripts/
│   └── m4brew.sh           # Core processing engine (Bash)
├── config/                 # Runtime data — gitignored, persisted on host
├── Dockerfile
├── docker-compose.yml
└── requirements.txt
```

---

## Running Locally (without Docker)

```bash
pip install flask
CONFIG_DIR=./config python app/web.py
# Opens at http://localhost:8080
```

---

## Docker Build & Run (on Unraid)

The app data lives at `/mnt/user/appdata/m4brew` on the Unraid host. The SMB share `//<unraid-ip>/appdata/m4brew` maps to this path and is what this repo is checked out into on a Mac via `/Volumes/m4brew`.

```bash
cd /mnt/user/appdata/m4brew
docker compose up -d --build
# Opens at http://<unraid-ip>:8586
```

**Always use `--build`** when changing Python, templates, or static files — the container must be rebuilt. Template changes are not picked up without a rebuild (Flask caches them in memory).

---

## Services

`docker-compose.yml` defines a single service:

| Service | Image | Purpose |
|---------|-------|---------|
| `m4brew` | Built from `./Dockerfile` (`FROM sandreas/m4b-tool:latest`) | Flask web UI + processing engine, port 8586→8080 |

`m4b-tool` and `ffmpeg` are baked into the image via the `sandreas/m4b-tool` base — the bash script calls them directly, in-process. There's no Docker socket, no socket-proxy, and no helper containers.

---

## Networking

The container joins the external `matflix` Docker network (`networks.default.name: matflix` in `docker-compose.yml`). Do not use the auto-created `m4brew_default` network.

---

## Volumes

Audiobook source folders are bind-mounted from the host. All mounts that come from Unassigned Devices (including remote SMB mounts under `/mnt/remotes/`) **must use the `:slave` propagation option**, otherwise the container cannot see mounts established after startup.

Current mounts in `docker-compose.yml`:

```yaml
- /mnt/remotes/<synology-ip>_media/Audiobooks:/DSM_Audiobooks:slave
- /mnt/cache/media/Audiobooks:/Test_Folder:slave
- /mnt/cache/media/Chaptarr/Audiobooks:/Chaptarr:slave
- ./config:/config
```

To add a new audiobook source: add a new line in the same format and rebuild.

---

## Unraid Docker Icon

Set via the `net.unraid.docker.icon` label in `docker-compose.yml`, pointing to `http://<unraid-ip>:8586/static/images/m4brew-logo.png` (served by the container itself).

Available icons in `app/static/images/`:
- `m4brew-logo.png` — light (white cup, transparent background) — **currently used**
- `m4brew-logo-dark.png` — dark cup, transparent background
- `m4brew-logo.svg` / `m4brew-logo-dark.svg` — SVG variants

To change: update the label in `docker-compose.yml`, then `docker compose down && docker compose up -d`. Unraid may cache the icon — clear with `rm -f /var/lib/docker/unraid/images/m4brew.png` then refresh the Docker page.

The Docker Folders plugin manages folder icons separately — update those directly in the plugin settings.

---

## No Build Step

There is no npm, no asset compilation, and no test suite. The frontend is vanilla HTML/CSS/JS with Jinja2 templating. Linting is manual.

---

## Architecture

### Separation of Concerns

- **`app/web.py`** — Flask server. Handles all HTTP routes, settings/history/job persistence, and spawns the bash script in a background thread.
- **`scripts/m4brew.sh`** — Core processing engine. Runs in a subprocess inside the same container; calls the baked-in `m4b-tool`/`ffmpeg` binaries directly, in-process. Emits a JSON summary line at the end that `web.py` parses.
- **`app/templates/`** — Jinja2 HTML templates. `base.html` contains the shared layout and theme bootstrap logic.
- **`app/static/`** — CSS (including `theme.css` with 12 themes) and JS. `tasks.js` drives the live polling UI.

### Job Lifecycle

1. User submits form → `POST /` → `web.py` runs preflight checks → spawns `m4brew.sh` in a background thread
2. Script streams stdout to `/config/job_output.log`
3. Frontend polls `GET /api/job` every 500ms and streams `/job/output` for live display
4. On completion, `web.py` parses the JSON summary from the script's final stdout line and appends to `history.jsonl`

### Persistence (all under `/config/`)

| File | Contents |
|------|----------|
| `settings.json` | User config: root folder, audio mode, bitrate, theme |
| `job.json` | Current/last job state (atomic writes) |
| `job_output.log` | Full script stdout for the active job |
| `history.jsonl` | JSONL of past jobs, max 100 records |

### Docker Mount Mapping

The bash script needs host paths (not container paths) when spawning helper containers. `web.py` inspects its own container mounts and the helper functions `to_host_path()` / `_map_host_to_container_path()` translate container paths (e.g. `/DSM_Audiobooks`) → real host paths.

### Key Flask Routes

```
GET/POST /               Tasks page — start convert/cleanup/correct jobs
GET      /api/job        Current job state (polled by frontend every 500ms)
POST     /job/cancel     Request cancellation (kills process group + containers)
GET      /job/output     Raw log stream
GET/POST /settings       Settings form
GET      /history        Job history list
GET      /history/<idx>  Full output for a specific job
GET      /api/mounts     Available Docker volumes
GET      /api/preflight  Validate root folder path
GET      /health         Health check endpoint (used by Docker HEALTHCHECK)
GET      /about          About page
```

### Bash Script Modes

- **Convert**: Multi-file MP3/M4A folders → single M4B with chapters, originals backed up to `_backup_files/`
- **Cleanup**: Remove `_backup_files/` directories left by prior conversions
- **Correct**: Rename output M4Bs to "Book - Author.m4b" format

All modes support `DRY_RUN=true` which simulates without making changes.

### Theme System

`app/static/theme.css` defines 12 themes via CSS custom properties. The active theme is stored in `settings.json` and applied as a `data-theme` attribute on `<html>` at page load (preventing flash). Theme changes are applied immediately client-side before the settings form saves.

---

## Version Tracking

Version is set in one place: `app/web.py` → `APP_VERSION` constant. It is passed to all templates via a context processor and displayed in the header.

---

## Handover Notes

- The donate/coffee link appears **only on the About page** (`app/templates/about.html`) — do not add it back to `base.html`.
- Volume mounts that go through Unassigned Devices need `:slave` — forgetting this means the container sees an empty directory.
- The SMB share at `/Volumes/m4brew` (Mac) maps directly to `/mnt/user/appdata/m4brew` (Unraid). Edits on either side are the same files.
- There is no staging environment. Changes go straight to production on Unraid.
