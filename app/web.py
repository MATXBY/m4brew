# ---------------------------
# Imports
# ---------------------------
from flask import Flask, render_template, request
import subprocess
import os
from datetime import datetime
import json
from pathlib import Path

# ---------------------------
# Flask app
# ---------------------------
app = Flask(__name__)

# ---------------------------
# Constants / paths
# ---------------------------
SCRIPT_PATH = "/scripts/m4b-toolbox.sh"

CONFIG_DIR = Path("/config")
SETTINGS_FILE = CONFIG_DIR / "settings.json"

DEFAULT_SETTINGS = {
    "root_folder": "/mnt/remotes/192.168.4.4_media/Audiobooks",
    "audio_mode": "match",   # match | mono | stereo
    "bitrate": 64            # kbps
}

# ---------------------------
# Settings helpers
# ---------------------------
def save_settings(settings: dict):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)

def load_settings():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    if not SETTINGS_FILE.exists():
        save_settings(DEFAULT_SETTINGS)

    with open(SETTINGS_FILE, "r") as f:
        return json.load(f)

# Load settings once on startup (mostly for future use)
settings = load_settings()

# ---------------------------
# Routes
# ---------------------------
@app.route("/", methods=["GET", "POST"])
def index():
    output = None
    mode = request.form.get("mode", "convert")
    dry_run = request.form.get("dry_run", "true")

    if request.method == "POST":
        # Clamp values so we only allow known-safe options
        if mode not in ["convert", "cleanup", "correct"]:
            mode = "convert"
        if dry_run not in ["true", "false"]:
            dry_run = "true"

        env = os.environ.copy()
        env["MODE"] = mode
        env["DRY_RUN"] = dry_run

        # Pass settings into the script via environment variables
        current = load_settings()
        env["ROOT_FOLDER"] = current.get("root_folder", "")
        env["AUDIO_MODE"] = current.get("audio_mode", "match")
        env["BITRATE"] = str(current.get("bitrate", 64))

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        header = (
            f"[{timestamp}] Running MODE={mode} DRY_RUN={dry_run}\n"
            f"ROOT_FOLDER={env['ROOT_FOLDER']}\n"
            f"AUDIO_MODE={env['AUDIO_MODE']}\n"
            f"BITRATE={env['BITRATE']}\n\n"
        )

        try:
            proc = subprocess.run(
                ["/bin/bash", SCRIPT_PATH],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=60 * 60,
            )
            output = header + proc.stdout
        except Exception as e:
            output = header + f"Error running script: {e}\n"

    return render_template(
        "index.html",
        mode=mode,
        dry_run=dry_run,
        output=output
    )

@app.route("/settings", methods=["GET", "POST"])
def settings_page():
    current = load_settings()

    if request.method == "POST":
        # ---- root_folder ----
        new_root = request.form.get("root_folder", "").strip()

        # Basic safety: must be an absolute path and not empty
        if new_root and new_root.startswith("/"):
            current["root_folder"] = new_root

        # ---- bitrate ----
        try:
            new_bitrate = int(request.form.get("bitrate", current.get("bitrate", 64)))
        except ValueError:
            new_bitrate = current.get("bitrate", 64)

        allowed_bitrates = [32, 64, 96, 128, 160, 192]
        if new_bitrate not in allowed_bitrates:
            new_bitrate = current.get("bitrate", 64)

        current["bitrate"] = new_bitrate

        # ---- audio_mode ----
        new_audio_mode = request.form.get("audio_mode", current.get("audio_mode", "match"))
        allowed_modes = ["match", "mono", "stereo"]
        if new_audio_mode not in allowed_modes:
            new_audio_mode = current.get("audio_mode", "match")

        current["audio_mode"] = new_audio_mode

        # Save + reload from disk
        save_settings(current)
        current = load_settings()

    return render_template("settings.html", settings=current)

# ---------------------------
# Entrypoint
# ---------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
