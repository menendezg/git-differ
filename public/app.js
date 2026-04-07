(function () {
  'use strict';

  // State
  let repoPath = '';
  let branches = [];
  let currentBranch = '';
  let commits = [];
  let selectedCommit = null;
  let focusedCommitIndex = -1;
  let diffData = null;
  let activeFileIndex = 0;
  let searchDebounceTimer = null;
  let cmdkResults = [];
  let cmdkFocusIndex = 0;

  // DOM elements
  const $ = (sel) => document.querySelector(sel);
  const repoInput = $('#repo-path');
  const openBtn = $('#open-btn');
  const repoError = $('#repo-error');
  const mainEl = $('#main');
  const branchBtn = $('#branch-btn');
  const branchMenu = $('#branch-menu');
  const branchSearch = $('#branch-search');
  const branchList = $('#branch-list');
  const currentBranchEl = $('#current-branch');
  const commitList = $('#commit-list');
  const commitSearch = $('#commit-search');
  const commitCount = $('#commit-count');
  const diffPlaceholder = $('#diff-placeholder');
  const diffContent = $('#diff-content');
  const commitHeader = $('#commit-header');
  const fileTabs = $('#file-tabs');
  const diffViewer = $('#diff-viewer');
  const cmdkOverlay = $('#cmdk-overlay');
  const cmdkInput = $('#cmdk-input');
  const cmdkResultsEl = $('#cmdk-results');
  const cmdkHint = $('#cmdk-hint');

  // API helper
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // =============================================
  // THEME SYSTEM
  // =============================================
  const savedTheme = localStorage.getItem('gitdiffer-theme') || 'lazy-midnight';
  document.documentElement.setAttribute('data-theme', savedTheme);
  document.querySelectorAll('.theme-pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.theme === savedTheme);
    pill.addEventListener('click', () => {
      const theme = pill.dataset.theme;
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('gitdiffer-theme', theme);
      document.querySelectorAll('.theme-pill').forEach((p) =>
        p.classList.toggle('active', p.dataset.theme === theme)
      );
    });
  });

  // =============================================
  // CMD+K DIALOG
  // =============================================
  function openCmdK() {
    if (!repoPath) return;
    cmdkOverlay.classList.remove('hidden');
    cmdkInput.value = '';
    cmdkResults = commits.slice(0, 20);
    cmdkFocusIndex = 0;
    renderCmdkResults();
    cmdkInput.focus();
  }

  function closeCmdK() {
    cmdkOverlay.classList.add('hidden');
    cmdkInput.value = '';
  }

  cmdkHint.addEventListener('click', openCmdK);

  cmdkOverlay.addEventListener('click', (e) => {
    if (e.target === cmdkOverlay) closeCmdK();
  });

  let cmdkDebounce = null;
  cmdkInput.addEventListener('input', () => {
    clearTimeout(cmdkDebounce);
    cmdkDebounce = setTimeout(async () => {
      const query = cmdkInput.value.trim();
      if (!query) {
        cmdkResults = commits.slice(0, 20);
        cmdkFocusIndex = 0;
        renderCmdkResults();
        return;
      }
      try {
        const data = await api(
          `/api/commits?repo=${enc(repoPath)}&branch=${enc(currentBranch)}&search=${enc(query)}&limit=20`
        );
        cmdkResults = data.commits;
        cmdkFocusIndex = 0;
        renderCmdkResults();
      } catch {
        cmdkResults = [];
        renderCmdkResults();
      }
    }, 200);
  });

  cmdkInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdkFocusIndex = Math.min(cmdkFocusIndex + 1, cmdkResults.length - 1);
      renderCmdkResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdkFocusIndex = Math.max(cmdkFocusIndex - 1, 0);
      renderCmdkResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (cmdkResults[cmdkFocusIndex]) {
        selectCmdkResult(cmdkResults[cmdkFocusIndex]);
      }
    } else if (e.key === 'Escape') {
      closeCmdK();
    }
  });

  function selectCmdkResult(commit) {
    closeCmdK();
    selectedCommit = commit.hash;
    // Check if commit is in current list
    const idx = commits.findIndex((c) => c.hash === commit.hash);
    if (idx >= 0) {
      focusedCommitIndex = idx;
      renderCommits();
    } else {
      // Add to list temporarily so loadDiff can find it
      commits.unshift(commit);
      focusedCommitIndex = 0;
      renderCommits();
    }
    loadDiff(commit.hash);
  }

  function renderCmdkResults() {
    if (cmdkResults.length === 0) {
      cmdkResultsEl.innerHTML =
        '<div class="cmdk-empty">No commits found</div>';
      return;
    }
    cmdkResultsEl.innerHTML = cmdkResults
      .map(
        (c, i) => `
        <div class="cmdk-result ${i === cmdkFocusIndex ? 'focused' : ''}" data-index="${i}">
          <span class="cmdk-result-hash">${c.abbrevHash}</span>
          <div class="cmdk-result-body">
            <div class="cmdk-result-msg">${esc(c.message)}</div>
            <div class="cmdk-result-meta"><span class="author">${esc(c.author)}</span> &middot; ${formatDate(c.date)}</div>
          </div>
        </div>
      `
      )
      .join('');

    cmdkResultsEl.querySelectorAll('.cmdk-result').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index);
        if (cmdkResults[idx]) selectCmdkResult(cmdkResults[idx]);
      });
    });

    const focused = cmdkResultsEl.querySelector('.cmdk-result.focused');
    if (focused) focused.scrollIntoView({ block: 'nearest' });
  }

  // =============================================
  // REPO
  // =============================================
  openBtn.addEventListener('click', openRepo);
  repoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openRepo();
  });

  async function openRepo() {
    const path = repoInput.value.trim();
    if (!path) return;
    repoError.classList.add('hidden');

    try {
      openBtn.textContent = '...';
      openBtn.disabled = true;
      const result = await api('/api/repo', {
        method: 'POST',
        body: JSON.stringify({ repoPath: path }),
      });
      repoPath = result.root;
      repoInput.value = repoPath;
      localStorage.setItem('gitdiffer-last-repo', repoPath);
      mainEl.classList.remove('hidden');
      await loadBranches();
    } catch (err) {
      repoError.textContent = err.message;
      repoError.classList.remove('hidden');
    } finally {
      openBtn.textContent = 'Open';
      openBtn.disabled = false;
    }
  }

  // Restore last repo on load
  const lastRepo = localStorage.getItem('gitdiffer-last-repo');
  if (lastRepo) {
    repoInput.value = lastRepo;
    openRepo();
  }

  // =============================================
  // BRANCHES
  // =============================================
  async function loadBranches() {
    const data = await api(`/api/branches?repo=${enc(repoPath)}`);
    branches = data.branches.filter(
      (b) => !b.name.startsWith('remotes/origin/HEAD')
    );
    currentBranch = data.current;
    currentBranchEl.textContent = currentBranch;
    renderBranches();
    await loadCommits(currentBranch);
  }

  function renderBranches(filter = '') {
    const filtered = branches.filter((b) =>
      b.name.toLowerCase().includes(filter.toLowerCase())
    );

    const local = filtered.filter((b) => !b.name.startsWith('remotes/'));
    const remote = filtered.filter((b) => b.name.startsWith('remotes/'));

    let html = '';

    if (local.length > 0) {
      html += '<div class="branch-group-label">Local</div>';
      html += local
        .map(
          (b) =>
            `<div class="branch-item ${b.name === currentBranch ? 'active' : ''}" data-branch="${esc(b.name)}">${esc(b.name)}</div>`
        )
        .join('');
    }

    if (remote.length > 0) {
      html += '<div class="branch-group-label">Remote</div>';
      html += remote
        .map(
          (b) =>
            `<div class="branch-item remote ${b.name === currentBranch ? 'active' : ''}" data-branch="${esc(b.name)}"><span class="remote-tag">origin</span>${esc(b.name.replace(/^remotes\/origin\//, ''))}</div>`
        )
        .join('');
    }

    branchList.innerHTML = html;

    branchList.querySelectorAll('.branch-item').forEach((el) => {
      el.addEventListener('click', () => {
        const name = el.dataset.branch;
        currentBranch = name;
        currentBranchEl.textContent = name;
        branchMenu.classList.add('hidden');
        branchSearch.value = '';
        renderBranches();
        loadCommits(name);
      });
    });
  }

  branchBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    branchMenu.classList.toggle('hidden');
    if (!branchMenu.classList.contains('hidden')) {
      branchSearch.focus();
    }
  });

  branchSearch.addEventListener('input', () => {
    renderBranches(branchSearch.value);
  });

  branchSearch.addEventListener('click', (e) => e.stopPropagation());
  branchMenu.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', () => {
    branchMenu.classList.add('hidden');
  });

  // =============================================
  // COMMIT SEARCH
  // =============================================
  commitSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      loadCommits(currentBranch);
    }, 300);
  });

  // =============================================
  // COMMITS
  // =============================================
  async function loadCommits(branch) {
    commitList.innerHTML =
      '<div class="loading-spinner"><div class="spinner"></div>Loading commits...</div>';
    selectedCommit = null;
    focusedCommitIndex = -1;
    diffPlaceholder.classList.remove('hidden');
    diffContent.classList.add('hidden');

    try {
      const search = commitSearch.value.trim();
      let url = `/api/commits?repo=${enc(repoPath)}&branch=${enc(branch)}`;
      if (search) url += `&search=${enc(search)}`;

      const data = await api(url);
      commits = data.commits;
      commitCount.textContent = commits.length > 0 ? commits.length : '';
      renderCommits();
    } catch (err) {
      commitList.innerHTML = `<div class="loading-spinner" style="color:var(--red)">${esc(err.message)}</div>`;
    }
  }

  function renderCommits() {
    commitList.innerHTML = commits
      .map(
        (c, i) => `
      <div class="commit-item ${selectedCommit === c.hash ? 'active' : ''} ${focusedCommitIndex === i ? 'focused' : ''}" data-hash="${c.hash}" data-index="${i}">
        <div class="commit-msg" title="${esc(c.message)}">${esc(c.message)}</div>
        <div class="commit-meta">
          <span class="commit-hash">${c.abbrevHash}</span>
          <span class="commit-author">${esc(c.author)}</span>
          <span class="commit-date">${formatDate(c.date)}</span>
        </div>
      </div>
    `
      )
      .join('');

    commitList.querySelectorAll('.commit-item').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index);
        focusedCommitIndex = idx;
        selectedCommit = el.dataset.hash;
        renderCommits();
        loadDiff(selectedCommit);
      });
    });
  }

  // =============================================
  // KEYBOARD NAVIGATION
  // =============================================
  document.addEventListener('keydown', (e) => {
    // Cmd+K / Ctrl+K — open search dialog
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (cmdkOverlay.classList.contains('hidden')) {
        openCmdK();
      } else {
        closeCmdK();
      }
      return;
    }

    // If cmd+k dialog is open, don't handle other shortcuts
    if (!cmdkOverlay.classList.contains('hidden')) return;

    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') {
        document.activeElement.blur();
        branchMenu.classList.add('hidden');
      }
      return;
    }

    if (commits.length === 0) return;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusedCommitIndex = Math.min(
        focusedCommitIndex + 1,
        commits.length - 1
      );
      updateFocus();
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusedCommitIndex = Math.max(focusedCommitIndex - 1, 0);
      updateFocus();
    } else if (e.key === 'Enter') {
      if (focusedCommitIndex >= 0 && focusedCommitIndex < commits.length) {
        selectedCommit = commits[focusedCommitIndex].hash;
        renderCommits();
        loadDiff(selectedCommit);
      }
    } else if (e.key === 'Escape') {
      branchMenu.classList.add('hidden');
    }
  });

  function updateFocus() {
    commitList.querySelectorAll('.commit-item').forEach((el) => {
      el.classList.toggle(
        'focused',
        parseInt(el.dataset.index) === focusedCommitIndex
      );
    });
    const focused = commitList.querySelector('.commit-item.focused');
    if (focused) focused.scrollIntoView({ block: 'nearest' });
  }

  // =============================================
  // DIFF
  // =============================================
  async function loadDiff(hash) {
    diffPlaceholder.classList.add('hidden');
    diffContent.classList.remove('hidden');
    diffViewer.innerHTML =
      '<div class="loading-spinner"><div class="spinner"></div>Loading diff...</div>';
    commitHeader.innerHTML = '';
    fileTabs.innerHTML = '';

    try {
      const commit = commits.find((c) => c.hash === hash);
      diffData = await api(
        `/api/diff?repo=${enc(repoPath)}&hash=${enc(hash)}`
      );
      activeFileIndex = 0;

      let totalAdded = 0;
      let totalDeleted = 0;
      if (diffData.numstat) {
        Object.values(diffData.numstat).forEach((s) => {
          totalAdded += s.added;
          totalDeleted += s.deleted;
        });
      }

      commitHeader.innerHTML = `
        <div class="header-message">${esc(commit.message)}</div>
        <div class="header-meta">
          <span class="hash">${commit.abbrevHash}</span>
          <span class="author">${esc(commit.author)}</span>
          <span>${formatDate(commit.date)}</span>
          <span>${diffData.files.length} file${diffData.files.length !== 1 ? 's' : ''} changed</span>
          ${totalAdded > 0 ? `<span class="stat-add">+${totalAdded}</span>` : ''}
          ${totalDeleted > 0 ? `<span class="stat-del">-${totalDeleted}</span>` : ''}
        </div>
      `;

      renderFileTabs();
      renderDiffForFile(0);
    } catch (err) {
      diffViewer.innerHTML = `<div class="loading-spinner" style="color:var(--red)">${esc(err.message)}</div>`;
    }
  }

  function renderFileTabs() {
    const files = diffData.files;
    const numstat = diffData.numstat || {};

    fileTabs.innerHTML = files
      .map((f, i) => {
        const name = f.path.split('/').pop();
        const dir = f.path.includes('/')
          ? f.path.substring(0, f.path.lastIndexOf('/') + 1)
          : '';
        const stats = numstat[f.path] || {};
        const statsHtml =
          stats.added != null || stats.deleted != null
            ? `<span class="file-stats"><span class="stat-add">+${stats.added || 0}</span> <span class="stat-del">-${stats.deleted || 0}</span></span>`
            : '';
        const renameHtml = f.oldPath
          ? `<span class="rename-from" title="${esc(f.oldPath)}">${esc(f.oldPath.split('/').pop())} &rarr; </span>`
          : '';
        return `
        <div class="file-tab ${i === activeFileIndex ? 'active' : ''}" data-index="${i}">
          <span class="file-status ${f.status}">${f.statusLetter}</span>
          <span style="color:var(--text-muted);font-size:11px">${esc(dir)}</span>${renameHtml}${esc(name)}
          ${statsHtml}
        </div>
      `;
      })
      .join('');

    fileTabs.querySelectorAll('.file-tab').forEach((el) => {
      el.addEventListener('click', () => {
        activeFileIndex = parseInt(el.dataset.index);
        fileTabs
          .querySelectorAll('.file-tab')
          .forEach((t) => t.classList.remove('active'));
        el.classList.add('active');
        renderDiffForFile(activeFileIndex);
      });
    });
  }

  function renderDiffForFile(index) {
    const file = diffData.files[index];
    if (!file) {
      diffViewer.innerHTML =
        '<div class="placeholder"><p>No file selected</p></div>';
      return;
    }

    const patch = diffData.patches.find(
      (p) =>
        p.newFile === file.path ||
        p.oldFile === file.path ||
        (file.oldPath && p.oldFile === file.oldPath)
    );

    if (!patch) {
      diffViewer.innerHTML = `<div class="diff-file"><div class="diff-binary">No diff available for this file</div></div>`;
      return;
    }

    if (patch.isBinary) {
      diffViewer.innerHTML = `<div class="diff-file"><div class="diff-binary">Binary file changed</div></div>`;
      return;
    }

    let html = '<div class="diff-file">';

    patch.hunks.forEach((hunk) => {
      html += `<div class="hunk-header">${esc(hunk.header.replace(hunk.context, ''))}<span class="fn-name">${esc(hunk.context)}</span></div>`;
      html += '<table class="diff-table"><tbody>';

      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;

      hunk.lines.forEach((line) => {
        if (line === '\\ No newline at end of file') {
          html += `<tr class="line-noeof"><td colspan="5">\\ No newline at end of file</td></tr>`;
          return;
        }

        const type = line[0];
        const content = line.substring(1);

        if (type === '+') {
          html += `<tr class="line-add">
            <td class="line-num"></td>
            <td class="line-num">${newLine}</td>
            <td class="line-sign">+</td>
            <td class="line-content">${esc(content)}</td>
          </tr>`;
          newLine++;
        } else if (type === '-') {
          html += `<tr class="line-del">
            <td class="line-num">${oldLine}</td>
            <td class="line-num"></td>
            <td class="line-sign">-</td>
            <td class="line-content">${esc(content)}</td>
          </tr>`;
          oldLine++;
        } else {
          html += `<tr class="line-ctx">
            <td class="line-num">${oldLine}</td>
            <td class="line-num">${newLine}</td>
            <td class="line-sign"></td>
            <td class="line-content">${esc(content)}</td>
          </tr>`;
          oldLine++;
          newLine++;
        }
      });

      html += '</tbody></table>';
    });

    html += '</div>';
    diffViewer.innerHTML = html;
    diffViewer.scrollTop = 0;
  }

  // =============================================
  // UTILITIES
  // =============================================
  function enc(s) {
    return encodeURIComponent(s);
  }

  function esc(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    });
  }
})();
