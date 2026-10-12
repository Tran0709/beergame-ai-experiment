"""Telegram feedback channel. Run on any always-on machine:  python agent/telegram_bot.py
Only chat IDs listed in TELEGRAM_ALLOWED_CHAT_IDS are obeyed. Anything else is ignored.
  plain text      -> treated as feedback; the agent fixes it and reports back
  /status         -> where dev/test/live are
  /run            -> run the weekly maintenance now
  /approve        -> deploy what's on test to live
  /rollback       -> put live back to the last restore point
  /help"""
import sys, os, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

def reply(token, chat, text):
    try: tg_call(token, "sendMessage", {"chat_id": chat, "text": text[:3900]})
    except Exception as e: print("send failed:", e)

def agent(*args):
    return subprocess.run([sys.executable, os.path.join(HERE, *args[:1])] + list(args[1:]), cwd=REPO,
                          capture_output=True, text=True).returncode

def status():
    gb = cfg()["git"]
    try: git("fetch", "--quiet", check=False)
    except Exception: pass
    s = []
    for n in ("dev_branch", "test_branch", "live_branch"):
        b = gb[n]; s.append("%s: %s %s" % (n.split("_")[0], git("rev-parse", "--short", b, check=False), git("log", "-1", "--format=%s", b, check=False)))
    ahead = git("rev-list", "--count", "%s..%s" % (gb["live_branch"], gb["test_branch"]), check=False)
    s.append("Waiting for approval: %s change(s)" % ahead)
    return "\n".join(s)

def handle(token, chat, text):
    t = text.strip()
    if t in ("/start", "/help"):
        reply(token, chat, __doc__.split("\n", 1)[1]); return
    if t == "/status": reply(token, chat, status()); return
    if t == "/run": reply(token, chat, "Starting weekly maintenance now."); agent("maintain.py", "weekly"); return
    if t == "/approve": reply(token, chat, "Deploying to live..."); agent("pipeline.py", "go-live"); return
    if t == "/rollback": reply(token, chat, "Rolling back live..."); agent("pipeline.py", "rollback"); return
    # anything else = feedback for the AI
    os.makedirs(STATE, exist_ok=True)
    open(os.path.join(STATE, "feedback.jsonl"), "a", encoding="utf-8").write(json.dumps({"t": now(), "chat": chat, "text": t}) + "\n")
    reply(token, chat, "Got it. I'm looking into: \"%s\". I'll report back." % t[:200])
    agent("maintain.py", "feedback", "--text", t)

def main():
    load_env(); c = cfg()["telegram"]
    token = os.environ.get(c["token_env"]); allowed = {i.strip() for i in os.environ.get(c["allowed_chat_ids_env"], "").split(",") if i.strip()}
    if not token or not allowed: sys.exit("Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_IDS in ai-maintenance/.env")
    offset = 0; print("Bot running. Ctrl+C to stop.")
    while True:
        try: res = tg_call(token, "getUpdates", {"timeout": 30, "offset": offset}, timeout=45)
        except Exception as e: print("poll error:", e); import time; time.sleep(5); continue
        for u in res.get("result", []):
            offset = u["update_id"] + 1; m = u.get("message") or {}
            chat = str(m.get("chat", {}).get("id", "")); text = m.get("text", "")
            if chat in allowed and text: handle(token, chat, text)
            elif text: print("ignored message from unauthorised chat", chat)

if __name__ == "__main__": main()
