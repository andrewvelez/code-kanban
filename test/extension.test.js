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
  const commands = new Map(), panels = [];
  const noop = { dispose() {} };
  const uri = file => ({ fsPath: file, scheme: 'file', toString: () => pathToFileURL(file).href });
  const folder = { name: 'example', uri: uri(path.join(root, 'repository')) };
  const vscode = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    RelativePattern: class {}, ViewColumn: { Active: 1, Beside: 2 },
    workspace: {
      workspaceFolders: [folder], isTrusted: true,
      createFileSystemWatcher: () => ({ ...noop, onDidChange: () => noop, onDidCreate: () => noop, onDidDelete: () => noop }),
      onDidSaveTextDocument: () => noop
    },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return noop; } },
    window: {
      showInformationMessage: async () => {}, showErrorMessage: async error => { throw new Error(error); },
      registerWebviewPanelSerializer: () => noop,
      createWebviewPanel: () => {
        const events = new EventEmitter(), messages = [];
        const panel = { messages, events, reveal() {}, dispose() {}, onDidDispose: () => noop,
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
  await commands.get('code-kanban.open')(); await commands.get('code-kanban.open')();
  assert.equal(panels.length, 1);
  const panel = panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /script-src 'nonce-/);
  const send = async message => {
    panel.events.emit('message', message);
    for (let i = 0; i < 200; i++) {
      const response = panel.messages.find(item => item.requestId === message.requestId && item.type === 'result');
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
  context.storageUri = undefined;
  await commands.get('code-kanban.open')();
  assert.equal(panels.length, 1);
});
