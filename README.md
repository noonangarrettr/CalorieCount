# CalorieCount — a personal calorie & macro tracker

A MyFitnessPal replacement. Mobile-first PWA, no subscription, no paywalled
features, your data in your own Firebase project.

## What works

- **Diary** — calories and macros against your targets, four meal sections,
  per-entry delete, day-to-day navigation
- **Search** — USDA FoodData Central + Open Food Facts, with your own foods
  matched instantly and offline
- **Barcode scanning** — camera-based, native API on Android, ZXing on iOS
- **Saved meals** — capture a logged meal as a reusable combo in one tap
- **Recipes** — enter ingredients once, set a yield, log by the serving
- **Custom foods** — for anything not in either database
- **Goals** — TDEE-based targets (Mifflin-St Jeor) with manual override
- **Progress** — weight trend, calories vs goal, rolling macro averages
- **Installable** — add to home screen, works offline

## Running it

Needs to be served over HTTP(S) — `file://` blocks the camera and service
worker. For local development:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

`localhost` counts as a secure context, so camera and PWA features work there.

For your phone, deploy to GitHub Pages (free HTTPS):

```bash
git init && git add . && git commit -m "Initial commit"
gh repo create caloriecount --public --source=. --push
# then: repo Settings → Pages → deploy from main branch
```

## Setup

1. **USDA API key** — already wired into `index.html` and `food-api.js`.
   Free replacements at [api.data.gov/signup](https://api.data.gov/signup/).

   Note that this key ships to the browser and is readable by anyone who
   views source on the deployed site. That's unavoidable for a client-side
   app and generally fine: a data.gov key is a rate-limit identifier, not an
   access credential. The only real consequence of exposure is someone else
   consuming your 1,000 requests/hour. If that ever happens, generate a new
   key and replace it. To keep it genuinely private you'd need to proxy
   requests through a Cloud Function, which is more infrastructure than a
   personal tracker warrants.
2. **Firebase** — see `FIREBASE-SETUP.md`. Until then the app runs on an
   in-memory store and forgets everything on reload.

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole app — UI, search pipeline, scanner, in-memory store |
| `food-api.js` | Standalone module version of the USDA/OFF normalizing layer |
| `store-firestore.js` | Firestore implementation of the storage interface |
| `firebase-config.example.js` | Copy to `firebase-config.js`, add your keys |
| `firestore.rules` | Security rules — deploy these |
| `manifest.json` | PWA manifest |
| `service-worker.js` | Offline app-shell caching |

## Notes for future changes

- **The store is an interface.** The UI only calls `store.*`, so swapping
  memory for Firestore (or anything else) touches one line.
- **`addEntry(date, entry, food)` needs the third argument.** Entries carry
  scaled macros; the food carries per-100g values. Without the food, the
  cache never fills and offline search silently returns nothing.
- **`dayKey()` is local-time.** UTC would file evening entries under tomorrow.
- **Diary entries are snapshots; meal templates are live references.** What you
  ate on a given day should never change retroactively.
- **Volume-to-gram conversion assumes water density.** Fine for milk or broth,
  wrong for oil (~0.92) or flour (~0.53). See `toGrams()`.
- **Bump `CACHE_VERSION`** in `service-worker.js` when you change shell files,
  or returning users keep the stale copy.
