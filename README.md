# Seedream Studio Server

Self-hosted image and video generation workspace for Atlas Cloud with shared prompts, references, queue, history, gallery, xAI prompt assistance, and server backups.

## Requirements

- Ubuntu or another Linux server
- Node.js 18 or newer
- Atlas Cloud API key
- Optional xAI API token

## Install

```bash
git clone https://github.com/schwabe93/seedream-server.git
cd seedream-server
chmod +x setup.sh
./setup.sh
```

Open `http://SERVER-IP:7842` from a device on the same network.

## Update

```bash
cd ~/seedream-server
./deploy.sh
```

If the repository is installed elsewhere:

```bash
cd /path/to/seedream-server
git pull --ff-only
npm ci --omit=dev
sudo systemctl restart seedream-studio
```

## Data

Runtime data is stored below `data/` and is excluded from Git:

| Path | Contents |
|---|---|
| `data/store.json` | Prompts, folders, settings, queue, history, favorites, presets, and metadata |
| `data/refs/` | Uploaded reference images |
| `data/outputs/` | Generated images and videos |
| `data/backups/` | Daily and manual complete server snapshots |

The server uses atomic JSON writes. Existing installations require no database migration.

## Backups

The server creates one automatic snapshot per day and retains the newest seven snapshots by default. Backups include `store.json`, reference files, and outputs. Create and restore snapshots from Data Manager.

Change retention in the systemd service if required:

```ini
Environment=SEEDREAM_BACKUP_RETENTION=14
```

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart seedream-studio
```

## Service Commands

```bash
sudo systemctl status seedream-studio
sudo systemctl restart seedream-studio
sudo journalctl -u seedream-studio -f
```

## Tests

```bash
npm install
npm run smoke:install
npm run smoke
```

The smoke test runs against an isolated temporary data directory and does not modify production data.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for storage keys, module boundaries, queue recovery, and backup behavior.
