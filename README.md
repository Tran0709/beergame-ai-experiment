# The Beer Game (LA4) - AI Chat Suggestion Experiment (OpenAI)

**This is a separate, experimental branch. It is NOT the version being
prepared for Rick.** It adds an AI chat assistant that any role can consult
for an order/demand suggestion without leaving the game screen. Everything
else about the game is unchanged from the main build.

## Read this before doing anything else

**If you pasted an API key into a chat conversation to get this built,
that key is compromised - revoke it at platform.openai.com (or
console.mistral.ai, if a Mistral key was ever shared too, from when this
project briefly used that provider) and generate a new one before using
anything in this folder.** Nothing in this folder
contains any real key - every file here reads it from an environment
variable at runtime, but a key that has already been shared in a chat log
should be treated as burned regardless.

## Why this needs a backend at all

The game itself is one static HTML file. If an API key were written into
that file, every single person who plays the game could open their
browser's dev tools and read it out of the page source in a few seconds -
there is no way to hide a secret inside client-side JavaScript. Once
exposed that way, it's exposed to everyone, permanently, and since API
keys are billing-linked, an exposed key becomes real charges on your
account, not just an inconvenience.

`ai-proxy-server/` exists specifically to prevent that. The key lives only
on that server, as an environment variable. The game calls the server; the
server calls OpenAI's API; the browser never sees the key at all.

## What's in this folder

```
index.html              <- the game, with the AI chatbox added
source/                   <- the same code, split into readable files
  engine.js                 game rules (includes a bugfix - see below)
  market.js
  multiplayer.js
  ui.js                     the chatbox UI lives here (search "AI CHAT")
  base-style.css
ai-proxy-server/          <- REQUIRED for the AI feature to work
  server.js                 holds the OpenAI key server-side, never in code
  package.json
```

## Setting this up

**Recommended: a `.env` file.** In `ai-proxy-server/`, copy `.env.example`
to a new file named `.env`, and put your real key in that file instead of
the placeholder. The server loads it automatically on startup - nothing
else to configure. This is the safest option because the key lives in one
local file you control, and it's the only thing you ever need to edit
again if the key changes. **Never paste the contents of `.env` into a
chat, an email, or any shared document, and don't include it if you ever
zip up this folder to send to someone else.**

**Quickest path on Windows, once `.env` exists:** just double-click
`start-ai-game.bat`. It checks for `.env` automatically, starts the proxy
server in its own window, and opens the game for you. (The batch file also
still supports setting the key directly inside itself as a fallback, if
you'd rather not use `.env` - see the comments near the top of that file -
but `.env` is the better option if this folder might ever be shared.)

You still have to run the launcher every time you want the AI feature on
- a webpage cannot launch a background program on your machine on its
own, for the same reason no website should be able to do that. If you'd
rather it just always be running with no manual step at all, see
"Removing the manual step entirely" below.

The full manual steps, if you'd rather not use the batch file:

1. **Get a fresh OpenAI API key** at platform.openai.com (after revoking
   any key that was ever shared in a chat, per the warning above).
2. **Deploy `ai-proxy-server/`** somewhere that supports environment
   variables - Render, Railway, Fly.io, or your own machine for local
   testing. Set `OPENAI_API_KEY` as an environment variable on that
   platform's dashboard, never in a file:
   ```
   OPENAI_API_KEY=...      <- set this in your host's dashboard, not here
   ```
3. **Point the game at your deployed proxy.** In `source/ui.js`, find:
   ```js
   const AI_PROXY_URL = 'http://localhost:8790/suggest';
   ```
   and change it to wherever you deployed the proxy, then rebuild
   `index.html` (see below). Left pointing at localhost by default
   deliberately - if you forget this step, the feature fails with an
   obvious connection error rather than silently calling something
   unintended.
4. For local testing only:
   ```bash
   cd ai-proxy-server
   npm install
   OPENAI_API_KEY=your-new-key node server.js
   ```
   On Windows PowerShell, set it as its own step instead:
   ```powershell
   $env:OPENAI_API_KEY="your-new-key"
   node server.js
   ```
   Never commit a command with a real key in your shell history if that
   history is ever shared or backed up somewhere.

## Removing the manual step entirely

The batch file above still requires double-clicking something before each
session. To make the AI feature just work whenever the game is opened,
with nothing to start manually at all, deploy `ai-proxy-server/`
permanently - the same way the game's multiplayer relay server is already
deployed:

1. Push this folder (or just `ai-proxy-server/`) to a Node host - Render,
   Railway, and Fly.io all have a free tier and were already used
   elsewhere in this project.
2. Set `OPENAI_API_KEY` as an environment variable in that platform's
   dashboard - never in a file.
3. Once deployed you'll have a permanent URL, something like
   `https://your-app.onrender.com`. Update `AI_PROXY_URL` in
   `source/ui.js` to point at `https://your-app.onrender.com/suggest`,
   then rebuild `index.html` (see below).

After that, the game calls the AI feature the same way it already calls
the multiplayer relay - a permanent address, no local server, nothing to
remember to start.

## If the chatbox response seems to disappear on its own

This was a real bug, already fixed - if you're seeing it, you're almost
certainly running an older copy of `index.html`, not this one. Quick way
to check: open `index.html` in a text editor and search for
`aiChatStatus`. If it's there (should appear well over a dozen times),
you have the fixed version. If it's not there at all, you have an older
build - re-download and replace it.

Tested directly, not just assumed: the response now survives an unrelated
re-render firing mid-request (a decision timer expiring being the actual
case that surfaced this originally), and stays correctly visible for at
least 15 seconds after arriving, in both solo and multiplayer, for both a
successful suggestion and a failed one.

## News now has a real, mandatory effect on orders

Global and Local News used to be flavor text - a headline with a
percentage that was never actually applied to anything. That's changed:
both now carry a fixed number of units, shown directly in the news box
("+4 units to your order" / "-2 units to your order"), and that number is
mandatorily added to whatever a role submits - whether typed by a human
or decided by a bot - the moment they submit. Not optional, not a
suggestion.

- **Global News** affects everyone: every chain role's order, and the
  Facilitator's consumer demand.
- **Local News** affects only the one chain role it's assigned to, on top
  of whatever Global News is also active.
- Both are skipped entirely during the two fixed weeks, which stay a
  stable, unaffected baseline.
- The final number is always clamped to zero or above - news can push an
  order down to nothing, never negative.
- Every role's news box also shows a combined total when both Global and
  Local are active at once - e.g. "Total adjustment this week: +8 (Global
  +4, Local +4)" - so the interaction between the two is visible directly,
  not something a player has to add up themselves. The Facilitator's
  summary view shows this combined total for all 4 chain roles at a
  glance, since the same Global effect can land very differently
  depending on what Local News each role also has active.

Verified directly against the engine: global-only, global+local combined,
negative shifts clamping correctly at zero, bots getting the same
treatment as humans, and a full real multiplayer session where a guest's
independently-synced copy of the shift matched the host's authoritative
calculation exactly, across a week boundary.

**Both suggestion mechanisms account for this now.** The Facilitator's
"Suggested" button and the AI chatbox both know a shift will be added on
top of whatever they suggest, and choose their number accordingly - so
the *final* recorded order lands on a genuinely good decision, not
baseline+shift by accident. Verified end-to-end: with a +6 shift active,
"Suggested" filled in a lower raw number that, once the mandatory shift
was added at submission, landed the final recorded demand back on the
scenario's actual intended baseline - confirmed exact, not approximate.
The AI proxy is told the exact pending shift in its prompt and instructed
explicitly to suggest the pre-shift number, not the final total.

## Roles see this week's incoming order as soon as their buyer submits

Submissions run in order (Facilitator, Retailer, Wholesaler, Distributor,
Manufacturer). The moment a role's turn opens, the order its buyer placed
that week appears in its "Order received this week" box: the Retailer sees
the Facilitator's demand, the Wholesaler sees the Retailer's order, and so
on, with any news adjustment already included. It is the same number the
week later resolves with, because it comes from the engine's own
calculation. The AI chatbox is sent this same figure, so its suggestion is
based on this week's incoming order rather than last week's. In solo play
the other seats are bots that decide instantly, so the incoming order is
shown from the start of the week.

## Help & Guide

Settings (the gear) -> Help & Guide opens a walkthrough video of about a minute
and the written guide. The video has captions (CC button) and 13 chapter buttons
that jump to each step. The video and captions are embedded in `source/ui.js`
(`HOW_TO_PLAY_VIDEO_BASE64`, `HOW_TO_PLAY_CHAPTERS`, `HOW_TO_PLAY_CAPTIONS_VTT`), so
the game stays a single file. This build's video has an extra step on the Ask AI panel (it shows a sample reply), and the guide has an Ask AI section. It shows the game as it looks today: if the screens or
rules change, the video needs regenerating, or it will go out of date again.

## The Facilitator sees each order as it is placed

On the Facilitator's Current Role status panel, each seat shows how many units
that role has just ordered, the moment they submit, with any news adjustment
spelled out (for example "Ordered 11 (typed 5, news +6)"). AI seats show their
order as soon as their turn comes up. Waiting seats show last week's order. Other
players, and a host who is not the Facilitator, see only a tick. The Settings menu
also shows a "Build" line: if it is missing, an older copy of the game is being served.

## Facilitator interventions

When one role is stuck in a backlog spiral (a Retailer that understocks, then
panic-orders to clear the backlog and floods everyone upstream), the Facilitator
panel has three levers. All are off until switched on, and the players they affect
are told on their own screens.

- **Information sharing.** Shows the Retailer's stock, backlog and the real customer
  demand to the Wholesaler or to the whole chain. AI seats in that scope also order
  from real customer demand instead of the order their buyer placed. This
  deliberately breaks the normal rule that you only see your own numbers.
- **Order ceiling.** Caps one role's weekly order for a number of weeks, counted
  from the current week. Applied after any news adjustment, to humans and AI alike.
  A player who types more is told, and the next role is shown the capped number.
- **Market shift.** Different stock and/or backlog cost for one role or all of
  them, from the next week resolved. Past weeks are never recalculated, the
  end-of-game baseline is charged the same changed rates, and the results screen
  says when costs were changed because totals are then not directly comparable.
  The panel warns when backlog would cost less than stock: that makes running
  short the cheaper strategy.

The AI chatbox is told about any order ceiling and the role's own cost rates, so its suggestion respects them.

## A note on testing

I built this against OpenAI's documented chat completions API. I could
not verify a live round-trip myself - my own environment has no network
access to api.openai.com. Everything else (request validation, error
handling, prompt construction, the full frontend flow) is tested and
confirmed working with a simulated response. The first real request you
make is the one thing only you can confirm. If it fails specifically with
a 400
mentioning `response_format`, that field in `ai-proxy-server/server.js` is
the first thing to try removing.

## How the feature works

Every role - the 4 chain roles and the Facilitator - gets a small
"🤖 Ask AI for a suggestion" panel under their order entry, visible only
during real decision weeks (not the two fixed weeks). A player can
optionally type a specific question, then click to get a suggested number
with a short plain-language reason, and a "Use this number →" button that
fills the actual order/demand field for them - no new tab, no leaving the
game.

The AI is told only what that role could actually see in the real game:
their own stock, backlog, and the order placed on them - never anyone
else's numbers. The Facilitator's version is different, since they have no
stock or backlog of their own: it's given the recent demand trend instead
and asked what demand to set.

This is a genuinely different thing from the bots that already play in
this game. The bots decide instantly with a tuned heuristic in
`engine.js`, with no visible reasoning. This chat assistant is meant for a
*human* player to consult mid-decision and can explain itself in plain
language, but it never decides anything on its own - a player always
chooses whether to use the number it suggests.

## A bug fixed here, worth also fixing in the main build

While testing this, a genuine bug in `engine.js` was found and fixed here:
`getVisibleStateFor('facilitator')` was missing `isFixedOrderWeek`, which
meant a human playing Facilitator in Solo mode saw the wrong screen during
weeks 1-2 - the full manual entry field instead of the "fixed at 4 units,
confirm" screen - and if they didn't think to type 4 themselves, their
week 1-2 demand silently recorded as 0 instead of 4.

This bug predates this branch and is present in the main Rick-facing
build too. It's unrelated to the AI feature and should be applied there
separately - the fix is a few lines in `getVisibleStateFor()`.

## Rebuilding index.html from source

Same as the main build:

```python
engine = open('source/engine.js').read()
market = open('source/market.js').read()
multiplayer = open('source/multiplayer.js').read()
ui = open('source/ui.js').read()
css = open('source/base-style.css').read()

html = f'''<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Beer Game: Supply Chain Simulation (AI Experimental)</title>
<style>{css}</style></head>
<body><div id="app"></div><div id="helpModalRoot"></div>
<script>{engine}\n\n{market}\n\n{multiplayer}\n\n{ui}</script>
</body></html>'''

open('index.html', 'w').write(html)
```

## Turning the feature off without removing it

`SHOW_AI_CHATBOX` near the top of `source/ui.js` controls the whole
feature. Set it to `false` to hide it everywhere without touching
anything else.
