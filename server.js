const { scrapeVinted, searchEbay, scrapeWallapop } = require('./scrapers');
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const STOP_WORDS = new Set([
  'for',
  'the',
  'and',
  'with',
  'mens',
  'womens',
  'men',
  'women',
  'de',
  'la',
  'el',
  'y',
  'con'
]);

const QUERY_SYNONYMS = new Map([
  ['levis', 'levis'],
  ['levi', 'levis'],
  ['501s', '501'],
  ['tee', 't-shirt'],
  ['jkt', 'jacket']
]);

const CATEGORY_RULES = [
  { match: ['jean', 'jeans', 'denim', '501', '555'], reject: ['short', 'shorts', 'skirt'] },
  { match: ['jacket', 'coat', 'windbreaker', 'puffer'], reject: ['short', 'shorts'] },
  { match: ['hoodie', 'sweatshirt'], reject: ['short', 'shorts'] }
];

const COUNTRY_ALIASES = new Map([
  ['spain', 'Spain'],
  ['españa', 'Spain'],
  ['espana', 'Spain'],
  ['madrid', 'Spain'],
  ['barcelona', 'Spain'],
  ['valencia', 'Spain'],
  ['seville', 'Spain'],
  ['sevilla', 'Spain'],
  ['malaga', 'Spain'],
  ['uk', 'United Kingdom'],
  ['u k', 'United Kingdom'],
  ['united kingdom', 'United Kingdom'],
  ['england', 'United Kingdom'],
  ['london', 'United Kingdom'],
  ['manchester', 'United Kingdom'],
  ['birmingham', 'United Kingdom'],
  ['france', 'France'],
  ['paris', 'France'],
  ['lyon', 'France'],
  ['italy', 'Italy'],
  ['italia', 'Italy'],
  ['rome', 'Italy'],
  ['milan', 'Italy'],
  ['germany', 'Germany'],
  ['berlin', 'Germany'],
  ['munich', 'Germany'],
  ['deutschland', 'Germany'],
  ['netherlands', 'Netherlands'],
  ['amsterdam', 'Netherlands'],
  ['belgium', 'Belgium'],
  ['brussels', 'Belgium'],
  ['portugal', 'Portugal'],
  ['lisbon', 'Portugal'],
  ['australia', 'Australia'],
  ['sydney', 'Australia'],
  ['melbourne', 'Australia'],
  ['usa', 'United States'],
  ['us', 'United States'],
  ['united states', 'United States'],
  ['new york', 'United States'],
  ['california', 'United States']
]);

const EUROPEAN_COUNTRIES = new Set([
  'Spain',
  'United Kingdom',
  'France',
  'Italy',
  'Germany',
  'Netherlands',
  'Belgium',
  'Portugal'
]);

function normalizeText(value = '') {
  return value
    .toLowerCase()
    .replace(/[`']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeToken(token) {
  return QUERY_SYNONYMS.get(token) || token;
}

function extractTokens(value) {
  return normalizeText(value)
    .split(' ')
    .map(normalizeToken)
    .filter((token) => token && !STOP_WORDS.has(token));
}

function parseNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundCurrency(value) {
  return Number.parseFloat((value || 0).toFixed(2));
}

function buildSearchProfile(item, excludeWords) {
  const tokens = extractTokens(item);
  const requiredTokens = tokens.filter((token) => /\d/.test(token) || /^[wmxl]{1,4}\d{0,2}$/i.test(token));
  const excludedTokens = extractTokens(excludeWords);

  return { tokens, requiredTokens, excludedTokens };
}

function matchesCategoryRule(queryTokens, titleText) {
  return CATEGORY_RULES.every((rule) => {
    const wantsCategory = rule.match.some((token) => queryTokens.includes(token));

    if (!wantsCategory) {
      return true;
    }

    return !rule.reject.some((token) => titleText.includes(token));
  });
}

function resolveCountry(value = '') {
  const normalized = normalizeText(value);

  if (!normalized) {
    return '';
  }

  return COUNTRY_ALIASES.get(normalized) || '';
}

function parseDestination(location = '') {
  const country = resolveCountry(location);
  return {
    input: location || '',
    country,
    known: Boolean(country)
  };
}

function estimateShipping(result, destination) {
  const sellerCountry = resolveCountry(result.sellerCountry || result.sellerLocation || result.platform);
  const baseShipping = parseNumber(result.shipping, 3);
  const buyerCountry = destination.country;

  if (!buyerCountry) {
    return {
      shipping: roundCurrency(baseShipping),
      sellerCountry: sellerCountry || 'Unknown',
      shippingRoute: 'estimated',
      shippingNote: 'destination not recognized, using base shipping'
    };
  }

  if (!sellerCountry) {
    return {
      shipping: roundCurrency(baseShipping + 2.5),
      sellerCountry: 'Unknown',
      shippingRoute: 'estimated',
      shippingNote: `seller country unknown, estimated to ${destination.input}`
    };
  }

  if (sellerCountry === buyerCountry) {
    return {
      shipping: roundCurrency(Math.min(baseShipping, 4.5)),
      sellerCountry,
      shippingRoute: 'domestic',
      shippingNote: `domestic estimate to ${destination.input}`
    };
  }

  if (EUROPEAN_COUNTRIES.has(sellerCountry) && EUROPEAN_COUNTRIES.has(buyerCountry)) {
    return {
      shipping: roundCurrency(Math.max(baseShipping, 7.5)),
      sellerCountry,
      shippingRoute: 'europe',
      shippingNote: `European cross-border estimate to ${destination.input}`
    };
  }

  return {
    shipping: roundCurrency(Math.max(baseShipping, 14.5)),
    sellerCountry,
    shippingRoute: 'international',
    shippingNote: `international estimate to ${destination.input}`
  };
}

function enrichResult(result, destination) {
  const shippingInfo = estimateShipping(result, destination);
  const price = roundCurrency(result.price);
  const shipping = shippingInfo.shipping;

  return {
    ...result,
    price,
    shipping,
    total: roundCurrency(price + shipping),
    buyerLocation: destination.input || result.location || 'your city',
    sellerCountry: shippingInfo.sellerCountry,
    shippingRoute: shippingInfo.shippingRoute,
    shippingNote: shippingInfo.shippingNote
  };
}

function scoreResult(result, profile) {
  const haystack = normalizeText(`${result.title} ${result.platform}`);
  const matchedTokens = profile.tokens.filter((token) => haystack.includes(token));
  const missingRequired = profile.requiredTokens.some((token) => !haystack.includes(token));
  const hasExcluded = profile.excludedTokens.some((token) => haystack.includes(token));
  const categoryMismatch = !matchesCategoryRule(profile.tokens, haystack);
  const shouldKeep =
    !missingRequired &&
    !hasExcluded &&
    !categoryMismatch &&
    (profile.tokens.length === 0 || matchedTokens.length >= Math.min(2, profile.tokens.length));

  return {
    ...result,
    matchedTerms: matchedTokens.length,
    shouldKeep
  };
}

function applyFilters(results, options) {
  const platform = options.platform || 'all';
  const maxPrice = parseNumber(options.maxPrice, Number.POSITIVE_INFINITY);
  const size = normalizeText(options.size || '');
  const profile = buildSearchProfile(options.item, options.excludeWords);
  const condition = normalizeText(options.condition || 'all');
  const destination = parseDestination(options.location || '');

  let filtered = results
    .map((result) => enrichResult(result, destination))
    .map((result) => scoreResult(result, profile))
    .filter((result) => result.shouldKeep);

  if (platform !== 'all') {
    filtered = filtered.filter((result) => normalizeText(result.platform) === normalizeText(platform));
  }

  if (Number.isFinite(maxPrice)) {
    filtered = filtered.filter((result) => result.total <= maxPrice);
  }

  if (size) {
    filtered = filtered.filter((result) => normalizeText(result.title).includes(size));
  }

  if (condition && condition !== 'all') {
    filtered = filtered.filter((result) => normalizeText(result.title).includes(condition));
  }

  const sort = options.sort || 'lowest-total';

  if (sort === 'price-only') {
    filtered.sort((a, b) => a.price - b.price || a.total - b.total);
  } else if (sort === 'best-match') {
    filtered.sort((a, b) => b.matchedTerms - a.matchedTerms || a.total - b.total);
  } else {
    filtered.sort((a, b) => a.total - b.total);
  }

  return {
    destination,
    results: filtered.map(({ shouldKeep, matchedTerms, ...result }) => result)
  };
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/health', (req, res) => {
  res.json({ ok: true, port: PORT });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/search', async (req, res) => {
  const { item, location, platform, maxPrice, size, condition, excludeWords, sort } = req.query;

  if (!item) {
    return res.json({ results: [], meta: { item: '', totalFound: 0 } });
  }

  try {
    const [vintedResults, ebayResults, wallapopResults] = await Promise.all([
      scrapeVinted(item, location),
      searchEbay(item, location),
      scrapeWallapop(item, location)
    ]);

    const liveResults = [...vintedResults, ...ebayResults, ...wallapopResults];
    const filtered = applyFilters(liveResults, {
      item,
      location,
      platform,
      maxPrice,
      size,
      condition,
      excludeWords,
      sort
    });

    res.json({
      results: filtered.results,
      meta: {
        item,
        totalFound: filtered.results.length,
        destination: filtered.destination,
        sources: {
          vinted: vintedResults.length,
          ebay: ebayResults.length,
          wallapop: wallapopResults.length
        }
      }
    });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ results: [], error: 'Search failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
