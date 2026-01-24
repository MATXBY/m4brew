import json
import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import Flask, Response, jsonify, redirect, render_template, request, send_file, url_for

# -------------------------
# JSON helpers (atomic writes)
# -------------------------
def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, data) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

SETTINGS_PATH = CONFIG_DIR / "settings.json"
HISTORY_PATH = CONFIG_DIR / "history.jsonl"

# Job state + output
JOB_PATH = CONFIG_DIR / "job.json"
JOB_OUT_PATH = CONFIG_DIR / "job_output.log"

CANCEL_PATH = CONFIG_DIR / "cancel.flag"
SCRIPT_PATH = Path(os.environ.get("SCRIPT_PATH", "/scripts/m4brew.sh"))
HISTORY_MAX_LINES = int(os.environ.get("HISTORY_MAX_LINES", "100"))

app = Flask(__name__)


# -------------------------
# Time helpers
# -------------------------
def now_utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_ts(ts: str) -> Optional[datetime]:
    if not ts:
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


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


# -------------------------
# History
# -------------------------
def read_history() -> List[Dict[str, Any]]:
    if not HISTORY_PATH.exists():
        return []
    out: List[Dict[str, Any]] = []
    for line in HISTORY_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def write_history(records: List[Dict[str, Any]]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps(r, ensure_ascii=False) for r in records][-HISTORY_MAX_LINES:]
    HISTORY_PATH.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def append_history_record(record: Dict[str, Any]) -> None:
    records = read_history()
    records.append(record)
    write_history(records)


def parse_summary_from_output(output: str) -> Optional[Dict[str, Any]]:
    marker = "__M4B_SUMMARY_JSON__"
    last = None
    for line in output.splitlines():
        if marker in line:
            last = line
    if not last:
        return None
    try:
        payload = last.split(marker, 1)[1].strip()
        return json.loads(payload)
    except Exception:
        return None


# -------------------------
# Job persistence
# -------------------------
def _load_job() -> Dict[str, Any]:
    return read_json(JOB_PATH, {})


def _save_job(job: Dict[str, Any]) -> None:
    write_json(JOB_PATH, job)


def _pid_is_running(pid: Optional[int]) -> bool:
    if not pid or pid <= 0:
        return False
    return Path(f"/proc/{pid}").exists()


def _job_is_running(job: Dict[str, Any]) -> bool:
    if not job:
        return False
    if job.get("status") not in ("running", "canceling"):
        return False
    pid = job.get("pid")
    try:
        pid = int(pid) if pid is not None else None
    except Exception:
        pid = None
    return _pid_is_running(pid)


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
            m4bs = list(book_dir.glob("*.m4b"))
            if len(m4bs) != 1:
                continue
            desired_name = f"{book} - {author}.m4b"
            if m4bs[0].name != desired_name:
                n += 1
        return n

    # convert
    n = 0
    for book_dir in book_dirs:
        m4bs = [p for p in book_dir.glob("*.m4b") if not (p.name.startswith(".tmp_") or p.name.startswith("tmp_"))]
        if m4bs:
            continue
        if list(book_dir.glob("*.mp3")) or list(book_dir.glob("*.m4a")):
            n += 1
    return n


# -------------------------
# Cancel helpers
# -------------------------
def _kill_job_labeled_containers(job_id: str) -> None:
    job_id = (job_id or "").strip()
    if not job_id:
        return
    # kill anything spawned with label m4brew_job=<job_id>
    cmd = (
        f'ids=$(docker ps -aq --filter "label=m4brew_job={job_id}"); '
        f'[ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1 || true'
    )
    subprocess.run(["sh", "-lc", cmd], check=False)


def _signal_proc_group(pid: Optional[int]) -> None:
    if not pid:
        return
    try:
        import os, signal

        try:
            os.killpg(int(pid), signal.SIGINT)
            time.sleep(0.5)
        except Exception:
            pass
        try:
            os.killpg(int(pid), signal.SIGTERM)
            time.sleep(0.5)
        except Exception:
            pass
        try:
            os.killpg(int(pid), signal.SIGKILL)
        except Exception:
            pass
    except Exception:
        pass


def _is_cancel_requested(job_id: str) -> bool:
    try:
        persisted = _load_job()
        return bool(persisted and persisted.get("id") == job_id and persisted.get("cancel_requested"))
    except Exception:
        return False


# -------------------------
# Background runner (stream output, update progress)
# -------------------------
def _run_script_background(job: Dict[str, Any], env: Dict[str, str]) -> None:
    """
    Run the bash script, stream output to JOB_OUT_PATH, and keep job.json updated.

    Cancel behaviour (REAL cancel):
      - When cancel_requested flips true, we:
        1) immediately kill any spawned m4b-tool containers by job label
        2) kill the bash script process group
      - Then we finalize as canceled (exit_code 130), regardless of script summary
    """
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    JOB_OUT_PATH.write_text("", encoding="utf-8")

    job_id = str(job.get("id") or "")
    start = time.time()

    last_fp: Optional[str] = None

    def _save(j: dict) -> None:
        nonlocal last_fp
        # Only persist updates for the same job id
        if str(j.get("id") or "") != job_id:
            return

        # Preserve cancel_requested if UI wrote it into job.json
        try:
            persisted = _load_job()
            if persisted and persisted.get("id") == job_id and persisted.get("cancel_requested"):
                j["cancel_requested"] = True
        except Exception:
            pass

        # Fingerprint everything except 'updated' so we don't rewrite job.json unnecessarily
        try:
            snap = dict(j)
            snap.pop("updated", None)
            fp = json.dumps(snap, sort_keys=True, default=str)
        except Exception:
            fp = None

        if fp is not None and fp == last_fp:
            return

        j["updated"] = now_utc_iso()
        _save_job(j)
        last_fp = fp

    def write_line(line: str) -> None:
        with JOB_OUT_PATH.open("a", encoding="utf-8", errors="replace") as f:
            f.write(line)

    def strip_log_prefix(s: str) -> str:
        s = s.strip()
        if s.startswith("[") and "] " in s:
            return s.split("] ", 1)[1].strip()
        return s

    def set_if_changed(j: Dict[str, Any], key: str, val: Any) -> bool:
        if j.get(key) == val:
            return False
        j[key] = val
        return True

    cmd = ["/bin/bash", str(SCRIPT_PATH)]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        bufsize=1,
        start_new_session=True,  # critical: makes proc.pid the PGID for killpg()
    )

    # local state
    current_book = ""
    current_path = ""
    current = 0
    total = int(job.get("total") or 0)

    # initial job persist (only write if something actually changed)
    changed = False
    changed |= set_if_changed(job, "pid", proc.pid)
    if job.get("status") not in ("canceling", "canceled"):
        changed |= set_if_changed(job, "status", "running")
    changed |= set_if_changed(job, "current", 0)
    changed |= set_if_changed(job, "current_book", "")
    changed |= set_if_changed(job, "current_path", "")
    if changed:
        _save(job)

    canceled_early = False
    rc: Optional[int] = None

    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            # Cancel check *during* streaming (this is what you were missing)
            if _is_cancel_requested(job_id):
                canceled_early = True
                if job.get("status") != "canceling":
                    job["status"] = "canceling"
                    _save(job)

                try:
                    _kill_job_labeled_containers(job_id)
                except Exception:
                    pass
                try:
                    _signal_proc_group(proc.pid)
                except Exception:
                    pass

                write_line("\n[cancel] Forced stop initiated.\n")
                break

            line = raw if raw.endswith("\n") else raw + "\n"
            write_line(line)

            s = strip_log_prefix(line)

            # your script prints a divider per-book
            if s.startswith("----------------------------------------"):
                current += 1
                changed = False
                changed |= set_if_changed(job, "current", current)
                changed |= set_if_changed(job, "current_book", current_book)
                changed |= set_if_changed(job, "current_path", current_path)
                if changed:
                    _save(job)
                continue

            if s.startswith("BOOK:"):
                current_book = s.split("BOOK:", 1)[1].strip()
                if set_if_changed(job, "current_book", current_book):
                    _save(job)
                continue

            if s.startswith("PATH:"):
                current_path = s.split("PATH:", 1)[1].strip()
                if set_if_changed(job, "current_path", current_path):
                    _save(job)
                continue

        # Wait for process to end (if we broke out due to cancel, it may still be dying)
        try:
            rc = proc.wait(timeout=10 if canceled_early else None)  # type: ignore[arg-type]
        except Exception:
            # if it's still hanging, kill harder and mark canceled
            try:
                _signal_proc_group(proc.pid)
            except Exception:
                pass
            try:
                rc = proc.wait(timeout=5)
            except Exception:
                rc = 130 if canceled_early else 1

        full_output = JOB_OUT_PATH.read_text(encoding="utf-8", errors="replace")
        summary = parse_summary_from_output(full_output)

        runtime_s = max(1, int(time.time() - start))
        if isinstance(summary, dict):
            summary["runtime_s"] = runtime_s

        if total > 0:
            current = total

        cancel_requested = canceled_early or _is_cancel_requested(job_id)

        final_status = "canceled" if cancel_requested else ("finished" if (rc == 0) else "failed")
        final_exit = 130 if cancel_requested else (rc if rc is not None else 1)

        if cancel_requested:
            # If the underlying script claims success but we canceled, we override.
            if not isinstance(summary, dict):
                summary = {}
            summary["success"] = False
            summary["reason"] = "canceled"
            summary["runtime_s"] = runtime_s

        changed = False
        changed |= set_if_changed(job, "status", final_status)
        changed |= set_if_changed(job, "exit_code", final_exit)
        changed |= set_if_changed(job, "runtime_s", runtime_s)
        changed |= set_if_changed(job, "summary", summary)
        changed |= set_if_changed(job, "current", current)
        changed |= set_if_changed(job, "current_book", current_book)
        changed |= set_if_changed(job, "current_path", current_path)
        changed |= set_if_changed(job, "pid", None)
        if changed:
            _save(job)

        record = {
            "ts": now_utc_iso(),
            "mode": job.get("mode"),
            "dry_run": job.get("dry_run"),
            "settings": job.get("settings"),
            "exit_code": final_exit,
            "summary": summary,
            "output": full_output,
        }
        append_history_record(record)

    except Exception as e:
        runtime_s = max(1, int(time.time() - start))
        cancel_requested = _is_cancel_requested(job_id)

        if cancel_requested:
            job["status"] = "canceled"
            job["exit_code"] = 130
        else:
            job["status"] = "failed"
            job["exit_code"] = 1

        job["runtime_s"] = runtime_s
        job["pid"] = None
        _save(job)
        write_line(f"\n[worker-error] {e}\n")


def start_job(mode: str, dry_run: bool, root_folder: str, audio_mode: str, bitrate: int) -> Dict[str, Any]:
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

    t = threading.Thread(target=_run_script_background, args=(job, env), daemon=True)
    t.start()

    return job


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
    mode = (request.form.get("mode") or settings.get("mode") or "convert").strip().lower()
    dry_run = str(request.form.get("dry_run") or settings.get("dry_run") or "true").lower() == "true"

    # Everything else comes from saved Settings
    root_folder = str(settings.get("root_folder") or "").strip()
    audio_mode = str(settings.get("audio_mode") or "match").strip().lower()
    try:
        bitrate = int(settings.get("bitrate") or 96)
    except Exception:
        bitrate = 96

    # If user hasn't configured Settings yet, send them there
    if not root_folder:
        save_settings({**settings, "mode": mode, "dry_run": "true" if dry_run else "false"})
        return redirect(url_for("settings_get"))

    # Persist last selections (mode + dry_run only)
    save_settings({**settings, "mode": mode, "dry_run": "true" if dry_run else "false"})

    start_job(mode, dry_run, root_folder, audio_mode, bitrate)
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
    return render_template("about.html", active_page="about")


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

    updated = {
        "root_folder": root_folder,
        "audio_mode": request.form.get("audio_mode") or existing.get("audio_mode", "match"),
        "bitrate": int(request.form.get("bitrate") or existing.get("bitrate", 96)),
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

    return render_template("history.html", runs=enriched, count=len(enriched), active_page="history")


@app.get("/history/<int:idx>")
def history_detail(idx: int):
    records = list(reversed(read_history()))
    if idx < 0 or idx >= len(records):
        return "Not found", 404
    r = records[idx]
    ts = r.get("ts", "")
    r["ts_human"] = humanize_ts(ts) if ts else ""
    return render_template("history_detail.html", detail=r, active_page="history")


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



# --- M4Brew: Preflight checks (root folder mounted + writable) ---
# Used by the Tasks status pill to show friendly errors before/after runs.
try:
  import json, os, subprocess
except Exception:
  pass

@app.route("/api/preflight")
def api_preflight():
  settings_path = "/config/settings.json"
  root = ""
  try:
    with open(settings_path, "r") as f:
      s = json.load(f)
      root = str(s.get("root_folder", "") or "").strip()
  except Exception:
    root = ""

  if not root:
    return jsonify({"ok": False, "error_code": "no_root", "message": "No root folder set"}), 200

  puid = os.environ.get("PUID") or os.environ.get("DOCKER_UID") or "1000"
  pgid = os.environ.get("PGID") or os.environ.get("DOCKER_GID") or "1000"
  uidgid = f"{puid}:{pgid}"

  # Run a tiny container to validate mount + write access as the target user.
  # If the root isn't in the Docker template / not visible to the Docker daemon, this fails.
  cmd = [
    "docker","run","--rm",
    "-u", uidgid,
    "-v", f"{root}:/data:rw",
    "busybox",
    "sh","-lc",
    "test -d /data && touch /data/.m4brew_write_test && rm -f /data/.m4brew_write_test"
  ]

  try:
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    ok = (p.returncode == 0)
    out = (p.stdout or "").strip()
    err = (p.stderr or "").strip()
  except Exception as e:
    return jsonify({"ok": False, "error_code": "preflight_exception", "message": str(e)}), 200

  if ok:
    return jsonify({"ok": True, "root_folder": root, "uidgid": uidgid}), 200

  blob = (err + "\n" + out).lower()
  if "permission denied" in blob:
    return jsonify({"ok": False, "error_code": "write_denied", "message": "Write access denied (PUID/PGID)"}), 200

  # Common Docker mount/visibility failures
  if ("no such file or directory" in blob) or ("invalid mount config" in blob) or ("mount" in blob and "not" in blob):
    return jsonify({"ok": False, "error_code": "not_mounted", "message": "Folder not available to Docker (add it to the template)"}), 200

  return jsonify({"ok": False, "error_code": "unknown", "message": (err or out or "Unknown error")}), 200

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
