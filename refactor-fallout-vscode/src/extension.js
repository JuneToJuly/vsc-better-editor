"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
let panel;
let snapshot = { total: 0, families: [] };
let session;
let refreshTimer;
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('refactorFallout.open', () => open(context)), vscode.commands.registerCommand('refactorFallout.refresh', () => refresh()), vscode.languages.onDidChangeDiagnostics(() => {
        if (!panel || !vscode.workspace.getConfiguration('refactorFallout').get('autoRefresh', true))
            return;
        if (refreshTimer)
            clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => refresh(true), 180);
    }));
}
function normalize(message) {
    const s = message.replace(/\s+/g, ' ').trim();
    let m = s.match(/The method ([^(]+)\(([^)]*)\) in the type ([^ ]+) is not applicable for the arguments \(([^)]*)\)/i);
    if (m)
        return { key: `method:${m[1]}:${m[2]}`, title: `${m[1]}(${m[2]})`, subtitle: `Method signature mismatch`, category: 'Method signature mismatch', description: `Calls to ${m[1]} no longer match the declared parameter list. The method expects (${m[2]}), but one or more callers are passing different arguments.` };
    m = s.match(/method ([\w$]+).*cannot be applied to given types; required: ([^;]+); found: ([^;]+);/i);
    if (m)
        return { key: `method:${m[1]}:${m[2]}`, title: `${m[1]}(${m[2]})`, subtitle: 'Method signature mismatch', category: 'Method signature mismatch', description: `Calls to ${m[1]} no longer match its declaration. Review the arguments at each call site or update the method signature if the declaration is the part that changed.` };
    m = s.match(/constructor ([\w$]+).*cannot be applied to given types/i);
    if (m)
        return { key: `ctor:${m[1]}`, title: `${m[1]} constructor`, subtitle: 'Constructor mismatch', category: 'Constructor mismatch', description: `Calls creating ${m[1]} do not match an available constructor. A constructor parameter may have been added, removed, reordered, or changed.` };
    m = s.match(/cannot find symbol.*(?:method|variable|class)\s+([\w$]+)/i) || s.match(/([\w$]+) cannot be resolved to a (?:method|variable|type)/i);
    if (m)
        return { key: `missing:${m[1]}`, title: `${m[1]} cannot be resolved`, subtitle: 'Unresolved symbol', category: 'Unresolved symbol', description: `Java cannot resolve ${m[1]} at these locations. It may have been renamed, removed, moved, or may require an import.` };
    if (/Syntax error, insert ['\"]?;['\"]? to complete Statement/i.test(s))
        return { key: 'syntax:semicolon', title: 'Missing semicolon', subtitle: 'Java syntax error', category: 'Java syntax', description: 'A Java statement is missing its terminating semicolon. Add ";" at each reported statement and let the language server recheck the file.' };
    if (/Syntax error/i.test(s))
        return { key: `syntax:${s.replace(/\d+/g, '#')}`, title: s.slice(0, 70), subtitle: 'Java syntax error', category: 'Java syntax', description: 'The Java parser cannot complete this construct. Correct the reported syntax first; related diagnostics often disappear automatically afterward.' };
    m = s.match(/incompatible types: ([^ ]+) cannot be converted to ([^ ]+)/i);
    if (m)
        return { key: `type:${m[1]}:${m[2]}`, title: `${m[1]} → ${m[2]}`, subtitle: 'Type mismatch', category: 'Type mismatch', description: `A value of type ${m[1]} is being used where ${m[2]} is required. Change the value, conversion, or receiving declaration.` };
    const generic = s.replace(/['"`][^'"`]+['"`]/g, '<symbol>').replace(/\b\d+\b/g, '#').slice(0, 160);
    return { key: `generic:${generic}`, title: s.slice(0, 70), subtitle: 'Related diagnostics', category: 'Compiler diagnostic', description: 'These diagnostics have the same normalized compiler message and are grouped so they can be repaired as one work queue.' };
}
function codeOf(d) { return typeof d.code === 'object' ? String(d.code?.value ?? '') : d.code !== undefined ? String(d.code) : undefined; }
function range(l) { return new vscode.Range(l.line, l.character, l.endLine, l.endCharacter); }
function isUsefulAction(a) {
    const title = ('title' in a ? a.title : '').trim();
    if (!title)
        return false;
    const lower = title.toLowerCase();
    // Do not surface generic AI/chat actions as repair actions. They cannot be
    // applied deterministically and are useless in offline/no-chat environments.
    if (lower === 'explain' || lower === 'fix' || lower.includes('copilot') || lower.includes('chat') || lower.includes('generate with ai'))
        return false;
    if ('disabled' in a && a.disabled)
        return false;
    return true;
}
async function actionsFor(l) {
    try {
        const all = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', vscode.Uri.parse(l.uri), range(l), vscode.CodeActionKind.QuickFix.value) || [];
        return all.filter(isUsefulAction).map(a => ({ title: a.title, kind: 'kind' in a ? a.kind?.value : undefined, preferred: 'isPreferred' in a ? !!a.isPreferred : false }));
    }
    catch {
        return [];
    }
}
async function collect() {
    const includeWarnings = vscode.workspace.getConfiguration('refactorFallout').get('includeWarnings', false);
    const map = new Map();
    for (const [uri, ds] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== 'file')
            continue;
        if (vscode.workspace.workspaceFolders && !vscode.workspace.getWorkspaceFolder(uri))
            continue;
        for (const d of ds) {
            if (d.severity !== vscode.DiagnosticSeverity.Error && !(includeWarnings && d.severity === vscode.DiagnosticSeverity.Warning))
                continue;
            const n = normalize(d.message);
            const l = { id: `${uri.toString()}#${d.range.start.line}:${d.range.start.character}:${codeOf(d) ?? ''}:${d.message}`, uri: uri.toString(), fileName: uri.path.split('/').pop() || uri.fsPath, relativePath: vscode.workspace.asRelativePath(uri, false), line: d.range.start.line, character: d.range.start.character, endLine: d.range.end.line, endCharacter: d.range.end.character, message: d.message, source: d.source, code: codeOf(d), severity: d.severity, actions: [] };
            let f = map.get(n.key);
            if (!f) {
                f = { id: n.key, title: n.title, subtitle: n.subtitle, category: n.category, description: n.description, locations: [], files: [], actionCoverage: [] };
                map.set(n.key, f);
            }
            f.locations.push(l);
        }
    }
    const families = [...map.values()].sort((a, b) => b.locations.length - a.locations.length);
    const all = families.flatMap(f => f.locations);
    let cursor = 0;
    await Promise.all(Array.from({ length: 6 }, async () => { while (cursor < all.length) {
        const l = all[cursor++];
        l.actions = await actionsFor(l);
    } }));
    for (const f of families) {
        const fm = new Map();
        for (const l of f.locations) {
            let g = fm.get(l.uri);
            if (!g) {
                g = { uri: l.uri, fileName: l.fileName, relativePath: l.relativePath, locations: [] };
                fm.set(l.uri, g);
            }
            g.locations.push(l);
        }
        f.files = [...fm.values()];
        const counts = new Map();
        for (const l of f.locations) {
            for (const title of new Set(l.actions.map(a => a.title)))
                counts.set(title, (counts.get(title) || 0) + 1);
        }
        f.actionCoverage = [...counts].map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
    }
    return { total: all.length, families };
}
async function resolveAction(l, title) {
    const all = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', vscode.Uri.parse(l.uri), range(l), vscode.CodeActionKind.QuickFix.value) || [];
    return all.find(a => isUsefulAction(a) && a.title === title);
}
async function executeAction(action) {
    try {
        if ('edit' in action && action.edit) {
            const ok = await vscode.workspace.applyEdit(action.edit);
            if (!ok)
                return false;
        }
        if ('command' in action && action.command) {
            await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments || []));
        }
        else if (!('edit' in action) && action.command) {
            await vscode.commands.executeCommand(action.command, ...(action.arguments || []));
        }
        return ('edit' in action && !!action.edit) || ('command' in action && !!action.command);
    }
    catch (e) {
        console.error('Refactor Fallout quick fix failed', e);
        return false;
    }
}
async function applyActionToFamily(familyId, title) {
    const f = snapshot.families.find(x => x.id === familyId);
    if (!f)
        return;
    let applied = 0, unavailable = 0, failed = 0;
    // Re-query before every application. Workspace edits can move subsequent
    // diagnostics, so stale CodeAction objects from mural rendering are unsafe.
    for (const original of [...f.locations]) {
        const current = findClosestCurrent(original);
        if (!current) {
            continue;
        }
        const action = await resolveAction(current, title);
        if (!action) {
            unavailable++;
            continue;
        }
        if (await executeAction(action)) {
            applied++;
            await delay(80);
        }
        else
            failed++;
    }
    vscode.window.showInformationMessage(`Refactor Fallout: ${title}: applied ${applied}${unavailable ? `, ${unavailable} no longer available` : ''}${failed ? `, ${failed} failed` : ''}.`);
    await refresh(true);
}
function findClosestCurrent(old) {
    const exact = snapshot.families.flatMap(f => f.locations).find(l => l.id === old.id);
    if (exact)
        return exact;
    return snapshot.families.flatMap(f => f.locations).find(l => l.uri === old.uri && l.message === old.message && Math.abs(l.line - old.line) <= 3);
}
const delay = (ms) => new Promise(r => setTimeout(r, ms));
async function openLoc(l) { const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(l.uri)); const ed = await vscode.window.showTextDocument(doc, { preview: false }); const p = new vscode.Position(l.line, l.character); ed.selection = new vscode.Selection(p, p); ed.revealRange(range(l), vscode.TextEditorRevealType.InCenterIfOutsideViewport); }
function startGroup(id) { const f = snapshot.families.find(x => x.id === id); if (!f)
    return; session = { mode: 'group', familyIds: [id], currentFamilyId: id, currentLocationId: f.locations[0]?.id, initialIds: new Set(f.locations.map(l => l.id)), fixedIds: new Set() }; if (f.locations[0])
    openLoc(f.locations[0]); render(); }
function startAll() { const ids = snapshot.families.map(f => f.id); const locs = snapshot.families.flatMap(f => f.locations); session = { mode: 'all', familyIds: ids, currentFamilyId: ids[0], currentLocationId: locs[0]?.id, initialIds: new Set(locs.map(l => l.id)), fixedIds: new Set() }; if (locs[0])
    openLoc(locs[0]); render(); }
function sessionRemaining() { if (!session)
    return []; return snapshot.families.filter(f => session.familyIds.includes(f.id)).flatMap(f => f.locations); }
async function move(delta) { if (!session)
    return; const locs = sessionRemaining(); if (!locs.length)
    return; let i = locs.findIndex(l => l.id === session.currentLocationId); if (i < 0)
    i = 0;
else
    i = (i + delta + locs.length) % locs.length; session.currentLocationId = locs[i].id; session.currentFamilyId = snapshot.families.find(f => f.locations.some(l => l.id === locs[i].id))?.id; await openLoc(locs[i]); render(); }
function reconcileSession(previous) {
    if (!session)
        return;
    const nowIds = new Set(snapshot.families.flatMap(f => f.locations).map(l => l.id));
    for (const id of session.initialIds)
        if (!nowIds.has(id))
            session.fixedIds.add(id);
    const remaining = sessionRemaining();
    if (!remaining.length) {
        vscode.window.showInformationMessage(session.mode === 'all' ? 'Refactor Fallout: all repair groups complete.' : 'Refactor Fallout: repair group complete.');
        session = undefined;
        return;
    }
    if (!remaining.some(l => l.id === session.currentLocationId)) {
        const next = remaining[0];
        session.currentLocationId = next.id;
        session.currentFamilyId = snapshot.families.find(f => f.locations.some(l => l.id === next.id))?.id;
        openLoc(next);
    }
}
async function refresh(fromDiagnostics = false) { if (!panel)
    return; const prev = snapshot; snapshot = await collect(); if (fromDiagnostics)
    reconcileSession(prev); render(); }
function render() { if (panel)
    panel.webview.html = html(panel.webview); }
function open(context) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Active);
        refresh();
        return;
    }
    panel = vscode.window.createWebviewPanel('refactorFallout', 'Refactor Fallout', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.onDidDispose(() => panel = undefined, null, context.subscriptions);
    panel.webview.onDidReceiveMessage(async (m) => {
        if (m.type === 'refresh')
            return refresh();
        if (m.type === 'toggleWarnings') {
            await vscode.workspace.getConfiguration('refactorFallout').update('includeWarnings', !!m.enabled, vscode.ConfigurationTarget.Workspace);
            session = undefined;
            return refresh();
        }
        if (m.type === 'start')
            return startGroup(m.familyId);
        if (m.type === 'startAll')
            return startAll();
        if (m.type === 'next')
            return move(1);
        if (m.type === 'prev')
            return move(-1);
        const l = snapshot.families.flatMap(f => f.locations).find(x => x.id === m.locationId);
        if (m.type === 'open' && l)
            return openLoc(l);
        if (m.type === 'quickFix' && l) {
            await openLoc(l);
            return vscode.commands.executeCommand('editor.action.quickFix');
        }
        if (m.type === 'applyAll')
            return applyActionToFamily(m.familyId, m.title);
    });
    refresh();
}
function html(webview) {
    const nonce = String(Date.now());
    const data = JSON.stringify(snapshot).replace(/</g, '\\u003c');
    const sess = session ? JSON.stringify({ mode: session.mode, familyIds: session.familyIds, currentFamilyId: session.currentFamilyId, currentLocationId: session.currentLocationId, fixed: session.fixedIds.size, initial: session.initialIds.size }).replace(/</g, '\\u003c') : 'null';
    const warningsEnabled = vscode.workspace.getConfiguration('refactorFallout').get('includeWarnings', false);
    return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src ${webview.cspSource} 'unsafe-inline';script-src 'nonce-${nonce}';"><style>
 *{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px var(--vscode-font-family)}button{font:inherit;border:1px solid transparent;border-radius:3px;padding:7px 12px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:transparent;color:var(--vscode-foreground);border-color:var(--vscode-button-border,var(--vscode-panel-border))}button.toggle{display:flex;align-items:center;gap:7px;background:transparent;color:var(--vscode-foreground);border-color:var(--vscode-panel-border)}button.toggle.on{background:var(--vscode-list-activeSelectionBackground);border-color:var(--vscode-focusBorder)}.toggleDot{width:8px;height:8px;border-radius:50%;background:var(--vscode-editorWarning-foreground)}.severityWarning{color:var(--vscode-editorWarning-foreground);font-weight:600}.severityError{color:var(--vscode-editorError-foreground);font-weight:600}.shell{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}.side{padding:18px 10px;background:var(--vscode-sideBar-background);border-right:1px solid var(--vscode-panel-border);position:sticky;top:0;height:100vh;overflow:auto}.main{padding:0 24px 48px;background-image:radial-gradient(color-mix(in srgb,var(--vscode-editorIndentGuide-background) 65%,transparent) 1px,transparent 1px);background-size:20px 20px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:.09em;opacity:.62}.counts{line-height:1.65;margin:9px 4px 16px}.family{padding:11px 12px;margin:5px 0;border:1px solid transparent;border-radius:4px;cursor:pointer}.family:hover{background:var(--vscode-list-hoverBackground)}.family.active{border-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.familyTitle{font-weight:600;line-height:1.3}.familyMeta{display:flex;gap:7px;align-items:center;margin-top:7px;font-size:11px;opacity:.72}.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.badge{min-width:22px;text-align:center;border-radius:11px;padding:2px 7px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px}.sub{opacity:.66;font-size:12px;margin-top:4px}.topbar{height:52px;display:flex;align-items:center;justify-content:space-between;gap:12px;position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--vscode-editor-background) 94%,transparent);border-bottom:1px solid var(--vscode-panel-border);backdrop-filter:blur(8px)}.topTitle{font-size:13px;font-weight:600}.toolbar{display:flex;gap:7px}.workspace{max-width:1120px;margin:0 auto}.session{border:1px solid var(--vscode-focusBorder);background:var(--vscode-editorWidget-background);padding:11px 13px;margin:14px 0 0;border-radius:4px}.sessionProgress{height:3px;background:var(--vscode-progressBar-background);margin-top:10px;opacity:.8}.hero{margin:18px 0 12px;padding:16px 18px;border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-focusBorder);background:var(--vscode-editorWidget-background);border-radius:4px}.hero h2{font-size:15px;margin:0;font-weight:650}.heroMeta{display:flex;gap:12px;align-items:center;margin-top:8px;color:var(--vscode-descriptionForeground);font-size:12px}.category{font-weight:600;color:var(--vscode-foreground)}.description{line-height:1.55;margin:12px 0 0;max-width:850px;color:var(--vscode-descriptionForeground)}.technical{margin-top:10px;font-size:11px;color:var(--vscode-descriptionForeground)}.section{margin-top:14px}.sectionHead{display:flex;align-items:center;justify-content:space-between;padding:7px 2px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}.fixes{border:1px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background);border-radius:4px;overflow:hidden}.fix{display:grid;grid-template-columns:minmax(180px,1fr) auto auto;align-items:center;gap:14px;padding:10px 12px;border-top:1px solid var(--vscode-panel-border)}.fix:first-child{border-top:0}.fixCoverage{font-size:11px;color:var(--vscode-descriptionForeground)}.noFix{padding:12px;color:var(--vscode-descriptionForeground);line-height:1.45}.files{display:grid;gap:10px}.file{border:1px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background);border-radius:4px;overflow:hidden}.fileHead{padding:10px 12px;background:var(--vscode-sideBarSectionHeader-background)}.path{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.loc{display:grid;grid-template-columns:58px minmax(0,1fr) auto;align-items:start;gap:10px;padding:9px 12px;border-top:1px solid var(--vscode-panel-border);cursor:pointer}.loc:hover{background:var(--vscode-list-hoverBackground)}.loc.current{background:var(--vscode-list-activeSelectionBackground);outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.lineNo{font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--vscode-editorLineNumber-foreground);padding-top:1px}.locmsg{font-family:var(--vscode-editor-font-family);line-height:1.4;overflow-wrap:anywhere}.locfix{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px}.locAction{font-size:11px;color:var(--vscode-textLink-foreground);white-space:nowrap;padding-top:1px}.empty{text-align:center;margin:100px auto;max-width:420px;color:var(--vscode-descriptionForeground)}.empty h2{color:var(--vscode-foreground)}
 @media(max-width:850px){.shell{grid-template-columns:220px 1fr}.main{padding:0 14px}.fix{grid-template-columns:1fr auto}.fix button{grid-column:1/-1}.loc{grid-template-columns:45px 1fr}.locAction{display:none}}
 </style></head><body><div class="shell"><aside class="side"><div class="eyebrow">REFACTOR FALLOUT</div><div class="counts"><b>${snapshot.total}</b> visible problems in <b>${snapshot.families.length}</b> repair group${snapshot.families.length === 1 ? '' : 's'}<div class="sub">${snapshot.families.flatMap(f=>f.locations).filter(l=>l.severity===0).length} errors${warningsEnabled?' · '+snapshot.families.flatMap(f=>f.locations).filter(l=>l.severity===1).length+' warnings':''}</div></div><div id="families"></div></aside><main class="main"><div class="topbar"><div class="topTitle" id="topTitle">Repair workspace</div><div class="toolbar"><button class="toggle ${warningsEnabled?'on':''}" id="warnings"><span class="toggleDot"></span>Warnings ${warningsEnabled?'On':'Off'}</button><button class="secondary" id="refresh">Recheck</button><button id="startAll">Repair All</button><button id="start">Repair Group</button></div></div><div class="workspace"><div id="session"></div><div id="content"></div></div></main></div><script nonce="${nonce}">
 const vscode=acquireVsCodeApi(), snap=${data}, session=${sess};let selected=session?.currentFamilyId||snap.families[0]?.id;const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const fam=()=>snap.families.find(f=>f.id===selected);
 function render(){document.getElementById('families').innerHTML=snap.families.map(f=>{const q=f.locations.filter(l=>l.actions.length).length;return '<div class="family '+(f.id===selected?'active':'')+'" data-f="'+esc(f.id)+'"><div class="row"><div class="familyTitle">'+esc(f.title)+'</div><span class="badge">'+f.locations.length+'</span></div><div class="familyMeta"><span class="'+(f.locations.some(l=>l.severity===0)?'severityError':'severityWarning')+'">'+(f.locations.some(l=>l.severity===0)?'Error':'Warning')+'</span><span>·</span><span>'+esc(f.category)+'</span><span>·</span><span>'+f.files.length+' file'+(f.files.length===1?'':'s')+'</span></div>'+(q?'<div class="familyMeta"><span>'+q+' location'+(q===1?'':'s')+' with native fix</span></div>':'')+'</div>'}).join('');document.querySelectorAll('[data-f]').forEach(e=>e.onclick=()=>{selected=e.dataset.f;render()});
 const s=document.getElementById('session');if(session){const remaining=session.familyIds.flatMap(id=>snap.families.find(f=>f.id===id)?.locations||[]).length;const done=Math.max(0,session.initial-remaining),pct=session.initial?Math.round(done/session.initial*100):0;s.innerHTML='<div class="session"><div class="row"><div><b>'+(session.mode==='all'?'Repairing all groups':'Repairing selected group')+'</b><div class="sub">'+remaining+' remaining · '+session.fixed+' fixed this session'+(session.mode==='all'?' · '+session.familyIds.length+' groups queued':'')+'</div></div><div><button class="secondary" id="prev">Previous</button> <button id="next">Next</button></div></div><div class="sessionProgress" style="width:'+pct+'%"></div></div>';document.getElementById('prev').onclick=()=>vscode.postMessage({type:'prev'});document.getElementById('next').onclick=()=>vscode.postMessage({type:'next'});}else s.innerHTML='';
 const f=fam(),c=document.getElementById('content');if(!f){document.getElementById('topTitle').textContent='Repair workspace';c.innerHTML='<div class="empty"><h2>All clear</h2><p>No matching compiler diagnostics remain.</p></div>';return;}document.getElementById('topTitle').textContent=f.title;const src=[...new Set(f.locations.map(l=>l.source).filter(Boolean))].join(', ');const codes=[...new Set(f.locations.map(l=>l.code).filter(Boolean))].join(', ');const quickLocations=f.locations.filter(l=>l.actions.length).length;
 c.innerHTML='<div class="hero"><div class="row"><div><h2>'+esc(f.title)+'</h2><div class="heroMeta"><span class="category">'+esc(f.category)+'</span><span>'+f.locations.length+' occurrence'+(f.locations.length===1?'':'s')+'</span><span>'+f.files.length+' file'+(f.files.length===1?'':'s')+'</span>'+(quickLocations?'<span>'+quickLocations+' with native fix</span>':'')+'</div></div><span class="badge">'+f.locations.length+'</span></div><div class="description">'+esc(f.description)+'</div>'+((src||codes)?'<div class="technical">'+(src?'Source: '+esc(src):'')+(src&&codes?' · ':'')+(codes?'Diagnostic '+esc(codes):'')+'</div>':'')+'</div>'+
 '<div class="section"><div class="sectionHead"><span>Available fixes</span><span>'+quickLocations+'/'+f.locations.length+' locations</span></div>'+(f.actionCoverage.length?'<div class="fixes">'+f.actionCoverage.map(a=>'<div class="fix"><div><b>'+esc(a.title)+'</b><div class="fixCoverage">Available at '+a.count+' of '+f.locations.length+' locations</div></div><span class="fixCoverage">'+(a.count===f.locations.length?'Common fix':'Partial coverage')+'</span>'+(a.count===f.locations.length?'<button data-apply="'+esc(a.title)+'">Apply to Group</button>':'<button class="secondary" data-show="'+esc(a.title)+'">Open First</button>')+'</div>').join('')+'</div>':'<div class="fixes"><div class="noFix"><b>Manual repair</b><br>No deterministic native quick fix is available. Start a repair session and edit the location in the normal VS Code editor; when the diagnostic clears, Refactor Fallout will advance automatically.</div></div>')+'</div>'+
 '<div class="section"><div class="sectionHead"><span>Affected locations</span><span>'+f.locations.length+' total</span></div><div class="files">'+f.files.map(file=>'<div class="file"><div class="fileHead row"><div><b>'+esc(file.fileName)+'</b><div class="path">'+esc(file.relativePath)+'</div></div><span class="badge">'+file.locations.length+'</span></div>'+file.locations.map(l=>'<div class="loc '+(session?.currentLocationId===l.id?'current':'')+'" data-open="'+esc(l.id)+'"><span class="lineNo">Ln '+(l.line+1)+'</span><div><div class="locmsg">'+esc(l.message)+'</div>'+(l.actions.length?'<div class="locfix">'+esc(l.actions.map(a=>a.title).join(' · '))+'</div>':'<div class="locfix">Manual editor repair</div>')+'</div><span class="locAction">Open ↗</span></div>').join('')+'</div>').join('')+'</div></div>';
 c.querySelectorAll('[data-open]').forEach(e=>e.onclick=()=>vscode.postMessage({type:'open',locationId:e.dataset.open}));c.querySelectorAll('[data-apply]').forEach(e=>e.onclick=()=>vscode.postMessage({type:'applyAll',familyId:f.id,title:e.dataset.apply}));c.querySelectorAll('[data-show]').forEach(e=>e.onclick=()=>{const l=f.locations.find(x=>x.actions.some(a=>a.title===e.dataset.show));if(l)vscode.postMessage({type:'quickFix',locationId:l.id})});}
 document.getElementById('warnings').onclick=()=>vscode.postMessage({type:'toggleWarnings',enabled:${warningsEnabled?'false':'true'}});document.getElementById('refresh').onclick=()=>vscode.postMessage({type:'refresh'});document.getElementById('start').onclick=()=>{const f=fam();if(f)vscode.postMessage({type:'start',familyId:f.id})};document.getElementById('startAll').onclick=()=>vscode.postMessage({type:'startAll'});render();
 </script></body></html>`;
}
function deactivate() { }
