# Sift Lite — crypto auto-grant (Cloudflare Worker)

When a buyer pays with **LTC, native SOL, or USDC** and clicks the "Get my code"
button, the site asks this Worker to check the blockchain. If your wallet received
the ~$20 payment in the last hour, the Worker takes one unused code out of the pool
and returns it. The same payment can never claim a second code.

Everything below is free (Cloudflare free tier). Two ways to deploy: **Dashboard**
(recommended, no Node needed) or **wrangler**.

---

## 1. Mint your code pool (launcher, one-time)

Codes given away automatically must be **unbound** (redeemable by any account) so the
buyer's own account can redeem them. In a browser/PowerShell, once the launcher is
running:

```
POST http://localhost:<port>/api/lite/mint
{"count": 50, "type": "permanent"}
```

The response lists 50 plaintext codes, e.g. `BBV7-NNYA-ZJ87-BE2G-W557`.

> Bound codes (with a `username` in the request) stay single-account as before.

## 2. Deploy — Dashboard (no installs)

1. Go to **dash.cloudflare.com** → **Workers & Pages** → **Create** → **Worker**.
2. Pick a name (e.g. `sift-lite-grant`), **Deploy**, then **Edit code**.
3. Delete the starter code, paste the whole contents of `worker.js`, **Deploy**.
4. Create the KV namespace: **Workers & Pages → KV → Create a namespace**,
   name it `POOL`, copy its ID.
5. In your Worker's **Settings → Bindings → Add a KV namespace binding**:
   variable name `POOL`, namespace = the one you just made.
6. Open the KV namespace, **Add entry**:
   - key `codes`, value is a JSON array of your codes — e.g.
     `["BBV7-NNYA-ZJ87-BE2G-W557","XXXX-....","YYYY-...."]`
     and press **Save**. (Deleting the value later is how you retire unused codes.)

## 3. Deploy — wrangler (alternate)

```
npm i -g wrangler
cd cloudflare-worker
# put your namespace id in wrangler.toml
wrangler login
wrangler kv namespace create POOL
wrangler deploy
wrangler kv key put --binding=POOL codes '["BBV7-NNYA...."]'
```

## 4. Wire up the site

In `index.html` → **PAYMENT SETTINGS** → set:

```
grantService: "https://sift-lite-grant.<your-subdomain>.workers.dev"
```

(Yours will be `https://sift-lite-grant.<youraccount>.workers.dev` — shown on the
Worker page.) Commit + push; GitHub Pages picks it up. The same service powers both
the LTC and SOL/USDC auto-grant buttons.

## 5. Test

- `GET /price` → `{"ok":true,"ltc":{priceUSD,targetSats},"sol":{priceUSD,targetLamports,targetUsdc}}`.
- Send a small LTC or SOL payment to the wallet, then from the browser console:
  `fetch("https://…worker…/claim",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"TestUser1",currency:"ltc"})})`
  → confirm it returns `{"ok":true,"code":"…",...}` once the tx confirms. For SOL use
  `currency:"sol"` (native SOL or USDC both work).
- Run it again with a different username → same code back (`already:true`).
- Buyer then opens the **Sift Client** launcher, **Lite** tab, signs in with the
  account named `TestUser1`, pastes the code, and it activates.

## Notes

- The Worker verifies on-chain **server-side**; buyers can't forge claims or read the
  pool (codes live in KV, never in the page).
- Payments are recognized once they have a confirmation (LTC ≈ 2–5 min, SOL a few
  seconds). The site keeps polling for 5 minutes after the buyer clicks.
- SOL payments can be sent as **native SOL or USDC**; USDC is accepted at the exact
  USD price so tiny price swings never block a purchase.
- Refill the pool by minting more codes and appending them to the `codes` value.
- The key `claim_<cur>_<txid>` records make re-clicks return the same code instead
  of burning new ones — so "get the code every single time" holds even on retries.
- Chain data comes from `litecoinspace.org` (LTC) and public Solana RPCs.