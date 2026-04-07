/**
 * Static client-side JavaScript for the history graph webview panel.
 *
 * This code runs INSIDE the webview, not in the extension host. It's stored
 * as a string and injected into the panel's <script> block at render time.
 * The two dynamic values (DECO lookup and searchPattern) are declared inline
 * by historyGraphPanel.getHtml() immediately before this body is inserted,
 * so the functions here can reference them as top-level `const`s.
 *
 * Do not TypeScript-ify this — it's intentionally a string so the webview
 * receives it verbatim. Syntax errors will surface at runtime as DevTools
 * console errors in the webview, not at extension build time.
 */

export const historyGraphClientJs = `
function showLoading() {
	document.getElementById('progressBar').classList.add('active');
}
document.getElementById('refreshBtn').addEventListener('click', () => {
	showLoading();
	vscode.postMessage({ command: 'refresh' });
});
document.getElementById('focusBtn').addEventListener('click', () => {
	showLoading();
	vscode.postMessage({ command: 'focusCurrentBranch' });
});
document.getElementById('allBtn').addEventListener('click', () => {
	showLoading();
	vscode.postMessage({ command: 'filterBranch', branch: '' });
});

// ── File-scoped history filter ──────────────────────────────────
// Enter in the search input runs a filter. Empty string clears it.
// The pin button toggles follow-active-editor; its state is persisted
// in workspace config (bpscm.graph.followActiveFile).
const searchInput = document.getElementById('searchInput');
if (searchInput) {
	searchInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			const q = searchInput.value.trim();
			showLoading();
			if (q.length === 0) {
				vscode.postMessage({ command: 'clearSearch' });
			} else {
				vscode.postMessage({ command: 'search', query: q });
			}
		} else if (e.key === 'Escape') {
			searchInput.value = '';
			showLoading();
			vscode.postMessage({ command: 'clearSearch' });
		}
	});
}
const pinBtn = document.getElementById('pinBtn');
if (pinBtn) {
	pinBtn.addEventListener('click', () => {
		vscode.postMessage({ command: 'toggleFollow' });
	});
}
const clearFilterBtn = document.getElementById('clearFilterBtn');
if (clearFilterBtn) {
	clearFilterBtn.addEventListener('click', () => {
		showLoading();
		vscode.postMessage({ command: 'clearSearch' });
	});
}

// Cross-hover: row ↔ dot
const allRowsList = document.querySelectorAll('.row');
const allDots = document.querySelectorAll('.graph-svg circle');
allDots.forEach(dot => { dot.dataset.origR = dot.getAttribute('r') || '4'; });
allRowsList.forEach((row, idx) => {
	row.addEventListener('mouseenter', () => {
		if (idx < allDots.length) { allDots[idx].classList.add('hovered'); allDots[idx].setAttribute('r', '7'); }
	});
	row.addEventListener('mouseleave', () => {
		if (idx < allDots.length && !allDots[idx].classList.contains('selected-dot')) {
			allDots[idx].classList.remove('hovered');
			allDots[idx].setAttribute('r', allDots[idx].dataset.origR || '4');
		}
	});
});
allDots.forEach((dot, idx) => {
	dot.addEventListener('mouseenter', () => {
		if (idx < allRowsList.length) allRowsList[idx].classList.add('hovered');
	});
	dot.addEventListener('mouseleave', () => {
		if (idx < allRowsList.length) allRowsList[idx].classList.remove('hovered');
	});
});

// Click on commit row → request changeset files
document.querySelectorAll('.row').forEach(row => {
	row.addEventListener('click', () => {
		if (selectedRow) {
			selectedRow.classList.remove('selected');
			const prevInfo = selectedRow.querySelector('.info-col');
			if (prevInfo) { prevInfo.style.background = ''; prevInfo.style.borderLeft = ''; }
			// Reset previous SVG dot
			const prevDot = document.querySelector('.graph-svg circle.selected-dot');
			if (prevDot) { prevDot.classList.remove('selected-dot'); prevDot.setAttribute('r', prevDot.dataset.origR || '4'); }
		}
		row.classList.add('selected');
		const infoCol = row.querySelector('.info-col');
		if (infoCol) { infoCol.style.background = 'rgba(0, 120, 212, 0.3)'; infoCol.style.borderLeft = '3px solid #007fd4'; }
		// Highlight the SVG dot for this row
		const rowIdx = Array.from(document.querySelectorAll('.row')).indexOf(row);
		const dots = document.querySelectorAll('.graph-svg circle');
		if (rowIdx >= 0 && rowIdx < dots.length) {
			const dot = dots[rowIdx];
			dot.dataset.origR = dot.getAttribute('r') || '4';
			dot.classList.add('selected-dot');
			dot.setAttribute('r', '7');
		}
		selectedRow = row;
		const csId = parseInt(row.dataset.cs);
		const parentId = parseInt(row.dataset.parent);
		document.getElementById('filePanel').style.display = '';
		document.getElementById('filePanelTitle').textContent = 'Loading changeset #' + csId + '...';
		document.getElementById('fileList').innerHTML = '<div class="loading">Loading...</div>';
		vscode.postMessage({ command: 'selectChangeset', changesetId: csId, parentId: parentId });
	});
});

// Click on SVG dot → trigger corresponding row click
const allRows = document.querySelectorAll('.row');
document.querySelectorAll('.graph-svg circle').forEach((dot, idx) => {
	dot.addEventListener('click', () => {
		if (idx < allRows.length) allRows[idx].click();
	});
});

// Receive messages from extension
window.addEventListener('message', event => {
	const msg = event.data;
	if (msg.command === 'loading') {
		const bar = document.getElementById('progressBar');
		if (msg.active) { bar.classList.add('active'); } else { bar.classList.remove('active'); }
		return;
	}
	if (msg.command === 'changesetFiles') {
		lastFilesPayload = msg;
		renderFileList();
	}
});

// Mirror of the shared shouldOpenDiff rule — folders never open a diff view.
function shouldOpenDiff(f) { return !isFolderEntry(f); }
function isFolderEntry(f) { return !!f.isDirectory; }

function renderFileList() {
	if (!lastFilesPayload) return;
	const msg = lastFilesPayload;
	const panel = document.getElementById('filePanel');
	const list = document.getElementById('fileList');
	const title = document.getElementById('filePanelTitle');
	panel.style.display = '';

	if (msg.error) {
		title.textContent = 'Changeset #' + msg.changesetId + ' (error)';
		list.innerHTML = '<div class="empty">' + escHtml(msg.error) + '</div>';
		return;
	}

	const allFiles = msg.files || [];
	let files = showFolders ? allFiles : allFiles.filter(f => !isFolderEntry(f));
	if (searchPatternLc.length > 0) {
		// Float matches to the top so the reason this changeset showed up is obvious.
		files = files.slice().sort((a, b) => {
			const am = a.path.toLowerCase().indexOf(searchPatternLc) !== -1 ? 0 : 1;
			const bm = b.path.toLowerCase().indexOf(searchPatternLc) !== -1 ? 0 : 1;
			return am - bm;
		});
	}
	const folderCount = allFiles.length - allFiles.filter(f => !isFolderEntry(f)).length;
	const suffix = folderCount > 0 && !showFolders ? ' (' + folderCount + ' folder(s) hidden)' : '';
	title.textContent = 'Changeset #' + msg.changesetId + ' — ' + files.length + ' file(s)' + suffix;

	if (files.length === 0) {
		list.innerHTML = '<div class="empty">No files found</div>';
		return;
	}

	list.innerHTML = files.map(f => {
		const key = f.type + (isFolderEntry(f) ? ':folder' : '');
		const deco = DECO[key] || DECO[f.type] || { letter: '?', tooltip: f.type, strikeThrough: false, colorId: 'foreground' };
		const shortPath = f.path.split('/').slice(-2).join('/');
		const isDir = isFolderEntry(f);
		const isMatch = searchPatternLc.length > 0 && f.path.toLowerCase().indexOf(searchPatternLc) !== -1;
		const classes = 'list-item file-item' + (isDir ? ' is-folder' : '') + (isMatch ? ' search-match' : '');
		const strike = deco.strikeThrough ? 'text-decoration:line-through;' : '';
		// Color the change-type letter using the shared VS Code theme color var.
		// The native SCM panel uses a ThemeIcon with the same color id — same
		// visual semantics, different container.
		const colorVar = 'var(--vscode-' + deco.colorId.replace(/\\./g, '-') + ')';
		const letterHtml = '<span class="entry-letter" style="color:' + colorVar + '">' + escHtml(deco.letter) + '</span>';
		const folderGlyph = isDir ? '<span class="folder-glyph">📁</span>' : '';
		return '<div class="' + classes + '" data-path="' + escHtml(f.path) + '" data-cs="' + msg.changesetId + '" data-parent="' + msg.parentId + '" data-folder="' + (isDir ? '1' : '0') + '" title="' + escHtml(deco.tooltip + ' — ' + f.path) + '">' +
			letterHtml +
			folderGlyph +
			'<span class="file-path truncate" style="' + strike + 'color:' + colorVar + '">' + escHtml(shortPath) + '</span>' +
			'</div>';
	}).join('');

	// Click file → open diff (folders are skipped via shouldOpenDiff — unified rule).
	let selectedFile = null;
	list.querySelectorAll('.file-item').forEach(item => {
		const isDir = item.dataset.folder === '1';
		if (isDir) return; // shouldOpenDiff === false
		item.addEventListener('click', () => {
			if (selectedFile) selectedFile.classList.remove('selected');
			item.classList.add('selected');
			selectedFile = item;
			vscode.postMessage({
				command: 'openDiff',
				changesetId: parseInt(item.dataset.cs),
				parentId: parseInt(item.dataset.parent),
				path: item.dataset.path,
			});
		});
	});
}

// Folder-visibility toggle — lets the user hide directory entries from the
// historic changeset list. State is re-applied to the last-loaded changeset
// so the user can toggle without reclicking the row.
document.getElementById('toggleFoldersBtn').addEventListener('click', () => {
	showFolders = !showFolders;
	const btn = document.getElementById('toggleFoldersBtn');
	btn.classList.toggle('active', showFolders);
	btn.title = showFolders ? 'Hide folder entries' : 'Show folder entries';
	renderFileList();
});

function escHtml(s) {
	return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
`;
