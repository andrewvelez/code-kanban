const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { lock } = require('proper-lockfile');
const YAML = require('yaml');

const columns = [
  { id: 'backlog', name: 'Backlog', color: '#6b7280' },
  { id: 'todo', name: 'To Do', color: '#3b82f6' },
  { id: 'in-progress', name: 'In Progress', color: '#f59e0b' },
  { id: 'review', name: 'Review', color: '#8b5cf6' },
  { id: 'done', name: 'Done', color: '#22c55e' }
];
const defaults = {
  columns, nextNumber: 1, layout: 'horizontal', collapsed: [], epicView: false,
  compactMode: false, defaultPriority: 'medium', defaultStatus: 'backlog',
  showPriorityBadges: true, showAssignee: true, showDueDate: true,
  showLabels: true, showEpic: true, showFileName: false, markdownEditorMode: false,
  addNewCardsToTop: false
};
const revision = text => createHash('sha256').update(text).digest('hex');
const storyFilename = number => `STORY-${String(number).padStart(4, '0')}.md`;
const repositoryKey = uri => createHash('sha256').update(uri).digest('hex').slice(0, 20);

function parseStory(text, number) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${storyFilename(number)}: missing YAML frontmatter.`);
  const data = YAML.parse(match[1]);
  if (!data || data.number !== number) throw new Error(`${storyFilename(number)}: story number must match its filename.`);
  if (typeof data.status !== 'string' || !['critical', 'high', 'medium', 'low'].includes(data.priority) ||
      !Array.isArray(data.labels) || data.labels.some(label => typeof label !== 'string') ||
      !Number.isFinite(data.order)) throw new Error(`${storyFilename(number)}: invalid story metadata.`);
  for (const field of ['assignee', 'epic', 'dueDate']) {
    if (data[field] != null && typeof data[field] !== 'string') throw new Error(`${storyFilename(number)}: invalid ${field}.`);
  }
  return { ...data, content: match[2].replace(/^\r?\n/, ''), revision: revision(text) };
}
function serializeStory(story) {
  const { content, revision: ignored, ...metadata } = story;
  return `---\n${YAML.stringify(metadata)}---\n\n${content}`;
}
async function atomicWrite(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, text, { flag: 'wx' });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

class StoryStore {
  constructor(directory) { this.directory = directory; }
  file(number) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid story number.');
    return path.join(this.directory, storyFilename(number));
  }
  async transaction(action) {
    await fs.mkdir(this.directory, { recursive: true });
    const release = await lock(this.directory, { retries: { retries: 30, minTimeout: 25, maxTimeout: 200 }, stale: 10000 });
    try { return await action(); } finally { await release(); }
  }
  async config() {
    try { return { ...defaults, ...JSON.parse(await fs.readFile(path.join(this.directory, 'board.json'), 'utf8')) }; }
    catch (error) { if (error.code === 'ENOENT') return structuredClone(defaults); throw error; }
  }
  async stories() {
    let files;
    try { files = await fs.readdir(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(files.filter(file => /^STORY-\d+\.md$/.test(file)).map(async file =>
      parseStory(await fs.readFile(path.join(this.directory, file), 'utf8'), Number(file.match(/\d+/)[0]))));
  }
  async snapshot() {
    return this.transaction(async () => ({ config: await this.config(), stories: await this.stories() }));
  }
  async writeConfig(config) { await atomicWrite(path.join(this.directory, 'board.json'), `${JSON.stringify(config, null, 2)}\n`); }
  async writeStory(story) { await atomicWrite(this.file(story.number), serializeStory(story)); }
  validate(data, config) {
    if (!config.columns.some(column => column.id === data.status)) throw new Error('Unknown column.');
    if (!['critical', 'high', 'medium', 'low'].includes(data.priority)) throw new Error('Invalid priority.');
    if (typeof data.content !== 'string' || !data.content.trim()) throw new Error('Enter a story title or description.');
    if (!Array.isArray(data.labels) || data.labels.some(label => typeof label !== 'string')) throw new Error('Invalid labels.');
    for (const field of ['assignee', 'epic', 'dueDate']) {
      if (data[field] != null && typeof data[field] !== 'string') throw new Error(`Invalid ${field}.`);
    }
    if (data.dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(data.dueDate) || Number.isNaN(Date.parse(data.dueDate)))) throw new Error('Invalid due date.');
  }
  async create(data) {
    return this.transaction(async () => {
      const config = await this.config();
      const stories = await this.stories();
      const now = new Date().toISOString();
      const number = Math.max(config.nextNumber, 1, ...stories.map(story => story.number + 1));
      if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid story counter.');
      const peers = stories.filter(story => story.status === data.status && !story.archived && !story.deleted);
      const order = config.addNewCardsToTop ? Math.min(0, ...peers.map(story => story.order)) - 1 : Math.max(0, ...peers.map(story => story.order)) + 1;
      const story = { number, status: data.status, priority: data.priority, assignee: data.assignee || null,
        epic: data.epic || null, dueDate: data.dueDate || null, labels: data.labels,
        order, archived: false, deleted: false, created: now, modified: now,
        completedAt: data.status === 'done' ? now : null, content: data.content };
      this.validate(story, config);
      // Reserve first: even a failed write must never reuse an issued number.
      await this.writeConfig({ ...config, nextNumber: number + 1 });
      await this.writeStory(story);
      return number;
    });
  }
  async update(number, patch, expectedRevision) {
    return this.transaction(async () => {
      const story = parseStory(await fs.readFile(this.file(number), 'utf8'), number);
      if (!expectedRevision || story.revision !== expectedRevision) throw new Error('This story changed outside this editor. Your draft is kept open; reopen the story after copying your changes.');
      const config = await this.config();
      const next = { ...story };
      for (const key of ['content', 'status', 'priority', 'assignee', 'epic', 'dueDate', 'labels']) {
        if (Object.hasOwn(patch, key)) next[key] = patch[key];
      }
      this.validate(next, config);
      next.modified = new Date().toISOString();
      if (next.status !== story.status) next.completedAt = next.status === 'done' ? next.modified : null;
      await this.writeStory(next);
    });
  }
  async move(number, status, beforeNumber = null, epic) {
    return this.transaction(async () => {
      const config = await this.config();
      if (!config.columns.some(column => column.id === status)) throw new Error('Unknown column.');
      const stories = await this.stories();
      const story = stories.find(item => item.number === number && !item.deleted);
      if (!story) throw new Error('Story not found.');
      const peers = stories.filter(item => item.number !== number && item.status === status && item.archived === story.archived && !item.deleted).sort((a, b) => a.order - b.order || a.number - b.number);
      const index = beforeNumber == null ? peers.length : peers.findIndex(item => item.number === beforeNumber);
      if (index < 0) throw new Error('Drop target changed. Try moving the story again.');
      const before = peers[index - 1]?.order;
      const after = peers[index]?.order;
      story.order = before == null ? (after ?? 1) - 1 : after == null ? before + 1 : (before + after) / 2;
      const now = new Date().toISOString();
      if (story.status !== status) story.completedAt = status === 'done' ? now : null;
      story.status = status;
      if (epic !== undefined) {
        if (typeof epic !== 'string') throw new Error('Invalid epic.');
        story.epic = epic || null;
      }
      story.modified = now;
      // Rebalance only when repeated insertions exhaust floating-point space.
      if (story.order === before || story.order === after) {
        peers.splice(index, 0, story);
        for (const [order, item] of peers.entries()) await this.writeStory({ ...item, order });
      } else await this.writeStory(story);
    });
  }
  async flag(number, field, value) {
    if (!['archived', 'deleted'].includes(field) || typeof value !== 'boolean') throw new Error('Invalid story action.');
    return this.transaction(async () => {
      const story = parseStory(await fs.readFile(this.file(number), 'utf8'), number);
      await this.writeStory({ ...story, [field]: value, modified: new Date().toISOString() });
    });
  }
  async settings(patch) {
    return this.transaction(async () => {
      const current = await this.config();
      for (const [key, value] of Object.entries(patch)) {
        if (typeof defaults[key] === 'boolean' && typeof value === 'boolean') current[key] = value;
      }
      if (['horizontal', 'vertical'].includes(patch.layout)) current.layout = patch.layout;
      if (Array.isArray(patch.collapsed) && patch.collapsed.every(id => typeof id === 'string')) current.collapsed = patch.collapsed;
      if (['critical', 'high', 'medium', 'low'].includes(patch.defaultPriority)) current.defaultPriority = patch.defaultPriority;
      if (patch.columns) {
        if (!Array.isArray(patch.columns) || !patch.columns.length || patch.columns.some(c => !c || typeof c.id !== 'string' || !c.id.trim() || typeof c.name !== 'string' || !c.name.trim() || !/^#[\da-f]{6}$/i.test(c.color)) || new Set(patch.columns.map(c => c.id)).size !== patch.columns.length) throw new Error('Columns need unique IDs, names, and six-digit hex colors.');
        const stories = await this.stories();
        if (stories.some(story => !story.deleted && !patch.columns.some(c => c.id === story.status))) throw new Error('Move stories out of a column before removing it.');
        current.columns = patch.columns.map(({ id, name, color }) => ({ id, name, color }));
      }
      if (patch.defaultStatus && current.columns.some(c => c.id === patch.defaultStatus)) current.defaultStatus = patch.defaultStatus;
      if (!current.columns.some(c => c.id === current.defaultStatus)) current.defaultStatus = current.columns[0].id;
      await this.writeConfig(current);
    });
  }
}
module.exports = { StoryStore, defaults, parseStory, serializeStory, repositoryKey, storyFilename };
