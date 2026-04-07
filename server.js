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
    const { repo, branch, page = 0, limit = 50 } = req.query;
    const git = getGit(repo);
    const skip = parseInt(page) * parseInt(limit);
    const log = await git.log({
      [branch]: null,
      '--max-count': parseInt(limit),
      '--skip': skip,
    });
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

    // Get the diff against parent
    const diffText = await git.diff([`${hash}~1`, hash, '--unified=5']);

    // Get changed files summary
    const diffStat = await git.diff([`${hash}~1`, hash, '--stat']);

    // Get list of changed files with status
    const nameStatus = await git.diff([`${hash}~1`, hash, '--name-status']);

    const files = parseNameStatus(nameStatus);
    const patches = parseDiff(diffText);

    res.json({ files, patches, stat: diffStat });
  } catch (err) {
    // Handle first commit (no parent)
    try {
      const { repo, hash } = req.query;
      const git = getGit(repo);
      const diffText = await git.diff([
        '--root',
        hash,
        '--unified=5',
        '--',
      ]);
      // For first commit, use show instead
      const showDiff = await git.show([hash, '--unified=5', '--format=']);
      const nameStatus = await git.show([hash, '--name-status', '--format=']);
      const files = parseNameStatus(nameStatus);
      const patches = parseDiff(showDiff);
      res.json({ files, patches, stat: '' });
    } catch (innerErr) {
      res.status(500).json({ error: innerErr.message });
    }
  }
});

function parseNameStatus(text) {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^([AMDRC])\t(.+)$/);
      if (!match) return null;
      const statusMap = {
        A: 'added',
        M: 'modified',
        D: 'deleted',
        R: 'renamed',
        C: 'copied',
      };
      return {
        status: statusMap[match[1]] || match[1],
        statusLetter: match[1],
        path: match[2],
      };
    })
    .filter(Boolean);
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
