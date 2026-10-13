window.__ModuleLoader__.load({
	id: 'dsh-github-upload',
	factory(require) {
		const React = require('react');
		const jsx = require('react/jsx-runtime');
		const h = React.createElement;

		const STATUS_PATH = '/plugins/dsh-github-upload/status';
		const PREFLIGHT_PATH = '/plugins/dsh-github-upload/preflight';
		const UPLOAD_PATH = '/plugins/dsh-github-upload/upload';
		const CONFIG_PATH = '/plugins/dsh-github-upload/config';

		// ---------- styles (theme tokens only) ----------

		const page = {
			boxSizing: 'border-box',
			width: '100%',
			maxWidth: 820,
			margin: '0 auto',
			padding: '28px 24px 48px',
			display: 'flex',
			flexDirection: 'column',
			gap: 16,
			color: 'var(--dsw-alias-label-primary)'
		};
		const headingRow = {
			display: 'flex', alignItems: 'center', justifyContent: 'space-between',
			flexWrap: 'wrap', gap: 12
		};
		const title = { margin: 0, fontSize: 18, lineHeight: '26px', fontWeight: 600 };
		const subtitle = { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' };
		const button = {
			boxSizing: 'border-box', minHeight: 32, padding: '5px 14px',
			border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 16,
			background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
			font: 'inherit', fontSize: 13, cursor: 'pointer'
		};
		const primaryButton = {
			...button,
			border: '1px solid var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))',
			background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))',
			color: 'var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base))'
		};
		const dangerButton = { ...button, color: 'var(--dsw-alias-state-error-primary)' };
		const card = {
			display: 'flex', flexDirection: 'column', gap: 10,
			padding: '14px 16px', border: '1px solid var(--dsw-alias-border-l1)',
			borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)'
		};
		const rowBetween = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' };
		const label = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' };
		const value = { fontSize: 14, lineHeight: '20px', fontWeight: 500 };
		const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, overflowWrap: 'anywhere' };
		const input = {
			boxSizing: 'border-box', width: '100%', minHeight: 32, padding: '5px 10px',
			border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
			background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
			font: 'inherit', fontSize: 13
		};
		const fieldRow = { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px', minWidth: 0 };
		const grid2 = { display: 'flex', gap: 12, flexWrap: 'wrap' };
		const errorText = { ...label, color: 'var(--dsw-alias-state-error-primary)' };
		const warnText = { ...label, color: 'var(--dsw-alias-state-warn-primary)' };
		const okText = { ...label, color: 'var(--dsw-alias-state-success-primary)' };
		const list = { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 };
		const chip = {
			display: 'inline-block', padding: '1px 8px', borderRadius: 10,
			border: '1px solid var(--dsw-alias-border-l2)', fontSize: 12,
			color: 'var(--dsw-alias-label-secondary)'
		};
		const stepRow = {
			display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12,
			lineHeight: '18px'
		};
		const dot = status => ({
			width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto', marginTop: 6,
			background: status === 'ok' ? 'var(--dsw-alias-state-success-primary)'
				: status === 'failed' ? 'var(--dsw-alias-state-error-primary)'
				: status === 'warn' ? 'var(--dsw-alias-state-warn-primary)'
				: 'var(--dsw-alias-state-idle-primary)'
		});

		function formatBytes(bytes) {
			if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
			const units = ['B', 'KB', 'MB', 'GB', 'TB'];
			let v = bytes, i = 0;
			while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
			return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
		}

		// ---------- small pieces ----------

		function Kv({ k, children }) {
			return jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 }, children: [
				jsx.jsx('span', { style: label, children: k }),
				jsx.jsx('span', { style: value, children })
			] });
		}

		function StepList({ steps }) {
			if (!Array.isArray(steps) || steps.length === 0) return null;
			return jsx.jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: steps.map((s, i) =>
				jsx.jsxs('div', { style: stepRow, key: `${s.name}-${i}` }, [
					jsx.jsx('span', { 'aria-hidden': true, style: dot(s.status) }),
					jsx.jsx('span', { style: { fontWeight: 600, flex: '0 0 auto' }, children: s.name }),
					jsx.jsx('span', { style: { ...label, flex: '1 1 auto' }, children: s.detail ?? '' })
				])) });
		}

		function Bullets({ items, style }) {
			if (!Array.isArray(items) || items.length === 0) return null;
			return jsx.jsx('ul', { style: { ...list, ...style }, children: items.map((item, i) =>
				jsx.jsx('li', { key: i, style: label }, item)) });
		}

		function SensitiveList({ findings }) {
			if (!Array.isArray(findings) || findings.length === 0) return null;
			return jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
				jsx.jsx('span', { style: warnText, children: `发现 ${findings.length} 处疑似凭据，上传默认会被拦住：` }),
				jsx.jsx('ul', { style: list, children: findings.map((f, i) =>
					jsx.jsx('li', { key: i, style: { ...mono, color: 'var(--dsw-alias-label-secondary)' }, children:
						`${f.path}${Array.isArray(f.signatures) ? ` · ${f.signatures.join(', ')}` : ''}` })) })
			] });
		}

		// ---------- main panel ----------

		function UploadPage() {
			const [status, setStatus] = React.useState(undefined);
			const [path, setPath] = React.useState('');
			const [repo, setRepo] = React.useState('');
			const [owner, setOwner] = React.useState('');
			const [isPrivate, setIsPrivate] = React.useState(true);
			const [pre, setPre] = React.useState(undefined);
			const [result, setResult] = React.useState(undefined);
			const [busy, setBusy] = React.useState('');
			const [error, setError] = React.useState(undefined);
			const [tokenInput, setTokenInput] = React.useState('');
			const seq = React.useRef(0);

			const loadStatus = React.useCallback(async () => {
				try {
					const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
					const body = await response.json().catch(() => undefined);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					setStatus(body);
					// Seed the form from the host without depending on `path`, so this
					// callback stays stable and the effect does not re-run per keystroke.
					setPath(current => current === '' && typeof body?.workspaceRoot === 'string'
						? body.workspaceRoot
						: current);
					if (body?.defaultPrivate !== undefined) setIsPrivate(body.defaultPrivate !== false);
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
				}
			}, []);

			React.useEffect(() => { loadStatus(); }, [loadStatus]);

			const post = React.useCallback(async (url, payload) => {
				const response = await fetch(url, {
					method: 'POST',
					headers: { accept: 'application/json', 'content-type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify(payload ?? {})
				});
				const body = await response.json().catch(() => undefined);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return body;
			}, []);

			const doPreflight = React.useCallback(async () => {
				const id = ++seq.current;
				setBusy('preflight'); setError(undefined); setResult(undefined);
				try {
					const body = await post(PREFLIGHT_PATH, { path: path || undefined, repo: repo || undefined, owner: owner || undefined, private: isPrivate });
					if (seq.current !== id) return;
					if (body?.ok === false && body?.error !== undefined && body?.result === undefined) {
						setError(body.error);
						setPre(undefined);
					} else {
						setPre(body?.result);
					}
				} catch (caught) {
					if (seq.current === id) setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					if (seq.current === id) setBusy('');
				}
			}, [path, repo, owner, isPrivate, post]);

			const doUpload = React.useCallback(async (dryRun) => {
				const id = ++seq.current;
				setBusy(dryRun ? 'dry' : 'upload'); setError(undefined); setResult(undefined);
				try {
					const body = await post(UPLOAD_PATH, {
						path: path || undefined,
						repo: repo || undefined,
						owner: owner || undefined,
						private: isPrivate,
						dryRun: dryRun === true
					});
					if (seq.current !== id) return;
					if (body?.ok === false && body?.result === undefined) setError(body.error);
					else {
						setResult(body?.result);
						if (body?.result?.preflight !== undefined) setPre(body.result.preflight);
					}
					loadStatus();
				} catch (caught) {
					if (seq.current === id) setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					if (seq.current === id) setBusy('');
				}
			}, [path, repo, owner, isPrivate, post, loadStatus]);

			const saveToken = React.useCallback(async () => {
				if (tokenInput.trim().length === 0) return;
				setBusy('token'); setError(undefined);
				try {
					const body = await post(CONFIG_PATH, { token: tokenInput.trim() });
					if (body?.ok === false) setError(body.error ?? '令牌校验失败');
					else { setTokenInput(''); await loadStatus(); }
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					setBusy('');
				}
			}, [tokenInput, post, loadStatus]);

			const clearToken = React.useCallback(async () => {
				setBusy('token'); setError(undefined);
				try {
					await post(CONFIG_PATH, { action: 'clear' });
					await loadStatus();
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					setBusy('');
				}
			}, [post, loadStatus]);

			const account = status?.account;

			return jsx.jsxs('div', { style: page, children: [
				jsx.jsxs('div', { style: headingRow, children: [
					jsx.jsxs('div', { children: [
						jsx.jsx('h1', { style: title, children: 'GitHub 上传' }),
						jsx.jsx('p', { style: subtitle, children: '把已完成的项目目录推到 GitHub：预检 → 生成 .gitignore → 提交 → 建仓库 → 推送。只需要 git 与一个令牌。' })
					] }),
					jsx.jsx('button', { type: 'button', style: button, disabled: busy !== '', onClick: loadStatus, children: '刷新状态' })
				] }),

				error === undefined ? null : jsx.jsx('p', { style: errorText, children: `错误：${error}` }),

				// ---- token ----
				jsx.jsxs('div', { style: card, children: [
					jsx.jsxs('div', { style: rowBetween, children: [
						jsx.jsx('span', { style: value, children: '访问令牌' }),
						jsx.jsx('span', { style: status?.tokenConfigured === true ? okText : errorText, children:
							status === undefined ? '读取中…'
								: status.tokenConfigured === true
									? `已配置${account?.login !== undefined ? `（${account.login}）` : ''}`
									: '未配置' })
					] }),
					jsx.jsxs('div', { style: label, children: [
						'令牌保存为凭据 ',
						jsx.jsx('code', { style: mono, children: status?.tokenRef ?? 'GITHUB_TOKEN' }),
						'，也可直接用环境变量 ',
						jsx.jsx('code', { style: mono, children: 'GITHUB_TOKEN' }),
						'。需要 ',
						jsx.jsx('code', { style: mono, children: 'repo' }),
						' 权限。'
					] }),
					status?.accountError === undefined ? null : jsx.jsx('span', { style: errorText, children: `账号校验：${status.accountError}` }),
					status?.account?.scopes === undefined ? null : jsx.jsx('span', { style: label, children: `令牌权限：${status.account.scopes || '(未报告)'}` }),
					jsx.jsxs('div', { style: { ...grid2, alignItems: 'flex-end' }, children: [
						jsx.jsxs('div', { style: fieldRow, children: [
							jsx.jsx('span', { style: label, children: '新的令牌（留空则不修改）' }),
							jsx.jsx('input', {
								type: 'password', style: input, value: tokenInput,
								placeholder: 'ghp_… 或 github_pat_…',
								onChange: event => setTokenInput(event.target.value)
							})
						] }),
						jsx.jsx('button', { type: 'button', style: primaryButton, disabled: busy !== '' || tokenInput.trim().length === 0, onClick: saveToken, children: busy === 'token' ? '保存中…' : '保存并校验' }),
						jsx.jsx('button', { type: 'button', style: dangerButton, disabled: busy !== '' || status?.tokenConfigured !== true, onClick: clearToken, children: '清除' })
					] })
				] }),

				// ---- target ----
				jsx.jsxs('div', { style: card, children: [
					jsx.jsx('span', { style: value, children: '目标项目' }),
					jsx.jsxs('div', { style: fieldRow, children: [
						jsx.jsx('span', { style: label, children: '项目目录（留空用当前工作区根目录）' }),
						jsx.jsx('input', { type: 'text', style: input, value: path, placeholder: status?.workspaceRoot ?? 'E:\\path\\to\\project', onChange: event => setPath(event.target.value) })
					] }),
					jsx.jsxs('div', { style: grid2, children: [
						jsx.jsxs('div', { style: fieldRow, children: [
							jsx.jsx('span', { style: label, children: '仓库名（留空按目录名推导）' }),
							jsx.jsx('input', { type: 'text', style: input, value: repo, placeholder: 'my-project', onChange: event => setRepo(event.target.value) })
						] }),
						jsx.jsxs('div', { style: fieldRow, children: [
							jsx.jsx('span', { style: label, children: '账号/组织（留空用令牌所属账号）' }),
							jsx.jsx('input', { type: 'text', style: input, value: owner, placeholder: 'octocat', onChange: event => setOwner(event.target.value) })
						] })
					] }),
					jsx.jsxs('label', { style: { ...label, display: 'flex', alignItems: 'center', gap: 8 }, children: [
						jsx.jsx('input', { type: 'checkbox', checked: isPrivate, onChange: event => setIsPrivate(event.target.checked) }),
						'创建为私有仓库'
					] }),
					jsx.jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
						jsx.jsx('button', { type: 'button', style: button, disabled: busy !== '', onClick: doPreflight, children: busy === 'preflight' ? '预检中…' : '预检（只读）' }),
						jsx.jsx('button', { type: 'button', style: button, disabled: busy !== '', onClick: () => doUpload(true), children: busy === 'dry' ? '预演中…' : '预演（不推送）' }),
						jsx.jsx('button', { type: 'button', style: primaryButton, disabled: busy !== '', onClick: () => doUpload(false), children: busy === 'upload' ? '上传中…' : '上传到 GitHub' })
					] })
				] }),

				// ---- preflight ----
				pre === undefined ? null : jsx.jsxs('div', { style: card, children: [
					jsx.jsxs('div', { style: rowBetween, children: [
						jsx.jsx('span', { style: value, children: '预检结果' }),
						jsx.jsx('span', { style: pre.ok === true ? okText : errorText, children: pre.ok === true ? '可以上传' : '存在问题' })
					] }),
					jsx.jsxs('div', { style: grid2, children: [
						jsx.jsx(Kv, { k: '仓库', children: `${pre.owner ?? '?'}/${pre.repoName ?? '?'}` }),
						jsx.jsx(Kv, { k: '体积', children: `${pre.sizeText ?? formatBytes(pre.size?.bytes)} · ${pre.size?.files ?? '?'} 个文件` }),
						jsx.jsx(Kv, { k: 'git', children: pre.isGitRepo === true ? `已初始化 · ${pre.changes ?? 0} 个变更` : '尚未初始化' }),
						jsx.jsx(Kv, { k: '远端仓库', children: pre.github?.repoExists === true ? '已存在，将直接推送' : '将新建' })
					] }),
					Array.isArray(pre.stackLabels) && pre.stackLabels.length > 0
						? jsx.jsx('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: pre.stackLabels.map(name =>
							jsx.jsx('span', { style: chip, key: name, children: name })) })
						: null,
					jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [
						jsx.jsx('span', { style: value, children: '步骤' }),
						jsx.jsx(StepList, { steps: pre.steps })
					] }),
					jsx.jsx(SensitiveList, { findings: pre.sensitive }),
					jsx.jsxs('div', { children: [
						jsx.jsx('span', { style: value, children: '警告' }),
						jsx.jsx(Bullets, { items: pre.warnings })
					] }),
					jsx.jsxs('div', { children: [
						jsx.jsx('span', { style: errorText, children: '阻断项' }),
						jsx.jsx(Bullets, { items: pre.blockers, style: { color: 'var(--dsw-alias-state-error-primary)' } })
					] })
				] }),

				// ---- result ----
				result === undefined ? null : jsx.jsxs('div', { style: card, children: [
					jsx.jsxs('div', { style: rowBetween, children: [
						jsx.jsx('span', { style: value, children: result.dryRun === true ? '预演结果' : '上传结果' }),
						jsx.jsx('span', { style: result.ok === true ? okText : errorText, children: result.ok === true ? (result.dryRun === true ? '预演通过' : '成功') : '失败' })
					] }),
					result.repoUrl === undefined ? null : jsx.jsxs('div', { style: label, children: [
						'仓库地址：',
						jsx.jsxs('a', { href: result.repoUrl, target: '_blank', rel: 'noreferrer', style: { ...mono, color: 'var(--dsw-alias-brand-primary)' }, children: [result.repoUrl] })
					] }),
					result.error === undefined ? null : jsx.jsx('span', { style: errorText, children: result.error }),
					jsx.jsx(StepList, { steps: result.steps }),
					jsx.jsx(Bullets, { items: result.warnings })
				] })
			] });
		}

		function PanelIcon() {
			return h('svg', {
				viewBox: '0 0 64 64', width: 20, height: 20, 'aria-hidden': true, style: { display: 'block' }
			}, [
				h('path', { d: 'M32 8v30', fill: 'none', stroke: 'currentColor', 'stroke-width': 5, 'stroke-linecap': 'round' }),
				h('path', { d: 'M20 26l12 12 12-12', fill: 'none', stroke: 'currentColor', 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
				h('path', { d: 'M14 46h36', fill: 'none', stroke: 'currentColor', 'stroke-width': 5, 'stroke-linecap': 'round' })
			]);
		}

		// ---------- plugin entry ----------

		const NS = 'github-upload';
		const dictionaries = {
			zh: { panel: 'GitHub 上传' },
			en: { panel: 'GitHub Upload' }
		};

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				let t = key => dictionaries.zh[key] ?? key;
				try {
					ctx.locale.register(NS, dictionaries);
					const bound = ctx.locale.bind(NS);
					if (typeof bound === 'function') t = key => bound(key, {});
					else if (bound !== undefined) t = key => bound(key);
				} catch (caught) {
					console.warn('[dsh-github-upload] locale unavailable, falling back to zh copy:', caught);
				}

				ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
					name: 'sidebar.panellist',
					id: 'github-upload',
					order: 58,
					label: () => t('panel'),
					locale: NS
				}, PanelIcon));

				ctx.slots.inject('main', () => ctx.slots.register({
					name: 'main',
					key: 'github-upload',
					locale: NS,
					inject: () => ({ t })
				}, UploadPage));
			}
		};
	}
});
