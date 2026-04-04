const axios = require('axios');
const puppeteer = require('puppeteer');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteerExtra.use(StealthPlugin());

const VINTED_BASE_URL = 'https://www.vinted.es';
const DEFAULT_SHIPPING = 3.5;
const GRAILED_BASE_URL = 'https://www.grailed.com';
const VESTIAIRE_BASE_URL = 'https://www.vestiairecollective.com';
const TARGET_RESULT_DEPTH = 40;
const FAST_GOTO_TIMEOUT_MS = 18000;
const FAST_WAIT_TIMEOUT_MS = 7000;
const FAST_SCROLL_STEPS = 4;
const FAST_SCROLL_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePrice(value) {
  if (typeof value !== 'string') {
    return 0;
  }

  const match = value
    .replace(/\s+/g, ' ')
    .match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})?)/);

  if (!match) {
    return 0;
  }

  const normalized = match[1].replace(/\./g, '').replace(',', '.');
  const parsed = Number.parseFloat(normalized);

  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupeAndNormalizeResults(rawResults, platform, location, shipping = 10.0) {
  const seen = new Set();
  const normalized = [];

  rawResults.forEach((result) => {
    const url = (result.url || '').trim();
    const title = (result.title || '').trim();
    const price = parsePrice(result.priceText || result.price || '');

    if (!url || !title || !price || seen.has(url)) {
      return;
    }

    seen.add(url);
    normalized.push({
      title,
      platform,
      price,
      shipping,
      url,
      location: location || 'your city',
      sellerCountry: '',
      sellerLocation: ''
    });
  });

  return normalized;
}

async function logFailedPullDebug(page, sourceName, anchorSelector) {
  if (!page) {
    return;
  }

  try {
    const finalUrl = page.url();
    const pageTitle = await page.title();
    const diagnostics = await page.evaluate((selector) => {
      const htmlSnippet = (document.documentElement?.outerHTML || '').slice(0, 5000);
      return {
        htmlSnippetLength: htmlSnippet.length,
        candidateAnchors: document.querySelectorAll(selector).length,
        ldJsonNodes: document.querySelectorAll('script[type="application/ld+json"]').length
      };
    }, anchorSelector);

    console.warn(`${sourceName} debug:`, {
      finalUrl,
      pageTitle,
      htmlSnippetLength: diagnostics.htmlSnippetLength,
      candidateAnchors: diagnostics.candidateAnchors,
      ldJsonNodes: diagnostics.ldJsonNodes
    });
  } catch (error) {
    console.warn(`${sourceName} debug capture failed:`, error.message);
  }
}

async function extractFromAnyJsonScripts(page, baseUrl, pathHints = []) {
  return page.evaluate((origin, hints, maxDepth) => {
    const found = [];
    const seen = new Set();
    const scripts = Array.from(document.querySelectorAll('script'));

    const toAbsoluteUrl = (href) => {
      if (!href || typeof href !== 'string') {
        return '';
      }
      try {
        return new URL(href, origin).toString();
      } catch (error) {
        return '';
      }
    };

    const matchesHint = (url) => {
      if (!url) return false;
      if (!hints.length) return true;
      return hints.some((hint) => url.includes(hint));
    };

    const toPriceText = (node) => {
      const rawPrice =
        node?.price ||
        node?.amount ||
        node?.value ||
        node?.current_price ||
        node?.display_price ||
        node?.converted_price ||
        node?.offers?.price ||
        node?.offers?.lowPrice ||
        node?.offers?.highPrice ||
        '';
      const currency =
        node?.currency ||
        node?.currencyCode ||
        node?.priceCurrency ||
        node?.offers?.priceCurrency ||
        '';
      return `${currency} ${rawPrice}`.trim();
    };

    const pushCandidate = (node) => {
      const rawUrl =
        node?.url ||
        node?.canonical_url ||
        node?.item_url ||
        node?.item?.url ||
        node?.listing_url ||
        '';
      const url = toAbsoluteUrl(rawUrl);
      if (!matchesHint(url)) {
        return;
      }

      const title =
        (node?.name || node?.title || node?.listing_title || node?.item?.name || '').trim();
      const priceText = toPriceText(node);

      if (!url || !title || !priceText || seen.has(url)) {
        return;
      }

      seen.add(url);
      found.push({ title, priceText, url });
    };

    const walk = (node, depth = 0) => {
      if (!node || depth > 8) {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((entry) => walk(entry, depth + 1));
        return;
      }
      if (typeof node !== 'object') {
        return;
      }

      pushCandidate(node);
      Object.values(node).forEach((value) => {
        if (value && typeof value === 'object') {
          walk(value, depth + 1);
        }
      });
    };

    scripts.forEach((script) => {
      if (found.length >= maxDepth) {
        return;
      }
      const text = (script.textContent || '').trim();
      if (!text) {
        return;
      }

      const candidateJson =
        text.startsWith('{') || text.startsWith('[')
          ? text
          : text.startsWith('window.__NEXT_DATA__=')
            ? text.replace(/^window\.__NEXT_DATA__=/, '').replace(/;$/, '')
            : text.startsWith('window.__INITIAL_STATE__=')
              ? text.replace(/^window\.__INITIAL_STATE__=/, '').replace(/;$/, '')
              : '';

      if (!candidateJson) {
        return;
      }

      try {
        const parsed = JSON.parse(candidateJson);
        walk(parsed);
      } catch (error) {
        // Ignore non-JSON or protected script contents.
      }
    });

    return found.slice(0, maxDepth);
  }, baseUrl, pathHints, TARGET_RESULT_DEPTH);
}

function collectCandidatesFromObject(node, baseUrl, pathHints, seen, found, maxDepth, depth = 0) {
  if (!node || depth > maxDepth) {
    return;
  }

  const toAbsoluteUrl = (href) => {
    if (!href || typeof href !== 'string') {
      return '';
    }
    try {
      return new URL(href, baseUrl).toString();
    } catch (error) {
      return '';
    }
  };

  const matchesHint = (url) => {
    if (!url) return false;
    if (!pathHints.length) return true;
    return pathHints.some((hint) => url.includes(hint));
  };

  const asPriceText = (item) => {
    const rawPrice =
      item?.price ||
      item?.amount ||
      item?.value ||
      item?.display_price ||
      item?.current_price ||
      item?.converted_price ||
      item?.offers?.price ||
      item?.offers?.lowPrice ||
      item?.offers?.highPrice ||
      '';
    const currency =
      item?.currency ||
      item?.currencyCode ||
      item?.priceCurrency ||
      item?.offers?.priceCurrency ||
      '';
    return `${currency} ${rawPrice}`.trim();
  };

  const pushCandidate = (item) => {
    const rawUrl =
      item?.url ||
      item?.canonical_url ||
      item?.item_url ||
      item?.listing_url ||
      item?.item?.url ||
      '';
    const url = toAbsoluteUrl(rawUrl);
    if (!matchesHint(url) || seen.has(url)) {
      return;
    }

    const title =
      (item?.name || item?.title || item?.listing_title || item?.item?.name || '').trim();
    const priceText = asPriceText(item);
    if (!url || !title || !priceText) {
      return;
    }

    seen.add(url);
    found.push({ title, priceText, url });
  };

  if (Array.isArray(node)) {
    node.forEach((entry) =>
      collectCandidatesFromObject(entry, baseUrl, pathHints, seen, found, maxDepth, depth + 1)
    );
    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  pushCandidate(node);
  Object.values(node).forEach((value) => {
    if (value && typeof value === 'object') {
      collectCandidatesFromObject(value, baseUrl, pathHints, seen, found, maxDepth, depth + 1);
    }
  });
}

function attachJsonNetworkCapture(page, baseUrl, pathHints = []) {
  const found = [];
  const seen = new Set();
  let active = true;

  const shouldInspectUrl = (url) => {
    if (!url) return false;
    const lower = url.toLowerCase();
    return (
      lower.includes('search') ||
      lower.includes('api') ||
      lower.includes('graphql') ||
      lower.includes('algolia') ||
      lower.includes('listings') ||
      lower.includes('products')
    );
  };

  const handler = async (response) => {
    if (!active || found.length >= TARGET_RESULT_DEPTH) {
      return;
    }

    try {
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) {
        return;
      }

      const responseUrl = response.url() || '';
      if (!shouldInspectUrl(responseUrl)) {
        return;
      }

      const payload = await response.json();
      collectCandidatesFromObject(payload, baseUrl, pathHints, seen, found, 8);
    } catch (error) {
      // Ignore non-JSON or unreadable responses.
    }
  };

  page.on('response', handler);

  return {
    results: () => found.slice(0, TARGET_RESULT_DEPTH),
    detach: () => {
      active = false;
      page.off('response', handler);
    }
  };
}

async function dismissConsent(page) {
  const consentLabels = [
    'Aceptar',
    'Aceptar todo',
    'Aceptar todas',
    'Permitir todas',
    'Allow all',
    'Accept all'
  ];

  try {
    const clicked = await page.evaluate((labels) => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const match = buttons.find((button) => {
        const text = button.textContent?.replace(/\s+/g, ' ').trim();
        return text && labels.includes(text);
      });

      if (!match) {
        return false;
      }

      match.click();
      return true;
    }, consentLabels);

    if (clicked) {
      await sleep(500);
    }
  } catch (error) {
    // Ignore consent banner failures.
  }
}

async function waitForResults(page, timeoutMs = FAST_WAIT_TIMEOUT_MS) {
  const selectors = [
    'a[href*="/items/"]',
    '[data-testid="grid-item"]',
    '[itemprop="url"]'
  ];

  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: timeoutMs });
      return;
    } catch (error) {
      // Try the next selector.
    }
  }
}

async function launchStealthBrowser() {
  return puppeteerExtra.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });
}

async function prepareStealthPage(page) {
  await page.setViewport({ width: 1440, height: 1600 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'accept-language': 'en-US,en;q=0.9,es;q=0.8'
  });
}

async function autoScroll(page, maxSteps = FAST_SCROLL_STEPS, delayMs = FAST_SCROLL_DELAY_MS) {
  for (let i = 0; i < maxSteps; i += 1) {
    await page.evaluate(() => {
      window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
    });
    await sleep(delayMs);
  }
}

async function scrapeVinted(item, location) {
  let browser;
  let page;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    page = await browser.newPage();

    await page.setViewport({ width: 1440, height: 1600 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'accept-language': 'es-ES,es;q=0.9,en;q=0.8'
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false
      });
    });

    const url = `${VINTED_BASE_URL}/catalog?search_text=${encodeURIComponent(item)}`;

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: FAST_GOTO_TIMEOUT_MS
    });

    await dismissConsent(page);
    await waitForResults(page);
    await autoScroll(page, 2, 200);
    await sleep(300);

    const extractVintedResults = async () =>
      page.evaluate((baseUrl, maxDepth) => {
        const euroPattern = /\d+(?:[.,]\d{2})\s*\u20ac/u;

        const toAbsoluteUrl = (href) => {
          if (!href) {
            return '';
          }

          try {
            return new URL(href, baseUrl).toString();
          } catch (error) {
            return '';
          }
        };

        const cards = Array.from(document.querySelectorAll('[data-testid="grid-item"]'));
        const links = cards.length
          ? cards
          : Array.from(document.querySelectorAll('a[href*="/items/"]'));
        const seen = new Set();
        const found = [];

        for (const node of links) {
          if (found.length >= maxDepth) {
            break;
          }

          const card =
            node.matches?.('[data-testid="grid-item"]') ? node : node.closest?.('[data-testid="grid-item"]') || node;
          const overlayLink = card.matches?.('a[href*="/items/"]')
            ? card
            : card.querySelector?.('a[href*="/items/"]') || node;
          const url = toAbsoluteUrl(overlayLink?.href || overlayLink?.getAttribute?.('href'));

          if (!url || seen.has(url)) {
            continue;
          }

          seen.add(url);

          const overlayTitle = overlayLink?.getAttribute?.('title') || '';
          const imageAlt = card.querySelector?.('img[alt]')?.getAttribute?.('alt') || '';
          const descriptionTitle =
            card.querySelector?.('[data-testid$="description-title"]')?.textContent || '';
          const cardText = card.textContent?.replace(/\s+/g, ' ').trim() || '';

          const title =
            overlayTitle.split(', marca:')[0].trim() ||
            imageAlt.split(', marca:')[0].trim() ||
            descriptionTitle.trim() ||
            card.querySelector?.('h3')?.textContent?.trim() ||
            'Vinted item';

          const priceText =
            card.querySelector?.('[data-testid$="price-text"]')?.textContent ||
            card.querySelector?.('[data-testid*="price"]')?.textContent ||
            overlayTitle.match(euroPattern)?.[0] ||
            imageAlt.match(euroPattern)?.[0] ||
            cardText.match(euroPattern)?.[0] ||
            '';

          found.push({ title, priceText, url });
        }

        return found;
      }, VINTED_BASE_URL, TARGET_RESULT_DEPTH);

    let rawResults = await extractVintedResults();

    if (!rawResults.length) {
      const retryQuery = item
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .join(' ');

      if (retryQuery && retryQuery.toLowerCase() !== item.toLowerCase()) {
        const retryUrl = `${VINTED_BASE_URL}/catalog?search_text=${encodeURIComponent(retryQuery)}`;
        await page.goto(retryUrl, {
          waitUntil: 'domcontentloaded',
          timeout: FAST_GOTO_TIMEOUT_MS
        });
        await dismissConsent(page);
        await waitForResults(page);
        await autoScroll(page, 3, 250);
        await sleep(400);
        rawResults = await extractVintedResults();
      }
    }

    if (!rawResults.length) {
      await logFailedPullDebug(page, 'Vinted', 'a[href*="/items/"], [data-testid="grid-item"]');
    }

    return rawResults
      .map((result) => ({
        title: result.title,
        platform: 'Vinted',
        price: parsePrice(result.priceText),
        shipping: DEFAULT_SHIPPING,
        url: result.url,
        location: location || 'your city',
        sellerCountry: 'Spain',
        sellerLocation: 'Spain'
      }))
      .filter((result) => result.title && result.url && result.price > 0);
  } catch (error) {
    console.error('Vinted scrape failed:', error.message);
    return [];
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function searchEbay(item, location) {
  try {
    const authResponse = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
      {
        timeout: 3000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:
            'Basic ' +
            Buffer.from(
              `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
            ).toString('base64')
        }
      }
    );

    const token = authResponse.data.access_token;

    const searchResponse = await axios.get(
      'https://api.ebay.com/buy/browse/v1/item_summary/search',
      {
        timeout: 3500,
        headers: { Authorization: `Bearer ${token}` },
        params: {
          q: item,
          limit: 50,
          filter: 'conditionIds:{2000|2500|3000}'
        }
      }
    );

    const items = searchResponse.data.itemSummaries || [];

    return items.map((itemSummary) => ({
      title: itemSummary.title,
      platform: 'eBay',
      price: parseFloat(itemSummary.price?.value) || 0,
      shipping: parseFloat(itemSummary.shippingOptions?.[0]?.shippingCost?.value) || 3.0,
      url: itemSummary.itemWebUrl,
      location: location || 'your city',
      sellerCountry: itemSummary.itemLocation?.country || '',
      sellerLocation:
        [itemSummary.itemLocation?.city, itemSummary.itemLocation?.stateOrProvince]
          .filter(Boolean)
          .join(', ') || itemSummary.itemLocation?.country || ''
    }));
  } catch (err) {
    console.error('eBay API error:', err.message);
    return [];
  }
}

async function scrapeWallapop(item, location) {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const url = `https://es.wallapop.com/app/search?keywords=${encodeURIComponent(item)}&filters_source=search_box`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: FAST_GOTO_TIMEOUT_MS });
    try {
      await page.waitForSelector('a[href*="/item/"]', { timeout: FAST_WAIT_TIMEOUT_MS });
    } catch (error) {
      // Continue with whatever loaded so far.
    }
    await autoScroll(page);
    await sleep(250);

    const results = await page.evaluate((maxDepth) => {
      const cards = Array.from(document.querySelectorAll('a[href*="/item/"]'));
      const found = [];
      const seen = new Set();

      cards.forEach((el) => {
        if (found.length >= maxDepth) return;

        const title =
          el.querySelector('h3')?.textContent?.trim() ||
          el.getAttribute('title') ||
          el.getAttribute('aria-label') ||
          el.querySelector('img[alt]')?.getAttribute('alt') ||
          '';
        const link = new URL(el.getAttribute('href') || '/', 'https://es.wallapop.com').toString();
        const price =
          el.querySelector('strong[aria-label="Item price"]')?.textContent?.trim() ||
          '';

        if (!title || !link || seen.has(link)) {
          return;
        }

        seen.add(link);
        found.push({ title, price, url: link });
      });

      return found;
    }, TARGET_RESULT_DEPTH);

    return results.map((result) => ({
      title: result.title,
      platform: 'Wallapop',
      price: parsePrice(result.price),
      shipping: 3.0,
      url: result.url,
      location: location || 'your city',
      sellerCountry: 'Spain',
      sellerLocation: 'Spain'
    })).filter((result) => result.title && result.url && result.price > 0);
  } catch (err) {
    console.error('Wallapop scrape failed:', err.message);
    return [];
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function scrapeGrailed(item, location) {
  let browser;
  let page;

  try {
    browser = await launchStealthBrowser();
    page = await browser.newPage();

    await prepareStealthPage(page);
    const jsonCapture = attachJsonNetworkCapture(page, GRAILED_BASE_URL, ['/listings/']);

    const primaryUrl = `${GRAILED_BASE_URL}/shop?query=${encodeURIComponent(item)}`;

    await page.goto(primaryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: FAST_GOTO_TIMEOUT_MS
    });

    await dismissConsent(page);

    try {
      await page.waitForSelector(
        'a[href*="/listings/"], [data-testid*="listing"], [class*="listing"]',
        { timeout: FAST_WAIT_TIMEOUT_MS }
      );
    } catch (error) {
      const fallbackUrl = `${GRAILED_BASE_URL}/shop/${encodeURIComponent(item)}`;
      await page.goto(fallbackUrl, {
        waitUntil: 'domcontentloaded',
        timeout: FAST_GOTO_TIMEOUT_MS
      });
      await dismissConsent(page);
      try {
        await page.waitForSelector('a[href*="/listings/"], [data-testid*="listing"]', {
          timeout: FAST_WAIT_TIMEOUT_MS
        });
      } catch (fallbackError) {
        // Continue with whatever loaded so far.
      }
    }

    await autoScroll(page);
    await sleep(300);

    let rawResults = await page.evaluate((baseUrl, maxDepth) => {
      const cards = Array.from(
        document.querySelectorAll(
          'a[href*="/listings/"], [data-testid*="listing"] a[href*="/listings/"], [class*="listing"] a[href*="/listings/"], article a[href*="/listings/"], li a[href*="/listings/"]'
        )
      );
      const seen = new Set();
      const found = [];

      const toAbsoluteUrl = (href) => {
        if (!href) {
          return '';
        }

        try {
          return new URL(href, baseUrl).toString();
        } catch (error) {
          return '';
        }
      };

      for (const card of cards) {
        if (found.length >= maxDepth) {
          break;
        }

        const href = card.getAttribute('href') || '';
        const listingUrl = toAbsoluteUrl(href);

        if (!listingUrl || seen.has(listingUrl)) {
          continue;
        }

        seen.add(listingUrl);

        const container =
          card.closest('article') ||
          card.closest('li') ||
          card.closest('[data-testid*="listing"]') ||
          card.parentElement ||
          card;
        const containerText = container?.textContent?.replace(/\s+/g, ' ').trim() || '';

        const title =
          container?.querySelector('[data-testid*="title"]')?.textContent?.trim() ||
          container?.querySelector('[class*="title"]')?.textContent?.trim() ||
          container?.querySelector('h3')?.textContent?.trim() ||
          container?.querySelector('h2')?.textContent?.trim() ||
          card.querySelector('h3')?.textContent?.trim() ||
          card.querySelector('h2')?.textContent?.trim() ||
          card.querySelector('[class*="title"]')?.textContent?.trim() ||
          card.querySelector('[data-testid*="title"]')?.textContent?.trim() ||
          card.querySelector('img[alt]')?.getAttribute('alt') ||
          card.getAttribute('aria-label') ||
          card.getAttribute('title') ||
          '';

        const cardText = card.textContent?.replace(/\s+/g, ' ').trim() || '';
        const priceText =
          container?.querySelector('[data-testid*="price"]')?.textContent?.trim() ||
          container?.querySelector('[class*="price"]')?.textContent?.trim() ||
          card.querySelector('[data-testid*="price"]')?.textContent?.trim() ||
          card.querySelector('[class*="price"]')?.textContent?.trim() ||
          cardText.match(/[€$£]\s?\d[\d,]*(?:\.\d{2})?/)?.[0] ||
          containerText.match(/[€$£]\s?\d[\d,]*(?:\.\d{2})?/)?.[0] ||
          cardText.match(/\d[\d,]*(?:\.\d{2})?\s?(?:USD|EUR|GBP)/i)?.[0] ||
          containerText.match(/\d[\d,]*(?:\.\d{2})?\s?(?:USD|EUR|GBP)/i)?.[0] ||
          '';

        if (!title || !priceText) {
          continue;
        }

        found.push({ title, priceText, url: listingUrl });
      }

      return found;
    }, GRAILED_BASE_URL, TARGET_RESULT_DEPTH);

    if (!rawResults.length) {
      rawResults = await page.evaluate((baseUrl, maxDepth) => {
        const found = [];
        const seen = new Set();
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));

        const toAbsoluteUrl = (href) => {
          if (!href) return '';
          try {
            return new URL(href, baseUrl).toString();
          } catch (error) {
            return '';
          }
        };

        const pushCandidate = (node) => {
          const url = toAbsoluteUrl(node?.url || node?.item?.url || '');
          const title = (node?.name || node?.item?.name || '').trim();
          const priceValue =
            node?.offers?.price || node?.offers?.lowPrice || node?.offers?.highPrice || '';
          const priceCurrency = node?.offers?.priceCurrency || '';
          const priceText = `${priceCurrency} ${priceValue}`.trim();

          if (!url || !title || !priceText || seen.has(url)) {
            return;
          }

          seen.add(url);
          found.push({ title, priceText, url });
        };

        const walk = (node) => {
          if (!node) return;
          if (Array.isArray(node)) {
            node.forEach(walk);
            return;
          }
          if (typeof node !== 'object') return;

          pushCandidate(node);
          walk(node.itemListElement);
          walk(node.item);
          walk(node.offers);
          Object.values(node).forEach((value) => {
            if (value && typeof value === 'object') {
              walk(value);
            }
          });
        };

        scripts.forEach((script) => {
          try {
            const parsed = JSON.parse(script.textContent || '');
            walk(parsed);
          } catch (error) {
            // ignore invalid JSON blobs
          }
        });

        return found.slice(0, maxDepth);
      }, GRAILED_BASE_URL, TARGET_RESULT_DEPTH);
    }

    if (!rawResults.length) {
      rawResults = await extractFromAnyJsonScripts(page, GRAILED_BASE_URL, ['/listings/']);
    }

    if (!rawResults.length) {
      rawResults = jsonCapture.results();
    }

    jsonCapture.detach();

    const normalizedResults = dedupeAndNormalizeResults(rawResults, 'Grailed', location, 12.0);

    if (!normalizedResults.length) {
      await logFailedPullDebug(
        page,
        'Grailed',
        'a[href*="/listings/"], [data-testid*="listing"] a[href*="/listings/"], article a[href*="/listings/"], li a[href*="/listings/"]'
      );
    }

    return normalizedResults;
  } catch (error) {
    console.error('Grailed scrape failed:', error.message);
    return [];
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function scrapeVestiaireCollective(item, location) {
  let browser;
  let page;

  try {
    browser = await launchStealthBrowser();
    page = await browser.newPage();

    await prepareStealthPage(page);
    const jsonCapture = attachJsonNetworkCapture(page, VESTIAIRE_BASE_URL, [
      '/products/',
      '/women-',
      '/men-'
    ]);

    const url = `${VESTIAIRE_BASE_URL}/search/?q=${encodeURIComponent(item)}`;

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: FAST_GOTO_TIMEOUT_MS
    });

    await dismissConsent(page);
    try {
      await page.waitForSelector('a[href*="/women-"], a[href*="/men-"], a[href*="/products/"]', {
        timeout: FAST_WAIT_TIMEOUT_MS
      });
    } catch (error) {
      // Continue with whatever loaded so far.
    }
    await autoScroll(page);
    await sleep(300);

    let rawResults = await page.evaluate((baseUrl, maxDepth) => {
      const cards = Array.from(
        document.querySelectorAll('a[href*="/women-"], a[href*="/men-"], a[href*="/products/"]')
      );
      const seen = new Set();
      const found = [];

      const toAbsoluteUrl = (href) => {
        if (!href) {
          return '';
        }

        try {
          return new URL(href, baseUrl).toString();
        } catch (error) {
          return '';
        }
      };

      for (const card of cards) {
        if (found.length >= maxDepth) {
          break;
        }

        const listingUrl = toAbsoluteUrl(card.getAttribute('href') || '');

        if (!listingUrl || seen.has(listingUrl)) {
          continue;
        }

        seen.add(listingUrl);

        const title =
          card.querySelector('h3')?.textContent?.trim() ||
          card.querySelector('p')?.textContent?.trim() ||
          card.getAttribute('aria-label') ||
          '';

        const text = card.textContent?.replace(/\s+/g, ' ').trim() || '';
        const priceText =
          card.querySelector('[data-testid*="price"]')?.textContent?.trim() ||
          text.match(/[€$£]\s?\d[\d.,]*/)?.[0] ||
          '';

        if (!title || !priceText) {
          continue;
        }

        found.push({ title, priceText, url: listingUrl });
      }

      return found;
    }, VESTIAIRE_BASE_URL, TARGET_RESULT_DEPTH);

    if (!rawResults.length) {
      rawResults = await page.evaluate((baseUrl, maxDepth) => {
        const found = [];
        const seen = new Set();
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));

        const toAbsoluteUrl = (href) => {
          if (!href) return '';
          try {
            return new URL(href, baseUrl).toString();
          } catch (error) {
            return '';
          }
        };

        const pushCandidate = (node) => {
          const url = toAbsoluteUrl(node?.url || node?.item?.url || '');
          const title = (node?.name || node?.item?.name || '').trim();
          const priceValue =
            node?.offers?.price || node?.offers?.lowPrice || node?.offers?.highPrice || '';
          const priceCurrency = node?.offers?.priceCurrency || '';
          const priceText = `${priceCurrency} ${priceValue}`.trim();

          if (!url || !title || !priceText || seen.has(url)) {
            return;
          }

          seen.add(url);
          found.push({ title, priceText, url });
        };

        const walk = (node) => {
          if (!node) return;
          if (Array.isArray(node)) {
            node.forEach(walk);
            return;
          }
          if (typeof node !== 'object') return;

          pushCandidate(node);
          walk(node.itemListElement);
          walk(node.item);
          walk(node.offers);
          Object.values(node).forEach((value) => {
            if (value && typeof value === 'object') {
              walk(value);
            }
          });
        };

        scripts.forEach((script) => {
          try {
            const parsed = JSON.parse(script.textContent || '');
            walk(parsed);
          } catch (error) {
            // ignore invalid JSON blobs
          }
        });

        return found.slice(0, maxDepth);
      }, VESTIAIRE_BASE_URL, TARGET_RESULT_DEPTH);
    }

    if (!rawResults.length) {
      rawResults = await extractFromAnyJsonScripts(page, VESTIAIRE_BASE_URL, [
        '/products/',
        '/women-',
        '/men-'
      ]);
    }

    if (!rawResults.length) {
      rawResults = jsonCapture.results();
    }

    jsonCapture.detach();

    const normalizedResults = dedupeAndNormalizeResults(
      rawResults,
      'Vestiaire Collective',
      location,
      11.0
    );

    if (!normalizedResults.length) {
      await logFailedPullDebug(
        page,
        'Vestiaire Collective',
        'a[href*="/women-"], a[href*="/men-"], a[href*="/products/"]'
      );
    }

    return normalizedResults;
  } catch (error) {
    console.error('Vestiaire Collective scrape failed:', error.message);
    return [];
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  scrapeVinted,
  searchEbay,
  scrapeWallapop,
  scrapeGrailed,
  scrapeVestiaireCollective
};
