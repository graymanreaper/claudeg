// ChordBook Grabber — popup script
// Individual tab pages are scraped by navigating a real hidden browser tab
// so Cloudflare treats every request as a normal user page load.

const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise(r => setTimeout(r, ms));

let serverUrl = 'http://localhost:5000';
let currentTab = null;
let currentTabData = null;

// One persistent background tab is reused for all scraping; reset to null after import.
let _scrapeTabId = null;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  const { server } = await chrome.storage.local.get('server');
  if (server) serverUrl = server;
  $('serverUrl').value = serverUrl;
}

async function saveServerUrl() {
  serverUrl = $('serverUrl').value.trim().replace(/\/$/, '');
  await chrome.storage.local.set({ server: serverUrl });
  $('openLibrary').href = serverUrl + '/';
  pingServer();
}

// ---------------------------------------------------------------------------
// Server health check
// ---------------------------------------------------------------------------

async function pingServer() {
  const dot = $('serverStatus');
  try {
    const r = await fetch(serverUrl + '/api/songs');
    dot.className = r.ok ? 'dot dot-ok' : 'dot dot-off';
    dot.title     = r.ok ? 'Server reachable' : 'Server error ' + r.status;
  } catch {
    dot.className = 'dot dot-off';
    dot.title     = 'Server not reachable — is python app.py running?';
  }
}

// ---------------------------------------------------------------------------
// Real-tab scraper (bypasses Cloudflare)
// ---------------------------------------------------------------------------

/** Wait until a tab reaches 'complete' status, then pause for JS initialisation. */
function waitForTabLoad(tabId, ms = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Page load timed out'));
    }, ms);

    function onUpdated(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      setTimeout(resolve, 900); // let page JS (UGAPP) fully initialise
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/** Clean up the scrape tab when we're done. */
async function closeScrapeTab() {
  if (_scrapeTabId != null) {
    await chrome.tabs.remove(_scrapeTabId).catch(() => {});
    _scrapeTabId = null;
  }
}

// Track if user closes the scrape tab manually
chrome.tabs.onRemoved.addListener(id => {
  if (id === _scrapeTabId) _scrapeTabId = null;
});

/**
 * Navigate the reusable background tab to `url`, wait for full load,
 * then pull window.UGAPP.store.page.data via executeScript.
 * This is a genuine browser request — Cloudflare cannot block it.
 */
async function scrapeViaRealTab(url) {
  if (_scrapeTabId == null) {
    const tab = await chrome.tabs.create({ url, active: false });
    _scrapeTabId = tab.id;
  } else {
    // Check the tab still exists
    const existing = await chrome.tabs.get(_scrapeTabId).catch(() => null);
    if (!existing) {
      const tab = await chrome.tabs.create({ url, active: false });
      _scrapeTabId = tab.id;
    } else {
      await chrome.tabs.update(_scrapeTabId, { url });
    }
  }

  await waitForTabLoad(_scrapeTabId);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: _scrapeTabId },
    world: 'MAIN',
    func: () => {
      const d = window.UGAPP?.store?.page?.data;
      return d ? JSON.parse(JSON.stringify(d)) : null;
    },
  });

  if (!result) throw new Error('No tab data found — page may have failed to load');
  return result;
}

// ---------------------------------------------------------------------------
// Tab-data normaliser
// ---------------------------------------------------------------------------

function normaliseTabData(data, urlFallback) {
  const tab  = data?.tab;
  const view = data?.tab_view;
  const content = view?.wiki_tab?.content;
  if (!content) throw new Error('No chord/tab content on this page');
  return {
    url:      tab?.tab_url    || urlFallback,
    title:    (tab?.song_name   || '').trim(),
    artist:   (tab?.artist_name || '').trim(),
    tab_type: tab?.type_name    || 'Chords',
    content,
    key:    view?.meta?.tonality || '',
    capo:   view?.meta?.capo    || 0,
    rating: tab?.rating         || 0,
    votes:  tab?.votes          || 0,
  };
}

// ---------------------------------------------------------------------------
// My Saved Tabs — URL collection (www.ultimate-guitar.com, less restricted)
// ---------------------------------------------------------------------------

const TAB_URL_RE = /https:\/\/tabs\.ultimate-guitar\.com\/tab\/[a-z0-9_-]+\/[a-z0-9_-]+-\d+/gi;

/** Read window.UGAPP.store.page.data from a live tab in MAIN world. */
async function readLivePageData(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const d = window.UGAPP?.store?.page?.data;
      return d ? JSON.parse(JSON.stringify(d)) : null;
    },
  });
  return result;
}

/** Extract the UGAPP JSON blob from raw HTML. */
function parseDataFromHtml(html) {
  const marker = 'window.UGAPP.store.page.data = ';
  const start  = html.indexOf(marker);
  if (start === -1) throw new Error('UGAPP data not found');
  let i = start + marker.length;
  while (i < html.length && html[i] !== '{') i++;
  const jsonStart = i;
  let depth = 0, inStr = false, esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (esc)       { esc = false; continue; }
    if (c === '\\') { esc = true;  continue; }
    if (c === '"')  { inStr = !inStr; continue; }
    if (inStr)      continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0)
      return JSON.parse(html.substring(jsonStart, i + 1));
  }
  throw new Error('Could not parse UGAPP JSON');
}

/** Recursively find the first array of tab-like objects inside a JS object. */
function findTabsDeep(obj, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === 'object' &&
        (obj[0]?.tab_url || obj[0]?.tabUrl))
      return obj;
    for (const item of obj.slice(0, 20)) {
      const r = findTabsDeep(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const val of Object.values(obj)) {
    const r = findTabsDeep(val, depth + 1);
    if (r) return r;
  }
  return null;
}

function urlsFromPageData(data) {
  if (!data) return [];
  const candidates = [
    data?.tabs, data?.data?.tabs, data?.user_tabs,
    data?.data?.user_tabs, data?.data?.user_data?.tabs,
    data?.store?.tabs, data?.profile?.tabs, data?.page?.tabs,
  ];
  for (const arr of candidates) {
    if (Array.isArray(arr) && arr.length > 0) {
      const urls = arr.map(t => t.tab_url || t.tabUrl || t.url).filter(Boolean);
      if (urls.length) return urls;
    }
  }
  const deep = findTabsDeep(data);
  if (deep) return deep.map(t => t.tab_url || t.tabUrl || t.url).filter(Boolean);
  return [];
}

/** Scrape tab URLs from the live page's DOM anchors. */
async function urlsFromDom(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const urls = new Set();
      document.querySelectorAll('a[href]').forEach(a => {
        if (/tabs\.ultimate-guitar\.com\/tab\/[a-z0-9_-]+\/[a-z0-9_-]+-\d+/i.test(a.href))
          urls.add(a.href.split('?')[0]);
      });
      return [...urls];
    },
  });
  return result || [];
}

/** Detect max page number from pagination links in the live DOM. */
async function detectTotalPages(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      let max = 1;
      document.querySelectorAll('a[href*="page="]').forEach(a => {
        const m = a.href.match(/[?&]page=(\d+)/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      return max;
    },
  });
  return result || 1;
}

/** Collect all saved-tab URLs across every page of /user/mytabs. */
async function getAllMyTabUrls(tabId) {
  const all = new Set();

  // Page 1 — already loaded in browser
  let firstData = null;
  try { firstData = await readLivePageData(tabId); } catch {}
  urlsFromPageData(firstData).forEach(u => all.add(u));
  if (all.size === 0) (await urlsFromDom(tabId)).forEach(u => all.add(u));

  // Pagination
  let totalPages = 1;
  const pg = firstData?.pagination || firstData?.data?.pagination;
  if (pg) totalPages = pg.total ?? pg.last_page ?? 1;
  if (totalPages === 1) totalPages = await detectTotalPages(tabId);

  for (let p = 2; p <= totalPages; p++) {
    setProgress(all.size, all.size, `Collecting page ${p} of ${totalPages}…`);
    try {
      const resp = await fetch(
        `https://www.ultimate-guitar.com/user/mytabs?page=${p}`,
        { credentials: 'include' }
      );
      const html = await resp.text();
      let urls = [];
      try { urls = urlsFromPageData(parseDataFromHtml(html)); } catch {}
      if (!urls.length) {
        const re = new RegExp(TAB_URL_RE.source, 'gi');
        let m;
        while ((m = re.exec(html)) !== null) urls.push(m[0]);
      }
      urls.forEach(u => all.add(u));
    } catch (e) {
      appendLog('fail', `Page ${p}: ${e.message}`);
    }
    await delay(400);
  }

  return [...all];
}

// ---------------------------------------------------------------------------
// POST to local server
// ---------------------------------------------------------------------------

async function postToServer(tabObj) {
  const resp = await fetch(serverUrl + '/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tabObj),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body.ok) throw new Error(body.error || `HTTP ${resp.status}`);
  return body;
}

// ---------------------------------------------------------------------------
// Progress UI
// ---------------------------------------------------------------------------

function setProgress(done, total, label) {
  $('logSection').style.display = 'block';
  const pct = total ? Math.round(done / total * 100) : 0;
  $('progressFill').style.width = pct + '%';
  $('progressText').textContent = label || `${done} / ${total}`;
}

function appendLog(status, msg) {
  const li = document.createElement('li');
  li.className = 'log-' + status;
  li.textContent = `[${status}] ${msg}`;
  $('log').insertBefore(li, $('log').firstChild);
}

// ---------------------------------------------------------------------------
// Official-tab fallback — find the Chords version
// ---------------------------------------------------------------------------

/**
 * Inject into the scrape tab and dump actual VALUES of the fields we care about.
 * Returns a plain object so we can both act on it and log it.
 */
async function inspectOfficialTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const d = window.UGAPP?.store?.page?.data;
      if (!d) return { error: 'no UGAPP', currentUrl: location.href };
      const tv = d.tab_view;
      return {
        currentUrl:      location.href,
        wikiLen:         tv?.wiki_tab?.content?.length ?? 0,
        simplifiedUrl:   tv?.simplifiedUrl   ?? null,
        isSimplify:      tv?.is_simplify_available ?? false,
        typeUrls:        tv?.type_urls        ?? null,
        tabType:         d?.tab?.type_name    ?? null,
        brotherKeys:     tv?.brothers_by_type ? Object.keys(tv.brothers_by_type) : [],
        versionsTypes:   (tv?.versions ?? []).map(v => v.type_name ?? v.type),
        bestProTabUrl:   d?.best_pro_tab_url  ?? null,
        songName:        d?.tab?.song_name    ?? '',
        artistName:      d?.tab?.artist_name  ?? '',
      };
    },
  });
  return result;
}

/**
 * Find a non-Official chords URL from whatever data the page exposes.
 */
function findChordsUrlInData(info) {
  if (!info) return null;

  // type_urls keys are lowercase from UG: { chords: "...", pro: "...", tab: "..." }
  if (info.typeUrls && typeof info.typeUrls === 'object') {
    const entries = Object.entries(info.typeUrls);
    // Prefer the 'chords' key (case-insensitive) — it's the simplified chord view
    for (const [k, u] of entries) {
      if (k.toLowerCase() === 'chords' && u) return u.split('?')[0];
    }
    // Fall back to any key that isn't the pro/official notation tab
    for (const [k, u] of entries) {
      if (u && !['pro', 'official'].includes(k.toLowerCase())) return u.split('?')[0];
    }
  }

  if (info.simplifiedUrl) return info.simplifiedUrl.split('?')[0];

  return null;
}

/**
 * Poll window.UGAPP until wiki_tab.content appears (content loads async for official tabs).
 */
async function pollForWikiContent(tabId, maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await delay(600);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const d = window.UGAPP?.store?.page?.data;
        return d?.tab_view?.wiki_tab?.content ? JSON.parse(JSON.stringify(d)) : null;
      },
    });
    if (result) return result;
  }
  return null;
}

/**
 * UG official chords pages load content via React API — UGAPP is never updated.
 * This extracts chord/lyric text directly from the rendered DOM as a last resort.
 */
async function extractContentFromDom(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const d = window.UGAPP?.store?.page?.data;
      const tab = d?.tab;

      // Score candidate elements: prefer pre elements, then text-rich divs
      const candidates = [];
      document.querySelectorAll('pre').forEach(el => {
        if (el.innerText.length > 100) candidates.push({ el, score: el.innerText.length * 2 });
      });
      for (const el of document.querySelectorAll('div[class]')) {
        const text = el.innerText || '';
        const lines = text.split('\n').filter(l => l.trim()).length;
        if (text.length < 400 || lines < 8 || el.children.length >= 30) continue;
        const chordCount = (text.match(/\b[A-G][#b]?(?:m|maj|min|dim|aug|sus|add)?\d*(?:\/[A-G][#b]?)?\b/g) || []).length;
        candidates.push({ el, score: lines + chordCount * 3 });
      }
      if (!candidates.length) return null;

      candidates.sort((a, b) => b.score - a.score);
      const content = candidates[0].el.innerText;
      if (!content || content.length < 100) return null;

      return {
        tab: {
          song_name:   tab?.song_name   || document.title.replace(/ (Chords|Tab).*$/i, '').trim(),
          artist_name: tab?.artist_name || '',
          tab_url:     tab?.tab_url     || location.href.split('?')[0],
          type_name:   tab?.type_name   || 'Chords',
          rating: tab?.rating || 0,
          votes:  tab?.votes  || 0,
        },
        tab_view: { wiki_tab: { content }, meta: {} },
      };
    },
  });
  return result;
}

/**
 * Click the Chords aria toggle, then wait for either:
 *  (a) wiki_tab.content to appear in UGAPP (in-page React update), OR
 *  (b) the tab URL to change to a chords page (full navigation)
 */
async function clickChordsAndWait(tabId) {
  const urlBefore = (await chrome.tabs.get(tabId).catch(() => ({url:''}))).url;

  const [{ result: clicked }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const candidates = [
        document.querySelector('[aria-label="Chords"]'),
        document.querySelector('[aria-label="Chords"] span'),
        ...[...document.querySelectorAll('*')].filter(
          el => el.children.length === 0 && el.textContent.trim() === 'Chords'
        ),
      ].filter(Boolean);

      if (!candidates.length) return null;

      const el = candidates[0];
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t =>
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, composed: true }))
      );
      return el.tagName + '|' + (el.getAttribute('aria-label') ?? el.textContent.trim());
    },
  });

  if (!clicked) return { data: null, clicked: false };

  await delay(1500);

  // Case A: URL changed — real navigation happened
  const urlAfter = (await chrome.tabs.get(tabId).catch(() => ({url:urlBefore}))).url;
  if (urlAfter !== urlBefore) {
    await waitForTabLoad(tabId);
    const [{ result: data }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const d = window.UGAPP?.store?.page?.data;
        return d ? JSON.parse(JSON.stringify(d)) : null;
      },
    });
    return { data, clicked: true, newUrl: urlAfter };
  }

  // Case B: in-page React update — poll wiki_tab.content
  for (let i = 0; i < 8; i++) {
    await delay(500);
    const [{ result: data }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const d = window.UGAPP?.store?.page?.data;
        return d?.tab_view?.wiki_tab?.content ? JSON.parse(JSON.stringify(d)) : null;
      },
    });
    if (data) return { data, clicked: true };
  }

  return { data: null, clicked: true };
}

// ---------------------------------------------------------------------------
// Core import loop — uses the real-tab scraper for every individual tab page
// ---------------------------------------------------------------------------

async function importUrls(urls, { btnEl } = {}) {
  $('log').innerHTML = '';
  $('logSection').style.display = 'block';
  if (btnEl) btnEl.disabled = true;

  let done = 0;
  for (const url of urls) {
    setProgress(done, urls.length);
    try {
      let data     = await scrapeViaRealTab(url);
      let finalUrl = url;

      // Official tabs have no wiki_tab.content — find/load the Chords version
      if (!data?.tab_view?.wiki_tab?.content) {
        const info = await inspectOfficialTab(_scrapeTabId);

        // Strategy 1: Navigate to the chords URL from type_urls / simplifiedUrl.
        // Close the current tab first so we get a fresh HTTP request instead of
        // SPA client-side routing (which never updates window.UGAPP).
        const chordsUrl = findChordsUrlInData(info);
        if (chordsUrl && chordsUrl !== url) {
          await closeScrapeTab();
          data     = await scrapeViaRealTab(chordsUrl);
          finalUrl = chordsUrl;

          // Content may load asynchronously into UGAPP — poll for up to 10 s
          if (!data?.tab_view?.wiki_tab?.content) {
            const polled = await pollForWikiContent(_scrapeTabId);
            if (polled) data = polled;
          }

          // If UGAPP still never got the content, read it from the rendered DOM
          if (!data?.tab_view?.wiki_tab?.content) {
            const domData = await extractContentFromDom(_scrapeTabId);
            if (domData?.tab_view?.wiki_tab?.content) data = domData;
          }
        }

        // Strategy 2 (no chords URL found): click the Chords aria toggle
        if (!data?.tab_view?.wiki_tab?.content) {
          const { data: chordsData, newUrl } = await clickChordsAndWait(_scrapeTabId);
          if (chordsData) {
            data     = chordsData;
            finalUrl = (newUrl || finalUrl).split('?')[0];
          }
        }

        // Final DOM fallback on whatever page is loaded now
        if (!data?.tab_view?.wiki_tab?.content) {
          const domData = await extractContentFromDom(_scrapeTabId);
          if (domData?.tab_view?.wiki_tab?.content) data = domData;
        }

        if (!data?.tab_view?.wiki_tab?.content) {
          throw new Error(`Official tab — no chords found. typeUrls: ${JSON.stringify(info?.typeUrls)}, chordsUrl tried: ${chordsUrl}`);
        }
      }

      const tab    = normaliseTabData(data, finalUrl);
      const result = await postToServer(tab);
      appendLog(result.already_existed ? 'skip' : 'ok',
                `${tab.title} — ${tab.artist}`);
    } catch (e) {
      appendLog('fail', `${e.message}  [${url}]`);
    }
    done++;
    setProgress(done, urls.length);
  }

  await closeScrapeTab();
  setProgress(done, urls.length, `Done — ${done} tab${done !== 1 ? 's' : ''} processed.`);
  if (btnEl) { btnEl.disabled = false; btnEl.textContent = btnEl.dataset.label; }
}

// ---------------------------------------------------------------------------
// Mode: single UG tab page
// ---------------------------------------------------------------------------

async function setupSingleTabMode(tab) {
  $('currentPageSection').style.display = 'block';
  const info = $('currentPageInfo');
  const btn  = $('saveCurrentBtn');
  try {
    const raw = await readLivePageData(tab.id);
    if (!raw) throw new Error('page not fully loaded — refresh and try again');
    currentTabData = normaliseTabData(raw, tab.url);
    info.classList.add('ok');
    info.innerHTML = `<strong>${currentTabData.title}</strong><br>${currentTabData.artist}`;
    btn.disabled = false;
  } catch (e) {
    info.textContent = 'Could not read page: ' + e.message;
  }
}

async function saveCurrentPage() {
  const btn = $('saveCurrentBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const result = await postToServer(currentTabData);
    btn.textContent = result.already_existed ? 'Already saved ✓' : 'Saved ✓';
  } catch (e) {
    btn.textContent = 'Error — ' + e.message;
  }
  setTimeout(() => { btn.textContent = 'Save This Page'; btn.disabled = false; }, 2000);
}

// ---------------------------------------------------------------------------
// Mode: /user/mytabs page
// ---------------------------------------------------------------------------

async function setupMyTabsMode(tab) {
  $('myTabsSection').style.display = 'block';
  const info = $('myTabsInfo');
  const btn  = $('importMyTabsBtn');

  try {
    let data = null;
    try { data = await readLivePageData(tab.id); } catch {}
    const fromData = urlsFromPageData(data);
    const fromDom  = await urlsFromDom(tab.id);
    const count    = Math.max(fromData.length, fromDom.length);

    const pg = data?.pagination || data?.data?.pagination;
    let pages = (pg?.total ?? pg?.last_page) || 1;
    if (pages === 1) pages = await detectTotalPages(tab.id);

    if (count === 0) {
      info.textContent = 'No tabs detected — try scrolling down to load the list, then reopen the extension.';
      btn.disabled = true;
    } else {
      info.textContent = pages > 1
        ? `Detected ${count} tabs on page 1 of ${pages} — all pages will be collected.`
        : `Detected ${count} saved tabs.`;
      btn.disabled = false;
    }
  } catch (e) {
    info.textContent = 'Error reading page: ' + e.message;
    btn.disabled = true;
  }
}

async function importMyTabs() {
  const btn = $('importMyTabsBtn');
  btn.dataset.label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Collecting URLs…';
  $('myTabsInfo').textContent = 'Scanning all pages for tab URLs…';
  $('log').innerHTML = '';

  try {
    const urls = await getAllMyTabUrls(currentTab.id);
    if (!urls.length) throw new Error('No tab URLs found on this page.');
    $('myTabsInfo').textContent = `Found ${urls.length} tabs — importing (keep this popup open)…`;
    await importUrls(urls, { btnEl: btn });
  } catch (e) {
    appendLog('fail', e.message);
    btn.disabled = false; btn.textContent = btn.dataset.label;
  }
}

// ---------------------------------------------------------------------------
// Mode: bulk URL textarea
// ---------------------------------------------------------------------------

async function bulkImport() {
  const lines = $('bulkUrls').value
    .split('\n').map(s => s.trim())
    .filter(s => s && !s.startsWith('#') && s.startsWith('http'));
  if (!lines.length) return;
  const btn = $('bulkBtn');
  btn.dataset.label = btn.textContent;
  await importUrls(lines, { btnEl: btn });
}

// ---------------------------------------------------------------------------
// Detect active page type and show the right section
// ---------------------------------------------------------------------------

async function detectPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  const url = tab?.url || '';

  if (url.includes('ultimate-guitar.com/user/mytabs')) {
    setupMyTabsMode(tab);
  } else if (/tabs\.ultimate-guitar\.com\/tab\//i.test(url) ||
             /ultimate-guitar\.com\/tab\//i.test(url)) {
    setupSingleTabMode(tab);
  } else {
    $('notOnUgMsg').style.display = 'block';
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  $('openLibrary').href = serverUrl + '/';
  pingServer();
  detectPage();

  $('serverUrl').addEventListener('change', saveServerUrl);
  $('saveCurrentBtn').addEventListener('click', saveCurrentPage);
  $('importMyTabsBtn').dataset.label = $('importMyTabsBtn').textContent;
  $('importMyTabsBtn').addEventListener('click', importMyTabs);
  $('bulkBtn').dataset.label = $('bulkBtn').textContent;
  $('bulkBtn').addEventListener('click', bulkImport);
});
