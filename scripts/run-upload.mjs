/**
 * Upload the project using the plugin's own verified library code.
 *
 * This exists because the running desktop Host still holds the pre-fix module
 * (its process started before the lossless-JSON fix), and its tool bridge
 * therefore rejects results. The library half is unchanged by that fix and is
 * fully covered by the test suite, so driving it directly is the same code
 * path the tool would take.
 *
 * Usage:
 *   node scripts/run-upload.mjs --path <dir> [--owner <o>] [--repo <r>]
 *                               [--public] [--allow-sensitive] [--force] [--dry]
 */

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createGitDriver, createAskpassHelper } from '../lib/git.js';
import { createGitHubApi } from '../lib/github.js';
import { performUpload, preflight } from '../lib/upload.js';
import { stripUndefined } from '../lib/detect.js';

/** Flag parsing: an empty positional argument is easy to lose in a shell. */
function parseArgs(argv) {
	const flags = { positional: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith('--')) {
			flags.positional.push(token);
			continue;
		}
		const name = token.slice(2);
		const next = argv[index + 1];
		if (next !== undefined && !next.startsWith('--')) {
			flags[name] = next;
			index += 1;
		} else {
			flags[name] = true;
		}
	}
	return flags;
}

const flags = parseArgs(process.argv.slice(2));
const projectDir = flags.path ?? flags.positional[0] ?? process.cwd();
const owner = typeof flags.owner === 'string' && flags.owner.length > 0 ? flags.owner : undefined;
const repo = typeof flags.repo === 'string' && flags.repo.length > 0 ? flags.repo : undefined;
const isPrivate = flags.public !== true;
const allowSensitive = flags['allow-sensitive'] === true;
const allowForce = flags.force === true;
const dryRun = flags.dry === true;

console.log(`project : ${projectDir}`);
console.log(`owner   : ${owner ?? '(token account)'}`);
console.log(`repo    : ${repo ?? '(derive from folder)'}`);
console.log(`private : ${isPrivate}`);
console.log(`flags   : allowSensitive=${allowSensitive} allowForce=${allowForce} dryRun=${dryRun}\n`);

/** Resolve the token the same way the Host credential seam does: refs first. */
async function resolveToken(ref = 'GITHUB_TOKEN') {
	if (typeof process.env[ref] === 'string' && process.env[ref].trim().length > 0) {
		return { value: process.env[ref].trim(), source: 'environment' };
	}
	const file = join(homedir(), '.dsh', '.credentials.yaml');
	const text = await readFile(file, 'utf8').catch(() => '');
	// Minimal YAML read of the refs block: enough for one flat string ref.
	const lines = text.split(/\r?\n/);
	let inRefs = false;
	for (const line of lines) {
		if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
		if (inRefs && /^\S/.test(line)) break;
		if (!inRefs) continue;
		const match = line.match(/^\s{2}([^:]+):\s*(.*)$/);
		if (match !== null && match[1] === ref) {
			const raw = match[2].trim().replace(/^["']|["']$/g, '');
			if (raw.length > 0) return { value: raw, source: 'file' };
		}
	}
	return undefined;
}

/** Minimal subprocess service over node:child_process. */
const subprocess = {
	async resolveExecutable(command) { return command; },
	spawn(spec) {
		const child = spawn(spec.argv[0], spec.argv.slice(1), {
			cwd: spec.cwd,
			env: spec.env ?? process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		const buffers = { stdout: [], stderr: [] };
		const LIMIT = 16 * 1024 * 1024;
		let sizes = { stdout: 0, stderr: 0 };
		for (const key of ['stdout', 'stderr']) {
			child[key].on('data', chunk => {
				if (sizes[key] >= LIMIT) return;
				sizes[key] += chunk.length;
				buffers[key].push(chunk);
			});
		}
		const done = new Promise((resolve, reject) => {
			child.on('error', reject);
			child.on('close', (code, signal) => resolve({ exitCode: code, signal }));
		});
		const reader = key => ({
			readFrom() {
				return { text: Buffer.concat(buffers[key]).toString('utf8'), nextOffset: 0, lossy: false };
			}
		});
		return {
			stdin: undefined,
			stdout: child.stdout,
			stderr: child.stderr,
			control: undefined,
			collected: { stdout: reader('stdout'), stderr: reader('stderr') },
			done,
			terminate() { child.kill('SIGKILL'); },
			async waitForExit() { await done; return true; }
		};
	}
};

const resolved = await resolveToken();
if (resolved === undefined) {
	console.error('找不到 GITHUB_TOKEN');
	process.exit(1);
}
console.log(`token: ${resolved.source} (${resolved.value.slice(0, 4)}…, len=${resolved.value.length})`);

const token = resolved.value;
const helper = await createAskpassHelper({ token });
const git = createGitDriver({
	subprocess,
	log: () => {},
	timeoutMs: 900000,
	env: { ...helper.env, DSH_GIT_USERNAME: 'x-access-token', DSH_GIT_PASSWORD: token }
});
const api = createGitHubApi({ token });
const credentials = {
	currentRef: 'GITHUB_TOKEN',
	async tokenPresent() { return true; },
	async token() { return token; },
	async withToken() { return api; },
	async describe() { return { configured: true, source: resolved.source, writable: true }; }
};

const deps = { git, api, credentials, pushEnv: helper.env, log: () => {} };

console.log('\n=== 预检 ===');
const pre = await preflight({ projectDir, owner, repo, isPrivate, deps });
console.log('ok        :', pre.ok);
console.log('repo      :', `${pre.owner ?? '?'}/${pre.repoName}`);
console.log('size      :', pre.sizeText, '/', pre.size?.files, 'files');
console.log('stacks    :', (pre.stackLabels ?? []).join(', '));
console.log('sensitive :', (pre.sensitive ?? []).length);
for (const s of pre.steps ?? []) console.log(`  [${s.status}] ${s.name} — ${s.detail ?? ''}`);
for (const w of pre.warnings ?? []) console.log('  ! ' + w);
for (const b of pre.blockers ?? []) console.log('  X ' + b);

if (!pre.ok) {
	console.log('\n预检未通过，停止。');
	await helper.cleanup();
	process.exit(2);
}

console.log('\n=== 上传 ===');
const result = stripUndefined(await performUpload({
	projectDir,
	owner,
	repo,
	isPrivate,
	allowSensitive,
	allowForce,
	dryRun,
	description: 'DSH GitHub Upload — 把已完成的项目一键上传到 GitHub 的 DSH 插件（只需 git 与一个令牌，不依赖 gh CLI）',
	deps
}));

console.log('ok        :', result.ok);
console.log('repoUrl   :', result.repoUrl);
console.log('cloneUrl  :', result.cloneUrl);
console.log('branch    :', result.branch);
console.log('commits   :', result.commitCount);
console.log('created   :', result.created);
if (result.error !== undefined) console.log('error     :', result.error);
for (const s of result.steps ?? []) console.log(`  [${s.status}] ${s.name} — ${s.detail ?? ''}`);
for (const w of result.warnings ?? []) console.log('  ! ' + w);

await helper.cleanup();
process.exit(result.ok ? 0 : 3);
