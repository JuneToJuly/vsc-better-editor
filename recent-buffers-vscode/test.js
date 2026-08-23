'use strict';
const fs = require('fs');
const source = fs.readFileSync(require.resolve('./extension.js'), 'utf8');
const required = [
  'recentBuffers.show',
  'onDidChangeActiveTextEditor',
  'onDidChangeTextEditorSelection',
  'workspaceState',
  'showTextDocument',
  'findFiles',
  'searchFiles',
  'fileSearchMinChars',
  'fileSearchResultLimit',
  'createWebviewPanel',
  'Recent Buffers',
  'All Files'
];
for (const token of required) if (!source.includes(token)) throw new Error(`Missing implementation token: ${token}`);
if (source.includes('allFilesCache')) throw new Error('Workspace-wide file cache should not exist');
if (source.includes('getAllFiles()')) throw new Error('Workspace files should not be eagerly enumerated');
const pkg = require('./package.json');
if (pkg.main !== './extension.js') throw new Error('Unexpected extension entrypoint');
if (!pkg.contributes?.keybindings?.some(k => k.command === 'recentBuffers.show' && k.key === 'ctrl+e')) throw new Error('Ctrl+E keybinding missing');
if (pkg.version !== '0.3.7') throw new Error('Expected version 0.3.7');
if (pkg.contributes.configuration.properties['recentBuffers.allFilesLimit']) throw new Error('Legacy allFilesLimit setting should be removed');
console.log('Recent Buffers source/package checks passed.');

for (const token of ['jumpToAllFiles', "key === 'j'", "key === 'k'", "e.key === 'Tab'"]) { if (!source.includes(token)) throw new Error(`Missing keyboard navigation token: ${token}`); }

if (!source.includes("recentBuffers.moveDown")) throw new Error("Missing moveDown command");
if (!source.includes("recentBuffers.moveUp")) throw new Error("Missing moveUp command");
if (!JSON.stringify(pkg.contributes.keybindings).includes("recentBuffers.active")) throw new Error("Missing active-only keybindings");

if (source.includes("search.value = m.query")) throw new Error("Search input must not be overwritten by async state");
if (!source.includes("requestId")) throw new Error("Missing search request IDs");
if (!source.includes("requestId !== searchRequestId")) throw new Error("Missing stale search request guard");
console.log("Fast-typing regression checks passed.");

if (!source.includes("var(--vscode-editor-font-family")) throw new Error("Missing editor font for position");
if (!source.includes(".row.active::before")) throw new Error("Missing selected-row accent");
if (!source.includes("direction:rtl")) throw new Error("Missing trailing-path truncation");
console.log("Typography regression checks passed.");

if (!source.includes("recentWithFiles")) throw new Error("Missing bounded Recent pane");
if (!source.includes("filesSection")) throw new Error("Missing visible All Files pane");
if (!source.includes("data-section=\"files\"")) throw new Error("Missing All Files section marker");
console.log("Split result panes regression checks passed.");

if (!source.includes('spellcheck="false" autofocus')) throw new Error("Missing search autofocus");
if (!source.includes("function claimSearchFocus()")) throw new Error("Missing immediate focus helper");
if (!source.includes("requestAnimationFrame(claimSearchFocus)")) throw new Error("Missing first-frame focus reinforcement");
console.log("Initial-focus regression checks passed.");

if (!source.includes("recentBuffers.previousBuffer")) throw new Error("Missing previous buffer command");
if (!source.includes("async function openPreviousBuffer")) throw new Error("Missing previous-buffer implementation");
if (!source.includes("buildRecentRows(history, q, sourceUri)")) throw new Error("Recent rows do not receive invocation source URI");
if (!source.includes("const currentUri = sourceUri ||")) throw new Error("Invocation source URI is not excluded");
if (!pkg.contributes.commands.some(c => c.command === "recentBuffers.previousBuffer")) throw new Error("Previous Buffer command not contributed");
console.log("Previous-buffer regression checks passed.");

if (!source.includes("buildFileRows(files, q, history)")) throw new Error("All Files must use shared fuzzy row scoring");
if (!source.includes("minmax(190px, 275px)")) throw new Error("Filename column was not widened");
console.log("Unified search/readability regression checks passed.");

if (!source.includes("async function getWorkspaceFileIndex()")) throw new Error("Missing lazy workspace file index");
if (!source.includes("searchText: `${label} ${path}`")) throw new Error("Indexed files must use filename + path");
if (!source.includes("fuzzyScore(normalized, item.searchText)")) throw new Error("All Files must use the shared fuzzy matcher");
if (!source.includes("addWorkspaceFilesToIndex")) throw new Error("Missing create-file index update");
if (!source.includes("removeWorkspaceFilesFromIndex")) throw new Error("Missing delete-file index update");
if (!source.includes("renameWorkspaceFilesInIndex")) throw new Error("Missing rename-file index update");
if (!pkg.contributes.configuration.properties["recentBuffers.workspaceIndexLimit"]) throw new Error("Missing workspace index limit");
console.log("Lazy-index regression checks passed.");
