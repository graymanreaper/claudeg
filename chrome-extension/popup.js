// ChordBook Grabber — popup script

const $ = (id) => document.getElementById(id);

let serverUrl = 'http://localhost:5000';
let currentTab = null;
let currentTabData = null;

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
    const r = await fetch(serverUrl + '/api/songs', { method: 'GET' });
    dot.className = r.ok ? 'dot dot-ok' : 'dot dot-off';
    dot.title = r.ok ? 'Server reachable' : 'Server error ' + r.status;
  } catch {
    dot.className = 'dot dot-off';
    dot.title = 'Server not reachable — is python app.py running?';
  }
}

// ---------------------------------------------------------------------------
// JSON extraction helpers
// ---------------------------------------------------------------------------

/** Read window.UGAPP.store.page.data directly from a live page. */
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

/** Extract the UGAPP JSON blob from raw HTML (brace-balanced parser). */
function parseDataFromHtml(html) {
  const marker = 'window.UGAPP.store.page.data = ';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('UGAPP data not found in page');
  let i = start + marker.length;
  while (i < html.length && html[i] !== '{') i++;
  const jsonStart = i;
  let depth = 0, inStr = false, esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      return JSON.parse(html.substring(jsonStart, i + 1));
    }
  }
  throw new Error('Could not parse UGAPP JSON');
}

/** Fetch a UG URL using the browser's own session cookies. */
async function fetchUgPage(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${url}`);
  return parseDataFromHtml(await resp.text());
}

/** Fetch a UG URL and return the raw HTML (for DOM/regex fallback). */
async function fetchHtml(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

// ---------------------------------------------------------------------------
// Tab-data normaliser (for individual tab pages)
// ---------------------------------------------------------------------------

function normaliseTabData(data, urlFallback) {
  const tab = data?.tab;
  const view = data?.tab_view;
  const content = view?.wiki_tab?.content;
  if (!content) throw new Error('No chord/tab content on this page');
  return {
    url:      tab?.tab_url || urlFallback,
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
// My Saved Tabs — multi-strategy URL extraction
// ---------------------------------------------------------------------------

const TAB_URL_RE = /https:\/\/tabs\.ultimate-guitar\.com\/tab\/[a-z0-9_-]+\/[a-z0-9_-]+-\d+/gi;

/** Walk any JS object tree looking for the first array that contains tab objects. */
function findTabsDeep(obj, depth = 0) {
  if (depth > 10 || obj === null || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === 'object' &&
        (obj[0]?.tab_url || obj[0]?.tabUrl || obj[0]?.marketing_type)) {
      return obj;
    }
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

/** Extract tab URLs from a page-data object, trying every known path + deep search. */
function urlsFromPageData(data) {
  if (!data) return [];

  // Hard-coded candidate paths (add new ones as UG changes their schema)
  const candidates = [
    data?.tabs,
    data?.data?.tabs,
    data?.user_tabs,
    data?.data?.user_tabs,
    data?.data?.user_data?.tabs,
    data?.store?.tabs,
    data?.profile?.tabs,
    data?.page?.tabs,
  ];
  for (const arr of candidates) {
    if (Array.isArray(arr) && arr.length > 0) {
      const urls = arr.map(t => t.tab_url || t.tabUrl || t.url).filter(Boolean);
      if (urls.length) return urls;
    }
  }

  // Deep recursive search
  const found = findTabsDeep(data);
  if (found) return found.map(t => t.tab_url || t.tabUrl || t.url).filter(Boolean);

  return [];
}

/** Pull tab URLs directly from the live page's DOM anchor tags. */
async function urlsFromDom(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const urls = new Set();
      document.querySelectorAll('a[href]').forEach(a => {
        const h = a.href || '';
        if (/tabs\.ultimate-guitar\.com\/tab\/[a-z0-9_-]+\/[a-z0-9_-]+-\d+/i.test(h)) {
          urls.add(h.split('?')[0]);
        }
      });
      return [...urls];
    },
  });
  return result || [];
}

/** Pull tab URLs from raw HTML via regex (last resort). */
function urlsFromHtmlRegex(html) {
  const found = new Set();
  let m;
  const re = new RegExp(TAB_URL_RE.source, 'gi');
  while ((m = re.exec(html)) !== null) found.add(m[0]);
  return [...found];
}

/** Detect the max page number from the live DOM (pagination links). */
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

/**
 * Master function: collect all saved-tab URLs across all pages.
 * Tries three strategies in order; whichever finds URLs first wins.
 */
async function getAllMyTabUrls(tabId) {
  const all = new Set();

  // --- Strategy 1: window.UGAPP page data (fastest, cleanest) ---
  let firstData = null;
  try { firstData = await readLivePageData(tabId); } catch {}
  if (firstData) {
    urlsFromPageData(firstData).forEach(u => all.add(u));
  }

  // --- Strategy 2: DOM anchor scraping (works even if UGAPP is empty) ---
  if (all.size === 0) {
    const domUrls = await urlsFromDom(tabId);
    domUrls.forEach(u => all.add(u));
  }

  // Figure out how many pages exist
  let totalPages = 1;
  // Try page data first
  const pg = firstData?.pagination || firstData?.data?.pagination;
  if (pg) totalPages = pg.total ?? pg.last_page ?? 1;
  // Fall back to DOM pagination links
  if (totalPages === 1) totalPages = await detectTotalPages(tabId);

  // Fetch and parse additional pages
  for (let p = 2; p <= totalPages; p++) {
    setProgress(all.size, all.size, `Loading page ${p} of ${totalPages}…`);
    try {
      const html = await fetchHtml(
        `https://www.ultimate-guitar.com/user/mytabs?page=${p}`
      );
      // Try UGAPP data first, then regex
      let pageUrls = [];
      try { pageUrls = urlsFromPageData(parseDataFromHtml(html)); } catch {}
      if (!pageUrls.length) pageUrls = urlsFromHtmlRegex(html);
      pageUrls.forEach(u => all.add(u));
    } catch (e) {
      appendLog('fail', `Page ${p}: ${e.message}`);
    }
    await delay(500);
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

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Import a list of tab URLs
// ---------------------------------------------------------------------------

async function importUrls(urls, { btnEl } = {}) {
  $('log').innerHTML = '';
  $('logSection').style.display = 'block';
  if (btnEl) btnEl.disabled = true;

  let done = 0;
  for (const url of urls) {
    setProgress(done, urls.length);
    try {
      const data   = await fetchUgPage(url);
      const tab    = normaliseTabData(data, url);
      const result = await postToServer(tab);
      appendLog(result.already_existed ? 'skip' : 'ok',
                `${tab.title} — ${tab.artist}`);
    } catch (e) {
      appendLog('fail', `${e.message}  [${url}]`);
    }
    done++;
    await delay(600);
  }

  setProgress(done, urls.length, `Done — ${done} tab${done !== 1 ? 's' : ''} processed.`);
  if (btnEl) {
    btnEl.disabled = false;
    btnEl.textContent = btnEl.dataset.label;
  }
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
  btn.disabled = true;
  btn.textContent = 'Saving…';
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

  // Quick count preview using all three strategies
  let count = 0;
  let pages = 1;
  try {
    let data = null;
    try { data = await readLivePageData(tab.id); } catch {}

    const fromData = data ? urlsFromPageData(data) : [];
    const fromDom  = await urlsFromDom(tab.id);

    count = Math.max(fromData.length, fromDom.length);

    const pg = data?.pagination || data?.data?.pagination;
    if (pg) pages = pg.total ?? pg.last_page ?? 1;
    if (pages === 1) pages = await detectTotalPages(tab.id);
  } catch {}

  if (count === 0 && pages === 1) {
    info.textContent = 'Could not detect tabs yet — try scrolling the page down then clicking the extension icon again.';
    btn.disabled = true;
    return;
  }

  info.textContent = pages > 1
    ? `Detected ${count} tabs on page 1 of ${pages} — will collect all pages on import.`
    : `Detected ${count} saved tabs.`;
  btn.disabled = false;
}

async function importMyTabs() {
  const btn = $('importMyTabsBtn');
  btn.dataset.label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Collecting URLs…';
  $('myTabsInfo').textContent = 'Scanning all pages…';
  $('log').innerHTML = '';

  try {
    const urls = await getAllMyTabUrls(currentTab.id);
    if (!urls.length) throw new Error('No tab URLs found on this page.');
    $('myTabsInfo').textContent = `Found ${urls.length} tabs — importing…`;
    await importUrls(urls, { btnEl: btn });
  } catch (e) {
    appendLog('fail', e.message);
    btn.disabled = false;
    btn.textContent = btn.dataset.label;
  }
}

// ---------------------------------------------------------------------------
// Mode: bulk URL textarea
// ---------------------------------------------------------------------------

async function bulkImport() {
  const lines = $('bulkUrls').value
    .split('\n')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#') && s.startsWith('http'));
  if (!lines.length) return;
  const btn = $('bulkBtn');
  btn.dataset.label = btn.textContent;
  await importUrls(lines, { btnEl: btn });
}

// ---------------------------------------------------------------------------
// Detect which UG page is active
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
