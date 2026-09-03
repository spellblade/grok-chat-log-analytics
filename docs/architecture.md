# Architecture

Grok Chat Log Analytics is a client-side React application built with Vite.
Parsing, analytics, rendering, and persistence run in the browser.

## Data flow

```text
Grok JSON/folder export
        │
        ▼
archiveImport / grokBackend / parser
        │
        ▼
Conversation and Message model
        ├── Dashboard analytics
        ├── ChatExplorer transcript and branches
        └── IndexedDB persistence and media blobs
```

The existing source layout is intentionally preserved. `App.tsx` owns the
application shell and import lifecycle; `components/` owns UI; `utils/` owns
parsing, branch, media, rendering, and storage behavior.
