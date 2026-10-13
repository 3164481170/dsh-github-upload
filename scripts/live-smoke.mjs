/**
 * Live smoke test: real `git`, real filesystem, fake GitHub API.
 *
 * The fake API stops at the network boundary only, so this exercises the real
 * git driver (spawn, collect, exit codes, askpass) end to end. It is not part
 * of `node --test` because it needs a real git install.
 *
 * Usage: node scripts/live-smoke.mjs
 */

import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { createGitDriver } from '../lib/git.js';
import { performUpload } from '../lib/upload.js';

/** Minimal subprocess service over node:child_process, matching the Host seam. */
const subprocess = {
	async resolveExecutable(command) {
		// Windows resolves git.exe; POSIX resolves git. Both are on PATH.
		return command;
	},
	spawn(spec) {
		const child = spawn(spec.argv[0], spec.argv.slice(1), {
			cwd: spec.cwd,
			env: spec.env ?? process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		const buffers = { stdout: [], stderr: [] };
		const LIMIT = 8 * 1024 * 1024;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		child.stdout.on('data', chunk => {
			if (stdoutBytes >= LIMIT) return;
			stdoutBytes += chunk.length;
			buffers.stdout.push(chunk);
		});
		child.stderr.on('data', chunk => {
			if (stderrBytes >= LIMIT) return;
			stderrBytes += chunk.length;
			buffers.stderr.push(chunk);
		});
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
			async waitForExit() {
				await done;
				return true;
			}
		};
	}
};

/** Fake GitHub API: records the create call, never touches the network. */
function fakeApi() {
	const created = [];
	return {
		created,
		async getUser() { return { login: 'octocat', id: 1, name: 'Octo Cat' }; },
		async getScopes() { return 'repo'; },
		async getRepo() { return undefined; },
		async ensureRepo({ owner, repo, private: isPrivate }) {
			created.push({ owner, repo, private: isPrivate !== false });
			return {
				created: true,
				owner,
				repo,
				cloneUrl: 'https://github.com/octocat/demo.git',
				htmlUrl: 'https://github.com/octocat/demo'
			};
		}
	};
}

const credentials = {
	currentRef: 'GITHUB_TOKEN',
	async tokenPresent() { return true; },
	async token() { return 'ghp_' + '0'.repeat(36); },
	async withToken() { return undefined; },
	async describe() { return { configured: true, writable: true }; }
};

async function main() {
	const dir = await mkdtemp(join(tmpdir(), 'gh-live-'));
	await mkdir(join(dir, 'src'), { recursive: true });
	await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2), 'utf8');
	await writeFile(join(dir, 'src', 'index.js'), 'export const answer = 42;\n', 'utf8');
	await writeFile(join(dir, 'README.md'), '# Demo\n\nA live smoke test project.\n', 'utf8');
	await mkdir(join(dir, 'node_modules', 'junk'), { recursive: true });
	await writeFile(join(dir, 'node_modules', 'junk', 'index.js'), 'module.exports = 1;\n', 'utf8');

	const git = createGitDriver({ subprocess, log: message => console.log('   git>', message) });
	const api = fakeApi();
	const result = await performUpload({
		projectDir: dir,
		repo: 'demo',
		isPrivate: true,
		deps: { git, api, credentials, pushEnv: {}, log: () => {} }
	});

	console.log('\n=== 结果 ===');
	console.log('ok        :', result.ok);
	console.log('repoUrl   :', result.repoUrl);
	console.log('branch    :', result.branch);
	console.log('commit    :', result.commitCount);
	console.log('created   :', result.created);
	if (result.error !== undefined) console.log('error     :', result.error);
	for (const s of result.steps ?? []) console.log(`  [${s.status}] ${s.name} — ${s.detail ?? ''}`);
	if (Array.isArray(result.warnings) && result.warnings.length > 0) {
		console.log('warnings  :');
		for (const w of result.warnings) console.log('  -', w);
	}

	// ---- verify the real repository state ---------------------------------
	console.log('\n=== 仓库实际状态 ===');
	const head = await git.run(['log', '--oneline'], { cwd: dir, allowFailure: true });
	console.log(head.stdout.trim() || '(无提交)');
	const tracked = await git.run(['ls-files'], { cwd: dir, allowFailure: true });
	const files = tracked.stdout.split('\n').map(line => line.trim()).filter(Boolean);
	console.log('已跟踪文件:', files.join(', '));
	const ignored = files.some(name => name.startsWith('node_modules/'));
	console.log('node_modules 被忽略:', ignored ? '否（异常）' : '是');
	const remote = await git.remoteUrl(dir, 'origin');
	console.log('origin    :', remote);
	const gitignore = await readFile(join(dir, '.gitignore'), 'utf8');
	console.log('.gitignore 已生成:', gitignore.includes('node_modules/') ? '是' : '否');

	// ---- verify the token never hit the repo config -----------------------
	const configText = await readFile(join(dir, '.git', 'config'), 'utf8');
	console.log('令牌泄漏到 .git/config:', configText.includes('ghp_') || configText.includes('0000000000') ? '是（异常）' : '否');

	// ---- verify push failure surfaces as a structured result --------------
	console.log('\n=== 推送失败路径 ===');
	const failing = createGitDriver({ subprocess });
	const failingApi = fakeApi();
	const dir2 = await mkdtemp(join(tmpdir(), 'gh-live2-'));
	await writeFile(join(dir2, 'a.txt'), 'a\n', 'utf8');
	const result2 = await performUpload({
		projectDir: dir2,
		repo: 'demo2',
		deps: {
			git: { ...failing, run: async (args, opts) => args.includes('push')
				? { exitCode: 1, stdout: '', stderr: '! [rejected] main -> main (fetch first)', ok: false }
				: failing.run(args, opts) },
			api: failingApi,
			credentials,
			pushEnv: {},
			log: () => {}
		}
	});
	console.log('ok        :', result2.ok);
	console.log('error     :', result2.error);
	console.log('repoUrl   :', result2.repoUrl);

	await rm(dir, { recursive: true, force: true });
	await rm(dir2, { recursive: true, force: true });
}

main().catch(error => {
	console.error('smoke test threw:', error);
	process.exitCode = 1;
});
