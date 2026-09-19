const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { repositoryKey } = require('../src/store');

test('extension commands open one tab per repository and route Markdown writes under storageUri', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const commands = new Map(), panels = [], watchers = [];
  let sidebarProvider;
  const noop = { dispose() {} };
  const uri = file => ({ fsPath: file, scheme: 'file', toString: () => pathToFileURL(file).href });
  const folder = { name: 'example', uri: uri(path.join(root, 'repository')) };
  const vscode = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    RelativePattern: class {}, ViewColumn: { Active: 1, Beside: 2 },
    workspace: {
      workspaceFolders: [folder], isTrusted: true,
      createFileSystemWatcher: () => {
        const events = new EventEmitter(); watchers.push(events);
        const on = name => callback => { events.on(name, callback); return { dispose: () => events.off(name, callback) }; };
        return { dispose: () => events.removeAllListeners(), onDidChange: on('change'), onDidCreate: on('create'), onDidDelete: on('delete') };
      },
      onDidSaveTextDocument: () => noop
    },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return noop; } },
    window: {
      showInformationMessage: async () => {}, showErrorMessage: async error => { throw new Error(error); },
      registerWebviewPanelSerializer: () => noop,
      registerWebviewViewProvider: (id, provider) => { assert.equal(id, 'code-kanban.boardView'); sidebarProvider = provider; return noop; },
      createWebviewPanel: (type, title, column) => {
        if (type) { assert.equal(type, 'code-kanban.board'); assert.equal(column, vscode.ViewColumn.Active); }
        const events = new EventEmitter(), messages = [];
        const panel = { messages, events, visible: true, reveals: 0,
          reveal() { this.reveals++; }, dispose() { events.emit('dispose'); },
          onDidDispose: callback => { events.on('dispose', callback); return noop; },
          onDidChangeVisibility: callback => { events.on('visibility', callback); return { dispose: () => events.off('visibility', callback) }; },
          webview: { asWebviewUri: uri => uri.toString(), cspSource: 'vscode-webview:',
            postMessage: async message => { messages.push(message); return true; },
            onDidReceiveMessage: callback => { events.on('message', callback); return { dispose: () => events.off('message', callback) }; }
          }
        };
        panels.push(panel); return panel;
      }
    }
  };
  const load = Module._load;
  Module._load = function(name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
  let activate;
  try { ({ activate } = require('../src/extension')); } finally { Module._load = load; }
  const context = { subscriptions: [], extensionUri: uri(path.resolve(__dirname, '..')), storageUri: uri(path.join(root, 'storage')) };
  activate(context);
  t.after(() => context.subscriptions.forEach(item => item.dispose()));
  const sidebar = vscode.window.createWebviewPanel();
  panels.pop(); // VS Code supplies sidebar views independently of editor panels.
  t.after(() => sidebar.dispose());
  await sidebarProvider.resolveWebviewView(sidebar);
  assert.equal(panels.length, 1, 'first Activity Bar activation opens an editor tab');
  assert.match(sidebar.webview.html, /dist\/sidebar.js/);
  assert.doesNotMatch(sidebar.webview.html, /dist\/board.js/);
  await commands.get('code-kanban.open')();
  assert.equal(panels.length, 1);
  const panel = panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /script-src 'nonce-/);
  const send = async (message, target = panel) => {
    target.events.emit('message', message);
    for (let i = 0; i < 200; i++) {
      const response = target.messages.find(item => item.requestId === message.requestId && item.type === 'result');
      if (response) { assert.equal(response.error, undefined); return response; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('No extension response');
  };
  const result = await send({ type: 'create', requestId: 1, data: { status: 'backlog', priority: 'medium', labels: [], content: '# Host story' } });
  assert.equal(result.result, 1);
  const file = path.join(context.storageUri.fsPath, 'repositories', repositoryKey(folder.uri.toString()), 'STORY-0001.md');
  assert.match(await fs.readFile(file, 'utf8'), /# Host story/);
  await assert.rejects(fs.stat(folder.uri.fsPath), { code: 'ENOENT' });
  const until = async predicate => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('Expected extension event did not arrive');
  };
  // A sidebar action must survive an editor that has not loaded yet.
  sidebar.events.emit('message', { type: 'newStory' });
  await until(() => panel.reveals === 2);
  assert.equal(panel.messages.some(message => message.type === 'newStory'), false);
  panel.events.emit('message', { type: 'ready' });
  await until(() => panel.messages.some(message => message.type === 'newStory'));
  assert.ok(panel.messages.findIndex(message => message.type === 'snapshot') < panel.messages.findIndex(message => message.type === 'newStory'));
  sidebar.events.emit('message', { type: 'ready' });
  await until(() => sidebar.messages.some(message => message.type === 'snapshot'));
  assert.equal(sidebar.messages.find(message => message.type === 'snapshot').stories[0].content, '# Host story');
  const before = panel.reveals;
  sidebar.visible = false; sidebar.events.emit('visibility');
  assert.equal(panel.reveals, before, 'hiding the sidebar must not reveal the board');
  sidebar.visible = true; sidebar.events.emit('visibility');
  await until(() => panel.reveals === before + 1);
  assert.equal(panels.length, 1, 'returning to the Activity Bar reuses the editor');
  // Sidebar actions retain their repository even in a multi-root workspace.
  vscode.workspace.workspaceFolders.push({ name: 'other', uri: uri(path.join(root, 'other')) });
  vscode.window.showWorkspaceFolderPick = () => { throw new Error('Sidebar must not reprompt for its repository'); };
  sidebar.events.emit('message', { type: 'openStory', number: 1 });
  await until(() => panel.messages.some(message => message.type === 'openStory' && message.number === 1));
  vscode.workspace.workspaceFolders.pop();
  await send({ type: 'create', requestId: 3, data: { status: 'in-progress', priority: 'high', labels: [], content: '# Another story' } });
  for (const watcher of watchers) watcher.emit('change');
  await until(() => sidebar.messages.some(message => message.type === 'snapshot' && message.stories.length === 2));
  panel.dispose();
  assert.equal(sidebar.messages.at(-1).open, false, 'overview offers reopening when the tab closes');
  sidebar.visible = false; sidebar.events.emit('visibility');
  sidebar.visible = true; sidebar.events.emit('visibility');
  await until(() => panels.length === 2);
  assert.equal(sidebar.messages.at(-1).open, true);
  await commands.get('code-kanban.open')();
  assert.equal(panels.length, 2, 'only one replacement tab is created');
  context.storageUri = undefined;
  await commands.get('code-kanban.open')();
  assert.equal(panels.length, 2);
});
