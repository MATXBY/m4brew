"""
Shared job/state helpers used by both web.py (Flask routes) and
job_runner.py (the standalone process that actually runs a conversion).

Splitting this out lets the job itself run as a genuine detached
subprocess instead of a thread inside a gunicorn worker, while both
sides agree on exactly how job.json / job_output.log / history.jsonl
are read and written.
"""
import json
import os
import signal
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


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
    if pid is None:
        # job_runner.py is a genuine subprocess now, so there's a brief
        # startup window (process spawn + interpreter init) before it sets
        # the real bash-script pid. status=="running" with no pid yet just
        # means "still starting up" - not "vanished" - so trust the status.
        return True
    try:
        pid = int(pid)
    except Exception:
        return False
    return _pid_is_running(pid)


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
# Job runner (stream output, update progress)
# -------------------------
def run_job(job: Dict[str, Any], env: Dict[str, str]) -> None:
    """
    Run the bash script, stream output to JOB_OUT_PATH, and keep job.json updated.

    This runs to completion in whatever process calls it - job_runner.py runs
    it in a standalone subprocess, detached from the Flask/gunicorn process,
    so a long conversion never ties up a web worker.

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
