// Smoke check for a deployed copy: node scripts/smoke_url.js <url>   (200 + the game's title + build tag)
const url = process.argv[2];
if (!url) { console.error('usage: smoke_url.js <url>'); process.exit(2); }
fetch(url).then(async r => {
  const t = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (!t.includes('The Beer Game')) throw new Error('page loaded but is not the Beer Game');
  const tag = (t.match(/BUILD_TAG = '([^']+)'/) || [])[1];
  console.log('OK', url, 'build', tag); 
}).catch(e => { console.error('SMOKE FAIL', url, e.message); process.exit(1); });
