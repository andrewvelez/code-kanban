/**
 * Repository overview and actions for the Code Kanban sidebar.
 * @author Andrew Velez 2026
 * @license MIT
 */
const vscode = acquireVsCodeApi();
const app = document.querySelector('#app');
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function action(label, message, className) {
  const node = element('button', label, className);
  node.type = 'button';
  node.addEventListener('click', () => vscode.postMessage(message));
  return node;
}
const openBoard = action('Open Kanban Board', { type: 'openBoard' });
const newStory = action('New Story', { type: 'newStory' }, 'secondary');
const actions = element('div', null, 'actions');
actions.append(openBoard, newStory);
const overview = element('section');
const heading = element('h2', 'Overview');
const total = element('span', '0 total');
heading.append(total);
const counts = element('dl');
overview.append(heading, counts);
const inProgress = element('section');
const stories = element('ul');
inProgress.append(element('h2', 'In Progress'), stories);
inProgress.hidden = true;
const error = element('p');
error.setAttribute('role', 'alert');
error.hidden = true;
app.setAttribute('aria-label', 'Kanban overview');
app.replaceChildren(actions, overview, inProgress, error);
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'boardOpenChanged') openBoard.hidden = message.open;
  if (message.type === 'error') { error.textContent = message.message; error.hidden = false; }
  if (message.type !== 'snapshot') return;
  error.hidden = true;
  openBoard.hidden = message.boardOpen;
  const active = message.stories.filter(story => !story.archived && !story.deleted);
  total.textContent = `${active.length} total`;
  counts.replaceChildren();
  for (const column of message.config.columns) {
    const label = element('dt', column.name);
    const dot = element('span', null, 'dot');
    dot.style.backgroundColor = column.color;
    label.prepend(dot);
    counts.append(label, element('dd', active.filter(story => story.status === column.id).length));
  }
  stories.replaceChildren();
  const current = active.filter(story => story.status === 'in-progress').sort((a, b) => a.order - b.order || a.number - b.number);
  inProgress.hidden = !current.length;
  for (const story of current) {
    const title = story.content.split('\n')[0].replace(/^#+\s*/, '').trim();
    const item = element('li');
    item.append(action(`#${story.number} ${title}`, { type: 'openStory', number: story.number }, 'story'));
    stories.append(item);
  }
});
vscode.postMessage({ type: 'ready' });
