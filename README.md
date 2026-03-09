# 🎨 Seedream Studio — Local Network Server

Self-hosted server for Seedream Studio. All prompts, folders, reference images, and history are stored in SQLite on your Ubuntu server and shared across every device on your home network.

---

## Quick Setup (Ubuntu Server)

### Step 1 — Copy files to your server

From your PC, open a terminal and run:

```bash
scp -r seedream-studio-server/ your-user@YOUR_SERVER_IP:~/
```

Or if you're already on the server, just place the folder anywhere (e.g. `~/seedream-studio-server/`).

### Step 2 — Run the setup script

SSH into your server, then:

```bash
cd ~/seedream-studio-server
chmod +x setup.sh
./setup.sh
```

This will:
- Install Node.js 20 (if not already installed)
- Install npm dependencies (`better-sqlite3`)
- Copy files to `~/seedream-studio/`
- Create a **systemd service** that starts automatically on boot
- Open port `7842` in ufw firewall

### Step 3 — Open in your browser

The setup script will print your server's local IP, e.g.:

```
→ http://192.168.1.100:7842
```

Open that URL on **any device on your home WiFi** — PC, phone, tablet. All data is shared instantly.

---

## File Structure

```
seedream-studio-server/
├── server.js          ← Node.js backend (HTTP + SQLite API)
├── package.json
├── setup.sh           ← One-time setup script
├── public/
│   └── index.html     ← The full app (server-aware version)
└── data/
    └── studio.db      ← SQLite database (auto-created)
```

---

## Managing the Service

```bash
# Check status
systemctl status seedream-studio

# View live logs
journalctl -u seedream-studio -f

# Restart after updating index.html
systemctl restart seedream-studio

# Stop
systemctl stop seedream-studio

# Disable auto-start
systemctl disable seedream-studio
```

---

## Updating the App

When a new `index.html` is available:

```bash
# Copy new file to server
scp index.html your-user@YOUR_SERVER_IP:~/seedream-studio/public/

# Restart (optional — static files are read on each request)
systemctl restart seedream-studio
```

No data is lost — the SQLite database is untouched.

---

## Manual Start (without systemd)

```bash
cd ~/seedream-studio
node server.js
```

---

## Storage Details

| Data | Where stored |
|------|-------------|
| API key | SQLite `store` table, key `atlasApiKey` |
| Prompts | SQLite, key `atlasPrompts` |
| Folders + images | SQLite, key `atlasFolders` (base64 images included) |
| History | SQLite, key `atlasHistory` |
| Auto-save folder | RAM only (browser File System API — re-pick each session) |

The database file is at `~/seedream-studio/data/studio.db`. Back it up anytime with:

```bash
cp ~/seedream-studio/data/studio.db ~/seedream-studio-backup.db
```

---

## Port

Default port: **7842**. To change it:

```bash
# Edit the service file
sudo nano /etc/systemd/system/seedream-studio.service
# Change: Environment=PORT=7842

sudo systemctl daemon-reload
sudo systemctl restart seedream-studio
sudo ufw allow YOUR_NEW_PORT/tcp
```

---

## Troubleshooting

**Can't connect from phone?**
- Make sure phone is on the same WiFi
- Check firewall: `sudo ufw status` — port 7842 should show ALLOW
- Try `curl http://YOUR_SERVER_IP:7842/api/health` from server

**Service won't start?**
- Check logs: `journalctl -u seedream-studio -n 50`
- Verify Node.js: `node --version` (needs v18+)

**Data not syncing?**
- Hard-refresh the browser (Ctrl+Shift+R)
- Check the 💾 dot in the header — it turns green when connected to the server
