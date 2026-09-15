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
import { SKIP_PATH, captureKey, cleanUrl, desktopUserAgent, isSignedInState, looksLikeJson, redactBody, skippedView } from './redact.mjs';
import { normalizeCapture, readClassFolder, readClasses, stripLayout } from './normalize.mjs';

/** The engine's real version, for the browser identity Edsby is shown. */
const CHROMIUM_VERSION = await fs
  .readFile(new URL('./node_modules/playwright-core/browsers.json', import.meta.url), 'utf8')
  .then((text) => JSON.parse(text).browsers.find((b) => b.name === 'chromium')?.browserVersion)
  .catch(() => undefined);

const OPTIONS_FILE = process.env.OPTIONS_FILE ?? '/data/options.json';
const PROFILE_DIR = process.env.PROFILE_DIR ?? '/data/profile';
const HEADLESS = process.env.HEADLESS === '1';
const VERSION = '0.5.1';
const TIME_ZONE = process.env.TZ || 'America/Toronto';

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
    if (skippedView(response.url())) return;
    const request = response.request();
    const kind = request.resourceType();
    if (kind !== 'xhr' && kind !== 'fetch') return;
    const contentType = response.headers()['content-type'] ?? '';
    const text = await response.text().catch(() => null);
    if (!text || !looksLikeJson(contentType, text)) return;

    // The screen layout first — it is most of every response and none of the data.
    const clean = redactBody(stripLayout(text));
    const key = captureKey(request.method(), response.url());
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

/**
 * The addresses Edsby loads, never their contents.
 *
 * How a file downloads or a folder opens is only learned by watching it
 * happen, and the capture above keeps JSON alone. This keeps the rest as
 * addresses — cleaned of anything secret — so opening something once in the
 * panel is enough to see how it is fetched.
 */
const addressLog = [];
const MAX_ADDRESSES = 150;
function noteAddress(response) {
  if (!signedIn) return;
  try {
    const url = new URL(response.url());
    if (url.hostname !== HOST || SKIP_PATH.test(url.pathname)) return;
    const kind = response.request().resourceType();
    if (!['document', 'xhr', 'fetch', 'other', 'media'].includes(kind)) return;
    addressLog.push({
      at: Date.now(),
      method: response.request().method(),
      url: cleanUrl(response.url()),
      status: response.status(),
      type: response.headers()['content-type'] ?? '',
      kind,
    });
    if (addressLog.length > MAX_ADDRESSES) addressLog.splice(0, addressLog.length - MAX_ADDRESSES);
  } catch {
    // nothing worth noting
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
/** The student's own Edsby id, learned from the class list. */
let studentNid = null;

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
    void notifyHomeAssistant(false);
    setTimeout(() => void refresh(), 10_000);
  } else {
    captured.clear();
    log(`not signed in (${reason}) — open the Edsby panel in Home Assistant and sign in`);
    void notifyHomeAssistant(true);
    void push('signed out');
  }
  return now;
}

const NOTIFICATION_ID = 'edsby_bridge_signed_out';

/**
 * Say so in Home Assistant when the session ends, and take it back when it
 * returns.
 *
 * The first real session ended in the afternoon and nothing said so: the
 * bridge kept looking every three hours, found a login page each time, and
 * the only sign was an absence of new posts. A notification in the sidebar is
 * where a person will actually see it.
 */
async function notifyHomeAssistant(signedOut) {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return;
  const service = signedOut ? 'create' : 'dismiss';
  const body = signedOut
    ? {
        notification_id: NOTIFICATION_ID,
        title: 'Edsby Bridge is signed out',
        message:
          'Edsby ended the session, so class posts, test dates and libraries have stopped updating. ' +
          'Open **Edsby** in the sidebar and sign in again, with **Keep me logged in** ticked.',
      }
    : { notification_id: NOTIFICATION_ID };
  try {
    const res = await fetch(`http://supervisor/core/api/services/persistent_notification/${service}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) log(`Home Assistant did not take the notification: ${res.status}`);
  } catch (err) {
    log(`could not reach Home Assistant for the notification: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------


let lastFetchLog = [];

async function push(reason) {
  const page = context.pages()[0];
  const all = signedIn ? [...captured.values()].reverse() : [];
  const normalized = signedIn ? normalizeCapture(all, { host: HOST, timeZone: TIME_ZONE, storedFiles: new Set(storedFiles.keys()) }) : null;
  // Until a look has found the classes there is nothing worth keeping, so
  // only the status goes; the relay holds on to the last full capture.
  const complete = Boolean(normalized?.classes?.length);
  const responses = complete ? all : [];
  const payload = {
    version: 1,
    addon: VERSION,
    host: HOST,
    reason,
    capturedAt: Date.now(),
    signedIn,
    page: page ? { url: page.url().startsWith('http') ? cleanUrl(page.url()) : '', title: await page.title().catch(() => '') } : null,
    responseCount: responses.length,
    fetchLog: lastFetchLog,
    addressLog: complete ? addressLog : [],
    downloadLog: lastDownloadLog,
    storedFileCount: storedFiles.size,
    complete,
    normalized: complete ? normalized : null,
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
    log(complete
      ? `sent ${responses.length} responses (${Math.round(bytes / 1024)} KB) because: ${reason}`
      : `sent status only (signed in: ${signedIn ? 'yes' : 'no'}, no classes captured yet) because: ${reason}`);
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
context.on('response', noteAddress);
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
void notifyHomeAssistant(!signedIn);
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
    await lookAtEveryClass(page);
    await storeNewFiles();
  } catch (err) {
    log(`the regular look did not finish: ${err.message}`);
  } finally {
    await page.close().catch(() => {});
  }
  clearTimeout(settleTimer);
  await push('schedule');
}

/**
 * Each class's own feed and calendar, the same requests Edsby's app makes when
 * a class is opened. The home page only carries the newest handful of posts
 * across all classes; a class's feed carries all of its own.
 *
 * Made from inside the signed-in page, one at a time and a moment apart, so to
 * Edsby it is the student opening their classes.
 */
/** Requests, one at a time and a moment apart, from inside the signed-in page. */
async function fetchViews(page, urls) {
  return page.evaluate(async (list) => {
    const out = [];
    for (const url of list) {
      try {
        const res = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        const text = await res.text();
        out.push({ url, status: res.status, type: res.headers.get('content-type') || '', bytes: text.length });
      } catch (err) {
        out.push({ url, status: 0, error: String(err) });
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return out;
  }, urls);
}

/** Most folders opened in one look. A library bigger than this finishes next time. */
const MAX_FOLDERS_PER_LOOK = 60;
const MAX_FOLDER_DEPTH = 4;

/**
 * Everything each class has: its feed, calendar, My Work, and library.
 *
 * These are the requests Edsby's own app makes when a class is opened.
 * My Work is asked for per class — asking once for the student is refused —
 * and a library is read a level at a time, opening each folder the way a
 * person clicking through it would.
 */
async function lookAtEveryClass(page) {
  const list = [...captured.values()].find((c) => /xds=BaseStudentClasses/.test(c.url));
  let classes = [];
  try {
    const body = JSON.parse(list?.body ?? 'null');
    classes = readClasses(body);
    studentNid = body?.slices?.[0]?.data?.nid ?? studentNid;
  } catch {
    // no class list yet; the next look will have one
  }
  if (classes.length === 0) {
    log('no class list captured yet; looking at classes next time');
    return;
  }

  const log1 = await fetchViews(
    page,
    classes.flatMap((c) => [
      `/core/node.json/${c.nid}?xds=CourseFeed`,
      `/core/node.json/${c.nid}?xds=CalendarPanel_Class`,
      `/core/node.json/${c.nid}?xds=MyWork&MyWork_active=assessments`,
      `/core/node.json/${c.nid}?xds=ClassFolder`,
    ])
  );
  await page.waitForTimeout(3_000);

  // Then into the libraries, a level at a time.
  const opened = new Set(classes.map((c) => c.nid));
  const folderLog = [];
  for (let depth = 0; depth < MAX_FOLDER_DEPTH; depth++) {
    const folders = [];
    for (const entry of captured.values()) {
      if (!/xds=(ClassFolder|Folder)\b/.test(entry.url)) continue;
      let body = null;
      try {
        body = JSON.parse(entry.body);
      } catch {
        continue;
      }
      const container = /\/node\.json\/(\d+)/.exec(entry.url)?.[1] ?? '';
      for (const item of readClassFolder(body, container)) {
        if (item.kind === 'folder' && !opened.has(item.nid)) folders.push(item.nid);
      }
    }
    const room = MAX_FOLDERS_PER_LOOK - folderLog.length;
    const next = [...new Set(folders)].slice(0, Math.max(0, room));
    if (next.length === 0) break;
    for (const nid of next) opened.add(nid);
    // A class's top level answers ClassFolder; a folder inside it answers
    // Folder, which is what Edsby's own panel asks for when one is opened.
    // Asking a folder for ClassFolder is refused.
    folderLog.push(...(await fetchViews(page, next.map((nid) => `/core/node.json/${nid}?xds=Folder`))));
    await page.waitForTimeout(3_000);
  }

  lastFetchLog = [...log1, ...folderLog];
  const ok = lastFetchLog.filter((f) => f.status === 200 && /json/.test(f.type)).length;
  log(`looked at ${classes.length} classes and ${folderLog.length} library folders: ${ok} of ${lastFetchLog.length} views answered`);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const STORED_FILES_PATH = process.env.STORED_FILES ?? '/data/stored-files.json';
/** Edsby file id → when it went to the relay. Survives restarts, so nothing is sent twice. */
const storedFiles = new Map(
  Object.entries(await fs.readFile(STORED_FILES_PATH, 'utf8').then(JSON.parse).catch(() => ({})))
);
let lastDownloadLog = [];

const MAX_FILE_BYTES = 20_000_000;
const MAX_FILES_PER_LOOK = 60;
const MAX_BYTES_PER_LOOK = 150_000_000;

/**
 * Each new library file and post attachment, fetched once and stored on the
 * relay for the study app to read.
 *
 * Fetched with the browser's own session through Playwright's request context
 * — the same cookies the signed-in page uses, without drawing anything — from
 * the address Edsby's viewer uses. A handful per look, a moment apart, and
 * never again once stored. A reply that is a web page rather than a file means
 * Edsby did not hand it over, and the rest wait for the next look.
 */
async function storeNewFiles() {
  if (!SECRET || !RELAY || !signedIn) return;
  const n = normalizeCapture([...captured.values()], { host: HOST, timeZone: TIME_ZONE });
  const wanted = new Map();
  for (const it of n.library) if (it.kind === 'file' && it.file) wanted.set(it.nid, it.file);
  for (const p of n.posts) for (const f of p.files) if (f.nid) wanted.set(f.nid, f);

  const queue = [...wanted.entries()].filter(([nid]) => !storedFiles.has(nid));
  const results = [];
  let sentBytes = 0;
  for (const [nid, meta] of queue) {
    if (results.length >= MAX_FILES_PER_LOOK || sentBytes >= MAX_BYTES_PER_LOOK) break;
    if (meta.bytes > MAX_FILE_BYTES) {
      results.push({ nid, name: meta.name, outcome: 'too large to store', bytes: meta.bytes });
      continue;
    }
    try {
      const res = await context.request.get(
        `https://${HOST}/core/nodedl/${nid}?field=file&xds=fileView&size=orig&attach=1`,
        { timeout: 90_000, headers: { referer: `https://${HOST}/` } }
      );
      const type = res.headers()['content-type'] ?? '';
      const body = await res.body();
      if (!res.ok() || /text\/html/i.test(type) || body.length === 0) {
        results.push({ nid, name: meta.name, outcome: `Edsby answered ${res.status()} ${type}`.trim() });
        // A web page instead of a file is Edsby refusing, not one bad file.
        if (/text\/html/i.test(type)) break;
        continue;
      }
      const put = await fetch(`${RELAY}/edsby/file/${encodeURIComponent(SECRET)}/${nid}`, {
        method: 'PUT',
        headers: {
          'content-type': meta.type || type || 'application/octet-stream',
          'x-file-name': encodeURIComponent(meta.name || String(nid)),
          'user-agent': `edsby-bridge/${VERSION}`,
        },
        body,
      });
      if (!put.ok) {
        results.push({ nid, name: meta.name, outcome: `relay refused ${put.status}` });
        continue;
      }
      storedFiles.set(nid, Date.now());
      sentBytes += body.length;
      results.push({ nid, name: meta.name, outcome: 'stored', bytes: body.length });
    } catch (err) {
      results.push({ nid, name: meta.name, outcome: `failed: ${err?.message ?? err}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await fs.writeFile(STORED_FILES_PATH, JSON.stringify(Object.fromEntries(storedFiles))).catch(() => {});
  lastDownloadLog = results;
  const stored = results.filter((l) => l.outcome === 'stored').length;
  if (queue.length) log(`files: ${stored} stored this look, ${queue.length - stored} still waiting, ${storedFiles.size} stored in all`);
}

/**
 * A light touch every twenty minutes, so the session is not idle long enough
 * to be ended. An open Edsby tab does the same.
 */
const KEEP_ALIVE_MS = 20 * 60_000;
async function keepAlive() {
  if (!signedIn || !studentNid) return;
  const main = context.pages()[0];
  if (!main) return;
  try {
    await main.evaluate(async (nid) => {
      await fetch(`/core/node.json/${nid}?xds=scrollingNews`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    }, studentNid);
  } catch {
    // mid-navigation; the next touch will do
  }
  await updateSignedIn('keep-alive');
}
setInterval(() => void keepAlive(), KEEP_ALIVE_MS);

setTimeout(() => void refresh(), 60_000);
setInterval(() => void refresh(), INTERVAL_MS);
