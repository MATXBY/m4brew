from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from flask import Flask, redirect, render_template, request, url_for

APP_DIR = Path(__file__).resolve().parent
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
SETTINGS_PATH = CONFIG_DIR / "settings.json"
HISTORY_PATH = CONFIG_DIR / "history.jsonl"

SCRIPT_PATH = Path(os.environ.get("SCRIPT_PATH", "/scripts/m4b-toolbox.sh"))

HISTORY_LIMIT = int(os.environ.get("HISTORY_LIMIT", "100"))

SUMMARY_PREFIX = "__M4B_SUMMARY_JSON__ "

app = Flask(__name__)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def load_settings() -> Dict[str, Any]:
    """
    Settings stored in /config/settings.json
    {
      "root_folder": "...",
      "audio_mode": "match|mono|stereo",
      "bitrate": 64
    }
    """
    ensure_config_dir()

    if not SETTINGS_PATH.exists():
        # sensible defaults
        return {
            "root_folder": "/mnt/remotes/192.168.4.4_media/Audiobooks",
            "audio_mode": "match",
            "bitrate": 64,
        }

    try:
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        # if the file is corrupted, fall back to defaults rather than crash
        return {
            "root_folder": "/mnt/remotes/192.168.4.4_media/Audiobooks",
            "audio_mode": "match",
            "bitrate": 64,
        }


def save_settings(settings: Dict[str, Any]) -> None:
    ensure_config_dir()
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")


def parse_summary_from_output(output: str) -> Optional[Dict[str, Any]]:
    """
    Find the last __M4B_SUMMARY_JSON__ {...} line and parse JSON payload.
    Handles both normal JSON and occasionally escaped JSON strings.
    """
    last_payload: Optional[str] = None
    for line in output.splitlines():
        if line.startswith(SUMMARY_PREFIX):
            last_payload = line[len(SUMMARY_PREFIX):].strip()

    if not last_payload:
        return None

    # First attempt: direct JSON
    try:
        return json.loads(last_payload)
    except Exception:
        pass

    # Second attempt: handle escaped quotes (e.g. {\"mode\":\"convert\"...})
    try:
        cleaned = last_payload.replace('\\"', '"')
        return json.loads(cleaned)
    except Exception:
        return None


def append_history_record(record: Dict[str, Any]) -> None:
    ensure_config_dir()

    line = json.dumps(record, ensure_ascii=False)
    if HISTORY_PATH.exists():
        HISTORY_PATH.write_text(HISTORY_PATH.read_text(encoding="utf-8") + line + "\n", encoding="utf-8")
    else:
        HISTORY_PATH.write_text(line + "\n", encoding="utf-8")

    # enforce cap
    lines = HISTORY_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
    if len(lines) > HISTORY_LIMIT:
        lines = lines[-HISTORY_LIMIT:]
        HISTORY_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_history() -> List[Dict[str, Any]]:
    if not HISTORY_PATH.exists():
        return []

    items: List[Dict[str, Any]] = []
    for line in HISTORY_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            items.append(json.loads(line))
        except Exception:
            # skip malformed lines
            continue

    # newest first
    items.reverse()
    return items


def run_script(mode: str, dry_run: bool, settings: Dict[str, Any]) -> Tuple[int, str, Optional[Dict[str, Any]]]:
    """
    Executes /scripts/m4b-toolbox.sh with env vars.
    Returns (exit_code, combined_output, parsed_summary_json)
    """
    env = os.environ.copy()

    env["MODE"] = mode
    env["DRY_RUN"] = "true" if dry_run else "false"

    env["ROOT_FOLDER"] = settings.get("root_folder", "")
    env["AUDIO_MODE"] = settings.get("audio_mode", "match")

    bitrate = settings.get("bitrate", 64)
    try:
        bitrate_int = int(bitrate)
    except Exception:
        bitrate_int = 64
    env["BITRATE"] = str(bitrate_int)

    cmd = ["/bin/bash", str(SCRIPT_PATH)]

    try:
        proc = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
        )
        output = (proc.stdout or "") + (proc.stderr or "")
        summary = parse_summary_from_output(output)
        return proc.returncode, output, summary
    except Exception as e:
        return 1, f"[web.py] ERROR running script: {e}\n", None


@app.get("/")
def index_get():
    settings = load_settings()
    return render_template(
        "index.html",
        settings=settings,
        last_output=None,
        last_exit_code=None,
        last_summary=None,
    )


@app.post("/")
def index_post():
    settings = load_settings()

    mode = request.form.get("mode", "convert").strip()
    if mode not in ("convert", "correct", "cleanup"):
        mode = "convert"

    dry_run = request.form.get("dry_run") == "on"

    exit_code, output, summary = run_script(mode=mode, dry_run=dry_run, settings=settings)

    record = {
        "ts": utc_now_iso(),
        "mode": mode,
        "dry_run": dry_run,
        "settings": settings,
        "exit_code": exit_code,
        "summary": summary,
        "output": output,
    }
    append_history_record(record)

    return render_template(
        "index.html",
        settings=settings,
        last_output=output,
        last_exit_code=exit_code,
        last_summary=summary,
    )


@app.get("/settings")
def settings_get():
    settings = load_settings()
    return render_template("settings.html", settings=settings)


@app.post("/settings")
def settings_post():
    settings = load_settings()

    root_folder = (request.form.get("root_folder") or "").strip()
    audio_mode = (request.form.get("audio_mode") or "match").strip()
    bitrate = (request.form.get("bitrate") or "64").strip()

    if audio_mode not in ("match", "mono", "stereo"):
        audio_mode = "match"

    try:
        bitrate_int = int(bitrate)
    except Exception:
        bitrate_int = 64

    # basic bounds to prevent nonsense
    if bitrate_int < 16:
        bitrate_int = 16
    if bitrate_int > 320:
        bitrate_int = 320

    if root_folder:
        settings["root_folder"] = root_folder
    settings["audio_mode"] = audio_mode
    settings["bitrate"] = bitrate_int

    save_settings(settings)
    return redirect(url_for("settings_get"))


@app.get("/history")
def history_get():
    items = read_history()
    return render_template("history.html", items=items)


@app.get("/history/<int:run_id>")
def history_detail_get(run_id: int):
    items = read_history()
    if run_id < 0 or run_id >= len(items):
        return redirect(url_for("history_get"))

    item = items[run_id]
    return render_template("history.html", items=items, selected=item, selected_id=run_id)


if __name__ == "__main__":
    # dev server; docker publishes 8080
    app.run(host="0.0.0.0", port=8080, debug=False)
