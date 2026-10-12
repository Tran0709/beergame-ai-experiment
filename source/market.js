// ===== The Beer Game (LA4): Beer-Industry Stock Chart & AI Market Awareness =====
//
// SCOPE, STATED PLAINLY:
// 1. There is no single "beer stock price" as a data series. This charts a
//    real, named beer company's stock: Anheuser-Busch InBev (ticker BUD),
//    the world's largest brewer, as an honest, clearly-labeled proxy for
//    "the beer industry," via the Alpha Vantage API.
// 2. ALPHA_VANTAGE_API_KEY is intentionally blank by default. This file is
//    distributed as a public static page; baking in a real key would expose
//    it to anyone who views the source, and Alpha Vantage's free tier is
//    rate-limited low enough that one shared key would be exhausted almost
//    immediately in real multiplayer use. Fill in your own key below only
//    for a deployment you control, understanding it will then be visible to
//    anyone who can view that deployment's source.
// 3. When no key is configured, or the live fetch fails/rate-limits, this
//    falls back to a clearly-labeled simulated price series so the chart and
//    the AI market-awareness feature both keep working. The core game must
//    never depend on a third-party API being up.

// Hidden per Rick's explicit request in the requirements meeting ("hide this
// chart first, don't show it up"). Left as a single flag, not deleted, so
// it's a one-line change to bring back if that decision changes later.
const SHOW_MARKET_CHART = false;

const ALPHA_VANTAGE_API_KEY = 'IJ6GPD8IWYRTSQLD'; // confirmed working by the user directly against Alpha Vantage. See the
                                                    // note above: this means the key is visible to anyone who views this
                                                    // page's source, and the shared free-tier quota can be exhausted by
                                                    // real multiplayer use. Applied at the user's explicit, informed request.
const BEER_STOCK_SYMBOL = 'BUD';  // Anheuser-Busch InBev, used as an honest, named proxy, not a fictional "beer index"
const BEER_STOCK_LABEL = 'Anheuser-Busch InBev (BUD)';

const marketData = {
  series: null,       // [{date, close}], oldest first
  isLive: false,      // true if this came from a real Alpha Vantage fetch
  trendPct: 0,         // % change from first to last point in the series
  loading: false,
  error: null,
};

// Deterministic-looking but simulated series, used whenever there's no live
// data available, so the chart and AI nudge always have something coherent
// to work with instead of breaking.
function generateSimulatedSeries(days = 30) {
  const series = [];
  let price = 60 + Math.random() * 10; // beer-stock-ish starting price
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    price += (Math.random() - 0.48) * 1.5; // gentle random walk with a slight upward bias
    price = Math.max(20, price);
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    series.push({ date: d.toISOString().slice(0, 10), close: Math.round(price * 100) / 100 });
  }
  return series;
}

function computeTrendPct(series) {
  if (!series || series.length < 2) return 0;
  const first = series[0].close, last = series[series.length - 1].close;
  if (!first) return 0;
  return ((last - first) / first) * 100;
}

// Fetches BUD's recent daily closes from Alpha Vantage. Returns null (never
// throws) on any failure: missing key, network error, or a rate-limit
// response, so callers can always fall back cleanly.
async function fetchLiveBeerStockSeries() {
  if (!ALPHA_VANTAGE_API_KEY) return { series: null, reason: null };
  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${BEER_STOCK_SYMBOL}&outputsize=compact&apikey=${ALPHA_VANTAGE_API_KEY}`;
    // Plain fetch with a Promise.race timeout, deliberately NOT using
    // AbortController here. An AbortSignal passed into fetch() options
    // triggered a DataCloneError in real-world testing, most likely because
    // something in the request pipeline (browser extension, dev tools
    // protocol, or the file:// context this game often runs from) attempts
    // to structured-clone the request, and AbortSignal objects are not
    // reliably cloneable. A timeout promise avoids passing anything
    // non-standard into fetch() at all.
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000));
    const res = await Promise.race([fetch(url), timeoutPromise]);
    const data = await res.json();
    // Alpha Vantage returns 200 OK even for rate-limit/error responses,
    // the actual signal is in these fields, not the HTTP status. Surface the
    // exact text back rather than collapsing every failure into one message,
    // this is usually either a daily rate limit, or TIME_SERIES_DAILY sitting
    // behind a higher access tier than GLOBAL_QUOTE on newer Alpha Vantage plans.
    if (data['Note']) return { series: null, reason: 'Alpha Vantage: ' + data['Note'] };
    if (data['Information']) return { series: null, reason: 'Alpha Vantage: ' + data['Information'] };
    if (data['Error Message']) return { series: null, reason: 'Alpha Vantage: ' + data['Error Message'] };
    const series = data['Time Series (Daily)'];
    if (!series) return { series: null, reason: 'Alpha Vantage returned no recognizable data for this request.' };
    const dates = Object.keys(series).sort(); // ascending, oldest first
    const last30 = dates.slice(-30);
    return { series: last30.map(date => ({ date, close: Number(series[date]['4. close']) })), reason: null };
  } catch (e) {
    // network failure, timeout, abort, CORS rejection, or JSON parse error all land here,
    // browsers intentionally hide the exact cause of a CORS failure from JS for security reasons
    return { series: null, reason: 'Request failed (' + (e.name || 'network error') + '), possibly CORS, offline, or a timeout.' };
  }
}

// Call once per session (e.g. when a setup screen mounts), never on every render.
async function loadMarketData() {
  if (marketData.series && (marketData.isLive || !ALPHA_VANTAGE_API_KEY)) return marketData; // already loaded this session
  marketData.loading = true;
  const result = await fetchLiveBeerStockSeries();
  if (result.series && result.series.length >= 2) {
    marketData.series = result.series;
    marketData.isLive = true;
    marketData.error = null;
  } else {
    marketData.series = generateSimulatedSeries();
    marketData.isLive = false;
    marketData.error = result.reason; // null if no key configured at all; the specific reason otherwise
  }
  marketData.trendPct = computeTrendPct(marketData.series);
  marketData.loading = false;
  return marketData;
}

// AI MARKET AWARENESS: an optional, bounded nudge on top of the existing
// naive ordering heuristic, never a replacement for it. If the trend is
// strongly up, bots trim their order slightly (prices rising -> be a little
// more cautious about committing to more stock); if strongly down, they
// nudge slightly higher (cheaper -> a little more willing to stock up).
// The adjustment is capped small on purpose so bot behavior stays close to
// its original, predictable pattern regardless of whether live data exists.
function marketAwareOrderAdjustment(baseQty) {
  const trend = marketData.trendPct || 0;
  if (Math.abs(trend) < 3) return baseQty; // ignore noise
  const factor = clamp(1 - trend / 200, 0.85, 1.15); // +/-15% max nudge
  return Math.max(0, Math.round(baseQty * factor));
}

function renderMarketChart(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const series = marketData.series;
  if (!series || series.length < 2) return;

  const padding = 36;
  const prices = series.map(p => p.close);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const range = (maxP - minP) || 1;
  const chartW = W - padding * 1.5, chartH = H - padding * 1.6;

  // gridlines
  ctx.strokeStyle = 'rgba(242,232,213,0.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padding * 0.6 + (chartH / 3) * i;
    ctx.beginPath(); ctx.moveTo(padding, y); ctx.lineTo(W - 10, y); ctx.stroke();
  }

  // line path
  ctx.beginPath();
  series.forEach((p, i) => {
    const x = padding + (chartW / (series.length - 1)) * i;
    const y = padding * 0.6 + chartH - ((p.close - minP) / range) * chartH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = marketData.isLive ? '#86A86A' : '#E0A94A';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // fill under the line
  const lastX = padding + chartW;
  ctx.lineTo(lastX, padding * 0.6 + chartH);
  ctx.lineTo(padding, padding * 0.6 + chartH);
  ctx.closePath();
  ctx.fillStyle = marketData.isLive ? 'rgba(134,168,106,0.12)' : 'rgba(224,169,74,0.10)';
  ctx.fill();

  // axis labels (min/max price, first/last date)
  ctx.fillStyle = '#A8987B';
  ctx.font = '11px Calibri, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('$' + maxP.toFixed(2), 4, padding * 0.6 + 4);
  ctx.fillText('$' + minP.toFixed(2), 4, padding * 0.6 + chartH);
  ctx.textAlign = 'left';
  ctx.fillText(series[0].date, padding, H - 8);
  ctx.textAlign = 'right';
  ctx.fillText(series[series.length - 1].date, W - 10, H - 8);

  // ---- data point labels ----
  // Labeling every point on a ~30-day series would be unreadable at this
  // size, so label an evenly-spaced subset (always including the very first
  // and very last points) with small markers, and call out the most recent
  // price specifically since that's the one number people actually look for.
  const pointXY = series.map((p, i) => ({
    x: padding + (chartW / (series.length - 1)) * i,
    y: padding * 0.6 + chartH - ((p.close - minP) / range) * chartH,
    close: p.close,
  }));
  const maxLabels = 6;
  const step = Math.max(1, Math.ceil((series.length - 1) / (maxLabels - 1)));
  const labeledIndices = new Set();
  for (let i = 0; i < series.length; i += step) labeledIndices.add(i);
  labeledIndices.add(series.length - 1); // always label the most recent point

  ctx.font = '10px Calibri, sans-serif';
  labeledIndices.forEach((i) => {
    const pt = pointXY[i];
    const isLast = i === series.length - 1;
    // marker dot
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, isLast ? 3.5 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = isLast ? '#F2E8D5' : (marketData.isLive ? '#86A86A' : '#E0A94A');
    ctx.fill();
    if (isLast) { ctx.strokeStyle = '#1b1712'; ctx.lineWidth = 1.5; ctx.stroke(); }
    // value label: flip above/below the point depending on where there's room, so
    // labels near the top/bottom of the chart don't run off the canvas edge
    const labelAbove = pt.y > padding * 0.6 + 12;
    const labelY = labelAbove ? pt.y - 8 : pt.y + 14;
    ctx.textAlign = 'center';
    ctx.fillStyle = isLast ? '#F2E8D5' : '#A8987B';
    ctx.font = isLast ? 'bold 11px Calibri, sans-serif' : '10px Calibri, sans-serif';
    ctx.fillText('$' + pt.close.toFixed(2), pt.x, labelY);
  });
}




