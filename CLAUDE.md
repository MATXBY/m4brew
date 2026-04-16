# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

M4Brew is a containerized web app for batch-converting audiobook folders into single-file M4B format. It's a **Flask web UI + Bash processing engine** deployed as a Docker container.

## Running Locally (without Docker)

```bash
pip install flask
CONFIG_DIR=./config python app/web.py
# Opens at http://localhost:8080
```

## Docker Build & Run

```bash
docker compose up -d --build
# Opens at http://localhost:8586
```

The app uses a `docker-compose.yml` with two services: `m4brew` (the web UI, port 8586) and `m4brew-socket-proxy` (a `tecnativa/docker-socket-proxy` that gates access to the Docker socket). The bash script spawns helper containers (`sandreas/m4b-tool`, `linuxserver/ffmpeg`) via the proxy rather than mounting `/var/run/docker.sock` directly.

## No Build Step

There is no npm, no asset compilation, and no test suite. The frontend is vanilla HTML/CSS/JS with Jinja2 templating. Linting is manual.

## Architecture

### Separation of Concerns

- **`app/web.py`** — Flask server (~1043 lines). Handles all HTTP routes, settings/history/job persistence, and spawns the bash script in a background thread.
- **`scripts/m4brew.sh`** — Core processing engine (~967 lines). Runs in a subprocess; all audio work happens here via Docker-in-Docker. Emits a JSON summary line at the end that `web.py` parses.
- **`app/templates/`** — Jinja2 HTML templates. `base.html` contains shared layout and theme bootstrap logic.
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

The bash script needs host paths (not container paths) when spawning helper containers. `web.py` inspects its own container mounts and the helper functions `to_host_path()` / `_map_host_to_container_path()` translate `/audiobooks` → the real host path.

### Key Flask Routes

```
GET/POST /          Tasks page — start convert/cleanup/correct jobs
GET      /api/job   Current job state (read-only, polled by frontend)
POST     /job/cancel  Request cancellation (kills process group + containers)
GET      /job/output  Raw log stream
GET/POST /settings  Settings form
GET      /history   Job history list
GET      /history/<idx>  Full output for a specific job
GET      /api/mounts     Available Docker volumes
GET      /api/preflight  Validate root folder path
```

### Bash Script Modes

- **Convert**: Multi-file MP3/M4A folders → single M4B with chapters, files backed up to `_backup_files/`
- **Cleanup**: Remove `_backup_files/` directories left by prior conversions
- **Correct**: Rename output M4Bs to "Book - Author.m4b" format

All modes support `DRY_RUN=true` which simulates without making changes.

### Theme System

`app/static/theme.css` defines 12 themes via CSS custom properties. The active theme is stored in `settings.json` and applied as a `data-theme` attribute on `<html>` at page load (preventing flash). Theme changes are applied immediately client-side before the settings form saves.

## Version Tracking

Version is maintained in two places — keep them in sync when bumping:
- `app/static/theme.css` → `--ui-version` CSS variable
- `Dockerfile` → `LABEL app.version`
