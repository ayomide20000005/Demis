import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

const execAsync = promisify(exec);

// ── Swap this URL once Railway is live ────────────────────────
const SERVER_URL = 'https://demis-server-production.up.railway.app/ask';
// ─────────────────────────────────────────────────────────────

let terminal: vscode.Terminal | null = null;
let isInstalling = false;



// ── Groq via Railway ─────────────────────────────────────────
async function askGroq(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ prompt });
        const url = new URL(SERVER_URL);
        const req = https.request({
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (!data || data.trim() === '') {
                    reject(new Error('Server returned empty response. Status: ' + res.statusCode));
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) { reject(new Error('Server error: ' + parsed.error.message)); return; }
                    resolve((parsed as { result: string }).result || '');
                } catch(e) { reject(new Error('Parse failed. Raw: ' + data.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
// ─────────────────────────────────────────────────────────────

// ── Audit VS Code extensions ──────────────────────────────────
async function auditExtensions(): Promise<string[]> {
    try {
        const { stdout } = await execAsync('code --list-extensions');
        return stdout.split('\n').map(e => e.trim().toLowerCase()).filter(Boolean);
    } catch(e) { return []; }
}
// ─────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    let toolCommands = new Map<string, string>();
    let currentRole = '';

    let disposable = vscode.commands.registerCommand('demis.start', async () => {

        const panel = vscode.window.createWebviewPanel(
            'demisDashboard', 'Demis', vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        const os = process.platform;
        panel.webview.html = getChatHtml(os);

        panel.webview.onDidReceiveMessage(async (message) => {
            try {

                if (message.command === 'processRole') {
                    currentRole = message.role;
                    const installed = await auditSystem();
                    const prompt = `You are a Senior Lead Engineer. User Role: "${message.role}". OS: ${os}. 
                    EXTREMELY IMPORTANT: The user ALREADY HAS these packages installed: [${installed.join(', ')}].
                    TASK: Suggest 5 NEW and MISSING industry-standard tools for this career path. 
                    - DO NOT suggest anything that is already in the "Already Installed" list above.
                    - If the role is nonsense, return ONLY: {"error": "invalid"}.
                    - Return ONLY a JSON array: [{"id":"system_package_id","name":"Tool Name","cmd":"install_command"}]
                    - Use exact ${os === 'win32' ? 'Winget' : 'Brew'} IDs.
                    - Add flags: ${os === 'win32' ? '--latest --accept-package-agreements --accept-source-agreements' : ''}`;

                    const text = await askGroq(prompt);

                    if (text.includes('"error"')) {
                        panel.webview.postMessage({ command: 'chatError', msg: "I didn't recognize that role. Try 'DevOps' or 'Data Scientist'." });
                        return;
                    }

                    const tools = JSON.parse(text.substring(text.indexOf('['), text.lastIndexOf(']') + 1));
                    tools.forEach((t: any) => toolCommands.set(t.id, t.cmd));
                    panel.webview.postMessage({ command: 'renderTools', tools });

                } else if (message.command === 'requestManualAudit') {
                    const installed = await auditSystem();
                    const statusMsg = installed.length > 0
                        ? `Audit Complete. Detected <b>${installed.length}</b> packages via ${os === 'win32' ? 'Winget' : 'Homebrew'}. AI will now ignore these.`
                        : "Audit Complete. No packages found.";
                    panel.webview.postMessage({ command: 'systemAuditResult', msg: statusMsg });

                } else if (message.command === 'scanExtensions') {
                    if (!currentRole) {
                        panel.webview.postMessage({ command: 'chatError', msg: 'Please enter your role first before scanning extensions.' });
                        return;
                    }
                    const installedExts = await auditExtensions();
                    const prompt = `You are a Senior VS Code Expert. User Role: "${currentRole}".
                    ALREADY INSTALLED EXTENSIONS: [${installedExts.join(', ')}].
                    Return ONLY a JSON array of 5 VS Code extension IDs for this role.
                    Example: ["esbenp.prettier-vscode","dbaeumer.vscode-eslint","ms-python.python"]
                    - Use exact VS Code marketplace extension IDs only.
                    - DO NOT include anything already installed.
                    - Return ONLY the JSON array, no explanation.`;

                    const text = await askGroq(prompt);
                    const extIds: string[] = JSON.parse(text.substring(text.indexOf('['), text.lastIndexOf(']') + 1));

                    const extensions = extIds.map(id => ({
                        id,
                        name: id.split('.')[1] || id,
                        alreadyInstalled: installedExts.includes(id.toLowerCase()),
                        cmd: `code --install-extension ${id}`
                    }));

                    extensions.forEach(e => { if (!e.alreadyInstalled) { toolCommands.set(e.id, e.cmd); } });
                    panel.webview.postMessage({ command: 'renderExtensions', extensions });

                } else if (message.command === 'importDevtools') {
                    const uris = await vscode.window.showOpenDialog({
                        canSelectFiles: true, canSelectMany: false,
                        filters: { 'Demis Config': ['json'] },
                        title: 'Select your devtools.json'
                    });
                    if (!uris || !uris.length) { return; }

                    const raw = fs.readFileSync(uris[0].fsPath, 'utf8');
                    const devtools = JSON.parse(raw);

                    if (!devtools.generatedBy || devtools.generatedBy !== 'demis-vscode-extension') {
                        panel.webview.postMessage({ command: 'chatError', msg: 'This file was not generated by Demis. Please use a valid devtools.json.' });
                        return;
                    }

                    const installed = await auditSystem();
                    const installedLower = installed.map(i => i.toLowerCase());
                    const installedExts = await auditExtensions();

                    const tools = devtools.tools || [];
                    const enriched = tools.map((t: any) => ({
                        ...t,
                        alreadyInstalled: installedLower.some(i => i.includes(t.id.toLowerCase()) || i.includes(t.name.toLowerCase()))
                    }));
                    enriched.forEach((t: any) => {
                        if (!t.alreadyInstalled && t.cmd) { toolCommands.set(t.id, t.cmd); }
                    });

                    const extensions = (devtools.extensions || []).map((e: any) => ({
                        ...e,
                        alreadyInstalled: installedExts.includes(e.id.toLowerCase()),
                        cmd: `code --install-extension ${e.id}`
                    }));
                    extensions.forEach((e: any) => {
                        if (!e.alreadyInstalled) { toolCommands.set(e.id, e.cmd); }
                    });

                    panel.webview.postMessage({ command: 'renderImportedTools', tools: enriched });
                    if (extensions.length > 0) {
                        panel.webview.postMessage({ command: 'renderExtensions', extensions });
                    }

                } else if (message.command === 'saveDevtools') {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    const savePath = workspaceFolders
                        ? path.join(workspaceFolders[0].uri.fsPath, 'devtools.json')
                        : undefined;

                    const uri = await vscode.window.showSaveDialog({
                        defaultUri: savePath ? vscode.Uri.file(savePath) : undefined,
                        filters: { 'Demis Config': ['json'] },
                        title: 'Save devtools.json'
                    });
                    if (!uri) { return; }

                    const payload = {
                        demis: "1.0",
                        generatedBy: "demis-vscode-extension",
                        marketplace: "https://marketplace.visualstudio.com/items?itemName=yourname.demis",
                        os,
                        savedAt: new Date().toISOString(),
                        tools: message.tools,
                        extensions: message.extensions || []
                    };

                    fs.writeFileSync(uri.fsPath, JSON.stringify(payload, null, 2), 'utf8');
                    panel.webview.postMessage({ command: 'devtoolsSaved', filePath: uri.fsPath });

                } else if (message.command === 'searchSystem') {
                    try {
                        const searchCmd = os === 'win32'
                            ? `winget search "${message.query}" --source winget --limit 5`
                            : `brew search "${message.query}"`;
                        const { stdout } = await execAsync(searchCmd);

                        let results: { id: string; name: string }[] = [];

                        if (os === 'win32') {
                            const lines = stdout.split('\n').slice(2).filter(l => l.trim());
                            lines.forEach(line => {
                                const parts = line.trim().split(/\s{2,}/);
                                if (parts[1] && parts[0]) {
                                    results.push({ name: parts[0].trim(), id: parts[1].trim() });
                                }
                            });
                        } else {
                            stdout.split('\n').forEach(line => {
                                const name = line.trim();
                                if (name && !name.startsWith('==>')) {
                                    results.push({ name, id: name });
                                }
                            });
                        }

                        results = results.slice(0, 5);

                        if (results.length === 0) {
                            panel.webview.postMessage({ command: 'searchResult', results: [], notFound: true });
                        } else {
                            panel.webview.postMessage({ command: 'searchResult', results });
                        }
                    } catch (err) {
                        const prompt = `Find the most official ${os === 'win32' ? 'Winget' : 'Brew'} Package ID for: "${message.query}". Return ONLY JSON: [{"id":"exact_id","name":"Official Name"}]`;
                        const text = await askGroq(prompt);
                        const results = JSON.parse(text.substring(text.indexOf('['), text.lastIndexOf(']') + 1));
                        panel.webview.postMessage({ command: 'searchResult', results });
                    }

                } else if (message.command === 'addVerifiedTool') {
                    let cmd = '';
                    if (os === 'win32') {
                        cmd = `winget install --id ${message.toolId} --latest --accept-package-agreements --accept-source-agreements`;
                    } else if (os === 'darwin') {
                        cmd = `brew install ${message.toolId}`;
                    } else {
                        cmd = `sudo apt-get install -y ${message.toolId}`;
                    }
                    const tool = { id: message.toolId, name: message.toolName, cmd };
                    toolCommands.set(tool.id, tool.cmd);
                    panel.webview.postMessage({ command: 'appendTool', tool });

                } else if (message.command === 'installSelected') {
                    isInstalling = true;
                    const ids: string[] = message.ids;

                    const cmds = ids.map(id => toolCommands.get(id)).filter(Boolean) as string[];
                    if (cmds.length === 0) {
                        panel.webview.postMessage({ command: 'installCancelled' });
                        return;
                    }

                    // Open/reuse terminal for visibility
                    const existingTerminals = vscode.window.terminals;
                    if (terminal && existingTerminals.includes(terminal)) {
                        terminal.show(true);
                    } else {
                        terminal = vscode.window.createTerminal('Demis Installer');
                        terminal.show(true);
                    }

                    await new Promise(r => setTimeout(r, 500));
                    panel.webview.postMessage({ command: 'installStarted' });

                    // Run each tool one by one with execAsync (gives success/fail)
                    // and also send to terminal so user can see it
                    for (let i = 0; i < ids.length; i++) {
                        if (!isInstalling) {
                            panel.webview.postMessage({ command: 'installCancelled' });
                            break;
                        }
                        const id = ids[i];
                        const cmd = toolCommands.get(id);
                        if (!cmd) { continue; }

                        panel.webview.postMessage({ command: 'installStep', id, current: i + 1, total: ids.length });
                        terminal.sendText(cmd);

                        try {
                            await execAsync(cmd, { timeout: 180000 });
                            panel.webview.postMessage({ command: 'updateStatus', id, status: 'success' });
                        } catch (err: any) {
                            panel.webview.postMessage({ command: 'updateStatus', id, status: 'error' });
                        }
                    }

                    if (isInstalling) {
                        isInstalling = false;
                        panel.webview.postMessage({ command: 'sweepComplete' });
                    }

                } else if (message.command === 'killInstallation') {
                    isInstalling = false;
                    if (terminal) {
                        terminal.show(true);
                        terminal.sendText('\x03');
                        panel.webview.postMessage({ command: 'installKilled' });
                    }
                }

            } catch (err: any) {
                vscode.window.showErrorMessage("Demis Error: " + err.message);
                panel.webview.postMessage({ command: 'chatError', msg: 'Error: ' + err.message });
            }
        });
    });

    context.subscriptions.push(disposable);
}

async function auditSystem(): Promise<string[]> {
    const os = process.platform;
    const found: string[] = [];
    try {
        if (os === 'win32') {
            const { stdout } = await execAsync('winget list --source winget');
            const lines = stdout.split('\n').slice(2);
            lines.forEach(line => {
                const parts = line.trim().split(/\s{2,}/);
                if (parts[1]) { found.push(parts[1].trim()); }
            });
        } else {
            const { stdout } = await execAsync('brew list --versions');
            stdout.split('\n').forEach(line => {
                const name = line.split(' ')[0];
                if (name) { found.push(name.trim()); }
            });
        }
    } catch (e) {}
    return found;
}

function getChatHtml(os: string) {
    return `<!DOCTYPE html><html><head><style>
        :root { --bg: var(--vscode-editor-background); --text: var(--vscode-editor-foreground); --accent: var(--vscode-button-background); --border: var(--vscode-widget-border); }
        body { background: var(--bg); color: var(--text); font-family: sans-serif; margin: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
        #history { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 12px; }
        .msg { padding: 12px; border-radius: 8px; max-width: 85%; border: 1px solid var(--border); font-size: 13px; line-height: 1.4; }
        .demis { background: var(--vscode-sideBar-background); align-self: flex-start; }
        .user { background: var(--accent); color: white; align-self: flex-end; }
        .card { background: rgba(255,255,255,0.04); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-top: 10px; }
        .tool-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .dot { height: 10px; width: 10px; border-radius: 50%; background: #444; flex-shrink: 0; margin-left: 10px; }
        .dot.installed { background: #2ecc71; }
        .dot.missing { background: #3498db; }
        .dot.installing { background: #3498db; box-shadow: 0 0 10px #3498db; }
        .dot.success { background: #2ecc71; }
        .dot.error { background: #e74c3c; }
        .status-label { font-size: 10px; margin-left: 6px; opacity: 0.7; }
        .footer { padding: 12px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
        .top-btns { display: flex; gap: 8px; flex-wrap: wrap; }
        .input-row { display: flex; gap: 8px; }
        input[type=text] { flex: 1; padding: 10px; background: var(--vscode-input-background); color: white; border: 1px solid var(--border); border-radius: 4px; outline: none; }
        .sm-btn { background: transparent; color: var(--accent); border: 1px solid var(--accent); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
        .sm-btn:hover { background: var(--accent); color: white; }
        .main-btn { width: 100%; margin-top: 15px; background: var(--accent); color: white; border: none; padding: 12px; border-radius: 4px; cursor: pointer; font-weight: bold; }
        .kill-btn { width: 100%; margin-top: 8px; background: #e74c3c; color: white; border: none; padding: 10px; border-radius: 4px; cursor: pointer; font-weight: bold; display: none; }
        .kill-btn.active { display: block; }
        .kill-btn:hover { background: #c0392b; }
        .save-btn { width: 100%; margin-top: 8px; background: transparent; color: #2ecc71; border: 1px solid #2ecc71; padding: 10px; border-radius: 4px; cursor: pointer; font-weight: bold; }
        .save-btn:hover { background: #2ecc71; color: #000; }
        .search-area { display: none; margin-top: 10px; flex-direction: column; gap: 5px; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 4px; }
        .plus-btn { color: #3498db; cursor: pointer; font-size: 12px; font-weight: bold; margin-top: 8px; display: inline-block; }
        .result-item { padding: 8px; cursor: pointer; font-size: 12px; border-bottom: 1px solid #333; }
        .skip-note { color: #e74c3c; font-size: 10px; margin-left: 5px; }
        .summary { font-size: 11px; opacity: 0.7; margin-bottom: 8px; }
    </style></head><body>
        <div id="history"><div class="msg demis"><b>Demis</b><br>Welcome. Enter your role, audit your system, or import a devtools.json to get started.</div></div>
        <div class="footer">
            <div class="top-btns">
                <button class="sm-btn" onclick="runAudit()">🔍 Audit System</button>
                <button class="sm-btn" onclick="importJson()">📂 Import devtools.json</button>
                <button class="sm-btn" onclick="scanExtensions()">🧩 Extensions</button>
            </div>
            <div class="input-row">
                <input type="text" id="in" placeholder="Type your role..." autocomplete="off">
                <button onclick="send()" style="background:var(--accent);color:white;border:none;padding:8px 15px;border-radius:4px;cursor:pointer">Send</button>
            </div>
        </div>
        <script>
            const vscode = acquireVsCodeApi();
            let lastList = null;
            let currentTools = [];
            let currentExtensions = [];
            let killBtn = null;
            let currentInstallBtn = null;
            const hist = document.getElementById('history');

            function send() {
                const val = document.getElementById('in').value.trim();
                if(!val) return;
                hist.innerHTML += '<div class="user msg">'+val+'</div>';
                document.getElementById('in').value = '';

                const thinkId = 'think-'+Date.now();
                const steps = [
                    '🧠 Analyzing your role...',
                    '🔍 Running system audit to detect what you already have...',
                    '⚙️ Matching industry-standard tools for your career path...',
                    '🚫 Filtering out already installed packages...',
                    '📦 Preparing your personalized tool list...'
                ];
                let si = 0;
                const thinkEl = document.createElement('div');
                thinkEl.className = 'msg demis'; thinkEl.id = thinkId;
                thinkEl.innerHTML = '<i>'+steps[0]+'</i>';
                hist.appendChild(thinkEl);
                hist.scrollTop = hist.scrollHeight;

                const iv = setInterval(() => {
                    si++;
                    if(si < steps.length) {
                        thinkEl.innerHTML = '<i>'+steps[si]+'</i>';
                        hist.scrollTop = hist.scrollHeight;
                    } else { clearInterval(iv); }
                }, 1200);

                window._thinkInterval = iv;
                window._thinkId = thinkId;
                vscode.postMessage({ command: 'processRole', role: val });
                hist.scrollTop = hist.scrollHeight;
            }

            function runAudit() {
                const thinkId = 'audit-'+Date.now();
                const steps = [
                    '🔍 Initializing system scan...',
                    '📋 Reading installed packages list...',
                    '🧩 Identifying package IDs and versions...',
                    '✅ Finalizing audit results...'
                ];
                let si = 0;
                const thinkEl = document.createElement('div');
                thinkEl.className = 'msg demis'; thinkEl.id = thinkId;
                thinkEl.innerHTML = '<i>'+steps[0]+'</i>';
                hist.appendChild(thinkEl);
                hist.scrollTop = hist.scrollHeight;

                const iv = setInterval(() => {
                    si++;
                    if(si < steps.length) {
                        thinkEl.innerHTML = '<i>'+steps[si]+'</i>';
                        hist.scrollTop = hist.scrollHeight;
                    } else { clearInterval(iv); }
                }, 900);

                window._auditInterval = iv;
                window._auditThinkId = thinkId;
                vscode.postMessage({ command: 'requestManualAudit' });
                hist.scrollTop = hist.scrollHeight;
            }

            function importJson() {
                hist.innerHTML += '<div class="msg demis"><i>Opening file picker...</i></div>';
                vscode.postMessage({ command: 'importDevtools' });
                hist.scrollTop = hist.scrollHeight;
            }

            function scanExtensions() {
                hist.innerHTML += '<div class="msg demis"><i>🧩 Scanning and suggesting VS Code extensions for your role...</i></div>';
                vscode.postMessage({ command: 'scanExtensions' });
                hist.scrollTop = hist.scrollHeight;
            }

            function saveJson() {
                vscode.postMessage({ command: 'saveDevtools', tools: currentTools, extensions: currentExtensions });
            }

            function killInstallation() {
                vscode.postMessage({ command: 'killInstallation' });
            }

            function renderToolCard(tools, title, showSaveBtn) {
                currentTools = tools;
                const alreadyCount = tools.filter(t => t.alreadyInstalled).length;
                const missingCount = tools.length - alreadyCount;

                const b = document.createElement('div'); b.className = 'msg demis';
                b.innerHTML = '<b>'+title+'</b><div class="summary">'+tools.length+' tools found &nbsp;·&nbsp; <span style="color:#2ecc71">'+alreadyCount+' already installed</span> &nbsp;·&nbsp; <span style="color:#3498db">'+missingCount+' ready to install</span></div>';

                lastList = document.createElement('div'); lastList.className = 'card';
                tools.forEach(t => {
                    const dotClass = t.alreadyInstalled ? 'installed' : 'missing';
                    const label = t.alreadyInstalled ? '<span class="status-label" style="color:#2ecc71">Already Installed</span>' : '';
                    const checkDisabled = t.alreadyInstalled ? 'disabled' : '';
                    lastList.innerHTML += '<div class="tool-row" id="row-'+t.id+'"><span><input type="checkbox" value="'+t.id+'" '+(t.alreadyInstalled ? '' : 'checked')+' '+checkDisabled+'> '+(t.name || t.id)+label+'</span><div id="dot-'+t.id+'" class="dot '+dotClass+'"></div></div>';
                });

                const sArea = document.createElement('div'); sArea.className = 'search-area'; sArea.id = 'sArea';
                sArea.innerHTML = '<input type="text" id="sq" placeholder="Verify & Add Tool..."><div id="res"></div>';
                const plus = document.createElement('span'); plus.className = 'plus-btn'; plus.innerText = '+ Add Specific Tool';
                plus.onclick = () => { sArea.style.display = 'flex'; document.getElementById('sq').focus(); };
                const btn = document.createElement('button'); btn.className = 'main-btn'; btn.innerText = 'Run Sweep Install';
                btn.onclick = () => {
                    const ids = Array.from(document.querySelectorAll('input[type=checkbox]:checked:not(:disabled)')).map(i => i.value);
                    const names = {};
                    ids.forEach(id => {
                        const row = document.getElementById('row-'+id);
                        const span = row ? row.querySelector('span') : null;
                        const text = span ? Array.from(span.childNodes).find(n => n.nodeType === 3)?.textContent?.trim() : id;
                        names[id] = text || id;
                    });
                    btn.innerText = 'Sweeping...'; btn.disabled = true;
                    killBtn.classList.add('active');
                    currentInstallBtn = btn;
                    vscode.postMessage({ command: 'installSelected', ids, names });
                };

                killBtn = document.createElement('button'); killBtn.className = 'kill-btn'; killBtn.innerText = '🛑 Kill Installation';
                killBtn.onclick = killInstallation;

                b.appendChild(lastList); b.appendChild(plus); b.appendChild(sArea); b.appendChild(btn); b.appendChild(killBtn);

                if(showSaveBtn) {
                    const saveBtn = document.createElement('button'); saveBtn.className = 'save-btn'; saveBtn.innerText = '💾 Save devtools.json';
                    saveBtn.onclick = saveJson;
                    b.appendChild(saveBtn);
                }

                hist.appendChild(b);
                // Attach search listener after appending to DOM
                const sqEl = document.getElementById('sq');
                if (sqEl) {
                    sqEl.onkeydown = ev => {
                        if(ev.key === 'Enter') {
                            document.getElementById('res').innerHTML = '<small>Searching...</small>';
                            vscode.postMessage({ command: 'searchSystem', query: ev.target.value });
                        }
                    };
                }
                hist.scrollTop = hist.scrollHeight;
            }

            window.addEventListener('message', e => {
                const m = e.data;

                if(m.command === 'renderExtensions') {
                    currentExtensions = m.extensions;
                    const alreadyCount = m.extensions.filter(e => e.alreadyInstalled).length;
                    const missingCount = m.extensions.length - alreadyCount;
                    const b = document.createElement('div'); b.className = 'msg demis';
                    b.innerHTML = '<b>🧩 VS Code Extensions</b><div class="summary">'+m.extensions.length+' found &nbsp;·&nbsp; <span style="color:#2ecc71">'+alreadyCount+' installed</span> &nbsp;·&nbsp; <span style="color:#9b59b6">'+missingCount+' ready to install</span></div>';
                    const card = document.createElement('div'); card.className = 'card';
                    m.extensions.forEach(e => {
                        const dotColor = e.alreadyInstalled ? '#2ecc71' : '#9b59b6';
                        const label = e.alreadyInstalled ? '<span class="status-label" style="color:#2ecc71">Installed</span>' : '<span class="status-label" style="color:#9b59b6">Not Installed</span>';
                        card.innerHTML += '<div class="tool-row" id="row-'+e.id+'"><span><input type="checkbox" value="'+e.id+'" '+(e.alreadyInstalled?'':'checked')+' '+(e.alreadyInstalled?'disabled':'')+'>  '+e.name+label+'</span><div id="dot-'+e.id+'" class="dot" style="background:'+dotColor+'"></div></div>';
                    });
                    const installBtn = document.createElement('button'); installBtn.className = 'main-btn'; installBtn.innerText = 'Install Selected Extensions';
                    installBtn.onclick = () => {
                        const ids = Array.from(card.querySelectorAll('input:checked:not(:disabled)')).map(i => i.value);
                        const names = {}; ids.forEach(id => { names[id] = id; });
                        installBtn.innerText = 'Installing...'; installBtn.disabled = true;
                        vscode.postMessage({ command: 'installSelected', ids, names });
                    };
                    b.appendChild(card); b.appendChild(installBtn);
                    hist.appendChild(b);
                    hist.scrollTop = hist.scrollHeight;
                }
                if(m.command === 'systemAuditResult') {
                    clearInterval(window._auditInterval);
                    const el = document.getElementById(window._auditThinkId);
                    if(el) el.remove();
                    hist.innerHTML += '<div class="msg demis"><b>Audit Results:</b><br>' + m.msg + '</div>';
                    hist.scrollTop = hist.scrollHeight;
                }
                if(m.command === 'chatError') {
                    clearInterval(window._thinkInterval);
                    const el = document.getElementById(window._thinkId);
                    if(el) el.remove();
                    hist.innerHTML += '<div class="msg demis" style="border-color:#e74c3c"><b>System:</b> '+m.msg+'</div>';
                    hist.scrollTop = hist.scrollHeight;
                }
                if(m.command === 'renderTools') {
                    clearInterval(window._thinkInterval);
                    const el = document.getElementById(window._thinkId);
                    if(el) el.remove();
                    const tools = m.tools.map(t => ({ ...t, alreadyInstalled: false }));
                    renderToolCard(tools, 'One-Sweep Setup:', true);
                }
                if(m.command === 'renderImportedTools') {
                    renderToolCard(m.tools, 'Imported Stack from devtools.json:', false);
                }
                if(m.command === 'searchResult') {
                    const rDiv = document.getElementById('res');
                    if(m.notFound || !m.results.length) {
                        rDiv.innerHTML = '<small style="color:#e74c3c">❌ No official package found. Try a different name.</small>';
                        return;
                    }
                    rDiv.innerHTML = '<small style="opacity:0.6">✅ Found '+m.results.length+' result(s) — click to add:</small><br>';
                    m.results.forEach(r => {
                        const item = document.createElement('div'); item.className = 'result-item';
                        item.innerHTML = '<b>'+r.name+'</b> <span style="opacity:0.5;font-size:10px">'+r.id+'</span>';
                        item.onclick = () => {
                            rDiv.innerHTML = '<small>➕ Adding '+r.name+'...</small>';
                            vscode.postMessage({ command: 'addVerifiedTool', toolId: r.id, toolName: r.name });
                        };
                        rDiv.appendChild(item);
                    });
                }
                if(m.command === 'appendTool') {
                    const d = document.createElement('div'); d.className = 'tool-row'; d.id = 'row-'+m.tool.id;
                    d.innerHTML = '<span><input type="checkbox" value="'+m.tool.id+'" checked> '+m.tool.name+'</span><div id="dot-'+m.tool.id+'" class="dot missing"></div>';
                    lastList.appendChild(d);
                    currentTools.push(m.tool);
                    document.getElementById('sArea').style.display = 'none';
                    hist.scrollTop = hist.scrollHeight;
                }
                if(m.command === 'installStarted') {
                    hist.innerHTML += '<div class="msg demis"><i>📺 Terminal launching... Tools will install in sequence.</i></div>';
                    hist.scrollTop = hist.scrollHeight;
                }
                if(m.command === 'installStep') {
                    const dot = document.getElementById('dot-'+m.id);
                    if(dot) dot.className = 'dot installing';
                    const lbl = document.getElementById('lbl-'+m.id);
                    if(lbl) lbl.innerHTML = '<span class="status-label" style="color:#3498db">Installing...</span>';
                    hist.scrollTop = hist.scrollHeight;
                }
                if(m.command === 'updateStatus') {
                    const dot = document.getElementById('dot-'+m.id);
                    if(dot) dot.className = 'dot ' + m.status;
                    const lbl = document.getElementById('lbl-'+m.id);
                    if(lbl) {
                        if(m.status === 'success') lbl.innerHTML = '<span class="status-label" style="color:#2ecc71">✅ Installed</span>';
                        if(m.status === 'error') lbl.innerHTML = '<span class="status-label" style="color:#e74c3c">❌ Failed</span>';
                    }
                }
                if(m.command === 'logSkip') {
                    const row = document.getElementById('row-'+m.id);
                    if(row) {
                        const existing = row.querySelector('.skip-note');
                        if(!existing) row.innerHTML += '<span class="skip-note" title="'+m.reason+'">⚠ Skipped</span>';
                    }
                }
                if(m.command === 'installCancelled') {
                    hist.innerHTML += '<div class="msg demis" style="border-color:#e74c3c"><b>⛔ Installation Cancelled</b><br>Sweep halted by user.</div>';
                    if(killBtn) killBtn.classList.remove('active');
                    if(currentInstallBtn) { currentInstallBtn.innerText = 'Run Sweep Install'; currentInstallBtn.disabled = false; currentInstallBtn = null; }
                    hist.scrollTop = hist.scrollHeight;
                }
                if(m.command === 'installKilled') {
                    hist.innerHTML += '<div class="msg demis"><i>🔌 Kill signal sent to terminal.</i></div>';
                    if(killBtn) killBtn.classList.remove('active');
                    if(currentInstallBtn) { currentInstallBtn.innerText = 'Run Sweep Install'; currentInstallBtn.disabled = false; currentInstallBtn = null; }
                    hist.scrollTop = hist.scrollHeight;
                }
                if(m.command === 'sweepComplete') {
                    hist.innerHTML += '<div class="msg demis"><b>Sweep Complete!</b> Your system is now tuned.<br><br><small style="opacity:0.6">Tip: Save your devtools.json and push it to GitHub so your team can replicate this setup instantly.</small></div>';
                    if(killBtn) killBtn.classList.remove('active');
                    if(currentInstallBtn) { currentInstallBtn.innerText = 'Run Sweep Install'; currentInstallBtn.disabled = false; currentInstallBtn = null; }
                    hist.scrollTop = hist.scrollHeight;
                }
                if(m.command === 'devtoolsSaved') {
                    hist.innerHTML += '<div class="msg demis"><b>✅ Saved!</b><br><small>'+m.filePath+'</small><br><small style="opacity:0.6;margin-top:4px;display:block">Commit this file to GitHub so teammates can import it with Demis.</small></div>';
                    hist.scrollTop = hist.scrollHeight;
                }
            });
            document.getElementById('in').onkeydown = e => { if(e.key==='Enter') { send(); } };
        </script></body></html>`;
}

export function deactivate() {}