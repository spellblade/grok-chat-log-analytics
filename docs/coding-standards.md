# Coding standards

- Use TypeScript and existing project conventions.
- Keep React UI concerns in `components/` and data/import concerns in `utils/`.
- Prefer typed interfaces from `src/types.ts`.
- Treat imported files and remote URLs as untrusted input.
- Avoid unsafe HTML rendering and broad error swallowing.
- Preserve local-first behavior and user-visible error reporting.
- Run lint, smoke tests, and build before submitting changes.
