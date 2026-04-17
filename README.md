# M4Brew

**Brew better audiobooks.**

M4Brew converts messy audiobook folders into clean, reliable, chapterised M4B (AAC) files — safely, predictably, and without manual FFmpeg work.

Designed for users of:
	•	Plex
	•	Jellyfin
	•	Audiobookshelf
	•	Any M4B-friendly player

---

## 📸 Screenshots

| Espresso Theme | 12 Distictive Themes |
|--------|--------|
| ![](docs/screenshots/Home_1.png) | ![](docs/screenshots/Home_2.png) |

| Converting Status - Simple / Advanced  | History - Full Log Outputs |
|------------|----------|
| ![](docs/screenshots/Task_Convert.png) | ![](docs/screenshots/Task_History.png)

---

### Who it's for

M4Brew is for anyone with audiobook folders full of:
	•	MP3 parts
	•	M4A files
	•	Split M4B files

…who wants clean, properly structured single-file .m4b outputs **without scripting or command line work.**

⸻

### What M4Brew Does

M4Brew batch converts audiobooks into **single, chapterised .m4b files** using FFmpeg under the hood.
Each source file becomes a chapter in the final book.
Output files are:
	•	Easier for media managers to recognise
	•	Cleaner to tag and match with metadata
	•	More reliable across players
	•	Safer to back up

⸻

### Supported Input Formats
	•	MP3 (single or multi-file)
	•	M4A (single or multi-file)
	•	M4B (multi-file merge)
Output is always:
A single chapterised .m4b file (AAC audio)

⸻

### Smart Merging

M4Brew includes intelligent safety checks:
	•	Multi-file books are merged in correct numeric order
	•	If part order is unclear, the book is skipped safely
	•	No partial or incorrectly ordered merges
	•	Clear warnings are shown in the UI and history
Safety is always prioritised over guessing.

⸻

### Test vs Run

Every task supports two modes:
**Test**
	•	Simulates the operation
	•	Shows exactly what would happen
	•	Makes no changes
**Run**
	•	Performs the actual conversion / rename / cleanup
	•	Safe cancel support
	•	No half-written files
***Nothing destructive happens unless you explicitly run it.***

⸻

### Folder Structure (Required)

***M4Brew expects your audiobooks to be organised like this:***

```text
Audiobooks/
└── Author Name/
    └── Book Title/
        └── audio files
```

This structure ensures:
	•	**Correct output naming**
	•	**Reliable metadata matching**
	•	**Consistent chapter generation**

⸻

## Deployment (Docker Compose)

A `docker-compose.yml` is included. Edit the audiobooks volume path to match your setup, then run:

```bash
docker compose up -d
```

### Optional environment variables

| Variable | Description |
|---|---|
| `AUTH_PASSWORD` | Set to enable HTTP Basic Auth (password-protect the UI) |
| `SECRET_KEY` | Fixed secret for CSRF tokens — recommended if you want sessions to survive container restarts |
| `PUID` / `PGID` | User/group ID for file permissions |

⸻

## Unraid Setup

Edit `docker-compose.yml` and set your audiobook paths, `PUID`, `PGID`, and optionally `AUTH_PASSWORD`. The included compose file uses a Docker socket proxy for improved security — M4Brew only gets the Docker permissions it actually needs.

Config is stored in `./config` next to the compose file.

⸻

## Audio Settings

You can choose:
	•	Custom output
	•	Custom bitrate
	•	Or **Match both**

⸻

## Safety Design

M4Brew is intentionally cautious:
	•	***Originals are never automatically deleted***
	•	Converted files are created alongside your structure
	•	Cleanup is a separate, explicit step
	•	Order issues do not stop the whole batch
	•	Warnings are logged clearly in History

***No surprises.***

⸻

## Under the Hood

M4Brew uses:
	•	**FFmpeg** for audio processing
	•	**Flask** + **Gunicorn** web server
	•	**Docker socket proxy** to limit container permissions
	•	Docker container deployment

It wraps professional media tooling in a focused interface built specifically for audiobook workflows.

⸻

## Themes

M4Brew includes **12 visual themes.**
Because if you're going to brew audiobooks…
it might as well look good while doing it.

⸻

Project Status - v2.0.0 — Stable
	•	Core conversion workflow complete
	•	Security hardened (auth, CSRF protection, input whitelisting, non-root container)
	•	Safety logic hardened
	•	Batch behaviour reliable
	•	History logging polished

Enjoy.

☕
