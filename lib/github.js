/**
 * dsh-github-upload — minimal GitHub REST client.
 *
 * Only what an upload needs: who am I, does the repo exist, create it. No gh
 * CLI, no git credential manager: one token plus `git` is the whole dependency
 * surface.
 */

const API_BASE = 'https://api.github.com';

/** Error carrying the HTTP status and GitHub's own message. */
export class GitHubError extends Error {
	constructor(message, { status, body } = {}) {
		super(message);
		this.name = 'GitHubError';
		this.status = status;
		this.body = body;
	}
}

/**
 * @param {{ token?: string, fetchImpl?: typeof fetch, userAgent?: string, apiBase?: string }} options
 */
export function createGitHubApi(options = {}) {
	const token = typeof options.token === 'string' && options.token.length > 0 ? options.token : undefined;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const apiBase = (options.apiBase ?? API_BASE).replace(/\/+$/, '');
	const userAgent = options.userAgent ?? 'dsh-github-upload';

	if (typeof fetchImpl !== 'function') {
		throw new GitHubError('当前运行环境没有可用的 fetch，无法调用 GitHub API');
	}

	async function request(path, { method = 'GET', body, signal } = {}) {
		if (token === undefined) {
			throw new GitHubError('没有可用的 GitHub 令牌，无法调用 GitHub API');
		}
		const response = await fetchImpl(`${apiBase}${path}`, {
			method,
			signal,
			headers: {
				accept: 'application/vnd.github+json',
				'content-type': 'application/json',
				'user-agent': userAgent,
				'x-github-api-version': '2022-11-28',
				authorization: `Bearer ${token}`
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const text = await response.text();
		let parsed;
		try {
			parsed = text.length > 0 ? JSON.parse(text) : undefined;
		} catch {
			parsed = undefined;
		}
		return { ok: response.ok, status: response.status, body: parsed, text };
	}

	/** Who the token belongs to; also the default repo owner. */
	async function getUser(signal) {
		const answer = await request('/user', { signal });
		if (!answer.ok) {
			throw new GitHubError(describeFailure('读取 GitHub 账号失败', answer), { status: answer.status, body: answer.body });
		}
		const user = answer.body;
		if (typeof user?.login !== 'string') {
			throw new GitHubError('GitHub /user 返回了无法识别的响应');
		}
		return {
			login: user.login,
			id: typeof user.id === 'number' ? user.id : undefined,
			name: typeof user.name === 'string' ? user.name : undefined,
			email: typeof user.email === 'string' ? user.email : undefined
		};
	}

	/** Scopes the token was granted, when the server reports them. */
	async function getScopes(signal) {
		try {
			const response = await fetchImpl(`${apiBase}/user`, {
				method: 'HEAD',
				signal,
				headers: {
					accept: 'application/vnd.github+json',
					'user-agent': userAgent,
					authorization: `Bearer ${token}`
				}
			});
			const raw = response.headers?.get?.('x-oauth-scopes');
			return raw === null || raw === undefined ? undefined : raw;
		} catch {
			return undefined;
		}
	}

	/** Inspect an existing repository without treating 404 as an error. */
	async function getRepo(owner, repo, signal) {
		const answer = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { signal });
		if (answer.status === 404) return undefined;
		if (!answer.ok) {
			throw new GitHubError(describeFailure(`读取仓库 ${owner}/${repo} 失败`, answer), { status: answer.status, body: answer.body });
		}
		return {
			fullName: answer.body.full_name,
			cloneUrl: answer.body.clone_url,
			sshUrl: answer.body.ssh_url,
			private: answer.body.private === true,
			defaultBranch: answer.body.default_branch
		};
	}

	/**
	 * Create the repository when missing; return the clone URL either way.
	 *
	 * @param {{ owner?: string, repo: string, private?: boolean, description?: string, signal?: AbortSignal }} input
	 */
	async function ensureRepo({ owner, repo, private: isPrivate = true, description, signal }) {
		const login = (await getUser(signal)).login;
		const targetOwner = owner !== undefined && owner.length > 0 ? owner : login;
		const existing = await getRepo(targetOwner, repo, signal);
		if (existing !== undefined) {
			return { created: false, owner: targetOwner, repo, cloneUrl: existing.cloneUrl, login, existing };
		}
		const path = targetOwner.toLowerCase() === login.toLowerCase()
			? '/user/repos'
			: `/orgs/${encodeURIComponent(targetOwner)}/repos`;
		const answer = await request(path, {
			method: 'POST',
			signal,
			body: {
				name: repo,
				private: isPrivate,
				description: description ?? '由 dsh-github-upload 上传',
				auto_init: false
			}
		});
		if (!answer.ok) {
			throw new GitHubError(describeFailure(`创建仓库 ${targetOwner}/${repo} 失败`, answer), { status: answer.status, body: answer.body });
		}
		return {
			created: true,
			owner: targetOwner,
			repo,
			cloneUrl: answer.body.clone_url,
			login,
			htmlUrl: answer.body.html_url
		};
	}

	return { tokenPresent: token !== undefined, getUser, getScopes, getRepo, ensureRepo, apiBase };
}

/** Turn a GitHub failure response into one actionable sentence. */
function describeFailure(prefix, answer) {
	const message = typeof answer?.body?.message === 'string' ? answer.body.message : undefined;
	const hints = [];
	if (answer?.status === 401) hints.push('令牌无效或已过期');
	if (answer?.status === 403) hints.push('令牌权限不足（建仓需要 repo 或 public_repo 权限）');
	if (answer?.status === 404) hints.push('目标不存在或令牌看不到它（组织仓库需要 org 权限）');
	const detail = message === undefined ? answer?.text?.slice(0, 200) : message;
	return [prefix, `HTTP ${answer?.status}`, detail, hints.length > 0 ? `（${hints.join('；')}）` : undefined]
		.filter(part => part !== undefined && part !== '')
		.join('：');
}
