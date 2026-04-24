import re
from html import escape
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify

import database as db
import scraper

app = Flask(__name__)
app.secret_key = 'ug-local-secret-change-me'

db.init_db()


# ---------------------------------------------------------------------------
# Chord/tab content renderer
# ---------------------------------------------------------------------------

def render_content(raw: str) -> str:
    """Convert UG wiki markup to HTML, preserving whitespace layout."""
    # Escape HTML entities first (brackets are safe)
    out = escape(raw)

    # [ch]CHORD[/ch]  →  styled span
    out = re.sub(
        r'\[ch\](.*?)\[/ch\]',
        r'<span class="chord">\1</span>',
        out,
    )

    # [tab]...[/tab]  →  strip wrapper, keep content
    out = re.sub(r'\[tab\](.*?)\[/tab\]', r'\1', out, flags=re.DOTALL)

    # [Verse 1], [Chorus], [Bridge], etc.  →  section header
    out = re.sub(
        r'\[([^\]]+)\]',
        r'<span class="section">[\1]</span>',
        out,
    )

    return out


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    q = request.args.get('q', '').strip()
    songs = db.get_all_songs(search=q)
    return render_template('index.html', songs=songs, q=q)


@app.route('/song/<int:song_id>')
def song(song_id):
    s = db.get_song(song_id)
    if not s:
        flash('Song not found.', 'error')
        return redirect(url_for('index'))
    s['content_html'] = render_content(s['content'])
    return render_template('song.html', song=s)


@app.route('/song/<int:song_id>/delete', methods=['POST'])
def delete_song(song_id):
    s = db.get_song(song_id)
    if s:
        db.delete_song(song_id)
        flash(f'"{s["title"]}" removed.', 'info')
    return redirect(url_for('index'))


# --- Add by URL ----------------------------------------------------------

@app.route('/add/url', methods=['GET', 'POST'])
def add_by_url():
    if request.method == 'POST':
        url = request.form.get('url', '').strip()
        if not url:
            flash('Please enter a URL.', 'error')
            return render_template('add_url.html')
        if db.song_exists(url):
            flash('That tab is already in your library.', 'info')
            return redirect(url_for('index'))
        try:
            tab = scraper.fetch_tab_by_url(url)
            song_id = db.add_song(tab)
            flash(f'Added "{tab["title"]}" by {tab["artist"]}.', 'success')
            return redirect(url_for('song', song_id=song_id))
        except Exception as exc:
            flash(f'Error: {exc}', 'error')
    return render_template('add_url.html')


# --- Search & add --------------------------------------------------------

@app.route('/add/search', methods=['GET', 'POST'])
def add_by_search():
    results = None
    if request.method == 'POST':
        song_name = request.form.get('song', '').strip()
        artist_name = request.form.get('artist', '').strip()
        if not song_name:
            flash('Please enter a song name.', 'error')
        else:
            try:
                results = scraper.search_tabs(song_name, artist_name)
                if not results:
                    flash('No results found. Try a different search or add by URL.', 'info')
            except Exception as exc:
                flash(f'Search error: {exc}', 'error')
    return render_template('add_search.html', results=results)


@app.route('/add/fetch', methods=['POST'])
def fetch_and_add():
    """Fetch a tab from a search-result URL and store it."""
    url = request.form.get('url', '').strip()
    if not url:
        flash('No URL provided.', 'error')
        return redirect(url_for('add_by_search'))
    if db.song_exists(url):
        flash('That tab is already in your library.', 'info')
        return redirect(url_for('index'))
    try:
        tab = scraper.fetch_tab_by_url(url)
        song_id = db.add_song(tab)
        flash(f'Added "{tab["title"]}" by {tab["artist"]}.', 'success')
        return redirect(url_for('song', song_id=song_id))
    except Exception as exc:
        flash(f'Error fetching tab: {exc}', 'error')
        return redirect(url_for('add_by_search'))


# --- JSON API (for future dynamic/mobile use) ----------------------------

@app.route('/api/songs')
def api_songs():
    q = request.args.get('q', '').strip()
    return jsonify(db.get_all_songs(search=q))


@app.route('/api/song/<int:song_id>')
def api_song(song_id):
    s = db.get_song(song_id)
    if not s:
        return jsonify({'error': 'not found'}), 404
    return jsonify(s)


if __name__ == '__main__':
    # 0.0.0.0 makes the server reachable on your local network (phone, etc.)
    app.run(host='0.0.0.0', port=5000, debug=True)
