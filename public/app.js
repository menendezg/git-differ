(function () {
  'use strict';

  // State
  let repoPath = '';
  let branches = [];
  let currentBranch = '';
  let commits = [];
  let selectedCommit = null;
  let diffData = null;
  let activeFileIndex = 0;

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
  const diffPlaceholder = $('#diff-placeholder');
  const diffContent = $('#diff-content');
  const commitHeader = $('#commit-header');
  const fileTabs = $('#file-tabs');
  const diffViewer = $('#diff-viewer');

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

  // Open repo
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

  // Branches
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
    branchList.innerHTML = filtered
      .map(
        (b) =>
          `<div class="branch-item ${b.name === currentBranch ? 'active' : ''}" data-branch="${esc(b.name)}">${esc(b.name)}</div>`
      )
      .join('');

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

  // Branch dropdown toggle
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

  // Commits
  async function loadCommits(branch) {
    commitList.innerHTML =
      '<div class="loading-spinner"><div class="spinner"></div>Loading commits...</div>';
    selectedCommit = null;
    diffPlaceholder.classList.remove('hidden');
    diffContent.classList.add('hidden');

    try {
      const data = await api(
        `/api/commits?repo=${enc(repoPath)}&branch=${enc(branch)}`
      );
      commits = data.commits;
      renderCommits();
    } catch (err) {
      commitList.innerHTML = `<div class="loading-spinner" style="color:var(--red)">${esc(err.message)}</div>`;
    }
  }

  function renderCommits() {
    commitList.innerHTML = commits
      .map(
        (c) => `
      <div class="commit-item ${selectedCommit === c.hash ? 'active' : ''}" data-hash="${c.hash}">
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
        selectedCommit = el.dataset.hash;
        renderCommits();
        loadDiff(selectedCommit);
      });
    });
  }

  // Diff
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

      // Render commit header
      commitHeader.innerHTML = `
        <div class="header-message">${esc(commit.message)}</div>
        <div class="header-meta">
          <span class="hash">${commit.abbrevHash}</span>
          <span class="author">${esc(commit.author)}</span>
          <span>${formatDate(commit.date)}</span>
          <span>${diffData.files.length} file${diffData.files.length !== 1 ? 's' : ''} changed</span>
        </div>
      `;

      // Render file tabs
      renderFileTabs();
      renderDiffForFile(0);
    } catch (err) {
      diffViewer.innerHTML = `<div class="loading-spinner" style="color:var(--red)">${esc(err.message)}</div>`;
    }
  }

  function renderFileTabs() {
    const files = diffData.files;
    const patches = diffData.patches;

    fileTabs.innerHTML = files
      .map((f, i) => {
        const name = f.path.split('/').pop();
        const dir = f.path.includes('/')
          ? f.path.substring(0, f.path.lastIndexOf('/') + 1)
          : '';
        return `
        <div class="file-tab ${i === activeFileIndex ? 'active' : ''}" data-index="${i}">
          <span class="file-status ${f.status}">${f.statusLetter}</span>
          <span style="color:var(--text-muted);font-size:11px">${esc(dir)}</span>${esc(name)}
        </div>
      `;
      })
      .join('');

    // Also show any patches that don't map to a file in the status list
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

    // Find matching patch
    const patch = diffData.patches.find(
      (p) => p.newFile === file.path || p.oldFile === file.path
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

  // Utilities
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
