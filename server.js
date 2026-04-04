const {
  scrapeVinted,
  searchEbay,
  scrapeWallapop,
  scrapeGrailed,
  scrapeVestiaireCollective
} = require('./scrapers');
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SOURCE_TIMEOUT_MS = 8000;
const BROWSER_SOURCE_TIMEOUT_MS = 90000;
const API_SOURCE_TIMEOUT_MS = 12000;
const BROWSER_SOURCE_CONCURRENCY = 2;
const ENABLE_EBAY = (process.env.ENABLE_EBAY || 'false').toLowerCase() === 'true';
const NON_EBAY_CACHE_TTL_MS = 2 * 60 * 1000;
const nonEbayCache = new Map();

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

const SIZE_EQUIVALENTS = {
  xs: ['xs', 'extra small', '34', '36', 'w28'],
  s: ['s', 'small', '36', '38', 'w30'],
  m: ['m', 'medium', '38', '40', 'w32'],
  l: ['l', 'large', '40', '42', 'w34'],
  xl: ['xl', 'xlarge', 'x-large', '44', '46', 'w36', 'w38'],
  xxl: ['xxl', '2xl', 'xx-large', '48', '50', 'w40']
};

const CATEGORY_RULES = [
  { match: ['jean', 'jeans', 'denim', '501', '555'], reject: ['short', 'shorts', 'skirt'] },
  { match: ['jacket', 'coat', 'windbreaker', 'puffer'], reject: ['short', 'shorts'] },
  { match: ['hoodie', 'sweatshirt'], reject: ['short', 'shorts'] }
];

const LUXURY_BRANDS = [
  'prada',
  'gucci',
  'louis vuitton',
  'lv',
  'balenciaga',
  'dior',
  'fendi',
  'celine',
  'saint laurent',
  'ysl',
  'loewe',
  'burberry',
  'chanel',
  'hermes',
  'bottega'
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

function tokenizeSize(value = '') {
  return normalizeText(value)
    .split(/\s+|\/|,|-/g)
    .filter(Boolean);
}

function buildSizeAlternatives(token, item = '') {
  const cleanToken = token.replace(/\s+/g, '');
  const alternatives = new Set([cleanToken]);
  const itemText = normalizeText(item);
  const isDenimSearch = /\b(jean|jeans|denim|levis|levi|501|505|527|550|560)\b/.test(itemText);

  if (SIZE_EQUIVALENTS[cleanToken]) {
    SIZE_EQUIVALENTS[cleanToken].forEach((entry) => alternatives.add(entry));
  }

  const waistMatch = cleanToken.match(/^w?(\d{2})$/i);
  if (waistMatch) {
    const waist = waistMatch[1];
    alternatives.add(waist);
    alternatives.add(`w${waist}`);
    alternatives.add(`${waist}x30`);
    alternatives.add(`${waist}x32`);
    alternatives.add(`${waist}x34`);

    if (isDenimSearch) {
      const waistNum = Number.parseInt(waist, 10);
      if (Number.isFinite(waistNum)) {
        const eu = waistNum + 8;
        alternatives.add(String(eu));
      }
    }
  }

  const euNumberMatch = cleanToken.match(/^\d{2}$/);
  if (euNumberMatch) {
    const eu = Number.parseInt(cleanToken, 10);
    if (Number.isFinite(eu) && eu >= 42 && eu <= 56) {
      const waist = eu - 8;
      alternatives.add(`w${waist}`);
      alternatives.add(String(waist));
      alternatives.add(`${waist}x32`);
    }
  }

  return Array.from(alternatives);
}

function matchesSizeToken(titleText, token) {
  const direct = titleText.includes(token);
  if (direct) {
    return true;
  }

  const waistMatch = token.match(/^w?(\d{2})$/i);
  if (waistMatch) {
    const waist = waistMatch[1];
    const waistPatterns = [
      new RegExp(`\\bw\\s?${waist}\\b`, 'i'),
      new RegExp(`\\b${waist}w\\b`, 'i'),
      new RegExp(`\\bwaist\\s?${waist}\\b`, 'i'),
      new RegExp(`\\b${waist}x\\d{2}\\b`, 'i'),
      new RegExp(`\\b\\d{2}x${waist}\\b`, 'i'),
      new RegExp(`\\b${waist}\\b`, 'i')
    ];

    return waistPatterns.some((pattern) => pattern.test(titleText));
  }

  const pairMatch = token.match(/^(\d{2})x(\d{2})$/i);
  if (pairMatch) {
    return new RegExp(`\\b${pairMatch[1]}x${pairMatch[2]}\\b`, 'i').test(titleText);
  }

  return false;
}

function matchesSizeFilter(title, sizeQuery, itemQuery = '') {
  const sizeTokens = tokenizeSize(sizeQuery);

  if (sizeTokens.length === 0) {
    return true;
  }

  const titleText = normalizeText(title);
  return sizeTokens.every((token) => {
    const alternatives = buildSizeAlternatives(token, itemQuery);
    return alternatives.some((candidate) => matchesSizeToken(titleText, candidate));
  });
}

function detectSizeMappingUsed(sizeQuery, itemQuery = '') {
  const sizeTokens = tokenizeSize(sizeQuery);
  if (sizeTokens.length === 0) {
    return false;
  }

  return sizeTokens.some((token) => buildSizeAlternatives(token, itemQuery).length > 1);
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
    .map((result) => scoreResult(result, profile));

  if (!options.relaxedMatching) {
    filtered = filtered.filter((result) => result.shouldKeep);
  }

  if (platform !== 'all') {
    filtered = filtered.filter((result) => normalizeText(result.platform) === normalizeText(platform));
  }

  if (Number.isFinite(maxPrice)) {
    filtered = filtered.filter((result) => result.total <= maxPrice);
  }

  if (size) {
    filtered = filtered.filter((result) => matchesSizeFilter(result.title, size, options.item));
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

function getNonEbayCacheKey(item = '', location = '') {
  return `${normalizeText(item)}::${normalizeText(location)}`;
}

function getCachedNonEbayResults(item = '', location = '') {
  const key = getNonEbayCacheKey(item, location);
  const entry = nonEbayCache.get(key);

  if (!entry) {
    return [];
  }

  if (Date.now() - entry.timestamp > NON_EBAY_CACHE_TTL_MS) {
    nonEbayCache.delete(key);
    return [];
  }

  return entry.results || [];
}

function setCachedNonEbayResults(item = '', location = '', results = []) {
  const key = getNonEbayCacheKey(item, location);
  nonEbayCache.set(key, {
    timestamp: Date.now(),
    results
  });
}

function buildMetaFromSourceState(sourceState) {
  return {
    sources: {
      vinted: sourceState.vintedResults.length,
      ebay: sourceState.ebayResults.length,
      wallapop: sourceState.wallapopResults.length,
      grailed: sourceState.grailedResults.length,
      vestiaireCollective: sourceState.vestiaireResults.length
    },
    timeouts: { ...sourceState.timeouts },
    skipped: { ...sourceState.skipped }
  };
}

function isSourceRequested(platformValue = 'all', sourceKey = '') {
  const normalizedPlatform = normalizeText(platformValue || 'all');
  if (!normalizedPlatform || normalizedPlatform === 'all') {
    return true;
  }

  const aliases = {
    vinted: ['vinted'],
    ebay: ['ebay', 'e bay'],
    wallapop: ['wallapop'],
    grailed: ['grailed'],
    vestiaireCollective: ['vestiaire collective', 'vestiairecollective', 'vestiaire']
  };

  return (aliases[sourceKey] || []).some((alias) => alias === normalizedPlatform);
}

function createEmptySource(skipped = false) {
  return { results: [], timedOut: false, skipped };
}

function buildSearchResponse(options, sourceState, config = {}) {
  const { allowFallback = true, allowCache = true } = config;
  const sizeMappingUsed = detectSizeMappingUsed(options.size, options.item);
  const singlePlatformMode = normalizeText(options.platform || 'all') !== 'all';

  const liveNonEbayResults = [
    ...sourceState.vintedResults,
    ...sourceState.wallapopResults,
    ...sourceState.grailedResults,
    ...sourceState.vestiaireResults
  ];

  let cacheUsed = false;
  let nonEbayResults = liveNonEbayResults;

  if (allowCache && !singlePlatformMode) {
    if (nonEbayResults.length > 0) {
      setCachedNonEbayResults(options.item, options.location, nonEbayResults);
    } else {
      const cached = getCachedNonEbayResults(options.item, options.location);
      if (cached.length > 0) {
        nonEbayResults = cached;
        cacheUsed = true;
      }
    }
  }

  const liveResults = [...nonEbayResults, ...sourceState.ebayResults];

  let filtered = applyFilters(liveResults, options);
  const hasTimeouts = Object.values(sourceState.timeouts || {}).some(Boolean);
  let relaxedFallbackUsed = false;

  if (allowFallback && filtered.results.length === 0 && hasTimeouts && liveResults.length > 0) {
    relaxedFallbackUsed = true;
    filtered = applyFilters(liveResults, {
      ...options,
      relaxedMatching: true
    });
  }

  if (allowFallback && filtered.results.length === 0 && options.size && liveResults.length > 0) {
    relaxedFallbackUsed = true;
    filtered = applyFilters(liveResults, {
      ...options,
      size: '',
      relaxedMatching: true
    });
  }

  return {
    results: filtered.results,
    meta: {
      item: options.item,
      totalFound: filtered.results.length,
      destination: filtered.destination,
      sources: {
        vinted: sourceState.vintedResults.length,
        ebay: sourceState.ebayResults.length,
        wallapop: sourceState.wallapopResults.length,
        grailed: sourceState.grailedResults.length,
        vestiaireCollective: sourceState.vestiaireResults.length
      },
      timeouts: sourceState.timeouts,
      relaxedFallbackUsed,
      sizeMappingUsed,
      luxuryRescueUsed: Boolean(sourceState.luxuryRescueUsed),
      cacheUsed,
      skipped: sourceState.skipped
    }
  };
}

function isLuxuryQuery(item = '') {
  const normalized = normalizeText(item);
  return LUXURY_BRANDS.some((brand) => normalized.includes(normalizeText(brand)));
}

function buildVestiaireRetryQuery(item = '') {
  const normalized = normalizeText(item);
  const luxury = LUXURY_BRANDS.find((brand) => normalized.includes(normalizeText(brand)));

  if (!luxury) {
    return item;
  }

  const categoryToken =
    extractTokens(item).find((token) =>
      ['jacket', 'coat', 'bag', 'shirt', 'jeans', 'pants', 'shoes', 'sneakers'].includes(token)
    ) || 'jacket';

  return `${luxury} ${categoryToken}`.trim();
}

function buildGeneralRetryQuery(item = '') {
  const tokens = extractTokens(item).slice(0, 2);
  if (!tokens.length) {
    return item;
  }
  return tokens.join(' ');
}

function buildGrailedRetryQuery(item = '') {
  const normalized = normalizeText(item);
  const luxury = LUXURY_BRANDS.find((brand) => normalized.includes(normalizeText(brand)));
  if (!luxury) {
    return item;
  }

  const categoryToken =
    extractTokens(item).find((token) =>
      ['jacket', 'coat', 'hoodie', 'bag', 'shirt', 'pants', 'jeans', 'sneakers'].includes(token)
    ) || 'jacket';

  return `${luxury} ${categoryToken}`.trim();
}

async function searchVestiaireWithLuxuryRetry(item, location) {
  const first = await scrapeVestiaireCollective(item, location);

  if (!isLuxuryQuery(item) || first.length > 0) {
    return first;
  }

  const retryQuery = buildVestiaireRetryQuery(item);
  if (normalizeText(retryQuery) === normalizeText(item)) {
    return first;
  }

  const retry = await scrapeVestiaireCollective(retryQuery, location);
  if (!retry.length) {
    return first;
  }

  const seen = new Set(first.map((result) => result.url));
  const merged = [...first];

  retry.forEach((result) => {
    if (!seen.has(result.url)) {
      seen.add(result.url);
      merged.push(result);
    }
  });

  return merged;
}

async function mergeUniqueByUrl(...groups) {
  const merged = [];
  const seen = new Set();

  groups.flat().forEach((result) => {
    if (!result || !result.url || seen.has(result.url)) {
      return;
    }

    seen.add(result.url);
    merged.push(result);
  });

  return merged;
}

async function scrapeWithQueryFallback(sourceName, scraperFn, item, location) {
  const first = await scraperFn(item, location);
  if (first.length > 0) {
    return first;
  }

  const retryQuery = buildGeneralRetryQuery(item);
  if (!retryQuery || normalizeText(retryQuery) === normalizeText(item)) {
    return first;
  }

  const retry = await scraperFn(retryQuery, location);
  if (!retry.length) {
    return first;
  }

  console.warn(`${sourceName} fallback query used: "${retryQuery}"`);
  return mergeUniqueByUrl(first, retry);
}

function buildFocusedRetryQueries(item = '') {
  const queries = [];
  const normalized = normalizeText(item);
  const luxury = LUXURY_BRANDS.find((brand) => normalized.includes(normalizeText(brand))) || '';
  const compact = buildGeneralRetryQuery(item);
  const category =
    extractTokens(item).find((token) =>
      ['jacket', 'coat', 'bag', 'hoodie', 'shirt', 'pants', 'jeans', 'shoes', 'sneakers'].includes(token)
    ) || 'jacket';

  queries.push(item);
  if (compact) {
    queries.push(compact);
  }
  if (luxury) {
    queries.push(luxury);
    queries.push(`${luxury} ${category}`);
    queries.push(`${luxury} vintage ${category}`);
  }

  const unique = [];
  const seen = new Set();
  queries.forEach((query) => {
    const key = normalizeText(query);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    unique.push(query);
  });

  return unique.slice(0, 5);
}

async function scrapeWithFocusedFallbacks(sourceName, scraperFn, item, location) {
  const queries = buildFocusedRetryQueries(item);
  let merged = [];

  for (const query of queries) {
    const results = await scraperFn(query, location);
    merged = await mergeUniqueByUrl(merged, results);

    if (results.length > 0 && normalizeText(query) !== normalizeText(item)) {
      console.warn(`${sourceName} focused fallback query used: "${query}"`);
    }

    if (merged.length >= 8) {
      break;
    }
  }

  return merged;
}

async function withSourceTimeout(sourceName, task, timeoutMs = SOURCE_TIMEOUT_MS) {
  let timer;

  try {
    const result = await Promise.race([
      task,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn(`${sourceName} timed out after ${timeoutMs}ms. Skipping source.`);
          resolve({ results: [], timedOut: true });
        }, timeoutMs);
      })
    ]);

    if (timer) {
      clearTimeout(timer);
    }

    if (Array.isArray(result)) {
      return { results: result, timedOut: false };
    }

    if (result && Array.isArray(result.results)) {
      return result;
    }

    return { results: [], timedOut: false };
  } catch (error) {
    if (timer) {
      clearTimeout(timer);
    }

    console.error(`${sourceName} failed:`, error.message);
    return { results: [], timedOut: false };
  }
}

async function runLimited(taskFactories, limit = 2) {
  const results = new Array(taskFactories.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= taskFactories.length) {
        return;
      }

      results[index] = await taskFactories[index]();
    }
  }

  const workerCount = Math.max(1, Math.min(limit, taskFactories.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
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
    const singlePlatformMode = normalizeText(platform || 'all') !== 'all';
    const runVinted = isSourceRequested(platform, 'vinted');
    const runEbay = isSourceRequested(platform, 'ebay') && ENABLE_EBAY;
    const runWallapop = isSourceRequested(platform, 'wallapop');
    const runGrailed = isSourceRequested(platform, 'grailed');
    const runVestiaire = isSourceRequested(platform, 'vestiaireCollective');

    const browserTaskFactories = [];
    if (runVinted) {
      browserTaskFactories.push(async () => ({
        key: 'vinted',
        result: await withSourceTimeout(
          'Vinted',
          scrapeWithQueryFallback('Vinted', scrapeVinted, item, location),
          BROWSER_SOURCE_TIMEOUT_MS
        )
      }));
    }
    if (runWallapop) {
      browserTaskFactories.push(async () => ({
        key: 'wallapop',
        result: await withSourceTimeout(
          'Wallapop',
          scrapeWithQueryFallback('Wallapop', scrapeWallapop, item, location),
          BROWSER_SOURCE_TIMEOUT_MS
        )
      }));
    }
    if (runGrailed) {
      browserTaskFactories.push(async () => ({
        key: 'grailed',
        result: await withSourceTimeout(
          'Grailed',
          singlePlatformMode
            ? scrapeWithFocusedFallbacks('Grailed', scrapeGrailed, item, location)
            : scrapeWithQueryFallback('Grailed', scrapeGrailed, item, location),
          BROWSER_SOURCE_TIMEOUT_MS
        )
      }));
    }
    if (runVestiaire) {
      browserTaskFactories.push(async () => ({
        key: 'vestiaireCollective',
        result: await withSourceTimeout(
          'Vestiaire Collective',
          singlePlatformMode
            ? scrapeWithFocusedFallbacks(
                'Vestiaire Collective',
                searchVestiaireWithLuxuryRetry,
                item,
                location
              )
            : scrapeWithQueryFallback(
                'Vestiaire Collective',
                searchVestiaireWithLuxuryRetry,
                item,
                location
              ),
          BROWSER_SOURCE_TIMEOUT_MS
        )
      }));
    }

    const browserTaskResults = browserTaskFactories.length
      ? await runLimited(browserTaskFactories, BROWSER_SOURCE_CONCURRENCY)
      : [];

    const sourceLookup = {
      vinted: createEmptySource(!runVinted),
      ebay: createEmptySource(!runEbay),
      wallapop: createEmptySource(!runWallapop),
      grailed: createEmptySource(!runGrailed),
      vestiaireCollective: createEmptySource(!runVestiaire)
    };

    browserTaskResults.forEach((entry) => {
      sourceLookup[entry.key] = entry.result;
    });

    if (runEbay) {
      sourceLookup.ebay = await withSourceTimeout('eBay', searchEbay(item, location), API_SOURCE_TIMEOUT_MS);
    }

    let sourceState = {
      vintedResults: sourceLookup.vinted.results,
      ebayResults: sourceLookup.ebay.results,
      wallapopResults: sourceLookup.wallapop.results,
      grailedResults: sourceLookup.grailed.results,
      vestiaireResults: sourceLookup.vestiaireCollective.results,
      timeouts: {
      vinted: sourceLookup.vinted.timedOut,
      ebay: sourceLookup.ebay.timedOut,
      wallapop: sourceLookup.wallapop.timedOut,
      grailed: sourceLookup.grailed.timedOut,
      vestiaireCollective: sourceLookup.vestiaireCollective.timedOut
      },
      skipped: {
        ebay: Boolean(sourceLookup.ebay.skipped)
      },
      luxuryRescueUsed: false
    };

    const nonEbayCount =
      sourceState.vintedResults.length +
      sourceState.wallapopResults.length +
      sourceState.grailedResults.length +
      sourceState.vestiaireResults.length;

    if (runGrailed && runVestiaire && isLuxuryQuery(item) && nonEbayCount === 0) {
      sourceState.luxuryRescueUsed = true;

      const [grailedRescue, vestiaireRescue] = await Promise.all([
        withSourceTimeout(
          'Grailed Rescue',
          scrapeGrailed(buildGrailedRetryQuery(item), location),
          28000
        ),
        withSourceTimeout(
          'Vestiaire Rescue',
          scrapeVestiaireCollective(buildVestiaireRetryQuery(item), location),
          28000
        )
      ]);

      sourceState.grailedResults = await mergeUniqueByUrl(
        sourceState.grailedResults,
        grailedRescue.results
      );
      sourceState.vestiaireResults = await mergeUniqueByUrl(
        sourceState.vestiaireResults,
        vestiaireRescue.results
      );

      sourceState.timeouts.grailed = Boolean(
        sourceState.timeouts.grailed && sourceState.grailedResults.length === 0
      );
      sourceState.timeouts.vestiaireCollective = Boolean(
        sourceState.timeouts.vestiaireCollective && sourceState.vestiaireResults.length === 0
      );
    }

    const response = buildSearchResponse(
      { item, location, platform, maxPrice, size, condition, excludeWords, sort },
      sourceState,
      { allowFallback: true, allowCache: true }
    );

    res.json(response);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ results: [], error: 'Search failed.' });
  }
});

app.get('/search/stream', async (req, res) => {
  const { item, location, platform, maxPrice, size, condition, excludeWords, sort } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const sendEvent = (event, payload) => {
    if (closed) {
      return;
    }
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  if (!item) {
    sendEvent('done', { results: [], meta: { item: '', totalFound: 0 } });
    return res.end();
  }

  const options = { item, location, platform, maxPrice, size, condition, excludeWords, sort };
  const singlePlatformMode = normalizeText(platform || 'all') !== 'all';
  const sourceState = {
    vintedResults: [],
    ebayResults: [],
    wallapopResults: [],
    grailedResults: [],
    vestiaireResults: [],
    timeouts: {
      vinted: false,
      ebay: false,
      wallapop: false,
      grailed: false,
      vestiaireCollective: false
    },
    skipped: {
      ebay: false
    },
    luxuryRescueUsed: false
  };

  sendEvent('start', {
    message: 'Streaming results from marketplaces...'
  });

  const runVinted = isSourceRequested(platform, 'vinted');
  const runEbay = isSourceRequested(platform, 'ebay') && ENABLE_EBAY;
  const runWallapop = isSourceRequested(platform, 'wallapop');
  const runGrailed = isSourceRequested(platform, 'grailed');
  const runVestiaire = isSourceRequested(platform, 'vestiaireCollective');

  sourceState.skipped.ebay = !runEbay;

  const pushSourceUpdate = (key, label, sourceResult) => {
    const targetMap = {
      vinted: 'vintedResults',
      ebay: 'ebayResults',
      wallapop: 'wallapopResults',
      grailed: 'grailedResults',
      vestiaireCollective: 'vestiaireResults'
    };
    const targetKey = targetMap[key];
    if (!targetKey) {
      return;
    }
    sourceState[targetKey] = sourceResult.results || [];
    sourceState.timeouts[key] = Boolean(sourceResult.timedOut);
    if (key === 'ebay') {
      sourceState.skipped.ebay = Boolean(sourceResult.skipped);
    }

    const partialResponse = buildSearchResponse(options, sourceState, {
      allowFallback: false,
      allowCache: false
    });

    sendEvent('source_results', {
      source: key,
      label,
      added: sourceState[targetKey].length,
      ...partialResponse
    });

    if (sourceResult.timedOut) {
      sendEvent('source_timeout', { source: key, label });
    }
  };

  try {
    let ebayPromise = Promise.resolve(createEmptySource(true));
    if (runEbay) {
      ebayPromise = withSourceTimeout('eBay', searchEbay(item, location), API_SOURCE_TIMEOUT_MS);
      ebayPromise.then((ebaySource) => {
        pushSourceUpdate('ebay', 'eBay', ebaySource);
      });
    }

    const browserTasks = [
      ...(runVinted
        ? [
            async () => {
              const result = await withSourceTimeout(
                'Vinted',
                scrapeWithQueryFallback('Vinted', scrapeVinted, item, location),
                BROWSER_SOURCE_TIMEOUT_MS
              );
              pushSourceUpdate('vinted', 'Vinted', result);
            }
          ]
        : []),
      ...(runWallapop
        ? [
            async () => {
              const result = await withSourceTimeout(
                'Wallapop',
                scrapeWithQueryFallback('Wallapop', scrapeWallapop, item, location),
                BROWSER_SOURCE_TIMEOUT_MS
              );
              pushSourceUpdate('wallapop', 'Wallapop', result);
            }
          ]
        : []),
      ...(runGrailed
        ? [
            async () => {
              const result = await withSourceTimeout(
                'Grailed',
                singlePlatformMode
                  ? scrapeWithFocusedFallbacks('Grailed', scrapeGrailed, item, location)
                  : scrapeWithQueryFallback('Grailed', scrapeGrailed, item, location),
                BROWSER_SOURCE_TIMEOUT_MS
              );
              pushSourceUpdate('grailed', 'Grailed', result);
            }
          ]
        : []),
      ...(runVestiaire
        ? [
            async () => {
              const result = await withSourceTimeout(
                'Vestiaire Collective',
                singlePlatformMode
                  ? scrapeWithFocusedFallbacks(
                      'Vestiaire Collective',
                      searchVestiaireWithLuxuryRetry,
                      item,
                      location
                    )
                  : scrapeWithQueryFallback(
                      'Vestiaire Collective',
                      searchVestiaireWithLuxuryRetry,
                      item,
                      location
                    ),
                BROWSER_SOURCE_TIMEOUT_MS
              );
              pushSourceUpdate('vestiaireCollective', 'Vestiaire Collective', result);
            }
          ]
        : [])
    ];

    if (browserTasks.length) {
      await runLimited(browserTasks, BROWSER_SOURCE_CONCURRENCY);
    }
    const ebaySource = await ebayPromise;
    sourceState.ebayResults = ebaySource.results || [];
    sourceState.timeouts.ebay = Boolean(ebaySource.timedOut);
    sourceState.skipped.ebay = Boolean(ebaySource.skipped);

    const nonEbayCount =
      sourceState.vintedResults.length +
      sourceState.wallapopResults.length +
      sourceState.grailedResults.length +
      sourceState.vestiaireResults.length;

    if (runGrailed && runVestiaire && isLuxuryQuery(item) && nonEbayCount === 0) {
      sourceState.luxuryRescueUsed = true;
      const [grailedRescue, vestiaireRescue] = await Promise.all([
        withSourceTimeout(
          'Grailed Rescue',
          scrapeGrailed(buildGrailedRetryQuery(item), location),
          28000
        ),
        withSourceTimeout(
          'Vestiaire Rescue',
          scrapeVestiaireCollective(buildVestiaireRetryQuery(item), location),
          28000
        )
      ]);

      sourceState.grailedResults = await mergeUniqueByUrl(
        sourceState.grailedResults,
        grailedRescue.results
      );
      sourceState.vestiaireResults = await mergeUniqueByUrl(
        sourceState.vestiaireResults,
        vestiaireRescue.results
      );

      sourceState.timeouts.grailed = Boolean(
        sourceState.timeouts.grailed && sourceState.grailedResults.length === 0
      );
      sourceState.timeouts.vestiaireCollective = Boolean(
        sourceState.timeouts.vestiaireCollective && sourceState.vestiaireResults.length === 0
      );

      const rescueSnapshot = buildSearchResponse(options, sourceState, {
        allowFallback: false,
        allowCache: false
      });
      sendEvent('source_results', {
        source: 'luxury_rescue',
        label: 'Luxury Rescue',
        added: sourceState.grailedResults.length + sourceState.vestiaireResults.length,
        ...rescueSnapshot
      });
    }

    const finalResponse = buildSearchResponse(options, sourceState, {
      allowFallback: true,
      allowCache: true
    });

    sendEvent('done', finalResponse);
    return res.end();
  } catch (error) {
    sendEvent('error', { message: error.message || 'Streaming search failed.' });
    return res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
