// ChordBook Grabber — popup script
// Pulls UG tab JSON from the page (or by fetching) and POSTs it to the
// local Flask server at /api/import.

const $ = (id) => document.getElementById(id);

let serverUrl = 'http://localhost:5000';
let currentTab = null;
let currentTabData = null;

// ---------------------------------------------------------------------------
// Settings persistence
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
    if (r.ok) { dot.className = 'dot dot-ok'; dot.title = 'Server reachable'; }
    else      { dot.className = 'dot dot-off'; dot.title = 'Server error ' + r.status; }
  } catch (e) {
    dot.className = 'dot dot-off';
    dot.title = 'Server unreachable — is python app.py running?';
  }
}

// ---------------------------------------------------------------------------
// Scrape helpers
// ---------------------------------------------------------------------------

/** Extract & normalise tab data from the raw window.UGAPP.store.page.data object. */
function normaliseTabData(data, urlFallback) {
  const tab = data?.tab;
  const view = data?.tab_view;
  const content = view?.wiki_tab?.content;
  if (!content) throw new Error('No chord/tab content found on this page.');

  return {
    url:      tab?.tab_url || urlFallback,
    title:    (tab?.song_name || '').trim(),
    artist:   (tab?.artist_name || '').trim(),
    tab_type: tab?.type_name || 'Chords',
    content:  content,
    key:      view?.meta?.tonality || '',
    capo:     view?.meta?.capo || 0,
    rating:   tab?.rating || 0,
    votes:    tab?.votes || 0,
  };
}

/** Given raw HTML from a UG page, extract the window.UGAPP.store.page.data JSON. */
function parseTabDataFromHtml(html) {
  const marker = 'window.UGAPP.store.page.data = ';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('UGAPP data block not found in page');

  let i = start + marker.length;
  while (i < html.length && html[i] !== '{') i++;
  if (i >= html.length) throw new Error('JSON start not found');

  const jsonStart = i;
  let depth = 0, inString = false, escape = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(html.substring(jsonStart, i + 1));
    }
  }
  throw new Error('Unterminated JSON in page');
}

/** Pull the page data from the currently active tab's own window.UGAPP object. */
async function readCurrentPageData(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const d = window.UGAPP?.store?.page?.data;
      return d ? JSON.parse(JSON.stringify(d)) : null;
    },
  });
  return results[0]?.result || null;
}

/** Fetch a UG URL using the browser's session cookies and extract its data. */
async function fetchAndParse(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  return parseTabDataFromHtml(html);
}

/** POST a tab object to the ChordBook server. */
async function postToServer(tab) {
  const resp = await fetch(serverUrl + '/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tab),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body.ok) throw new Error(body.error || `HTTP ${resp.status}`);
  return body;
}

// ---------------------------------------------------------------------------
// Current-tab flow
// ---------------------------------------------------------------------------

async function setupCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  const info = $('currentPageInfo');
  const btn = $('saveCurrentBtn');

  if (!tab?.url?.includes('ultimate-guitar.com/tab/')) {
    info.textContent = 'Not on a UG tab page. Navigate to any tab URL to enable single-page save.';
    btn.disabled = true;
    return;
  }

  try {
    const raw = await readCurrentPageData(tab.id);
    if (!raw) throw new Error('page data not loaded yet — refresh the tab');
    currentTabData = normaliseTabData(raw, tab.url);
    info.classList.add('ok');
    info.innerHTML = `<strong>${currentTabData.title}</strong><br>${currentTabData.artist}`;
    btn.disabled = false;
  } catch (e) {
    info.textContent = 'Could not read page data: ' + e.message;
    btn.disabled = true;
  }
}

async function saveCurrentPage() {
  const btn = $('saveCurrentBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const result = await postToServer(currentTabData);
    btn.textContent = result.already_existed ? 'Updated ✓' : 'Saved ✓';
    setTimeout(() => { btn.textContent = 'Save This Page'; btn.disabled = false; }, 1500);
  } catch (e) {
    btn.textContent = 'Failed — ' + e.message;
    setTimeout(() => { btn.textContent = 'Save This Page'; btn.disabled = false; }, 3000);
  }
}

// ---------------------------------------------------------------------------
// Bulk import flow
// ---------------------------------------------------------------------------

function appendLog(status, msg) {
  const li = document.createElement('li');
  li.className = 'log-' + status;
  li.textContent = `[${status}] ${msg}`;
  $('log').insertBefore(li, $('log').firstChild);
}

async function bulkImport() {
  const raw = $('bulkUrls').value;
  const lines = raw.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  if (!lines.length) return;

  $('logSection').style.display = 'block';
  $('log').innerHTML = '';
  $('bulkBtn').disabled = true;
  $('bulkBtn').textContent = 'Importing…';

  let done = 0;
  const total = lines.length;
  const updateProgress = () => {
    $('progressFill').style.width = Math.round(done / total * 100) + '%';
    $('progressText').textContent = `${done} / ${total}`;
  };
  updateProgress();

  for (const line of lines) {
    try {
      const raw = await fetchAndParse(line);
      const tab = normaliseTabData(raw, line);
      const result = await postToServer(tab);
      appendLog(result.already_existed ? 'skip' : 'ok',
                `${tab.title} — ${tab.artist}`);
    } catch (e) {
      appendLog('fail', `${line}  →  ${e.message}`);
    }
    done++;
    updateProgress();
    // small delay — be polite to UG even though it's our own browser
    await new Promise(r => setTimeout(r, 400));
  }

  $('bulkBtn').disabled = false;
  $('bulkBtn').textContent = 'Import All';
  $('progressText').textContent = `Done — ${done} processed.`;
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  $('openLibrary').href = serverUrl + '/';
  pingServer();
  setupCurrentTab();

  $('serverUrl').addEventListener('change', saveServerUrl);
  $('saveCurrentBtn').addEventListener('click', saveCurrentPage);
  $('bulkBtn').addEventListener('click', bulkImport);
});
