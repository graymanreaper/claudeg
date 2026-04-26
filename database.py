import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(os.environ.get('CHORDBOOK_DB',
                              Path(__file__).parent / 'songs.db'))

SCHEMA = """
CREATE TABLE IF NOT EXISTS songs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    artist      TEXT    NOT NULL,
    url         TEXT    UNIQUE,
    tab_type    TEXT    DEFAULT 'Chords',
    content     TEXT    NOT NULL,
    key         TEXT    DEFAULT '',
    capo        INTEGER DEFAULT 0,
    rating      REAL    DEFAULT 0.0,
    votes       INTEGER DEFAULT 0,
    added_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_artist ON songs(artist COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_title  ON songs(title  COLLATE NOCASE);
"""


@contextmanager
def _conn():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init_db():
    with _conn() as con:
        con.executescript(SCHEMA)


def add_song(song: dict) -> int:
    """Insert or replace a song; returns the row id."""
    with _conn() as con:
        cur = con.execute(
            """
            INSERT INTO songs (title, artist, url, tab_type, content, key, capo, rating, votes)
            VALUES (:title, :artist, :url, :tab_type, :content, :key, :capo, :rating, :votes)
            ON CONFLICT(url) DO UPDATE SET
                title    = excluded.title,
                artist   = excluded.artist,
                tab_type = excluded.tab_type,
                content  = excluded.content,
                key      = excluded.key,
                capo     = excluded.capo,
                rating   = excluded.rating,
                votes    = excluded.votes
            """,
            song,
        )
        return cur.lastrowid


def get_all_songs(search: str = '') -> list[dict]:
    with _conn() as con:
        if search:
            like = f'%{search}%'
            rows = con.execute(
                """SELECT id, title, artist, tab_type, key, capo, rating, votes, added_at
                   FROM songs
                   WHERE title LIKE ? OR artist LIKE ?
                   ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE""",
                (like, like),
            ).fetchall()
        else:
            rows = con.execute(
                """SELECT id, title, artist, tab_type, key, capo, rating, votes, added_at
                   FROM songs
                   ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE"""
            ).fetchall()
        return [dict(r) for r in rows]


def get_song(song_id: int) -> dict | None:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM songs WHERE id = ?", (song_id,)
        ).fetchone()
        return dict(row) if row else None


def delete_song(song_id: int):
    with _conn() as con:
        con.execute("DELETE FROM songs WHERE id = ?", (song_id,))


def song_exists(url: str) -> bool:
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM songs WHERE url = ?", (url,)
        ).fetchone()
        return row is not None
