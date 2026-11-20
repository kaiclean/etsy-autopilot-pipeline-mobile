#!/usr/bin/env python3
"""Install or remove user-level Brain scheduling on Linux."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
from tempfile import NamedTemporaryFile
import time

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts/brain"
UNIT = "com.kaiclean.omnibrain-daily"
SERVICE = UNIT + ".service"
TIMER = UNIT + ".timer"
CRON_MARK = " # " + UNIT
CRON_ZONE = f"# {UNIT} timezone (keep this block last)\nCRON_TZ=Europe/Zurich\n"


class InstallError(Exception):
    pass


def systemctl(*args):
    return subprocess.run(["systemctl", "--user", *args], stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, check=False).returncode == 0


def units_dir():
    config = os.environ.get("XDG_CONFIG_HOME")
    return (Path(config) if config and Path(config).is_absolute()
            else Path.home() / ".config") / "systemd" / "user"


def fallback_pidfile():
    return units_dir().parents[1] / "omnibrain" / "scheduler.pid"


def stop_fallback():
    path = fallback_pidfile()
    if not path.exists():
        return
    with path.open() as file:
        try:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            try:
                pid, started = file.read().split()
                pid = int(pid)
                if pid <= 1:
                    raise ValueError
                proc = Path(f"/proc/{pid}")
                current = (proc / "stat").read_text().rsplit(")", 1)[1].split()[19]
                args = (proc / "cmdline").read_bytes().split(b"\0")
                if current != started or args[-3:-1] != [b"--pid-file", os.fsencode(path)]:
                    raise ValueError
                os.kill(pid, signal.SIGTERM)
            except (FileNotFoundError, ProcessLookupError):
                pass
            except (ValueError, IndexError, OSError):
                raise InstallError("Could not verify the Brain scheduler PID; no process was signaled.") from None
            for _ in range(50):
                try:
                    fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    time.sleep(0.1)
            else:
                raise InstallError("The Brain scheduler did not stop; the PID file was kept.")
        path.unlink()


def start_fallback(command, logs):
    path = fallback_pidfile()
    path.parent.mkdir(parents=True, exist_ok=True)
    logs.mkdir(mode=0o700, parents=True, exist_ok=True)
    logs.chmod(0o700)
    with (logs / "scheduler.log").open("a") as log:
        process = subprocess.Popen(
            ["nohup", *command, "--pid-file", str(path)], stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )
    for _ in range(50):
        if process.poll() is not None:
            break
        if path.exists() and path.read_text().startswith(f"{process.pid} "):
            return process
        time.sleep(0.1)
    if process.poll() is None:
        process.kill()
        process.wait()
    raise InstallError(f"Could not start the Brain scheduler; see {logs / 'scheduler.log'}.")


def render_units(command, slots):
    def quote(arg):
        return json.dumps(str(arg).replace("%", "%%"), ensure_ascii=False)

    exec_line = " ".join(map(quote, command))
    calendars = "".join(f"OnCalendar=*-*-* {hour:02}:{minute:02}:00 Europe/Zurich\n"
                        for hour, minute in slots)
    return {
        SERVICE: f"[Unit]\nDescription=OmniBrain saved-Reel worker\n\n"
                 f"[Service]\nType=oneshot\nExecStart=:{exec_line}\nUMask=0077\n",
        TIMER: "[Unit]\nDescription=OmniBrain Zurich schedule and hourly catch-up\n\n"
               f"[Timer]\n{calendars}OnCalendar=*-*-* *:00:00 Europe/Zurich\n"
               "Persistent=true\nAccuracySec=1s\n\n[Install]\nWantedBy=timers.target\n",
    }


def write_unit(path, contents):
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
        staging = Path(file.name)
        try:
            file.write(contents)
            file.close()
            staging.replace(path)
        finally:
            staging.unlink(missing_ok=True)


def remove_units(directory, active_manager):
    enabled = directory / "timers.target.wants" / TIMER
    paths = [directory / TIMER, directory / SERVICE, enabled]
    if not any(path.exists() or path.is_symlink() for path in paths):
        return
    if active_manager:
        for name in (TIMER, SERVICE):
            # Units that failed to load may not exist in the manager at all.
            if not systemctl("stop", name) and systemctl("is-active", name, "--quiet"):
                raise InstallError(f"Could not stop {name}; retry with the user systemd manager available.")
    for path in paths:
        path.unlink(missing_ok=True)
    if active_manager and not systemctl("daemon-reload"):
        raise InstallError("Could not reload the user systemd manager.")


def crontab(*args, **kwargs):
    return subprocess.run(["crontab", *args], capture_output=True, text=True,
                          env=dict(os.environ, LC_ALL="C"), **kwargs)


def cron_line(command):
    # Cron strips the backslash before each percent before handing the line to sh.
    # Keep it outside shell quotes so it cannot collide with a backslash in a path.
    return "* * * * * " + " ".join(
        "'" + str(arg).replace("'", "'\\''").replace("%", "'\\%'") + "'" for arg in command
    ) + CRON_MARK + "\n"


def update_cron(command=None):
    result = crontab("-l")
    if result.returncode == 0:
        original = result.stdout
    elif (result.stderr.strip().startswith("no crontab for ") or
          (result.stderr.strip().startswith("crontab: can't open '")
           and result.stderr.strip().endswith(": No such file or directory"))):
        original = ""
    else:
        raise InstallError("Could not read the user's crontab; no cron entries were changed.")
    updated = "".join(line for line in original.replace(CRON_ZONE, "").splitlines(keepends=True)
                      if not (line.startswith("* * * * * ") and line.rstrip().endswith(CRON_MARK)))
    if command is not None:
        if updated and not updated.endswith("\n"):
            updated += "\n"
        updated += CRON_ZONE + cron_line(command)
    if updated != original and crontab("-", input=updated).returncode:
        raise InstallError("Could not update the user's crontab.")


def uninstall():
    errors = []
    try:
        stop_fallback()
    except InstallError as error:
        errors.append(str(error))
    if shutil.which("crontab"):
        try:
            update_cron()
        except InstallError as error:
            errors.append(str(error))
    try:
        remove_units(units_dir(), bool(shutil.which("systemctl") and systemctl("show-environment")))
    except InstallError as error:
        errors.append(str(error))
    if errors:
        raise InstallError(" ".join(errors))
    print("Brain scheduling removed. Local sessions, checkpoints, notes and logs preserved.")


def install(env_file):
    sys.path.insert(0, str(SCRIPTS))
    from daily import WorkerError
    from scheduler import configuration, worker_environment

    python = str(Path(sys.executable).absolute())
    command = [python, str(SCRIPTS / "scheduler.py"), "--env-file", str(env_file)]
    if not env_file.is_absolute() or not env_file.is_file():
        raise InstallError("Supply an existing absolute path to the private .env.brain file.")
    if any(ord(char) < 32 or ord(char) == 127 for arg in command for char in arg):
        raise InstallError("Scheduler paths must not contain control characters.")
    env_file.chmod(0o600)
    try:
        slots, log_dir = configuration(env_file)
    except (WorkerError, ValueError):
        raise InstallError("Invalid schedule or private env file configuration.") from None
    if subprocess.run([python, str(SCRIPTS / "daily.py"), "--env-file", str(env_file), "--check"],
                      cwd=ROOT, env=worker_environment()).returncode:
        raise InstallError("Brain worker preflight failed; scheduling was not changed.")

    directory = units_dir()
    manager = bool(shutil.which("systemctl") and systemctl("show-environment"))
    has_cron = bool(shutil.which("crontab"))
    stop_fallback()
    if manager:
        if has_cron:
            update_cron()
        directory.mkdir(parents=True, exist_ok=True)
        if (directory / TIMER).exists() and not systemctl("stop", TIMER):
            raise InstallError(f"Could not stop the old {TIMER}.")
        for name, contents in render_units([*command, "--run-now"], slots).items():
            write_unit(directory / name, contents)
        if systemctl("daemon-reload") and systemctl("enable", "--now", TIMER):
            print(f"Installed the Brain systemd user timer. Logs: {log_dir / 'daily.log'}")
            print("The user systemd manager must be running (for example via login or linger).")
            return
        print("Could not activate the systemd user timer; trying another backend.", file=sys.stderr)
    remove_units(directory, manager)
    if has_cron:
        update_cron([*command, "--tick"])
        print(f"Installed Brain in the user's crontab; ensure the cron daemon is running. Logs: {log_dir / 'daily.log'}")
        print("Keep the Brain block last: CRON_TZ also applies to any cron jobs added below it.")
    else:
        start_fallback(command, log_dir)
        print(f"Started the Brain nohup scheduler (does not survive reboot). Logs: {log_dir / 'daily.log'}")


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("install").add_argument("env_file", type=Path)
    actions.add_parser("uninstall")
    args = parser.parse_args(argv)
    if not sys.platform.startswith("linux") or os.getuid() == 0:
        parser.exit(1, "Run on Linux as your normal user, without sudo.\n")
    try:
        if args.action == "install":
            install(args.env_file)
        else:
            uninstall()
    except InstallError as error:
        parser.exit(1, f"{error}\n")
    except (OSError, ImportError):
        parser.exit(1, "Could not access Brain scheduling files or dependencies.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
