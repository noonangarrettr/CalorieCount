/* ============================================================
   store-firestore.js — Firestore implementation of the storage
   interface used by the app.

   Every method here mirrors one in the in-memory store, so the UI
   never needs to know which backend it's talking to.

   Setup:
     1. Create a Firebase project, enable Firestore and Authentication
        (Email/Password is enough for a single user).
     2. Copy your web app config into firebase-config.js.
     3. Deploy firestore.rules.
     4. In index.html, swap the memory store for this one.
   ============================================================ */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  doc, collection, getDoc, getDocs, setDoc, deleteDoc, runTransaction,
  query, where, orderBy, limit as qLimit, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';

/* ---------- init ---------- */

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

/**
 * Offline persistence is not optional for this app — you will absolutely
 * be logging food in a grocery store with one bar of signal. persistentLocalCache
 * keeps an IndexedDB copy so reads resolve locally and writes queue until
 * the connection returns.
 *
 * singleTabManager (rather than multi-tab) because this is a phone-first
 * PWA; multi-tab coordination costs overhead you won't use.
 */
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
});

/* ---------- paths ---------- */

let uid = null;

const userDoc = () => {
  if (!uid) throw new Error('Not signed in');
  return doc(db, 'users', uid);
};
const sub = (name, id) => id
  ? doc(db, 'users', uid, name, id)
  : collection(db, 'users', uid, name);

/* ---------- helpers ---------- */

const MACROS = ['kcal', 'protein', 'carbs', 'fat'];

const round = (v, dp = 1) => {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  const m = 10 ** dp;
  return Math.round(n * m) / m;
};

/** Recompute totals from entries. Single source of truth for the denormalized field. */
function computeTotals(entries) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const e of entries) {
    for (const k of MACROS) t[k] += Number(e[k]) || 0;
  }
  for (const k of MACROS) t[k] = round(t[k]);
  return t;
}

/** Local date key — must use local time, not UTC, or entries land on the wrong day. */
function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const emptyDay = date => ({ date, entries: [], totals: computeTotals([]) });

/* ============================================================
   Auth
   ============================================================ */

const authApi = {
  signIn: (email, password) => signInWithEmailAndPassword(auth, email, password),
  signOut: () => signOut(auth),
  /** Resolves once the initial auth state is known. */
  ready: () => new Promise(resolve => {
    const stop = onAuthStateChanged(auth, user => {
      uid = user ? user.uid : null;
      stop();
      resolve(user);
    });
  }),
  onChange: cb => onAuthStateChanged(auth, user => {
    uid = user ? user.uid : null;
    cb(user);
  }),
  get uid() { return uid; },
};

/* ============================================================
   Store
   ============================================================ */

const firestoreStore = {
  kind: 'firestore',
  auth: authApi,
  dayKey,

  /* ---- profile & goals ---- */

  async getProfile() {
    const snap = await getDoc(sub('meta', 'profile'));
    return snap.exists() ? snap.data() : null;
  },
  async setProfile(profile) {
    await setDoc(sub('meta', 'profile'), { ...profile, updatedAt: serverTimestamp() }, { merge: true });
  },
  async getGoals() {
    const snap = await getDoc(sub('meta', 'goals'));
    return snap.exists() ? snap.data() : null;
  },
  async setGoals(goals) {
    await setDoc(sub('meta', 'goals'), { ...goals, updatedAt: serverTimestamp() }, { merge: true });
  },

  /* ---- diary ---- */

  async getDay(date) {
    const snap = await getDoc(sub('days', date));
    if (!snap.exists()) return emptyDay(date);
    const data = snap.data();
    return {
      date,
      entries: data.entries || [],
      // Trust computed totals over stored ones — cheap, and self-heals if a
      // write was interrupted partway through.
      totals: computeTotals(data.entries || []),
    };
  },

  /**
   * Entries live in an array on the day doc, so add/remove is read-modify-write.
   * A transaction keeps it correct if two devices write at once — unlikely
   * with one user, but the cost is a single extra read.
   *
   * `food` is the normalized source food. It is NOT optional in practice:
   * log entries carry scaled macros, not the per-100g values that the food
   * cache and local-first search depend on. Omit it and recents will never
   * hydrate, silently disabling offline search.
   */
  async addEntry(date, entry, food = null) {
    const ref = sub('days', date);
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      const entries = snap.exists() ? (snap.data().entries || []) : [];
      entries.push(entry);
      tx.set(ref, { date, entries, totals: computeTotals(entries) });
    });
    if (food) await this.cacheFood(food);
    await this.touchRecent(food || entry);
    return entry;
  },

  async removeEntry(date, entryId) {
    const ref = sub('days', date);
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const entries = (snap.data().entries || []).filter(e => e.id !== entryId);
      tx.set(ref, { date, entries, totals: computeTotals(entries) });
    });
  },

  async updateEntry(date, entryId, patch) {
    const ref = sub('days', date);
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const entries = (snap.data().entries || [])
        .map(e => (e.id === entryId ? { ...e, ...patch } : e));
      tx.set(ref, { date, entries, totals: computeTotals(entries) });
    });
  },

  /** Range of days for the Progress charts. Reads the denormalized totals only. */
  async getDayRange(startDate, endDate) {
    const q = query(
      sub('days'),
      where('date', '>=', startDate),
      where('date', '<=', endDate),
      orderBy('date', 'asc'),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => {
      const data = d.data();
      return { date: data.date, totals: data.totals || computeTotals(data.entries || []) };
    });
  },

  /* ---- recents (drives local-first search) ---- */

  /**
   * One doc per food, tracking last use and a running count. Gives both
   * "recent" and "frequent" ordering from the same data.
   */
  async touchRecent(foodOrEntry) {
    const key = `${foodOrEntry.source}_${foodOrEntry.sourceId}`;
    const ref = sub('recents', key);
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      const useCount = snap.exists() ? (snap.data().useCount || 0) + 1 : 1;
      tx.set(ref, {
        source: foodOrEntry.source,
        sourceId: foodOrEntry.sourceId,
        name: foodOrEntry.name,
        brand: foodOrEntry.brand ?? null,
        barcode: foodOrEntry.barcode ?? null,
        useCount,
        lastUsedAt: new Date().toISOString(),
      }, { merge: true });
    });
  },

  /** Loaded once at startup to seed the local search index. */
  async getRecents(max = 100) {
    const q = query(sub('recents'), orderBy('lastUsedAt', 'desc'), qLimit(max));
    const snap = await getDocs(q);
    const recents = snap.docs.map(d => d.data());

    // Hydrate full nutrition from the food cache; drop any we can't resolve.
    const out = [];
    for (const r of recents) {
      const cached = await this.getCachedFood(`${r.source}_${r.sourceId}`);
      if (cached) out.push({ ...cached, useCount: r.useCount, local: true });
    }
    return out;
  },

  /* ---- food cache ---- */

  async cacheFood(food) {
    const key = `${food.source}_${food.sourceId}`;
    await setDoc(sub('foodCache', key), {
      ...food,
      raw: null,                       // don't store the full API payload
      cachedAt: new Date().toISOString(),
    }, { merge: true });
  },

  async getCachedFood(key) {
    const snap = await getDoc(sub('foodCache', key));
    return snap.exists() ? snap.data() : null;
  },

  /* ---- saved meals & recipes ---- */

  async listSavedMeals() {
    const snap = await getDocs(query(sub('savedMeals'), orderBy('name')));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async saveMeal(meal) {
    const id = meal.id || crypto.randomUUID();
    await setDoc(sub('savedMeals', id), {
      ...meal, id, updatedAt: new Date().toISOString(),
    }, { merge: true });
    return id;
  },
  async deleteMeal(id) { await deleteDoc(sub('savedMeals', id)); },

  async listRecipes() {
    const snap = await getDocs(query(sub('recipes'), orderBy('name')));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async saveRecipe(recipe) {
    const id = recipe.id || crypto.randomUUID();
    await setDoc(sub('recipes', id), {
      ...recipe, id, updatedAt: new Date().toISOString(),
    }, { merge: true });
    return id;
  },
  async deleteRecipe(id) { await deleteDoc(sub('recipes', id)); },

  /* ---- custom foods ---- */

  async listCustomFoods() {
    const snap = await getDocs(query(sub('customFoods'), orderBy('name')));
    return snap.docs.map(d => ({ id: d.id, ...d.data(), source: 'custom', sourceId: d.id }));
  },
  async addCustomFood(food) {
    const id = food.id || crypto.randomUUID();
    await setDoc(sub('customFoods', id), { ...food, id }, { merge: true });
    return id;
  },
  async deleteCustomFood(id) { await deleteDoc(sub('customFoods', id)); },

  /* ---- weight ---- */

  async addWeight(date, lb) {
    await setDoc(sub('weights', date), { date, lb: round(lb), loggedAt: new Date().toISOString() });
  },
  async getWeights(startDate, endDate) {
    const q = query(
      sub('weights'),
      where('date', '>=', startDate),
      where('date', '<=', endDate),
      orderBy('date', 'asc'),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data());
  },
  async deleteWeight(date) { await deleteDoc(sub('weights', date)); },
};

export { firestoreStore, computeTotals, dayKey, db, auth };
