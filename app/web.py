from flask import Flask, render_template, request
import subprocess
import os
from datetime import datetime

app = Flask(__name__)

# Path to your script inside the container
SCRIPT_PATH = "/scripts/m4b-toolbox.sh"


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

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        header = f"[{timestamp}] Running MODE={mode} DRY_RUN={dry_run}\n\n"

        try:
            # Run the bash script and capture output
            proc = subprocess.run(
                ["/bin/bash", SCRIPT_PATH],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=60 * 60,  # up to 1 hour
            )
            output = header + proc.stdout
        except Exception as e:
            output = header + f"Error running script: {e}\n"

    return render_template("index.html", mode=mode, dry_run=dry_run, output=output)


if __name__ == "__main__":
    # This is for running inside the container.
    app.run(host="0.0.0.0", port=8080)
