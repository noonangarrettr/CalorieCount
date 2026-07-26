/* ============================================================
   food-api.js — unified food lookup layer
   Normalizes USDA FoodData Central + Open Food Facts into one shape.

   Normalized food object:
   {
     source:      'usda' | 'off' | 'custom',
     sourceId:    string,
     name:        string,
     brand:       string | null,
     barcode:     string | null,
     servings:    [ { label, grams } ],   // selectable serving sizes
     per100g:     { kcal, protein, carbs, fat, fiber, sugar, sodium },
     raw:         original payload (kept for debugging)
   }
   ============================================================ */

const CONFIG = {
  // api.data.gov key. This ships to the browser and is therefore public —
  // see the README on why that's acceptable here and how to change it.
  usdaKey: 'ebJFjvgnbnZOajp2RESSmNuNwJ78A9i4GazNPplk',
  usdaBase: 'https://api.nal.usda.gov/fdc/v1',
  offBase: 'https://world.openfoodfacts.org/api/v2',
};

/* ---------- USDA nutrient IDs we care about ---------- */
const USDA_NUTRIENTS = {
  1008: 'kcal',     // Energy
  1003: 'protein',
  1005: 'carbs',    // Carbohydrate, by difference
  1004: 'fat',      // Total lipid
  1079: 'fiber',
  2000: 'sugar',
  1093: 'sodium',
};

const EMPTY_NUTRITION = {
  kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0,
};

/* ============================================================
   USDA FoodData Central
   ============================================================ */

/* USDA keeps count-based portions ("1 large egg = 50 g") in `foodPortions`,
   which ONLY the /food/{id} detail endpoint returns. Search results carry
   `servingSize` for branded products and nothing at all for the generic
   Foundation / SR Legacy entries — so a food searched but never fetched in
   detail can only offer 100 g. Use getUsdaFood() to fill in the rest. */
const UNSPECIFIED = /^quantity not specified$/i;
const MAX_SERVINGS = 12;

function usdaPortionLabel(p) {
  const desc = String(p.portionDescription || '').trim();
  if (desc && !UNSPECIFIED.test(desc)) return desc;
  // SR Legacy splits the same idea across amount / measureUnit / modifier,
  // and parks "undetermined" in measureUnit when the portion is a count.
  const parts = [];
  const amount = Number(p.amount);
  if (isFinite(amount) && amount > 0) parts.push(String(round(amount, 2)));
  const unit = String(p.measureUnit?.name || '').trim();
  if (unit && unit.toLowerCase() !== 'undetermined') parts.push(unit);
  const modifier = String(p.modifier || '').trim();
  if (modifier && !UNSPECIFIED.test(modifier)) parts.push(modifier);
  return parts.join(' ').trim();
}

/* USDA's own sequenceNumber often puts a bulk measure first — the egg
   record leads with "1 cup (4.86 large eggs)". Nobody logs eggs by the cup,
   so count-based portions ("1 large") sort ahead of volume ones and become
   the default selection. */
const VOLUME_MEASURE =
  /\b(cups?|tbsps?|tablespoons?|tsps?|teaspoons?|fl oz|fluid ounces?|pints?|quarts?|gallons?|lit(?:er|re)s?|ml)\b/i;

const portionRank = label => (VOLUME_MEASURE.test(label) ? 1 : 0);

/** Build the selectable serving list. 100 g is always the last resort. */
function usdaServings(food) {
  const servings = [];
  const seen = new Set();
  const push = (label, grams) => {
    const g = round(grams);
    if (!isFinite(g) || g <= 0 || !label) return;
    const key = `${label}|${g}`;
    if (seen.has(key)) return;
    seen.add(key);
    servings.push({ label, grams: g });
  };

  // Branded products: the serving off the nutrition panel.
  if (food.servingSize && food.servingSizeUnit) {
    const grams = toGrams(food.servingSize, food.servingSizeUnit);
    if (grams) {
      push(food.householdServingFullText
        ? `${food.householdServingFullText} (${grams} g)`
        : `${food.servingSize} ${food.servingSizeUnit}`, grams);
    }
  }

  // Generic foods: counts and household measures from the detail record.
  const portions = (food.foodPortions || [])
    .map(p => ({ p, label: usdaPortionLabel(p), grams: Number(p.gramWeight) }))
    .filter(x => x.label && isFinite(x.grams) && x.grams > 0)
    .sort((a, b) =>
      portionRank(a.label) - portionRank(b.label) ||
      (a.p.sequenceNumber ?? 0) - (b.p.sequenceNumber ?? 0));
  for (const { label, grams } of portions) {
    if (servings.length >= MAX_SERVINGS) break;
    push(`${label} (${round(grams)} g)`, grams);
  }

  push('100 g', 100);
  return servings;
}

/**
 * USDA returns nutrients as an array keyed by numeric nutrient IDs,
 * and values are per 100g for most data types. Flatten to named fields.
 */
function normalizeUsdaFood(food) {
  const nutrition = { ...EMPTY_NUTRITION };

  const nutrients = food.foodNutrients || [];
  for (const n of nutrients) {
    // Search results and detail responses nest the ID differently
    const id = n.nutrientId ?? n.nutrient?.id ?? n.nutrientNumber;
    const key = USDA_NUTRIENTS[Number(id)];
    if (!key) continue;
    const value = n.value ?? n.amount ?? 0;
    nutrition[key] = round(value);
  }

  return {
    source: 'usda',
    sourceId: String(food.fdcId),
    name: titleCase(food.description || food.lowercaseDescription || 'Unknown food'),
    brand: food.brandOwner || food.brandName || null,
    barcode: food.gtinUpc || null,
    servings: usdaServings(food),
    per100g: nutrition,
    raw: food,
  };
}

/** True when a food only has the generic 100 g fallback left to offer. */
const needsServings = food =>
  food.source === 'usda' && (food.servings || []).length <= 1;

async function searchUsda(query, { limit = 20 } = {}) {
  const url = new URL(`${CONFIG.usdaBase}/foods/search`);
  url.searchParams.set('api_key', CONFIG.usdaKey);
  url.searchParams.set('query', query);
  url.searchParams.set('pageSize', limit);
  // Foundation + SR Legacy give clean generic foods; Branded covers packaged.
  url.searchParams.set('dataType', 'Foundation,SR Legacy,Branded');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`USDA search failed (${res.status})`);
  const data = await res.json();
  return (data.foods || []).map(normalizeUsdaFood);
}

/** Full detail record — the only response that carries foodPortions. */
async function getUsdaFood(fdcId) {
  // NB: no `format=abridged` — the abridged payload omits foodPortions.
  const url = new URL(`${CONFIG.usdaBase}/food/${encodeURIComponent(fdcId)}`);
  url.searchParams.set('api_key', CONFIG.usdaKey);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USDA lookup failed (${res.status})`);
  return normalizeUsdaFood(await res.json());
}

/* ============================================================
   Open Food Facts — barcode-first, crowdsourced packaged foods
   ============================================================ */

const OFF_FIELDS = [
  'code', 'product_name', 'brands', 'nutriments',
  'serving_size', 'serving_quantity', 'image_front_small_url',
].join(',');

/**
 * OFF stores nutrition per 100g under nutriments with _100g suffixes.
 * Energy comes as energy-kcal_100g (sometimes only kJ is present).
 */
function normalizeOffProduct(p) {
  const n = p.nutriments || {};

  let kcal = n['energy-kcal_100g'];
  if (kcal == null && n['energy-kj_100g'] != null) {
    kcal = n['energy-kj_100g'] / 4.184;   // kJ → kcal
  }

  const nutrition = {
    kcal: round(kcal ?? 0),
    protein: round(n.proteins_100g ?? 0),
    carbs: round(n.carbohydrates_100g ?? 0),
    fat: round(n.fat_100g ?? 0),
    fiber: round(n.fiber_100g ?? 0),
    sugar: round(n.sugars_100g ?? 0),
    // OFF reports salt in grams; sodium in mg is more useful
    sodium: round((n.sodium_100g ?? 0) * 1000),
  };

  const servings = [{ label: '100 g', grams: 100 }];
  if (p.serving_quantity) {
    const grams = Number(p.serving_quantity);
    if (grams > 0) {
      servings.unshift({
        label: p.serving_size ? `${p.serving_size}` : `1 serving (${grams} g)`,
        grams,
      });
    }
  }

  return {
    source: 'off',
    sourceId: String(p.code),
    name: titleCase(p.product_name || 'Unnamed product'),
    brand: p.brands ? p.brands.split(',')[0].trim() : null,
    barcode: String(p.code),
    servings,
    per100g: nutrition,
    image: p.image_front_small_url || null,
    raw: p,
  };
}

/** The reason OFF is in the stack: real barcode lookup. */
async function lookupBarcode(barcode) {
  const url = `${CONFIG.offBase}/product/${encodeURIComponent(barcode)}?fields=${OFF_FIELDS}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Barcode lookup failed (${res.status})`);
  const data = await res.json();
  if (data.status === 0 || !data.product) return null;
  return normalizeOffProduct(data.product);
}

async function searchOff(query, { limit = 20 } = {}) {
  const url = new URL(`${CONFIG.offBase}/search`);
  url.searchParams.set('search_terms', query);
  url.searchParams.set('fields', OFF_FIELDS);
  url.searchParams.set('page_size', limit);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OFF search failed (${res.status})`);
  const data = await res.json();
  return (data.products || [])
    .filter(p => p.product_name && p.nutriments)
    .map(normalizeOffProduct);
}

/* ============================================================
   Combined search
   Runs both sources in parallel, interleaves, dedupes by barcode.
   Neither source failing should kill the search.
   ============================================================ */

async function searchFoods(query, { limit = 25 } = {}) {
  if (!query || query.trim().length < 2) return [];

  const [usda, off] = await Promise.allSettled([
    searchUsda(query, { limit: 15 }),
    searchOff(query, { limit: 15 }),
  ]);

  const a = usda.status === 'fulfilled' ? usda.value : [];
  const b = off.status === 'fulfilled' ? off.value : [];

  const results = [];
  const seenBarcodes = new Set();

  // USDA data is lab-verified; OFF is crowdsourced. When both have the same
  // barcode, keep USDA's — otherwise interleaving lets OFF's copy land first
  // and win the dedupe by accident.
  const usdaBarcodes = new Set(a.filter(f => f.barcode).map(f => f.barcode));

  const push = (food) => {
    if (food.barcode) {
      if (seenBarcodes.has(food.barcode)) return;
      if (food.source === 'off' && usdaBarcodes.has(food.barcode)) return;
      seenBarcodes.add(food.barcode);
    }
    results.push(food);
  };

  // Interleave so neither source dominates the top of the list
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i]) push(a[i]);
    if (b[i]) push(b[i]);
  }

  if (!results.length && usda.status === 'rejected' && off.status === 'rejected') {
    throw new Error('Both food databases are unreachable.');
  }

  return results.slice(0, limit);
}

/* ============================================================
   Scaling — turn a normalized food + quantity into logged macros
   ============================================================ */

/**
 * @param food  normalized food object
 * @param grams total grams consumed
 * @returns nutrition scaled from per-100g values
 */
function scaleNutrition(food, grams) {
  const factor = grams / 100;
  const out = {};
  for (const [key, value] of Object.entries(food.per100g)) {
    out[key] = round(value * factor);
  }
  return out;
}

/** Build the immutable diary entry that gets written to days/{date}. */
function buildLogEntry(food, { meal, servingIndex = 0, quantity = 1, fromMeal = null }) {
  const serving = food.servings[servingIndex] || food.servings[0];
  const grams = serving.grams * quantity;
  const n = scaleNutrition(food, grams);

  return {
    id: crypto.randomUUID(),
    meal,
    name: food.name,
    brand: food.brand,
    source: food.source,
    sourceId: food.sourceId,
    qty: quantity,
    unit: serving.label,
    grams: round(grams),
    kcal: n.kcal,
    protein: n.protein,
    carbs: n.carbs,
    fat: n.fat,
    fromMeal,
    loggedAt: new Date().toISOString(),
  };
}

/* ---------- helpers ---------- */

function round(v, dp = 1) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  const m = 10 ** dp;
  return Math.round(n * m) / m;
}

function toGrams(value, unit) {
  const v = Number(value);
  if (!isFinite(v)) return null;
  switch (String(unit).toLowerCase()) {
    case 'g': case 'gram': case 'grams': return round(v);
    case 'mg': return round(v / 1000);
    case 'kg': return round(v * 1000);
    case 'oz': return round(v * 28.3495);
    case 'lb': return round(v * 453.592);
    // Volume units aren't mass — approximating as water density.
    // Fine for milk or broth, wrong for oil or flour. Flag in UI.
    case 'ml': case 'l': return round(unit === 'l' ? v * 1000 : v);
    default: return null;
  }
}

function titleCase(str) {
  return String(str)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

export {
  CONFIG,
  searchFoods,
  searchUsda,
  searchOff,
  lookupBarcode,
  getUsdaFood,
  scaleNutrition,
  buildLogEntry,
  normalizeUsdaFood,
  normalizeOffProduct,
  usdaServings,
  needsServings,
};
