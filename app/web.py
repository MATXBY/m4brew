from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import Flask, Response, jsonify, redirect, render_template, request, send_file, url_for

APP_DIR = Path(__file__).resolve().parent
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

SETTINGS_PATH = CONFIG_DIR / "settings.json"
HISTORY_PATH = CONFIG_DIR / "history.jsonl"

# Job state + output
JOB_PATH = CONFIG_DIR / "job.json"
JOB_OUT_PATH = CONFIG_DIR / "job_output.log"

SCRIPT_PATH = Path(os.environ.get("SCRIPT_PATH", "/scripts/m4brew.sh"))
HISTORY_MAX_LINES = int(os.environ.get("HISTORY_MAX_LINES", "100"))

app = Flask(__name__)


# -------------------------
# Time helpers
# -------------------------
def now_utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_ts(ts: str) -> Optional[datetime]:
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
    try:
        if not ts:
            return ""
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        sec = int((now - dt).total_seconds())
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
    if SETTINGS_PATH.exists():
        try:
            return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_settings(settings: Dict[str, Any]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")


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
    if not JOB_PATH.exists():
        return {}
    try:
        return json.loads(JOB_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_job(job: Dict[str, Any]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    JOB_PATH.write_text(json.dumps(job, indent=2) + "\n", encoding="utf-8")


def _pid_is_running(pid: Optional[int]) -> bool:
    if not pid or pid <= 0:
        return False
    return Path(f"/proc/{pid}").exists()


def _job_is_running(job: Dict[str, Any]) -> bool:
    if not job:
        return False
    if job.get("status") != "running":
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
        if list(book_dir.glob("*.m4b")):
            continue
        if list(book_dir.glob("*.mp3")) or list(book_dir.glob("*.m4a")):
            n += 1
    return n


# -------------------------
# Background runner (stream output, update progress)
# -------------------------
def _run_script_background(job: Dict[str, Any], env: Dict[str, str]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    JOB_OUT_PATH.write_text("", encoding="utf-8")

    job_id = job.get("id", "")
    start = time.time()

    def bump(**kwargs: Any) -> None:
        j = _load_job() or job
        if j.get("id") != job_id:
            return
        j.update(kwargs)
        j["updated"] = now_utc_iso()
        _save_job(j)

    def write_line(line: str) -> None:
        with JOB_OUT_PATH.open("a", encoding="utf-8", errors="replace") as f:
            f.write(line)

    def strip_log_prefix(s: str) -> str:
        s = s.strip()
        if s.startswith("[") and "] " in s:
            return s.split("] ", 1)[1].strip()
        return s

    cmd = ["/bin/bash", str(SCRIPT_PATH)]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        bufsize=1,
    )

    bump(pid=proc.pid, status="running", current=0, current_book="", current_path="")

    current_book = ""
    current_path = ""
    current = 0
    total = int(job.get("total") or 0)

    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw if raw.endswith("\n") else raw + "\n"
            write_line(line)

            s = strip_log_prefix(line)

            if s.startswith("----------------------------------------"):
                current += 1
                bump(current=current, current_book=current_book, current_path=current_path)
                continue

            if s.startswith("BOOK:"):
                current_book = s.split("BOOK:", 1)[1].strip()
                bump(current=current, current_book=current_book, current_path=current_path)
                continue

            if s.startswith("PATH:"):
                current_path = s.split("PATH:", 1)[1].strip()
                bump(current=current, current_book=current_book, current_path=current_path)
                continue

        rc = proc.wait()

        full_output = JOB_OUT_PATH.read_text(encoding="utf-8", errors="replace")
        summary = parse_summary_from_output(full_output)
        runtime_s = int(time.time() - start)

        if total > 0:
            current = total

        bump(
            status=("finished" if rc == 0 else "failed"),
            exit_code=rc,
            runtime_s=runtime_s,
            summary=summary,
            current=current,
            current_book=current_book,
            current_path=current_path,
        )

        record = {
            "ts": now_utc_iso(),
            "mode": job.get("mode"),
            "dry_run": job.get("dry_run"),
            "settings": job.get("settings"),
            "exit_code": rc,
            "summary": summary,
            "output": full_output,
        }
        append_history_record(record)

    except Exception as e:
        runtime_s = int(time.time() - start)
        bump(status="failed", exit_code=1, runtime_s=runtime_s)
        write_line(f"\n[worker-error] {e}\n")


def start_job(mode: str, dry_run: bool, root_folder: str, audio_mode: str, bitrate: int) -> Dict[str, Any]:
    existing = _load_job()
    if _job_is_running(existing):
        return existing

    job_id = now_utc_iso().replace(":", "").replace("-", "").replace("T", "_").replace("Z", "")
    total = _scan_total(mode, root_folder)

    job = {
        "id": job_id,
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
    settings = load_settings()

    mode = request.form.get("mode") or settings.get("mode") or "convert"
    dry_run = (request.form.get("dry_run") or settings.get("dry_run") or "true").lower() == "true"
    root_folder = request.form.get("root_folder") or settings.get("root_folder") or ""
    audio_mode = request.form.get("audio_mode") or settings.get("audio_mode") or "match"
    bitrate = int(request.form.get("bitrate") or settings.get("bitrate") or 64)

    # Persist last selections
    save_settings(
        {
            "mode": mode,
            "dry_run": "true" if dry_run else "false",
            "root_folder": root_folder,
            "audio_mode": audio_mode,
            "bitrate": bitrate,
        }
    )

    start_job(mode, dry_run, root_folder, audio_mode, bitrate)
    return redirect(url_for("index_get"))


@app.get("/api/job")
def api_job():
    job = _load_job()
    if not job:
        return jsonify({"status": "none"})
    if job.get("status") == "running" and not _job_is_running(job):
        job["status"] = "failed"
        job["updated"] = now_utc_iso()
        _save_job(job)
    return jsonify(job)


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
    if job and job.get("status") == "running":
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


@app.get("/settings")
def settings_get():
    settings = load_settings()
    return render_template("settings.html", settings=settings, active_page="settings")


@app.post("/settings")
def settings_post():
    existing = load_settings()
    updated = {
        "root_folder": request.form.get("root_folder") or "",
        "audio_mode": request.form.get("audio_mode") or "match",
        "bitrate": int(request.form.get("bitrate") or 64),
        # keep these if they exist so Tasks page doesn't reset oddly
        "mode": existing.get("mode", "convert"),
        "dry_run": existing.get("dry_run", "true"),
    }
    save_settings(updated)
    return redirect(url_for("settings_get"))


@app.get("/history")
def history_get():
    records = list(reversed(read_history()))  # newest first

    def fmt_dur(v):
        try:
            s = int(v or 0)
        except Exception:
            s = 0
        if s < 60:
            return f"{s}s"
        m = s // 60
        if m < 60:
            return f"{m}m"
        h = m // 60
        return f"{h}h"

    enriched = []
    for i, r in enumerate(records):
        ts = r.get("ts", "")
        summary = r.get("summary") or {}
        exit_code = int(r.get("exit_code", 0))

        success = bool(summary.get("success", exit_code == 0))
        runtime_s = summary.get("runtime_s")
        runtime_h = fmt_dur(runtime_s)
        created = summary.get("created")
        renamed = summary.get("renamed")
        deleted = summary.get("deleted")
        skipped = summary.get("skipped")
        failed = summary.get("failed")

        # Completed means: created (convert), renamed (correct), deleted (cleanup)
        mode = r.get("mode", "")
        completed = created if mode == "convert" else (renamed if mode == "correct" else (deleted if mode == "cleanup" else created))

        enriched.append(
            {
                "idx": i,
                "ts": ts,
                "ts_human": humanize_ts(ts) if ts else "",
                "mode": r.get("mode", ""),
                "mode_label": {"convert": "Convert", "correct": "Rename", "cleanup": "Delete"}.get(
                    r.get("mode", ""), r.get("mode", "")
                ),
                "dry_run": r.get("dry_run", False),
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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
