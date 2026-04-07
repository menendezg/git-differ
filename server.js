const express = require('express');
const path = require('path');
const simpleGit = require('simple-git');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getGit(repoPath) {
  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved)) {
    throw new Error('Repository path does not exist');
  }
  return simpleGit(resolved);
}

// Validate repo path
app.post('/api/repo', async (req, res) => {
  try {
    const { repoPath } = req.body;
    const git = getGit(repoPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      return res.status(400).json({ error: 'Not a git repository' });
    }
    const root = await git.revparse(['--show-toplevel']);
    res.json({ valid: true, root: root.trim() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// List branches
app.get('/api/branches', async (req, res) => {
  try {
    const git = getGit(req.query.repo);
    const branchSummary = await git.branch(['-a']);
    res.json({
      current: branchSummary.current,
      branches: Object.values(branchSummary.branches).map(b => ({
        name: b.name,
        current: b.current,
        commit: b.commit,
        label: b.label,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Commit history for a branch
app.get('/api/commits', async (req, res) => {
  try {
    const { repo, branch, search } = req.query;
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const git = getGit(repo);
    const skip = page * limit;

    const logOpts = {
      [branch]: null,
      '--max-count': limit,
      '--skip': skip,
    };

    if (search && search.trim()) {
      logOpts['--grep'] = search.trim();
      logOpts['--regexp-ignore-case'] = null;
    }

    const log = await git.log(logOpts);
    res.json({
      commits: log.all.map(c => ({
        hash: c.hash,
        abbrevHash: c.hash.substring(0, 7),
        message: c.message,
        author: c.author_name,
        email: c.author_email,
        date: c.date,
      })),
      total: log.total,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diff for a specific commit
app.get('/api/diff', async (req, res) => {
  try {
    const { repo, hash } = req.query;
    const git = getGit(repo);

    // Check if commit has a parent
    let hasParent = true;
    try {
      await git.raw(['rev-parse', '--verify', `${hash}~1`]);
    } catch {
      hasParent = false;
    }

    let diffText, nameStatus, numstatText;

    if (hasParent) {
      [diffText, nameStatus, numstatText] = await Promise.all([
        git.diff([`${hash}~1`, hash, '-M', '--unified=5']),
        git.diff([`${hash}~1`, hash, '-M', '--name-status']),
        git.diff([`${hash}~1`, hash, '-M', '--numstat']),
      ]);
    } else {
      [diffText, nameStatus, numstatText] = await Promise.all([
        git.show([hash, '--unified=5', '-M', '--format=']),
        git.show([hash, '--name-status', '-M', '--format=']),
        git.show([hash, '--numstat', '-M', '--format=']),
      ]);
    }

    const files = parseNameStatus(nameStatus);
    const patches = parseDiff(diffText);
    const numstat = parseNumstat(numstatText);

    res.json({ files, patches, numstat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseNameStatus(text) {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      // Handle renames: R100\told\tnew and copies: C100\told\tnew
      const match = line.match(/^([AMDRC]\d*)\t([^\t]+)(?:\t(.+))?$/);
      if (!match) return null;
      const statusLetter = match[1][0];
      const statusMap = {
        A: 'added',
        M: 'modified',
        D: 'deleted',
        R: 'renamed',
        C: 'copied',
      };
      const result = {
        status: statusMap[statusLetter] || statusLetter,
        statusLetter,
        path: match[3] || match[2],
      };
      if (match[3]) {
        result.oldPath = match[2];
      }
      return result;
    })
    .filter(Boolean);
}

function parseNumstat(text) {
  const stats = {};
  text
    .trim()
    .split('\n')
    .filter(Boolean)
    .forEach(line => {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const added = parts[0] === '-' ? 0 : parseInt(parts[0]) || 0;
        const deleted = parts[1] === '-' ? 0 : parseInt(parts[1]) || 0;
        // For renames, the path may be in "old => new" format or just the new path
        const filePath = parts.slice(2).join('\t');
        // Handle rename format: {old => new}/path or old/path => new/path
        const renameMatch = filePath.match(/\{(.+) => (.+)\}/);
        const key = renameMatch
          ? filePath.replace(/\{.+ => (.+)\}/, '$1')
          : filePath.includes(' => ')
            ? filePath.split(' => ').pop()
            : filePath;
        stats[key] = { added, deleted };
      }
    });
  return stats;
}

function parseDiff(diffText) {
  const patches = [];
  const lines = diffText.split('\n');
  let current = null;
  let hunk = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git')) {
      if (current) patches.push(current);
      const fileMatch = line.match(/diff --git a\/(.+) b\/(.+)/);
      current = {
        oldFile: fileMatch ? fileMatch[1] : '',
        newFile: fileMatch ? fileMatch[2] : '',
        hunks: [],
        isBinary: false,
      };
      hunk = null;
    } else if (line.startsWith('Binary files')) {
      if (current) current.isBinary = true;
    } else if (line.startsWith('@@')) {
      const hunkMatch = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/
      );
      if (hunkMatch && current) {
        hunk = {
          header: line,
          oldStart: parseInt(hunkMatch[1]),
          oldLines: parseInt(hunkMatch[2] || '1'),
          newStart: parseInt(hunkMatch[3]),
          newLines: parseInt(hunkMatch[4] || '1'),
          context: hunkMatch[5] || '',
          lines: [],
        };
        current.hunks.push(hunk);
      }
    } else if (hunk) {
      if (
        line.startsWith('+') ||
        line.startsWith('-') ||
        line.startsWith(' ')
      ) {
        hunk.lines.push(line);
      } else if (line === '\\ No newline at end of file') {
        hunk.lines.push(line);
      }
    }
  }

  if (current) patches.push(current);
  return patches;
}

app.listen(PORT, () => {
  console.log(`Git Differ running at http://localhost:${PORT}`);
});
