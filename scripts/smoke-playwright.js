const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  let chromium;
  try {
    ({ chromium } = require('@playwright/test'));
  } catch {
    console.error('Playwright is not installed. Run: npm install');
    process.exit(1);
  }

  const root = path.resolve(__dirname, '..');
  const port = String(process.env.SMOKE_PORT || 17942);
  const baseUrl = `http://127.0.0.1:${port}`;
  const outputDir = path.join(root, 'data', 'outputs');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'smoke-output.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const cleanup = () => {
    server.kill('SIGTERM');
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    await waitForHealth(`${baseUrl}/api/health`);

    await fetch(`${baseUrl}/api/store/atlasHistory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: JSON.stringify([{
          id: 'smoke-history',
          type: 'image',
          model: 'smoke',
          promptFull: 'Smoke prompt "with quotes" and commas, still copyable.',
          prompt: 'Smoke prompt fallback',
          thumb: '/outputs/smoke-output.jpg',
          outputs: ['/outputs/smoke-output.jpg'],
          time: 'smoke',
        }]),
      }),
    });

    const browser = await chromium.launch();
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
    const page = await context.newPage();

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#promptList');

    await page.evaluate(() => {
      promptFolders = [
        { id: 'root-smoke', name: 'Smoke Root', parentId: null },
        { id: 'child-smoke', name: 'Smoke Child', parentId: 'root-smoke' },
      ];
      prompts = [{ id: 'prompt-smoke', name: 'Smoke Prompt', text: 'Prompt body', folderId: 'child-smoke' }];
      openPromptFolderIds.clear();
      openPromptFolderIds.add('root-smoke');
      renderPrompts();
    });

    await page.evaluate(() => togglePromptFolder('child-smoke'));
    await page.waitForFunction(() => document.querySelector('#prompt-folder-child-smoke').classList.contains('open'));
    await page.evaluate(() => togglePromptFolder('child-smoke'));
    await page.waitForFunction(() => !document.querySelector('#prompt-folder-child-smoke').classList.contains('open'));

    await page.goto(`${baseUrl}/gallery`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.copy-prompt-btn');
    await page.click('.copy-prompt-btn');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    if (!copied.includes('Smoke prompt "with quotes"')) {
      throw new Error(`Gallery prompt copy failed. Clipboard contained: ${copied}`);
    }

    await browser.close();
    console.log('Smoke test passed.');
  } finally {
    cleanup();
  }
}

async function waitForHealth(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become healthy: ${url}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
