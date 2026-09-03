# Grok Chat Log Analytics

**Version: 1.0.1** (see [Version history](#version-history) below)

Local-first web app to **import X/xAI Grok data exports**, explore conversations, view analytics, recover media where possible, and export plain-text transcripts.

All parsing, statistics, and storage run **in your browser**. Chat content is not sent to a remote API for analysis.

---

## Features (current)

| Area | What it does |
|------|----------------|
| **Folder import** | Import the Grok export tree (`prod-grok-backend.json` + `prod-mc-asset-server`, etc.) |
| **JSON import** | Single-file JSON still works for simpler exports |
| **Titles** | Prefers Grok-generated conversation titles when present |
| **Explorer** | Search, filter by mode/model, read transcripts with markdown |
| **Thought process** | Cleans agent JSON, tool-usage cards, and glued step labels into readable lists |
| **Citations** | Turns `<grok:render …>` markers into chips linked to search results when available |
| **Images** | Links local assets (including extensionless / hex-encoded `content` files) |
| **Remote images** | **Retry Remote Images** — download working `https` URLs and save locally; failures left unchanged |
| **Branches** | Regeneration siblings with `‹ 1 / 2 ›` path switching |
| **Analytics** | Counts, activity patterns, model mix, keywords, recent chats |
| **Persistence** | IndexedDB (primary) + localStorage best-effort for smaller sets |
| **Text export** | Download the **active branch path** of the open chat as `.txt` (includes thought process when present) |

---

## Prerequisites

- [Node.js](https://nodejs.org/) (recent LTS recommended)

---

## Run locally

```bash
npm install
npm run dev
```

App defaults to **http://localhost:3000** (see `package.json` scripts).

Other scripts:

```bash
npm run build       # typecheck + production build → dist/
npm run preview     # preview production build
npm run lint        # tsc --noEmit
npm run clean       # remove dist/
npm run test:smoke  # lightweight smoke scripts (thinking / branches / images)
```

No API key is required for core use (import, analytics, local browsing).

---

## How to get a Grok export

1. Request your archive from **X / xAI** account data download (e.g. Settings → download your data, or [accounts.x.ai](https://accounts.x.ai) data controls — exact path may change).
2. Wait for the archive, download, and unzip.
3. Find a folder similar to:

   ```text
   ttl / 30d / export data / <id>/
     prod-grok-backend.json
     prod-mc-billing.json
     prod-mc-auth-mgmt-api.json
     prod-mc-asset-server/
       <asset-id>/
         content          # often no extension
         preview-image    # sometimes present
   ```

4. In the app, click **Import Export Folder** and select the **`<id>`** folder (the one that contains `prod-grok-backend.json` and `prod-mc-asset-server`).

You can also drop that folder (or a single `.json`) onto the window.

### Import tips

- Prefer the full folder so images under `prod-mc-asset-server` can link.
- After import, the success toast reports format, titles, assets decoded/linked, and branch points.
- **Retry Remote Images** (header or open-chat download icon) tries to fetch remaining `https` URLs and save successes to IndexedDB. CORS/expired links will fail in-browser; those items stay unchanged.

---

## Privacy

- Processing is **100% local** in the browser.
- Data is stored in **IndexedDB** / **localStorage** on your machine.
- Clearing browser site data or using **Clear** in the app removes cached logs.
- Remote image retry only contacts the image host URLs already present in your export.

---

## Known limits

- Official Grok zips often **do not include every image** that ever appeared in the product UI; missing `prod-mc-asset-server` files cannot be invented.
- Many CDN image URLs **block browser `fetch` (CORS)** even when they once rendered as `<img>`.
- Text export is **one conversation**, **active branch only**, **no image files**.
- Thought-process tool cards like `edit_memory` are summarized (not full personal diffs).

---

## Stack

- React 19 + TypeScript + Vite  
- Tailwind CSS 4  
- Lucide icons  
- Client-side IndexedDB for large archives and media blobs  

---

## Documentation

- [Documentation index](docs/index.md)
- [Architecture](docs/architecture.md)
- [Setup](docs/setup.md)
- [Usage](docs/usage.md)
- [Export formats](docs/export-formats.md)
- [Coding standards](docs/coding-standards.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Version history

Versions follow [semver](https://semver.org/)-style numbering (`MAJOR.MINOR.PATCH`).  
`package.json` version should match the **current** release noted at the top of this README.

### 1.0.1 — Project cleanup (2026-07)

Housekeeping only — no feature changes.

- Removed unused dependencies: `@google/genai`, `express`, `dotenv`, `motion`, `autoprefixer`, `esbuild`, `tsx`, `@types/express`
- Slimmed runtime deps to `react`, `react-dom`, `lucide-react` (Vite/Tailwind/TypeScript as devDependencies only)
- Deleted leftovers: AI Studio `metadata.json`, Gemini `.env.example`, empty `assets/`, debug screenshot, broken smoke scripts
- Branding: page title/meta, cleaned `vite.config.ts`, `src/vite-env.d.ts`, cross-platform `npm run clean`
- Added `npm run test:smoke` for kept smoke scripts

### 1.0.0 — Initial local Grok analytics release (2026-07)

Baseline product suitable for day-to-day use of a full X/xAI Grok data export.

**Import & data model**

- Folder import for `prod-grok-backend.json` + `prod-mc-asset-server` (and related JSON)
- Native wrapped Grok backend format (`conversation` / `responses` / `response`)
- Flat message-array fallbacks and generic JSON import
- Conversation titles from export metadata (not only first user prompt)
- IndexedDB persistence for large archives; localStorage best-effort; sample data restore

**Transcript UX**

- Conversations explorer: search, mode/model filters, markdown rendering
- Thought process cleanup: unwrap agent JSON, humanize step lists
- Tool-usage card cleanup (`<xai:tool_usage_card>`) → short summaries (e.g. web search queries); privacy-safe `edit_memory` line
- Inline citations from `<grok:render …>` with links when search results exist
- Regeneration branches: `parent_response_id` DAG, `‹ 1 / 2 ›` switcher (active path only)
- Plain-text export of the open chat’s **active path** (includes formatted thought process)

**Media**

- Local assets: index UUID folders, prefer `preview-image` / `content`
- Decode raw, hex-encoded, and base64 image payloads; correct MIME for `blob:` URLs
- Richer attachment field extraction (`generated_image_urls`, `file_attachments`, `card_attachments_json`, steps, etc.)
- **Retry Remote Images**: fetch working remote URLs, save successes to IndexedDB; leave failures unchanged; report CORS/HTTP stats

**Analytics & shell**

- Dashboard: stats, activity patterns, model distribution, keywords, recent chats
- Drag-and-drop folder/JSON import, empty states, How to Export guide
- Project docs and TypeScript React types (`@types/react`, `@types/react-dom`) for IDE support

**Fixes along the way (pre–1.0 hardening)**

- Message body no longer dumps full export JSON when `content: null` and `message` is set
- Branch switcher no longer appends non-selected regenerations (arrows actually switch path)
- Thought panel no longer shows raw agent object dumps or tool XML

### Unreleased / planned (later versions)

Tracked as optional roadmap below — not part of 1.0.0.

---

## Later versions / optional roadmap

Not required for current use; good candidates for **future releases** (e.g. 1.1.x / 1.2.x). Update this list and the [Version history](#version-history) when shipping.

### High value

- **ZIP export with images** — transcript (Markdown/HTML) + `images/` folder from local assets  
- **“Missing media” report** — list chats with remote-only or failed fetches  
- Copy / empty-state / How to Export polish  

### Medium

- Text/ZIP option to **include all regenerations** (not only active path)  
- Per-image **Retry** control (bulk retry already exists)  
- Remove unused template dependencies if packaging for a leaner install  

### Nice-to-have

- Search that jumps to a specific message  
- Settings / theming beyond the default dark theme  
- Automated tests for parser and import fixtures  

### Probably skip unless needed

- CORS-busting proxy (extra server, privacy complexity)  
- Scraping live grok.com while logged in  

---

## Project layout (source)

```text
src/
  App.tsx                 # Shell, import, persistence, remote-image retry
  components/
    Dashboard.tsx         # Analytics
    ChatExplorer.tsx      # Browse / branches / export
    markdown/
      MessageContent.tsx  # Markdown, citations, images
  utils/
    parser.ts             # Generic + repair paths
    grokBackend.ts        # Native prod-grok-backend format
    archiveImport.ts      # Folder ingest + asset materialization
    formatThinking.ts     # Thought-process cleanup
    branchTree.ts         # Regeneration paths
    downloadRemoteImages.ts
    assetDecode.ts
    storage.ts            # IndexedDB
  data/sampleData.ts      # Demo conversations
  types.ts
```

---

## License / origin

Originally scaffolded from a Google AI Studio-style React template; the app has
been adapted for **local Grok export analytics**. Licensed under the MIT
License; see [LICENSE](LICENSE).
