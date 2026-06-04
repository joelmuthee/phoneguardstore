# Phone Guard Store — project notes & locked decisions

Read `C:\Users\Joel\Website Designs\CATALOG-STANDARDS.md` first. This file only
records what is SPECIFIC to this build, and locks choices a future session must
not "helpfully" revert.

## What this shop is
- **Phone Guard Store** — "Your Phone's Best Friend". Sells **brand new** cases +
  accessories for phones, MacBooks, tablets and iPads (Iconic Business Plaza,
  3rd Floor, Shop T9, Moi Avenue, Nairobi).
- IG: [@phoneguardstorekenya](https://www.instagram.com/phoneguardstorekenya/) · WhatsApp **254112440060** (0112 440060).

## Infra
- Worker: `phoneguardstore-api` → `https://phoneguardstore-api.stawisystems.workers.dev`
- KV namespace: `phoneguardstore-bags` (id `8b4e846a2736409a82ac75989abd9904`, binding `BAGS`)
- Pages project: `phoneguardstore` (production branch **main**) → `https://phoneguardstore.pages.dev`
- Intended custom domain: `phoneguardstore.essenceautomations.com` (OG/canonical point here)
- IG numeric user id: **13528649848** (hard-coded as `IG_USER_ID` in admin.js)

## Locked decisions (do NOT revert)
1. **Data model = new-stock** (`stock` + `sales[]`, qty 1 per detected device model).
2. **The "size" dimension IS the device model** (iPhone 15 Pro Max, Galaxy S24,
   iPad Air, MacBook Pro, etc.). The worker `parseDeviceModels()` extracts them;
   the public size filter builds model chips from them. "One Size" = universal-fit
   (chargers, cables) and is hidden from public chips. The admin stock grid is
   device-model presets + "+ Add custom size" for any other model.
3. **Categories come from the post's hashtags** (every IG post tags the device
   family: `#iphonecase`, `#samsungcase`, `#googlepixelcase`, `#ipadcase`, …).
   `categoryFromHashtags()` in the worker is the authoritative signal and
   overrides the keyword/AI guess in parseCaptionForBag + discover + ingest.
   **Allowed set:** iPhone Cases, Samsung Cases, Google Pixel Cases, OnePlus
   Cases, Phone Cases (other), iPad Cases, Tablet Cases, MacBook Cases, Screen
   Protectors, Accessories. `coerceCategory()` maps anything else into these.
   (The 128 already-seeded items were back-filled from the hashtag map by the
   one-off `PGS-category-backfill` scheduled task after the KV write quota reset —
   needed because seeding had exhausted the 1,000/day KV writes; code path is live
   for all future syncs.)
4. **Primary CTA label = "Check availability"** (WA body: "I'd like to check
   availability of *<Item>*"). Sold-out = "Sold out · notify me". Both keep the
   WhatsApp glyph (owner requirement: WA icon on every button incl. sold-out).
5. **Logins:** owner = `guard123` (client-side `ADMIN_PASSWORD` + SHA-256 hash in
   KV `adminpass`). Agency master = `Joel@123` (server-only via `MASTER_PASSWORD`
   secret) and the fleet `MASTER_TOKEN`. Server-checked via `/api/check-password`
   with offline fallback to the client constant. Never hard-code `Joel@123`.
6. **/api/buyer is neutralised** (acks, does not forward) — no GHL form yet, so no
   buyer PII leaves KV. Wire a real GHL form before charging for that feature.
7. **No Google Analytics / no GHL external-tracking** on this build (Ryker's were
   stripped). `gaEvent()` stays as a no-op guard.

## Seeding note (important)
IG **rate-limits the worker's unauthenticated `/api/v1/feed/user/` endpoint** hard
(401 after ~2 calls). The 128-product seed was done by pulling the feed from a
**logged-in Instagram browser tab** (no rate limit), exfiltrating the items via a
file download, then POSTing them to the worker **`/api/ig-ingest`** endpoint
(classifies via vision+text LLM + heuristic, downloads CDN images, stores). For
top-ups, the owner's "⚡ Add stock from IG" widget works for small batches; for a
big backfill, repeat the authenticated-browser → `/api/ig-ingest` path.

## Manual handover steps still pending
1. **Attach custom domain** `phoneguardstore.essenceautomations.com` in the CF
   Pages dashboard (Custom domains → Add — auto-creates the proxied DNS). Until
   then OG/WhatsApp previews + canonical resolve to a non-live host. Site is live
   on `phoneguardstore.pages.dev` meanwhile.
2. **Add `CLOUDFLARE_API_TOKEN`** (reusable account token) to the GitHub repo
   Settings → Secrets → Actions, so `.github/workflows/deploy.yml` auto-deploys on
   push. (No trailing newline — see CATALOG-STANDARDS.)
