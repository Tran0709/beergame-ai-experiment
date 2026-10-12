// Rebuilds index.html from source/ (the single-file bundle). Usage: node scripts/rebuild.js [--check] [--relay wss://...] [--out file]
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const rd = f => fs.readFileSync(path.join(root, 'source', f), 'utf8');
const existing = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const title = (existing.match(/<title>([^<]*)<\/title>/) || [])[1] || 'The Beer Game';
let js = [rd('engine.js'), rd('market.js'), rd('multiplayer.js'), rd('ui.js')].join('\n\n');
const relay = opt('--relay');
if (relay) js = js.replace(/const DEFAULT_SERVER_URL = '[^']*';/, "const DEFAULT_SERVER_URL = '" + relay + "';");
const html = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' + title + '</title><style>' +
  rd('base-style.css') + '</style></head>\n<body><div id="app"></div><div id="helpModalRoot"></div><script>' + js + '</script></body></html>';
if (args.includes('--check')) {
  if (html !== existing) { console.error('index.html is OUT OF SYNC with source/. Run: node scripts/rebuild.js'); process.exit(1); }
  console.log('index.html matches source/'); process.exit(0);
}
fs.writeFileSync(opt('--out') || path.join(root, 'index.html'), html);
console.log('wrote', opt('--out') || 'index.html', html.length, 'bytes');
