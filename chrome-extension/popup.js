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
 * Strategy 1: search the UGAPP page data deeply for any array that looks
 * like a versions list and contains a Chords entry.
 */
function _chordsFromArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const TYPE_PREF = { Chords: 0, Tab: 1 };
  // Only treat this as a versions list if it has recognisable type fields
  if (!arr.some(v => v && (v.type || v.type_name))) return null;
  const sorted = [...arr].sort(
    (a, b) => (TYPE_PREF[a.type_name ?? a.type] ?? 99) -
               (TYPE_PREF[b.type_name ?? b.type] ?? 99)
  );
  const best = sorted[0];
  const u = best?.tab_url || best?.url;
  return (u && !u.includes('-official-')) ? u : null;
}

function _findChordsDeep(obj, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    const u = _chordsFromArray(obj);
    if (u) return u;
    for (const item of obj.slice(0, 30)) {
      const r = _findChordsDeep(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  // Prioritise keys that are likely to hold version lists
  const priority = ['versions', 'tab_versions', 'other_versions', 'related_tabs', 'tabs'];
  for (const k of priority) {
    if (obj[k]) { const r = _findChordsDeep(obj[k], depth + 1); if (r) return r; }
  }
  for (const val of Object.values(obj)) {
    const r = _findChordsDeep(val, depth + 1);
    if (r) return r;
  }
  return null;
}

function findChordsUrlInData(data) {
  return _findChordsDeep(data);
}

/**
 * Strategy 2: look for chords-type links directly in the rendered DOM of
 * the scrape tab (works even when UGAPP doesn't include a versions list).
 */
async function findChordsUrlInDom(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      // Any anchor whose href contains "-chords-" followed by digits
      for (const a of document.querySelectorAll('a[href*="-chords-"]')) {
        if (/\/tab\/[a-z0-9_-]+-chords-\d+/i.test(a.href))
          return a.href.split('?')[0];
      }
      // Any anchor whose visible text is exactly "Chords"
      for (const a of document.querySelectorAll('a[href*="/tab/"]')) {
        if (a.textContent.trim().toLowerCase() === 'chords')
          return a.href.split('?')[0];
      }
      // Dump top-level UGAPP keys so the dev can find the right path
      const data = window.UGAPP?.store?.page?.data;
      if (data) {
        const tv = data.tab_view;
        return '__DEBUG__:' + JSON.stringify({
          topKeys:     Object.keys(data),
          tabViewKeys: tv ? Object.keys(tv) : [],
          versionsLen: tv?.versions?.length,
          tabKeys:     data.tab ? Object.keys(data.tab) : [],
        });
      }
      return null;
    },
  });
  return result;
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

      // Official tabs have no wiki_tab.content — find the Chords version
      if (!data?.tab_view?.wiki_tab?.content) {
        // Strategy 1: deep search through UGAPP data
        let chordsUrl = findChordsUrlInData(data);

        // Strategy 2: scan the live DOM for chords-type links
        if (!chordsUrl) {
          const domResult = await findChordsUrlInDom(_scrapeTabId);
          if (domResult && domResult.startsWith('__DEBUG__:')) {
            // Log debug info so we can fix the data path next time
            appendLog('fail', `Official tab — no chords link found. Debug: ${domResult.slice(9)}  [${url}]`);
            done++;
            setProgress(done, urls.length);
            continue;
          }
          chordsUrl = domResult;
        }

        if (chordsUrl && chordsUrl !== url) {
          data     = await scrapeViaRealTab(chordsUrl);
          finalUrl = chordsUrl;
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
