# Contributing

## Development setup

1. Install a current Node.js LTS release.
2. Run `npm install`.
3. Start the app with `npm run dev`.

## Validation

Before opening a change, run:

```bash
npm run lint
npm run test:smoke
npm run build
```

Changes should preserve the local-first privacy model and existing import
behavior. Do not commit exported chat data, credentials, generated build
output, or local editor files.

## Commit style

Use short imperative commit subjects with a conventional prefix, for example:

- `feat: add conversation export`
- `fix: preserve branch selection`
- `docs: clarify folder import`
- `chore: update project metadata`

Keep unrelated refactors out of feature or bug-fix changes.
