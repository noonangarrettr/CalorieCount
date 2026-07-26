# Wiring up Firebase

The app currently runs on an in-memory store, so it works but forgets
everything on reload. Here's how to swap in real persistence.

## 1. Create the project

1. [Firebase console](https://console.firebase.google.com) → **Add project**
2. **Build → Firestore Database → Create database** → production mode, pick a
   region near you (`us-west1` for San Diego)
3. **Build → Authentication → Get started → Email/Password** → enable
4. **Authentication → Users → Add user** — create your own account. One user is
   all this needs; no signup flow required.

## 2. Add your config

1. **Project settings → General → Your apps → Web** (`</>` icon) → register the app
2. Copy the `firebaseConfig` values
3. `cp firebase-config.example.js firebase-config.js` and paste them in

These values aren't secrets — Firebase web config is designed to ship in the
client. Your protection is the security rules plus Authentication.

## 3. Deploy the rules

Paste `firestore.rules` into **Firestore → Rules → Publish**, or:

```bash
npm install -g firebase-tools
firebase login
firebase init firestore   # point it at firestore.rules
firebase deploy --only firestore:rules
```

**Don't skip this.** Firestore's default rules either deny everything (app
won't work) or allow everything (your data is world-readable).

## 4. Switch the app over

In `index.html`, replace the memory store with the Firestore one:

```html
<!-- change the inline <script> to a module -->
<script type="module">
  import { firestoreStore } from './store-firestore.js';
  // ... rest of the app code ...
  const store = firestoreStore;     // was: makeMemoryStore()
</script>
```

Then delete the `seedDemoData()` call in `boot()` — real data comes from the
store now.

Because the app only ever calls `store.*`, nothing else changes. That's the
whole point of the interface.

## 5. Sign-in

`store-firestore.js` exposes `store.auth.signIn(email, password)`. You'll need
a small sign-in form, or for a personal app you can call it once from the
console and let the session persist — Firebase keeps you logged in across
reloads by default.

## 6. Composite indexes

The date-range queries on `days` and `weights` may need an index the first time
they run. Firestore's error message includes a direct link that creates it —
click it, wait a minute, retry.

## Notes

- **Offline is already configured.** `persistentLocalCache` keeps an IndexedDB
  copy, so reads resolve locally and writes queue when you're offline. Logging
  food in a grocery store with bad signal will work; it syncs when you reconnect.
- **Free tier is generous** for one person: 50k reads and 20k writes per day.
  A heavy day of tracking is maybe 100 operations.
- **`addEntry(date, entry, food)` needs all three arguments.** The third is the
  normalized source food. Log entries only carry scaled macros, so without the
  food, the cache never fills and offline search silently returns nothing.
