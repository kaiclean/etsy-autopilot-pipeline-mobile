import contextlib
from datetime import datetime, timezone
import fcntl
import importlib.util
import io
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import scheduler
from slots import parse_run_times

SPEC = importlib.util.spec_from_file_location("brain_linux", scheduler.ROOT / "deploy/brain/linux.py")
linux = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(linux)


class ScratchTest(unittest.TestCase):
    def setUp(self):
        original_umask = os.umask(0o077)
        self.addCleanup(os.umask, original_umask)
        scratch = tempfile.TemporaryDirectory(dir=".")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).absolute()


class SchedulingTests(ScratchTest):
    def test_zurich_slots_and_hourly_catch_up_across_dst(self):
        slots = parse_run_times("07:20,19:20")
        for date, hours in [((2026, 1, 5), (6, 18)), ((2026, 7, 5), (5, 17))]:
            for hour in hours:
                for minute, expected in [(0, True), (19, False), (20, True), (21, False)]:
                    with self.subTest(date=date, hour=hour, minute=minute):
                        self.assertEqual(scheduler.is_due(datetime(*date, hour, minute, tzinfo=timezone.utc), slots),
                                         expected)
        custom = parse_run_times("09:43")
        self.assertTrue(scheduler.is_due(datetime(2026, 7, 5, 7, 43, tzinfo=timezone.utc), custom))

    def test_foreground_sleeps_until_slot_or_hour_and_runs_after_a_late_wake(self):
        times = iter(datetime(2026, 1, 5, h, m, s, tzinfo=timezone.utc) for h, m, s in [
            (6, 18, 30), (6, 46, 0), (7, 0, 0),
        ])
        run = Mock(side_effect=[1, 1, 0])
        sleep = Mock(side_effect=[None, None, StopIteration])
        with self.assertRaises(StopIteration):
            scheduler.run_foreground([(7, 20), (19, 20)], run, now=lambda: next(times), sleep=sleep)
        self.assertEqual(run.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [90, 840, 3600])

    def test_delay_uses_elapsed_time_across_zurich_clock_changes(self):
        cases = [
            # Spring skips 02:20; the real next trigger is 03:00 Zurich.
            (datetime(2026, 3, 29, 0, 59, 45, tzinfo=timezone.utc), [(2, 20)], 15),
            # Fall moves from the first 02:59 to the second 02:00.
            (datetime(2026, 10, 25, 0, 59, 45, tzinfo=timezone.utc), [(2, 20)], 15),
            (datetime(2026, 10, 25, 1, 19, 45, tzinfo=timezone.utc), [(2, 20)], 15),
        ]
        for now, slots, expected in cases:
            with self.subTest(now=now):
                self.assertEqual(scheduler.next_delay(now, slots), expected)

    def test_cron_tick_uses_worker_environment_file_and_rotates_logs(self):
        env_file = self.root / ".env brain"
        data_dir = self.root / "data"
        data_dir.mkdir()
        env_file.write_text(f"BRAIN_RUN_TIMES=13:42\nBRAIN_DATA_DIR={data_dir}\n")
        env_file.chmod(0o600)
        logs = data_dir / "logs"
        logs.mkdir()
        (logs / "daily.log").write_text("old output\n")
        args = ["--tick", "--env-file", str(env_file)]
        with patch.dict(os.environ, {"BRAIN_RUN_TIMES": "13:41"}, clear=True), \
                patch.object(scheduler, "datetime") as clock, patch.object(scheduler, "LOG_LIMIT", 4), \
                patch.object(scheduler.subprocess, "run") as process:
            clock.now.return_value = datetime(2026, 1, 5, 12, 41, tzinfo=timezone.utc)
            self.assertEqual(scheduler.main(args), 0)
            process.assert_not_called()
            clock.now.return_value = datetime(2026, 1, 5, 12, 42, tzinfo=timezone.utc)
            process.return_value.returncode = 9
            self.assertEqual(scheduler.main(args), 9)
            command = process.call_args.args[0]
            self.assertEqual(command[-2:], ["--env-file", str(env_file)])
            self.assertNotIn("--force", command)
            self.assertNotIn("BRAIN_RUN_TIMES", process.call_args.kwargs["env"])
        self.assertEqual((logs / "daily.log.1").read_text(), "old output\n")
        self.assertIn("worker exit status 9", (logs / "daily.log").read_text())
        self.assertEqual(stat.S_IMODE((logs / "daily.log").stat().st_mode), 0o600)

    def test_run_now_uses_same_private_logs_and_default_worker_data_dir(self):
        env_file = self.root / "config"
        env_file.write_text("")
        with patch.dict(os.environ, {}, clear=True), patch.object(scheduler, "ROOT", self.root), \
                patch.object(scheduler, "run_worker", return_value=0):
            self.assertEqual(scheduler.main(["--env-file", str(env_file), "--run-now"]), 0)
        self.assertIn("worker exit status 0",
                      (self.root / ".data/brain-worker/logs/daily.log").read_text())


class LinuxInstallerTests(ScratchTest):
    def setUp(self):
        super().setUp()
        env = patch.dict(os.environ, {
            "HOME": str(self.root), "XDG_CONFIG_HOME": str(self.root / "config"),
        }, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.env_file = self.root / """config space ' " $ % .env"""
        self.logs = self.root / "data" / "logs"
        self.env_file.write_text(f"BRAIN_RUN_TIMES=07:20,19:20\nBRAIN_DATA_DIR={self.logs.parent}\n"
                                 "EXAMPLE_VALUE=fixture-value\n")
        self.env_file.chmod(0o644)
        self.cron_original = "MAILTO=operator@example.invalid\nCRON_TZ=UTC\n17 1 * * * /usr/bin/true\n"
        self.cron_state = self.cron_original

    def fake_crontab(self, action, input=None):
        if action == "-l":
            return subprocess.CompletedProcess("crontab", 0, self.cron_state, "")
        self.assertEqual(action, "-")
        self.cron_state = input
        return subprocess.CompletedProcess("crontab", 0, "", "")

    def test_systemd_install_and_uninstall(self):
        with patch.object(linux.shutil, "which", side_effect=lambda name: name), \
                patch.object(linux, "systemctl", return_value=True) as systemctl, \
                patch.object(linux, "crontab", side_effect=self.fake_crontab), \
                patch.object(linux.subprocess, "run", return_value=Mock(returncode=0)) as run, \
                contextlib.redirect_stdout(io.StringIO()):
            self.cron_state += linux.cron_line(["/previous/install"])
            linux.install(self.env_file)
            run.assert_called_once()
            self.assertEqual(run.call_args.args[0][-3:], ["--env-file", str(self.env_file), "--check"])
            self.assertNotIn("EXAMPLE_VALUE", os.environ)
            self.assertEqual(self.cron_state, self.cron_original)
            timer = linux.units_dir() / linux.TIMER
            service = linux.units_dir() / linux.SERVICE
            self.assertEqual(timer.read_text().count("Europe/Zurich"), 3)
            for time in ("07:20", "19:20", "*:00"):
                self.assertIn(f"{time}:00 Europe/Zurich", timer.read_text())
            self.assertIn("Persistent=true", timer.read_text())
            self.assertIn("ExecStart=:", service.read_text())
            self.assertIn('%% .env"', service.read_text())
            self.assertIn("--run-now", service.read_text())
            self.assertNotIn("fixture-value", service.read_text())
            self.assertNotIn("EnvironmentFile", service.read_text())
            self.assertEqual(stat.S_IMODE(self.env_file.stat().st_mode), 0o600)
            systemctl.assert_any_call("enable", "--now", linux.TIMER)
            enabled = timer.parent / "timers.target.wants" / timer.name
            enabled.parent.mkdir()
            enabled.symlink_to(timer)
            log = self.logs / "daily.log"
            log.parent.mkdir(parents=True)
            log.write_text("preserved")
            linux.uninstall()
            linux.uninstall()
            systemctl.assert_any_call("stop", linux.TIMER)
            systemctl.assert_any_call("stop", linux.SERVICE)
            self.assertFalse(timer.exists() or service.exists() or enabled.is_symlink())
            self.assertEqual(log.read_text(), "preserved")
            self.assertTrue(self.env_file.exists())

    def test_cron_fallback_and_reinstall_preserve_unrelated_jobs(self):
        def fake_systemd(*args):
            return args != ("enable", "--now", linux.TIMER)

        with patch.object(linux.shutil, "which", side_effect=lambda name: name), \
                patch.object(linux, "systemctl", side_effect=fake_systemd), \
                patch.object(linux, "crontab", side_effect=self.fake_crontab), \
                patch.object(linux.subprocess, "run", return_value=Mock(returncode=0)), \
                contextlib.redirect_stdout(io.StringIO()):
            linux.install(self.env_file)
            linux.install(self.env_file)
            self.assertFalse((linux.units_dir() / linux.TIMER).exists())
            self.assertTrue(self.cron_state.startswith(self.cron_original))
            entry = self.cron_state.removeprefix(self.cron_original)
            self.assertEqual(entry.count(linux.CRON_MARK), 1)
            self.assertNotIn("fixture-value", entry)
            self.assertIn("\nCRON_TZ=Europe/Zurich\n* * * * * ", entry)
            command = entry.removeprefix(linux.CRON_ZONE + "* * * * * ").removesuffix(linux.CRON_MARK + "\n")
            args = shlex.split(command.replace(r"\%", "%"))
            self.assertEqual(args[2:], [
                "--env-file", str(self.env_file), "--tick",
            ])
            linux.uninstall()
            self.assertEqual(self.cron_state, self.cron_original)

    def test_preflight_failure_and_nohup_selection(self):
        with patch.object(linux.shutil, "which", return_value=None), \
                patch.object(linux.subprocess, "run", return_value=Mock(returncode=2)) as run, \
                patch.object(linux, "start_fallback") as fallback, \
                contextlib.redirect_stdout(io.StringIO()) as stdout:
            with self.assertRaisesRegex(linux.InstallError, "preflight failed"):
                linux.install(self.env_file)
            self.assertFalse(linux.units_dir().exists())
            self.assertEqual(stdout.getvalue(), "")
            fallback.assert_not_called()
            run.return_value.returncode = 0
            linux.install(self.env_file)
            command, logs = fallback.call_args.args
            self.assertEqual(command[1:4], [str(scheduler.ROOT / "scripts/brain/scheduler.py"),
                                           "--env-file", str(self.env_file)])
            self.assertEqual(logs, self.logs)

    @unittest.skipUnless(shutil.which("nohup"), "nohup unavailable")
    def test_nohup_process_logs_and_uninstall(self):
        self.env_file.chmod(0o600)
        program = (f"import sys; sys.path.insert(0, {str(linux.SCRIPTS)!r}); import scheduler; "
                   "scheduler.run_worker = lambda *args: 0; sys.exit(scheduler.main())")
        command = [sys.executable, "-c", program, "--env-file", str(self.env_file)]
        with patch.object(linux.subprocess, "Popen", wraps=subprocess.Popen) as popen:
            process = linux.start_fallback(command, self.logs)
            args = popen.call_args.args[0]
            self.assertEqual(args[0], "nohup")
        self.addCleanup(process.wait, 5)
        self.addCleanup(linux.stop_fallback)
        pid, started = linux.fallback_pidfile().read_text().split()
        self.assertEqual(scheduler.process_start(int(pid)), started)
        log = self.logs / "daily.log"
        for _ in range(50):
            if log.exists() and "worker exit status 0" in log.read_text():
                break
            time.sleep(0.1)
        else:
            self.fail("Background scheduler did not record its first run")
        with patch.object(linux.shutil, "which", return_value=None), contextlib.redirect_stdout(io.StringIO()):
            linux.uninstall()
        self.assertEqual(process.wait(timeout=5), 0)
        self.assertFalse(linux.fallback_pidfile().exists())
        self.assertIn("worker exit status 0", log.read_text())

    def test_uninstall_refuses_to_signal_unverified_pid(self):
        pidfile = linux.fallback_pidfile()
        pidfile.parent.mkdir(parents=True)
        with pidfile.open("w") as file:
            file.write(f"{os.getpid()} {scheduler.process_start(os.getpid())}\n")
            file.flush()
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(linux.os, "kill") as kill:
                with self.assertRaisesRegex(linux.InstallError, "no process was signaled"):
                    linux.stop_fallback()
                kill.assert_not_called()
        linux.stop_fallback()
        self.assertFalse(pidfile.exists())

    def test_uninstall_offline_removes_dangling_enablement_link(self):
        link = linux.units_dir() / "timers.target.wants" / linux.TIMER
        link.parent.mkdir(parents=True)
        link.symlink_to("../" + linux.TIMER)
        with patch.object(linux.shutil, "which", return_value=None), contextlib.redirect_stdout(io.StringIO()):
            linux.uninstall()
        self.assertFalse(link.is_symlink())

    def test_unknown_crontab_error_does_not_replace_jobs(self):
        with patch.object(linux, "crontab", return_value=Mock(returncode=1, stderr="permission denied")) as cron:
            with self.assertRaisesRegex(linux.InstallError, "Could not read"):
                linux.update_cron(["test"])
            cron.assert_called_once_with("-l")

    @unittest.skipUnless(shutil.which("systemd-analyze"), "systemd-analyze unavailable")
    def test_systemd_accepts_generated_units(self):
        command = [sys.executable, str(scheduler.ROOT / "scripts/brain/scheduler.py"),
                   "--env-file", str(self.env_file), "--run-now"]
        units = linux.render_units(command, [(7, 20), (19, 20)])
        for name, contents in units.items():
            (self.root / name).write_text(contents)
        result = subprocess.run(["systemd-analyze", "verify", str(self.root / linux.TIMER),
                                 str(self.root / linux.SERVICE)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
