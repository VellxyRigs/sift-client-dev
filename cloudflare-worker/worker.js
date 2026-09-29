// ============================================================================
//  Sift Client Lite - LTC auto-grant Worker
//  Verifies a Litecoin payment to the seller's wallet server-side, then hands
//  out one unused code from the pool. Codes come from the launcher's
//  /api/lite/mint (minted WITHOUT a username so any account can redeem them).
//
//  KV namespace binding: POOL
//    key  "codes"   -> JSON array of unused codes, e.g.  ["AAAA-...", "BBBB-..."]
//    key  "price"   -> {"usd":123.45, "at":...}  (auto-cached, no need to set)
//    key  "claim_<txid>" -> {code, username, ts}  (auto-written; makes grants
//                           idempotent so a duplicate claim returns the same code)
// ============================================================================

const CONFIG = {
  // The wallet buyers send LTC to (keep in sync with the site).
  LTC_ADDRESS: "LKnxoffLk7mrHrtQDxL9FKWqmUeCD8iKVA",
  TARGET_USD: 20,             // product price in USD
  ACCEPT_RATIO: 0.9,          // accept as low as 90% of the target (fees/price drift)
  WINDOW_SEC: 3600,           // only txs confirmed in the last hour are considered the payment
  PRICE_FALLBACK_USD: 250,    // used only if live price AND cached price are both unavailable
  USERNAME_RE: /^[A-Za-z0-9_]{3,16}$/
};

const API = {
  TXS: "https://litecoinspace.org/api/address/" + CONFIG.LTC_ADDRESS + "/txs",
  PRICE: "https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd"
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

async function ltcPriceUsd(env) {
  try {
    const r = await fetch(API.PRICE, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (r.ok) {
      const j = await r.json();
      if (j && j.litecoin && j.litecoin.usd > 0) {
        const rec = { usd: j.litecoin.usd, at: Date.now() };
        try { await env.POOL.put("price", JSON.stringify(rec), { expirationTtl: 600 }); } catch (e) {}
        return j.litecoin.usd;
      }
    }
  } catch (e) {}
  try {
    const c = await env.POOL.get("price");
    if (c) { const j = JSON.parse(c); if (j && j.usd > 0) return j.usd; }
  } catch (e) {}
  return CONFIG.PRICE_FALLBACK_USD;
}

function thresholdSats(priceUsd) {
  return Math.ceil(((CONFIG.TARGET_USD * CONFIG.ACCEPT_RATIO) / priceUsd) * 1e8);
}

async function fetchTxs() {
  const r = await fetch(API.TXS);
  if (!r.ok) throw new Error("chain api " + r.status);
  return r.json();
}

// Most recent confirmed tx that pays >= threshold sats to the merchant within the window.
function findPayment(txs, thr, now) {
  let best = null;
  for (const tx of txs) {
    if (!tx || !tx.status || !tx.status.confirmed) continue;
    const bt = (tx.status.block_time || 0) * 1000;
    if (now - bt > CONFIG.WINDOW_SEC * 1000) continue;
    let received = 0;
    for (const v of (tx.vout || [])) if (v.scriptpubkey_address === CONFIG.LTC_ADDRESS) received += v.value || 0;
    if (received < thr) continue;
    if (!best || bt > best.time) best = { txid: tx.txid, received, time: bt };
  }
  return best;
}

// per-IP in-memory rate limit (fine for a small merchant; Workers reset on eviction)
const rate = new Map();

async function claim(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const stamps = (rate.get(ip) || []).filter(t => now - t < 60000);
  if (stamps.length >= 6) return json({ ok: false, reason: "slow_down" }, 429);
  stamps.push(now);
  rate.set(ip, stamps);

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, reason: "bad_request" }); }
  const username = String(body.username || "").trim();
  if (!CONFIG.USERNAME_RE.test(username)) return json({ ok: false, reason: "invalid_username" });

  const usd = await ltcPriceUsd(env);
  const thr = thresholdSats(usd);

  let txs;
  try { txs = await fetchTxs(); } catch (e) { return json({ ok: false, reason: "chain_unavailable" }); }

  const pay = findPayment(txs, thr, now);
  if (!pay) return json({ ok: false, reason: "no_payment" });

  // idempotent: same tx never burns a second code
  try {
    const existing = JSON.parse((await env.POOL.get("claim_" + pay.txid)) || "null");
    if (existing) return json({ ok: true, code: existing.code, txid: pay.txid, already: true });
  } catch (e) {}

  let codes = [];
  try { codes = JSON.parse((await env.POOL.get("codes")) || "[]"); } catch (e) {}
  if (!Array.isArray(codes) || codes.length === 0) return json({ ok: false, reason: "sold_out" });

  const code = codes.shift();
  await env.POOL.put("codes", JSON.stringify(codes));
  await env.POOL.put("claim_" + pay.txid, JSON.stringify({ code, username, ts: now }));

  return json({ ok: true, code, txid: pay.txid, already: false, priceUSD: usd, receivedLTC: pay.received / 1e8 });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === "/price") {
      const usd = await ltcPriceUsd(env);
      return json({ ok: true, priceUSD: usd, targetSats: thresholdSats(usd) });
    }

    if (url.pathname === "/claim" && request.method === "POST") return claim(request, env);

    return json({ ok: false, reason: "not_found" }, 404);
  }
};