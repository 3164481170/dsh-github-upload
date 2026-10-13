/**
 * dsh-github-upload — preflight + upload orchestration.
 *
 * Both entry points take their collaborators as injected dependencies, so the
 * whole flow is exercisable against fake git/api objects without a live Host.
 */

import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { join } from 'node:path';
import { buildGitignore, detectStacks, formatBytes, resolveIdentity, redact, suggestRepoName } from './detect.js';
import { listTopLevel, measureProject, scanProject } from './scan.js';

/** GitHub notifies on files over 50 MB and rejects a push over 100 MB per file. */
const SIZE_WARN_BYTES = 50 * 1024 * 1024;
const SIZE_BLOCK_BYTES = 100 * 1024 * 1024;

/** One step record shared by every flow. */
function step(name, status, detail) {
	return { name, status, detail };
}

async function exists(path) {
	try {
		await access(path, FS.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read-only inspection. Never writes anything, never touches the network except
 * the GitHub identity/repo lookups when a token is available.
 *
 * @param {{ projectDir: string, owner?: string, repo?: string, isPrivate?: boolean, deps: object }} input
 */
export async function preflight(input) {
	const { projectDir, deps } = input;
	const { git, api, credentials, log } = deps;
	const owner = normalizeOwner(input.owner);
	const warnings = [];
	const blockers = [];

	if (!(await exists(projectDir))) {
		return {
			projectDir,
			ok: false,
			blockers: [`目录不存在：${projectDir}`],
			warnings: [],
			steps: [step('检查目录', 'failed', '目录不存在')]
		};
	}
	const info = await stat(projectDir).catch(() => undefined);
	if (info === undefined || !info.isDirectory()) {
		return {
			projectDir,
			ok: false,
			blockers: [`目标不是目录：${projectDir}`],
			warnings: [],
			steps: [step('检查目录', 'failed', '目标不是目录')]
		};
	}

	const repoName = normalizeRepo(input.repo) ?? suggestRepoName(projectDir);
	const listing = await listTopLevel(projectDir);
	const stacks = detectStacks(listing);
	const scan = await scanProject(projectDir, { maxFiles: 8000, maxDepth: 12 });
	const size = await measureProject(projectDir);

	const isRepo = await git.isRepo(projectDir);
	const branch = isRepo ? await git.currentBranch(projectDir) : undefined;
	const commitCount = isRepo ? await git.commitCount(projectDir) : 0;
	const statusLines = isRepo ? await git.status(projectDir) : [];
	const remoteUrlValue = isRepo ? await git.remoteUrl(projectDir, 'origin') : undefined;
	const hasGitignore = listing.files.some(name => name === '.gitignore');
	const gitConfig = {
		name: await git.configGet(projectDir, 'user.name'),
		email: await git.configGet(projectDir, 'user.email')
	};

	const sensitive = scan.findings.filter(f => f.kind === 'sensitive-file' || f.kind === 'secret-content');
	if (sensitive.length > 0) {
		warnings.push(`发现 ${sensitive.length} 处疑似凭据（文件或内容），上传前请确认`);
	}
	if (scan.truncated) {
		warnings.push(`文件数量超过扫描上限（已扫描 ${scan.scannedFiles} 个），结果可能不完整`);
	}
	if (size.bytes > SIZE_WARN_BYTES) {
		warnings.push(`项目体积约 ${formatBytes(size.bytes)}，超过 GitHub 建议的 50 MB`);
	}
	if (size.bytes > SIZE_BLOCK_BYTES * 20) {
		warnings.push('项目体积过大，推送可能超时或失败，建议先清理构建产物');
	}
	if (!hasGitignore) {
		warnings.push('没有 .gitignore，上传时会自动生成一份');
	}
	if (isRepo && statusLines.length > 2000) {
		warnings.push(`工作区有 ${statusLines.length} 个变更，提交可能较慢`);
	}
	if (remoteUrlValue !== undefined) {
		warnings.push(`已存在 origin 远端（${remoteUrlValue}），上传时会更新为新的仓库地址`);
	}

	// ---- GitHub side -------------------------------------------------------
	const tokenPresent = await credentials.tokenPresent();
	let account;
	const github = { tokenPresent, login: undefined, scopes: undefined, repoExists: false, repoUrl: undefined, repoPrivate: undefined };
	if (tokenPresent) {
		const token = await credentials.token();
		// The injected facade wins; only a caller that supplied nothing gets one
		// built from the resolved token.
		const scoped = deps.api ?? (token !== undefined && credentials.withToken
			? await credentials.withToken(token)
			: undefined);
		if (scoped !== undefined) {
			try {
				account = await scoped.getUser(undefined);
				github.login = account.login;
				github.scopes = await scoped.getScopes(undefined);
				const targetOwner = owner ?? account.login;
				const found = await scoped.getRepo(targetOwner, repoName, undefined);
				if (found !== undefined) {
					github.repoExists = true;
					github.repoUrl = found.cloneUrl;
					github.repoPrivate = found.private;
					if (found.cloneUrl !== remoteUrlValue) {
						warnings.push(`仓库 ${targetOwner}/${repoName} 已存在，将直接推送（远端 origin 会被设为它）`);
					}
				}
				github.owner = targetOwner;
				github.repo = repoName;
			} catch (error) {
				warnings.push(redact(`GitHub 预检失败：${describeApiError(error)}`, [token]));
			}
		}
	} else {
		blockers.push('缺少 GitHub 令牌：请先设置 GITHUB_TOKEN（环境变量、凭据存储或 .env）');
	}

	const identity = resolveIdentity({ options: {}, gitConfig, profile: account });
	const hasAnyChange = !isRepo || commitCount === 0 || statusLines.length > 0;

	return {
		projectDir,
		ok: blockers.length === 0,
		repoName,
		owner: github.owner ?? owner,
		isPrivate: input.isPrivate !== false,
		isGitRepo: isRepo,
		branch: branch ?? 'main',
		commitCount,
		changes: statusLines.length,
		changeSample: statusLines.slice(0, 30),
		hasGitignore,
		stacks: stacks.map(s => s.id),
		stackLabels: stacks.map(s => s.label),
		size,
		sizeText: formatBytes(size.bytes),
		scannedFiles: scan.scannedFiles,
		sensitive: sensitive.slice(0, 50),
		symlinks: scan.findings.filter(f => f.kind === 'symlink').slice(0, 20),
		github,
		identity,
		willCommit: hasAnyChange,
		blockers,
		warnings,
		steps: [
			step('检查目录', 'ok', projectDir),
			step('识别技术栈', stacks.length > 0 ? 'ok' : 'skipped', stacks.map(s => s.label).join('、') || '未识别到常见栈'),
			step('扫描敏感内容', sensitive.length === 0 ? 'ok' : 'warn', sensitive.length === 0 ? '未发现凭据' : `${sensitive.length} 处待确认`),
			step('读取 git 状态', isRepo ? 'ok' : 'warn', isRepo ? `分支 ${branch ?? '(未提交)'} · ${statusLines.length} 个变更` : '还不是 git 仓库，上传时会初始化'),
			step('读取 GitHub 账号', tokenPresent ? 'ok' : 'failed', tokenPresent ? (github.login ?? '令牌可用') : '无令牌')
		]
	};
}

/**
 * Perform the upload: init → .gitignore → add → commit → create repo → push.
 *
 * @param {{
 *   projectDir: string, owner?: string, repo?: string, isPrivate?: boolean,
 *   description?: string, commitMessage?: string, branch?: string,
 *   allowSensitive?: boolean, allowForce?: boolean, dryRun?: boolean,
 *   deps: object
 * }} input
 */
export async function performUpload(input) {
	const { projectDir, deps } = input;
	const { git, credentials, log } = deps;
	const steps = [];
	const warnings = [];

	// A dry run still needs one token read so the push step can report honestly.
	const token = await credentials.token();
	const secrets = token === undefined ? [] : [token];
	// The injected api facade wins; a caller that only supplied credentials gets
	// one built from the resolved token.
	const api = deps.api ?? (token === undefined || !credentials.withToken
		? undefined
		: await credentials.withToken(token));

	if (token === undefined || token.length === 0) {
		return {
			ok: false,
			steps: [step('读取令牌', 'failed', '缺少 GITHUB_TOKEN')],
			error: '缺少 GitHub 令牌：请先设置 GITHUB_TOKEN（环境变量、凭据存储或 .env）'
		};
	}

	const pre = await preflight({ projectDir, owner: input.owner, repo: input.repo, isPrivate: input.isPrivate, deps });
	steps.push(...pre.steps);
	warnings.push(...pre.warnings);
	if (!pre.ok) {
		return { ok: false, steps, warnings, error: pre.blockers.join('；'), preflight: pre };
	}
	if (pre.sensitive.length > 0 && input.allowSensitive !== true) {
		return {
			ok: false,
			steps: [...steps, step('安全检查', 'failed', '发现疑似凭据，已中止')],
			warnings,
			error: '扫描到疑似凭据文件或内容，已中止上传。确认无误后可用 allowSensitive=true 强制继续。',
			sensitive: pre.sensitive,
			preflight: pre
		};
	}
	if (input.dryRun === true) {
		return {
			ok: true,
			dryRun: true,
			steps: [...steps, step('预演', 'ok', 'dry_run=true，未做任何写入与推送')],
			warnings,
			plan: {
				repoName: pre.repoName,
				owner: pre.owner,
				isPrivate: input.isPrivate !== false,
				branch: input.branch ?? pre.branch,
				willCommit: pre.willCommit,
				stacks: pre.stackLabels
			},
			preflight: pre
		};
	}

	// A GitHub failure must come back as a structured result, not an exception:
	// the caller renders steps, and a throw would lose the steps already taken.
	let account;
	let owner;
	let repoName;
	let isPrivate;
	let branch;
	let identityArgs;
	try {
		account = await api.getUser(undefined);
		owner = normalizeOwner(input.owner) ?? account.login;
		repoName = normalizeRepo(input.repo) ?? suggestRepoName(projectDir);
		isPrivate = input.isPrivate !== false;
		branch = sanitizeBranch(input.branch) ?? (await currentOrMain(git, projectDir));
		const identity = resolveIdentity({ options: {}, gitConfig: await readGitIdentity(git, projectDir), profile: account });
		identityArgs = [`-c`, `user.name=${identity.name}`, `-c`, `user.email=${identity.email}`];
	} catch (error) {
		const detail = redact(describeApiError(error), secrets);
		return {
			ok: false,
			steps: [...steps, step('读取 GitHub 账号', 'failed', detail)],
			warnings,
			error: `读取 GitHub 账号失败：${detail}`,
			preflight: pre
		};
	}

	// ---- 1. repository -----------------------------------------------------
	if (!(await git.isRepo(projectDir))) {
		const init = await git.run(['init', '-b', branch], { cwd: projectDir });
		steps.push(step('初始化仓库', 'ok', `git init -b ${branch}`));
	} else {
		steps.push(step('初始化仓库', 'skipped', '已是 git 仓库'));
	}

	// ---- 2. .gitignore -----------------------------------------------------
	const gitignorePath = join(projectDir, '.gitignore');
	const listing = await listTopLevel(projectDir);
	if (!listing.files.some(name => name === '.gitignore')) {
		const stacks = detectStacks(listing);
		await writeFile(gitignorePath, buildGitignore(stacks), 'utf8');
		steps.push(step('生成 .gitignore', 'ok', `按 ${stacks.length} 个技术栈生成`));
	} else {
		steps.push(step('生成 .gitignore', 'skipped', '已存在，保留原文件'));
	}

	// ---- 3. stage + commit -------------------------------------------------
	await git.run(['add', '-A'], { cwd: projectDir, secrets });
	const statusAfter = await git.status(projectDir);
	if (statusAfter.length === 0) {
		steps.push(step('提交变更', 'skipped', '没有需要提交的变更'));
	} else {
		const message = typeof input.commitMessage === 'string' && input.commitMessage.trim().length > 0
			? input.commitMessage.trim()
			: `chore: 上传项目（${statusAfter.length} 个文件）`;
		await git.run([...identityArgs, 'commit', '-m', message], { cwd: projectDir, secrets });
		const count = await git.commitCount(projectDir);
		steps.push(step('提交变更', 'ok', `${statusAfter.length} 个文件 · 共 ${count} 个提交`));
	}

	// ---- 4. remote repository ---------------------------------------------
	let ensured;
	try {
		ensured = await api.ensureRepo({
			owner,
			repo: repoName,
			private: isPrivate,
			description: input.description,
			signal: undefined
		});
	} catch (error) {
		const detail = redact(describeApiError(error), secrets);
		return {
			ok: false,
			steps: [...steps, step('准备远端仓库', 'failed', detail)],
			warnings,
			error: `创建仓库失败：${detail}`,
			repoUrl: `https://github.com/${owner}/${repoName}`,
			preflight: pre
		};
	}
	steps.push(step(
		'准备远端仓库',
		'ok',
		ensured.created ? `已创建 ${ensured.owner}/${ensured.repo}（${isPrivate ? '私有' : '公开'}）` : `已存在 ${ensured.owner}/${ensured.repo}，直接推送`
	));

	const remote = ensured.cloneUrl;
	const existingRemote = await git.remoteUrl(projectDir, 'origin', undefined);
	if (existingRemote === undefined) {
		await git.run(['remote', 'add', 'origin', remote], { cwd: projectDir, secrets });
	} else if (existingRemote !== remote) {
		await git.run(['remote', 'set-url', 'origin', remote], { cwd: projectDir, secrets });
	}

	// ---- 5. push -----------------------------------------------------------
	const pushArgs = [...identityArgs, 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`];
	if (input.allowForce === true) pushArgs.splice(3, 0, '--force-with-lease');
	const push = await git.run(pushArgs, { cwd: projectDir, env: deps.pushEnv, secrets, allowFailure: true });
	if (!push.ok) {
		const detail = redact(push.stderr || push.stdout, secrets).trim().slice(-1200);
		const hint = /non-fast-forward|fetch first|rejected/i.test(detail)
			? '远端已有提交且与本地不连续。可先 git pull --rebase，或用 allowForce=true 强推。'
			: /authentication|403|401|denied|Permission/i.test(detail)
				? '认证失败：确认令牌有效且具备 repo（或 public_repo）权限。'
				: undefined;
		return {
			ok: false,
			steps: [...steps, step('推送', 'failed', detail || `退出码 ${push.exitCode}`)],
			warnings: hint === undefined ? warnings : [...warnings, hint],
			error: `推送失败${hint === undefined ? '' : `：${hint}`}${detail.length > 0 ? `（${detail.split('\n').slice(-3).join(' ')}）` : ''}`,
			repoUrl: `https://github.com/${ensured.owner}/${ensured.repo}`,
			preflight: pre
		};
	}
	steps.push(step('推送', 'ok', `已推送分支 ${branch}`));

	const webUrl = ensured.htmlUrl ?? `https://github.com/${ensured.owner}/${ensured.repo}`;
	return {
		ok: true,
		steps,
		warnings,
		repoUrl: webUrl,
		cloneUrl: ensured.cloneUrl,
		owner: ensured.owner,
		repo: ensured.repo,
		branch,
		private: isPrivate,
		created: ensured.created,
		commitCount: await git.commitCount(projectDir),
		preflight: pre
	};
}

async function currentOrMain(git, projectDir) {
	const branch = await git.currentBranch(projectDir);
	return branch ?? 'main';
}

/** One actionable sentence for a failed GitHub call. */
function describeApiError(error) {
	if (error === null || error === undefined) return '未知错误';
	const message = error instanceof Error ? error.message : String(error);
	if (typeof error.status === 'number' && !/HTTP \d/.test(message)) {
		return `HTTP ${error.status}：${message}`;
	}
	return message;
}

async function readGitIdentity(git, projectDir) {
	return {
		name: await git.configGet(projectDir, 'user.name'),
		email: await git.configGet(projectDir, 'user.email')
	};
}

function normalizeOwner(value) {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	// Accept a full URL or owner/repo form and keep only the owner segment.
	const fromUrl = trimmed.match(/github\.com[/:]([^/]+)(?:\/([^/]+?))?(?:\.git)?\/?$/i);
	if (fromUrl !== null) return fromUrl[1];
	const simple = trimmed.match(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
	return simple === null ? trimmed.replace(/[^A-Za-z0-9-]/g, '') : trimmed;
}

function normalizeRepo(value) {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const fromUrl = trimmed.match(/github\.com[/:][^/]+\/([^/]+?)(?:\.git)?\/?$/i);
	const candidate = fromUrl === null ? trimmed : fromUrl[1];
	const cleaned = candidate.replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]/g, '-');
	return cleaned.length === 0 ? undefined : cleaned.slice(0, 100);
}

function sanitizeBranch(value) {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const cleaned = trimmed.replace(/[^A-Za-z0-9._/-]/g, '-').replace(/^[.-]+/, '');
	return cleaned.length === 0 ? undefined : cleaned;
}

export { SIZE_WARN_BYTES, SIZE_BLOCK_BYTES };
