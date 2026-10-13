/**
 * End-to-end tests for the upload flow against a fake git driver and a fake
 * GitHub API. These prove the ordering, the guards, and the failure paths
 * without touching a real repository or the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { performUpload, preflight } from '../lib/upload.js';
import { stripUndefined } from '../lib/detect.js';

/** Every dotted path at which the tree holds an `undefined`. */
function findUndefinedPaths(value, prefix = 'result') {
	const found = [];
	if (value === undefined) {
		found.push(prefix);
		return found;
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => found.push(...findUndefinedPaths(entry, `${prefix}[${index}]`)));
		return found;
	}
	if (value !== null && typeof value === 'object') {
		for (const [key, entry] of Object.entries(value)) {
			found.push(...findUndefinedPaths(entry, `${prefix}.${key}`));
		}
	}
	return found;
}

/** A project directory with a couple of files. */
async function makeProject(files = { 'index.js': 'console.log(1)\n', 'package.json': '{}\n' }) {
	const dir = await mkdtemp(join(tmpdir(), 'gh-upload-test-'));
	for (const [name, content] of Object.entries(files)) {
		const target = join(dir, name);
		await mkdir(join(target, '..'), { recursive: true });
		await writeFile(target, content, 'utf8');
	}
	return dir;
}

/**
 * Fake git driver.
 *
 * Records every argv so the tests assert on the exact command sequence rather
 * than on side effects inside a real repository.
 */
function fakeGit(options = {}) {
	const calls = [];
	const state = {
		isRepo: options.isRepo ?? false,
		branch: options.branch,
		status: options.status ?? ['?? index.js'],
		commitCount: options.commitCount ?? 0,
		config: options.config ?? {},
		remote: options.remote,
		pushFails: options.pushFails === true,
		pushStderr: options.pushStderr ?? '! [rejected] main -> main (fetch first)'
	};
	const driver = {
		calls,
		state,
		async isRepo() { calls.push(['isRepo']); return state.isRepo; },
		async currentBranch() { calls.push(['currentBranch']); return state.branch; },
		async status() { calls.push(['status']); return state.status; },
		async commitCount() { calls.push(['commitCount']); return state.commitCount; },
		async remoteUrl(_dir, name) { calls.push(['remoteUrl', name]); return name === 'origin' ? state.remote : undefined; },
		async configGet(_dir, key) {
			calls.push(['configGet', key]);
			return state.config[key];
		},
		async run(args, opts = {}) {
			calls.push(['run', args.join(' ')]);
			const joined = args.join(' ');
			if (joined.startsWith('init')) {
				state.isRepo = true;
				state.branch = args[args.length - 1];
			}
			if (joined.includes('add -A')) return { exitCode: 0, stdout: '', stderr: '', ok: true };
			if (joined.includes('commit')) {
				state.commitCount += 1;
				state.status = [];
				return { exitCode: 0, stdout: '', stderr: '', ok: true };
			}
			if (joined.startsWith('remote add') || joined.startsWith('remote set-url')) {
				state.remote = args[args.length - 1];
				return { exitCode: 0, stdout: '', stderr: '', ok: true };
			}
			if (joined.includes('push')) {
				if (state.pushFails) return { exitCode: 1, stdout: '', stderr: state.pushStderr, ok: false };
				return { exitCode: 0, stdout: '', stderr: '', ok: true };
			}
			return { exitCode: 0, stdout: '', stderr: '', ok: true };
		}
	};
	return driver;
}

/** Fake GitHub API with an in-memory repository table. */
function fakeApi(options = {}) {
	const repos = new Map(options.repos ?? []);
	const created = [];
	return {
		created,
		repos,
		async getUser() {
			if (options.authFails === true) throw new Error('Bad credentials');
			return { login: options.login ?? 'octocat', id: options.id ?? 1, name: 'Octo Cat' };
		},
		async getScopes() { return options.scopes ?? 'repo'; },
		async getRepo(owner, repo) {
			return repos.get(`${owner}/${repo}`);
		},
		async ensureRepo({ owner, repo, private: isPrivate, description }) {
			const key = `${owner}/${repo}`;
			const existing = repos.get(key);
			if (existing !== undefined) {
				return { created: false, owner, repo, cloneUrl: existing.cloneUrl, login: 'octocat', existing };
			}
			if (options.createFails === true) throw new Error('HTTP 403：令牌权限不足');
			const entry = {
				fullName: key,
				cloneUrl: `https://github.com/${key}.git`,
				sshUrl: `git@github.com:${key}.git`,
				private: isPrivate !== false,
				defaultBranch: 'main'
			};
			repos.set(key, entry);
			created.push({ owner, repo, private: isPrivate !== false, description });
			return { created: true, owner, repo, cloneUrl: entry.cloneUrl, login: 'octocat', htmlUrl: `https://github.com/${key}` };
		}
	};
}

/** Credential port over a fixed token. Pass `null` for "no token configured". */
function fakeCredentials(token) {
	const value = token === undefined ? 'ghp_testtokenvalue0000000000000000000000' : token;
	return {
		currentRef: 'GITHUB_TOKEN',
		async tokenPresent() { return typeof value === 'string' && value.length > 0; },
		async token() { return typeof value === 'string' && value.length > 0 ? value : undefined; },
		async withToken() { return undefined; },
		async describe() { return { configured: typeof value === 'string', writable: true }; }
	};
}

function deps({ git, api, credentials }) {
	return {
		git,
		api,
		credentials: credentials ?? fakeCredentials(),
		pushEnv: {},
		log: () => {}
	};
}

// ---------------------------------------------------------------- preflight

test('preflight reports a fresh, non-git project as uploadable', async () => {
	const dir = await makeProject();
	try {
		const result = await preflight({
			projectDir: dir,
			deps: {
				git: fakeGit(),
				api: fakeApi(),
				credentials: fakeCredentials(),
				log: () => {}
			}
		});
		assert.equal(result.ok, true);
		assert.equal(result.isGitRepo, false);
		assert.equal(result.hasGitignore, false);
		assert.equal(result.repoName, dir.split(/[\\/]/).pop().toLowerCase().replace(/[^a-z0-9._-]/g, '-'));
		assert.ok(result.stacks.includes('node'));
		assert.deepEqual(result.blockers, []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('preflight blocks when no token is configured', async () => {
	const dir = await makeProject();
	try {
		const result = await preflight({
			projectDir: dir,
			deps: { git: fakeGit(), api: fakeApi(), credentials: fakeCredentials(null), log: () => {} }
		});
		assert.equal(result.ok, false);
		assert.ok(result.blockers.some(text => text.includes('令牌')));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('preflight flags a .env file as sensitive', async () => {
	const dir = await makeProject({ 'index.js': 'x\n', '.env': 'API_KEY=abcdefghijklmnop\n' });
	try {
		const result = await preflight({
			projectDir: dir,
			deps: { git: fakeGit(), api: fakeApi(), credentials: fakeCredentials(), log: () => {} }
		});
		assert.ok(result.sensitive.some(f => f.path === '.env'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('preflight flags credential content inside an ordinary file', async () => {
	const dir = await makeProject({
		'config.js': 'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n'
	});
	try {
		const result = await preflight({
			projectDir: dir,
			deps: { git: fakeGit(), api: fakeApi(), credentials: fakeCredentials(), log: () => {} }
		});
		const finding = result.sensitive.find(f => f.path === 'config.js');
		assert.ok(finding !== undefined);
		assert.ok(finding.signatures.includes('github-token'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('preflight reports a missing directory instead of throwing', async () => {
	const result = await preflight({
		projectDir: join(tmpdir(), 'definitely-not-here-' + Date.now()),
		deps: { git: fakeGit(), api: fakeApi(), credentials: fakeCredentials(), log: () => {} }
	});
	assert.equal(result.ok, false);
	assert.equal(result.steps[0].status, 'failed');
});

// ------------------------------------------------------------------ upload

test('upload initialises, commits, creates the repo, and pushes', async () => {
	const dir = await makeProject();
	const git = fakeGit();
	const api = fakeApi();
	try {
		const result = await performUpload({
			projectDir: dir,
			repo: 'demo',
			isPrivate: true,
			deps: deps({ git, api })
		});
		assert.equal(result.ok, true);
		assert.equal(result.repo, 'demo');
		assert.equal(result.owner, 'octocat');
		assert.equal(result.branch, 'main');
		assert.equal(api.created.length, 1);
		assert.equal(api.created[0].private, true);

		const commands = git.calls.filter(c => c[0] === 'run').map(c => c[1]);
		const indexOf = needle => commands.findIndex(command => command.includes(needle));
		assert.ok(indexOf('init') >= 0, 'git init ran');
		assert.ok(indexOf('add -A') > indexOf('init'), 'add runs after init');
		assert.ok(indexOf('commit') > indexOf('add -A'), 'commit runs after add');
		assert.ok(indexOf('push') > indexOf('remote add'), 'push runs after remote add');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload writes a .gitignore when the project has none', async () => {
	const dir = await makeProject();
	try {
		const result = await performUpload({ projectDir: dir, repo: 'demo', deps: deps({ git: fakeGit(), api: fakeApi() }) });
		assert.equal(result.ok, true);
		const written = await import('node:fs/promises').then(fs => fs.readFile(join(dir, '.gitignore'), 'utf8'));
		assert.match(written, /node_modules\//);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload leaves an existing .gitignore untouched', async () => {
	const dir = await makeProject({ 'index.js': 'x\n', '.gitignore': '# mine\ncustom/\n' });
	try {
		await performUpload({ projectDir: dir, repo: 'demo', deps: deps({ git: fakeGit(), api: fakeApi() }) });
		const written = await import('node:fs/promises').then(fs => fs.readFile(join(dir, '.gitignore'), 'utf8'));
		assert.equal(written, '# mine\ncustom/\n');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload refuses to proceed when it finds credentials', async () => {
	const dir = await makeProject({ 'index.js': 'x\n', '.env': 'SECRET=abcdefghijklmnop\n' });
	const git = fakeGit();
	try {
		const result = await performUpload({ projectDir: dir, repo: 'demo', deps: deps({ git, api: fakeApi() }) });
		assert.equal(result.ok, false);
		assert.match(result.error, /凭据/);
		// Nothing may have been staged or committed.
		assert.ok(!git.calls.some(c => c[0] === 'run' && c[1].includes('add -A')));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload proceeds past credentials when allowSensitive is set', async () => {
	const dir = await makeProject({ 'index.js': 'x\n', '.env': 'SECRET=abcdefghijklmnop\n' });
	try {
		const result = await performUpload({
			projectDir: dir,
			repo: 'demo',
			allowSensitive: true,
			deps: deps({ git: fakeGit(), api: fakeApi() })
		});
		assert.equal(result.ok, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload in dry-run mode writes nothing', async () => {
	const dir = await makeProject();
	const git = fakeGit();
	try {
		const result = await performUpload({
			projectDir: dir,
			repo: 'demo',
			dryRun: true,
			deps: deps({ git, api: fakeApi() })
		});
		assert.equal(result.ok, true);
		assert.equal(result.dryRun, true);
		assert.equal(git.calls.filter(c => c[0] === 'run').length, 0);
		await assert.rejects(() => import('node:fs/promises').then(fs => fs.access(join(dir, '.gitignore'))));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload reuses an existing remote repository', async () => {
	const dir = await makeProject();
	const api = fakeApi({ repos: [['octocat/demo', { fullName: 'octocat/demo', cloneUrl: 'https://github.com/octocat/demo.git', private: true, defaultBranch: 'main' }]] });
	try {
		const result = await performUpload({ projectDir: dir, repo: 'demo', deps: deps({ git: fakeGit(), api }) });
		assert.equal(result.ok, true);
		assert.equal(result.created, false);
		assert.equal(api.created.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload points an existing origin at the new repository', async () => {
	const dir = await makeProject();
	const git = fakeGit({ remote: 'https://github.com/someone/old.git' });
	try {
		await performUpload({ projectDir: dir, repo: 'demo', deps: deps({ git, api: fakeApi() }) });
		const commands = git.calls.filter(c => c[0] === 'run').map(c => c[1]);
		assert.ok(commands.some(command => command.startsWith('remote set-url origin')));
		assert.ok(!commands.some(command => command.startsWith('remote add origin')));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload reports an actionable hint when the push is rejected', async () => {
	const dir = await makeProject();
	const git = fakeGit({ pushFails: true });
	try {
		const result = await performUpload({ projectDir: dir, repo: 'demo', deps: deps({ git, api: fakeApi() }) });
		assert.equal(result.ok, false);
		assert.match(result.error, /强推|rebase/);
		// The repository was still created, so the user can retry against it.
		assert.equal(result.repoUrl, 'https://github.com/octocat/demo');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload adds --force-with-lease only when asked', async () => {
	const dir = await makeProject();
	const plain = fakeGit();
	const forced = fakeGit();
	try {
		await performUpload({ projectDir: dir, repo: 'demo', deps: deps({ git: plain, api: fakeApi() }) });
		await performUpload({ projectDir: dir, repo: 'demo', allowForce: true, deps: deps({ git: forced, api: fakeApi() }) });
		const plainPush = plain.calls.filter(c => c[0] === 'run' && c[1].includes('push')).map(c => c[1]).join('\n');
		const forcedPush = forced.calls.filter(c => c[0] === 'run' && c[1].includes('push')).map(c => c[1]).join('\n');
		assert.ok(!plainPush.includes('--force-with-lease'));
		assert.ok(forcedPush.includes('--force-with-lease'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload fails cleanly when the token has no create permission', async () => {
	const dir = await makeProject();
	try {
		const result = await performUpload({
			projectDir: dir,
			repo: 'demo',
			deps: deps({ git: fakeGit(), api: fakeApi({ createFails: true }) })
		});
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /令牌权限不足|403/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload stops before git when no token is available', async () => {
	const dir = await makeProject();
	const git = fakeGit();
	try {
		const result = await performUpload({
			projectDir: dir,
			repo: 'demo',
			deps: deps({ git, api: fakeApi(), credentials: fakeCredentials(null) })
		});
		assert.equal(result.ok, false);
		assert.equal(git.calls.filter(c => c[0] === 'run').length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload skips the commit when the tree is already clean', async () => {
	const dir = await makeProject();
	const git = fakeGit({ isRepo: true, branch: 'main', status: [], commitCount: 3 });
	try {
		const result = await performUpload({ projectDir: dir, repo: 'demo', deps: deps({ git, api: fakeApi() }) });
		assert.equal(result.ok, true);
		const commands = git.calls.filter(c => c[0] === 'run').map(c => c[1]);
		assert.ok(!commands.some(command => command.includes('commit')));
		assert.ok(commands.some(command => command.includes('push')));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload derives the repository name from the folder when omitted', async () => {
	const dir = await makeProject();
	const api = fakeApi();
	try {
		const result = await performUpload({ projectDir: dir, deps: deps({ git: fakeGit(), api }) });
		assert.equal(result.ok, true);
		assert.equal(result.repo, api.created[0].repo);
		assert.match(result.repo, /^gh-upload-test-/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload honours an explicit owner and organization path', async () => {
	const dir = await makeProject();
	const api = fakeApi();
	try {
		const result = await performUpload({ projectDir: dir, repo: 'demo', owner: 'my-org', deps: deps({ git: fakeGit(), api }) });
		assert.equal(result.ok, true);
		assert.equal(result.owner, 'my-org');
		assert.match(result.repoUrl, /my-org\/demo/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload uses the remote URL as the origin when given one', async () => {
	const dir = await makeProject();
	const api = fakeApi();
	try {
		const result = await performUpload({
			projectDir: dir,
			owner: 'https://github.com/my-org',
			repo: 'https://github.com/my-org/demo.git',
			deps: deps({ git: fakeGit(), api })
		});
		assert.equal(result.ok, true);
		assert.equal(result.owner, 'my-org');
		assert.equal(result.repo, 'demo');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload names the branch and pushes HEAD to it', async () => {
	const dir = await makeProject();
	const git = fakeGit();
	try {
		const result = await performUpload({ projectDir: dir, repo: 'demo', branch: 'trunk', deps: deps({ git, api: fakeApi() }) });
		assert.equal(result.ok, true);
		assert.equal(result.branch, 'trunk');
		const commands = git.calls.filter(c => c[0] === 'run').map(c => c[1]);
		assert.ok(commands.some(command => command.includes('init -b trunk')));
		assert.ok(commands.some(command => command.includes('HEAD:refs/heads/trunk')));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload applies the commit identity through -c flags', async () => {
	const dir = await makeProject();
	const git = fakeGit({ config: {} });
	try {
		await performUpload({ projectDir: dir, repo: 'demo', deps: deps({ git, api: fakeApi() }) });
		const commit = git.calls.filter(c => c[0] === 'run').map(c => c[1]).find(command => command.includes('commit'));
		assert.ok(commit !== undefined);
		assert.match(commit, /-c user\.name=/);
		assert.match(commit, /-c user\.email=/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('upload never puts the token on a command line', async () => {
	const dir = await makeProject();
	const git = fakeGit();
	const token = 'ghp_testtokenvalue0000000000000000000000';
	try {
		await performUpload({ projectDir: dir, repo: 'demo', deps: deps({ git, api: fakeApi(), credentials: fakeCredentials(token) }) });
		const allArgs = git.calls.filter(c => c[0] === 'run').map(c => c[1]).join('\n');
		assert.ok(!allArgs.includes(token), 'token must not appear in any git argv');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// A tool result must be lossless JSON, so no code path may emit `undefined`.

test('a token-less preflight result carries no undefined once stripped', async () => {
	const dir = await makeProject();
	try {
		const result = await preflight({
			projectDir: dir,
			deps: { git: fakeGit(), api: fakeApi(), credentials: fakeCredentials(null), log: () => {} }
		});
		assert.ok(findUndefinedPaths(result).length > 0, 'this scenario does produce absent optionals');
		assert.deepEqual(findUndefinedPaths(stripUndefined(result)), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('a successful upload result carries no undefined once stripped', async () => {
	const dir = await makeProject();
	try {
		const result = await performUpload({ projectDir: dir, repo: 'demo', deps: deps({ git: fakeGit(), api: fakeApi() }) });
		assert.deepEqual(findUndefinedPaths(stripUndefined(result)), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('a failed upload result carries no undefined once stripped', async () => {
	const dir = await makeProject();
	try {
		const result = await performUpload({
			projectDir: dir,
			repo: 'demo',
			deps: deps({ git: fakeGit({ pushFails: true }), api: fakeApi() })
		});
		assert.equal(result.ok, false);
		assert.deepEqual(findUndefinedPaths(stripUndefined(result)), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('every result is JSON round-trip stable once stripped', async () => {
	const dir = await makeProject();
	try {
		const result = await performUpload({ projectDir: dir, repo: 'demo', dryRun: true, deps: deps({ git: fakeGit(), api: fakeApi() }) });
		const json = JSON.stringify(stripUndefined(result));
		assert.equal(json, JSON.stringify(JSON.parse(json)));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
