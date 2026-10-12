// Self-maintenance test suite. Zero dependencies. Exit code 0 = healthy.   node tests/run_all.js
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync, spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  PASS', name); } catch (e) { fail++; console.log('  FAIL', name, '-', e.message); } }
const eq = (c, m) => { if (!c) throw new Error(m); };

t('every source file parses', () => {
  ['engine.js', 'market.js', 'multiplayer.js', 'ui.js'].forEach(f => new vm.Script(fs.readFileSync(path.join(root, 'source', f), 'utf8'), { filename: f }));
  const r = spawnSync(process.execPath, ['--check', path.join(root, 'ai-proxy-server', 'server.js')]); eq(r.status === 0, 'ai-proxy-server/server.js: ' + r.stderr);
});
t('index.html is in sync with source/', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'rebuild.js'), '--check']); eq(r.status === 0, r.stderr.toString().trim());
});
t('bundle has the key screens and a build tag', () => {
  const h = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ['orderInput', 'BUILD_TAG', 'Current Role status', 'HOW_TO_PLAY_VIDEO_BASE64'].forEach(s => eq(h.includes(s), 'missing: ' + s));
});
t('no secrets in the project', () => {
  const bad = []; (function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name); if (['node_modules', '.git', 'twin'].includes(e.name)) return;
    if (e.isDirectory()) return walk(p);
    if (e.name === '.env') bad.push(p + ' (.env must not ship)');
    if (/\.(js|html|json|md|py|bat|yml|example)$/.test(e.name) && /sk-[A-Za-z0-9_-]{20,}/.test(fs.readFileSync(p, 'utf8'))) bad.push(p);
  }); })(root);
  eq(!bad.length, bad.join(', '));
});
t('engine: 150 bot-only games stay sane', () => {
  const { BeerGameEngine, CHAIN } = require(path.join(root, 'source', 'engine.js'));
  for (let n = 0; n < 150; n++) {
    const g = new BeerGameEngine({ totalWeeks: 8 + (n % 9) }); let guard = 0, sum = {};
    while (!g.gameOver && guard++ < 60) g.processWeek({});
    eq(g.gameOver, 'game never ended');
    CHAIN.forEach(r => { const s = g.roles[r];
      eq([s.stock, s.backlog, s.totalCost].every(Number.isFinite), 'NaN in ' + r);
      eq(s.stock >= 0 && s.backlog >= 0 && s.totalCost >= 0, 'negative value in ' + r);
      eq(s.history.length === g.totalWeeks, r + ' history length'); });
  }
});
t('engine: facilitator order ceiling is enforced', () => {
  const { BeerGameEngine } = require(path.join(root, 'source', 'engine.js'));
  const run = capped => { const g = new BeerGameEngine({ totalWeeks: 8, roleAssignments: { retailer: { id: 'h', name: 'Human', isBot: false } } });
    if (capped) g.setInterventions({ infoScope: 'off', caps: { retailer: { max: 5, untilWeek: 8 } }, costs: {} });
    g.processWeek({}); g.processWeek({}); g.processWeek({ retailer: 40 }); return g.roles.retailer.history[2].orderPlaced; };
  eq(run(false) === 40, 'uncapped control should order 40, got ' + run(false));
  eq(run(true) === 5, 'capped retailer should order 5, got ' + run(true));
});
t('digital twin builds and matches live', () => {
  execSync(process.execPath + ' scripts/make_twin.js', { cwd: root, stdio: 'pipe' });
});
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
