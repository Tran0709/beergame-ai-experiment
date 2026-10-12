"""Dev -> Test(twin) -> Live promotion. Each stage = run tests, deploy, smoke check.
A failure at any stage resets that branch to where it was, so bad changes never linger."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

def stage(name, dry):
    c = cfg(); env = c["environments"][name]; log = []
    rc, out = run(c["commands"]["test"])
    log.append("tests: %s" % ("PASS" if rc == 0 else "FAIL"))
    if rc != 0:
        return False, log, out[-1500:]
    for label, key in (("deploy", "deploy_cmd"), ("smoke", "smoke_cmd")):
        if dry:
            log.append("%s: skipped (dry-run)" % label); continue
        rc, out = run(env.get(key, ""))
        log.append("%s: %s" % (label, "ok" if rc == 0 else "FAIL"))
        if rc != 0:
            return False, log, out[-1500:]
    return True, log, ""

def push(branch):
    c = cfg()["git"]
    if c.get("push"):
        git("push", c["remote"], branch)

def promote(work_branch, dry=False):
    """work_branch -> dev -> test -> (gate) live. Returns (ok, summary_lines)."""
    c = cfg(); gb = c["git"]; dev, test, live = gb["dev_branch"], gb["test_branch"], gb["live_branch"]
    lines = []
    # DEV
    before_dev = git("rev-parse", dev)
    git("checkout", dev); git("merge", "--no-ff", "-m", "AI maintenance: merge %s" % work_branch, work_branch)
    ok, log, err = stage("dev", dry); lines += ["DEV: " + ", ".join(log)]
    if not ok:
        git("reset", "--hard", before_dev); return False, lines + ["DEV failed, rolled back.", err]
    push(dev)
    # TEST (digital twin)
    before_test = git("rev-parse", test)
    git("checkout", test); git("merge", "--no-ff", "-m", "Promote dev to test", dev)
    ok, log, err = stage("test", dry); lines += ["TEST (twin): " + ", ".join(log)]
    if not ok:
        git("reset", "--hard", before_test); git("checkout", dev); return False, lines + ["TEST failed, rolled back.", err]
    push(test)
    git("checkout", dev)
    if c["approval"]["live"] == "telegram":
        lines.append("LIVE: waiting for your approval. Reply /approve in Telegram (or run: python agent/pipeline.py go-live).")
        return True, lines
    ok, more = go_live(dry); return ok, lines + more

def go_live(dry=False):
    c = cfg(); gb = c["git"]; test, live = gb["test_branch"], gb["live_branch"]
    ahead = git("rev-list", "--count", "%s..%s" % (live, test))
    if ahead == "0":
        return True, ["LIVE: already up to date, nothing to deploy."]
    before = git("rev-parse", live)
    git("tag", "-f", "pre-live-" + now(), before)          # restore point
    git("checkout", live); git("merge", "--ff-only", test)
    ok, log, err = stage("live", dry); lines = ["LIVE: " + ", ".join(log)]
    if ok:
        push(live); git("checkout", gb["dev_branch"]); return True, lines
    git("reset", "--hard", before)                          # ROLLBACK
    if not dry:
        run(c["environments"]["live"]["deploy_cmd"])        # redeploy previous version
    git("checkout", gb["dev_branch"])
    return False, lines + ["LIVE failed. Rolled back to %s and redeployed." % before[:8], err]

def rollback(dry=False):
    """Manual rollback of live to the most recent pre-live tag."""
    c = cfg(); live = c["git"]["live_branch"]
    tags = git("tag", "--list", "pre-live-*", "--sort=-creatordate").splitlines()
    if not tags: return False, ["No restore point found."]
    git("checkout", live); git("reset", "--hard", tags[0])
    if not dry: run(c["environments"]["live"]["deploy_cmd"])
    git("checkout", c["git"]["dev_branch"])
    return True, ["Live rolled back to restore point %s." % tags[0]]

if __name__ == "__main__":
    load_env(); cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    dry = "--dry-run" in sys.argv
    fn = {"go-live": lambda: go_live(dry), "rollback": lambda: rollback(dry)}.get(cmd)
    if not fn: sys.exit("usage: pipeline.py go-live|rollback [--dry-run]")
    ok, lines = fn(); notify("\n".join(lines)); sys.exit(0 if ok else 1)
