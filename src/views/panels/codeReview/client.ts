/**
 * Static client-side JS for the code review webview panel.
 *
 * Runs inside the webview. Injected as a string into the panel's <script>
 * block at render time. Assumes `vscode` has been acquired via
 * `acquireVsCodeApi()` immediately before this body is inserted.
 */

export const codeReviewClientJs = `
document.getElementById('statusBtn').addEventListener('click', () => {
	const status = document.getElementById('statusSelect').value;
	vscode.postMessage({ type: 'changeStatus', status });
});

document.getElementById('submitCommentBtn').addEventListener('click', () => {
	const input = document.getElementById('commentInput');
	const text = input.value.trim();
	if (!text) return;
	vscode.postMessage({ type: 'addComment', text });
	input.value = '';
});

document.getElementById('addReviewerBtn').addEventListener('click', () => {
	const input = document.getElementById('newReviewerInput');
	const reviewer = input.value.trim();
	if (!reviewer) return;
	vscode.postMessage({ type: 'addReviewer', reviewer });
	input.value = '';
});

document.querySelectorAll('.reviewer-status-select').forEach(sel => {
	sel.addEventListener('change', (e) => {
		const reviewer = e.target.dataset.reviewer;
		vscode.postMessage({ type: 'changeReviewerStatus', reviewer, status: e.target.value });
	});
});

document.querySelectorAll('.remove-reviewer-btn').forEach(btn => {
	btn.addEventListener('click', (e) => {
		const reviewer = e.target.dataset.reviewer;
		vscode.postMessage({ type: 'removeReviewer', reviewer });
	});
});

document.querySelectorAll('.reply-btn').forEach(btn => {
	btn.addEventListener('click', (e) => {
		const parentId = parseInt(e.target.dataset.commentId);
		const text = prompt('Reply:');
		if (text) {
			vscode.postMessage({ type: 'addComment', text, parentId });
		}
	});
});
`;
