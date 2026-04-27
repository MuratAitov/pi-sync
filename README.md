# Pi Sync Suite

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
- `/sync-status` shows mode, paths, chat settings, cleanup settings, and last sync timestamps.
- `/sync-dashboard` shows the same status output as `/sync-status`.
- `/sync-help` lists the native Pi commands.
- `/sync` runs pull then push according to the current configuration.
- `/sync-push` uploads portable config and chat exports.
- `/sync-pull` downloads remote updates and applies portable config.
- `/sync-diff` stages the current safe snapshot and shows the Git diff summary.
- `/sync-log` shows recent sync repository commits.
- `/sync-doctor` runs diagnostics for Git, config, paths, and remote style.
- `/sync-export-chat` exports local Pi sessions to Markdown and JSON metadata.
- `/sync-export-chats` is an alias for `/sync-export-chat`.
- `/sync-chat-status` shows chat automation and export paths.
- `/sync-chat-upload` exports chats and uploads them with the snapshot.
- `/sync-chat-download` downloads synced chat exports from the remote.
- `/sync-chat-auto export|upload|download on|off` changes chat automation flags.
- `/sync-sessions on|off` explicitly enables or disables raw Pi `sessions/` sync.
- `/sync-clean-preview` previews cleanup candidates without deleting anything.
- `/sync-clean-run` deletes cleanup candidates only after confirmation.
- `/sync-clean-policy chat=<n> backups=<n> days=<n> auto=on|off` changes retention settings.
- `/sync-backup` creates a local backup of managed files.
- `/sync-backups` lists local backups.
- `/sync-restore [backup-id|latest]` restores a local backup.
- `/sync-auto <mode>` changes automation mode. Valid modes are `full-auto`, `config-only-auto`, `chats-manual`, `manual`, and `off`.
- `/sync-store-this-too [path]` opts into an optional path.
- `/sync-include <path>` includes a relative Pi agent path in future snapshots.
- `/sync-exclude <path>` excludes a relative Pi agent path from future snapshots.

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

`/sync-setup` starts in `full-auto`.

- `full-auto`: pulls on session start and on the configured interval, polls the safe sync scope for debounced pushes, exports chats during push, uploads chat exports, and applies downloaded chat exports.
- `config-only-auto`: pulls on session start and on the configured interval, polls the safe sync scope for debounced pushes, but disables chat auto export, upload, and download.
- `chats-manual`: enables manual chat export defaults, but does not start automatic config pull or push watchers.
- `manual`: disables automatic config and chat activity. Use `/sync-push`, `/sync-pull`, and `/sync-export-chat` explicitly.
- `off`: disables automatic config and chat activity.

Changing modes with `/sync-auto` also resets the chat automation flags to the mode defaults.

## Safe Defaults

By default, only portable Pi configuration is staged:

- Root files: `settings.json`, `keybindings.json`
- Directories: `themes`, `skills`, `prompts`

`settings.json` is copied without `lastChangelogVersion`. On restore, incoming settings are merged over local settings instead of replacing the whole file.

Before upload, files are scanned for common secret-like patterns such as private keys, GitHub personal access tokens, OpenAI-style keys, and obvious `api_key`, `token`, `password`, or `secret` assignments. Matching files stop the push. Symlinks are refused.

The sync repository also receives a managed `.gitignore` that excludes machine-local and sensitive names.

## Store This Too

Use `/sync-store-this-too` to opt into optional safe paths. Without an argument, Pi prompts from the known optional choices:

- `AGENTS.md`
- `CLAUDE.md`
- `extensions`
- `sync-suite-chat-exports`

You can pass a relative path directly:

```text
/sync-store-this-too AGENTS.md
```

Paths are normalized to portable forward-slash form and must stay inside the Pi agent directory. Paths containing unsafe names are refused.

`/sync-include` and `/sync-exclude` expose the same path policy directly for users who want manual control beyond the suggested optional choices.

## Chat Export And Import Behavior

`/sync-export-chat` scans `sessions/**/*.jsonl` under the Pi agent directory and writes exports to `sync-suite-chat-exports`.

For each source session it writes:

- A Markdown transcript: `<portable-session-path>.md`
- JSON metadata: `<portable-session-path>.metadata.json`

Metadata includes the source path, relative session path, session id, export time, message count, skipped line count, source modified time, source size, and generated output paths. Malformed JSONL lines or records without recognizable message content are counted as skipped.

In `full-auto`, `/sync-push` exports chats before staging and uploads `sync-suite-chat-exports`. In other modes, run `/sync-export-chat` explicitly. `/sync-chat-upload` temporarily enables chat upload for one manual upload, and `/sync-chat-download` temporarily enables chat download for one manual pull.

There is no command that imports exported Markdown or metadata back into live Pi `sessions`. Pull behavior only applies the `sync-suite-chat-exports` directory when chat download is enabled, making exported transcripts available on the receiving machine without recreating original session JSONL files.

## Raw Session Sync

Markdown chat exports are safe for browsing, but they do not make `pi continue` or the session tree work on another machine. For that, enable raw session sync explicitly:

```text
/sync-sessions on
/sync-push
```

Then on another Pi environment:

```text
/sync-pull
```

This syncs the real `sessions/` tree so Pi can see prior sessions. It is intentionally off by default because raw sessions may contain full prompts, model outputs, tool logs, file paths, and secrets. Use it only with a private repo you control.

Disable it again with:

```text
/sync-sessions off
```

## Cleanup

Cleanup is preview-first:

```text
/sync-clean-preview
/sync-clean-run
```

The default retention policy keeps the newest `100` chat export files, the newest `20` backup files, and anything newer than `180` days. `autoApply` defaults to `false`, so cleanup only deletes after `/sync-clean-run` shows the candidates and the user confirms.

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

Local backup commands are available:

```text
/sync-backup
/sync-backups
/sync-restore latest
/sync-restore <backup-id>
```

These commands operate only on local `sync-suite-backups`; they do not force-push or rewrite remote history.

## Cross-Platform Notes

- Linux, macOS, and Windows are supported through Node.js path handling.
- The Pi agent directory is `~/.pi/agent` by default, or `PI_CODING_AGENT_DIR` when set.
- Paths passed to `/sync-store-this-too` may use `/` or `\`; they are normalized to portable `/` paths.
- Git must be installed and available to Pi.
- SSH authentication must already work outside Pi because Git prompts are disabled.
- The sync remote should have an upstream branch configured so `HEAD..@{u}` and `git pull --ff-only` work.

## What Never Syncs

The extension refuses any path containing these names:

- `auth.json`
- `sessions` unless `/sync-sessions on` was explicitly enabled
- `git`
- `npm`
- `bin`
- `node_modules`
- `.env`
- `.ssh`
- `sync-suite-repo`
- `pi-sync-suite.json`

The repository `.gitignore` also excludes `*.log`, `.DS_Store`, and `Thumbs.db`.
