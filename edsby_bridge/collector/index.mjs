/**
 * Edsby Bridge collector.
 *
 * One Chromium, one persistent profile, on a virtual screen the add-on shows
 * inside Home Assistant. You sign in to Edsby there once, the way you would on
 * a laptop, and the session lives in the profile from then on.
 *
 * It does not click through Edsby's pages or read their HTML. Edsby's web app
 * is a shell that fetches its content as JSON, and this records those
 * responses as the app receives them — the class feeds, posts, assignments and
 * calendars it loads for you. That survives visual redesigns, which is what
 * breaks scrapers, and it needs no knowledge of Edsby's internals up front:
 * what matters is learned from the captures.
 *
 * What it never keeps:
 *  - anything you send. Request bodies are not read at all, so what you type
 *    into the sign-in form never passes through this code.
 *  - responses from sign-in, session or token endpoints.
 *  - values under keys that name a secret (password, token, ticket, session,
 *    cookie, csrf…), wherever they appear in a body.
 *  - query parameters that carry one.
 *  - cookies and headers.
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { SKIP_PATH, cleanUrl, desktopUserAgent, isSignedInState, looksLikeJson, redactBody } from './redact.mjs';

/** The engine's real version, for the browser identity Edsby is shown. */
const CHROMIUM_VERSION = await fs
  .readFile(new URL('./node_modules/playwright-core/browsers.json', import.meta.url), 'utf8')
  .then((text) => JSON.parse(text).browsers.find((b) => b.name === 'chromium')?.browserVersion)
  .catch(() => undefined);

const OPTIONS_FILE = process.env.OPTIONS_FILE ?? '/data/options.json';
const PROFILE_DIR = process.env.PROFILE_DIR ?? '/data/profile';
const HEADLESS = process.env.HEADLESS === '1';
const VERSION = '0.1.0';

const options = JSON.parse(await fs.readFile(OPTIONS_FILE, 'utf8'));
const HOST = String(options.edsby_host || '')
  .replace(/^https?:\/\//, '')
  .replace(/\/.*$/, '')
  .trim();
const RELAY = String(options.relay_url || '').replace(/\/+$/, '');
const SECRET = String(options.relay_secret || '').trim();
const INTERVAL_MS = Math.max(30, Number(options.interval_minutes) || 180) * 60_000;

/** Longest single response kept; longer ones keep their beginning and say so. */
const MAX_BODY = 400_000;
/** Most sent in one push. The relay refuses anything over five megabytes. */
const MAX_TOTAL = 3_500_000;
/** How long after the last new response to wait before pushing. */
const SETTLE_MS = 20_000;

const log = (...args) => console.log(`[edsby-bridge ${new Date().toISOString()}]`, ...args);

if (!HOST) {
  log('No Edsby address set. Add it in the add-on Configuration tab.');
  process.exit(1);
}
if (!SECRET) log('No relay secret set yet: captures are kept here but not sent anywhere.');

// ---------------------------------------------------------------------------
// Capturing
// ---------------------------------------------------------------------------

/** Latest response per request, by method and cleaned address. */
const captured = new Map();
let settleTimer = null;

async function record(response) {
  // Nothing before sign-in. The login page loads Edsby data too, and some of
  // it is the sign-in challenge; there is nothing of the student's to keep
  // until they are in.
  if (!signedIn) return;
  try {
    const url = new URL(response.url());
    if (url.hostname !== HOST) return;
    if (SKIP_PATH.test(url.pathname)) return;
    const request = response.request();
    const kind = request.resourceType();
    if (kind !== 'xhr' && kind !== 'fetch') return;
    const contentType = response.headers()['content-type'] ?? '';
    const text = await response.text().catch(() => null);
    if (!text || !looksLikeJson(contentType, text)) return;

    const clean = redactBody(text);
    const key = `${request.method()} ${cleanUrl(response.url())}`;
    captured.delete(key); // re-insert so the newest sits last
    captured.set(key, {
      method: request.method(),
      url: cleanUrl(response.url()),
      status: response.status(),
      at: Date.now(),
      bytes: clean.length,
      truncated: clean.length > MAX_BODY,
      body: clean.length > MAX_BODY ? clean.slice(0, MAX_BODY) : clean,
    });
    trim();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => void push('activity'), SETTLE_MS);
  } catch {
    // A response that vanished mid-read is not worth a crash.
  }
}

function trim() {
  let total = 0;
  for (const entry of captured.values()) total += entry.bytes;
  for (const key of captured.keys()) {
    if (total <= MAX_TOTAL) break;
    total -= captured.get(key).bytes;
    captured.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Signed in or not
// ---------------------------------------------------------------------------

let signedIn = false;

async function readSignedIn(page) {
  try {
    const title = await page.title();
    const hasPasswordField = await page.evaluate(() =>
      [...document.querySelectorAll('input[type=password]')].some((el) => el.offsetParent !== null)
    );
    return isSignedInState({ url: page.url(), title, hasPasswordField }, HOST);
  } catch {
    return false; // mid-navigation: say not yet, and look again shortly
  }
}

/** Re-read the state; on arriving signed in, go and fetch everything fresh. */
async function updateSignedIn(reason) {
  const main = context.pages()[0];
  const now = main ? await readSignedIn(main) : false;
  if (now === signedIn) return now;
  signedIn = now;
  if (now) {
    log(`signed in (${reason}); taking a first look in 10 seconds`);
    setTimeout(() => void refresh(), 10_000);
  } else {
    captured.clear();
    log(`not signed in (${reason}) — open the Edsby panel in Home Assistant and sign in`);
  }
  return now;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------


async function push(reason) {
  const page = context.pages()[0];
  const responses = signedIn ? [...captured.values()].reverse() : [];
  const payload = {
    version: 1,
    addon: VERSION,
    host: HOST,
    reason,
    capturedAt: Date.now(),
    signedIn,
    page: page ? { url: page.url().startsWith('http') ? cleanUrl(page.url()) : '', title: await page.title().catch(() => '') } : null,
    responseCount: responses.length,
    responses,
  };
  const bytes = JSON.stringify(payload).length;
  if (!SECRET || !RELAY) {
    log(`holding ${responses.length} responses (${Math.round(bytes / 1024)} KB); no relay configured`);
    return;
  }
  try {
    const res = await fetch(`${RELAY}/edsby/${encodeURIComponent(SECRET)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `edsby-bridge/${VERSION}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log(`relay refused the capture: ${res.status} ${await res.text().catch(() => '')}`);
      return;
    }
    log(`sent ${responses.length} responses (${Math.round(bytes / 1024)} KB), signed in: ${signedIn ? 'yes' : 'no'}, because: ${reason}`);
  } catch (err) {
    log(`could not reach the relay: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: HEADLESS,
  // Headless runs (testing off the server) use the full Chromium rather than
  // the separate headless build, which the add-on image does not need.
  ...(HEADLESS ? { channel: 'chromium' } : {}),
  viewport: null,
  userAgent: desktopUserAgent(CHROMIUM_VERSION),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-position=0,0', '--window-size=1366,900'],
});
context.on('response', record);
context.on('close', () => {
  log('browser closed');
  process.exit(0);
});

const home = `https://${HOST}/`;
const first = context.pages()[0] ?? (await context.newPage());
await first.goto(home, { waitUntil: 'networkidle', timeout: 60_000 }).catch((e) => log(`could not open Edsby: ${e.message}`));
log(`Edsby open at ${home}`);
signedIn = await readSignedIn(first);
log(signedIn ? 'signed in: yes (kept from last time)' : 'signed in: no — open the Edsby panel in Home Assistant and sign in');
// Edsby is a single-page app: signing in does not always load a new page, so
// the state is re-read on a short timer as well as on navigation.
first.on('framenavigated', (frame) => {
  if (frame === first.mainFrame()) setTimeout(() => void updateSignedIn('page changed'), 2_000);
});
setInterval(() => void updateSignedIn('check'), 30_000);

/**
 * The regular look. A second tab, so a person using the window is never
 * navigated away from what they are doing; it loads Edsby's home, which
 * fetches the feed and classes, and closes again.
 */
async function refresh() {
  if (!(await updateSignedIn('scheduled look'))) {
    log('not signed in; skipping the regular look');
    await push('status');
    return;
  }
  const page = await context.newPage();
  try {
    await page.goto(home, { waitUntil: 'networkidle', timeout: 90_000 });
    await page.waitForTimeout(5_000);
  } catch (err) {
    log(`the regular look did not finish loading: ${err.message}`);
  } finally {
    await page.close().catch(() => {});
  }
  clearTimeout(settleTimer);
  await push('schedule');
}

setTimeout(() => void refresh(), 60_000);
setInterval(() => void refresh(), INTERVAL_MS);
