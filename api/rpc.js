// api/rpc.js — Vercel Node.js serverless function (ESM). No npm deps.
// POST JSON-RPC (single object or batch ≤ 10) → forwarded to Helius mainnet with a method allowlist.
// Env: HELIUS_API_KEY (never logged or echoed; the upstream URL is never returned to the client).

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const ALLOWED = new Set([
  'getLatestBlockhash',
  'getBlockHeight',
  'sendTransaction',
  'simulateTransaction',
  'getSignatureStatuses',
  'getTokenAccountsByOwner',
  'getBalance',
  'getAccountInfo',
  'getMultipleAccounts',
]);
const MAX_BATCH = 10;
const UPSTREAM_TIMEOUT_MS = 25_000;
const MAX_BODY = 1024 * 1024;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return undefined; } }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function validateCall(call) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return 'each request must be a JSON-RPC object';
  if (typeof call.method !== 'string') return 'method must be a string';
  if (!ALLOWED.has(call.method)) return `method not allowed: ${call.method}`;
  if (call.params !== undefined && !Array.isArray(call.params)) return 'params must be an array';
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('access-control-allow-methods', 'POST');
    res.setHeader('access-control-allow-headers', 'content-type');
    return res.end();
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return send(res, 405, { error: 'Method not allowed' });
  }
  const key = process.env.HELIUS_API_KEY;
  if (!key) return send(res, 500, { error: 'HELIUS_API_KEY is not set' });

  const body = await readJsonBody(req);
  if (body === undefined) return send(res, 400, { error: 'Body must be JSON (≤ 1 MB)' });

  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length) return send(res, 400, { error: 'Empty batch' });
  if (calls.length > MAX_BATCH) return send(res, 400, { error: `Batch too large (max ${MAX_BATCH})` });
  for (const call of calls) {
    const problem = validateCall(call);
    if (problem) return send(res, 400, { error: problem });
  }
  const forward = calls.map((c) => ({ jsonrpc: '2.0', id: c.id ?? 1, method: c.method, params: c.params ?? [] }));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream, text;
  try {
    upstream = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Array.isArray(body) ? forward : forward[0]),
      signal: ctrl.signal,
    });
    text = await upstream.text();
  } catch (e) {
    clearTimeout(timer);
    const timedOut = e && e.name === 'AbortError';
    return send(res, 504, { error: timedOut ? 'RPC upstream timed out' : 'RPC upstream unreachable' });
  }
  clearTimeout(timer);

  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (parsed === undefined) {
    return send(res, 502, { error: `RPC upstream returned a non-JSON answer (HTTP ${upstream.status})` });
  }
  // Pass JSON-RPC answers (including JSON-RPC error objects) through with the upstream status,
  // mapped into the 200/4xx/5xx classes the client understands. Never include the upstream URL.
  const status = upstream.ok ? 200 : (upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : 502);
  return send(res, status, parsed);
}
