const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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
  const instanceToken = randomUUID();
  const smokeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedream-smoke-'));
  const outputDir = path.join(smokeDataDir, 'outputs');
  const evidenceDir = process.env.SMOKE_EVIDENCE_DIR || path.join(os.tmpdir(), 'seedream-mobile-qa');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  const outputPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const persistentOutputPrompt = 'Persistent output prompt "with quotes", apostrophe\'s, and a newline.\nSecond line.';
  fs.writeFileSync(path.join(outputDir, 'smoke-output.png'), outputPixel);
  fs.writeFileSync(path.join(outputDir, 'orphan-output.png'), outputPixel);
  fs.writeFileSync(path.join(outputDir, 'remote-collision.png'), outputPixel);
  fs.writeFileSync(path.join(outputDir, 'delete-collision.png'), outputPixel);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: port, SEEDREAM_DATA_DIR: smokeDataDir, SEEDREAM_INSTANCE_TOKEN: instanceToken },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const cleanup = () => server.kill('SIGTERM');
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    await waitForHealth(`${baseUrl}/api/health`, instanceToken);
    const indexResponse = await fetch(baseUrl);
    assert(indexResponse.headers.get('cache-control') === 'no-cache', 'HTML responses remain pinned in browser cache after deployment');
    assert(indexResponse.headers.get('x-content-type-options') === 'nosniff', 'Static responses can still be MIME-sniffed');

    await fetch(`${baseUrl}/api/store/atlasHistory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: JSON.stringify([{
          id: 'remote-collision',
          promptFull: 'Remote prompt must not attach to a local file.',
          thumb: 'https://cdn.example/outputs/remote-collision.png',
          outputs: ['https://cdn.example/outputs/remote-collision.png'],
        }]),
      }),
    });
    const collisionOutputsResponse = await fetch(`${baseUrl}/api/outputs`);
    const collisionOutputs = await collisionOutputsResponse.json();
    assert(!collisionOutputs.files.find(file => file.name === 'remote-collision.png')?.prompt, 'Remote basename collision exposed the wrong prompt');
    fs.unlinkSync(path.join(outputDir, 'remote-collision.png'));

    await fetch(`${baseUrl}/api/store/atlasHistory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: JSON.stringify([
          { id: 'local-delete', outputs: ['/outputs/delete-collision.png'], thumb: '/outputs/delete-collision.png' },
          { id: 'remote-keep', outputs: ['https://cdn.example/outputs/delete-collision.png'], thumb: 'https://cdn.example/outputs/delete-collision.png' },
        ]),
      }),
    });
    const collisionDeleteResponse = await fetch(`${baseUrl}/api/output/delete-collision.png`, { method: 'DELETE' });
    assert(collisionDeleteResponse.ok, 'Local collision fixture could not be deleted');
    const collisionHistoryResponse = await fetch(`${baseUrl}/api/store/atlasHistory`);
    const collisionHistoryData = await collisionHistoryResponse.json();
    const collisionHistory = JSON.parse(collisionHistoryData.value || '[]');
    assert(collisionHistory.some(item => item.id === 'remote-keep'), 'Deleting a local output removed unrelated remote history with the same basename');
    assert(!collisionHistory.some(item => item.id === 'local-delete'), 'Deleting a local output left its local history entry behind');

    await fetch(`${baseUrl}/api/store/atlasHistory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: JSON.stringify([{
          id: 'smoke-history',
          type: 'image',
          model: 'smoke',
          promptFull: 'History fallback prompt that must not override output metadata.',
          prompt: 'History fallback prompt',
          thumb: '/outputs/smoke-output.png',
          outputs: ['/outputs/smoke-output.png'],
          time: 'smoke',
        }]),
      }),
    });

    const promptMetadataResponse = await fetch(`${baseUrl}/api/save-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${baseUrl}/outputs/smoke-output.png`,
        filename: 'smoke-output.png',
        prompt: persistentOutputPrompt,
      }),
    });
    assert(promptMetadataResponse.ok, 'Existing output prompt metadata could not be saved');

    const overwriteResponse = await fetch(`${baseUrl}/api/save-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${baseUrl}/outputs/smoke-output.png`,
        filename: 'smoke-output.png',
        prompt: 'Later metadata must not overwrite the original prompt.',
      }),
    });
    assert(overwriteResponse.ok, 'Existing output could not be acknowledged on a repeated save');

    const unsupportedResponse = await fetch(`${baseUrl}/api/save-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${baseUrl}/outputs/smoke-output.png`,
        filename: 'unsafe-output.html',
        prompt: 'Unsafe metadata',
      }),
    });
    assert(unsupportedResponse.status === 400, 'Unsupported output file type was accepted');

    const oversizedPromptResponse = await fetch(`${baseUrl}/api/save-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${baseUrl}/outputs/smoke-output.png`,
        filename: 'oversized-output.png',
        prompt: 'x'.repeat(50001),
      }),
    });
    assert(oversizedPromptResponse.status === 413, 'Oversized output prompt metadata was accepted');

    const failedDownloadResponse = await fetch(`${baseUrl}/api/save-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${baseUrl}/missing-output.png`,
        filename: 'failed-output.png',
        prompt: 'Failed downloads must not persist this prompt.',
      }),
    });
    assert(!failedDownloadResponse.ok, 'Missing remote output unexpectedly downloaded');
    assert(!fs.existsSync(path.join(outputDir, 'failed-output.png')), 'Failed download left an output file behind');
    assert(!fs.readdirSync(outputDir).some(name => name.startsWith('failed-output.png.part-')), 'Failed download left a partial file behind');

    const protectedOutputsResponse = await fetch(`${baseUrl}/api/outputs`);
    const protectedOutputs = await protectedOutputsResponse.json();
    const protectedOutput = protectedOutputs.files.find(file => file.name === 'smoke-output.png');
    assert(protectedOutput?.prompt === persistentOutputPrompt, 'A repeated save overwrote persistent output prompt metadata');
    assert(!protectedOutputs.files.some(file => file.name === 'failed-output.png'), 'Failed output appeared in the Gallery API');

    const parallelResponses = await Promise.all([
      fetch(`${baseUrl}/api/save-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${baseUrl}/outputs/smoke-output.png`, filename: 'parallel-output.png', prompt: 'Parallel prompt A' }),
      }),
      fetch(`${baseUrl}/api/save-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${baseUrl}/outputs/orphan-output.png`, filename: 'parallel-output.png', prompt: 'Parallel prompt B' }),
      }),
    ]);
    assert(parallelResponses.every(response => response.ok), 'Concurrent saves for one output filename did not serialize cleanly');
    assert(!fs.readdirSync(outputDir).some(name => name.startsWith('parallel-output.png.part-')), 'Concurrent save left a partial file behind');
    const parallelOutputs = await (await fetch(`${baseUrl}/api/outputs`)).json();
    assert(['Parallel prompt A', 'Parallel prompt B'].includes(parallelOutputs.files.find(file => file.name === 'parallel-output.png')?.prompt), 'Concurrent save lost its owning prompt metadata');
    await fetch(`${baseUrl}/api/output/parallel-output.png`, { method: 'DELETE' });

    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
    const page = await context.newPage();

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#promptList', { state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#serverDot')?.classList.contains('connected'));
    await page.evaluate(() => document.fonts.ready);

    await page.evaluate(() => {
      scheduleWorkspaceSave = () => {};
      lastKnownVersion = Number.MAX_SAFE_INTEGER;
      promptFolders = [
        { id: 'root-smoke', name: 'Smoke Root', parentId: null },
        { id: 'child-smoke', name: 'Smoke Child', parentId: 'root-smoke' },
      ];
      prompts = Array.from({ length: 14 }, (_, index) => ({
        id: `prompt-smoke-${index}`,
        name: `Smoke Prompt ${index + 1}`,
        text: `Prompt body ${index + 1}`,
        folderId: 'child-smoke',
      }));
      openPromptFolderIds.clear();
      openPromptFolderIds.add('root-smoke');
      openPromptFolderIds.add('child-smoke');

      const image = color => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="${color}"/></svg>`)}`;
      folders = [{
        id: 'refs-smoke',
        name: 'Smoke References',
        parentId: null,
        images: Array.from({ length: 18 }, (_, index) => ({
          src: image(`hsl(${index * 20} 18% ${24 + (index % 4) * 7}%)`),
          name: `Reference ${index + 1}`,
        })),
      }];
      openReferenceFolderIds.clear();
      openReferenceFolderIds.add('refs-smoke');
      refImages = [];
      renderPrompts();
      renderFolders();
      renderRefStrip();
    });

    await page.fill('#promptTextarea', 'Quick xAI seed from the generator');
    const quickButtonMetrics = await page.locator('#xaiQuickButton').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    assert(quickButtonMetrics.width >= 44 && quickButtonMetrics.height >= 44, `xAI quick action is too small on mobile: ${JSON.stringify(quickButtonMetrics)}`);
    await page.click('#xaiQuickButton');
    await page.waitForFunction(() => document.querySelector('#promptGeneratorModal')?.classList.contains('show'));
    assert(await page.inputValue('#xaiPromptIdea') === 'Quick xAI seed from the generator', 'xAI quick action did not carry over the current prompt');
    const xaiDialogSemantics = await page.evaluate(() => ({
      role: document.getElementById('promptGeneratorModal')?.getAttribute('role'),
      modal: document.getElementById('promptGeneratorModal')?.getAttribute('aria-modal'),
      labelledBy: document.getElementById('promptGeneratorModal')?.getAttribute('aria-labelledby'),
      expanded: document.getElementById('xaiQuickButton')?.getAttribute('aria-expanded'),
    }));
    assert(xaiDialogSemantics.role === 'dialog' && xaiDialogSemantics.modal === 'true' && xaiDialogSemantics.labelledBy === 'xaiPromptGeneratorTitle' && xaiDialogSemantics.expanded === 'true', `xAI dialog semantics are incomplete: ${JSON.stringify(xaiDialogSemantics)}`);
    await page.evaluate(() => closeModal('promptGeneratorModal'));
    await page.fill('#promptTextarea', 'Updated prompt for second xAI launch');
    await page.click('#xaiQuickButton');
    assert(await page.inputValue('#xaiPromptIdea') === 'Updated prompt for second xAI launch', 'Repeated xAI quick action retained a stale idea');

    await page.evaluate(() => {
      xaiPromptCategories = [
        { id: 'reference', name: 'Refernz', locked: true, keywords: [] },
        { id: 'smoke-keywords', name: 'Smoke Keywords', keywords: ['keep me', 'remove me'] },
      ];
      selectedXaiPromptKeywords.clear();
      editingXaiPromptCategoryIds.clear();
      renderXaiPromptBuilder();
    });
    const editKeywordsButton = page.locator('[data-xai-action="edit-keywords"][data-category-id="smoke-keywords"]');
    await editKeywordsButton.click();
    assert(await editKeywordsButton.getAttribute('aria-pressed') === 'true', 'Keyword edit mode did not become active');
    const deleteKeywordButton = page.locator('[data-xai-action="delete-keyword"][data-keyword="remove me"]');
    const deleteKeywordMetrics = await deleteKeywordButton.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    assert(deleteKeywordMetrics.width >= 44 && deleteKeywordMetrics.height >= 44, `Keyword delete action is too small on mobile: ${JSON.stringify(deleteKeywordMetrics)}`);
    await deleteKeywordButton.click();
    assert(await page.evaluate(() => !xaiPromptCategories.find(category => category.id === 'smoke-keywords')?.keywords.includes('remove me')), 'Keyword deletion did not update its category');
    await page.waitForFunction(async () => {
      const response = await fetch('/api/store/xaiPromptCategories');
      if (!response.ok) return false;
      const data = await response.json();
      const categories = JSON.parse(data.value || '[]');
      return !categories.find(category => category.id === 'smoke-keywords')?.keywords.includes('remove me');
    });
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-xai-prompt-375.png'), fullPage: false });
    await page.evaluate(() => closeModal('promptGeneratorModal'));

    await page.click('#studioMenuButton');
    await page.waitForFunction(() => document.body.classList.contains('mobile-panel-prompts'));
    assert(await page.evaluate(() => document.querySelector('.center-panel')?.inert), 'Covered generator remains focusable while the mobile library is open');

    await page.focus('#prompt-folder-child-smoke > .prompt-folder-header > .prompt-folder-toggle');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#prompt-folder-child-smoke')?.classList.contains('open'));
    await page.waitForFunction(() => document.activeElement?.matches('#prompt-folder-child-smoke > .prompt-folder-header > .prompt-folder-toggle'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#prompt-folder-child-smoke')?.classList.contains('open'));
    await verifyWheelScroll(page, '#promptList');

    await page.waitForTimeout(250);

    const promptMetrics = await page.evaluate(() => {
      const rect = selector => {
        const bounds = document.querySelector(selector)?.getBoundingClientRect();
        return bounds ? { width: bounds.width, height: bounds.height, top: bounds.top, right: bounds.right, bottom: bounds.bottom, left: bounds.left } : null;
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        panel: rect('.left-panel'),
        tab: rect('.mobile-drawer-tab.active'),
        checkboxTarget: rect('.prompt-select-target'),
        moveAction: rect('.prompt-action-move'),
        deleteAction: rect('.prompt-action-delete'),
        applyActionDisplay: getComputedStyle(document.querySelector('.prompt-action-apply')).display,
        nestedInteractiveControls: document.querySelectorAll('.prompt-folder-toggle button, .prompt-folder-toggle input, .prompt-use-target button, .prompt-use-target input, .folder-thumb button').length,
      };
    });

    assert(promptMetrics.viewport.width === 375, `Expected 375px viewport, got ${promptMetrics.viewport.width}`);
    assert(Math.abs(promptMetrics.panel.left) <= 1 && Math.abs(promptMetrics.panel.width - 375) <= 1 && promptMetrics.panel.bottom === 812, `Mobile drawer does not fill viewport: ${JSON.stringify(promptMetrics.panel)}`);
    assert(promptMetrics.tab.height >= 44, `Mobile tab target is too small: ${promptMetrics.tab.height}`);
    assert(promptMetrics.checkboxTarget.width >= 44 && promptMetrics.checkboxTarget.height >= 44, 'Queue checkbox target is below 44px');
    assert(promptMetrics.moveAction.width >= 44 && promptMetrics.moveAction.height >= 44, 'Move action target is below 44px');
    assert(promptMetrics.deleteAction.width >= 44 && promptMetrics.deleteAction.height >= 44, 'Delete action target is below 44px');
    assert(promptMetrics.applyActionDisplay === 'none', 'Redundant mobile apply action is still visible');
    assert(promptMetrics.nestedInteractiveControls === 0, 'Interactive controls are nested inside custom button roles');
    const promptCountBeforeDelete = await page.locator('#prompt-folder-child-smoke .prompt-item').count();
    page.once('dialog', dialog => dialog.dismiss());
    await page.click('#prompt-folder-child-smoke .prompt-action-delete');
    assert(await page.locator('#prompt-folder-child-smoke .prompt-item').count() === promptCountBeforeDelete, 'Dismissed prompt deletion still removed data');
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-prompts-375.png'), fullPage: false });

    await page.check('#prompt-folder-child-smoke .prompt-select');
    assert(await page.evaluate(() => document.body.classList.contains('menu-open')), 'Queue selection closed the mobile library');

    await page.focus('#prompt-folder-child-smoke .prompt-use-target');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.body.classList.contains('menu-open'));
    assert((await page.inputValue('#promptTextarea')).startsWith('Prompt body'), 'Prompt selection did not populate the editor');

    await page.click('#studioMenuButton');
    await page.click('[data-mobile-panel="references"]');
    await page.waitForFunction(() => document.body.classList.contains('mobile-panel-references'));
    await page.waitForTimeout(250);
    await page.focus('#folder-refs-smoke > .folder-header');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#folder-refs-smoke')?.classList.contains('open'));
    await page.waitForFunction(() => document.activeElement?.matches('#folder-refs-smoke > .folder-header'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#folder-refs-smoke')?.classList.contains('open'));
    await verifyWheelScroll(page, '#folderList');
    const referenceMetrics = await page.evaluate(() => {
      const thumb = document.querySelector('.folder-thumb')?.getBoundingClientRect();
      const deleteAction = document.querySelector('.folder-thumb-wrap .del-btn')?.getBoundingClientRect();
      const actions = document.querySelector('.mobile-ref-actions')?.getBoundingClientRect();
      const panel = document.querySelector('.left-panel')?.getBoundingClientRect();
      const logo = document.querySelector('.logo')?.getBoundingClientRect();
      const modeTabs = document.querySelector('.header-tabs')?.getBoundingClientRect();
      return {
        thumb: thumb ? { width: thumb.width, height: thumb.height } : null,
        deleteAction: deleteAction ? { width: deleteAction.width, height: deleteAction.height } : null,
        actions: actions ? { height: actions.height, bottom: actions.bottom } : null,
        panel: panel ? { left: panel.left, right: panel.right } : null,
        logo: logo ? { width: logo.width, top: logo.top, bottom: logo.bottom } : null,
        modeTabs: modeTabs ? { width: modeTabs.width, top: modeTabs.top, bottom: modeTabs.bottom } : null,
        promptPanelDisplay: getComputedStyle(document.querySelector('#promptLibrarySection')).display,
      };
    });
    assert(referenceMetrics.thumb.width >= 64 && referenceMetrics.thumb.height >= 64, `Reference target is too small: ${JSON.stringify(referenceMetrics.thumb)}`);
    assert(referenceMetrics.deleteAction.width >= 44 && referenceMetrics.deleteAction.height >= 44, `Reference delete target is too small: ${JSON.stringify(referenceMetrics.deleteAction)}`);
    assert(Math.abs(referenceMetrics.actions.bottom - 812) <= 1, `Reference action bar is not fixed to drawer bottom: ${JSON.stringify(referenceMetrics.actions)}`);
    assert(Math.abs(referenceMetrics.panel.left) <= 1 && Math.abs(referenceMetrics.panel.right - 375) <= 1, `Reference drawer is not settled: ${JSON.stringify(referenceMetrics.panel)}`);
    assert(referenceMetrics.logo.width >= 180 && referenceMetrics.logo.top >= 0, `Mobile logo disappeared after reopening the library: ${JSON.stringify(referenceMetrics.logo)}`);
    assert(referenceMetrics.modeTabs.width >= 130 && referenceMetrics.modeTabs.top >= 0, `Mobile mode tabs disappeared after reopening the library: ${JSON.stringify(referenceMetrics.modeTabs)}`);
    assert(referenceMetrics.promptPanelDisplay === 'none', 'Prompt panel remains visible in reference mode');
    const referenceCountBeforeDelete = await page.locator('#folder-refs-smoke .folder-thumb').count();
    page.once('dialog', dialog => dialog.dismiss());
    await page.click('#folder-refs-smoke .folder-thumb-wrap .del-btn');
    assert(await page.locator('#folder-refs-smoke .folder-thumb').count() === referenceCountBeforeDelete, 'Dismissed reference deletion still removed data');
    page.once('dialog', dialog => dialog.accept());
    await page.click('#folder-refs-smoke .folder-thumb-wrap .del-btn');
    await page.waitForFunction(count => document.querySelectorAll('#folder-refs-smoke .folder-thumb').length === count - 1, referenceCountBeforeDelete);
    const rebuiltReferenceCounts = await page.evaluate(() => ({
      wrappers: document.querySelectorAll('#folder-refs-smoke .folder-thumb-wrap').length,
      thumbs: document.querySelectorAll('#folder-refs-smoke .folder-thumb').length,
      deleteButtons: document.querySelectorAll('#folder-refs-smoke .folder-thumb-wrap .del-btn').length,
    }));
    assert(rebuiltReferenceCounts.wrappers === rebuiltReferenceCounts.thumbs && rebuiltReferenceCounts.thumbs === rebuiltReferenceCounts.deleteButtons, `Reference rebuild left orphan controls: ${JSON.stringify(rebuiltReferenceCounts)}`);

    await page.focus('#folder-refs-smoke .folder-thumb[data-ii="0"]');
    await page.keyboard.press('Enter');
    await page.click('#folder-refs-smoke .folder-thumb[data-ii="1"]');
    assert((await page.textContent('#mobileRefSelectionCount')).includes('2 references'), 'Reference selection count did not update');
    assert(await page.evaluate(() => document.body.classList.contains('menu-open')), 'Reference selection closed before Done');
    await page.click('#mobileClearRefsButton');
    assert(await page.evaluate(() => refImages.length === 0), 'Clear did not remove selected references');
    await page.focus('#folder-refs-smoke .folder-thumb[data-ii="0"]');
    await page.keyboard.press('Enter');
    await page.click('#folder-refs-smoke .folder-thumb[data-ii="1"]');
    assert((await page.textContent('#mobileRefSelectionCount')).includes('2 references'), 'Reference selection could not be rebuilt after Clear');
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-references-375.png'), fullPage: false });

    await page.click('.mobile-ref-action.primary');
    await page.waitForFunction(() => !document.body.classList.contains('menu-open'));
    assert(!(await page.evaluate(() => document.querySelector('.center-panel')?.inert)), 'Generator stayed inert after closing the mobile library');
    assert(await page.evaluate(() => refImages.length === 2), 'Done did not preserve selected references');
    await page.waitForTimeout(250);
    assert(await page.evaluate(() => document.activeElement?.id === 'studioMenuButton'), 'Done did not restore focus to Library');
    assert(await page.evaluate(() => normalizeReferenceGroups([{
      name: 'Limit fixture',
      images: Array.from({ length: 12 }, (_, index) => ({ src: `/refs/limit-${index}.png`, name: `Limit ${index}` })),
    }])[0].images.length === 10), 'Imported reference groups are not capped at 10 images');

    const saveGroupMetrics = await page.locator('#saveReferenceGroupButton').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, disabled: element.disabled };
    });
    assert(!saveGroupMetrics.disabled && saveGroupMetrics.height >= 44, `Reference group save action is unavailable on mobile: ${JSON.stringify(saveGroupMetrics)}`);
    await page.click('#saveReferenceGroupButton');
    await page.waitForFunction(() => document.querySelector('#referenceGroupModal')?.classList.contains('show'));
    assert((await page.textContent('#referenceGroupModalHint')).includes('2/10'), 'Reference group modal does not explain its image limit');
    await page.fill('#referenceGroupNameInput', 'Smoke Duo');
    await page.click('#confirmReferenceGroupButton');
    await page.waitForFunction(() => !document.querySelector('#referenceGroupModal')?.classList.contains('show'));
    await page.waitForSelector('.reference-group-card');
    await page.waitForFunction(async () => {
      const response = await fetch('/api/store/atlasReferenceGroups');
      if (!response.ok) return false;
      const data = await response.json();
      const groups = JSON.parse(data.value || '[]');
      return groups.some(group => group.name === 'Smoke Duo' && group.images?.length === 2);
    });
    const groupMetrics = await page.locator('.reference-group-card').evaluate(card => {
      const apply = card.querySelector('.reference-group-apply').getBoundingClientRect();
      const remove = card.querySelector('.reference-group-delete').getBoundingClientRect();
      return { applyHeight: apply.height, deleteWidth: remove.width, deleteHeight: remove.height };
    });
    assert(groupMetrics.applyHeight >= 44 && groupMetrics.deleteWidth >= 44 && groupMetrics.deleteHeight >= 44, `Reference group mobile targets are too small: ${JSON.stringify(groupMetrics)}`);
    await page.evaluate(() => clearRefs());
    assert(await page.evaluate(() => refImages.length === 0), 'Reference group fixture could not clear active references');
    await page.click('.reference-group-apply');
    assert(await page.evaluate(() => refImages.length === 2), 'One-click reference group did not restore all images');
    assert(await page.locator('.reference-group-card').evaluate(card => card.classList.contains('active')), 'Applied reference group has no active state');
    assert(await page.evaluate(() => buildExportPayload('folders').referenceGroups?.[0]?.name === 'Smoke Duo'), 'Reference groups are missing from folder backups');
    const groupCountBeforeDelete = await page.locator('.reference-group-card').count();
    page.once('dialog', dialog => dialog.dismiss());
    await page.click('.reference-group-delete');
    assert(await page.locator('.reference-group-card').count() === groupCountBeforeDelete, 'Dismissed reference group deletion still removed the group');
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-reference-groups-375.png'), fullPage: false });

    const headerState = await page.evaluate(() => {
      const visibleWidth = selector => document.querySelector(selector)?.getBoundingClientRect().width || 0;
      return {
        logo: visibleWidth('.logo'),
        library: visibleWidth('#studioMenuButton'),
        imageMode: visibleWidth('#modeImageBtn'),
      };
    });
    assert(headerState.logo > 100 && headerState.library >= 44 && headerState.imageMode >= 44, `Mobile header content disappeared: ${JSON.stringify(headerState)}`);
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-generator-return-375.png'), fullPage: false });

    await page.click('#studioMenuButton');
    await page.click('[data-mobile-panel="settings"]');
    await page.waitForFunction(() => document.body.classList.contains('mobile-panel-settings'));
    await page.waitForTimeout(250);
    const settingsPanel = await page.evaluate(() => document.querySelector('.right-panel').getBoundingClientRect().toJSON());
    assert(Math.abs(settingsPanel.left) <= 1 && settingsPanel.width === 375 && Math.abs(settingsPanel.bottom - 812) <= 1, `Mobile Studio panel dimensions are wrong: ${JSON.stringify(settingsPanel)}`);
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-studio-375.png'), fullPage: false });

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('menu-open'));
    await page.waitForFunction(() => document.activeElement?.id === 'studioMenuButton');
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.click('#studioMenuButton');
    await page.click('[data-mobile-panel="prompts"]');
    await verifyWheelScroll(page, '#promptList');
    await page.click('[data-mobile-panel="references"]');
    await page.waitForFunction(() => document.body.classList.contains('menu-open'));
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-library-768.png'), fullPage: false });
    const tabletPanel = await page.evaluate(() => document.querySelector('.left-panel').getBoundingClientRect().toJSON());
    assert(Math.abs(tabletPanel.bottom - 1024) <= 1 && tabletPanel.width === 768, `Tablet drawer dimensions are wrong: ${JSON.stringify(tabletPanel)}`);

    await page.evaluate(() => closeStudioMenu());
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.click('#studioMenuButton');
    await page.waitForFunction(() => document.body.classList.contains('menu-open'));
    await page.waitForTimeout(250);
    const desktopPanels = await page.evaluate(() => ({
      left: document.querySelector('.left-panel').getBoundingClientRect().toJSON(),
      right: document.querySelector('.right-panel').getBoundingClientRect().toJSON(),
    }));
    assert(desktopPanels.left.width === 320, `Desktop prompt panel width regressed: ${desktopPanels.left.width}`);
    assert(desktopPanels.right.left === 320 && desktopPanels.right.width === 340, `Desktop settings panel regressed: ${JSON.stringify(desktopPanels.right)}`);
    await page.screenshot({ path: path.join(evidenceDir, 'desktop-library-1280.png'), fullPage: false });
    await page.evaluate(() => closeStudioMenu());
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(evidenceDir, 'desktop-reference-groups-1280.png'), fullPage: false });
    await page.click('#studioMenuButton');
    await page.waitForFunction(() => document.body.classList.contains('menu-open'));
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForFunction(() => document.body.matches('.menu-open.mobile-panel-prompts, .menu-open.mobile-panel-references, .menu-open.mobile-panel-settings'));
    assert(await page.evaluate(() => getComputedStyle(document.querySelector('.left-panel')).display === 'flex'), 'Open desktop library disappeared after resizing to mobile');
    await page.evaluate(() => closeStudioMenu());

    await page.goto(`${baseUrl}/gallery`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.copy-prompt-btn');
    const mappedCard = page.locator('.card').filter({ has: page.locator('.name[title="smoke-output.png"]') });
    await mappedCard.locator('.copy-prompt-btn').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    if (copied.replace(/\r\n/g, '\n') !== persistentOutputPrompt.replace(/\r\n/g, '\n')) {
      throw new Error(`Gallery prompt copy failed. Clipboard contained: ${copied}`);
    }
    assert(await mappedCard.locator('.copy-prompt-btn').textContent() === 'Copied', 'Gallery copy action gave no success feedback');
    const orphanCard = page.locator('.card').filter({ has: page.locator('.name[title="orphan-output.png"]') });
    assert(await orphanCard.locator('.copy-prompt-btn').isDisabled(), 'Gallery enabled prompt copy for an output without stored prompt metadata');
    const galleryCardCount = await page.locator('.card').count();
    page.once('dialog', dialog => dialog.dismiss());
    await mappedCard.locator('.delete-output-btn').click();
    assert(await page.locator('.card').count() === galleryCardCount, 'Dismissed Gallery deletion still removed an output');
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-gallery-375.png'), fullPage: false });

    await fetch(`${baseUrl}/api/store/atlasHistory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify([]) }),
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#serverDot')?.classList.contains('connected'));
    await page.waitForFunction(() => referenceGroups.some(group => group.name === 'Smoke Duo' && group.images?.length === 2));
    await page.waitForFunction(expectedPrompt => history.some(item => item.outputs?.includes('/outputs/smoke-output.png') && item.promptFull === expectedPrompt && !item.promptUnavailable), persistentOutputPrompt);
    assert(await page.evaluate(() => getPromptText(history.find(item => item.outputs?.includes('/outputs/smoke-output.png')))) === persistentOutputPrompt, 'History recovery discarded durable output prompt metadata');

    await fetch(`${baseUrl}/api/store/atlasHistory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify([]) }),
    });
    await fetch(`${baseUrl}/api/store/atlasOutputPrompts`, { method: 'DELETE' });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => history.length > 0 && history.every(item => item.promptUnavailable));
    await page.goto(`${baseUrl}/gallery`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.copy-prompt-btn');
    assert(await page.locator('.copy-prompt-btn:not(:disabled)').count() === 0, 'Recovered legacy outputs exposed a synthetic prompt as copyable');

    await browser.close();
    console.log(`Smoke test passed. Evidence: ${evidenceDir}`);
  } finally {
    await stopServer(server);
    fs.rmSync(smokeDataDir, { recursive: true, force: true });
  }
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
}

async function verifyWheelScroll(page, selector) {
  await page.hover(selector);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(150);
  const metrics = await page.$eval(selector, element => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  assert(metrics.scrollHeight > metrics.clientHeight && metrics.scrollTop > 0, `${selector} did not respond to wheel scrolling: ${JSON.stringify(metrics)}`);
  await page.$eval(selector, element => new Promise(resolve => {
    element.scrollTo(0, 0);
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function waitForHealth(url, instanceToken) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.instanceToken === instanceToken) return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become healthy: ${url}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
