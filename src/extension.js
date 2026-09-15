const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const { StoryStore, repositoryKey } = require('./store');

function activate(context) {
  const panels = new Map();
  async function folderForBoard() {
    const folders = vscode.workspace.workspaceFolders;
    if (!context.storageUri || !folders?.length) {
      await vscode.window.showInformationMessage('Open a repository folder or workspace to use Code Kanban.');
      return;
    }
    if (folders.length === 1) return folders[0];
    return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose the repository for this board' });
  }
  function attach(panel, folder, sidebar = false) {
    const key = folder.uri.toString();
    const directory = vscode.Uri.joinPath(context.storageUri, 'repositories', repositoryKey(key));
    const store = new StoryStore(directory.fsPath);
    const disposables = [];
    let disposed = false;
    let refreshTimer;
    panel.title = `Kanban · ${folder.name}`;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')] };
    const send = message => !disposed && panel.webview.postMessage(message);
    const snapshot = async () => send({ type: 'snapshot', ...(await store.snapshot()), repository: folder.name, repositoryUri: key });
    let queue = Promise.resolve();
    const schedule = task => {
      queue = queue.then(task).catch(error => {
        send({ type: 'error', message: error.message });
      });
    };
    disposables.push(panel.webview.onDidReceiveMessage(message => {
      if (!message || typeof message.type !== 'string') return;
      schedule(async () => {
        let result;
        try {
          switch (message.type) {
            case 'ready': await snapshot(); return;
            case 'create': result = await store.create(message.data); break;
            case 'update': await store.update(message.number, message.data, message.revision); break;
            case 'move': await store.move(message.number, message.status, message.beforeNumber, message.epic); break;
            case 'refresh': break;
            case 'flag': await store.flag(message.number, message.field, message.value); break;
            case 'settings': await store.settings(message.data); break;
            case 'openFile': {
              const uri = vscode.Uri.file(store.file(message.number));
              await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { viewColumn: vscode.ViewColumn.Beside });
              break;
            }
            case 'startAI': {
              if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting an AI agent.');
              const story = (await store.snapshot()).stories.find(item => item.number === message.number);
              if (!story) throw new Error('Story not found.');
              const agent = await vscode.window.showQuickPick(['claude', 'codex', 'copilot', 'opencode', 'Copy prompt'], { placeHolder: 'Build with an installed AI CLI' });
              if (!agent) break;
              const prompt = `Implement story #${story.number} (${story.priority} priority) in ${folder.name}.\n\n${story.content}\n\nStory file: ${store.file(story.number)}`;
              if (agent === 'Copy prompt') await vscode.env.clipboard.writeText(prompt);
              else vscode.window.createTerminal({ name: `Story #${story.number} · ${agent}`, cwd: folder.uri.fsPath, shellPath: agent, shellArgs: [prompt] }).show();
              break;
            }
            default: throw new Error('Unknown board action.');
          }
          const state = await store.snapshot();
          await send({ type: 'result', requestId: message.requestId, result, ...state });
        } catch (error) {
          await send({ type: 'result', requestId: message.requestId, error: error.message });
        }
      });
    }));
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*'));
    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => schedule(snapshot), 150);
    };
    disposables.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
    disposables.push(vscode.workspace.onDidSaveTextDocument(document => {
      if (document.uri.toString().startsWith(`${directory.toString()}/`)) refresh();
    }));
    panel.onDidDispose(() => {
      disposed = true;
      clearTimeout(refreshTimer);
      disposables.forEach(disposable => disposable.dispose());
      if (!sidebar && panels.get(key) === panel) panels.delete(key);
    });
    if (!sidebar) panels.set(key, panel);
    const nonce = randomBytes(16).toString('hex');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'board.js'));
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'board.css'));
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Code Kanban</title></head><body><main id="app" aria-label="Kanban board"><p>Loading board…</p></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
    return panel;
  }
  async function open(addStory = false) {
    const folder = await folderForBoard();
    if (!folder) return;
    const key = folder.uri.toString();
    let panel = panels.get(key);
    if (!panel) {
      await fs.mkdir(context.storageUri.fsPath, { recursive: true });
      panel = attach(vscode.window.createWebviewPanel('code-kanban.board', 'Kanban', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }), folder);
      // The UI reads this state only after its initial snapshot arrives.
      if (addStory) {
        const ready = panel.webview.onDidReceiveMessage(message => {
          if (message.type === 'ready') { panel.webview.postMessage({ type: 'newStory' }); ready.dispose(); }
        });
        context.subscriptions.push(ready);
      }
    } else {
      panel.reveal();
      if (addStory) panel.webview.postMessage({ type: 'newStory' });
    }
  }
  const report = action => action().catch(error => vscode.window.showErrorMessage(`Code Kanban: ${error.message}`));
  context.subscriptions.push(
    vscode.commands.registerCommand('code-kanban.open', () => report(() => open())),
    vscode.commands.registerCommand('code-kanban.addStory', () => report(() => open(true))),
    vscode.window.registerWebviewViewProvider('code-kanban.boardView', {
      async resolveWebviewView(view) {
        const folder = await folderForBoard();
        if (!folder) {
          view.webview.html = '<!doctype html><html><body><p>Open a repository folder to use Code Kanban.</p></body></html>';
          return;
        }
        attach(view, folder, true);
      }
    }, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewPanelSerializer('code-kanban.board', {
      async deserializeWebviewPanel(panel, state) {
        const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === state?.repositoryUri);
        if (!context.storageUri || !folder) { panel.dispose(); return; }
        attach(panel, folder);
      }
    }),
    { dispose: () => { for (const panel of panels.values()) panel.dispose(); } }
  );
}
module.exports = { activate };
