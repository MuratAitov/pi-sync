# Pi Sync Suite

Cross-platform Pi extension for syncing portable Pi configuration, exporting chats, and keeping the sync repository clean.

This package is intentionally implemented from scratch. It is inspired by the idea of config sync, but it does not reuse third-party extension code.

## Goals

- Automatic upload and download after setup.
- Safe defaults that avoid credentials, caches, logs, and machine-local state.
- Optional "store this too" controls for files such as `AGENTS.md`, `CLAUDE.md`, and chat exports.
- Git-based transport with non-interactive SSH workflows.
- Native Pi commands and status output.
- Cross-platform behavior on Linux, macOS, and Windows.

## Development

```bash
npm install
npm run typecheck
npm run build
```
