# ChordBook Grabber — Chrome Extension

Save Ultimate Guitar tabs to your local ChordBook server with one click.
Uses your *real* browser session so you don't need cookies, API keys, or
anything else — if you can see the tab in your browser, the extension
can save it.

## Install (one time, ~30 seconds)

1. Make sure your Flask server is running: `python app.py`
2. Open Chrome and go to `chrome://extensions/`
3. In the top-right, enable **Developer mode**
4. Click **Load unpacked**
5. Navigate to `claudeg/chrome-extension` and select that folder
6. The "ChordBook Grabber" icon now appears in your toolbar
   (pin it via the puzzle-piece icon so it's always visible)

## Use

### Save the page you're on
1. On any UG tab page (e.g. `tabs.ultimate-guitar.com/tab/...`), click the
   ChordBook icon in your toolbar.
2. The popup shows the song name and artist.
3. Click **Save This Page**. Done.

### Bulk import (100+ songs)
1. Click the ChordBook icon anywhere.
2. Paste URLs one per line into the textarea.
3. Click **Import All**. Progress bar + live log shows each one.

## Notes

- The green dot next to "Server:" shows whether your local Flask server
  is reachable. Grey = server not running.
- Default server is `http://localhost:5000`. If you run the server on
  another port or on a different machine, edit the Server field.
- Because the extension runs in *your* browser, UG Pro content and
  Cloudflare challenges are handled transparently — you're already
  logged in.
- The extension never sees your UG password, and ChordBook never needs
  your session cookie.
