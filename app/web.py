import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import Flask, Response, jsonify, redirect, render_template, request, send_file, url_for
from flask_wtf.csrf import CSRFProtect

from job_common import (
    CONFIG_DIR,
    SETTINGS_PATH,
    HISTORY_PATH,
    JOB_PATH,
    JOB_OUT_PATH,
    read_json,
    write_json,
    now_utc_iso,
    parse_ts,
    read_history,
    write_history,
    append_history_record,
    _load_job,
    _save_job,
    _pid_is_running,
    _job_is_running,
    _kill_job_labeled_containers,
    _signal_proc_group,
)

AUTH_PASSWORD = os.environ.get("AUTH_PASSWORD", "").strip()

JOB_RUNNER_PATH = Path(__file__).resolve().parent / "job_runner.py"

VALID_MODES = {"convert", "cleanup", "correct"}
VALID_AUDIO_MODES = {"match", "mono", "stereo"}
VALID_THEMES = {"dark", "light", "espresso", "latte", "horror", "comedy", "scifi", "fantasy", "romance", "ocean", "holiday", "war"}
VALID_BITRATES = {"match", "32", "48", "64", "80", "96", "112", "128", "160", "192", "224", "256", "320"}
VALID_EFFECTS = {"none", "aurora", "stars", "underwater"}


def _get_secret_key() -> str:
    env_key = os.environ.get("SECRET_KEY", "").strip()
    if env_key:
        return env_key
    key_file = CONFIG_DIR / "secret_key.txt"
    if key_file.exists():
        return key_file.read_text().strip()
    key = os.urandom(32).hex()
    key_file.write_text(key)
    return key


APP_VERSION = "1.8.0"

app = Flask(__name__)
app.config["SECRET_KEY"] = _get_secret_key()
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024  # 16KB — app has no file uploads
app.config["WTF_CSRF_ENABLED"] = True
app.config["WTF_CSRF_TIME_LIMIT"] = None  # no expiry — tokens last the full session
csrf = CSRFProtect(app)


@app.context_processor
def inject_version():
    return {"app_version": APP_VERSION}


@app.before_request
def check_auth():
    if not AUTH_PASSWORD:
        return
    if request.endpoint == "health":
        return
    auth = request.authorization
    if not auth or auth.password != AUTH_PASSWORD:
        return Response(
            "Authentication required",
            401,
            {"WWW-Authenticate": 'Basic realm="M4Brew"'},
        )


@app.get("/health")
@csrf.exempt
def health():
    return "ok", 200


# -------------------------
# Time helpers
# -------------------------
def humanize_ts(ts: str) -> str:
    """Return short age like 11s/4m/2h/3d."""
    if not ts:
        return ""
    try:
        dt = parse_ts(ts)
        if not dt:
            return ""
        sec = int((datetime.now(timezone.utc) - dt).total_seconds())
        if sec < 0:
            sec = 0

        if sec < 60:
            return f"{sec}s"
        m = sec // 60
        if m < 60:
            return f"{m}m"
        h = m // 60
        if h < 24:
            return f"{h}h"
        d = h // 24
        return f"{d}d"
    except Exception:
        return ""


# -------------------------
# Settings
# -------------------------
def load_settings() -> Dict[str, Any]:
    return read_json(SETTINGS_PATH, {})


def save_settings(settings: Dict[str, Any]) -> None:
    write_json(SETTINGS_PATH, settings)


# History, job persistence and cancel-signaling helpers (read_history,
# write_history, append_history_record, _load_job, _save_job,
# _pid_is_running, _job_is_running, _kill_job_labeled_containers,
# _signal_proc_group) live in job_common.py, shared with job_runner.py.


# -------------------------
# Scanning totals (best-effort)
# -------------------------
def _scan_total(mode: str, root_folder: str) -> int:
    root = Path(root_folder)
    if not root.exists():
        return 0

    mode = (mode or "").strip().lower()

    # build list of ROOT/Author/Book dirs
    book_dirs: List[Path] = []
    try:
        for author_dir in root.iterdir():
            if not author_dir.is_dir():
                continue
            if author_dir.name == "#recycle":
                continue
            for book_dir in author_dir.iterdir():
                if book_dir.is_dir():
                    book_dirs.append(book_dir)
    except Exception:
        return 0

    if mode == "cleanup":
        try:
            return sum(1 for p in root.rglob("_backup_files") if p.is_dir())
        except Exception:
            return 0

    if mode == "correct":
        # desired is: "Book - Author.m4b"
        n = 0
        for book_dir in book_dirs:
            author = book_dir.parent.name
            book = book_dir.name
            m4bs = [p for p in book_dir.glob("*.m4b") if not p.name.startswith("._")]
            if len(m4bs) != 1:
                continue
            desired_name = f"{book} - {author}.m4b"
            if m4bs[0].name != desired_name:
                n += 1
        return n

    # convert
    n = 0
    for book_dir in book_dirs:
        m4bs = [p for p in book_dir.glob("*.m4b") if not (p.name.startswith("._") or p.name.startswith(".tmp_") or p.name.startswith("tmp_"))]
        if len(m4bs) == 1 and not [p for p in book_dir.glob("*.mp3") if not p.name.startswith("._")] and not [p for p in book_dir.glob("*.m4a") if not p.name.startswith("._")]:
            continue  # already has single m4b, skip
        if [p for p in book_dir.glob("*.mp3") if not p.name.startswith("._")] or [p for p in book_dir.glob("*.m4a") if not p.name.startswith("._")] or len(m4bs) > 1:
            n += 1
    return n


def start_job(mode: str, dry_run: bool, root_folder: str, audio_mode: str, bitrate) -> Dict[str, Any]:
    root_folder = (root_folder or "").strip()
    if not root_folder:
        return {"status": "error", "error": "root_folder_not_set"}
    existing = _load_job()
    if _job_is_running(existing):
        return existing

    job_id = now_utc_iso().replace(":", "").replace("-", "").replace("T", "_").replace("Z", "")
    total = _scan_total(mode, root_folder)

    job = {
        "id": job_id,
        "cancel_requested": False,
        "status": "running",
        "started": now_utc_iso(),
        "updated": now_utc_iso(),
        "mode": mode,
        "dry_run": dry_run,
        "settings": {"root_folder": root_folder, "audio_mode": audio_mode, "bitrate": bitrate},
        "current": 0,
        "total": total,
        "current_book": "",
        "current_path": "",
        "pid": None,
        "exit_code": None,
        "runtime_s": None,
        "summary": None,
    }
    _save_job(job)

    env = os.environ.copy()
    env.update(
        {
            "MODE": mode,
            "DRY_RUN": "true" if dry_run else "false",
            "ROOT_FOLDER": root_folder,
            "AUDIO_MODE": audio_mode,
            "BITRATE": str(bitrate),
            "JOB_ID": job_id,  # <-- used by scripts/m4brew.sh to label spawned containers
        }
    )

    # Run the job in a genuine detached subprocess (job_runner.py), not a
    # thread inside this gunicorn worker - a multi-hour conversion must
    # never tie up the process that also has to answer HTTP requests.
    # start_new_session=True gives it its own session, independent of this
    # worker's process group. We still need to reap it to avoid a zombie,
    # so a lightweight thread just blocks on proc.wait() and discards the
    # result - it does none of the per-line stdout parsing that used to
    # live here, so it can't contend with request-handling threads.
    runner_log_path = CONFIG_DIR / "job_runner_stderr.log"
    with open(runner_log_path, "wb") as runner_log:
        proc = subprocess.Popen(
            [sys.executable, "-u", str(JOB_RUNNER_PATH)],
            env=env,
            stdout=runner_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    threading.Thread(target=proc.wait, daemon=True).start()

    return job


def _validated_bitrate(raw, fallback):
    val = str(raw or "").strip().lower()
    if val in VALID_BITRATES:
        return val if val == "match" else int(val)
    fb = str(fallback or "96").strip().lower()
    return fb if fb == "match" else int(fb) if fb in VALID_BITRATES else 96


def _validated_theme(raw, fallback):
    val = str(raw or "").strip().lower()
    return val if val in VALID_THEMES else (str(fallback or "dark") if str(fallback or "dark") in VALID_THEMES else "dark")


def _validated_effect(raw, fallback):
    val = str(raw or "").strip().lower()
    return val if val in VALID_EFFECTS else (str(fallback or "none") if str(fallback or "none") in VALID_EFFECTS else "none")


# -------------------------
# Routes
# -------------------------
@app.get("/")
def index_get():
    settings = load_settings()
    job = _load_job()
    return render_template("index.html", settings=settings, job=job, active_page="tasks")


@app.post("/")
def index_post():
    settings = load_settings() or {}

    # Tasks page only chooses mode + dry_run
    mode_raw = (request.form.get("mode") or settings.get("mode") or "convert").strip().lower()
    mode = mode_raw if mode_raw in VALID_MODES else "convert"
    dry_run = str(request.form.get("dry_run") or settings.get("dry_run") or "true").lower() == "true"

    # Everything else comes from saved Settings
    root_folder = str(settings.get("root_folder") or "").strip()
    audio_mode_raw = str(settings.get("audio_mode") or "match").strip().lower()
    audio_mode = audio_mode_raw if audio_mode_raw in VALID_AUDIO_MODES else "match"
    bitrate_raw = settings.get("bitrate", 96)
    if str(bitrate_raw).strip().lower() == "match":
        bitrate = "match"
    else:
        try:
            bitrate = int(bitrate_raw)
        except Exception:
            bitrate = 96

    # If user hasn't configured Settings yet, send them there
    if not root_folder:
        save_settings({**settings, "mode": mode, "dry_run": "true" if dry_run else "false"})
        return redirect(url_for("settings_get"))

    # Persist last selections (mode + dry_run only)
    save_settings({**settings, "mode": mode, "dry_run": "true" if dry_run else "false"})

    # Server-side guard: do not start jobs if preflight fails
    pf = preflight_root_mapped(root_folder)
    if not pf.get("ok"):
        return redirect(url_for("index_get"))

    root_for_job = pf.get("mapped_path") or root_folder
    start_job(mode, dry_run, root_for_job, audio_mode, bitrate)
    return redirect(url_for("index_get"))


@app.get("/api/job")
def api_job():
    job = _load_job()
    if not job:
        return jsonify({"status": "none"})

    # IMPORTANT: api_job() is READ-ONLY.
    # It must not call _save_job() or mutate persisted state.
    resp = dict(job)

    status = resp.get("status")

    # If it claims running but PID is gone, present derived state (do NOT persist)
    if status == "running" and not _job_is_running(resp):
        rc = resp.get("exit_code")
        try:
            rc = int(rc) if rc is not None else None
        except Exception:
            rc = None

        resp["status"] = "finished" if rc == 0 else "failed"
        resp["pid"] = None

        if resp.get("exit_code") is None:
            resp["exit_code"] = 0 if rc == 0 else 1

        # Derive updated timestamp for display only
        resp["updated"] = resp.get("updated") or now_utc_iso()

        status = resp["status"]

    # For finished/failed: pid is always stale in UI; hide it.
    if status in ("finished", "failed", "canceled"):
        resp["pid"] = None

        # runtime_s: derive for display if missing/0, but do not write back.
        rs = 0
        try:
            rs = int(resp.get("runtime_s") or 0)
        except Exception:
            rs = 0

        if rs <= 0:
            summary = resp.get("summary")
            srs = 0
            if isinstance(summary, dict):
                try:
                    srs = int(summary.get("runtime_s") or 0)
                except Exception:
                    srs = 0

            if srs > 0:
                rs = srs
            else:
                dt_start = parse_ts(str(resp.get("started") or ""))
                dt_end = parse_ts(str(resp.get("updated") or "")) or datetime.now(timezone.utc)
                if dt_start and dt_end:
                    rs = max(1, int((dt_end - dt_start).total_seconds()))
                else:
                    rs = 1

            resp["runtime_s"] = rs

        # Always align summary runtime for DISPLAY (do not persist)
        summary = resp.get("summary")
        if isinstance(summary, dict):
            summary = dict(summary)
            summary["runtime_s"] = rs
            resp["summary"] = summary

    return jsonify(resp)


@app.get("/about")
def about_get():
    return render_template("about.html", settings=load_settings(), active_page="about")


@app.get("/job/output")
def job_output():
    if not JOB_OUT_PATH.exists():
        return Response("", mimetype="text/plain")
    return Response(JOB_OUT_PATH.read_text(encoding="utf-8", errors="replace"), mimetype="text/plain")


@app.post("/job/clear")
def job_clear():
    job = _load_job()
    if job and job.get("status") in ("running", "canceling"):
        return redirect(url_for("index_get"))
    try:
        JOB_PATH.unlink(missing_ok=True)  # type: ignore[arg-type]
    except Exception:
        pass
    try:
        JOB_OUT_PATH.unlink(missing_ok=True)  # type: ignore[arg-type]
    except Exception:
        pass
    return redirect(url_for("index_get"))


@app.post("/job/cancel")
def job_cancel():
    job = _load_job()
    if not job or job.get("status") not in ("running", "canceling"):
        return redirect(url_for("index_get"))

    pid = job.get("pid")
    job_id = str(job.get("id") or "").strip()

    # Mark intent (worker will also react mid-stream)
    job["cancel_requested"] = True
    job["status"] = "canceling"
    _save_job(job)

    # Immediate: kill spawned containers + kill process group
    try:
        _kill_job_labeled_containers(job_id)
    except Exception:
        pass
    try:
        _signal_proc_group(int(pid) if pid is not None else None)
    except Exception:
        pass

    # Write a note into the output log so it’s visible in UI
    try:
        with JOB_OUT_PATH.open("a", encoding="utf-8", errors="replace") as f:
            f.write("\n[cancel] Cancel requested by user.\n")
    except Exception:
        pass

    return redirect(url_for("index_get"))


@app.get("/settings")
def settings_get():
    settings = load_settings()
    return render_template("settings.html", settings=settings, active_page="settings")


@app.post("/settings")
def settings_post():
    existing = load_settings() or {}

    autosave = request.headers.get("X-M4Brew-Autosave") == "1"
    root_dirty = request.headers.get("X-M4Brew-Root-Dirty") == "1"

    incoming_root = (request.form.get("root_folder") or "").strip()

    # Root folder rule:
    # - Normal (non-autosave): accept changes from the Settings page submit.
    # - Autosave: only accept root_folder changes if the UI marked it as "dirty".
    root_folder = (existing.get("root_folder") or "").strip()
    if autosave:
        if root_dirty and incoming_root:
            root_folder = incoming_root
        # else: keep existing root_folder
    else:
        if incoming_root:
            root_folder = incoming_root

    audio_mode_raw = (request.form.get("audio_mode") or existing.get("audio_mode", "match")).strip().lower()
    audio_mode = audio_mode_raw if audio_mode_raw in VALID_AUDIO_MODES else "match"

    updated = {
        "root_folder": root_folder,
        "audio_mode": audio_mode,
        "bitrate": _validated_bitrate(request.form.get("bitrate"), existing.get("bitrate", 96)),
        "theme": _validated_theme(request.form.get("theme"), existing.get("theme", "dark")),
        "effect": _validated_effect(request.form.get("effect"), existing.get("effect", "none")),
        "mode": existing.get("mode", "convert"),
        "dry_run": existing.get("dry_run", "true"),
    }

    save_settings(updated)

    if autosave:
        return ("", 204)

    return redirect(url_for("settings_get"))


@app.get("/history")
def history_get():
    records = list(reversed(read_history()))  # newest first

    def fmt_dur(v) -> str:
        try:
            sec = int(v or 0)
        except Exception:
            sec = 0
        if sec < 60:
            return f"{sec}s"
        m = sec // 60
        if m < 60:
            return f"{m}m"
        h = m // 60
        return f"{h}h"

    mode_labels = {"convert": "Convert", "correct": "Rename", "cleanup": "Delete"}

    enriched = []
    for i, r in enumerate(records):
        ts = r.get("ts", "") or ""
        summary = r.get("summary") or {}
        exit_code = int(r.get("exit_code") or 0)

        success = bool(summary.get("success", exit_code == 0))
        runtime_s = summary.get("runtime_s")
        runtime_h = fmt_dur(runtime_s)

        mode = (r.get("mode") or "").lower()
        created = summary.get("created")
        renamed = summary.get("renamed")
        deleted = summary.get("deleted")
        skipped = summary.get("skipped")
        failed = summary.get("failed")

        completed = created if mode == "convert" else (renamed if mode == "correct" else (deleted if mode == "cleanup" else 0))

        enriched.append(
            {
                "idx": i,
                "ts": ts,
                "ts_human": humanize_ts(ts) if ts else "",
                "mode": mode,
                "mode_label": mode_labels.get(mode, mode),
                "dry_run": bool(r.get("dry_run", False)),
                "success": success,
                "exit_code": exit_code,
                "runtime_s": runtime_s,
                "runtime_h": runtime_h,
                "completed": completed,
                "created": created,
                "skipped": skipped,
                "failed": failed,
            }
        )

    return render_template("history.html", runs=enriched, count=len(enriched), settings=load_settings(), active_page="history")


@app.get("/history/<int:idx>")
def history_detail(idx: int):
    records = list(reversed(read_history()))
    if idx < 0 or idx >= len(records):
        return "Not found", 404
    r = records[idx]
    ts = r.get("ts", "")
    r["ts_human"] = humanize_ts(ts) if ts else ""
    return render_template("history_detail.html", detail=r, settings=load_settings(), active_page="history")


@app.get("/history/download")
def history_download():
    if not HISTORY_PATH.exists():
        return Response("", mimetype="text/plain")
    return send_file(
        HISTORY_PATH,
        as_attachment=True,
        download_name="history.jsonl",
        mimetype="application/x-ndjson",
    )


@app.post("/history/clear")
def history_clear():
    write_history([])
    return redirect(url_for("history_get"))



# --- M4Brew: Preflight checks (NON-DESTRUCTIVE) ---
# Goals:
# - Never create folders on the host
# - Tell the user whether the path is (a) not mounted, (b) missing, (c) not writable
# - Only return "failed" for real job failures, not setup issues

_SYSTEM_DIRS = frozenset([
    "/", "/proc", "/sys", "/dev", "/run", "/tmp",
    "/app", "/config", "/scripts",
    "/bin", "/sbin", "/usr", "/lib", "/lib64",
    "/etc", "/opt", "/root", "/home", "/var",
    "/boot", "/media", "/mnt", "/srv",
])

def _filtered_mounts() -> list[tuple[str, str]]:
    """Return user-mounted audiobook directories by scanning top-level dirs."""
    try:
        dirs = []
        for name in sorted(os.listdir("/")):
            path = "/" + name
            if path not in _SYSTEM_DIRS and os.path.isdir(path):
                dirs.append((path, path))
        return dirs
    except Exception:
        return []


def _map_host_to_container_path(host_path: str) -> tuple[str | None, str | None]:
    """In single-container mode paths are identical — just validate the path is within a known mount."""
    host_path = os.path.normpath(host_path)
    for src, dst in _filtered_mounts():
        if host_path == dst or host_path.startswith(dst.rstrip("/") + "/"):
            return (host_path, src)
    return (None, None)


@app.get("/api/mounts")
def api_mounts():
    mounts = _filtered_mounts()

    items = [{"host": dst, "container": dst} for (src, dst) in mounts]
    items.sort(key=lambda x: x["container"])
    return jsonify({"ok": True, "mounts": items}), 200

def preflight_root_mapped(root: str) -> dict:
    """
    Accept either:
      - container path (e.g. /audiobooks)
      - host path (e.g. /mnt/remotes/.../Audiobooks)
    """
    root = (root or "").strip()
    if not root:
        return {"ok": False, "error_code": "no_root", "message": "No root folder set"}

    # Normalize: allow "audiobooks" -> "/audiobooks"
    if root and not root.startswith("/"):
        root = "/" + root

    root_n = os.path.normpath(root)
    container_path, matched_src = _map_host_to_container_path(root_n)

    if not container_path:
        return {
            "ok": False,
            "error_code": "not_mounted",
            "message": "Folder not available to M4Brew (add it to the Docker template)",
            "root_folder": root,
        }

    if not os.path.isdir(container_path):
        return {
            "ok": False,
            "error_code": "folder_missing",
            "message": "Folder does not exist (check the path)",
            "root_folder": root,
        }

    test_file = os.path.join(container_path, ".m4brew_write_test")
    try:
        with open(test_file, "w", encoding="utf-8") as f:
            f.write("ok\n")
        try:
            os.remove(test_file)
        except Exception:
            pass
    except PermissionError:
        return {
            "ok": False,
            "error_code": "write_denied",
            "message": "Write access denied (check PUID/PGID + permissions)",
            "root_folder": root,
        }
    except Exception:
        return {
            "ok": False,
            "error_code": "unknown",
            "message": "Unexpected error accessing folder (check permissions and path)",
            "root_folder": root,
        }

    return {
        "ok": True,
        "root_folder": root,
        "mapped_path": container_path,
        "matched_mount": matched_src,
    }

@app.route("/api/preflight")
def api_preflight():
    settings = load_settings()
    root = str(settings.get("root_folder", "") or "").strip()
    if not root:
        return jsonify({"ok": False, "error_code": "no_root", "message": "No root folder set"}), 200
    return jsonify(preflight_root_mapped(root)), 200

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
