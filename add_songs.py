#!/usr/bin/env python3
"""
Batch import songs into ChordBook.

Usage:
  python add_songs.py songs.csv          # from CSV file (title,artist or title,artist,url)
  python add_songs.py --url <UG-url>     # single URL
  python add_songs.py --search "Song" "Artist"  # search and add best match

CSV format (no header row needed):
  Deep Satin,Zach Bryan
  Fast Car,Tracy Chapman
  Blinding Lights,The Weeknd
  Some Song,Artist,https://tabs.ultimate-guitar.com/tab/...  # optional direct URL

Lines starting with # are treated as comments.
"""

import argparse
import csv
import sys
import time

import database as db
import scraper

db.init_db()


def add_from_url(url: str) -> bool:
    if db.song_exists(url):
        print(f"  [skip]  Already in library: {url}")
        return True
    try:
        tab = scraper.fetch_tab_by_url(url)
        db.add_song(tab)
        print(f"  [ok]    {tab['title']} — {tab['artist']}")
        return True
    except Exception as exc:
        print(f"  [fail]  {url} → {exc}")
        return False


def add_from_search(song_name: str, artist_name: str = '') -> bool:
    label = f"{song_name}" + (f" — {artist_name}" if artist_name else "")
    print(f"  Searching: {label}")
    try:
        tab = scraper.auto_add_song(song_name, artist_name)
        if db.song_exists(tab['url']):
            print(f"  [skip]  Already in library: {tab['title']}")
            return True
        db.add_song(tab)
        print(f"  [ok]    {tab['title']} — {tab['artist']}")
        return True
    except Exception as exc:
        print(f"  [fail]  {label} → {exc}")
        return False


def process_csv(path: str):
    ok = fail = skip = 0
    with open(path, newline='', encoding='utf-8') as f:
        for row in csv.reader(f):
            if not row or row[0].startswith('#'):
                continue
            row = [c.strip() for c in row]
            title = row[0] if len(row) > 0 else ''
            artist = row[1] if len(row) > 1 else ''
            url = row[2] if len(row) > 2 else ''

            if not title:
                continue

            if url:
                result = add_from_url(url)
            else:
                result = add_from_search(title, artist)

            if result:
                ok += 1
            else:
                fail += 1

            time.sleep(1.0)  # polite delay between requests

    print(f"\nDone — {ok} added, {fail} failed.")


def main():
    parser = argparse.ArgumentParser(description='Batch-add songs to ChordBook')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('csv_file', nargs='?', help='CSV file of songs to import')
    group.add_argument('--url', help='Add a single tab by URL')
    group.add_argument('--search', nargs='+', metavar=('SONG', 'ARTIST'),
                       help='Search and add best match (1 or 2 args)')
    args = parser.parse_args()

    if args.url:
        add_from_url(args.url)
    elif args.search:
        song = args.search[0]
        artist = args.search[1] if len(args.search) > 1 else ''
        add_from_search(song, artist)
    elif args.csv_file:
        process_csv(args.csv_file)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()
