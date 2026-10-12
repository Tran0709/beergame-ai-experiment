"""The AI maintenance agent.
  python agent/maintain.py weekly                   scheduled upkeep
  python agent/maintain.py feedback --text "..."    fix something a human reported
Flow: branch off dev -> run upkeep tasks -> run tests -> if red, ask the AI for a patch (guardrailed)
      -> commit -> promote dev -> test(twin) -> live gate -> report to Telegram."""
import sys, os, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *
import pipeline

SYSTEM = ("You are a careful maintenance engineer for The Beer Game, a single-file browser simulation (sources in source/*.js and base-style.css; index.html is generated, never edit it). Reply with ONLY a unified diff "
          "(git apply format, paths relative to repo root) that makes the smallest change to fix the problem. "
          "Never touch secrets, .env, CI files or ai-maintenance/. If you cannot fix it safely, reply with exactly: NO_SAFE_FIX")

def dirty():
    """Uncommitted changes, ignoring the agent's own folder (reports, state)."""
    return git("status", "--porcelain", "--", ".", ":!ai-maintenance")

def try_patch(problem, out, g, report):
    files = git("ls-files")[:6000]
    for attempt in range(1, g["max_fix_attempts"] + 1):
        reply = ask_llm("Problem:\n%s\n\nOutput:\n%s\n\nRepo files:\n%s" % (problem, out[-3000:], files), SYSTEM)
        if reply is None:
            report.append("AI patch skipped: no API key configured."); return False
        patch = reply.strip()
        if patch.startswith("```"):
            patch = "\n".join(l for l in patch.splitlines() if not l.startswith("```"))
        if "NO_SAFE_FIX" in patch or "+++ " not in patch:
            report.append("AI attempt %d: no safe fix proposed." % attempt); continue
        paths = patch_paths(patch)
        bad = [p for p in paths if is_protected(p, g)]
        changed_lines = sum(1 for l in patch.splitlines() if l[:1] in "+-" and l[:3] not in ("+++", "---"))
        if bad or len(paths) > g["max_changed_files"] or changed_lines > g["max_diff_lines"]:
            report.append("AI attempt %d REJECTED by guardrails (%s)." % (attempt, "protected: %s" % bad if bad else "too large")); continue
        pf = os.path.join(STATE, "patch.diff"); os.makedirs(STATE, exist_ok=True)
        open(pf, "w", encoding="utf-8").write(patch + "\n")
        if subprocess.run(["git", "apply", pf], cwd=REPO, capture_output=True).returncode != 0:
            report.append("AI attempt %d: patch did not apply." % attempt); continue
        run(cfg()["commands"].get("post_patch", ""))        # e.g. rebuild index.html from source/
        rc, o = run(cfg()["commands"]["test"])
        if rc == 0:
            report.append("AI attempt %d: patch applied (%d files, %d lines); tests now pass." % (attempt, len(paths), changed_lines)); return True
        git("checkout", "--", "."); report.append("AI attempt %d: patch applied but tests still failing; reverted." % attempt); out = o
    return False

def main():
    load_env(); ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["weekly", "feedback"]); ap.add_argument("--text", default="")
    ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    c = cfg(); g = c["guardrails"]; gb = c["git"]
    lock = os.path.join(STATE, "lock"); os.makedirs(STATE, exist_ok=True)
    if os.path.exists(lock):
        sys.exit("Another maintenance run is in progress (state/lock).")
    open(lock, "w").write(now())
    report = ["# %s run (%s)" % (a.mode, now()), ""]
    try:
        if dirty():
            raise RuntimeError("Repo has uncommitted changes; refusing to run.")
        git("checkout", gb["dev_branch"])
        work = "ai/%s-%s" % (a.mode, now()); git("checkout", "-b", work)
        if a.mode == "feedback":
            report.append("Feedback received: " + a.text)
        run(c["commands"]["install"])
        for t in c["maintenance_tasks"]:
            if a.mode == "weekly" and t["cmd"]:
                rc, o = run(t["cmd"]); report.append("task %s: %s" % (t["name"], "ok" if rc == 0 else "FAILED"))
        rc, out = run(c["commands"]["test"])
        problem = None
        if rc != 0:
            problem = "Tests are failing after maintenance tasks."
        elif a.mode == "feedback":
            problem = "A user reported: " + a.text
        fixed_by_ai = False
        if problem:
            report.append("Problem: " + problem)
            fixed_by_ai = try_patch(problem + ("\nUser report: " + a.text if a.text else ""), out, g, report)
            rc2, _ = run(c["commands"]["test"])
            if rc2 != 0:
                report.append("RESULT: could not get to green. Nothing was promoted. Human attention needed.")
                git("checkout", "--", "."); git("checkout", gb["dev_branch"]); git("branch", "-D", work)
                p = write_report(a.mode, report); notify("\n".join(report)); return 1
        if not dirty():
            report.append("RESULT: nothing to change; portal is healthy."); git("checkout", gb["dev_branch"]); git("branch", "-D", work)
            write_report(a.mode, report); notify("\n".join(report)); return 0
        nfiles = len(dirty().splitlines())
        if nfiles > g["max_changed_files"]:
            report.append("RESULT: %d files changed, above the limit of %d. Stopped." % (nfiles, g["max_changed_files"]))
            git("checkout", "--", "."); git("clean", "-fd", "--", ".", ":!ai-maintenance"); git("checkout", gb["dev_branch"]); git("branch", "-D", work)
            write_report(a.mode, report); notify("\n".join(report)); return 1
        git("add", "-A", "--", ".", ":!ai-maintenance"); git("commit", "-m", "AI %s: %s" % (a.mode, (a.text or "upkeep")[:60]))
        ok, lines = pipeline.promote(work, dry=a.dry_run)
        report += lines + ["RESULT: " + ("promoted" if ok else "FAILED, rolled back")]
        write_report(a.mode, report); notify("\n".join(report)); return 0 if ok else 1
    except Exception as e:
        report.append("ERROR: %s" % e); write_report(a.mode, report); notify("\n".join(report)); return 2
    finally:
        if os.path.exists(lock): os.remove(lock)

if __name__ == "__main__":
    sys.exit(main())
