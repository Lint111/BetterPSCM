/**
 * Static CSS for the code review webview panel. Extracted from the inline
 * template in codeReviewPanel.buildHtml() so the panel file focuses on
 * extension-side wiring and HTML structure, not styling.
 */

export const codeReviewStyles = `
.review-header { padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
.review-title { font-size: 16px; font-weight: bold; margin-bottom: 4px; }
.review-meta { display: flex; gap: 16px; flex-wrap: wrap; font-size: var(--font-label); color: var(--vscode-descriptionForeground); }
.review-status { font-weight: bold; padding: 2px 8px; border-radius: 10px; font-size: var(--font-caption); }
.section { padding: 8px 16px; }
.section-title { font-weight: bold; font-size: var(--font-label); margin-bottom: 6px; color: var(--vscode-descriptionForeground); }
.reviewer-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.reviewer-name { flex: 1; }
.reviewer-status { font-size: var(--font-caption); }
.reviewer-status-select { font-size: var(--font-caption); }
.remove-reviewer-btn { background: none; border: none; color: var(--vscode-errorForeground); cursor: pointer; padding: 0 4px; }
.comment { padding: 8px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
.comment.question { border-left: 3px solid var(--color-changed); }
.comment-header { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.comment-author { font-weight: bold; font-size: var(--font-label); }
.comment-type { font-size: var(--font-caption); }
.comment-time { font-size: var(--font-caption); margin-left: auto; }
.comment-location { font-size: var(--font-caption); margin-bottom: 4px; }
.comment-body { white-space: pre-wrap; }
.reply-btn { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: var(--font-caption); padding: 4px 0; }
.new-comment { padding: 12px 16px; border-top: 1px solid var(--vscode-panel-border); }
.new-comment textarea { width: 100%; min-height: 60px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 6px; font-family: var(--vscode-font-family); font-size: var(--font-body); border-radius: 2px; }
.new-comment .actions { display: flex; gap: 6px; margin-top: 6px; }
.add-reviewer-row { display: flex; gap: 4px; margin-top: 6px; }
.add-reviewer-row input { flex: 1; }
`;
