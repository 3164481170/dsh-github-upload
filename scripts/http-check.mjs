/**
 * Live HTTP check against a booted host: status, preflight, and the token guard.
 *
 * Usage: node scripts/http-check.mjs <baseUrl> <projectPath>
 */

const base = process.argv[2] ?? 'http://127.0.0.1:19877';
const projectPath = process.argv[3] ?? process.cwd();

async function post(path, body) {
	const response = await fetch(`${base}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return { status: response.status, body: await response.json().catch(() => undefined) };
}

async function get(path) {
	const response = await fetch(`${base}${path}`);
	return { status: response.status, body: await response.json().catch(() => undefined) };
}

console.log('=== status ===');
const status = await get('/plugins/dsh-github-upload/status');
console.log('HTTP', status.status);
console.log(JSON.stringify(status.body, null, 2));

console.log('\n=== preflight (explicit path) ===');
const pre = await post('/plugins/dsh-github-upload/preflight', { path: projectPath });
console.log('HTTP', pre.status);
const r = pre.body?.result ?? {};
console.log('ok        :', r.ok);
console.log('projectDir:', r.projectDir);
console.log('repoName  :', r.repoName);
console.log('isGitRepo :', r.isGitRepo);
console.log('size      :', r.sizeText, '/', r.size?.files, 'files');
console.log('scanned   :', r.scannedFiles);
console.log('stacks    :', (r.stackLabels ?? []).join(', ') || '(none)');
console.log('sensitive :', (r.sensitive ?? []).length);
console.log('blockers  :', (r.blockers ?? []).join(' | '));
for (const s of r.steps ?? []) console.log(`  [${s.status}] ${s.name} — ${s.detail ?? ''}`);

console.log('\n=== upload without a token (must refuse) ===');
const upload = await post('/plugins/dsh-github-upload/upload', { path: projectPath, repo: 'probe-demo' });
console.log('HTTP', upload.status);
console.log('ok     :', upload.body?.ok);
console.log('error  :', upload.body?.result?.error ?? upload.body?.error);
console.log('steps  :');
for (const s of upload.body?.result?.steps ?? []) console.log(`  [${s.status}] ${s.name} — ${s.detail ?? ''}`);

console.log('\n=== dry run without a token (must refuse before writing) ===');
const dry = await post('/plugins/dsh-github-upload/upload', { path: projectPath, repo: 'probe-demo', dryRun: true });
console.log('HTTP', dry.status);
console.log('ok    :', dry.body?.ok);
console.log('error :', dry.body?.result?.error ?? dry.body?.error);
