/**
 * dsh-github-upload — pure project inspection helpers (no ctx, no I/O side effects).
 *
 * Everything here takes plain data in and returns plain data out, so the whole
 * preflight vocabulary is testable without a live composition.
 */

/** Filenames that must never be pushed without an explicit override. */
const SENSITIVE_NAMES = Object.freeze([
	/^\.env(\..+)?$/i,
	/^\.envrc$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)$/i,
	/^\.?(npmrc|pypirc|netrc|htpasswd)$/i,
	/^credentials(\.json)?$/i,
	/^service[-_]?account.*\.json$/i,
	/^\.?terraform\.tfstate.*$/i,
	/^.*\.(pem|key|pfx|p12|jks|keystore|ppk)$/i,
	/^.*\.(sqlite|sqlite3|db|mdb|dump|sql\.gz)$/i,
	/^secrets?\.(json|ya?ml|toml)$/i,
	/^\.aws$/i,
	/^\.ssh$/i,
	/^\.gnupg$/i,
	/^\.git-credentials$/i
]);

/** Content signatures that scream "credential" when found in a text file. */
const SENSITIVE_CONTENT = Object.freeze([
	{ id: 'private-key-block', re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
	{ id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
	{ id: 'github-pat-fine', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
	{ id: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
	{ id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
	{ id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ id: 'generic-secret-assign', re: /(api[_-]?key|secret|passwd|password|access[_-]?token)\s*[:=]\s*["'][^"'\s]{16,}["']/i }
]);

/** Directories never worth pushing; used for the generated .gitignore. */
export const COMMON_IGNORES = Object.freeze([
	'.DS_Store',
	'Thumbs.db',
	'*.log',
	'*.tmp',
	'.idea/',
	'.vscode/',
	'*.swp'
]);

/**
 * Stack templates. `markers` are probed against the top level of the project;
 * `dirs` are probed as directory names at any depth up to 2.
 */
export const STACKS = Object.freeze([
	{
		id: 'node',
		label: 'Node.js',
		markers: ['package.json'],
		dirs: ['node_modules'],
		ignore: ['node_modules/', 'dist/', 'build/', 'coverage/', '.npm/', '.pnpm-store/', '*.tsbuildinfo', '.env', '.env.local', '.env.*.local']
	},
	{
		id: 'python',
		label: 'Python',
		markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'poetry.lock'],
		dirs: ['__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache'],
		ignore: ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', 'build/', 'dist/', '*.egg-info/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/']
	},
	{
		id: 'rust',
		label: 'Rust',
		markers: ['Cargo.toml'],
		dirs: ['target'],
		ignore: ['target/', '**/*.rs.bk']
	},
	{
		id: 'go',
		label: 'Go',
		markers: ['go.mod'],
		dirs: [],
		ignore: ['bin/', '*.test', '*.out']
	},
	{
		id: 'java',
		label: 'Java/JVM',
		markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
		dirs: ['target', 'build', '.gradle'],
		ignore: ['target/', 'build/', '.gradle/', '*.class', '*.jar']
	},
	{
		id: 'dotnet',
		label: '.NET',
		markers: ['*.sln', '*.csproj'],
		dirs: ['bin', 'obj'],
		ignore: ['bin/', 'obj/', '*.user', '*.suo']
	},
	{
		id: 'unity',
		label: 'Unity',
		markers: ['ProjectSettings', 'Assets'],
		dirs: ['Library', 'Temp', 'Logs'],
		ignore: ['Library/', 'Temp/', 'Obj/', 'Logs/', 'UserSettings/', '*.csproj', '*.sln', '*.unityproj']
	},
	{
		id: 'godot',
		label: 'Godot',
		markers: ['project.godot'],
		dirs: ['.godot'],
		ignore: ['.godot/', '.import/', 'export_presets.cfg']
	},
	{
		id: 'cpp',
		label: 'C/C++',
		markers: ['CMakeLists.txt', 'Makefile', 'meson.build'],
		dirs: ['build', 'cmake-build-debug'],
		ignore: ['build/', 'cmake-build-*/', '*.o', '*.obj', '*.a', '*.so', '*.dll', '*.exe']
	},
	{
		id: 'web-static',
		label: '静态站点',
		markers: ['index.html'],
		dirs: [],
		ignore: []
	}
]);

/**
 * Detect the stacks present in a directory listing.
 *
 * @param {{ files: string[], dirs: string[] }} listing top-level names
 * @returns {{ id: string, label: string, ignore: string[] }[]}
 */
export function detectStacks(listing) {
	const files = new Set((listing?.files ?? []).map(escapeName => String(escapeName).toLowerCase()));
	const dirs = new Set(listing?.dirs ?? []);
	const found = [];
	for (const stack of STACKS) {
		const hitMarker = stack.markers.some(marker => {
			const lower = marker.toLowerCase();
			if (lower.includes('*')) {
				const suffix = lower.slice(lower.indexOf('*') + 1);
				return [...files].some(file => file.endsWith(suffix));
			}
			return files.has(lower);
		});
		const hitDir = stack.dirs.some(dir => dirs.has(dir));
		if (hitMarker || hitDir) found.push({ id: stack.id, label: stack.label, ignore: [...stack.ignore] });
	}
	return found;
}

/** Build .gitignore text from detected stacks; always includes the common tail. */
export function buildGitignore(stacks, extra = []) {
	const lines = [];
	const seen = new Set();
	const push = line => {
		if (line === '' || seen.has(line)) return;
		seen.add(line);
		lines.push(line);
	};
	for (const stack of stacks ?? []) {
		push(`# ${stack.label}`);
		for (const line of stack.ignore ?? []) push(line);
		lines.push('');
	}
	push('# 通用');
	for (const line of COMMON_IGNORES) push(line);
	for (const line of extra ?? []) push(line);
	return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/** True when a repo-relative path matches a sensitive name pattern. */
export function sensitivePathKind(path) {
	const normalized = String(path).replace(/\\/g, '/');
	const segments = normalized.split('/');
	const base = segments[segments.length - 1];
	if (SENSITIVE_NAMES.some(re => re.test(base))) return 'file';
	if (segments.some(segment => segment === '.ssh' || segment === '.aws' || segment === '.gnupg')) return 'dir';
	return undefined;
}

/**
 * Scan text content for credential signatures.
 *
 * @param {string} text
 * @returns {string[]} matched signature ids
 */
export function scanText(text) {
	const hits = [];
	for (const signature of SENSITIVE_CONTENT) {
		signature.re.lastIndex = 0;
		if (signature.re.test(text)) hits.push(signature.id);
	}
	return hits;
}

/** True when a path looks binary-by-extension and should skip content scanning. */
export function looksBinary(path) {
	return /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tgz|7z|rar|xz|bz2|exe|dll|so|dylib|bin|dat|wasm|mp[34]|wav|ogg|webm|mov|avi|ttf|otf|woff2?|db|sqlite3?|gpk|jsc|pak|unity3d|assets)$/i
		.test(String(path));
}

/** Human-readable byte size. */
export function formatBytes(bytes) {
	if (!Number.isFinite(bytes)) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Normalize a project folder name into a valid GitHub repository name. */
export function suggestRepoName(dir) {
	const base = String(dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
	const cleaned = base
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^[._-]+/, '')
		.replace(/[._-]+$/, '')
		.slice(0, 100);
	return cleaned.length > 0 ? cleaned : 'my-project';
}

/** Pick commit identity from explicit options, git facts, or a GitHub profile. */
export function resolveIdentity({ options, gitConfig, profile }) {
	const name = firstNonEmpty(
		options?.gitUserName,
		gitConfig?.name,
		profile?.login,
		'dsh-github-upload'
	);
	const email = firstNonEmpty(
		options?.gitUserEmail,
		gitConfig?.email,
		profile?.id !== undefined && profile?.login !== undefined
			? `${profile.id}+${profile.login}@users.noreply.github.com`
			: undefined,
		'dsh-github-upload@users.noreply.github.com'
	);
	return { name, email };
}

function firstNonEmpty(...values) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

/** Redact any credential-looking substring before it reaches a log or a model. */
export function redact(text, secrets = []) {
	let output = String(text ?? '');
	for (const secret of secrets) {
		if (typeof secret === 'string' && secret.length >= 8) {
			output = output.split(secret).join('***');
		}
	}
	return output
		.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '***')
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***')
		.replace(/(Authorization:\s*(?:basic|Bearer)\s+)\S+/gi, '$1***')
		.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, '$1***@');
}

/**
 * Drop every `undefined` value from a result tree.
 *
 * Tool results must be lossless JSON, and `undefined` is not a JSON value: a
 * single absent optional field would make the whole call fail validation. The
 * result shapes here legitimately carry absent optionals (an unconfigured
 * token has no login, a fresh project has no remote), so absent means "omit"
 * rather than "null" — a null would falsely claim the value is known to be
 * empty.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function stripUndefined(value) {
	if (Array.isArray(value)) return value.map(stripUndefined);
	if (value !== null && typeof value === 'object') {
		const output = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry === undefined) continue;
			output[key] = stripUndefined(entry);
		}
		return output;
	}
	return value;
}
