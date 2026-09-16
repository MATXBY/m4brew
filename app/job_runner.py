#!/usr/bin/env python3
"""
Standalone entrypoint that runs one conversion job to completion.

Spawned by web.py's start_job() as a genuine detached subprocess (not a
thread inside a gunicorn worker), so a long-running conversion never
ties up a web worker. Reads its job parameters from the environment
(the same MODE/DRY_RUN/ROOT_FOLDER/AUDIO_MODE/BITRATE/JOB_ID variables
m4brew.sh itself uses) and the initial job.json record web.py already
wrote before spawning this process.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from job_common import _load_job, run_job  # noqa: E402


def main() -> None:
    job_id = os.environ.get("JOB_ID", "").strip()
    job = _load_job()
    if not job or str(job.get("id") or "") != job_id:
        return
    run_job(job, os.environ.copy())


if __name__ == "__main__":
    main()
