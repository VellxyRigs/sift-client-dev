// ============================================================================
//  Sift Client Lite - crypto auto-grant Worker (LTC + SOL + USDC)
//
//  Verifies a crypto payment (Litecoin, native SOL, or USDC) to the seller's
//  wallet server-side, then hands out one unused code from the pool. Codes come
//  from the launcher's /api/lite/mint (minted WITHOUT a username so any signed-in
//  account can redeem them).
//
//  KV namespace binding: POOL
//    key  "codes"   -> JSON array of unused codes, e.g.  ["AAAA-...", "BBBB-..."]
//    key  "price"   -> {"at":..., "ltc":..., "sol":...}  (auto-cached, optional)
//    key  "claim_<cur>_<txid>" -> {code, username, ts}   (auto-written; makes
//                                 grants idempotent,  duplicate claims return the
//                                 same code instead of burning a new one)
//
//  Endpoints:
//    GET  /price                       -> current prices + per-currency thresholds
//    POST /claim {username, currency}  -> currency: "ltc" | "sol" (default "ltc")
// ============================================================================

const CONFIG = {
  TARGET_USD: 20,             // product price in USD
  ACCEPT_RATIO: 0.9,          // accept as low as 90% of the target (fees/price drift)
  WINDOW_SEC: 3600,           // only transactions confirmed in the last hour count as the payment
  PRICE_FALLBACK_USD_LTC: 250,
  PRICE_FALLBACK_USD_SOL: 250,
  USERNAME_RE: /^[A-Za-z0-9_]{3,16}$/,

  LTC: {
    name: "ltc",
    address: "LKnxoffLk7mrHrtQDxL9FKWqmUeCD8iKVA",     // Litecoin receiving wallet
    priceId: "litecoin",
    priceFallback: 250,
    txsUrl: "https://litecoinspace.org/api/address/LKnxoffLk7mrHrtQDxL9FKWqmUeCD8iKVA/txs"
  },

  SOL: {
    name: "sol",
    address: "5itMqG3gNTFYbxXDM7X2Y4q6U7WZijPAb98SayuJzSw6", // Solana receiving wallet
    priceId: "solana",
    priceFallback: 250,
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    rpcs: [
      "https://api.mainnet-beta.solana.com",
      "https://solana-rpc.publicnode.com",
      "https://api.rpcpool.com"
    ]
  },

  PAYPAL: {
    name: "paypal",
    tokenUrl: "https://api-m.paypal.com/v1/oauth2/token",
    ordersUrl: "https://api-m.paypal.com/v2/checkout/orders/"
  }
};

const COINGECKO = "https://api.coingecko.com/api/v3/simple/price?ids=" +
  CONFIG.LTC.priceId + "," + CONFIG.SOL.priceId + "&vs_currencies=usd";

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

// ---------------------------------------------------------------- price
async function prices(env) {
  let ltc = 0, sol = 0;
  try {
    const r = await fetch(COINGECKO, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (r.ok) {
      const j = await r.json();
      ltc = (j && j[CONFIG.LTC.priceId] && j[CONFIG.LTC.priceId].usd) || 0;
      sol = (j && j[CONFIG.SOL.priceId] && j[CONFIG.SOL.priceId].usd) || 0;
      if (ltc > 0 && sol > 0) {
        try { await env.POOL.put("price", JSON.stringify({ at: Date.now(), ltc, sol }), { expirationTtl: 600 }); } catch (e) {}
        return { ltc, sol };
      }
    }
  } catch (e) {}
  try {
    const c = await env.POOL.get("price");
    if (c) { const p = JSON.parse(c); if (p && p.ltc > 0 && p.sol > 0) return { ltc: p.ltc, sol: p.sol }; }
  } catch (e) {}
  return { ltc: CONFIG.LTC.priceFallback, sol: CONFIG.SOL.priceFallback };
}

// LTC threshold in satoshis (1 LTC = 1e8 sat), SOL/USDC threshold in lamports or USD-units (1e9 lamports, USDC 1e6)
function threshold(cur, priceUsd) {
  const per1e = CONFIG.TARGET_USD * CONFIG.ACCEPT_RATIO / priceUsd;
  return cur === "ltc" ? Math.ceil(per1e * 1e8) : Math.ceil(per1e * 1e9);
}

// ---------------------------------------------------------------- LTC
async function ltcTxs() {
  const r = await fetch(CONFIG.LTC.txsUrl);
  if (!r.ok) throw new Error("ltc api " + r.status);
  return r.json();
}

function findLtcPayment(txs, thr, now) {
  let best = null;
  for (const tx of txs) {
    if (!tx || !tx.status || !tx.status.confirmed) continue;
    const bt = (tx.status.block_time || 0) * 1000;
    if (now - bt > CONFIG.WINDOW_SEC * 1000) continue;
    let received = 0;
    for (const v of (tx.vout || [])) if (v.scriptpubkey_address === CONFIG.LTC.address) received += v.value || 0;
    if (received < thr) continue;
    if (!best || bt > best.time) best = { txid: tx.txid, received, time: bt };
  }
  return best;
}

// ---------------------------------------------------------------- SOL
async function solRpc(method, params) {
  let lastErr = null;
  for (const url of CONFIG.SOL.rpcs) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.error) { lastErr = new Error(String(j.error.message || j.error.code)); continue; }
      if (j && j.result !== undefined) return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("sol rpc unavailable");
}

async function solRecent() {
  return solRpc("getSignaturesForAddress", [
    CONFIG.SOL.address,
    { limit: 25, commitment: "finalized" }
  ]);
}

async function solTx(sig) {
  return solRpc("getTransaction", [
    sig,
    { maxSupportedTransactionVersion: 0, commitment: "finalized" }
  ]);
}

function solNativeDelta(tx) {
  const keys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
  const pre = (tx.meta && tx.meta.preBalances) || [];
  const post = (tx.meta && tx.meta.postBalances) || [];
  let delta = 0;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].pubkey === CONFIG.SOL.address && i < post.length && i < pre.length) delta += post[i] - pre[i];
  }
  return delta; // lamports; negative = merchant spent
}

function solUsdcIn(tx) {
  let inTokens = 0;
  const pre = new Map();
  const post = new Map();
  for (const tb of (tx.meta && tx.meta.preTokenBalances) || []) {
    if (tb.owner === CONFIG.SOL.address && tb.mint === CONFIG.SOL.usdcMint)
      pre.set(tb.accountIndex, tb.uiTokenAmount ? tb.uiTokenAmount.uiAmount || 0 : 0);
  }
  for (const tb of (tx.meta && tx.meta.postTokenBalances) || []) {
    if (tb.owner === CONFIG.SOL.address && tb.mint === CONFIG.SOL.usdcMint)
      post.set(tb.accountIndex, tb.uiTokenAmount ? tb.uiTokenAmount.uiAmount || 0 : 0);
  }
  for (const [idx, v] of post) {
    const inBefore = pre.get(idx) || 0;
    const d = v - inBefore;
    if (d > 0) inTokens += d;
  }
  return inTokens; // USDC units (6 decimals already normalized by uiAmount)
}

async function scanSolPayments(now, nativeThr, usdcThr) {
  const sigs = await solRecent();
  let best = null;
  for (const s of sigs) {
    if (!s || s.err) continue;
    const bt = s.blockTime ? s.blockTime * 1000 : 0;
    if (!bt || now - bt > CONFIG.WINDOW_SEC * 1000) continue;
    let tx = null;
    try { tx = await solTx(s.signature); } catch (e) { continue; }
    if (!tx || !tx.meta) continue;
    const native = solNativeDelta(tx);
    const usdcIn = solUsdcIn(tx);
    let received = 0;
    let ok = false;
    if (native >= nativeThr) { received = native; ok = true; }
    else if (usdcIn >= usdcThr) { received = usdcIn; ok = true; }
    if (!ok) continue;
    if (!best || bt > best.time) best = { txid: s.signature, received, kind: native >= nativeThr ? "sol" : "usdc", time: bt };
  }
  return best;
}

// ---------------------------------------------------------------- PayPal
async function paypalToken(env) {
  try {
    const cached = await env.POOL.get("paypal_token");
    if (cached) return cached;
  } catch (e) {}
  const auth = btoa(String(env.PAYPAL_CLIENT_ID || "") + ":" + String(env.PAYPAL_CLIENT_SECRET || ""));
  const r = await fetch(CONFIG.PAYPAL.tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + auth,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!r.ok) throw new Error("paypal auth " + r.status);
  const j = await r.json();
  if (!j.access_token) throw new Error("paypal auth no token");
  try { await env.POOL.put("paypal_token", j.access_token, { expirationTtl: 32400 }); } catch (e) {}
  return j.access_token;
}

// Confirms an order is captured on PayPal for >= the target in USD.
async function paypalOrder(orderId, env) {
  const token = await paypalToken(env);
  const r = await fetch(CONFIG.PAYPAL.ordersUrl + encodeURIComponent(orderId), {
    headers: { "Authorization": "Bearer " + token }
  });
  if (!r.ok) throw new Error("paypal order " + r.status);
  const o = await r.json();
  const pu = (o && o.purchase_units) || [];
  const cap = pu[0] && pu[0].payments && pu[0].payments.captures && pu[0].payments.captures[0];
  if (o && o.status === "COMPLETED" && cap && cap.status === "COMPLETED" && cap.amount &&
      cap.amount.currency_code === "USD" && parseFloat(cap.amount.value) >= CONFIG.TARGET_USD) {
    return { txid: orderId, received: parseFloat(cap.amount.value), kind: "paypal", time: Date.now() };
  }
  return null;
}

// ---------------------------------------------------------------- claim
const rate = new Map(); // ip -> timestamps

async function claim(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const stamps = (rate.get(ip) || []).filter(t => now - t < 60000);
  if (stamps.length >= 30) return json({ ok: false, reason: "slow_down" }, 429);
  stamps.push(now);
  rate.set(ip, stamps);

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, reason: "bad_request" }); }
  const username = String(body.username || "").trim();
  if (!CONFIG.USERNAME_RE.test(username)) return json({ ok: false, reason: "invalid_username" });
  const currency = body.currency === "sol" ? "sol" : body.currency === "paypal" ? "paypal" : "ltc";

  let pay = null;
  let priceUsd = 0;
  if (currency === "paypal") {
    const orderId = String(body.orderId || "").trim();
    if (!orderId) return json({ ok: false, reason: "bad_request" });
    try { pay = await paypalOrder(orderId, env); }
    catch (e) { return json({ ok: false, reason: "chain_unavailable" }); }
  } else {
    const px = await prices(env);
    priceUsd = currency === "ltc" ? px.ltc : px.sol;
    const thr = currency === "ltc" ? threshold("ltc", px.ltc) : threshold("sol", px.sol);
    const usdcThr = currency === "sol" ? CONFIG.TARGET_USD * CONFIG.ACCEPT_RATIO : 0;
    try {
      if (currency === "ltc") pay = findLtcPayment(await ltcTxs(), thr, now);
      else pay = await scanSolPayments(now, thr, usdcThr);
    } catch (e) {
      return json({ ok: false, reason: "chain_unavailable" });
    }
  }
  if (!pay) return json({ ok: false, reason: "no_payment" });

  const claimKey = "claim_" + currency + "_" + pay.txid;
  try {
    const existing = JSON.parse((await env.POOL.get(claimKey)) || "null");
    if (existing) return json({ ok: true, code: existing.code, txid: pay.txid, currency, already: true });
  } catch (e) {}

  let codes = [];
  try { codes = JSON.parse((await env.POOL.get("codes")) || "[]"); } catch (e) {}
  if (!Array.isArray(codes) || codes.length === 0) return json({ ok: false, reason: "sold_out" });

  const code = codes.shift();
  await env.POOL.put("codes", JSON.stringify(codes));
  await env.POOL.put(claimKey, JSON.stringify({ code, username, ts: now }));

  return json({
    ok: true, code, txid: pay.txid, currency,
    already: false,
    priceUSD: priceUsd,
    received: pay.received,
    kind: pay.kind || currency
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === "/price") {
      const px = await prices(env);
      return json({
        ok: true,
        ltc: { priceUSD: px.ltc, targetSats: threshold("ltc", px.ltc) },
        sol: { priceUSD: px.sol, targetLamports: threshold("sol", px.sol), targetUsdc: CONFIG.TARGET_USD * CONFIG.ACCEPT_RATIO }
      });
    }

    if (url.pathname === "/claim" && request.method === "POST") return claim(request, env);

    return json({ ok: false, reason: "not_found" }, 404);
  }
};