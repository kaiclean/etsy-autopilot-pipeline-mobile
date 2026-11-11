import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import daily
spec = importlib.util.spec_from_file_location("install_agent", Path(__file__).with_name("install-agent.py"))
install_agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install_agent)

ANALYSIS = {
    "summary": "A technical explanation gives a concrete approach to arranging a creative workflow for a small shop.",
    "observations": "Four observed blue frames contain no readable text; the fixture contains no audio track.",
    "tags": ["alpine", "software"],
    "ideas": [
        {"kind": "product", "title": "Alpine mountain lake poster", "concept": "An original copper dawn mountain composition with a blue lake, built from a fresh seller-designed layout.",
         "buyer": "Mountain cabin owners", "evidence": "A source frame shows a simple blue colour field; the layout is a new proposal.",
         "etsy_fit": "Make a real high-resolution poster file and check originality and printable pixels before listing.",
         "validation": "Interview five cabin owners and test three sample layouts before producing a range.",
         "steps": ["Draw three original compositions", "Create and open the printable PDF", "Ask buyers to review the sample"]},
        {"kind": "saas", "title": "Small shop workflow assistant", "concept": "A software prototype that keeps source evidence and production tasks together for a solo shop owner.",
         "buyer": "Independent shop owners", "evidence": "The caption describes a source-linked workflow; viability still needs customer evidence.",
         "etsy_fit": "", "validation": "Ask five operators to try the manual workflow and measure time saved.",
         "steps": ["Observe one real shop workflow", "Build a single-screen prototype", "Run a customer usability test"]},
    ],
}


class FakeDashboard:
    def __init__(self, fail_upload=False):
        self.fail_upload = fail_upload
        self.deliveries = []

    def call(self, data=None):
        if data is None:
            return {"reels": [{"id": "Reels/old-name", "shortcode": "TestResume1", "status": "transcribed"}]}
        self.deliveries.append(json.loads(json.dumps(data)))
        if data["notes"] and self.fail_upload:
            self.fail_upload = False
            raise daily.WorkerError("sync")
        return {"accepted": len(data["notes"])}


class DailyTests(unittest.TestCase):
    def test_analysis_refuses_missing_evidence_and_unbuildable_ideas(self):
        self.assertIs(daily.validate_analysis(ANALYSIS), ANALYSIS)
        for patch in [{"observations": ""}, {"ideas": [{**ANALYSIS["ideas"][0], "steps": []}]}, {"ideas": [{**ANALYSIS["ideas"][0], "kind": "execute-command"}]}]:
            with self.assertRaises(daily.WorkerError):
                daily.validate_analysis({**ANALYSIS, **patch})

    def test_env_is_private_data_not_a_shell_program(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / ".env.brain"
            p.write_text("BRAIN_SYNC_TOKEN=$(false)\n")
            p.chmod(0o600)
            with mock.patch.dict(os.environ, {}, clear=True):
                daily.load_env(p)
                self.assertEqual(os.environ["BRAIN_SYNC_TOKEN"], "$(false)")
            p.chmod(0o644)
            with self.assertRaises(daily.WorkerError):
                daily.load_env(p)

    def test_local_only_model_and_exact_dashboard_origin(self):
        with mock.patch.dict(os.environ, {"OLLAMA_BASE_URL": "https://api.example.com"}):
            with self.assertRaises(daily.WorkerError):
                daily.ollama_base()
        with mock.patch.dict(os.environ, {"BRAIN_BASE_URL": "http://example.com", "BRAIN_SYNC_TOKEN": "fixture"}):
            with self.assertRaises(daily.WorkerError):
                daily.Dashboard()
        with mock.patch.dict(os.environ, {"OLLAMA_BASE_URL": "http://localhost:11434", "OLLAMA_MODEL": "gemma3:4b"}):
            with mock.patch.object(daily, "json_http", return_value={"remote_host": "https://paid.example", "capabilities": ["vision"]}):
                with self.assertRaises(daily.WorkerError):
                    daily.check_local_model()

    def test_failed_upload_reuses_analysis_and_keeps_historical_id(self):
        post = types.SimpleNamespace(shortcode="TestResume1", is_video=True, owner_username="fixture", date_utc=daily.dt.datetime(2026, 11, 11), caption="Source-linked workflow")
        profile = types.SimpleNamespace(get_saved_posts=lambda: iter([post]))
        module = types.SimpleNamespace(Profile=types.SimpleNamespace(from_username=lambda *_: profile))
        dashboard = FakeDashboard(fail_upload=True)
        evidence = {"frames": [], "duration": 10, "transcript": "[0.0s] A local fixture transcript.", "sha256": "a" * 64}
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(sys.modules, {"instaloader": module}), mock.patch.object(daily.importlib.util, "find_spec", return_value=True), mock.patch.object(daily.shutil, "which", return_value="/bin/fixture"), mock.patch.object(daily, "check_local_model"), mock.patch.object(daily, "login_loader", return_value=(types.SimpleNamespace(context=object()), "fixture")), mock.patch.object(daily, "download_video"), mock.patch.object(daily, "extract_evidence", return_value=evidence), mock.patch.object(daily, "analyse", return_value=ANALYSIS) as analyser:
            folder = Path(directory)
            with self.assertRaises(daily.WorkerError) as stopped:
                daily.run_daily(dashboard, folder)
            self.assertEqual(stopped.exception.stage, "sync")
            self.assertTrue((folder / "outbox/TestResume1.json").exists())
            self.assertNotIn("TestResume1", json.loads((folder / "state.json").read_text()).get("done", {}) if (folder / "state.json").exists() else {})
            daily.run_daily(dashboard, folder)
            self.assertEqual(analyser.call_count, 1)
            self.assertFalse((folder / "outbox/TestResume1.json").exists())
            state = json.loads((folder / "state.json").read_text())
            self.assertIn("TestResume1", state["done"])
            uploads = [d for d in dashboard.deliveries if d["notes"]]
            self.assertEqual(uploads[-1]["notes"][0]["id"], "Reels/old-name")
            self.assertIn('type: "saas"', uploads[-1]["notes"][2]["markdown"])
            before = len(dashboard.deliveries)
            daily.run_daily(dashboard, folder)
            self.assertEqual(len(dashboard.deliveries), before)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
    def test_real_media_extraction_does_not_invent_speech(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            video = folder / "real-fixture.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x96:r=10", "-t", "1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(video)], check=True)
            evidence = daily.extract_evidence(video, folder)
            self.assertEqual(len(evidence["frames"]), 4)
            self.assertTrue(all(p.stat().st_size > 100 for p in evidence["frames"]))
            self.assertEqual(evidence["transcript"], "")
            self.assertEqual(evidence["sha256"], hashlib.sha256(video.read_bytes()).hexdigest())

    def test_launchd_schedule_has_no_credential_and_rejects_invalid_time(self):
        rendered = install_agent.agent("/private/.env.brain", "/venv/python", "/repo with spaces", "/logs", 7, 20)
        self.assertEqual(rendered["StartCalendarInterval"], {"Hour": 7, "Minute": 20})
        self.assertEqual(rendered["StartInterval"], 3600)
        self.assertNotIn("TOKEN", json.dumps(rendered))
        self.assertIn("/repo with spaces/scripts/brain/daily.py", rendered["ProgramArguments"])
        with self.assertRaises(ValueError):
            install_agent.agent("/env", "/python", "/repo", "/logs", 25, 0)


if __name__ == "__main__":
    unittest.main()
