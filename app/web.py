from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from flask import (
    Flask,
    Response,
    redirect,
    render_template,
    request,
    send_file,
    url_for,
)

# -------------------------------------------------------------------
# Paths & constants
# -------------------------------------------------------------------

APP_DIR = Path(__file__).resolve().parent

CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

SETTINGS_PATH = CONFIG_DIR / "settings.json"
HISTORY_PATH = CONFIG_DIR / "history.jsonl"

SCRIPT_PATH = Path(os.environ.get("SCRIPT_PATH", "/scripts/m4brew.sh"))

HISTORY_MAX_LINES = int(os.environ.get("HISTORY_MAX_LINES", "100"))

app = Flask(__name__)

# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------


def now_utc_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def parse_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).lower() in {"1", "true", "yes", "on"}


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
    dt = parse_ts(ts)
    if not dt:
        return ts

    delta = int((datetime.now(timezone.utc) - dt).total_seconds())

    if delta < 10:
        return "just now"
    if delta < 60:
        return f"{delta}s ago"
    if delta < 3600:
        m = delta // 60
        return f"{m} minute{'s' if m != 1 else ''} ago"
    if delta < 172800:
        h = delta // 3600
        return f"{h} hour{'s' if h != 1 else ''} ago"
    d = delta // 86400
    return f"{d} day{'s' if d != 1 else ''} ago"


# -------------------------------------------------------------------
# Settings
# -------------------------------------------------------------------


def load_settings() -> Dict[str, Any]:
    if SETTINGS_PATH.exists():
        try:
            return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_settings(settings: Dict[str, Any]) -> None:
    SETTINGS_PATH.write_text(
        json.dumps(settings, indent=2) + "\n", encoding="utf-8"
    )


# -------------------------------------------------------------------
# History
# -------------------------------------------------------------------


def read_history() -> List[Dict[str, Any]]:
    if not HISTORY_PATH.exists():
        return []

    records: List[Dict[str, Any]] = []
    for line in HISTORY_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except Exception:
            continue
    return records


def write_history(records: List[Dict[str, Any]]) -> None:
    trimmed = records[-HISTORY_MAX_LINES :]
    text = "\n".join(json.dumps(r, ensure_ascii=False) for r in trimmed)
    HISTORY_PATH.write_text(text + ("\n" if text else ""), encoding="utf-8")


def append_history_record(record: Dict[str, Any]) -> None:
    records = read_history()
    records.append(record)
    write_history(records)


# -------------------------------------------------------------------
# Script execution
# -------------------------------------------------------------------


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


def run_script(
    mode: str,
    dry_run: bool,
    root_folder: str,
    audio_mode: str,
    bitrate: int,
) -> Tuple[int, str, Dict[str, str]]:
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

    cmd = ["/bin/bash", str(SCRIPT_PATH)]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        env=env,
    )

    output = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode, output, env


# -------------------------------------------------------------------
# Routes
# -------------------------------------------------------------------


@app.get("/")
def index_get():
    settings = load_settings()
    return render_template(
        "index.html",
        settings=settings,
        last_output=None,
        last_summary=None,
    )


@app.post("/")
def index_post():
    settings = load_settings()

    mode = request.form.get("mode") or settings.get("mode") or "convert"

    dry_run = parse_bool(
        request.form.get("dry_run"),
        default=parse_bool(settings.get("dry_run"), True),
    )

    root_folder = request.form.get("root_folder") or settings.get("root_folder") or ""
    audio_mode = request.form.get("audio_mode") or settings.get("audio_mode") or "match"
    bitrate = int(request.form.get("bitrate") or settings.get("bitrate") or 64)

    exit_code, output, _env = run_script(
        mode, dry_run, root_folder, audio_mode, bitrate
    )

    summary = parse_summary_from_output(output)

    record = {
        "ts": now_utc_iso(),
        "mode": mode,
        "dry_run": dry_run,
        "settings": {
            "root_folder": root_folder,
            "audio_mode": audio_mode,
            "bitrate": bitrate,
        },
        "exit_code": exit_code,
        "summary": summary,
        "output": output,
    }

    append_history_record(record)

    return render_template(
        "index.html",
        settings={
            "mode": mode,
            "dry_run": "true" if dry_run else "false",
            "root_folder": root_folder,
            "audio_mode": audio_mode,
            "bitrate": bitrate,
        },
        last_output=output,
        last_summary=summary,
    )


@app.get("/settings")
def settings_get():
    return render_template("settings.html", settings=load_settings())


@app.post("/settings")
def settings_post():
    settings = {
        "root_folder": request.form.get("root_folder") or "",
        "audio_mode": request.form.get("audio_mode") or "match",
        "bitrate": int(request.form.get("bitrate") or 64),
    }
    save_settings(settings)
    return redirect(url_for("settings_get"))


@app.get("/history")
def history_get():
    records = list(reversed(read_history()))

    runs = []
    for i, r in enumerate(records):
        ts = r.get("ts", "")
        summary = r.get("summary") or {}
        exit_code = int(r.get("exit_code", 0))

        success = bool(summary.get("success", exit_code == 0))

        runs.append(
            {
                "idx": i,
                "ts": ts,
                "ts_human": humanize_ts(ts) if ts else "",
                "mode": r.get("mode", ""),
                "dry_run": r.get("dry_run", False),
                "success": success,
                "runtime_s": summary.get("runtime_s"),
                "created": summary.get("created"),
                "skipped": summary.get("skipped"),
                "failed": summary.get("failed"),
            }
        )

    return render_template("history.html", runs=runs, count=len(runs))


@app.get("/history/<int:idx>")
def history_detail(idx: int):
    records = list(reversed(read_history()))
    if idx < 0 or idx >= len(records):
        return "Not found", 404

    r = records[idx]
    r["ts_human"] = humanize_ts(r.get("ts", ""))

    return render_template("history_detail.html", detail=r)


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


# -------------------------------------------------------------------
# Entrypoint
# -------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
