# Export Ultimate Guitar Favourites

A Tampermonkey userscript for exporting saved Ultimate Guitar tabs from `https://www.ultimate-guitar.com/user/mytabs` into a local JSON library.

## Why?

This was made so I could use it with [Freetar](https://github.com/kmille/freetar) - an open source alternative front-end to ultimate-guitar.com
Export your favourites tabs into a .JSON file for import into Freetar :)

## Features

- Incremental caching of previously parsed tabs
- Export full merged library or only currently visible tabs
- Hide/show UI button
- Cancel current export
- Lightweight UI designed to reduce Firefox slowdown

## Installation

1. Install Tampermonkey in Firefox
2. Create a new userscript
3. Paste the contents of `ug-mytabs-exporter.user.js`
4. Open `https://www.ultimate-guitar.com/user/mytabs`
5. Use the on-page buttons or Tampermonkey menu commands

## Export format

The script exports a JSON object keyed by tab path, for example:

```json
{
  "/tab/example-artist/example-song-chords-123456": {
    "artist_name": "Example Artist",
    "song": "Example Song",
    "type": "Chords",
    "rating": "",
    "tab_url": "/tab/example-artist/example-song-chords-123456",
    "chord_text": "Example chord text here",
    "cached_at": "2026-04-07T12:00:00.000Z",
    "parse_status": "ok"
  }
}
```

## How to Use with Freetar

1. Open your Freetar Instance
2. Open 'Advanced' dropdown at the bottom of the page
3. Import the .JSON file
4. And that's about it! Play to your hearts content :)

