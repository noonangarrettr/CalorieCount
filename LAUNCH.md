# Launch guide

Three stages. Stage 1 gets it running in five minutes. Stage 2 gets it on your
phone. Stage 3 makes it remember your data.

Do them in order — each one is usable on its own.

---

## Stage 1 — Run it locally (5 minutes)

Unzip the folder, then from inside it:

```bash
python3 -m http.server 8000
```

Open **http://localhost:8000** in your browser.

You'll see a seeded demo day so the screens aren't empty. Everything works
except persistence — reloading resets it.

**Why a server instead of double-clicking `index.html`?** Opening the file
directly uses the `file://` protocol, which browsers treat as insecure. That
blocks the camera and the service worker. `localhost` counts as a secure
context, so both work there.

**Try these to confirm it's healthy:**
- Type "chicken" in Search — results should appear from USDA and Open Food Facts
- Tap a result, adjust quantity, add it to the diary
- Go to Goals, change your stats, watch the target recalculate
- Log a weight on Progress

If search returns nothing but your own foods, your network is blocking the APIs
or the key needs regenerating (see README).

---

## Stage 2 — Get it on your phone (15 minutes)

Deploy to GitHub Pages for free HTTPS. **You need HTTPS for barcode scanning** —
this is the only way to test the camera.

```bash
cd <the unzipped folder>
git init
git add .
git commit -m "Initial commit"
```

Then create the repo and push. With the GitHub CLI:

```bash
gh repo create caloriecount --public --source=. --push
```

Or manually: create an empty repo on github.com, then

```bash
git remote add origin https://github.com/noonangarrettr/caloriecount.git
git branch -M main
git push -u origin main
```

**Enable Pages:** repo → **Settings → Pages** → Source: *Deploy from a branch* →
Branch: `main`, folder `/ (root)` → **Save**.

Wait 1–2 minutes, then open **https://noonangarrettr.github.io/caloriecount/** on your
iPhone.

**Install it:** Safari → Share button → **Add to Home Screen**. It'll launch
fullscreen with no browser chrome, like a native app.

**Test the scanner:** Add → *Scan a barcode* → allow camera access → point at
any packaged food. The badge in the top corner will read **ZXing** on iOS; that's
expected, since Safari lacks the native barcode API.

### If you'd rather keep the repo private

GitHub Pages needs a paid plan for private repos. Free alternatives with HTTPS:

```bash
npx netlify-cli deploy --prod --dir .
```

Or drag the folder onto [app.netlify.com/drop](https://app.netlify.com/drop).

---

## Stage 3 — Make it remember (30 minutes)

Right now the app forgets everything on reload. Follow **FIREBASE-SETUP.md** to
wire up Firestore. Summary of what you'll do:

1. Create a Firebase project, enable Firestore and Email/Password auth
2. Add yourself as a user
3. Copy your config into `firebase-config.js`
4. Publish `firestore.rules` — **don't skip this**, the defaults either block
   everything or expose everything
5. Switch the store in `index.html` from memory to Firestore
6. Delete the `seedDemoData()` call

After this you get real persistence plus offline writes that queue and sync —
which matters when you're scanning in a grocery store with bad signal.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Camera button does nothing | Not on HTTPS. Use localhost or the deployed URL. |
| Search finds only your own foods | APIs unreachable, or key needs regenerating |
| "Add to Home Screen" missing | Must be Safari on iOS, not Chrome |
| Scanner says "unavailable" | ZXing CDN blocked — check network |
| Blank page after deploying | Wait 2 min for Pages to build; hard-refresh |
| Changes not appearing after redeploy | Bump `CACHE_VERSION` in `service-worker.js` |
| Firestore "permission denied" | Rules not published, or not signed in |
| Firestore "index required" | Click the link in the error — it creates it |

---

## Day-to-day use

- **Morning:** log weight on Progress
- **Each meal:** Add → search or scan → set quantity → add
- **After building a meal you eat often:** tap **save** on that meal section in
  the diary. Next time it's one tap.
- **Batch cooking:** create a Recipe with the yield, then log by the serving

The app gets faster the more you use it — every food you log joins a local index
that matches instantly, offline, without hitting either API.
