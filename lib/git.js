/**
 * dsh-github-upload — git plumbing over the Host `subprocess` service.
 *
 * One managed child per command, collect-mode output, no shell. The token never
 * appears on a command line: it is injected per-invocation through an in-memory
 * `GIT_ASKPASS` helper, so it cannot leak into the process table, a git config
 * file, or `.git/config`'s remote URL.
 */

import { redact } from './detect.js';

/** Thrown when git itself exits non-zero. */
export class GitError extends Error {
	constructor(message, { code, stderr, stdout, command } = {}) {
		super(message);
		this.name = 'GitError';
		this.code = code;
		this.stderr = stderr;
		this.stdout = stdout;
		this.command = command;
	}
}

/** Result of one git invocation. */
function outcomeText(collected) {
	if (collected?.stdout === undefined) return '';
	return collected.stdout.readFrom(0).text;
}
function outcomeErr(collected) {
	if (collected?.stderr === undefined) return '';
	return collected.stderr.readFrom(0).text;
}

/**
 * Build a git driver bound to one subprocess service.
 *
 * @param {{ subprocess: object, env?: Record<string, string>, log?: (message: string) => void, timeoutMs?: number }} options
 */
export function createGitDriver(options) {
	const subprocess = options.subprocess;
	const baseEnv = { ...(options.env ?? {}) };
	const log = options.log ?? (() => {});
	const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 600000;

	if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
		throw new GitError('subprocess 服务不可用，无法运行 git');
	}

	/** Resolve `git` once; a missing git is reported as an actionable error. */
	let gitPath;
	async function resolveGit(signal) {
		if (gitPath !== undefined) return gitPath;
		try {
			gitPath = await subprocess.resolveExecutable('git', undefined, signal);
		} catch (error) {
			throw new GitError(
				`找不到可执行的 git（${error instanceof Error ? error.message : String(error)}）。请先安装 git 并确保它在 PATH 中。`
			);
		}
		return gitPath;
	}

	/**
	 * Run one git command.
	 *
	 * @param {string[]} args
	 * @param {{ cwd: string, env?: Record<string,string>, signal?: AbortSignal, allowFailure?: boolean, secrets?: string[] }} options
	 */
	async function run(args, { cwd, env, signal, allowFailure = false, secrets = [] } = {}) {
		const exe = await resolveGit(signal);
		const mergedEnv = { ...baseEnv, ...(env ?? {}) };
		const handle = subprocess.spawn({
			argv: [exe, ...args],
			cwd,
			env: mergedEnv,
			graceMs: 5000,
			signal,
			stdio: {
				stdin: 'ignore',
				stdout: { maxBytes: 8 * 1024 * 1024 },
				stderr: { maxBytes: 2 * 1024 * 1024 }
			}
		});

		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => {
				try { handle.terminate(); } catch { /* already gone */ }
				reject(new GitError(`git ${args[0]} 超时（${Math.round(timeoutMs / 1000)} 秒）已终止`, { command: args }));
			}, timeoutMs);
		});

		let outcome;
		try {
			outcome = await Promise.race([handle.done, timeout]);
		} finally {
			clearTimeout(timer);
		}

		const stdout = outcomeText(handle.collected);
		const stderr = outcomeErr(handle.collected);
		const exitCode = outcome?.exitCode;

		if (exitCode !== 0 && !allowFailure) {
			throw new GitError(
				redact(`git ${args.join(' ')} 失败（退出码 ${exitCode}）`, secrets)
					+ (stderr.trim().length > 0 ? `：${redact(stderr.trim(), secrets)}` : ''),
				{ code: exitCode, stderr: redact(stderr, secrets), stdout: redact(stdout, secrets), command: args }
			);
		}
		return { exitCode, stdout, stderr, ok: exitCode === 0 };
	}

	/** Whether a path is inside a git work tree. */
	async function isRepo(dir, signal) {
		const result = await run(['rev-parse', '--is-inside-work-tree'], { cwd: dir, signal, allowFailure: true });
		return result.ok && result.stdout.trim() === 'true';
	}

	/** Current branch, or undefined on an unborn branch. */
	async function currentBranch(dir, signal) {
		const result = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, signal, allowFailure: true });
		if (!result.ok) return undefined;
		const name = result.stdout.trim();
		return name === 'HEAD' || name.length === 0 ? undefined : name;
	}

	/** Porcelain status lines, one entry per changed path. */
	async function status(dir, signal) {
		const result = await run(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: dir, signal });
		return result.stdout
			.split('\n')
			.map(line => line.replace(/\r$/, ''))
			.filter(line => line.trim().length > 0);
	}

	/** Configured value for one key, or undefined. */
	async function configGet(dir, key, signal) {
		const result = await run(['config', '--get', key], { cwd: dir, signal, allowFailure: true });
		const value = result.stdout.trim();
		return result.ok && value.length > 0 ? value : undefined;
	}

	/** Commit count on HEAD; 0 on an unborn branch. */
	async function commitCount(dir, signal) {
		const result = await run(['rev-list', '--count', 'HEAD'], { cwd: dir, signal, allowFailure: true });
		if (!result.ok) return 0;
		const value = Number.parseInt(result.stdout.trim(), 10);
		return Number.isFinite(value) ? value : 0;
	}

	/** Remote URL for one name, or undefined. */
	async function remoteUrl(dir, name, signal) {
		const result = await run(['remote', 'get-url', name], { cwd: dir, signal, allowFailure: true });
		const value = result.stdout.trim();
		return result.ok && value.length > 0 ? value : undefined;
	}

	return { run, isRepo, currentBranch, status, configGet, commitCount, remoteUrl, resolveGit };
}

/**
 * Create the in-memory askpass helper.
 *
 * git runs the askpass executable with the prompt as argv[1] and reads the
 * credential from stdout. We hand git the *current* node binary and a tiny
 * script that prints whatever `DSH_GIT_PASSWORD` holds, so the secret travels
 * only through the child's environment.
 *
 * @returns {{ path: string, env: Record<string,string>, dir: string, cleanup: () => Promise<void> }}
 */
export async function createAskpassHelper(credentials) {
	const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const dir = await mkdtemp(join(tmpdir(), 'dsh-gh-upload-'));
	const script = join(dir, 'askpass.cjs');
	await writeFile(
		script,
		[
			'#!/usr/bin/env node',
			"// Managed by dsh-github-upload. Prints the credential git asked for.",
			"const prompt = String(process.argv[2] ?? '');",
			"const value = /username/i.test(prompt)",
			'	? (process.env.DSH_GIT_USERNAME ?? "")',
			'	: (process.env.DSH_GIT_PASSWORD ?? "");',
			'process.stdout.write(value + "\\n");'
		].join('\n'),
		'utf8'
	);
	return {
		path: script,
		dir,
		env: {
			GIT_ASKPASS: script,
			SSH_ASKPASS: script,
			GIT_TERMINAL_PROMPT: '0',
			GCM_INTERACTIVE: 'never'
		},
		credentials,
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ });
		}
	};
}
