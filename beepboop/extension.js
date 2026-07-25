const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

class SoundEngine {
    constructor(context) {
        this.context = context;
        this.lastPlayed = new Map();
        this.activeProcesses = new Map();
        this.windowFocused = true;
        this.lastAnySoundAt = 0;

        this.soundNames = {
            open: 'open',
            close: 'close',
            navigate: 'navigate',
            save: 'save',
            start: 'start',
            success: 'success',
            warning: 'warning',
            failure: 'failure',
            debugStart: 'debug-start',
            debugStop: 'debug-stop',
            vimNormal: 'vim-normal',
            vimInsert: 'vim-insert',
            vimVisual: 'vim-visual',
            vimSearch: 'vim-search',
            vimYank: 'vim-yank',
            vimPaste: 'vim-paste',
            vimDelete: 'vim-delete',
            vimChange: 'vim-change',
            vimMoveLeft: 'vim-move-left',
            vimMoveDown: 'vim-move-down',
            vimMoveUp: 'vim-move-up',
            vimMoveRight: 'vim-move-right',
            vimPageUp: 'vim-page-up',
            vimPageDown: 'vim-page-down',
            vimWordForward: 'vim-word-forward',
            vimWordBackward: 'vim-word-backward'
        };
    }

    environment() {
        const configured = this.config().get('environment', 'voxel');
        return ['voxel', 'kingdomHearts', 'zen'].includes(configured)
            ? configured
            : 'voxel';
    }

    candidatesFor(name) {
        const basename = this.soundNames[name];
        if (!basename) {
            return [];
        }

        const environment = this.environment();
        return Array.from({ length: 5 }, (_, index) =>
            this.context.asAbsolutePath(
                path.join('environments', environment, `${basename}-${index}.wav`)
            )
        );
    }

    config() {
        return vscode.workspace.getConfiguration('ambientActionAudio');
    }

    setWindowFocused(focused) {
        this.windowFocused = focused;
    }

    play(name, minimumOverride) {
        if (!this.config().get('enabled', true)) return;
        if (this.config().get('muteWhenWindowInactive', true) && !this.windowFocused) return;

        const now = Date.now();
        const minimum = minimumOverride ?? this.config().get('minimumIntervalMs', 180);
        const duplicateGuard = this.config().get('globalMinimumIntervalMs', 12);
        const maxConcurrent = Math.max(
            1,
            this.config().get('maxConcurrentSounds', 3)
        );

        // Per-sound throttling still prevents an accidental event storm, but
        // active sounds no longer cause the newest action to be discarded.
        if (now - (this.lastPlayed.get(name) || 0) < minimum) return;
        if (now - this.lastAnySoundAt < duplicateGuard) return;

        const candidates = this.candidatesFor(name);
        if (!Array.isArray(candidates) || candidates.length === 0) return;

        const variation = this.config().get('soundVariation', true);
        const file = variation
            ? candidates[Math.floor(Math.random() * candidates.length)]
            : candidates[0];
        if (!file || !fs.existsSync(file)) return;

        // Favor current input over stale audio. This keeps feedback immediate
        // even when an environment uses longer bell, choir, or bowl tails.
        while (this.activeProcesses.size >= maxConcurrent) {
            const oldest = this.activeProcesses.keys().next().value;
            if (!oldest) break;

            this.activeProcesses.delete(oldest);
            try {
                oldest.kill();
            } catch {
                // The process may already have exited.
            }
        }

        const child = this.spawnPlayer(file);
        if (!child) return;

        this.lastPlayed.set(name, now);
        this.lastAnySoundAt = now;
        this.activeProcesses.set(child, {
            name,
            startedAt: now
        });

        const remove = () => this.activeProcesses.delete(child);
        child.once('exit', remove);
        child.once('error', remove);
    }

    spawnPlayer(file) {
        if (process.platform === 'win32') {
            const escaped = file.replace(/'/g, "''");
            return spawn('powershell.exe', [
                '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
                '-Command',
                `$p = New-Object System.Media.SoundPlayer '${escaped}'; $p.PlaySync()`
            ], { windowsHide: true, stdio: 'ignore' });
        }
        if (process.platform === 'darwin') {
            return spawn('afplay', [file], { detached: true, stdio: 'ignore' });
        }
        return spawn('paplay', [file], { detached: true, stdio: 'ignore' });
    }

    dispose() {
        for (const child of this.activeProcesses.keys()) {
            try { child.kill(); } catch {}
        }
        this.activeProcesses.clear();
    }
}

const VIM_SETUP = `
// Add these entries to your VS Code settings.json.
// Merge them into existing VSCodeVim arrays rather than creating duplicate keys.

"vim.insertModeKeyBindingsNonRecursive": [
  {
    "before": ["<Esc>"],
    "commands": [
      "ambientActionAudio.vimNormal",
      { "command": "vim.remap", "args": { "after": ["<Esc>"] } }
    ]
  },
  {
    "before": ["j", "j"],
    "commands": [
      "ambientActionAudio.vimNormal",
      { "command": "vim.remap", "args": { "after": ["<Esc>"] } }
    ]
  }
],

"vim.normalModeKeyBindingsNonRecursive": [
  {
    "before": ["i"],
    "commands": [
      "ambientActionAudio.vimInsert",
      { "command": "vim.remap", "args": { "after": ["i"] } }
    ]
  },
  {
    "before": ["a"],
    "commands": [
      "ambientActionAudio.vimInsert",
      { "command": "vim.remap", "args": { "after": ["a"] } }
    ]
  },
  {
    "before": ["o"],
    "commands": [
      "ambientActionAudio.vimInsert",
      { "command": "vim.remap", "args": { "after": ["o"] } }
    ]
  },
  {
    "before": ["v"],
    "commands": [
      "ambientActionAudio.vimVisual",
      { "command": "vim.remap", "args": { "after": ["v"] } }
    ]
  },
  {
    "before": ["V"],
    "commands": [
      "ambientActionAudio.vimVisual",
      { "command": "vim.remap", "args": { "after": ["V"] } }
    ]
  },
  {
    "before": ["/"],
    "commands": [
      "ambientActionAudio.vimSearch",
      { "command": "vim.remap", "args": { "after": ["/"] } }
    ]
  },
  {
    "before": ["p"],
    "commands": [
      "ambientActionAudio.vimPaste",
      { "command": "vim.remap", "args": { "after": ["p"] } }
    ]
  },
  {
    "before": ["d", "d"],
    "commands": [
      "ambientActionAudio.vimDelete",
      { "command": "vim.remap", "args": { "after": ["d", "d"] } }
    ]
  },
  {
    "before": ["y", "y"],
    "commands": [
      "ambientActionAudio.vimYank",
      { "command": "vim.remap", "args": { "after": ["y", "y"] } }
    ]
  }
],

"vim.visualModeKeyBindingsNonRecursive": [
  {
    "before": ["<Esc>"],
    "commands": [
      "ambientActionAudio.vimNormal",
      { "command": "vim.remap", "args": { "after": ["<Esc>"] } }
    ]
  },
  {
    "before": ["y"],
    "commands": [
      "ambientActionAudio.vimYank",
      { "command": "vim.remap", "args": { "after": ["y"] } }
    ]
  },
  {
    "before": ["d"],
    "commands": [
      "ambientActionAudio.vimDelete",
      { "command": "vim.remap", "args": { "after": ["d"] } }
    ]
  }
]
`;


async function mergeVimMappings(settingName, desiredMappings) {
    const vimConfig = vscode.workspace.getConfiguration('vim');
    const inspection = vimConfig.inspect(settingName);
    const current = vimConfig.get(settingName, []);
    const mappings = Array.isArray(current)
        ? JSON.parse(JSON.stringify(current))
        : [];

    const sameBefore = (left, right) =>
        Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((value, index) => value === right[index]);

    for (const desired of desiredMappings) {
        const index = mappings.findIndex(mapping =>
            sameBefore(mapping?.before, desired.before)
        );

        if (index >= 0) {
            mappings[index] = desired;
        } else {
            mappings.push(desired);
        }
    }

    let target = vscode.ConfigurationTarget.Global;
    if (inspection?.workspaceFolderValue !== undefined) {
        target = vscode.ConfigurationTarget.WorkspaceFolder;
    } else if (inspection?.workspaceValue !== undefined) {
        target = vscode.ConfigurationTarget.Workspace;
    }

    await vimConfig.update(settingName, mappings, target);
}

async function installVimMappings() {
    await mergeVimMappings('normalModeKeyBindingsNonRecursive', [
        {
            before: ['<C-u>'],
            commands: ['ambientActionAudio.playVimPageUp'],
            after: ['<C-u>']
        },
        {
            before: ['<C-d>'],
            commands: ['ambientActionAudio.playVimPageDown'],
            after: ['<C-d>']
        },
        {
            before: ['c'],
            commands: ['ambientActionAudio.playVimChange'],
            after: ['c']
        },
        {
            before: ['d'],
            commands: ['ambientActionAudio.playVimDelete'],
            after: ['d']
        },
        {
            before: ['y'],
            commands: ['ambientActionAudio.playVimYank'],
            after: ['y']
        },
        {
            before: ['p'],
            commands: ['ambientActionAudio.playVimPut'],
            after: ['p']
        }
    ]);

    await mergeVimMappings('visualModeKeyBindingsNonRecursive', [
        {
            before: ['c'],
            commands: ['ambientActionAudio.playVimChange'],
            after: ['c']
        },
        {
            before: ['d'],
            commands: ['ambientActionAudio.playVimDelete'],
            after: ['d']
        },
        {
            before: ['y'],
            commands: ['ambientActionAudio.playVimYank'],
            after: ['y']
        },
        {
            before: ['p'],
            commands: ['ambientActionAudio.playVimPut'],
            after: ['p']
        }
    ]);
}

async function activate(context) {
    const engine = new SoundEngine(context);
    context.subscriptions.push(engine);

    const playVimSound = (sound, minimumOverride) => {
        const vimConfig = vscode.workspace.getConfiguration('ambientActionAudio.vim');
        if (!vimConfig.get('enabled', true)) {
            return;
        }

        if (sound.startsWith('vimPage')) {
            if (!vimConfig.get('pageMovement', true)) {
                return;
            }
        } else if (!vimConfig.get('actionCommands', true)) {
            return;
        }

        engine.play(sound, minimumOverride);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'ambientActionAudio.playVimPageUp',
            () => playVimSound(
                'vimPageUp',
                vscode.workspace
                    .getConfiguration('ambientActionAudio.vim')
                    .get('movementMinimumIntervalMs', 24)
            )
        ),
        vscode.commands.registerCommand(
            'ambientActionAudio.playVimPageDown',
            () => playVimSound(
                'vimPageDown',
                vscode.workspace
                    .getConfiguration('ambientActionAudio.vim')
                    .get('movementMinimumIntervalMs', 24)
            )
        ),
        vscode.commands.registerCommand(
            'ambientActionAudio.playVimChange',
            () => playVimSound(
                'vimChange',
                vscode.workspace.getConfiguration('ambientActionAudio.vim')
                    .get('actionMinimumIntervalMs', 18)
            )
        ),
        vscode.commands.registerCommand(
            'ambientActionAudio.playVimDelete',
            () => playVimSound(
                'vimDelete',
                vscode.workspace.getConfiguration('ambientActionAudio.vim')
                    .get('actionMinimumIntervalMs', 18)
            )
        ),
        vscode.commands.registerCommand(
            'ambientActionAudio.playVimYank',
            () => playVimSound(
                'vimYank',
                vscode.workspace.getConfiguration('ambientActionAudio.vim')
                    .get('actionMinimumIntervalMs', 18)
            )
        ),
        vscode.commands.registerCommand(
            'ambientActionAudio.playVimPut',
            () => playVimSound(
                'vimPaste',
                vscode.workspace.getConfiguration('ambientActionAudio.vim')
                    .get('actionMinimumIntervalMs', 18)
            )
        ),
        vscode.commands.registerCommand(
            'ambientActionAudio.installVimMappings',
            async () => {
                await installVimMappings();
                await context.globalState.update('vimMappingsInstalledV101', true);
                vscode.window.showInformationMessage(
                    'Installed safe Vim mappings. Reload VS Code now.'
                );
            }
        ),
        vscode.commands.registerCommand(
            'ambientActionAudio.installNavigationMappings',
            async () => {
                await installVimMappings();
                await context.globalState.update('vimMappingsInstalledV101', true);
                vscode.window.showInformationMessage(
                    'Installed safe Vim mappings. Reload VS Code now.'
                );
            }
        )
    );

    if (
        vscode.workspace
            .getConfiguration('ambientActionAudio.vim')
            .get('autoInstallActionMappings', true) &&
        !context.globalState.get('vimMappingsInstalledV101', false)
    ) {
        try {
            await installVimMappings();
            await context.globalState.update('vimMappingsInstalledV101', true);
            vscode.window.showInformationMessage(
                'Ambient Action Audio updated its Vim mappings. Reload VS Code to activate Ctrl+U and action sounds.'
            );
        } catch (error) {
            console.warn('Could not install Vim sound mappings:', error);
        }
    }

    context.subscriptions.push(vscode.window.onDidChangeWindowState(
        state => engine.setWindowFocused(state.focused)
    ));


    context.subscriptions.push(
        vscode.commands.registerCommand('ambientActionAudio.vimTransition', async args => {
            if (!vscode.workspace
                .getConfiguration('ambientActionAudio.vim')
                .get('enabled', true)) {
                await vscode.commands.executeCommand('vim.remap', { after: args?.after ?? [] });
                return;
            }

            const sound = args?.sound;
            const after = args?.after;

            if (typeof sound === 'string') {
                const vimConfig = vscode.workspace.getConfiguration('ambientActionAudio.vim');
                const isMovement = sound.startsWith('vimMove') || sound.startsWith('vimWord');
                const isPageMovement = sound.startsWith('vimPage');

                if ((!isMovement || vimConfig.get('movement', true)) &&
                    (!isPageMovement || vimConfig.get('pageMovement', true))) {
                    const interval = (isMovement || isPageMovement)
                        ? vimConfig.get('movementMinimumIntervalMs', 24)
                        : undefined;
                    engine.play(sound, interval);
                }
            }

            if (Array.isArray(after) && after.length > 0) {
                await vscode.commands.executeCommand('vim.remap', { after });
            }
        })
    );


    context.subscriptions.push(
        vscode.commands.registerCommand('ambientActionAudio.vimEscape', async () => {
            if (vscode.workspace
                .getConfiguration('ambientActionAudio.vim')
                .get('enabled', true)) {
                engine.play('vimNormal');
            }
            await vscode.commands.executeCommand('vim.remap', { after: ['<Esc>'] });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ambientActionAudio.installJkEscapeSound', async () => {
            const vimConfig = vscode.workspace.getConfiguration('vim');
            const inspection = vimConfig.inspect('insertModeKeyBindingsNonRecursive');
            const current = vimConfig.get('insertModeKeyBindingsNonRecursive', []);
            const mappings = Array.isArray(current)
                ? JSON.parse(JSON.stringify(current))
                : [];

            const isJk = mapping =>
                Array.isArray(mapping?.before) &&
                mapping.before.length === 2 &&
                mapping.before[0] === 'j' &&
                mapping.before[1] === 'k';

            let mapping = mappings.find(isJk);

            if (!mapping) {
                mapping = {
                    before: ['j', 'k'],
                    commands: ['ambientActionAudio.vimEscape']
                };
                mappings.push(mapping);
            } else if (Array.isArray(mapping.commands)) {
                mapping.commands = mapping.commands.filter(
                    command => command !== 'ambientActionAudio.vimEscape'
                );
                mapping.commands.unshift('ambientActionAudio.vimEscape');

                // vimEscape already performs the Escape remap, so remove a second
                // explicit Escape remap when it is represented as a command object.
                mapping.commands = mapping.commands.filter(command => {
                    if (!command || typeof command !== 'object') return true;
                    if (command.command !== 'vim.remap') return true;
                    const after = command.args?.after;
                    return !(Array.isArray(after) &&
                        after.length === 1 &&
                        after[0] === '<Esc>');
                });
            } else if (Array.isArray(mapping.after)) {
                mapping.commands = ['ambientActionAudio.vimEscape'];
                delete mapping.after;
            } else {
                mapping.commands = ['ambientActionAudio.vimEscape'];
            }

            let target = vscode.ConfigurationTarget.Global;
            if (inspection?.workspaceFolderValue !== undefined) {
                target = vscode.ConfigurationTarget.WorkspaceFolder;
            } else if (inspection?.workspaceValue !== undefined) {
                target = vscode.ConfigurationTarget.Workspace;
            }

            await vimConfig.update(
                'insertModeKeyBindingsNonRecursive',
                mappings,
                target
            );

            vscode.window.showInformationMessage(
                'JK Escape now plays the Normal-mode sound. Reload VS Code if VSCodeVim does not pick it up immediately.'
            );
        })
    );

    const soundCommands = {
        'ambientActionAudio.playSuccess': 'success',
        'ambientActionAudio.playFailure': 'failure',
        'ambientActionAudio.vimNormal': 'vimNormal',
        'ambientActionAudio.vimInsert': 'vimInsert',
        'ambientActionAudio.vimVisual': 'vimVisual',
        'ambientActionAudio.vimSearch': 'vimSearch',
        'ambientActionAudio.vimYank': 'vimYank',
        'ambientActionAudio.vimPaste': 'vimPaste',
        'ambientActionAudio.vimDelete': 'vimDelete'
    };

    for (const [command, sound] of Object.entries(soundCommands)) {
        context.subscriptions.push(vscode.commands.registerCommand(command, () => {
            if (command.includes('.vim') &&
                !vscode.workspace.getConfiguration('ambientActionAudio.vim').get('enabled', true)) {
                return;
            }
            engine.play(sound);
        }));
    }

    context.subscriptions.push(vscode.commands.registerCommand(
        'ambientActionAudio.showVimSetup',
        async () => {
            const document = await vscode.workspace.openTextDocument({
                language: 'jsonc',
                content: VIM_SETUP.trim()
            });
            await vscode.window.showTextDocument(document, { preview: false });
        }
    ));

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'ambientActionAudio.selectEnvironment',
            async () => {
                const environments = [
                    {
                        label: 'Voxel',
                        description: 'Warm wood, soft movement, and cave-like ambience',
                        value: 'voxel'
                    },
                    {
                        label: 'Kingdom Hearts',
                        description: 'Original airy crystal and magical fantasy tones',
                        value: 'kingdomHearts'
                    },
                    {
                        label: 'Zen',
                        description: 'Restrained wood, bowls, breath, and water',
                        value: 'zen'
                    }
                ];

                const current = engine.environment();
                const selected = await vscode.window.showQuickPick(
                    environments.map(item => ({
                        ...item,
                        picked: item.value === current
                    })),
                    {
                        title: 'Select Ambient Action Audio Environment',
                        placeHolder: 'The change takes effect immediately'
                    }
                );

                if (!selected) {
                    return;
                }

                await vscode.workspace
                    .getConfiguration('ambientActionAudio')
                    .update(
                        'environment',
                        selected.value,
                        vscode.ConfigurationTarget.Global
                    );

                vscode.window.showInformationMessage(
                    `Ambient Action Audio environment: ${selected.label}`
                );
                engine.play('save', 0);
            }
        ),
        vscode.commands.registerCommand(
            'ambientActionAudio.previewEnvironment',
            async () => {
                for (const sound of [
                    'vimMoveLeft', 'vimMoveDown', 'vimMoveUp', 'vimMoveRight',
                    'vimWordForward', 'vimPageDown',
                    'vimChange', 'vimDelete', 'vimYank', 'vimPaste',
                    'save', 'success'
                ]) {
                    engine.play(sound, 0);
                    await new Promise(resolve => setTimeout(resolve, 360));
                }
            }
        )
    );

    context.subscriptions.push(vscode.commands.registerCommand(
        'ambientActionAudio.toggle',
        async () => {
            const config = vscode.workspace.getConfiguration('ambientActionAudio');
            const enabled = config.get('enabled', true);
            await config.update('enabled', !enabled, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Ambient Action Audio ${enabled ? 'disabled' : 'enabled'}.`
            );
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'ambientActionAudio.preview',
        async () => {
            for (const sound of [
                'open', 'save', 'success', 'failure',
                'vimNormal', 'vimInsert', 'vimVisual',
                'vimSearch', 'vimYank', 'vimPaste', 'vimDelete'
            ]) {
                engine.play(sound);
                await new Promise(resolve => setTimeout(resolve, 400));
            }
        }
    ));

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(() => {
            if (setting('save', true)) engine.play('save');
        }),
        vscode.workspace.onDidOpenTextDocument(doc => {
            if (doc.uri.scheme === 'file' && setting('openClose', true)) engine.play('open');
        }),
        vscode.workspace.onDidCloseTextDocument(doc => {
            if (doc.uri.scheme === 'file' && setting('openClose', true)) engine.play('close');
        }),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && setting('editorNavigation', false)) engine.play('navigate');
        }),
        vscode.tasks.onDidStartTask(() => {
            if (setting('tasks', true)) engine.play('start');
        }),
        vscode.tasks.onDidEndTaskProcess(event => {
            if (!setting('tasks', true)) return;
            if (event.exitCode === 0) engine.play('success');
            else if (typeof event.exitCode === 'number') engine.play('failure');
            else engine.play('warning');
        }),
        vscode.debug.onDidStartDebugSession(() => {
            if (setting('debug', true)) engine.play('debugStart');
        }),
        vscode.debug.onDidTerminateDebugSession(() => {
            if (setting('debug', true)) engine.play('debugStop');
        })
    );

    function setting(name, fallback) {
        return vscode.workspace.getConfiguration('ambientActionAudio').get(name, fallback);
    }
}

function deactivate() {}

module.exports = { activate, deactivate };
