/**
 * dsh-github-upload — Host half.
 *
 * One job: take a finished project directory and put it on GitHub, using only
 * `git` plus a GitHub token. No `gh` CLI, no npm publish, no release machinery.
 *
 * Registers:
 * - Agent tools `gh_upload_status` (read-only preflight) and `gh_upload_project`
 *   (the real upload), plus `gh_upload_config` for the token.
 * - HTTP routes the browser panel polls: `/plugins/dsh-github-upload/status`,
 *   `/preflight`, `/upload`, `/config`.
 *
 * The token is resolved per operation from the credential seam and never leaves
 * the Host: the browser half only ever receives booleans and login names.
 */

import z from '@deepseek-ai/schemastery';
import { createGitDriver, createAskpassHelper, GitError } from './git.js';
import { createGitHubApi, GitHubError } from './github.js';
import { performUpload, preflight } from './upload.js';
import { redact, stripUndefined } from './detect.js';

/** Cordis plugin identity; must match the patch entry id. */
export const name = 'github-upload';

/** Services are optional: a missing one degrades one capability, not boot. */
export const inject = ['subprocess', 'tools', 'webServer', 'credentials'];

/** Live plugin configuration. */
export const Config = z.object({
	tokenRef: z.string().default('GITHUB_TOKEN').description('保存 GitHub 令牌的凭据引用名'),
	defaultPrivate: z.boolean().default(true).description('新仓库默认私有'),
	defaultBranch: z.string().default('main').description('推送分支名'),
	commitMessage: z.string().default('').description('默认提交信息；留空则自动生成'),
	allowSensitive: z.boolean().default(false).description('允许上传扫描到疑似凭据的项目（不推荐）'),
	timeoutMs: z.number().default(600000).description('单条 git 命令超时（毫秒）'),
	maxScanFiles: z.number().default(8000).description('凭据扫描的文件数上限')
});

const DEFAULTS = Object.freeze({
	tokenRef: 'GITHUB_TOKEN',
	defaultPrivate: true,
	defaultBranch: 'main',
	commitMessage: '',
	allowSensitive: false,
	timeoutMs: 600000,
	maxScanFiles: 8000
});

const STATUS_PATH = '/plugins/dsh-github-upload/status';
const PREFLIGHT_PATH = '/plugins/dsh-github-upload/preflight';
const UPLOAD_PATH = '/plugins/dsh-github-upload/upload';
const CONFIG_PATH = '/plugins/dsh-github-upload/config';

/** JSON response writer. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(payload),
		'Cache-Control': 'no-store'
	});
	res.end(payload);
}

/** Read a JSON request body with a hard ceiling. */
async function readJsonBody(req, limitBytes = 256 * 1024) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > limitBytes) throw new Error('请求体过大');
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString('utf8');
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		throw new Error('请求体不是合法 JSON');
	}
}

/** Loopback guard: the panel is same-origin, so no Origin means local. */
function hostIsLoopback(hostHeader) {
	if (typeof hostHeader !== 'string' || hostHeader === '') return false;
	const host = hostHeader.toLowerCase().split(':')[0];
	return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}
function originIsLoopback(originHeader) {
	if (typeof originHeader !== 'string' || originHeader === '' || originHeader === 'null') return true;
	try {
		return hostIsLoopback(new URL(originHeader).host);
	} catch {
		return false;
	}
}
function requestTrusted(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}

/**
 * Plugin entry.
 *
 * @param {object} ctx plugin context
 * @param {object} config resolved Config values
 */
export function apply(ctx, config) {
	const read = () => ({
		tokenRef: typeof config.tokenRef === 'string' && config.tokenRef.trim().length > 0
			? config.tokenRef.trim() : DEFAULTS.tokenRef,
		defaultPrivate: config.defaultPrivate !== false,
		defaultBranch: typeof config.defaultBranch === 'string' && config.defaultBranch.trim().length > 0
			? config.defaultBranch.trim() : DEFAULTS.defaultBranch,
		commitMessage: typeof config.commitMessage === 'string' ? config.commitMessage : DEFAULTS.commitMessage,
		allowSensitive: config.allowSensitive === true,
		timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs >= 10000
			? config.timeoutMs : DEFAULTS.timeoutMs,
		maxScanFiles: Number.isFinite(config.maxScanFiles) && config.maxScanFiles > 0
			? config.maxScanFiles : DEFAULTS.maxScanFiles
	});

	const log = message => { ctx.logger?.info?.(`[github-upload] ${message}`); };
	const warn = message => { ctx.logger?.warn?.(`[github-upload] ${message}`); };

	// ---- collaborators ----------------------------------------------------

	const subprocess = () => ctx.get('subprocess');
	const credentialsSvc = () => ctx.get('credentials');
	const sandboxPolicy = () => ctx.get('sandboxPolicy');

	/** The credential seam wrapped down to the two questions the flow asks. */
	function credentialsPort() {
		const settings = read();
		return {
			get currentRef() { return settings.tokenRef; },
			async tokenPresent() {
				const svc = credentialsSvc();
				if (svc === undefined) return false;
				try {
					const resolved = await svc.resolve(settings.tokenRef);
					return typeof resolved?.value === 'string' && resolved.value.length > 0;
				} catch {
					return false;
				}
			},
			async token() {
				const svc = credentialsSvc();
				if (svc === undefined) return undefined;
				try {
					const resolved = await svc.resolve(settings.tokenRef);
					return typeof resolved?.value === 'string' && resolved.value.length > 0 ? resolved.value : undefined;
				} catch {
					return undefined;
				}
			},
			async store(value) {
				const svc = credentialsSvc();
				if (svc === undefined) throw new Error('credentials 服务不可用，请改用环境变量设置令牌');
				await svc.set(settings.tokenRef, value);
			},
			async clear() {
				const svc = credentialsSvc();
				if (svc === undefined) return;
				await svc.unset(settings.tokenRef);
			},
			async describe() {
				const svc = credentialsSvc();
				if (svc === undefined) return { configured: false, writable: false };
				try {
					const info = await svc.describe(settings.tokenRef);
					return { configured: info?.configured === true, source: info?.source, writable: info?.writable === true };
				} catch {
					return { configured: false, writable: false };
				}
			},
			/** An api facade bound to one token, so no call reaches for the env. */
			async withToken(token) {
				return createGitHubApi({ token, userAgent: 'dsh-github-upload' });
			}
		};
	}

	/** A git driver for one project, with the token-mounted askpass helper. */
	async function gitPort(projectDir, token) {
		const sub = subprocess();
		if (sub === undefined) throw new GitError('subprocess 服务不可用，无法运行 git');
		const settings = read();
		const helper = token === undefined ? undefined : await createAskpassHelper({ token });
		const driver = createGitDriver({
			subprocess: sub,
			log,
			timeoutMs: settings.timeoutMs,
			env: helper === undefined ? {} : {
				...helper.env,
				DSH_GIT_USERNAME: 'x-access-token',
				DSH_GIT_PASSWORD: token
			}
		});
		return {
			driver,
			pushEnv: helper === undefined ? undefined : {
				...helper.env,
				DSH_GIT_USERNAME: 'x-access-token',
				DSH_GIT_PASSWORD: token
			},
			cleanup: async () => { if (helper !== undefined) await helper.cleanup(); }
		};
	}

	/** Resolve a project directory from an explicit path or the workspace root. */
	async function resolveProjectDir(explicit) {
		if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim();
		const policy = sandboxPolicy();
		if (policy !== undefined && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot.length > 0) {
			return policy.workspaceRoot;
		}
		return process.cwd();
	}

	/** Build the dependency bundle both flows consume. */
	async function depsFor(projectDir) {
		const port = credentialsPort();
		const token = await port.token();
		const git = await gitPort(projectDir, token);
		const api = token === undefined ? undefined : await port.withToken(token);
		return {
			deps: {
				git: git.driver,
				api,
				credentials: port,
				pushEnv: git.pushEnv,
				log
			},
			cleanup: git.cleanup,
			token
		};
	}

	/** Run a flow with cleanup guaranteed. */
	async function withDeps(projectDir, run) {
		const built = await depsFor(projectDir);
		try {
			return await run(built.deps, built.token);
		} finally {
			await built.cleanup().catch(() => { /* best effort */ });
		}
	}

	// ---- shared operations -------------------------------------------------

	async function runPreflight(args) {
		const projectDir = await resolveProjectDir(args?.path);
		return withDeps(projectDir, deps => preflight({
			projectDir,
			owner: args?.owner,
			repo: args?.repo,
			isPrivate: args?.private,
			deps
		}));
	}

	async function runUpload(args) {
		const settings = read();
		const projectDir = await resolveProjectDir(args?.path);
		return withDeps(projectDir, deps => performUpload({
			projectDir,
			owner: args?.owner,
			repo: args?.repo,
			isPrivate: args?.private !== undefined ? args.private !== false : settings.defaultPrivate,
			description: args?.description,
			commitMessage: typeof args?.commitMessage === 'string' && args.commitMessage.trim().length > 0
				? args.commitMessage
				: settings.commitMessage,
			branch: args?.branch ?? settings.defaultBranch,
			allowSensitive: args?.allowSensitive === true || settings.allowSensitive,
			allowForce: args?.allowForce === true,
			dryRun: args?.dryRun === true,
			deps
		}));
	}

	// ---- agent tools -------------------------------------------------------

	/**
	 * Tool results must be lossless JSON, which has no `undefined`. Optional
	 * fields legitimately go absent (no token means no login), so they are
	 * omitted rather than nulled.
	 */
	const asToolResult = value => stripUndefined(value);

	function toolsSection() {
		const toolsCtx = { tools: ctx.get('tools') };
		if (toolsCtx.tools === undefined) {
			warn('tools 服务不可用，跳过 agent 工具注册');
			return;
		}
		{
			const disposers = [];

			disposers.push(toolsCtx.tools.register({
				name: 'gh_upload_status',
				description: '把某个项目目录上传到 GitHub 之前的只读预检：目录内容、技术栈、体积、凭据扫描、git 状态、GitHub 账号与同名仓库是否存在。不写任何文件、不推送。',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: '项目目录绝对路径；缺省用当前工作区根目录。' },
						owner: { type: 'string', description: 'GitHub 用户名或组织名；缺省用令牌所属账号。' },
						repo: { type: 'string', description: '仓库名；缺省按目录名推导。' }
					},
					additionalProperties: false
				},
				output: {
					schema: { type: 'object', additionalProperties: true },
					render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
				},
				isConcurrencySafe: () => true,
				async execute(args) {
					try {
						return asToolResult(await runPreflight(args ?? {}));
					} catch (error) {
						return { ok: false, error: describeError(error) };
					}
				}
			}));

			disposers.push(toolsCtx.tools.register({
				name: 'gh_upload_project',
				description: '把一个已完成的项目目录上传到 GitHub：按技术栈生成 .gitignore、git init/add/commit、用 GitHub API 建仓库、推送分支。默认新建私有仓库。dryRun=true 时只预演不写入。',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: '项目目录绝对路径；缺省用当前工作区根目录。' },
						owner: { type: 'string', description: 'GitHub 用户名或组织名；缺省用令牌所属账号。' },
						repo: { type: 'string', description: '仓库名；缺省按目录名推导。' },
						private: { type: 'boolean', description: '是否私有仓库，默认 true。' },
						description: { type: 'string', description: '仓库描述。' },
						commitMessage: { type: 'string', description: '提交信息；缺省自动生成。' },
						branch: { type: 'string', description: '推送分支，默认 main。' },
						allowSensitive: { type: 'boolean', description: '扫描到疑似凭据时仍继续上传。' },
						allowForce: { type: 'boolean', description: '推送被拒时用 --force-with-lease 强推。' },
						dryRun: { type: 'boolean', description: '只预演，不做任何写入与推送。' }
					},
					additionalProperties: false
				},
				output: {
					schema: { type: 'object', additionalProperties: true },
					render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
				},
				isConcurrencySafe: () => false,
				async execute(args) {
					try {
						const result = await runUpload(args ?? {});
						log(`上传${result.ok ? '完成' : '失败'}：${result.repoUrl ?? result.error ?? ''}`);
						return asToolResult(result);
					} catch (error) {
						return { ok: false, error: describeError(error) };
					}
				}
			}));

			disposers.push(toolsCtx.tools.register({
				name: 'gh_upload_token',
				description: '查看/设置/清除本插件使用的 GitHub 令牌。令牌存在 DSH 凭据存储里，不会回显；也可改用环境变量 GITHUB_TOKEN。',
				parameters: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['status', 'set', 'clear'], description: 'status=查看；set=写入；clear=删除。' },
						value: { type: 'string', description: 'action=set 时的令牌明文。' }
					},
					required: ['action'],
					additionalProperties: false
				},
				output: {
					schema: { type: 'object', additionalProperties: true },
					render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
				},
				isConcurrencySafe: () => false,
				async execute(args) {
					const port = credentialsPort();
					const action = args?.action ?? 'status';
					try {
						if (action === 'set') {
							const value = typeof args?.value === 'string' ? args.value.trim() : '';
							if (value.length === 0) return { ok: false, error: '令牌不能为空' };
							await port.store(value);
							const check = await verifyToken(port, value);
							return asToolResult({ ok: check.ok, ref: port.currentRef, stored: true, login: check.login, scopes: check.scopes, error: check.error });
						}
						if (action === 'clear') {
							await port.clear();
							return { ok: true, ref: port.currentRef, cleared: true };
						}
						const info = await port.describe();
						const token = await port.token();
						const check = token === undefined ? { ok: false } : await verifyToken(port, token);
						return asToolResult({ ok: true, ref: port.currentRef, ...info, login: check.login, scopes: check.scopes, reachable: check.ok, error: check.error });
					} catch (error) {
						return { ok: false, error: describeError(error) };
					}
				}
			}));

			log('已注册 agent 工具：gh_upload_status、gh_upload_project、gh_upload_token');
			// Same contract as the routes above: the callback's return value is
			// the disposer, so it must not dispose during its own run.
			ctx.effect(() => () => {
				for (const dispose of disposers.reverse()) {
					try { dispose?.(); } catch { /* already gone */ }
				}
			}, 'github-upload: agent tools');
		}
	}

	/** Validate a token against GitHub without ever logging it. */
	async function verifyToken(port, token) {
		try {
			const api = await port.withToken(token);
			const user = await api.getUser(undefined);
			const scopes = await api.getScopes(undefined);
			return { ok: true, login: user.login, scopes };
		} catch (error) {
			return { ok: false, error: describeError(error) };
		}
	}

	/** One actionable sentence for any failure this plugin can raise. */
	function describeError(error) {
		if (error instanceof GitError) return error.message;
		if (error instanceof GitHubError) return error.message;
		if (error?.code === 'ENOENT') return `路径不存在：${error.path ?? ''}`;
		return error instanceof Error ? error.message : String(error);
	}

	// ---- HTTP routes -------------------------------------------------------

	const webCtx = { webServer: ctx.get('webServer') };
	if (webCtx.webServer === undefined) {
		warn('webServer 服务不可用，跳过 HTTP 路由注册');
	} else {
		const disposers = [];

		disposers.push(webCtx.webServer.register({
			kind: 'exact',
			path: STATUS_PATH,
			handler: async (req, res) => {
				if (req.method !== 'GET' && req.method !== 'HEAD') {
					writeJson(res, 405, { error: 'method-not-allowed' });
					return;
				}
				if (!requestTrusted(req)) {
					writeJson(res, 403, { error: 'request-not-trusted' });
					return;
				}
				const port = credentialsPort();
				const info = await port.describe();
				const token = await port.token();
				const check = token === undefined ? { ok: false } : await verifyToken(port, token);
				const policy = sandboxPolicy();
				writeJson(res, 200, {
					plugin: 'dsh-github-upload',
					version: 1,
					updatedAt: Date.now(),
					tokenRef: port.currentRef,
					tokenConfigured: info.configured,
					tokenSource: info.source,
					tokenWritable: info.writable === true,
					account: check.ok ? { login: check.login, scopes: check.scopes } : undefined,
					accountError: check.ok ? undefined : check.error,
					defaultPrivate: read().defaultPrivate,
					defaultBranch: read().defaultBranch,
					workspaceRoot: policy?.workspaceRoot,
					capabilities: {
						git: subprocess() !== undefined,
						credentials: credentialsSvc() !== undefined,
						tools: ctx.get('tools') !== undefined
					}
				});
			}
		}));

		disposers.push(webCtx.webServer.register({
			kind: 'exact',
			path: PREFLIGHT_PATH,
			handler: async (req, res) => {
				if (req.method !== 'POST') {
					writeJson(res, 405, { error: 'method-not-allowed' });
					return;
				}
				if (!requestTrusted(req)) {
					writeJson(res, 403, { error: 'request-not-trusted' });
					return;
				}
				try {
					const body = await readJsonBody(req);
					const result = await runPreflight(body);
					writeJson(res, 200, { ok: result.ok, result });
				} catch (error) {
					writeJson(res, 200, { ok: false, error: describeError(error) });
				}
			}
		}));

		disposers.push(webCtx.webServer.register({
			kind: 'exact',
			path: UPLOAD_PATH,
			handler: async (req, res) => {
				if (req.method !== 'POST') {
					writeJson(res, 405, { error: 'method-not-allowed' });
					return;
				}
				if (!requestTrusted(req)) {
					writeJson(res, 403, { error: 'request-not-trusted' });
					return;
				}
				try {
					const body = await readJsonBody(req);
					log(`面板请求上传：${body?.path ?? '(工作区根)'}`);
					const result = await runUpload(body);
					writeJson(res, 200, { ok: result.ok === true, result });
				} catch (error) {
					writeJson(res, 200, { ok: false, error: describeError(error) });
				}
			}
		}));

		disposers.push(webCtx.webServer.register({
			kind: 'exact',
			path: CONFIG_PATH,
			handler: async (req, res) => {
				if (req.method !== 'POST') {
					writeJson(res, 405, { error: 'method-not-allowed' });
					return;
				}
				if (!requestTrusted(req)) {
					writeJson(res, 403, { error: 'request-not-trusted' });
					return;
				}
				try {
					const body = await readJsonBody(req);
					const port = credentialsPort();
					if (body.action === 'clear') {
						await port.clear();
						writeJson(res, 200, { ok: true, cleared: true });
						return;
					}
					const value = typeof body.token === 'string' ? body.token.trim() : '';
					if (value.length === 0) {
						writeJson(res, 200, { ok: false, error: '令牌不能为空' });
						return;
					}
					await port.store(value);
					const check = await verifyToken(port, value);
					log(`令牌已更新（${check.ok ? `账号 ${check.login}` : '校验失败'}）`);
					writeJson(res, 200, { ok: check.ok, stored: true, login: check.login, scopes: check.scopes, error: check.error });
				} catch (error) {
					writeJson(res, 200, { ok: false, error: describeError(error) });
				}
			}
		}));

		log(`HTTP 路由已挂载：${STATUS_PATH}、${PREFLIGHT_PATH}、${UPLOAD_PATH}、${CONFIG_PATH}`);
		// ctx.effect runs this callback immediately and keeps its *return value*
		// as the disposer. Disposing inline would tear down the routes that were
		// just registered, so the callback returns the teardown instead.
		ctx.effect(() => () => {
			for (const dispose of disposers.reverse()) {
				try { dispose?.(); } catch { /* already gone */ }
			}
		}, 'github-upload: http routes');
	}

	toolsSection();

	log(`插件已加载（tokenRef=${read().tokenRef}, private=${read().defaultPrivate}, branch=${read().defaultBranch}）`);

	return () => { /* registrations are owned by ctx.effect hooks */ };
}

