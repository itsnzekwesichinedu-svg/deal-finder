const axios = require('axios');
const puppeteer = require('puppeteer');

const VINTED_BASE_URL = 'https://www.vinted.es';
const DEFAULT_SHIPPING = 3.5;

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

async function waitForResults(page) {
  const selectors = [
    'a[href*="/items/"]',
    '[data-testid="grid-item"]',
    '[itemprop="url"]'
  ];

  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 8000 });
      return;
    } catch (error) {
      // Try the next selector.
    }
  }
}

async function scrapeVinted(item, location) {
  let browser;

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

    const page = await browser.newPage();

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
      timeout: 45000
    });

    await dismissConsent(page);
    await waitForResults(page);
    await sleep(1500);

    const rawResults = await page.evaluate((baseUrl) => {
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
      const seen = new Set();
      const found = [];

      for (const card of cards) {
        if (found.length >= 12) {
          break;
        }

        const overlayLink = card.querySelector('a[href*="/items/"]');
        const url = toAbsoluteUrl(overlayLink?.href);

        if (!url || seen.has(url)) {
          continue;
        }

        seen.add(url);

        const overlayTitle = overlayLink?.getAttribute('title') || '';
        const imageAlt = card.querySelector('img[alt]')?.getAttribute('alt') || '';
        const descriptionTitle =
          card.querySelector('[data-testid$="description-title"]')?.textContent || '';
        const cardText = card.textContent?.replace(/\s+/g, ' ').trim() || '';

        const title =
          overlayTitle.split(', marca:')[0].trim() ||
          imageAlt.split(', marca:')[0].trim() ||
          descriptionTitle.trim() ||
          'Vinted item';

        const priceText =
          card.querySelector('[data-testid$="price-text"]')?.textContent ||
          card.querySelector('[data-testid*="price"]')?.textContent ||
          overlayTitle.match(euroPattern)?.[0] ||
          imageAlt.match(euroPattern)?.[0] ||
          cardText.match(euroPattern)?.[0] ||
          '';

        found.push({ title, priceText, url });
      }

      return found;
    }, VINTED_BASE_URL);

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
        headers: { Authorization: `Bearer ${token}` },
        params: {
          q: item,
          limit: 8,
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

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('a[href*="/item/"]', { timeout: 10000 });

    const results = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('a[href*="/item/"]'));
      const found = [];
      const seen = new Set();

      cards.forEach((el) => {
        if (found.length >= 8) return;

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
    });

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

module.exports = { scrapeVinted, searchEbay, scrapeWallapop };
