const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StoryStore, repositoryKey, parseStory } = require('../src/store');
const data = (content = '# A story\n\nDescription') => ({ status: 'backlog', priority: 'medium', content, labels: [], assignee: null, epic: null, dueDate: null });
async function storeFor(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-kanban-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new StoryStore(root);
}
test('concurrent writers issue unique permanent numbers and retain them after deletion and reopen', async t => {
  const store = await storeFor(t);
  const otherWindow = new StoryStore(store.directory);
  const numbers = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? store : otherWindow).create(data())));
  assert.deepEqual(numbers.sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
  await store.flag(12, 'deleted', true);
  await store.flag(11, 'archived', true);
  assert.equal(await new StoryStore(store.directory).create(data()), 13);
  const text = await fs.readFile(store.file(1), 'utf8');
  assert.match(text, /number: 1\n/);
  assert.equal(parseStory(text, 1).content, data().content);
});
test('metadata edits preserve Markdown and unknown frontmatter, stale saves fail', async t => {
  const store = await storeFor(t); await store.create(data('# Café\n\n```js\nconst n = 1;\n```\n'));
  const text = await fs.readFile(store.file(1), 'utf8');
  await fs.writeFile(store.file(1), text.replace('number: 1', 'custom: preserve me\nnumber: 1'));
  const [before] = (await store.snapshot()).stories;
  await store.update(1, { priority: 'high', number: 99 }, before.revision);
  const [after] = (await store.snapshot()).stories;
  assert.equal(after.content, before.content); assert.equal(after.custom, 'preserve me'); assert.equal(after.number, 1);
  await assert.rejects(store.update(1, { content: '# stale' }, before.revision), /changed outside/);
  assert.equal((await store.snapshot()).stories[0].content, before.content);
});
test('move and reorder survive reopening without renumbering', async t => {
  const store = await storeFor(t);
  for (let i = 0; i < 3; i++) await store.create(data());
  await store.move(3, 'backlog', 1); await store.move(2, 'done');
  const stories = (await new StoryStore(store.directory).snapshot()).stories;
  assert.deepEqual(stories.filter(s => s.status === 'backlog').sort((a, b) => a.order - b.order).map(s => s.number), [3, 1]);
  assert.ok(stories.find(s => s.number === 2).completedAt);
  await store.move(2, 'todo');
  assert.equal((await store.snapshot()).stories.find(s => s.number === 2).completedAt, null);
});
test('repository storage is isolated and validates card IDs and columns', async t => {
  const root = await storeFor(t);
  const a = new StoryStore(path.join(root.directory, repositoryKey('file:///repo-a')));
  const b = new StoryStore(path.join(root.directory, repositoryKey('file:///repo-b')));
  assert.equal(await a.create(data()), 1); assert.equal(await b.create(data()), 1);
  assert.throws(() => a.file('../elsewhere'), /Invalid story/);
  await assert.rejects(a.create({ ...data(), status: 'unknown' }), /Unknown column/);
  await assert.rejects(a.settings({ columns: [{ id: 'todo', name: 'To Do', color: '#000000' }] }), /Move stories/);
  await a.settings({ compactMode: true, nextNumber: 0 });
  assert.equal((await a.snapshot()).config.nextNumber, 2);
  assert.equal((await b.snapshot()).config.compactMode, false);
});
test('malformed Markdown is reported without overwriting or reusing numbers', async t => {
  const store = await storeFor(t); await store.create(data());
  await fs.writeFile(store.file(1), 'broken frontmatter');
  await assert.rejects(store.create(data()), /missing YAML/);
  assert.equal(await fs.readFile(store.file(1), 'utf8'), 'broken frontmatter');
});
