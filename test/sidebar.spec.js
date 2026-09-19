/**
 * Browser regression checks for the sidebar overview and its editor actions.
 * @author Andrew Velez 2026
 * @license MIT
 */
const { test, expect } = require('@playwright/test');
const path = require('node:path');

test('overview counts active stories and routes sidebar actions to the editor', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 280, height: 800 });
  await page.setContent('<main id="app"></main>');
  await page.evaluate(() => {
    window.messages = [];
    window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message) });
  });
  await page.addStyleTag({ path: path.join(__dirname, '../media/sidebar.css') });
  await page.addScriptTag({ path: path.join(__dirname, '../dist/sidebar.js') });
  const snapshot = {
    type: 'snapshot', boardOpen: true,
    config: { columns: [{ id: 'todo', name: 'To Do', color: '#3b82f6' }, { id: 'in-progress', name: 'Building', color: '#f59e0b' }] },
    stories: [
      { number: 1, status: 'todo', content: '# Next story', order: 0 },
      { number: 2, status: 'in-progress', content: '# <img src=x onerror=alert(1)>', order: 0 },
      { number: 3, status: 'in-progress', content: '# Archived', archived: true },
      { number: 4, status: 'in-progress', content: '# Deleted', deleted: true }
    ]
  };
  const dispatch = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  await dispatch(snapshot);
  await expect(page.getByRole('main', { name: 'Kanban overview' })).toBeVisible();
  await expect(page.getByText('2 total')).toBeVisible();
  await expect(page.locator('dd')).toHaveText(['1', '1']);
  await expect(page.getByText('Building', { exact: true })).toBeVisible();
  await expect(page.locator('li')).toHaveCount(1);
  await expect(page.locator('img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Kanban Board' })).toBeHidden();
  await page.getByRole('button', { name: '#2 <img src=x onerror=alert(1)>', exact: true }).click();
  await page.getByRole('button', { name: 'New Story', exact: true }).click();
  await dispatch({ type: 'boardOpenChanged', open: false });
  await page.getByRole('button', { name: 'Open Kanban Board' }).click();
  expect(await page.evaluate(() => window.messages)).toEqual([
    { type: 'ready' }, { type: 'openStory', number: 2 }, { type: 'newStory' }, { type: 'openBoard' }
  ]);
  await dispatch({ ...snapshot, stories: [] });
  await expect(page.getByText('0 total')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'In Progress', exact: true })).toBeHidden();
  expect(errors).toEqual([]);
});
