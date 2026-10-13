/* Shared plumbing for the Folio QA harness: launch headless Chromium, point it
   at the dev server, capture downloads, and fail loudly on console errors.
   Requires two packages that are deliberately NOT project dependencies:
     npm i --no-save puppeteer-core @sparticuz/chromium
*/
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

export const BASE = process.env.FOLIO_URL ?? 'http://127.0.0.1:5173/';
export const OUT = join(here, 'out');
export const DOWNLOADS = join(OUT, 'downloads');
export const SHOTS = join(OUT, 'shots');
export const FIXTURES = join(here, '.fixtures');

export const problems = [];
export const flag = (message) => {
  problems.push(message);
  console.log(`  ! ${message}`);
};
export const say = (label, value) => console.log(`• ${label}: ${value}`);

function chromiumLibPath() {
  for (const candidate of [join(here, '.chromium-lib'), '/tmp/al2023/lib']) {
    try {
      if (readdirSync(candidate).length) return candidate;
    } catch {
      /* not there, keep looking */
    }
  }
  return null;
}

export async function open({ width = 1440, height = 1000, freshDownloads = true } = {}) {
  let puppeteer;
  let chromium;
  try {
    puppeteer = require('puppeteer-core');
    chromium = require('@sparticuz/chromium');
    chromium = chromium.default ?? chromium;
  } catch (error) {
    console.error('\nThe QA harness needs puppeteer-core and @sparticuz/chromium:\n  npm i --no-save puppeteer-core @sparticuz/chromium\n');
    throw error;
  }
  const executablePath = await chromium.executablePath();
  const lib = chromiumLibPath();
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage'],
    env: lib ? { ...process.env, LD_LIBRARY_PATH: lib } : process.env,
  });
  mkdirSync(DOWNLOADS, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  if (freshDownloads) {
    rmSync(DOWNLOADS, { recursive: true, force: true });
    mkdirSync(DOWNLOADS, { recursive: true });
  }
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  /* A real click still (so the hit test counts), but centred first: the tab bar
     and the page strip are sticky, and Puppeteer's own scroll can leave a button
     underneath them, where the click would land on the strip instead. */
  const rawClick = page.click.bind(page);
  page.click = async (selector, options) => {
    await page.$eval(selector, (node) => {
      node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const sticky = ['#toolNav', '#pageStrip']
        .map((sel) => document.querySelector(sel))
        .filter((el) => el && el.offsetParent !== null)
        .reduce((bottom, el) => Math.max(bottom, el.getBoundingClientRect().bottom), 0);
      const rect = node.getBoundingClientRect();
      if (sticky && rect.top < sticky + 10) window.scrollBy({ top: rect.top - sticky - 60, behavior: 'instant' });
    }).catch(() => {});
    await sleep(90);
    return rawClick(selector, options);
  };
  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true });
  page.on('pageerror', (error) => flag(`pageerror: ${String(error.message).slice(0, 200)}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|net::|Failed to load resource|favicon/.test(text)) return;
    flag(`console.error: ${text.slice(0, 200)}`);
  });
  return { browser, page };
}

export const files = () => readdirSync(DOWNLOADS).filter((name) => !name.endsWith('.crdownload'));
/* A signature per file, not just the names: Chromium here overwrites a download
   that reuses a name instead of adding " (1)", so a second export of the same
   document would otherwise look like nothing happened. */
export const snapshot = () => new Map(files().map((name) => {
  try {
    const info = statSync(join(DOWNLOADS, name));
    return [name, `${info.size}:${info.mtimeMs}`];
  } catch {
    return [name, 'missing'];
  }
}));
export const fixture = (name) => (isAbsolute(name) ? name : join(FIXTURES, name));

export async function waitForDownload(before, { seconds = 40 } = {}) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const now = snapshot();
    const fresh = [...now].find(([name, signature]) => before.get(name) !== signature);
    if (fresh) {
      await sleep(400);
      return fresh[0];
    }
    await sleep(200);
  }
  return null;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function goto(page, hash, ms = 1500) {
  await page.goto(`${BASE}${hash}`, { waitUntil: 'domcontentloaded' });
  await sleep(ms);
}

export async function feed(page, selector, names) {
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click(selector)]);
  await chooser.accept(names.map(fixture));
}

export async function type(page, selector, text) {
  await page.$eval(selector, (node) => {
    node.value = '';
  });
  await page.click(selector);
  if (text) await page.type(selector, text);
  await page.$eval(selector, (node) => node.dispatchEvent(new Event('input', { bubbles: true })));
  await sleep(320);
}

export const text = (page, selector) => page.$eval(selector, (node) => node.textContent.trim()).catch(() => 'MISSING');
export const value = (page, selector) => page.$eval(selector, (node) => node.value).catch(() => 'MISSING');

export function report(label) {
  console.log('• --- problems ---');
  console.log(problems.length ? `${label}: ${problems.length} problem${problems.length === 1 ? '' : 's'}` : `${label}: clean`);
  return problems.length;
}

export { pathToFileURL };
