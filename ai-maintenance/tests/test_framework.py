"""End-to-end proof on a COPY of the real game: break the engine, let the agent heal it.
No network, no real AI (a canned patch stands in for the model), no real deploys.
    python ai-maintenance/tests/test_framework.py"""
import os, sys, json, shutil, subprocess, tempfile, unittest
FW = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = os.path.dirname(FW)

def sh(cmd, cwd): return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)

class Heal(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(); self.aux = tempfile.mkdtemp(); d = self.d
        shutil.copytree(PKG, d, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".git", "twin", "state", "reports", "__pycache__", "node_modules", ".env"))
        sh("git init -q -b main && git config user.email a@b.c && git config user.name t && git add -A && git commit -qm good", d)
        eng = d + "/source/engine.js"; src = open(eng, encoding="utf-8").read()
        needle = "const value = Math.max(0, Math.round(base + noise));"
        self.assertIn(needle, src)
        open(eng, "w", encoding="utf-8").write(src.replace(needle, "const value = Math.round(base + noise) * undefined;"))   # the planted bug
        sh("node scripts/rebuild.js && git commit -qam bug && git branch dev && git branch test", d)
        self.patch = self.aux + "/fix.diff"
        open(self.patch, "w").write(sh("git diff HEAD~1 HEAD -R -- source/engine.js", d).stdout)
        self.cfgfile = self.aux + "/cfg.json"; json.dump(json.load(open(FW + "/config/config.json")), open(self.cfgfile, "w"))
        self.env = dict(os.environ, PORTAL_REPO=d, AGENT_CONFIG=self.cfgfile)
        for k in ("TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY"): self.env.pop(k, None)
    def tearDown(self): shutil.rmtree(self.d, ignore_errors=True); shutil.rmtree(self.aux, ignore_errors=True)
    def agent(self, *a, fake=None):
        env = dict(self.env)
        if fake: env["AGENT_FAKE_LLM"] = fake
        return subprocess.run([sys.executable, FW + "/agent/" + a[0]] + list(a[1:]), cwd=self.d, env=env, capture_output=True, text=True)
    def head(self, b): return sh("git rev-parse " + b, self.d).stdout.strip()
    def test_broken_engine_is_healed_through_dev_test_then_live(self):
        live0 = self.head("main")
        self.assertNotEqual(sh("node tests/run_all.js", self.d).returncode, 0, "the planted bug must be detected")
        r = self.agent("maintain.py", "weekly", fake=self.patch); self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("tests now pass", r.stdout); self.assertIn("waiting for your approval", r.stdout)
        self.assertEqual(self.head("main"), live0, "live must not move before approval")
        self.assertEqual(sh("git diff dev test", self.d).stdout, "")
        self.assertEqual(sh("git checkout -q test && node tests/run_all.js", self.d).returncode, 0, "test branch must be green")
        self.assertEqual(sh("git checkout -q dev", self.d).returncode, 0)
        r = self.agent("pipeline.py", "go-live"); self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.head("main"), self.head("test"))
        sh("git checkout -q main", self.d); self.assertEqual(sh("node tests/run_all.js", self.d).returncode, 0, "live must be green")
        sh("git checkout -q dev", self.d)
        self.agent("pipeline.py", "rollback"); self.assertEqual(self.head("main"), live0)
    def test_ai_may_not_edit_the_tests_or_secrets(self):
        for target in ("tests/run_all.js", "ai-proxy-server/.env"):
            p = self.aux + "/bad.diff"; open(p, "w").write("--- a/%s\n+++ b/%s\n@@ -1,1 +1,1 @@\n-x\n+y\n" % (target, target))
            r = self.agent("maintain.py", "weekly", fake=p); self.assertIn("REJECTED by guardrails", r.stdout)
            self.assertEqual(self.head("dev"), self.head("main"))
    def test_unfixable_problem_alerts_and_changes_nothing(self):
        p = self.aux + "/none.txt"; open(p, "w").write("NO_SAFE_FIX")
        r = self.agent("maintain.py", "weekly", fake=p); self.assertNotEqual(r.returncode, 0)
        self.assertIn("Human attention needed", r.stdout); self.assertEqual(self.head("dev"), self.head("main"))
    def test_healthy_game_is_left_alone(self):
        sh("git apply --index %s && node scripts/rebuild.js && git commit -qam fixed && git branch -f dev && git branch -f test" % self.patch, self.d)
        r = self.agent("maintain.py", "weekly"); self.assertEqual(r.returncode, 0, r.stdout + r.stderr); self.assertIn("healthy", r.stdout)

if __name__ == "__main__": unittest.main(verbosity=2)
