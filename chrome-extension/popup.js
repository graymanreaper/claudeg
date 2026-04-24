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
// My Saved Tabs — URL extraction + pagination
// ---------------------------------------------------------------------------

/** Pull tab URLs out of a /user/mytabs page-data object (handles several layouts). */
function extractTabUrlsFromPageData(data) {
  // UG embeds saved-tab lists under various keys — try the most common ones
  const candidates = [
    data?.data?.tabs,
    data?.tabs,
    data?.user_tabs,
    data?.data?.user_data?.tabs,
  ];
  for (const arr of candidates) {
    if (Array.isArray(arr) && arr.length > 0) {
      return arr
        .map(t => t.tab_url || t.tabUrl || t.url)
        .filter(Boolean);
    }
  }
  return [];
}

/** Collect saved-tab URLs across all pagination pages. */
async function getAllMyTabUrls(currentTabId) {
  // Page 1 comes from the already-loaded browser tab (faster, avoids refetch)
  const firstData = await readLivePageData(currentTabId);
  if (!firstData) throw new Error('Could not read page data — try refreshing the tab');

  const allUrls = extractTabUrlsFromPageData(firstData);

  // Pagination: try common key paths
  const pagination = firstData?.pagination
                  || firstData?.data?.pagination;
  const totalPages = pagination?.total ?? pagination?.last_page ?? 1;

  for (let page = 2; page <= totalPages; page++) {
    setProgress(0, 0, `Loading page ${page} of ${totalPages}…`);
    const data = await fetchUgPage(
      `https://www.ultimate-guitar.com/user/mytabs?page=${page}`
    );
    allUrls.push(...extractTabUrlsFromPageData(data));
    await delay(400);
  }

  return allUrls;
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

async function importUrls(urls, { disableBtn, btnEl }) {
  $('log').innerHTML = '';
  $('logSection').style.display = 'block';
  if (btnEl) { btnEl.disabled = true; disableBtn && (btnEl.textContent = 'Importing…'); }

  let done = 0;
  for (const url of urls) {
    setProgress(done, urls.length);
    try {
      const data  = await fetchUgPage(url);
      const tab   = normaliseTabData(data, url);
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

  // Peek at page count without blocking the UI
  try {
    const data = await readLivePageData(tab.id);
    const urls = extractTabUrlsFromPageData(data);
    const pagination = data?.pagination || data?.data?.pagination;
    const totalPages = pagination?.total ?? pagination?.last_page ?? 1;
    const perPage = urls.length;
    const estTotal = totalPages > 1
      ? `~${perPage * (totalPages - 1) + urls.length}` // rough until all pages loaded
      : String(urls.length);
    info.textContent = `Found ${estTotal} saved tabs across ${totalPages} page${totalPages !== 1 ? 's' : ''}.`;
    if (urls.length === 0) {
      info.textContent = 'Could not read tab list from this page. Try refreshing.';
      $('importMyTabsBtn').disabled = true;
    }
  } catch (e) {
    info.textContent = 'Error reading page: ' + e.message;
    $('importMyTabsBtn').disabled = true;
  }
}

async function importMyTabs() {
  const btn = $('importMyTabsBtn');
  btn.disabled = true;
  btn.textContent = 'Collecting URLs…';
  $('myTabsInfo').textContent = 'Scanning all pages…';

  try {
    const urls = await getAllMyTabUrls(currentTab.id);
    $('myTabsInfo').textContent = `Found ${urls.length} tabs — importing…`;
    await importUrls(urls, { disableBtn: true, btnEl: btn });
    btn.dataset.label = 'Import All My Saved Tabs';
  } catch (e) {
    appendLog('fail', e.message);
    btn.disabled = false;
    btn.textContent = 'Import All My Saved Tabs';
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
  await importUrls(lines, { disableBtn: true, btnEl: btn });
}

// ---------------------------------------------------------------------------
// Detect which page type is active and show the right section
// ---------------------------------------------------------------------------

async function detectPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  const url = tab?.url || '';

  if (url.includes('ultimate-guitar.com/user/mytabs')) {
    setupMyTabsMode(tab);
  } else if (url.includes('ultimate-guitar.com/tab/') ||
             url.includes('ultimate-guitar.com/tabs/')) {
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
  $('importMyTabsBtn').addEventListener('click', importMyTabs);
  $('bulkBtn').dataset.label = $('bulkBtn').textContent;
  $('bulkBtn').addEventListener('click', bulkImport);
});
