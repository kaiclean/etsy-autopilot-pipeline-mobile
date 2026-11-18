#!/usr/bin/env python3
"""Render a LaunchAgent with paths, never credential values."""
import os
from pathlib import Path
import plistlib
import sys
from daily import load_env
from slots import parse_run_times


def agent(env_file, python, repo, logs, run_times=None):
    return {
        "Label": "com.kaiclean.omnibrain-daily",
        "ProgramArguments": ["/usr/bin/caffeinate", "-i", python, str(Path(repo) / "scripts/brain/daily.py"), "--env-file", env_file],
        "WorkingDirectory": repo,
        "EnvironmentVariables": {"PATH": str(Path(python).parent) + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"},
        "StartCalendarInterval": [{"Hour": h, "Minute": m} for h, m in parse_run_times(run_times)],
        "StartInterval": 3600,
        "RunAtLoad": True,
        "ProcessType": "Background",
        "StandardOutPath": str(Path(logs) / "daily.log"),
        "StandardErrorPath": str(Path(logs) / "daily.error.log"),
    }


if __name__ == "__main__":
    env_file, python, repo, logs, target = sys.argv[1:]
    load_env(Path(env_file))
    try:
        data = agent(env_file, python, repo, logs)
    except ValueError as error:
        sys.exit(str(error))
    with open(target, "wb") as f:
        plistlib.dump(data, f)
    os.chmod(target, 0o600)
