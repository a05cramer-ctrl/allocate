// ALLOCATION — /api/payouts (Vercel Node function, ESM, no deps).
// Reads StonkFun v2 reward payouts (no CORS upstream), keeps only payouts made in one of the
// three pre-IPO share tokens, enriches each row with the paying coin's symbol, returns newest first.

const V2_PAYOUTS = 'https://www.stonkfun.xyz/api/v2/rewards/payouts';
const V1_TOKEN = 'https://www.stonkfun.xyz/api/public/v1/tokens/';

const SHARES = {
  Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8: 'SPACEX',
  PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF: 'OPENAI',
  Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw: 'ANTHROPIC'
};

const MAX_PAGES = 3;
const MAX_ROWS = 60;
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_LOOKUPS = 8;
const UPSTREAM_TIMEOUT_MS = 6000;

// Module-level cache: launchMint -> symbol (string) | null (looked up, not listed yet).
const symbolCache = new Map();
const symbolCachedAt = new Map();
const NULL_TTL_MS = 60 * 1000; // re-check unlisted coins after a minute

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function readPayouts() {
  const out = [];
  let cursor = null;
  const cutoff = Date.now() - MAX_AGE_MS;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = V2_PAYOUTS + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const { ok, status, body } = await fetchJson(url);
    if (!ok || !body || !Array.isArray(body.rows)) {
      if (page === 0) throw new Error('upstream payouts ' + status);
      break;
    }
    let sawOld = false;
    for (const r of body.rows) {
      const share = SHARES[r.assetMint];
      const t = Date.parse(r.createdAt);
      if (Number.isFinite(t) && t < cutoff) sawOld = true;
      if (!share) continue;
      const amount = Number(r.amountTokens);
      if (!Number.isFinite(amount)) continue;
      out.push({
        signature: r.signature,
        coinMint: r.launchMint,
        coinSymbol: null,
        holder: r.holder,
        assetMint: r.assetMint,
        share,
        amount,
        createdAt: r.createdAt
      });
    }
    cursor = body.page && body.page.nextCursor;
    if (sawOld || !cursor || out.length >= MAX_ROWS) break;
  }
  return out;
}

async function lookupSymbol(mint) {
  try {
    const { ok, body } = await fetchJson(V1_TOKEN + encodeURIComponent(mint));
    const sym = ok && body && body.data && body.data.token && body.data.token.symbol;
    return typeof sym === 'string' && sym ? sym : null;
  } catch {
    return null;
  }
}

async function enrich(rows) {
  const now = Date.now();
  const pending = [];
  for (const row of rows) {
    const m = row.coinMint;
    if (!m) continue;
    if (symbolCache.has(m)) {
      const v = symbolCache.get(m);
      const fresh = v !== null || now - (symbolCachedAt.get(m) || 0) < NULL_TTL_MS;
      if (fresh) continue;
    }
    if (!pending.includes(m)) pending.push(m);
  }
  const batch = pending.slice(0, MAX_LOOKUPS);
  await Promise.all(batch.map(async (m) => {
    const sym = await lookupSymbol(m);
    symbolCache.set(m, sym);
    symbolCachedAt.set(m, Date.now());
  }));
  for (const row of rows) {
    const v = row.coinMint ? symbolCache.get(row.coinMint) : undefined;
    row.coinSymbol = v == null ? null : v;
  }
  if (symbolCache.size > 5000) {
    // keep the cache bounded on long-lived instances
    for (const k of Array.from(symbolCache.keys()).slice(0, 2500)) {
      symbolCache.delete(k);
      symbolCachedAt.delete(k);
    }
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  try {
    let rows = await readPayouts();
    rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    rows = rows.slice(0, MAX_ROWS);
    await enrich(rows);
    res.setHeader('Cache-Control', 's-maxage=4, stale-while-revalidate=10');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({ rows, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'StonkFun payouts unavailable: ' + (err && err.message ? err.message : String(err)) });
  }
}
