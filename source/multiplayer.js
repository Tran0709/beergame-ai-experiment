// ===== The Beer Game: Multiplayer Transport & Room Management =====
//
// TWO TRANSPORT MODES:
// 1. Same-device (default, no server URL given): uses the browser's
//    BroadcastChannel API. Connects tabs/windows of this file on ONE browser,
//    ONE device only: no internet involved, nothing to configure.
// 2. Online (a server URL is provided): connects to a real WebSocket relay
//    server (see server.js), which genuinely reaches other devices, other
//    networks, other time zones: anyone with the room code and the server's
//    address. The relay server does no game logic at all; it only forwards
//    messages between clients in the same room, so this file's game engine
//    and UI code work completely unchanged regardless of which mode is active.

// ===== The Beer Game: Multiplayer Transport & Room Management =====
//
// TWO TRANSPORT MODES:
// 1. Same-device (fallback, no server configured): uses the browser's
//    BroadcastChannel API. Connects tabs/windows of this file on ONE
//    browser, ONE device only: no internet involved, nothing to configure.
// 2. Online (DEFAULT_SERVER_URL below is set): connects to a real WebSocket
//    relay server (see relay-server/), which genuinely reaches other
//    devices, other networks, other timezones: anyone with just the room
//    code. The relay server does no game logic at all; it only forwards
//    messages between clients in the same room, so this file's game engine
//    and UI code work completely unchanged regardless of which mode is active.
//
// SET THIS ONCE to make every room in the game "just enter a code" on any
// device, automatically: no one ever has to type or paste a server URL.
// Deploy relay-server/ (see relay-server/README.md: Render's free tier
// takes about 5 minutes), then paste the wss:// URL it gives you below.
// Leave it blank to fall back to same-device-only play (still fully working,
// just limited to tabs on one browser).
const DEFAULT_SERVER_URL = 'wss://beer-game-v12p.onrender.com';

const ROOM_CHANNEL_PREFIX = 'beergame_la4_room_';
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid ambiguity

function generateRoomCode(len = 5) {
  let code = '';
  for (let i = 0; i < len; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  return code;
}

class RoomTransport {
  // serverUrl: e.g. "wss://your-app.onrender.com": omit/empty for same-device play
  constructor(roomCode, serverUrl) {
    this.roomCode = roomCode;
    this.handlers = [];
    this.errorHandlers = [];
    this.statusHandlers = [];  // transient connecting/reconnecting notices, not fatal errors
    this.mode = serverUrl ? 'websocket' : 'broadcast';
    this.sendQueue = [];
    this.wsOpen = false;

    if (this.mode === 'websocket') {
      const base = serverUrl.replace(/\/+$/, '');
      this.url = base + '?room=' + encodeURIComponent(roomCode);
      this.closedByUs = false;
      // Free hosting tiers (Render, Railway, Fly) put an idle service to
      // sleep and take roughly 30-60 seconds to wake on the next request.
      // A single connection attempt during that window just fails, which
      // looked to players like the room code was wrong. So retry for a
      // while before giving up, and tell them what's actually happening.
      this.retriesLeft = 12;      // ~12 attempts x 5s = about a minute
      this.retryDelayMs = 5000;
      this.everConnected = false;
      this._wakeThenConnect();
    } else {
      this.supported = typeof BroadcastChannel !== 'undefined';
      this.channel = this.supported ? new BroadcastChannel(ROOM_CHANNEL_PREFIX + roomCode) : null;
      if (this.channel) this.channel.onmessage = (e) => this.handlers.forEach(h => h(e.data));
    }
  }
  // Free hosting tiers put an idle service to sleep. Waking it needs a
  // plain HTTP request: a WebSocket upgrade aimed at a sleeping service
  // gets answered by the platform's router (Render returns 404) rather
  // than reaching the app, so the socket fails even though the deployment
  // is perfectly healthy. Firing a normal fetch first wakes the service,
  // then the upgrade lands on the real server.
  _wakeThenConnect() {
    const httpUrl = this.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    let settled = false;
    const go = () => { if (!settled) { settled = true; this._connect(); } };
    try {
      // no-cors: we don't need to read the response, only to make the
      // platform route a request to the app and spin it up.
      fetch(httpUrl, { mode: 'no-cors', cache: 'no-store' }).then(go).catch(go);
    } catch (e) { go(); return; }
    // don't wait forever on the wake ping
    setTimeout(go, 4000);
  }
  _connect() {
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this.errorHandlers.forEach(h => h('Could not reach the multiplayer server.'));
      return;
    }
    this.ws.addEventListener('open', () => {
      this.wsOpen = true;
      this.everConnected = true;
      this.retriesLeft = 12; // replenish, so a later drop also gets retries
      this.statusHandlers.forEach(h => h(null)); // clear any "connecting" notice
      this.sendQueue.forEach(msg => this.ws.send(JSON.stringify(msg)));
      this.sendQueue = [];
    });
    this.ws.addEventListener('message', (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      this.handlers.forEach(h => h(data));
    });
    this.ws.addEventListener('error', () => { /* handled in close, which always follows */ });
    this.ws.addEventListener('close', () => {
      this.wsOpen = false;
      if (this.closedByUs) return;
      if (this.retriesLeft > 0) {
        this.retriesLeft--;
        const attempt = 12 - this.retriesLeft;
        this.statusHandlers.forEach(h => h(
          this.everConnected
            ? `Connection dropped. Reconnecting… (attempt ${attempt})`
            : `Waking up the game server, this can take up to a minute on first use… (attempt ${attempt})`
        ));
        setTimeout(() => { if (!this.closedByUs) this._wakeThenConnect(); }, this.retryDelayMs);
      } else {
        this.errorHandlers.forEach(h => h(
          "Couldn't reach the game server after about a minute of trying. It may be offline. " +
          'Ask the host to confirm the server is deployed and running, then try again.'
        ));
      }
    });
  }
  send(msg) {
    if (this.mode === 'websocket') {
      if (this.wsOpen) this.ws.send(JSON.stringify(msg));
      else this.sendQueue.push(msg); // flushed once the socket opens
    } else if (this.channel) {
      this.channel.postMessage(msg);
    }
  }
  onMessage(handler) {
    this.handlers.push(handler);
  }
  onError(handler) {
    this.errorHandlers.push(handler);
  }
  // Fires with a message while the connection is being (re)established, and
  // with null once it succeeds. Distinct from onError, which only fires once
  // we have genuinely given up.
  onStatus(handler) {
    this.statusHandlers.push(handler);
  }
  close() {
    this.closedByUs = true;   // stops the retry loop from firing after a deliberate close
    if (this.mode === 'websocket') {
      if (this.ws) this.ws.close();
    } else if (this.channel) {
      this.channel.close();
    }
    this.handlers = [];
    this.errorHandlers = [];
    this.statusHandlers = [];
  }
}



