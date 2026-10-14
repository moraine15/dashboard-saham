# Third-party notices

The project's own code is under the MIT License (see [LICENSE](LICENSE)). It also uses
the third-party work listed here.

## Included in this repository

### IBM Plex Sans

- Files: `static/fonts/IBMPlexSans-*.woff2`. These are the split WOFF2 files IBM publishes in
  the `@ibm/plex-sans` 1.1.0 package, unmodified.
- Copyright © 2017 IBM Corp. with Reserved Font Name "Plex".
- License: SIL Open Font License, Version 1.1. The full text is in `static/fonts/license.txt`.

## Loaded by the browser

### TradingView Lightweight Charts

- Version 4.1.3, loaded from unpkg.com with a Subresource Integrity check. It is not stored in
  this repository.
- License: Apache License 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>).
- Its license asks every product that uses it to show TradingView's attribution notice and a
  link to <https://www.tradingview.com/>. The app shows both under Pengaturan › Tentang. The
  notice:

  > TradingView Lightweight Charts™<br>
  > Copyright (c) 2023 TradingView, Inc. https://www.tradingview.com/

## Installed with pip (not included here)

| Package | License | Used for |
|---|---|---|
| Flask | BSD-3-Clause | Web app |
| Waitress | ZPL 2.1 | Web server |
| yfinance | Apache License 2.0 | Market data from Yahoo Finance |
| pandas | BSD-3-Clause | Price series and indicators |
| NumPy | BSD-3-Clause | Numerics |
| Requests | Apache License 2.0 | News feeds and local AI servers |
| zeroconf (optional) | LGPL-2.1-or-later | `MDNS_NAME` network name |
| anthropic (optional) | MIT | Claude API |

## Data sources

- **Yahoo Finance**, through yfinance. yfinance is an independent project, not affiliated with or
  endorsed by Yahoo. Yahoo's data is meant for personal use; read Yahoo's terms before using it
  for anything else. IDX quotes are delayed by about 15 minutes.
- **Google News RSS** for headlines. Headlines and articles belong to their publishers; the app
  only links to them.
