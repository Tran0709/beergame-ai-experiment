// The Beer Game (LA4) - AI Suggestion Proxy Server (OpenAI)
// =====================================================
// This exists for exactly one reason: to keep the OpenAI API key OFF the
// browser. The game itself is a single static HTML file with no backend
// of its own - if the key lived in that file, every single player would
// be able to open dev tools and read it out of the page source in about
// two seconds. This tiny server is what stands between the key and the
// public internet.
//
// The key is read from an environment variable (or a local .env file,
// see loadDotEnvIfPresent below) and NEVER appears in any file in this
// project. Set it on whatever platform hosts this server (Render,
// Railway, Fly.io, etc. all have a "Environment Variables" or "Secrets"
// section in their dashboard) - never in a committed file, never in the
// game's own code, and never typed directly into a terminal command or
// pasted into a chat, since both get logged/retained in ways you don't
// control.
//
//   OPENAI_API_KEY=sk-...   <- set this on your hosting platform, not here
//
// This server does exactly one thing: takes a role's current game
// situation, asks the model for an order-quantity suggestion with brief
// reasoning, and returns that as JSON. It has no other capability and
// touches no other part of the game's state.
//
// NOTE ON TESTING: I could not verify a live round-trip to OpenAI myself -
// my environment has no network access to api.openai.com. The request
// shape below matches OpenAI's documented chat completions API, which
// this server was originally built against before a temporary switch to
// Mistral. Test the very first real request carefully once you have a
// working key.

const http = require('http');
const fs = require('fs');
const path = require('path');

// Loads OPENAI_API_KEY (or anything else) from a .env file sitting next
// to this script, if one exists - a safe, local place to put a real key
// without ever typing it into a chat, a terminal command, or a shared
// file. Deliberately dependency-free (no npm install needed) rather than
// pulling in the "dotenv" package for something this small.
// Only fills in values not already set in the real environment, so an
// actual environment variable (e.g. set by a hosting platform) always
// wins over anything in this file.
function loadDotEnvIfPresent() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // strip one layer of surrounding quotes, if present - a value copied
    // with quotes still around it is a common, easy mistake
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvIfPresent();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 8790;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// A SAFE fingerprint of the key actually loaded - length plus a few
// characters from each end, never the middle. Exists because "401 Invalid
// API Key" happening across several genuinely fresh keys, one after
// another, points at something systematic in how the key reaches this
// process rather than a bad key each time - and the fastest way to find
// that is to show exactly what this process has, rather than trust it
// matches what was typed. Specifically catches the two most common
// causes: invisible leading/trailing whitespace from a copy-paste, and
// literal quote characters accidentally becoming part of the value (a
// well-known Windows batch mistake - set VAR="value" embeds the quotes
// themselves into the value, set "VAR=value" does not).
function describeKeySafely(key) {
  if (!key) return { present: false };
  const trimmed = key.trim();
  const issues = [];
  if (trimmed.length !== key.length) {
    issues.push(`has leading/trailing whitespace (${key.length} chars raw, ${trimmed.length} chars trimmed) - copy-pasting often picks up a stray space or newline`);
  }
  if (key.startsWith('"') || key.endsWith('"')) {
    issues.push('starts or ends with a literal quote character - if this was set via set VAR="value" in a Windows batch file, that syntax embeds the quotes into the value itself; use set "VAR=value" instead');
  }
  return {
    present: true,
    length: key.length,
    startsWith: key.slice(0, 4),
    endsWith: key.slice(-4),
    issues,
  };
}
const keyInfo = describeKeySafely(OPENAI_API_KEY);

if (!OPENAI_API_KEY) {
  console.error(
    'OPENAI_API_KEY is not set. This server will start, but every request ' +
    'will fail until you set it as an environment variable on wherever ' +
    'you deploy this - never hardcode it into this file.'
  );
} else {
  console.log(`OPENAI_API_KEY loaded: ${keyInfo.length} characters, starts "${keyInfo.startsWith}...", ends "...${keyInfo.endsWith}"`);
  if (keyInfo.issues.length) {
    console.warn('  Possible problem(s) with this key:');
    keyInfo.issues.forEach(i => console.warn('  - ' + i));
  } else {
    console.log('  No obvious formatting problems detected. Compare the length/start/end above against your real key - if those genuinely match and you still get 401, the key itself is the issue (regenerate it, or check your OpenAI account/billing is fully active), not how it was set here.');
  }
}

// A short, plain description of the exercise's rules, so the model has the
// same context a human player would have - and, just as importantly, is
// told explicitly what it does NOT know, matching the hidden-information
// design that's the whole point of the game.
const SYSTEM_PROMPT = `You are a supply-chain ordering assistant inside a
digital version of the MIT Beer Distribution Game (a 4-stage chain: Retailer,
Wholesaler, Distributor, Manufacturer, each ordering from the one above it,
supplied by a Facilitator-controlled End Consumer at the bottom).

Rules you must reason from:
- Orders take 2 weeks to arrive after being placed (lead time).
- Holding cost is $1 per unit of stock remaining, per week.
- Stockout cost is $2 per unit of unfulfilled backlog, per week - twice as
  expensive as holding stock, which is why running out is worse than
  overstocking.
- The role you are advising can see ONLY their own stock, backlog, and the
  order placed on them by the role immediately below them in the chain -
  never the rest of the chain. Do not assume information they would not
  actually have. The Facilitator is the exception: they control the End
  Consumer's demand directly and have no stock or backlog of their own to
  reason about - for that role, suggest a demand quantity instead of an
  order quantity, informed only by the recent demand trend they're given.
- The classic mistake in this exercise is overreacting to a single week's
  demand change, which amplifies into large, costly swings up the chain
  (the "bullwhip effect"). A good suggestion accounts for the current
  backlog gradually rather than trying to clear it in one order, and does
  not chase a demand spike as if it will continue indefinitely.

Respond with a short, specific reason (1-2 sentences, plain language, no
jargon) and a single recommended order quantity as a whole number >= 0.
Always return valid JSON matching this exact shape, nothing else:
{"suggestedQty": <integer>, "reasoning": "<short explanation>"}`;

function buildUserPrompt(state) {
  const {
    role, week, totalWeeks, stock, backlog, incomingOrder,
    recentOrdersPlaced, recentDemand, holdingCost, stockoutCost, question,
    pendingOrderShift, orderCap,
  } = state;

  let prompt;
  if (role === 'facilitator') {
    // The Facilitator sets consumer demand, not an order - they have no
    // stock or backlog of their own, so that section of the chain-role
    // prompt doesn't apply and would be misleading to include.
    prompt = `Role: Facilitator (controls the End Consumer's weekly demand, not an order)
Week: ${week} of ${totalWeeks}
Recent consumer demand set (oldest to newest): ${JSON.stringify(recentDemand || [])}`;
  } else {
    prompt = `Role: ${role}
Week: ${week} of ${totalWeeks}
Current stock on hand: ${stock}
Current backlog owed: ${backlog}
Order just received from downstream this week: ${incomingOrder}
Recent orders I have placed (oldest to newest): ${JSON.stringify(recentOrdersPlaced || [])}
Holding cost: $${holdingCost}/unit/week
Stockout cost: $${stockoutCost}/unit/week`;
  }

  if (pendingOrderShift) {
    const verb = role === 'facilitator' ? 'the demand you set' : 'whatever number you decide on';
    prompt += `\n\nIMPORTANT: active news this week will automatically ADD ${pendingOrderShift > 0 ? '+' : ''}${pendingOrderShift} units to ${verb}, the moment it's submitted - this is mandatory, not optional, and happens regardless of what number is chosen. Your suggestedQty should be the RAW number to submit, chosen so that AFTER this ${pendingOrderShift} shift is automatically added on top, the resulting final total is a genuinely good decision. Do not suggest the final total itself and expect it to be used as-is - factor the shift into your reasoning and suggest the pre-shift number instead.`;
  }

  if (orderCap != null && orderCap !== '') {
    prompt += `\n\nIMPORTANT: the Facilitator has set an order ceiling: the final order can never exceed ${orderCap} units, whatever number is chosen. Do not suggest more than ${orderCap}, and say so if the ceiling is what is limiting a sensible order.`;
  }

  if (question && String(question).trim()) {
    prompt += `\n\nThe player also asked: "${String(question).trim()}"`;
  }
  prompt += role === 'facilitator'
    ? `\n\nWhat consumer demand should I set this week, and why?`
    : `\n\nWhat should I order this week, and why?`;
  return prompt;
}

async function callOpenAI(userPrompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: 200,
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`OpenAI API returned ${res.status}: ${bodyText.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('OpenAI response had no content to parse.');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error('Could not parse the model\'s response as JSON: ' + content.slice(0, 200));
  }
  const qty = Math.max(0, Math.round(Number(parsed.suggestedQty)));
  if (!Number.isFinite(qty)) throw new Error('Model did not return a usable suggestedQty.');
  return {
    suggestedQty: qty,
    reasoning: String(parsed.reasoning || '').slice(0, 500),
  };
}

const server = http.createServer(async (req, res) => {
  // Minimal CORS: this proxy is meant to be called from the game's own
  // page, which will usually be on a different origin (a different host
  // than this server). Restrict this to your actual game's origin before
  // using this anywhere beyond local testing.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AI suggestion proxy is running.\n');
    return;
  }

  // Visit this in a browser (http://localhost:8790/debug-key) to check
  // what key the RUNNING server actually has, any time, without needing
  // to restart it or dig through terminal scroll-back. Same safe
  // length/start/end fingerprint printed at startup - never the full key.
  if (req.method === 'GET' && req.url === '/debug-key') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(keyInfo, null, 2));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/suggest') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. POST to /suggest.' }));
    return;
  }

  if (!OPENAI_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server is not configured with an OPENAI_API_KEY.' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 10_000) req.destroy(); });
  req.on('end', async () => {
    let state;
    try {
      state = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
      return;
    }
    if (!state || typeof state.role !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: role.' }));
      return;
    }
    try {
      const userPrompt = buildUserPrompt(state);
      const suggestion = await callOpenAI(userPrompt);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(suggestion));
    } catch (e) {
      console.error('AI suggestion request failed:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not get a suggestion right now. ' + e.message }));
    }
  });
});

server.listen(PORT, () => console.log(`AI suggestion proxy listening on ${PORT}`));
