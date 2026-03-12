import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import {
	loginWithCredentials,
	loginWithToken,
	loginWithPAT,
	logout,
	hasStoredCredentials,
} from '../api/auth';
import { isConfigured } from '../util/config';
import { detectCachedToken } from '../util/plasticDetector';

/**
 * Register authentication commands: login, logout.
 */
export function registerAuthCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.login, async () => {
			await performLogin();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.logout, async () => {
			await logout();
			vscode.window.showInformationMessage('Signed out of Plastic SCM.');
		}),
	);
}

async function performLogin(): Promise<void> {
	if (!isConfigured()) {
		const action = await vscode.window.showErrorMessage(
			'Plastic SCM server URL and organization name must be configured first.',
			'Open Settings',
		);
		if (action === 'Open Settings') {
			vscode.commands.executeCommand('workbench.action.openSettings', 'plasticScm');
		}
		return;
	}

	// Build login options — show Unity SSO first if a cached token is available
	const options: Array<{ label: string; description: string; value: string }> = [];

	const cachedToken = detectCachedToken();
	if (cachedToken) {
		options.push({
			label: '$(key) Unity SSO (Auto-detect)',
			description: `Sign in as ${cachedToken.user} using cached desktop client token`,
			value: 'unity-sso',
		});
	}

	options.push(
		{ label: 'Username & Password', description: 'Sign in with your Plastic SCM credentials', value: 'credentials' },
		{ label: 'Personal Access Token', description: 'Use a PAT for authentication', value: 'pat' },
		{ label: 'SSO Token', description: 'Sign in with an SSO/auth token manually', value: 'token' },
	);

	const method = await vscode.window.showQuickPick(options, {
		placeHolder: 'Choose authentication method',
	});

	if (!method) return;

	let success = false;

	switch (method.value) {
		case 'unity-sso': {
			if (!cachedToken) return;
			success = await loginWithToken(cachedToken.user, cachedToken.token);
			break;
		}
		case 'credentials': {
			const username = await vscode.window.showInputBox({
				prompt: 'Username',
				placeHolder: 'Enter your username',
			});
			if (!username) return;

			const password = await vscode.window.showInputBox({
				prompt: 'Password',
				placeHolder: 'Enter your password',
				password: true,
			});
			if (!password) return;

			success = await loginWithCredentials(username, password);
			break;
		}
		case 'pat': {
			const pat = await vscode.window.showInputBox({
				prompt: 'Personal Access Token',
				placeHolder: 'Paste your PAT here',
				password: true,
			});
			if (!pat) return;

			success = await loginWithPAT(pat);
			break;
		}
		case 'token': {
			const email = await vscode.window.showInputBox({
				prompt: 'Email',
				placeHolder: 'Enter your email',
			});
			if (!email) return;

			const authToken = await vscode.window.showInputBox({
				prompt: 'Auth Token',
				placeHolder: 'Enter your auth token',
				password: true,
			});
			if (!authToken) return;

			success = await loginWithToken(email, authToken);
			break;
		}
	}

	if (success) {
		vscode.window.showInformationMessage('Successfully signed in to Plastic SCM.');
	} else {
		vscode.window.showErrorMessage('Sign in failed. Check your credentials and try again.');
	}
}
