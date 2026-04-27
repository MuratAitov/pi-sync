# Pi Sync

Cross-platform Pi extension for syncing portable Pi configuration, exporting chats, and keeping the sync repository clean.

This package is intentionally implemented from scratch. It is inspired by the idea of config sync, but it does not reuse third-party extension code.

## Install And Development Workflow

Requires Node.js 20 or newer.

```bash
npm install
npm run typecheck
npm run build
npm test
```

Two-device raw session sync can be smoke-tested with isolated temporary Pi agent directories:

```bash
npm run e2e:two-pi-sessions -- --local
npm run e2e:two-pi-sessions -- --remote git@github.com:you/private-test-repo.git
```

The GitHub mode uses a temporary `pi-sync-e2e-*` branch and deletes it after a successful run unless `--keep-remote-branch` is passed.

Pi loads the extension from `./src/index.ts` through the `pi.extensions` entry in `package.json`.

Runtime setup happens inside Pi:

```text
/sync-setup <ssh-repo-url> [pull-interval-minutes]
```

Use an SSH Git remote such as `git@github.com:you/pi-config.git`. HTTPS remotes are rejected so the extension can run Git with `GIT_TERMINAL_PROMPT=0` and avoid interactive credential prompts.

The optional pull interval defaults to `1440` minutes. The extension stores its local state under the Pi agent directory, which defaults to `~/.pi/agent` unless `PI_CODING_AGENT_DIR` is set.

## Commands

- `/sync-setup <ssh-repo-url> [pull-interval-minutes]` configures the extension.
- `/sync-push` uploads the current snapshot.
- `/sync-pull` downloads and applies the latest snapshot.
- `/sync-settings` opens the settings wizard.

Everything else is configured inside `/sync-settings` so the Pi command list stays small. The settings wizard currently contains:

- `Status` - overview
- `Sync Mode [full/config/manual/off]` - current background sync mode
- `Chat Sync [off/archive/resume]` - current chat sync behavior
- `Config Paths [n]` - number of extra optional paths included
- `Cleanup [manual/auto]` - current cleanup apply mode
- `Backups [n backups]` - local restore points
- `Diagnostics` - doctor, diff, and log

Inside a settings section, `Cancel [back]` returns to the main settings menu. `Cancel` on the main menu closes settings. Descriptions are shown in dim terminal text and explain what the current setting or selectable action does.

## Project Structure

```text
src/
  index.ts                 thin Pi package entrypoint
  extension/               Pi lifecycle and command registration
  config/                  config defaults, loading, validation, persistence
  engine/                  high-level push/pull orchestration
  git/                     non-interactive Git client helpers
  snapshot/                safe file staging/apply and path policy
  chat/                    Pi session scanning and chat export
  backup/                  local backup manifests and restore
  cleanup/                 retention planning and cleanup apply
  watcher/                 lightweight polling fingerprints for auto push
  doctor/                  diagnostics
  ui/                      status, dashboard, and command text rendering
  utils/                   cross-platform path helpers
tests/                     node:test smoke and regression coverage
scripts/                   development utilities
```

## Auto Modes

`/sync-setup` starts in `full-auto` for config sync, with chat sync off by default.

- `full-auto`: pulls on session start and on the configured interval, and polls the safe sync scope for debounced pushes.
- `config-only-auto`: same automation behavior as `full-auto`; chat behavior is still controlled separately by `Chat Sync`.
- `manual`: disables automatic pull and push. Use `/sync-push` and `/sync-pull` explicitly.
- `off`: disables automatic config and chat activity.

Change this from `/sync-settings` -> `Sync Mode`.

## Safe Defaults

By default, only portable Pi configuration is staged:

- Root files: `settings.json`, `keybindings.json`
- Directories: `themes`, `skills`, `prompts`

`settings.json` is copied without `lastChangelogVersion`. On restore, incoming settings are merged over local settings instead of replacing the whole file.

Before upload, files are scanned for common secret-like patterns such as private keys, GitHub personal access tokens, OpenAI-style keys, and obvious `api_key`, `token`, `password`, or `secret` assignments. Matching files stop the push. Symlinks are refused.

The sync repository also receives a managed `.gitignore` that excludes machine-local and sensitive names.

## Config Paths

Use `/sync-settings` -> `Config Paths` to opt into optional safe paths:

- `AGENTS.md`
- `CLAUDE.md`
- `extensions`
- `sync-suite-chat-exports`

Paths are normalized to portable forward-slash form and must stay inside the Pi agent directory. Paths containing unsafe names are refused.

The same screen also has manual include and exclude actions for advanced users.

## Chat Sync

Use `/sync-settings` -> `Chat Sync`.

- `Off`: do not sync chats.
- `Archive`: export local `sessions/**/*.jsonl` to readable Markdown and JSON metadata under `sync-suite-chat-exports`, then sync those archive files.
- `Resume`: sync the real Pi `sessions/` tree so another Pi environment can show the same session tree and resume sessions.

Archive mode writes:

- Markdown transcript files: `<portable-session-path>.md`
- JSON metadata files: `<portable-session-path>.metadata.json`

Metadata includes the source path, relative session path, session id, export time, message count, skipped line count, source modified time, source size, and generated output paths. Malformed JSONL lines or records without recognizable message content are counted as skipped.

Archive is useful for reading, search, and audit history, but it does not recreate live Pi sessions. Resume mode is intentionally explicit because raw sessions may contain prompts, model outputs, tool logs, file paths, and secrets. Use Resume only with a private repository you control.

## Cleanup

Cleanup is preview-first:

```text
/sync-settings -> Cleanup -> Preview
/sync-settings -> Cleanup -> Run
```

The default retention policy keeps the newest `100` chat export files, the newest `20` backup files, and anything newer than `180` days. `autoApply` defaults to `false`, so cleanup only deletes after the settings wizard shows the candidates and the user confirms.

Cleanup only considers files under:

- `sync-suite-chat-exports`
- `sync-suite-backups`

## Backup And Restore

The Git remote is the primary backup for portable Pi state. `/sync-push` clones the remote if needed, stages the safe snapshot into `sync-suite-repo`, commits changes, and pushes them.

Before `/sync-pull` applies incoming remote changes, the current local snapshot is copied to `sync-suite-backups/<timestamp>`. Each backup contains a `manifest.json` and a `files` directory with the snapshot entries that existed locally before the pull.

Cross-machine restore from the Git remote is done by configuring the same SSH remote on another machine and running:

```text
/sync-setup <ssh-repo-url>
/sync-pull
```

Pull uses `git pull --ff-only` and applies the safe snapshot into the Pi agent directory. `settings.json` is merged with local settings; other synced files and directories are replaced from the repository copy.

Local backup actions are available from `/sync-settings` -> `Backups`.

These commands operate only on local `sync-suite-backups`; they do not force-push or rewrite remote history.

## Cross-Platform Notes

- Linux, macOS, and Windows are supported through Node.js path handling.
- The Pi agent directory is `~/.pi/agent` by default, or `PI_CODING_AGENT_DIR` when set.
- Paths entered in `/sync-settings` may use `/` or `\`; they are normalized to portable `/` paths.
- Git must be installed and available to Pi.
- SSH authentication must already work outside Pi because Git prompts are disabled.
- The sync remote should have an upstream branch configured so `HEAD..@{u}` and `git pull --ff-only` work.

## What Never Syncs

The extension refuses any path containing these names:

- `auth.json`
- `sessions` unless `Chat Sync` is set to `Resume`
- `git`
- `npm`
- `bin`
- `node_modules`
- `.env`
- `.ssh`
- `sync-suite-repo`
- `pi-sync-suite.json`

The repository `.gitignore` also excludes `*.log`, `.DS_Store`, and `Thumbs.db`.
