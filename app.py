import os
import re
import threading
import time
import uuid
from pathlib import Path
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
    out = escape(raw)
    out = re.sub(r'\[ch\](.*?)\[/ch\]', r'<span class="chord">\1</span>', out)
    out = re.sub(r'\[tab\](.*?)\[/tab\]', r'\1', out, flags=re.DOTALL)
    out = re.sub(r'\[([^\]]+)\]', r'<span class="section">[\1]</span>', out)
    return out


# ---------------------------------------------------------------------------
# Background bulk-import job tracker
# ---------------------------------------------------------------------------

_jobs: dict[str, dict] = {}


def _run_import(job_id: str, lines: list[str]):
    job = _jobs[job_id]
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            if line.startswith('http'):
                # Treat as a direct URL
                if db.song_exists(line):
                    job['results'].append({'input': line, 'status': 'skip', 'msg': 'Already in library'})
                else:
                    tab = scraper.fetch_tab_by_url(line)
                    db.add_song(tab)
                    job['results'].append({'input': line, 'status': 'ok',
                                           'msg': f"{tab['title']} — {tab['artist']}"})
            else:
                # Treat as "Song Name, Artist" search
                parts = [p.strip() for p in line.split(',', 1)]
                song_name = parts[0]
                artist_name = parts[1] if len(parts) > 1 else ''
                tab = scraper.auto_add_song(song_name, artist_name)
                if db.song_exists(tab['url']):
                    job['results'].append({'input': line, 'status': 'skip', 'msg': 'Already in library'})
                else:
                    db.add_song(tab)
                    job['results'].append({'input': line, 'status': 'ok',
                                           'msg': f"{tab['title']} — {tab['artist']}"})
        except Exception as exc:
            job['results'].append({'input': line, 'status': 'fail', 'msg': str(exc)})

        job['done'] += 1
        time.sleep(1.2)  # polite delay between requests

    job['status'] = 'done'


# ---------------------------------------------------------------------------
# Routes — Library
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


# ---------------------------------------------------------------------------
# Routes — Add single song
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Routes — Bulk import
# ---------------------------------------------------------------------------

@app.route('/add/bulk', methods=['GET', 'POST'])
def add_bulk():
    if request.method == 'POST':
        raw = request.form.get('urls', '').strip()
        lines = [ln.strip() for ln in raw.splitlines() if ln.strip() and not ln.startswith('#')]
        if not lines:
            flash('No entries provided.', 'error')
            return render_template('add_bulk.html')
        job_id = str(uuid.uuid4())
        _jobs[job_id] = {'status': 'running', 'results': [], 'total': len(lines), 'done': 0}
        threading.Thread(target=_run_import, args=(job_id, lines), daemon=True).start()
        return redirect(url_for('bulk_progress', job_id=job_id))
    return render_template('add_bulk.html')


@app.route('/add/bulk/<job_id>')
def bulk_progress(job_id):
    if job_id not in _jobs:
        flash('Import job not found.', 'error')
        return redirect(url_for('add_bulk'))
    return render_template('bulk_progress.html', job_id=job_id)


@app.route('/add/bulk/<job_id>/status')
def bulk_status(job_id):
    job = _jobs.get(job_id)
    if not job:
        return jsonify({'error': 'not found'}), 404
    return jsonify(job)


# ---------------------------------------------------------------------------
# Routes — Settings (cookie management)
# ---------------------------------------------------------------------------

@app.route('/settings', methods=['GET', 'POST'])
def settings():
    if request.method == 'POST':
        cookie = request.form.get('cookie', '').strip()
        if cookie:
            cookies_file = Path(__file__).parent / 'cookies.txt'
            cookies_file.write_text(cookie, encoding='utf-8')
            scraper.reload_cookies()
            flash('Cookie saved — scraper session updated.', 'success')
        else:
            flash('No cookie value provided.', 'error')
        return redirect(url_for('settings'))
    return render_template('settings.html', cookie_loaded=bool(scraper._cookie_header))


# ---------------------------------------------------------------------------
# JSON API — used by the Chrome extension and future mobile clients
# ---------------------------------------------------------------------------

@app.after_request
def add_cors(response):
    """Allow the Chrome extension (and any local client) to call /api/* ."""
    if request.path.startswith('/api/'):
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response


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


@app.route('/api/import', methods=['POST', 'OPTIONS'])
def api_import():
    """Accept a pre-scraped tab object from the Chrome extension."""
    if request.method == 'OPTIONS':
        return '', 204

    data = request.get_json(silent=True) or {}
    required = ('url', 'title', 'artist', 'content')
    missing = [k for k in required if not data.get(k)]
    if missing:
        return jsonify({'ok': False, 'error': f'missing fields: {", ".join(missing)}'}), 400

    song = {
        'url':       data['url'],
        'title':     data['title'].strip(),
        'artist':    data['artist'].strip(),
        'tab_type':  data.get('tab_type') or 'Chords',
        'content':   data['content'],
        'key':       data.get('key') or '',
        'capo':      int(data.get('capo') or 0),
        'rating':    float(data.get('rating') or 0.0),
        'votes':     int(data.get('votes') or 0),
    }
    already = db.song_exists(song['url'])
    song_id = db.add_song(song)
    return jsonify({
        'ok': True,
        'song_id': song_id,
        'already_existed': already,
        'title': song['title'],
        'artist': song['artist'],
    })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
