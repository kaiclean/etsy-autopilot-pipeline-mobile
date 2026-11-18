#!/usr/bin/env python3
"""Render a LaunchAgent with paths, never credential values."""
import os
from pathlib import Path
import plistlib
import sys
from daily import load_env


def agent(env_file, python, repo, logs, hour, minute):
    if not 0 <= hour <= 23 or not 0 <= minute <= 59:
        raise ValueError("Invalid daily schedule")
    return {
        "Label": "com.kaiclean.omnibrain-daily",
        "ProgramArguments": ["/usr/bin/caffeinate", "-i", python, str(Path(repo) / "scripts/brain/daily.py"), "--env-file", env_file],
        "WorkingDirectory": repo,
        "EnvironmentVariables": {"PATH": str(Path(python).parent) + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"},
        "StartCalendarInterval": {"Hour": hour, "Minute": minute},
        "StartInterval": 3600,
        "RunAtLoad": True,
        "ProcessType": "Background",
        "StandardOutPath": str(Path(logs) / "daily.log"),
        "StandardErrorPath": str(Path(logs) / "daily.error.log"),
    }


if __name__ == "__main__":
    env_file, python, repo, logs, target = sys.argv[1:]
    load_env(Path(env_file))
    data = agent(env_file, python, repo, logs, int(os.environ.get("BRAIN_DAILY_HOUR", 7)), int(os.environ.get("BRAIN_DAILY_MINUTE", 20)))
    with open(target, "wb") as f:
        plistlib.dump(data, f)
    os.chmod(target, 0o600)
