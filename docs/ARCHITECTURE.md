# Architecture

## Runtime

- `server.js`: dependency-free Node.js HTTP server, atomic key-value persistence, file proxy, metadata, Atlas cancellation, and backups.
- `public/index.html`: core Studio layout and generation workflow.
- `public/productivity.js`: search, favorites, workflow presets, backup UI, queue normalization, and gallery-to-studio reuse.
- `public/productivity.css`: styles for productivity features and mobile targets.
- `public/gallery.html`: gallery shell and backward-compatible copy/delete behavior.
- `public/gallery-productivity.js`: gallery search, filters, albums, favorites, bulk actions, and reuse workflows.

## Persistent Keys

| Key | Purpose |
|---|---|
| `atlasPrompts` / `atlasPromptFolders` | Prompt library |
| `atlasFolders` / `atlasReferenceGroups` | Reference library |
| `atlasHistory` / `atlasOutputPrompts` | Generation history and legacy prompt mapping |
| `atlasOutputMeta` | Output prompt, model, settings, favorite, and album metadata |
| `atlasGenerationQueue` | Durable queue jobs and Atlas prediction IDs |
| `atlasFavorites` | Favorite prompt and reference-group IDs |
| `atlasWorkflowPresets` | Complete reusable generation configurations |
| `atlasWorkspace` | Current editor and open-folder state |

## Queue Recovery

Each browser has a stable local runner ID. A queue job records its runner and Atlas prediction ID. Refreshing the owning browser resumes polling the existing prediction. Another device can see the job but must explicitly choose `Resume here`, preventing accidental duplicate generations.

## Backups

Snapshots are written to a temporary directory and renamed only after completion. Restore creates a `before-restore` safety snapshot first. Backup retention defaults to seven and can be configured with `SEEDREAM_BACKUP_RETENTION`.

## Compatibility

The JSON store remains the source of truth to avoid a risky migration of existing installations. New capabilities use additive keys, so old `store.json` files continue to load.
