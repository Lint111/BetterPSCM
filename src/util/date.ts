/** Format an ISO date string as a short date: "Mar 21, 2026" */
export function formatShortDate(iso: string): string {
	if (!iso) return '';
	try {
		const d = new Date(iso);
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	} catch {
		return iso;
	}
}

/** Format an ISO date string as date + time: "Mar 21, 2026 02:30 PM" */
export function formatDateTime(iso: string): string {
	if (!iso) return '';
	try {
		const d = new Date(iso);
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
			+ ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	} catch {
		return iso;
	}
}

/** Format an ISO date string as relative time: "2d ago", "14:30", "Mar 21" */
export function formatRelativeDate(dateStr: string): string {
	if (!dateStr) return '';
	try {
		const d = new Date(dateStr);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffDays = Math.floor(diffMs / 86400000);
		if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		if (diffDays < 7) return `${diffDays}d ago`;
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	} catch {
		return dateStr;
	}
}
