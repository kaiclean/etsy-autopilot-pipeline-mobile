#!/usr/bin/env python3
"""Trigger the Brain worker in Zurich time."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from daily import ROOT, WorkerError, load_env
from slots import ZURICH, parse_run_times

LOG_LIMIT = 1024 * 1024


def is_due(now, slots):
    local = now.astimezone(ZURICH)
    return local.minute == 0 or (local.hour, local.minute) in slots


def configuration(env_file):
    # All backends use the schedule in the private file, not a login-shell override.
    environment = os.environ.copy()
    try:
        os.environ.pop("BRAIN_RUN_TIMES", None)
        load_env(env_file)
        data_dir = Path(os.environ.get("BRAIN_DATA_DIR") or ROOT / ".data/brain-worker").expanduser()
        return parse_run_times(), (ROOT / data_dir).resolve() / "logs"
    finally:
        os.environ.clear()
        os.environ.update(environment)


def worker_environment():
    environment = os.environ.copy()
    environment.pop("BRAIN_RUN_TIMES", None)
    environment["PATH"] = os.pathsep.join(filter(None, [
        str(Path(sys.executable).parent), environment.get("PATH"), os.defpath, "/usr/local/bin",
    ]))
    return environment


def run_worker(env_file, environment, output=None):
    return subprocess.run(
        [sys.executable, "-u", str(ROOT / "scripts/brain/daily.py"), "--env-file", str(env_file)],
        cwd=ROOT, env=environment, stdout=output,
        stderr=subprocess.STDOUT if output is not None else None,
    ).returncode


def try_lock(lock):
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    return True


def run_logged(env_file, environment, log_dir):
    with (log_dir / "trigger.lock").open("a") as lock:
        if not try_lock(lock):
            return 0
        log_path = log_dir / "daily.log"
        previous = log_dir / "daily.log.1"
        if log_path.exists() and log_path.stat().st_size >= LOG_LIMIT:
            log_path.replace(previous)
        with log_path.open("a", encoding="utf-8") as log:
            print(f"{datetime.now(ZURICH).isoformat(timespec='seconds')} Brain scheduler: starting worker",
                  file=log, flush=True)
            try:
                status = run_worker(env_file, environment, log)
            except OSError:
                print("Brain scheduler: could not start worker", file=log)
                return 1
            print(f"Brain scheduler: worker exit status {status}", file=log)
            return status


def next_delay(now, slots):
    # Walk real minutes in UTC: a Zurich hour can be skipped or repeated at DST.
    now = now.astimezone(timezone.utc)
    next_minute = now.replace(second=0, microsecond=0) + timedelta(minutes=1)
    while not is_due(next_minute, slots):
        next_minute += timedelta(minutes=1)
    return (next_minute - now).total_seconds()


def run_foreground(slots, run, *, now=lambda: datetime.now(timezone.utc), sleep=time.sleep):
    while True:
        # Also run on startup and after a late wake; the worker deduplicates slots.
        run()
        sleep(next_delay(now(), slots))


def process_start(pid):
    # Field 22 of /proc/<pid>/stat, after the parenthesized process name.
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]


def terminate(_signum, _frame):
    raise KeyboardInterrupt


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--tick", action="store_true", help="Run only if the current Zurich minute is due.")
    modes.add_argument("--run-now", action="store_true", help="Invoke the worker once.")
    modes.add_argument("--pid-file", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    env_file = args.env_file.absolute()
    environment = worker_environment()
    try:
        slots, log_dir = configuration(env_file)
        if args.tick and not is_due(datetime.now(timezone.utc), slots):
            return 0
        log_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        log_dir.chmod(0o700)

        def trigger():
            return run_logged(env_file, environment, log_dir)

        if args.tick or args.run_now:
            return trigger()
        with (args.pid_file or log_dir / "scheduler.lock").open("a+") as lock:
            if not try_lock(lock):
                print("A Brain scheduler is already running.", file=sys.stderr)
                return 1
            if args.pid_file:
                signal.signal(signal.SIGTERM, terminate)
                lock.seek(0)
                lock.truncate()
                lock.write(f"{os.getpid()} {process_start(os.getpid())}\n")
                lock.flush()
            run_foreground(slots, trigger)
    except (WorkerError, ValueError):
        print("Brain scheduler: invalid schedule or private env file configuration.", file=sys.stderr)
        return 1
    except OSError:
        print("Brain scheduler: could not access its files or launch the worker.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
