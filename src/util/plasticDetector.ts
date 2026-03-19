import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { log, logError } from './logger';

/**
 * Fallback cloud server URL if cloudregions.conf is not available.
 */
const FALLBACK_CLOUD_URL = 'https://prd-azure-eastus-01-cloud.plasticscm.com:7178';

const DEFAULT_LOCAL_URL = 'http://localhost:7178';

export interface PlasticWorkspaceInfo {
	/** Workspace name (e.g., "Divine Ambition-DAPrototype_2") */
	workspaceName: string;
	/** Workspace GUID */
	workspaceGuid: string;
	/** Organization name (from selector, e.g., "Divine Ambition") */
	organizationName: string;
	/** Repository name (from selector, e.g., "DAPrototype") */
	repositoryName: string;
	/** Current branch spec (e.g., "/main/Tech/Buff System") */
	currentBranch: string;
	/** Whether this is a cloud workspace */
	isCloud: boolean;
	/** Server URL (resolved from cloud ID or local) */
	serverUrl: string;
	/** Numeric cloud server ID (e.g., "20067454181069") */
	cloudServerId?: string;
	/** Display name from selector (e.g., "Divine Ambition") — before slug resolution */
	displayOrgName?: string;
}

export interface PlasticClientInfo {
	/** Working mode (e.g., "SSOWorkingMode") */
	workingMode: string;
	/** Security config / user email */
	userEmail: string;
}

export interface PlasticCachedToken {
	/** Server spec (e.g., "20067454181069@cloud") */
	server: string;
	/** User email */
	user: string;
	/** JWT token (with "TOKEN" prefix stripped) */
	token: string;
}

/**
 * Detect Plastic SCM workspace info from the .plastic folder in the given workspace root.
 */
export function detectWorkspace(workspaceRoot: string): PlasticWorkspaceInfo | undefined {
	const plasticDir = path.join(workspaceRoot, '.plastic');

	if (!fs.existsSync(plasticDir)) {
		log(`No .plastic folder found at ${workspaceRoot}`);
		return undefined;
	}

	try {
		// Read plastic.workspace: line 1 = name, line 2 = GUID, line 3 = type
		const workspaceFile = path.join(plasticDir, 'plastic.workspace');
		const workspaceLines = readLines(workspaceFile);
		if (workspaceLines.length < 2) {
			logError('plastic.workspace has unexpected format');
			return undefined;
		}
		const workspaceName = workspaceLines[0];
		const workspaceGuid = workspaceLines[1];

		// Read plastic.selector: repository "OrgName/RepoName@serverId@cloud"
		const selectorFile = path.join(plasticDir, 'plastic.selector');
		const selectorContent = readFileText(selectorFile);
		const selectorInfo = parseSelector(selectorContent);

		if (!selectorInfo) {
			logError('Could not parse plastic.selector');
			return undefined;
		}

		const isCloud = selectorInfo.serverSpec.endsWith('@cloud');
		let serverUrl = isCloud ? FALLBACK_CLOUD_URL : DEFAULT_LOCAL_URL;

		// For cloud workspaces, resolve the org slug from unityorgs.conf
		let organizationName = selectorInfo.orgName;
		let cloudServerId: string | undefined;
		const displayOrgName = selectorInfo.orgName;
		if (isCloud) {
			cloudServerId = selectorInfo.serverSpec.replace(/@cloud$/, '');
			const slug = resolveOrgSlug(cloudServerId);
			if (slug) {
				log(`  Resolved org slug: "${slug}" (from server ID ${cloudServerId})`);
				organizationName = slug;
			}
			// Resolve actual cloud region URL from cloudregions.conf
			const regionUrl = resolveCloudRegionUrl(slug ?? cloudServerId);
			if (regionUrl) {
				log(`  Resolved cloud region URL: ${regionUrl}`);
				serverUrl = regionUrl;
			}
		}

		return {
			workspaceName,
			workspaceGuid,
			organizationName,
			repositoryName: isCloud ? selectorInfo.fullRepoPath : selectorInfo.repoName,
			currentBranch: selectorInfo.branch,
			isCloud,
			serverUrl,
			cloudServerId,
			displayOrgName,
		};
	} catch (err) {
		logError('Failed to detect Plastic SCM workspace', err);
		return undefined;
	}
}

/**
 * Read Plastic SCM client config from the standard location.
 */
export function detectClientConfig(): PlasticClientInfo | undefined {
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) return undefined;

	const clientConf = path.join(localAppData, 'plastic4', 'client.conf');
	if (!fs.existsSync(clientConf)) return undefined;

	try {
		const content = readFileText(clientConf);

		const workingMode = extractXmlValue(content, 'WorkingMode') ?? '';
		const userEmail = extractXmlValue(content, 'SecurityConfig') ?? '';

		return { workingMode, userEmail };
	} catch (err) {
		logError('Failed to read Plastic SCM client config', err);
		return undefined;
	}
}

/**
 * Read cached SSO token from the Plastic SCM desktop client's tokens.conf.
 * The desktop client stores Unity SSO JWT tokens after the user signs in.
 *
 * Format: server=<spec> user=<email> token=TOKEN<jwt> seiddata=<email>
 */
export function detectCachedToken(serverSpec?: string): PlasticCachedToken | undefined {
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) return undefined;

	const tokensFile = path.join(localAppData, 'plastic4', 'tokens.conf');
	if (!fs.existsSync(tokensFile)) return undefined;

	try {
		const content = readFileText(tokensFile);
		const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0 && !l.startsWith('//'));

		for (const line of lines) {
			const parsed = parseTokenLine(line);
			if (!parsed) continue;

			// If a server spec is given, match against it
			if (serverSpec && parsed.server !== serverSpec) continue;

			return parsed;
		}

		return undefined;
	} catch (err) {
		logError('Failed to read cached tokens', err);
		return undefined;
	}
}

/**
 * Resolve an org slug from unityorgs.conf using the server ID.
 * Format: serverId:slug (e.g., "20067454181069:head-first-studios-bv")
 */
function resolveOrgSlug(serverId: string): string | undefined {
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) return undefined;

	const orgsFile = path.join(localAppData, 'plastic4', 'unityorgs.conf');
	if (!fs.existsSync(orgsFile)) return undefined;

	try {
		const content = readFileText(orgsFile);
		for (const line of content.split(/\r?\n/)) {
			if (line.startsWith('//') || !line.includes(':')) continue;
			const [id, slug] = line.split(':');
			if (id.trim() === serverId) return slug.trim();
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the cloud REST API URL from cloudregions.conf.
 * Format: organization=slug@cloud server=host:port version=N encrypted=T|F webserver=https://host:port
 */
function resolveCloudRegionUrl(orgIdentifier: string): string | undefined {
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) return undefined;

	const regionsFile = path.join(localAppData, 'plastic4', 'cloudregions.conf');
	if (!fs.existsSync(regionsFile)) return undefined;

	try {
		const content = readFileText(regionsFile);
		for (const line of content.split(/\r?\n/)) {
			if (line.startsWith('//') || !line.includes('organization=')) continue;
			const orgMatch = line.match(/organization=(\S+)/);
			const webMatch = line.match(/webserver=(\S+)/);
			if (!orgMatch || !webMatch) continue;
			const orgValue = orgMatch[1]; // e.g., "head-first-studios-bv@cloud"
			const orgBase = orgValue.replace(/@cloud$/, '');
			if (orgBase === orgIdentifier) {
				return webMatch[1];
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function parseTokenLine(line: string): PlasticCachedToken | undefined {
	// Format: server=X user=Y token=TOKENJWT seiddata=Z
	const serverMatch = line.match(/server=(\S+)/);
	const userMatch = line.match(/user=(\S+)/);
	const tokenMatch = line.match(/token=TOKEN(\S+)/);

	if (!serverMatch || !userMatch || !tokenMatch) return undefined;

	return {
		server: serverMatch[1],
		user: userMatch[1],
		token: tokenMatch[1],
	};
}

/**
 * Check if a directory contains a .plastic folder (activation check).
 */
export function hasPlasticWorkspace(workspaceRoot: string): boolean {
	return fs.existsSync(path.join(workspaceRoot, '.plastic', 'plastic.workspace'));
}

interface SelectorInfo {
	orgName: string;
	repoName: string;
	/** Full org/repo path before @ (e.g., "Divine Ambition/DAPrototype") */
	fullRepoPath: string;
	serverSpec: string;
	branch: string;
}

/**
 * Parse the plastic.selector file.
 * Format:
 *   repository "OrgName/RepoName@serverId@cloud"
 *     path "/"
 *       smartbranch "/main/SomeBranch"
 *   -- or --
 *       branch "/main/SomeBranch"
 */
function parseSelector(content: string): SelectorInfo | undefined {
	// Match: repository "OrgName/RepoName@serverId@cloud"
	const repoMatch = content.match(/repository\s+"([^"]+)"/);
	if (!repoMatch) return undefined;

	const repoSpec = repoMatch[1];
	// Split "Divine Ambition/DAPrototype@20067454181069@cloud"
	const atIndex = repoSpec.indexOf('@');
	const orgRepo = atIndex >= 0 ? repoSpec.substring(0, atIndex) : repoSpec;
	const serverSpec = atIndex >= 0 ? repoSpec.substring(atIndex + 1) : '';

	// Split org/repo — org name may contain spaces
	const slashIndex = orgRepo.lastIndexOf('/');
	const orgName = slashIndex >= 0 ? orgRepo.substring(0, slashIndex) : orgRepo;
	const repoName = slashIndex >= 0 ? orgRepo.substring(slashIndex + 1) : orgRepo;

	const fullRepoPath = orgRepo;

	// Match branch or smartbranch
	const branchMatch = content.match(/(?:smart)?branch\s+"([^"]+)"/);
	const branch = branchMatch?.[1] ?? '/main';

	return { orgName, repoName, fullRepoPath, serverSpec, branch };
}

function readLines(filePath: string): string[] {
	return readFileText(filePath).split(/\r?\n/).filter(l => l.length > 0);
}

function readFileText(filePath: string): string {
	return fs.readFileSync(filePath, 'utf-8');
}

function extractXmlValue(xml: string, tag: string): string | undefined {
	const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
	return match?.[1] || undefined;
}
