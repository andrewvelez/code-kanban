const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StoryStore } = require('../src/store');
let store, root, errors;
const data = (content, status = 'backlog') => ({ content, status, priority: 'medium', labels: [], assignee: null, epic: null, dueDate: null });
test.beforeEach(async ({ page }) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-ui-')); store = new StoryStore(root); errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  await page.exposeFunction('hostMessage', async message => {
    let result;
    try {
      switch (message.type) {
        case 'create': result = await store.create(message.data); break;
        case 'update': await store.update(message.number, message.data, message.revision); break;
        case 'move': await store.move(message.number, message.status, message.beforeNumber, message.epic); break;
        case 'flag': await store.flag(message.number, message.field, message.value); break;
        case 'settings': await store.settings(message.data); break;
      }
      return { type: message.type === 'ready' ? 'snapshot' : 'result', requestId: message.requestId, result, repository: 'code-kanban', repositoryUri: 'file:///code-kanban', ...(await store.snapshot()) };
    } catch (error) { return { type: 'result', requestId: message.requestId, error: error.message }; }
  });
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({
      setState: state => { window.savedState = state; },
      getState: () => window.savedState,
      postMessage: message => window.hostMessage(message).then(data => window.dispatchEvent(new MessageEvent('message', { data })))
    });
  });
  await page.route('http://board.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src http://board.test 'unsafe-inline'; script-src 'nonce-test'; img-src data:"><link rel="stylesheet" href="/media/board.css"></head><body class="vscode-dark" style="--vscode-editor-background:#18181b;--vscode-foreground:#e4e4e7;--vscode-descriptionForeground:#a1a1aa"><main id="app"></main><script nonce="test" src="/dist/board.js"></script></body></html>` });
    const files = { '/media/board.css': ['media/board.css', 'text/css'], '/dist/board.js': ['dist/board.js', 'text/javascript'] };
    const file = files[url.pathname];
    if (!file) return route.abort();
    return route.fulfill({ contentType: file[1], body: await fs.readFile(path.join(__dirname, '..', file[0])) });
  });
});
test.afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); expect(errors || []).toEqual([]); });
async function open(page) { await page.goto('http://board.test/'); await expect(page.locator('.column')).toHaveCount(5); }
async function refresh(page) { const snapshot = await store.snapshot(); await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', ...data } })), snapshot); }
test('sidebar story action opens the requested story and saves the current draft', async ({ page }) => {
  await store.create(data('# First story', 'in-progress'));
  await store.create(data('# Second story', 'in-progress'));
  await open(page);
  await page.getByRole('button', { name: 'Story #1: First story', exact: true }).click();
  await page.getByLabel('Story title', { exact: true }).fill('Edited first story');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'openStory', number: 2 } })));
  await expect(page.getByLabel('Story title', { exact: true })).toHaveValue('Second story');
  expect((await store.snapshot()).stories.find(story => story.number === 1).content).toContain('# Edited first story');
});
test('create numbered Markdown story, edit with autosave, and retain across reload', async ({ page }) => {
  await open(page);
  await page.keyboard.press('n');
  await page.getByLabel('Story title', { exact: true }).fill('Ship the board');
  await page.getByLabel('Story description', { exact: true }).fill('Markdown **description**');
  await page.getByRole('button', { name: 'Create story', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Story #1: Ship the board', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Story #1: Ship the board', exact: true }).click();
  await page.getByLabel('Story title', { exact: true }).fill('Board shipped');
  await expect(page.locator('.save-status')).toHaveText('Saved');
  await expect.poll(async () => (await store.snapshot()).stories[0].content).toContain('# Board shipped');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Story #1: Board shipped', exact: true })).toBeVisible();
  expect(await fs.readFile(store.file(1), 'utf8')).toContain('number: 1');
});
test('drag between columns, reorder, filter, archive, undo deletion and keep sequence', async ({ page }) => {
  await store.create(data('# First')); await store.create(data('# Second'));
  await open(page);
  await page.locator('[data-number="1"]').dragTo(page.locator('[data-status="todo"] .cards'));
  await expect(page.locator('[data-status="todo"] [data-number="1"]')).toBeVisible();
  await page.locator('[data-number="2"]').dragTo(page.locator('[data-number="1"]'));
  await expect.poll(async () => page.locator('[data-status="todo"] .card').evaluateAll(cards => cards.map(c => c.dataset.number))).toEqual(['2', '1']);
  await page.getByLabel('Search stories', { exact: true }).fill('#1');
  await expect(page.locator('.card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.locator('[data-number="1"]').click();
  await page.getByRole('button', { name: 'Archive story', exact: true }).click();
  await expect(page.locator('.card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Show archived stories', exact: true }).click();
  await page.locator('[data-number="1"]').click();
  await page.getByRole('button', { name: 'Delete story', exact: true }).click();
  await expect(page.locator('.card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.card')).toHaveCount(1);
  expect(await store.create(data('# Third'))).toBe(3);
});
test('external changes update clean editor, conflicting save retains draft', async ({ page }) => {
  await store.create(data('# Original')); await open(page);
  await page.locator('.card').click();
  let story = (await store.snapshot()).stories[0];
  await store.update(1, { content: '# External' }, story.revision); await refresh(page);
  await expect(page.getByLabel('Story title', { exact: true })).toHaveValue('External');
  await page.getByLabel('Story title', { exact: true }).fill('Local draft');
  story = (await store.snapshot()).stories[0];
  await store.update(1, { content: '# New external change' }, story.revision);
  await expect(page.getByRole('alert')).toContainText('changed outside');
  await expect(page.getByLabel('Story title', { exact: true })).toHaveValue('Local draft');
  expect((await store.snapshot()).stories[0].content).toBe('# New external change');
  await page.getByRole('button', { name: 'Discard draft and reload', exact: true }).click();
  await expect(page.getByLabel('Story title', { exact: true })).toHaveValue('New external change');
});
test('theme, settings and responsive editor render without executing card HTML', async ({ page }) => {
  await store.create(data('# <img src=x onerror=alert(1)>\n\n<script>window.injected=true</script>'));
  await open(page);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.getByRole('button', { name: 'Board settings', exact: true }).click();
  await page.getByLabel('Compact cards', { exact: true }).check();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.locator('.board')).toHaveClass(/compact/);
  await page.getByRole('button', { name: 'Toggle horizontal / vertical layout', exact: true }).click();
  await expect(page.locator('.board')).toHaveClass(/vertical/);
  await page.reload(); await expect(page.locator('.board')).toHaveClass(/vertical/);
  await page.setViewportSize({ width: 600, height: 800 }); await page.locator('.card').click();
  await expect(page.locator('.editor')).toBeVisible(); await expect(page.locator('.board')).toBeHidden();
  await page.evaluate(() => { document.body.className = 'vscode-light'; document.body.style.cssText = ''; });
  await expect(page.locator('.editor')).toBeVisible();
});
test('capture reference layouts with representative stories', async ({ page }) => {
  const examples = [
    ['# GitHub Integration\n\nConnect stories to issues and pull requests.', 'backlog', 'low', 'integration'],
    ['# Keyboard Navigation Support\n\nNavigate every story with the keyboard.', 'todo', 'medium', 'enhancement'],
    ['# CLI Integration\n\n## Commands\n\nCreate and manage story cards from the terminal.\n\n```sh\ncode --install-extension code-kanban.vsix\n```\n\n## Benefits\n\n- Faster developer workflows\n- Markdown stays portable', 'todo', 'medium', 'cli'],
    ['# Full-Text Search\n\nSearch by story number, content, or label.', 'in-progress', 'medium', 'search'],
    ['# Drag & Drop Card Reordering\n\nMove stories between columns.', 'review', 'high', 'core'],
    ['# Dark Mode Support\n\nMatch the current editor theme.', 'review', 'critical', 'theme'],
    ['# Markdown Preview Panel\n\nRead and edit descriptions in the board.', 'done', 'high', 'shipped']
  ];
  for (const [content, status, priority, label] of examples) await store.create({ ...data(content, status), priority, labels: [label], assignee: status === 'done' ? 'Andrew' : null });
  await open(page); await fs.mkdir(path.join(__dirname, '../docs'), { recursive: true });
  await page.screenshot({ path: path.join(__dirname, '../docs/board.png') });
  await page.locator('[data-number="3"]').click();
  await page.getByRole('button', { name: 'Toggle horizontal / vertical layout', exact: true }).click();
  await expect(page.locator('.board')).toHaveClass(/vertical/);
  await page.screenshot({ path: path.join(__dirname, '../docs/editor.png') });
});

 test('dragging between epic lanes updates the epic and preserves the story number', async ({ page }) => {
  await store.create({ ...data('# Epic A story'), epic: 'Epic A' });
  await store.create({ ...data('# Epic B story'), epic: 'Epic B' });
  await store.settings({ epicView: true });
  await page.goto('http://board.test/');
  const lane = page.locator('.lane').filter({ has: page.getByRole('heading', { name: 'Epic B', exact: true }) });
  await page.locator('[data-number="1"]').dragTo(lane.locator('[data-status="todo"] .cards'));
  await expect(lane.locator('[data-status="todo"] [data-number="1"]')).toBeVisible();
  expect((await store.snapshot()).stories.find(s => s.number === 1).epic).toBe('Epic B');
});

test('long story titles wrap on opening, typing and resizing without changing Markdown headings', async ({ page }) => {
  const title = 'A long story title that needs several lines to display every word in a narrow editor beside the Kanban board '.repeat(3).trim();
  await store.create(data(`# ${title}\n\nDescription`));
  await open(page); await page.locator('.card').click();
  const field = page.getByLabel('Story title', { exact: true });
  await expect(field).toHaveValue(title);
  const fits = () => field.evaluate(node => node.clientHeight >= node.scrollHeight && node.clientHeight > 60);
  await expect.poll(fits).toBe(true);
  await page.setViewportSize({ width: 400, height: 800 });
  await expect.poll(fits).toBe(true);
  await field.fill(`${title} More words at the end.`);
  await expect.poll(fits).toBe(true);
  await expect(page.locator('.save-status')).toHaveText('Saved');
  expect((await store.snapshot()).stories[0].content.split('\n')[0]).toBe(`# ${title} More words at the end.`);
});
