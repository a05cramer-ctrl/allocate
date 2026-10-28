// api/upload.js — Vercel Node.js serverless function (ESM). No npm deps.
// POST JSON { imageDataUrl, name, symbol, description, website, twitter, telegram }
//   → uploads the image, then the metadata JSON, to Filebase IPFS → 200 { uri, image }
// Env: FILEBASE_IPFS_TOKEN (never logged or echoed).

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

const FILEBASE_ADD = 'https://rpc.filebase.io/api/v0/add?cid-version=1';
const GATEWAY = 'https://ipfs.filebase.io/ipfs/';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_NAME = 32, MAX_SYMBOL = 10, MAX_DESCRIPTION = 500, MAX_URL = 200;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const UPSTREAM_TIMEOUT_MS = 25_000;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

class BadRequest extends Error { constructor(m) { super(m); this.status = 400; } }

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { throw new BadRequest('Body must be JSON'); } }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new BadRequest('Body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new BadRequest('Body must be JSON');
  try { return JSON.parse(text); } catch { throw new BadRequest('Body must be JSON'); }
}

function cleanText(v, label, max, { required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new BadRequest(`${label} must be a string`);
  // strip control chars, keep everything else (unicode names are fine)
  v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (required && !v) throw new BadRequest(`${label} is required`);
  if (v.length > max) throw new BadRequest(`${label} must be ${max} characters or fewer`);
  return v;
}

function cleanUrl(v, label) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new BadRequest(`${label} must be a string`);
  v = v.trim();
  if (!v) return '';
  if (v.length > MAX_URL) throw new BadRequest(`${label} must be ${MAX_URL} characters or fewer`);
  let u;
  try { u = new URL(v); } catch { throw new BadRequest(`${label} must be a valid http(s) URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BadRequest(`${label} must be an http(s) URL`);
  return u.toString();
}

function decodeImage(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) throw new BadRequest('imageDataUrl is required');
  const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!m) throw new BadRequest('Image must be a base64 data URL of type png, jpeg or webp');
  let mime = m[1].toLowerCase();
  if (mime === 'image/jpg') mime = 'image/jpeg';
  const ext = IMAGE_TYPES[mime];
  if (!ext) throw new BadRequest('Image must be png, jpeg or webp');
  const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!bytes.length) throw new BadRequest('Image is empty');
  if (bytes.length > MAX_IMAGE_BYTES) throw new BadRequest('Image must be 2 MB or smaller');
  // magic-number check so the declared type matches the bytes
  const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if ((mime === 'image/png' && !png) || (mime === 'image/jpeg' && !jpg) || (mime === 'image/webp' && !webp)) {
    throw new BadRequest('Image bytes do not match the declared image type');
  }
  return { bytes, mime, ext };
}

async function filebaseAdd(token, bytes, filename, contentType) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(FILEBASE_ADD, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: ctrl.signal });
    text = await res.text();
  } catch (e) {
    const err = new Error(e && e.name === 'AbortError' ? 'IPFS upload timed out' : 'IPFS upload failed (network)');
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new Error(res.status === 401 || res.status === 403 ? 'IPFS upload rejected (check FILEBASE_IPFS_TOKEN)' : `IPFS upload failed (HTTP ${res.status})`);
    err.status = 502;
    throw err;
  }
  // Filebase answers JSON {Name, Hash, Size} (possibly newline-delimited when several entries).
  let hash = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const j = JSON.parse(t); if (j && typeof j.Hash === 'string' && j.Hash) hash = j.Hash; } catch { /* ignore */ }
  }
  if (!hash) {
    const err = new Error('IPFS upload returned no CID');
    err.status = 502;
    throw err;
  }
  return hash;
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return '';
  return `${proto === 'http' ? 'https' : proto}://${host}`;
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
  const token = process.env.FILEBASE_IPFS_TOKEN;
  if (!token) return send(res, 500, { error: 'FILEBASE_IPFS_TOKEN is not set' });

  try {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') throw new BadRequest('Body must be a JSON object');
    const name = cleanText(body.name, 'name', MAX_NAME, { required: true });
    const symbol = cleanText(body.symbol, 'symbol', MAX_SYMBOL, { required: true });
    const description = cleanText(body.description, 'description', MAX_DESCRIPTION);
    const website = cleanUrl(body.website, 'website');
    const twitter = cleanUrl(body.twitter, 'twitter');
    const telegram = cleanUrl(body.telegram, 'telegram');
    const { bytes, mime, ext } = decodeImage(body.imageDataUrl);

    const imageCid = await filebaseAdd(token, bytes, `image.${ext}`, mime);
    const image = `${GATEWAY}${imageCid}`;

    const metadata = { name, symbol, description, image };
    if (website) metadata.website = website;
    if (twitter) metadata.twitter = twitter;
    if (telegram) metadata.telegram = telegram;
    const createdOn = requestOrigin(req);
    if (createdOn) metadata.createdOn = createdOn;

    const metaCid = await filebaseAdd(token, Buffer.from(JSON.stringify(metadata), 'utf8'), 'metadata.json', 'application/json');
    const uri = `${GATEWAY}${metaCid}`;
    if (uri.length > 200) return send(res, 502, { error: 'Metadata URI is too long for LaunchLab' });
    return send(res, 200, { uri, image });
  } catch (e) {
    const status = e && Number.isInteger(e.status) ? e.status : 500;
    const message = status < 500 || (e && e.status) ? (e.message || 'Upload failed') : 'Upload failed';
    return send(res, status, { error: message });
  }
}
