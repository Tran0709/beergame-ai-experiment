// Builds the DIGITAL TWIN: the exact live bundle, but wired to a sandbox relay + mock AI so
// nothing a test does can touch real players, the live relay, or the OpenAI bill.
// Usage: node scripts/make_twin.js   -> twin/site/index.html
const { execSync } = require('child_process'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const relay = process.env.TWIN_RELAY_URL || 'ws://localhost:8787';
const out = path.join(root, 'twin', 'site'); fs.mkdirSync(out, { recursive: true });
execSync('node scripts/rebuild.js --relay ' + relay + ' --out ' + JSON.stringify(path.join(out, 'index.html')), { cwd: root, stdio: 'inherit' });
const twin = fs.readFileSync(path.join(out, 'index.html'), 'utf8'), live = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (!twin.includes("DEFAULT_SERVER_URL = '" + relay + "'")) throw new Error('twin relay not applied');
// the twin must differ from live ONLY in the relay constant
const strip = s => s.replace(/const DEFAULT_SERVER_URL = '[^']*';/, '');
if (strip(twin) !== strip(live)) throw new Error('twin differs from live in more than the relay URL');
console.log('Twin OK: identical to live except relay =', relay);
