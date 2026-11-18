"""Shared worker schedule, in Zurich wall-clock time."""
import datetime as dt
import os
import re
from zoneinfo import ZoneInfo

ZURICH = ZoneInfo("Europe/Zurich")
DEFAULT_RUN_TIMES = "07:20,19:20"


def parse_run_times(value=None):
    if value is None:
        value = os.environ.get("BRAIN_RUN_TIMES", DEFAULT_RUN_TIMES)
    entries = [part.strip() for part in value.split(",")]
    if any(not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", part) for part in entries):
        raise ValueError("BRAIN_RUN_TIMES must contain comma-separated HH:MM times.")
    times = sorted({tuple(map(int, part.split(":"))) for part in entries})
    if len(times) != len(entries):
        raise ValueError("BRAIN_RUN_TIMES must not contain duplicate times.")
    return times


def latest_slot(now, times):
    local = now.astimezone(ZURICH)
    # Use wall time so a repeated clock hour cannot create a second checkpoint.
    for day in (local.date(), local.date() - dt.timedelta(days=1)):
        for hour, minute in reversed(times):
            slot = dt.datetime.combine(day, dt.time(hour, minute))
            if slot <= local.replace(tzinfo=None):
                return slot.isoformat(timespec="minutes")
