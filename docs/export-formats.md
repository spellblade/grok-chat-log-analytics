# Export formats

The importer primarily supports the wrapped Grok backend export:

```text
<export-root>/
├── prod-grok-backend.json
└── prod-mc-asset-server/
    └── <asset-id>/
        ├── content
        └── preview-image
```

Single JSON imports and flatter message-array formats are also supported.
Images may be local assets, remote URLs, or unavailable if the official export
did not include them. CORS and expired URLs can prevent browser retry.

The current transcript export is a `.txt` file containing the active branch
path and formatted thought process when available. It does not package image
files or inactive regenerations.
