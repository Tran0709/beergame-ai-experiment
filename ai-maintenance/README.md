# Beer Game: Weekly AI Self-Maintenance (AI-build demo)

An agent that looks after the game every week: it checks the game is healthy, fixes what it can, proves the fix in a safe copy, and only then asks you to approve it going live. Python standard library + Node, no installs.

## The loop
```
 Monday 02:00 SGT (GitHub Action) ─┐        ┌─ Telegram: "retailer can't see orders"
                                   ▼        ▼   /status /run /approve /rollback
                      ai-maintenance/agent/maintain.py
   branch off dev → rebuild index.html from source/ → run the health suite (tests/run_all.js)
   red? → ask OpenAI for a small patch → guardrails → rebuild → re-test
        ▼
   DEV   tests + smoke
   TEST  = DIGITAL TWIN (scripts/make_twin.js): the live bundle wired to a sandbox relay + mock AI,
           proven identical to live except the relay URL. Real players and the OpenAI bill are never touched.
        ▼
   LIVE gate → you reply /approve in Telegram  → main updated, restore tag made
        ▼  a failing live check rolls back automatically; /rollback does it by hand
```

## What the weekly health check covers (`node tests/run_all.js`)
Sources and AI proxy parse · `index.html` matches `source/` · key screens present · no API key or `.env` anywhere in the project · 150 bot-only games stay sane (no NaN/negative stock, cost, backlog) · Facilitator order ceiling enforced · twin builds and matches live.

## Guardrails
The agent can never edit: `.env` files, `tests/` (so it can't "pass" by weakening the tests), `.github/`, or `ai-maintenance/`. Max 12 files / 400 changed lines per run. It never pushes to live without `/approve` (config `approval.live`; `"auto"` is available later). If it can't reach green, nothing is promoted and you are told.

## Setup
1. Make the repo's branches: `dev`, `test`, `main` (= live). Copy this folder's contents into it.
2. `ai-maintenance/.env` (from `.env.example`): leave `OPENAI_API_KEY` blank to reuse the key already in `ai-proxy-server/.env`. Add the Telegram bot token (from @BotFather) and your chat ID. Never commit, paste or screenshot it.
3. Telegram: `python ai-maintenance/agent/telegram_bot.py` on any machine that stays on.
4. Weekly schedule: `.github/workflows/weekly-maintenance.yml` (add repo secrets `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`; set `git.push` to `true` in `config/config.json`). Or cron: `0 2 * * 1 python ai-maintenance/agent/maintain.py weekly`.
5. Live deploy: you upload to Cloudflare by hand today, so `/approve` promotes the code on `main` and you upload it. Put your `wrangler deploy` command in `environments.live.deploy_cmd` to automate that, then add `node scripts/smoke_url.js <url>` as its `smoke_cmd`.

## Prove it works (no keys, no network)
`python ai-maintenance/tests/test_framework.py` copies the real game, plants a bug in the engine, and shows the agent healing it through dev → test → approval → live, refusing to touch tests/secrets, and leaving a healthy game alone.

## Next: the no-AI build
Same folder, same config; only `project_name`, the live URL and the relay default differ, and the AI proxy files are absent.
