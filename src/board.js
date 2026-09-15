import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';

const vscode = acquireVsCodeApi();
const app = document.querySelector('#app');
const paths = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  collapse: '<path d="m14 6-6 6 6 6"/>',
  expand: '<path d="m10 6 6 6-6 6"/>',
  rows: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  archive: '<path d="M4 8v13h16V8M9 12h6"/><rect x="2" y="3" width="20" height="5" rx="1"/>',
  file: '<path d="M14 2H5v20h14V7Zm0 0v6h5M8 13h8M8 17h8"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 2v6M16 2v6"/>',
  user: '<circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 16h12l1-16M10 10v8M14 10v8"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  magic: '<path d="m4 20 13-13 3 3L7 23ZM4 2v6M1 5h6M18 1v4M16 3h4"/>',
  tags: '<path d="M2 3h9l11 11-9 9L2 12Z"/><circle cx="7" cy="8" r="1"/>'
};
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor'); node.setAttribute('stroke-width', '1.6');
  node.setAttribute('stroke-linecap', 'round'); node.setAttribute('stroke-linejoin', 'round');
  node.setAttribute('aria-hidden', 'true'); node.innerHTML = paths[name];
  return node;
}
function button(label, name, action, className = '') {
  const node = el('button', className);
  node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
  if (name) node.append(icon(name)); else node.textContent = label;
  node.addEventListener('click', () => Promise.resolve().then(action).catch(showError));
  return node;
}
function select(label, options, value, action) {
  const node = el('select'); node.setAttribute('aria-label', label);
  for (const [id, name] of options) { const option = el('option', '', name); option.value = id; node.append(option); }
  if (value != null) node.value = value;
  if (action) node.addEventListener('change', () => action(node.value));
  return node;
}
const priorities = ['critical', 'high', 'medium', 'low'].map(value => [value, value[0].toUpperCase() + value.slice(1)]);
let state, session, editor, pendingNew = false, serial = 0, dragged = null;
const pending = new Map();
const filters = { search: '', priority: '', assignee: '', label: '', date: '', archived: false };
let toolbar, board, workspace;
function request(type, payload = {}) {
  const requestId = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    vscode.postMessage({ type, requestId, ...payload });
  });
}
function toast(message, actionLabel, action, error = false) {
  document.querySelector('.toast')?.remove();
  const node = el('div', `toast${error ? ' error' : ''}`, message); node.setAttribute('role', error ? 'alert' : 'status');
  if (action) node.append(button(actionLabel, null, async () => { await action(); node.remove(); }));
  node.append(button('Dismiss', 'close', () => node.remove()));
  app.append(node);
}
function showError(error) {
  const message = error.message || String(error);
  if (session?.conflict) {
    toast(message, 'Discard draft and reload', async () => {
      const number = session.story.number;
      disposeEditor();
      const response = await request('refresh');
      openEditor(response.stories.find(story => story.number === number));
    }, true);
  } else toast(message, null, null, true);
}
function accept(next) {
  if (!next.config) return;
  state = { ...state, ...next };
  vscode.setState({ repositoryUri: state.repositoryUri });
  if (!toolbar) init();
  refreshFilters(); renderBoard();
  if (session?.story && !session.dirty && !session.saving) {
    const latest = state.stories.find(story => story.number === session.story.number);
    if (latest && latest.revision !== session.story.revision) openEditor(latest);
  }
  if (pendingNew) { pendingNew = false; openNew().catch(showError); }
}
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'snapshot') accept(message);
  if (message.type === 'newStory') { if (state) openNew().catch(showError); else pendingNew = true; }
  if (message.type === 'error') showError(message.message);
  if (message.type === 'result') {
    const waiting = pending.get(message.requestId); pending.delete(message.requestId);
    if (message.error) waiting?.reject(new Error(message.error));
    else { accept(message); waiting?.resolve(message); }
  }
});
function init() {
  app.replaceChildren();
  toolbar = el('header', 'toolbar'); toolbar.setAttribute('aria-label', 'Board filters');
  const search = el('label', 'search'); const input = el('input'); input.type = 'search';
  input.placeholder = 'Search stories…'; input.setAttribute('aria-label', 'Search stories');
  input.addEventListener('input', () => { filters.search = input.value; renderBoard(); });
  search.append(icon('search'), input); toolbar.append(search);
  const filterBox = el('div', 'filters'); filterBox.style.display = 'contents'; toolbar.append(filterBox);
  toolbar.append(
    button('Clear filters', 'close', () => { Object.assign(filters, { search: '', priority: '', assignee: '', label: '', date: '' }); input.value = ''; refreshFilters(); renderBoard(); }),
    button('Toggle horizontal / vertical layout', 'rows', () => request('settings', { data: { layout: state.config.layout === 'horizontal' ? 'vertical' : 'horizontal' } })),
    button('Toggle epic swimlanes', 'layers', () => request('settings', { data: { epicView: !state.config.epicView } })),
    button('Manage labels', 'tags', manageLabels),
    button('Show archived stories', 'archive', () => { filters.archived = !filters.archived; refreshFilters(); renderBoard(); }),
    button('Board settings', 'settings', settingsDialog)
  );
  const hint = el('span', 'hint'); hint.append('Press ', el('kbd', '', 'n'), ' to add'); toolbar.append(hint);
  workspace = el('div', 'workspace'); board = el('section', 'board'); board.setAttribute('aria-label', 'Stories');
  workspace.append(board); app.append(toolbar, workspace);
}
function refreshFilters() {
  const box = toolbar.querySelector('.filters'); box.replaceChildren();
  const unique = field => [...new Set(state.stories.filter(s => !s.deleted).flatMap(s => s[field] || []).filter(Boolean))].sort();
  const add = (label, key, options) => box.append(select(label, options, filters[key], value => { filters[key] = value; renderBoard(); }));
  if (state.config.showPriorityBadges) add('Filter priority', 'priority', [['', 'All Priorities'], ...priorities]);
  if (state.config.showAssignee) add('Filter assignee', 'assignee', [['', 'All Assignees'], ['__none', 'Unassigned'], ...unique('assignee').map(v => [v, v])]);
  if (state.config.showLabels) add('Filter label', 'label', [['', 'All Labels'], ['__none', 'Unlabeled'], ...unique('labels').map(v => [v, v])]);
  if (state.config.showDueDate) add('Filter due date', 'date', [['', 'All Dates'], ['overdue', 'Overdue'], ['today', 'Due Today'], ['week', 'Due This Week'], ['none', 'No Due Date']]);
  toolbar.querySelector('[aria-label="Show archived stories"]').setAttribute('aria-pressed', String(filters.archived));
  toolbar.querySelector('[aria-label="Toggle epic swimlanes"]').setAttribute('aria-pressed', String(state.config.epicView));
}
function daysUntil(date) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((new Date(`${date}T00:00:00`) - now) / 86400000);
}
function matches(story) {
  if (story.deleted || Boolean(story.archived) !== filters.archived) return false;
  const searchable = `#${story.number} ${story.content} ${story.assignee || ''} ${story.epic || ''} ${story.labels.join(' ')}`.toLowerCase();
  if (!searchable.includes(filters.search.toLowerCase())) return false;
  if (filters.priority && story.priority !== filters.priority) return false;
  if (filters.assignee && (filters.assignee === '__none' ? Boolean(story.assignee) : story.assignee !== filters.assignee)) return false;
  if (filters.label && (filters.label === '__none' ? story.labels.length : !story.labels.includes(filters.label))) return false;
  const days = story.dueDate ? daysUntil(story.dueDate) : null;
  if (filters.date === 'none' && days != null) return false;
  if (filters.date === 'overdue' && !(days != null && days < 0)) return false;
  if (filters.date === 'today' && days !== 0) return false;
  if (filters.date === 'week' && !(days != null && days >= 0 && days <= 7)) return false;
  return true;
}
function title(story) { return story.content.match(/^#\s+(.+)$/m)?.[1] || story.content.split('\n').find(Boolean) || 'Untitled story'; }
function body(story) { return story.content.replace(/^#\s+.*(?:\r?\n|$)/m, '').trim(); }
function renderBoard() {
  if (!board) return;
  board.className = `board ${state.config.layout}${state.config.compactMode ? ' compact' : ''}${state.config.epicView ? ' epics' : ''}`;
  board.replaceChildren();
  const stories = state.stories.filter(matches).sort((a, b) => a.order - b.order || a.number - b.number);
  if (state.config.epicView) {
    const epics = [...new Set(stories.map(s => s.epic || ''))].sort();
    if (!epics.length) epics.push('');
    for (const epic of epics) {
      const lane = el('section', 'lane'); lane.append(el('h2', '', epic || 'No epic'));
      const row = el('div', 'lane-columns');
      for (const column of state.config.columns) row.append(renderColumn(column, stories.filter(s => (s.epic || '') === epic), epic));
      lane.append(row); board.append(lane);
    }
  } else for (const column of state.config.columns) board.append(renderColumn(column, stories));
}
function renderColumn(column, stories, epic) {
  const items = stories.filter(story => story.status === column.id);
  const collapsed = state.config.collapsed.includes(column.id);
  const node = el('section', `column${collapsed ? ' collapsed' : ''}`); node.dataset.status = column.id;
  node.setAttribute('aria-label', column.name);
  const header = el('header', 'column-header'); const dot = el('span', 'dot'); dot.style.background = column.color;
  header.append(dot, el('h2', '', column.name), el('span', 'count', items.length));
  header.append(button(`${collapsed ? 'Expand' : 'Collapse'} ${column.name}`, collapsed ? 'expand' : 'collapse', () => request('settings', { data: { collapsed: collapsed ? state.config.collapsed.filter(id => id !== column.id) : [...state.config.collapsed, column.id] } })));
  if (!collapsed) header.append(button(`Add story to ${column.name}`, 'plus', () => openNew(column.id)), button(`${column.name} options`, 'more', () => columnMenu(column)));
  node.append(header);
  if (!collapsed) {
    const add = button('Add story', 'plus', () => openNew(column.id), 'add-story'); add.append('Add story'); node.append(add);
    const cards = el('div', 'cards'); items.forEach(story => cards.append(renderCard(story)));
    if (!items.length) cards.append(el('p', 'empty', filters.archived ? 'No archived stories' : 'No stories'));
    node.append(cards);
  }
  node.addEventListener('dragover', event => {
    if (dragged == null) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; clearDrop(); node.classList.add('drop-target');
    const target = event.target.closest('.card');
    if (target && Number(target.dataset.number) !== dragged) target.classList.add('drop-before');
  });
  node.addEventListener('drop', event => {
    event.preventDefault(); const number = dragged; clearDrop();
    if (number == null) return;
    const target = event.target.closest('.card'); const beforeNumber = target ? Number(target.dataset.number) : null;
    if (number === beforeNumber) return;
    Promise.resolve().then(async () => { await flushEditor(); await request('move', { number, status: column.id, beforeNumber, epic }); }).catch(showError);
  });
  return node;
}
function clearDrop() { board.querySelectorAll('.drop-target,.drop-before').forEach(node => node.classList.remove('drop-target', 'drop-before')); }
function renderCard(story) {
  const node = el('article', `card${session?.story?.number === story.number ? ' selected' : ''}`);
  node.dataset.number = story.number; node.draggable = true; node.tabIndex = 0;
  node.setAttribute('role', 'button'); node.setAttribute('aria-label', `Story #${story.number}: ${title(story)}`);
  const top = el('div', 'card-top'); top.append(el('span', 'number', `#${story.number}${state.config.showFileName ? ` · STORY-${String(story.number).padStart(4, '0')}.md` : ''}`));
  if (state.config.showPriorityBadges) top.append(el('span', `priority ${story.priority}`, story.priority === 'medium' ? 'Med' : story.priority[0].toUpperCase() + story.priority.slice(1)));
  node.append(top, el('h3', '', title(story)));
  const description = body(story).replace(/[#*`>]/g, '').replace(/\n/g, ' ');
  if (description) node.append(el('p', 'description', description));
  if (state.config.showEpic && story.epic) node.append(el('span', 'epic', story.epic));
  if (state.config.showLabels && story.labels.length) {
    const labels = el('div', 'labels'); story.labels.slice(0, 3).forEach(label => labels.append(el('span', 'label', label)));
    if (story.labels.length > 3) labels.append(el('span', '', `+${story.labels.length - 3}`)); node.append(labels);
  }
  const footer = el('div', 'card-footer'); const assignee = el('span');
  if (state.config.showAssignee && story.assignee) assignee.append(icon('user'), story.assignee); footer.append(assignee);
  if (state.config.showDueDate && story.dueDate && story.status !== 'done') {
    const days = daysUntil(story.dueDate); const due = el('span', days < 0 ? 'overdue' : '');
    due.append(icon('calendar'), days < 0 ? 'Overdue' : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days <= 7 ? `${days}d` : new Date(`${story.dueDate}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    footer.append(due);
  }
  node.append(footer);
  const open = async () => { await closeEditor(); if (state.config.markdownEditorMode) await request('openFile', { number: story.number }); else openEditor(state.stories.find(s => s.number === story.number)); };
  node.addEventListener('click', () => open().catch(showError));
  node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open().catch(showError); } });
  node.addEventListener('dragstart', event => { dragged = story.number; node.classList.add('dragging'); event.dataTransfer.setData('text/plain', String(story.number)); event.dataTransfer.effectAllowed = 'move'; });
  node.addEventListener('dragend', () => { dragged = null; node.classList.remove('dragging'); clearDrop(); });
  return node;
}
async function openNew(status = state.config.defaultStatus) { await closeEditor(); openEditor(null, status); }
function openEditor(story, status) {
  editor?.destroy(); workspace.querySelector('.editor')?.remove();
  session = { story, dirty: false, version: 0, saving: null, timer: null, contentChanged: false };
  const current = session;
  const node = el('aside', 'editor'); node.setAttribute('aria-label', story ? `Edit story #${story.number}` : 'New story');
  const heading = el('header', 'editor-header'); heading.append(el('strong', '', story ? `Story #${story.number}` : 'New story'));
  current.status = el('span', 'save-status', story ? 'Saved' : 'Draft'); heading.append(current.status);
  if (story) heading.append(button('Build with AI', 'magic', async () => { await flushEditor(); await request('startAI', { number: story.number }); }), button('Open Markdown file', 'file', async () => { await flushEditor(); await request('openFile', { number: story.number }); }));
  heading.append(button('Save and close', 'close', closeEditor)); node.append(heading);
  const properties = el('div', 'properties'); current.fields = {};
  function property(label, key, control) {
    const row = el('label', 'property'); row.append(el('span', '', label), control); properties.append(row); current.fields[key] = control;
    control.addEventListener('input', () => changed(current));
  }
  property('Status', 'status', select('Story status', state.config.columns.map(c => [c.id, c.name]), story?.status || status));
  property('Priority', 'priority', select('Story priority', priorities, story?.priority || state.config.defaultPriority));
  for (const [label, key, type, placeholder] of [['Assignee', 'assignee', 'text', 'Unassigned'], ['Epic', 'epic', 'text', 'No epic'], ['Due date', 'dueDate', 'date', ''], ['Labels', 'labels', 'text', 'Separate labels with commas']]) {
    const input = el('input'); input.type = type; input.placeholder = placeholder;
    input.value = key === 'labels' ? (story?.labels || []).join(', ') : story?.[key] || '';
    property(label, key, input);
  }
  node.append(properties);
  const content = el('div', 'editor-content'); current.title = el('input', 'story-title'); current.title.placeholder = 'Story title'; current.title.setAttribute('aria-label', 'Story title'); current.title.value = story ? title(story) : '';
  current.title.addEventListener('input', () => { current.contentChanged = true; changed(current); }); content.append(current.title);
  const rich = el('div'); content.append(rich); node.append(content);
  const footer = el('footer', 'editor-footer'); footer.append(el('span', '', story ? 'Auto-saved · Ctrl/Cmd+Enter to close' : 'Esc or Ctrl/Cmd+Enter to save and close'), el('span', 'spacer'));
  if (story) footer.append(button(story.archived ? 'Restore story' : 'Archive story', 'archive', async () => { await closeEditor(); await request('flag', { number: story.number, field: 'archived', value: !story.archived }); }), button('Delete story', 'trash', async () => {
    await closeEditor(); await request('flag', { number: story.number, field: 'deleted', value: true });
    toast(`Deleted story #${story.number}`, 'Undo', () => request('flag', { number: story.number, field: 'deleted', value: false }));
  }, 'danger'));
  else footer.append(button('Discard draft', null, () => disposeEditor()), button('Create story', null, closeEditor, 'primary'));
  node.append(footer); workspace.append(node);
  editor = new Editor({ element: rich, extensions: [StarterKit.configure({ link: { openOnClick: false } }), Markdown.configure({ html: false, transformPastedText: true })], content: story ? body(story) : '', injectCSS: false,
    editorProps: {
      attributes: { 'aria-label': 'Story description', role: 'textbox', 'aria-multiline': 'true' },
      handleTextInput(view, from, to, text) {
        // Tiptap's single-keystroke input rules cannot map a multi-character insertion.
        // Real paste events still use the Markdown paste handler.
        if (text.length <= 1) return false;
        view.dispatch(view.state.tr.insertText(text, from, to));
        return true;
      }
    },
    onUpdate: () => { current.contentChanged = true; changed(current); }
  });
  current.editor = editor;
  current.title.focus(); renderBoard();
}
function changed(current) {
  current.dirty = true; current.version++; current.status.textContent = current.story ? 'Unsaved' : 'Draft';
  clearTimeout(current.timer);
  if (current.story) current.timer = setTimeout(() => flushEditor().catch(showError), 500);
}
function draft(current) {
  const data = Object.fromEntries(Object.entries(current.fields).map(([key, input]) => [key, input.value]));
  data.labels = [...new Set(data.labels.split(',').map(label => label.trim()).filter(Boolean))];
  for (const key of ['assignee', 'epic', 'dueDate']) data[key] = data[key].trim() || null;
  data.content = current.story && !current.contentChanged ? current.story.content : `${current.title.value.trim() ? `# ${current.title.value.trim()}\n\n` : ''}${current.editor.storage.markdown.getMarkdown()}`;
  return data;
}
async function flushEditor() {
  const current = session;
  if (!current) return;
  clearTimeout(current.timer);
  if (current.saving) return current.saving;
  if (!current.dirty) return;
  if (current.conflict) throw new Error(current.conflict);
  current.saving = (async () => {
    while (current.dirty) {
      const version = current.version; const data = draft(current);
      if (!data.content.trim() && !current.story) return;
      current.status.textContent = 'Saving…';
      try {
        const response = await request(current.story ? 'update' : 'create', current.story ? { number: current.story.number, revision: current.story.revision, data } : { data });
        const number = current.story?.number || response.result;
        current.story = response.stories.find(story => story.number === number);
        current.dirty = current.version !== version;
        current.status.textContent = current.dirty ? 'Unsaved' : 'Saved';
      } catch (error) {
        current.status.textContent = 'Not saved';
        if (error.message.includes('changed outside')) current.conflict = error.message;
        throw error;
      }
    }
  })();
  try { await current.saving; } finally { current.saving = null; }
}
function disposeEditor() {
  if (session) clearTimeout(session.timer);
  editor?.destroy(); editor = null; session = null;
  workspace.querySelector('.editor')?.remove(); renderBoard();
}
async function closeEditor() { await flushEditor(); disposeEditor(); }
function dialog(titleText) {
  const node = el('dialog'); node.setAttribute('aria-label', titleText); node.append(el('h2', '', titleText));
  app.append(node); node.addEventListener('close', () => node.remove()); return node;
}
function settingsDialog() {
  const node = dialog('Board settings'); const fields = {};
  for (const [key, label] of Object.entries({ compactMode: 'Compact cards', showPriorityBadges: 'Priority badges', showAssignee: 'Assignees', showDueDate: 'Due dates', showLabels: 'Labels', showEpic: 'Epics', showFileName: 'Markdown filenames', markdownEditorMode: 'Open cards in native Markdown editor', addNewCardsToTop: 'Add new cards at top' })) {
    const row = el('label'); const input = el('input'); input.type = 'checkbox'; input.checked = state.config[key]; fields[key] = input; row.append(input, label); node.append(row);
  }
  const priority = select('Default priority', priorities, state.config.defaultPriority);
  const status = select('Default status', state.config.columns.map(c => [c.id, c.name]), state.config.defaultStatus);
  for (const [name, control] of [['Default priority', priority], ['Default status', status]]) { const label = el('label', '', name); label.append(control); node.append(label); }
  node.append(el('p', '', 'Columns'));
  const columns = el('div'); const columnFields = [];
  function addColumn(column) {
    const row = el('label'); const name = el('input'); name.value = column.name; name.setAttribute('aria-label', 'Column name');
    const color = el('input'); color.type = 'color'; color.value = column.color; color.setAttribute('aria-label', 'Column color');
    const entry = { id: column.id, name, color };
    columnFields.push(entry);
    row.append(name, color, button('Remove column', 'trash', () => { columnFields.splice(columnFields.indexOf(entry), 1); row.remove(); }));
    columns.append(row);
  }
  state.config.columns.forEach(addColumn);
  node.append(columns, button('Add column', null, () => addColumn({ id: `column-${crypto.randomUUID()}`, name: 'New column', color: '#6b7280' })));
  const footer = el('footer'); footer.append(button('Cancel', null, () => node.close()), button('Save settings', null, async () => {
    await flushEditor();
    const data = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.checked]));
    Object.assign(data, { defaultPriority: priority.value, defaultStatus: status.value, columns: columnFields.map(({ id, name, color }) => ({ id, name: name.value, color: color.value })) });
    await request('settings', { data }); node.close();
  }, 'primary')); node.append(footer); node.showModal();
}
function columnMenu(column) {
  const node = dialog(`${column.name} options`);
  node.append(el('p', '', 'Apply to all active stories in this column.'));
  const target = select('Move all to', state.config.columns.filter(c => c.id !== column.id).map(c => [c.id, c.name])); node.append(target);
  node.append(button('Move all stories', null, async () => {
    await flushEditor();
    const numbers = state.stories.filter(s => s.status === column.id && !s.deleted && !s.archived).map(s => s.number);
    for (const number of numbers) await request('move', { number, status: target.value }); node.close();
  }));
  node.append(button('Archive all stories', null, async () => {
    await closeEditor();
    const numbers = state.stories.filter(s => s.status === column.id && !s.deleted && !s.archived).map(s => s.number);
    for (const number of numbers) await request('flag', { number, field: 'archived', value: true }); node.close();
  }), button('Close', null, () => node.close())); node.showModal();
}
function manageLabels() {
  const node = dialog('Manage labels');
  const labels = [...new Set(state.stories.filter(s => !s.deleted).flatMap(s => s.labels))].sort();
  if (!labels.length) node.append(el('p', '', 'Add labels in a story to manage them here.'));
  for (const label of labels) {
    const row = el('label'); const input = el('input'); input.value = label; input.setAttribute('aria-label', `Rename ${label}`);
    const change = async replacement => {
      await flushEditor();
      const stories = state.stories.filter(s => !s.deleted && s.labels.includes(label));
      for (const story of stories) await request('update', { number: story.number, revision: story.revision, data: { labels: [...new Set(story.labels.flatMap(value => value === label ? replacement ? [replacement] : [] : [value]))] } });
      node.close(); manageLabels();
    };
    row.append(input, button('Rename label', null, () => change(input.value.trim())), button(`Remove ${label}`, 'trash', () => change(''))); node.append(row);
  }
  node.append(button('Close', null, () => node.close())); node.showModal();
}
document.addEventListener('keydown', event => {
  if (!state || document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key === 's'))) {
    if (session) { event.preventDefault(); closeEditor().catch(showError); } return;
  }
  if (event.key === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.target.closest('input,textarea,select,[contenteditable=true]')) {
    event.preventDefault(); openNew().catch(showError);
  }
});
window.addEventListener('blur', () => { if (session?.story) flushEditor().catch(showError); });
vscode.postMessage({ type: 'ready' });
