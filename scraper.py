import json
import re
import time
import requests
from urllib.parse import quote_plus

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def _extract_page_data(html: str) -> dict | None:
    """Pull the embedded JSON blob out of a UG page."""
    marker = 'window.UGAPP.store.page.data = '
    idx = html.find(marker)
    if idx == -1:
        return None
    json_str = html[idx + len(marker):]
    try:
        data, _ = json.JSONDecoder().raw_decode(json_str)
        return data
    except json.JSONDecodeError:
        return None


def fetch_tab_by_url(url: str) -> dict:
    """
    Fetch chord/tab data for a specific Ultimate Guitar URL.
    Returns a dict with: title, artist, url, tab_type, content,
    key, capo, rating, votes.
    Raises ValueError if the page can't be parsed.
    """
    resp = SESSION.get(url, timeout=15)
    resp.raise_for_status()

    data = _extract_page_data(resp.text)
    if not data:
        raise ValueError(f"Could not extract tab data from {url}. "
                         "The page may be protected or the URL is invalid.")

    tab = data.get('tab', {})
    tab_view = data.get('tab_view', {})
    meta = tab_view.get('meta', {})
    content = tab_view.get('wiki_tab', {}).get('content', '')

    if not content:
        raise ValueError(f"No chord/tab content found at {url}.")

    return {
        'title': tab.get('song_name', '').strip(),
        'artist': tab.get('artist_name', '').strip(),
        'url': url,
        'tab_type': tab.get('type_name', 'Chords'),
        'content': content,
        'key': meta.get('tonality', ''),
        'capo': meta.get('capo') or 0,
        'rating': tab.get('rating', 0.0),
        'votes': tab.get('votes', 0),
    }


def search_tabs(song_name: str, artist_name: str = '', preferred_type: str = 'Chords') -> list[dict]:
    """
    Search Ultimate Guitar for a song.  Returns a list of result dicts sorted
    by type preference and rating:
        [{'title', 'artist', 'url', 'tab_type', 'rating', 'votes'}, ...]

    Note: UG's search page is served behind Cloudflare so this may occasionally
    return an empty list.  In that case, add the tab directly by URL.
    """
    query = quote_plus(song_name)
    search_url = f'https://www.ultimate-guitar.com/search.php?search_type=title&value={query}'
    if artist_name:
        search_url += f'&bands={quote_plus(artist_name)}'

    try:
        resp = SESSION.get(search_url, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise ConnectionError(f"Search request failed: {exc}") from exc

    data = _extract_page_data(resp.text)
    if not data:
        return []

    raw_results = data.get('results', [])
    if not raw_results:
        # Some pages nest it differently
        raw_results = data.get('data', {}).get('results', [])

    TYPE_ORDER = {'Official': 0, 'Chords': 1, 'Tab': 2, 'Pro': 3}

    results = []
    for r in raw_results:
        tab_type = r.get('type', '')
        tab_url = r.get('tab_url', '')
        if not tab_url or tab_type in ('Video', 'Power', 'Bass'):
            continue
        results.append({
            'title': r.get('song_name', '').strip(),
            'artist': r.get('artist_name', '').strip(),
            'url': tab_url,
            'tab_type': tab_type,
            'rating': r.get('rating', 0.0),
            'votes': r.get('votes', 0),
        })

    results.sort(key=lambda r: (
        TYPE_ORDER.get(r['tab_type'], 99),
        -r['rating'],
        -r['votes'],
    ))
    return results


def auto_add_song(song_name: str, artist_name: str = '') -> dict:
    """
    Search for a song and fetch the best matching tab automatically.
    Returns the same dict as fetch_tab_by_url().
    Raises ValueError / ConnectionError on failure.
    """
    results = search_tabs(song_name, artist_name)
    if not results:
        raise ValueError(
            f"No tabs found for '{song_name}'"
            + (f" by {artist_name}" if artist_name else "")
            + ". Try adding by URL instead."
        )
    best = results[0]
    time.sleep(0.5)  # small courtesy delay
    return fetch_tab_by_url(best['url'])
