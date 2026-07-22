const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdir, rm, stat } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

class GitRepository {
  constructor(root) {
    this.root = root;
  }

  static async findRoot(candidatePath) {
    if (!candidatePath) {
      return undefined;
    }

    try {
      let workingDirectory = candidatePath;
      try {
        const candidateStat = await stat(candidatePath);
        if (!candidateStat.isDirectory()) {
          workingDirectory = path.dirname(candidatePath);
        }
      } catch {
        // A deleted or virtual file path may no longer exist. Its parent is
        // still the best location from which to ask Git for the repository.
        workingDirectory = path.dirname(candidatePath);
      }

      const { stdout } = await execFileAsync(
        'git',
        ['-C', workingDirectory, 'rev-parse', '--show-toplevel'],
        { encoding: 'utf8' }
      );
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async currentBranch() {
    try {
      return (await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    } catch {
      const shortHead = (await this.run(['rev-parse', '--short', 'HEAD'])).trim();
      return `detached-${shortHead}`;
    }
  }

  async timelineRef() {
    const branch = await this.currentBranch();
    const safeBranch = branch
      .replace(/[^A-Za-z0-9._/-]+/g, '-')
      .replace(/\.\./g, '-')
      .replace(/@\{/g, '-')
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/$|\.lock$/g, '-');

    return `refs/x-plane/timeline/${safeBranch || 'unknown'}`;
  }

  async createSnapshot(savedFile, includeUntracked) {
    const timelineRef = await this.timelineRef();
    const previousTimelineCommit = await this.tryResolve(timelineRef);
    const headCommit = await this.tryResolve('HEAD');

    const gitDirectory = await this.gitCommonDir();
    const privateIndexDirectory = path.join(gitDirectory, 'x-plane', 'indexes');
    await mkdir(privateIndexDirectory, { recursive: true });

    const indexKey = createHash('sha256')
      .update(`${this.root}\0${timelineRef}`)
      .digest('hex')
      .slice(0, 24);
    const privateIndexPath = path.join(privateIndexDirectory, `${indexKey}.index`);
    const privateIndexEnvironment = {
      ...process.env,
      GIT_INDEX_FILE: privateIndexPath
    };

    try {
      await rm(privateIndexPath, { force: true });

      // Start the private index from the preceding timeline snapshot or HEAD.
      // A newly initialized repository has an unborn HEAD, so begin with an
      // empty private index instead. None of these operations alter .git/index,
      // HEAD, or the checked-out branch.
      const existingParent = previousTimelineCommit || headCommit;
      if (existingParent) {
        await this.run(['read-tree', `${existingParent}^{tree}`], privateIndexEnvironment);
      } else {
        await this.run(['read-tree', '--empty'], privateIndexEnvironment);
      }

      // Overlay the current working tree onto the private index.
      const addMode = includeUntracked ? '-A' : '-u';
      const nestedRepositoryExclusions = includeUntracked
        ? await this.untrackedNestedRepositoryPathspecs()
        : [];
      await this.run(
        [
          '-c',
          'core.safecrlf=false',
          'add',
          addMode,
          '--',
          '.',
          ...nestedRepositoryExclusions
        ],
        privateIndexEnvironment
      );

      const treeHash = (await this.run(['write-tree'], privateIndexEnvironment)).trim();
      const branch = await this.currentBranch();
      const relativeSavedFile = this.relative(savedFile);
      const commitMessage = [
        `X-Plane save: ${relativeSavedFile}`,
        '',
        'X-Plane-Event: save',
        `X-Plane-File: ${relativeSavedFile}`,
        `X-Plane-Branch: ${branch}`
      ].join('\n');

      let parentCommit = previousTimelineCommit || headCommit;
      if (!parentCommit) {
        const emptyTreeHash = (
          await this.runWithInput(['mktree'], '', privateIndexEnvironment)
        ).trim();
        parentCommit = (
          await this.runWithInput(
            ['commit-tree', emptyTreeHash],
            'X-Plane timeline base\n',
            privateIndexEnvironment
          )
        ).trim();
      }

      const commitHash = (
        await this.runWithInput(
          ['commit-tree', treeHash, '-p', parentCommit],
          commitMessage,
          privateIndexEnvironment
        )
      ).trim();

      const updateArguments = previousTimelineCommit
        ? [
            'update-ref',
            '-m',
            `x-plane save: ${relativeSavedFile}`,
            timelineRef,
            commitHash,
            previousTimelineCommit
          ]
        : [
            'update-ref',
            '-m',
            `x-plane save: ${relativeSavedFile}`,
            timelineRef,
            commitHash
          ];

      await this.run(updateArguments);
      return commitHash;
    } finally {
      await rm(privateIndexPath, { force: true });
    }
  }


  async untrackedNestedRepositoryPathspecs() {
    // A multi-root workspace can place one Git repository inside another
    // repository's working tree. Git tries to stage an untracked nested repo as
    // a gitlink, and an unborn nested repo makes `git add` fail with
    // "does not have a commit checked out". X-Plane records each repository
    // independently, so nested repositories must be excluded from the parent
    // repository snapshot.
    const status = await this.run([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all'
    ]);

    const exclusions = [];
    for (const entry of status.split('\0')) {
      if (!entry.startsWith('?? ')) {
        continue;
      }

      const relativePath = entry.slice(3).replace(/\/$/, '');
      if (!relativePath) {
        continue;
      }

      try {
        await stat(path.join(this.root, relativePath, '.git'));
      } catch {
        continue;
      }

      exclusions.push(`:(exclude)${relativePath}`);
      exclusions.push(`:(exclude)${relativePath}/**`);
    }

    return exclusions;
  }

  async listTimeline(limit) {
    const timelineRef = await this.timelineRef();
    if (!(await this.tryResolve(timelineRef))) {
      return [];
    }

    const format = '%H%x1f%P%x1f%ct%x1f%s%x1f%b%x1e';
    const rawLog = await this.run([
      'log',
      timelineRef,
      `--max-count=${limit}`,
      `--format=${format}`
    ]);

    const entries = rawLog
      .split('\x1e')
      .map(value => value.trim())
      .filter(Boolean);

    const commits = [];
    for (const entry of entries) {
      const [hash, parents, epoch, subject, body = ''] = entry.split('\x1f');
      if (!body.includes('X-Plane-Event: save')) {
        continue;
      }

      const savedFileMatch = body.match(/^X-Plane-File:\s*(.+)$/m);
      const branchMatch = body.match(/^X-Plane-Branch:\s*(.+)$/m);
      const parent = parents.split(' ')[0] || undefined;
      const changedFiles = parent
        ? (await this.run(['diff', '--name-only', parent, hash]))
            .split(/\r?\n/)
            .filter(Boolean)
        : [];

      commits.push({
        hash,
        parent,
        timestamp: Number(epoch),
        subject,
        savedFile: savedFileMatch ? savedFileMatch[1] : undefined,
        branch: branchMatch ? branchMatch[1] : undefined,
        changedFiles
      });
    }

    return commits;
  }

  async showFile(commit, relativeFile) {
    try {
      return await this.run(['show', `${commit}:${relativeFile}`]);
    } catch {
      return '';
    }
  }

  relative(filePath) {
    return path.relative(this.root, filePath).split(path.sep).join('/');
  }

  async gitCommonDir() {
    const value = (await this.run(['rev-parse', '--git-common-dir'])).trim();
    return path.resolve(this.root, value);
  }

  async tryResolve(ref) {
    try {
      return (await this.run(['rev-parse', '--verify', ref])).trim();
    } catch {
      return undefined;
    }
  }

  async run(args, env = process.env) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', this.root, ...args], {
        encoding: 'utf8',
        env,
        maxBuffer: 20 * 1024 * 1024
      });
      return stdout;
    } catch (error) {
      const stderr = error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
      throw new Error(stderr || error.message || String(error));
    }
  }

  async runWithInput(args, input, env) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        ['-C', this.root, ...args],
        {
          encoding: 'utf8',
          env,
          maxBuffer: 20 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error((stderr || error.message).trim()));
            return;
          }
          resolve(stdout);
        }
      );

      child.stdin.end(input);
    });
  }
}

module.exports = { GitRepository };
