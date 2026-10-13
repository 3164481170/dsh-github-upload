/**
 * Pure-layer tests: stack detection, .gitignore generation, secret scanning,
 * repo-name derivation, and redaction. No filesystem, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildGitignore,
	detectStacks,
	formatBytes,
	redact,
	resolveIdentity,
	scanText,
	sensitivePathKind,
	stripUndefined,
	suggestRepoName
} from '../lib/detect.js';

test('detectStacks recognises a node project by package.json', () => {
	const stacks = detectStacks({ files: ['package.json', 'README.md'], dirs: [] });
	assert.deepEqual(stacks.map(s => s.id), ['node']);
});

test('detectStacks recognises several stacks at once', () => {
	const stacks = detectStacks({
		files: ['package.json', 'requirements.txt', 'Cargo.toml', 'go.mod'],
		dirs: []
	});
	assert.deepEqual(stacks.map(s => s.id).sort(), ['go', 'node', 'python', 'rust']);
});

test('detectStacks falls back to directory evidence', () => {
	const stacks = detectStacks({ files: [], dirs: ['node_modules'] });
	assert.deepEqual(stacks.map(s => s.id), ['node']);
});

test('detectStacks matches glob markers', () => {
	const stacks = detectStacks({ files: ['App.csproj'], dirs: [] });
	assert.deepEqual(stacks.map(s => s.id), ['dotnet']);
});

test('detectStacks returns nothing for an unknown tree', () => {
	assert.deepEqual(detectStacks({ files: ['notes.txt'], dirs: ['stuff'] }), []);
});

test('detectStacks tolerates missing input', () => {
	assert.deepEqual(detectStacks(undefined), []);
});

test('buildGitignore always carries the common tail and dedupes', () => {
	const stacks = detectStacks({ files: ['package.json'], dirs: [] });
	const text = buildGitignore(stacks);
	assert.match(text, /node_modules\//);
	assert.match(text, /\.DS_Store/);
	assert.ok(text.endsWith('\n'));
	// node_modules/ appears once even though the node template and the common
	// tail could both have contributed it.
	assert.equal(text.split('\n').filter(line => line === 'node_modules/').length, 1);
});

test('buildGitignore accepts extra lines', () => {
	const text = buildGitignore([], ['*.secret']);
	assert.match(text, /\*\.secret/);
});

test('sensitivePathKind flags credential filenames', () => {
	assert.equal(sensitivePathKind('.env'), 'file');
	assert.equal(sensitivePathKind('.env.local'), 'file');
	assert.equal(sensitivePathKind('config/.env.production'), 'file');
	assert.equal(sensitivePathKind('deploy/id_rsa'), 'file');
	assert.equal(sensitivePathKind('certs/server.pem'), 'file');
	assert.equal(sensitivePathKind('app/keystore.jks'), 'file');
	assert.equal(sensitivePathKind('secrets.yaml'), 'file');
});

test('sensitivePathKind flags credential directories', () => {
	assert.equal(sensitivePathKind('.ssh/x'), 'dir');
	assert.equal(sensitivePathKind('home/.aws/x'), 'dir');
});

test('sensitivePathKind leaves ordinary files alone', () => {
	assert.equal(sensitivePathKind('src/index.js'), undefined);
	assert.equal(sensitivePathKind('README.md'), undefined);
	assert.equal(sensitivePathKind('env.js'), undefined);
});

test('scanText finds a private key block', () => {
	const hits = scanText('-----BEGIN RSA PRIVATE KEY-----\nMIIE...');
	assert.ok(hits.includes('private-key-block'));
});

test('scanText finds a GitHub token', () => {
	const hits = scanText('const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";');
	assert.ok(hits.includes('github-token'));
});

test('scanText finds an AWS access key and a Slack token', () => {
	assert.ok(scanText('aws_access_key_id = AKIAIOSFODNN7EXAMPLE').includes('aws-access-key'));
	assert.ok(scanText('xoxb-1234567890-abcdefghijkl').includes('slack-token'));
});

test('scanText reports nothing for clean content', () => {
	assert.deepEqual(scanText('export const answer = 42;'), []);
});

test('scanText does not carry regex state between calls', () => {
	const text = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
	assert.deepEqual(scanText(text), scanText(text));
});

test('suggestRepoName normalizes a project folder name', () => {
	assert.equal(suggestRepoName('C:\\work\\My Project!'), 'my-project');
	assert.equal(suggestRepoName('/home/u/dsh-sysmon'), 'dsh-sysmon');
	assert.equal(suggestRepoName('UPPER_CASE'), 'upper_case');
	assert.equal(suggestRepoName('__weird__'), 'weird');
});

test('suggestRepoName never returns an empty name', () => {
	assert.equal(suggestRepoName('!!!'), 'my-project');
	assert.equal(suggestRepoName(undefined), 'my-project');
});

test('resolveIdentity prefers explicit options over everything', () => {
	const identity = resolveIdentity({
		options: { gitUserName: 'Alice', gitUserEmail: 'alice@example.com' },
		gitConfig: { name: 'Bob', email: 'bob@example.com' },
		profile: { login: 'carol', id: 7 }
	});
	assert.deepEqual(identity, { name: 'Alice', email: 'alice@example.com' });
});

test('resolveIdentity falls back to git config', () => {
	const identity = resolveIdentity({ options: {}, gitConfig: { name: 'Bob', email: 'bob@example.com' } });
	assert.deepEqual(identity, { name: 'Bob', email: 'bob@example.com' });
});

test('resolveIdentity derives a noreply address from the GitHub profile', () => {
	const identity = resolveIdentity({ options: {}, gitConfig: {}, profile: { login: 'carol', id: 42 } });
	assert.equal(identity.email, '42+carol@users.noreply.github.com');
	assert.equal(identity.name, 'carol');
});

test('resolveIdentity ignores blank strings', () => {
	const identity = resolveIdentity({ options: { gitUserName: '   ' }, gitConfig: { name: '' } });
	assert.equal(identity.name, 'dsh-github-upload');
	assert.match(identity.email, /@users\.noreply\.github\.com$/);
});

test('redact removes an exact secret', () => {
	assert.equal(redact('tok=secretvalue123', ['secretvalue123']), 'tok=***');
});

test('redact scrubs tokens by shape even when the exact value is unknown', () => {
	assert.match(redact('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), /\*\*\*/);
});

test('redact scrubs basic-auth URL credentials', () => {
	assert.equal(redact('https://user:pass@github.com/x/y.git'), 'https://***@github.com/x/y.git');
});

test('redact leaves ordinary text intact', () => {
	assert.equal(redact('git push origin main'), 'git push origin main');
});

test('formatBytes renders a human size', () => {
	assert.equal(formatBytes(0), '0 B');
	assert.equal(formatBytes(2048), '2.0 KB');
	assert.equal(formatBytes(15 * 1024 * 1024), '15 MB');
	assert.equal(formatBytes(undefined), '—');
});

// Tool results must survive lossless-JSON validation, which rejects undefined.

test('stripUndefined removes absent object fields', () => {
	assert.deepEqual(stripUndefined({ a: 1, b: undefined }), { a: 1 });
});

test('stripUndefined omits rather than nulls', () => {
	// A null would falsely claim the value is known-empty; absence is the truth.
	assert.deepEqual(stripUndefined({ login: undefined }), {});
});

test('stripUndefined keeps explicit nulls and falsey values', () => {
	assert.deepEqual(
		stripUndefined({ a: null, b: false, c: 0, d: '' }),
		{ a: null, b: false, c: 0, d: '' }
	);
});

test('stripUndefined recurses through nested objects and arrays', () => {
	assert.deepEqual(
		stripUndefined({ rows: [{ id: 1, note: undefined }, { nested: { deep: undefined, keep: 'x' } }] }),
		{ rows: [{ id: 1 }, { nested: { keep: 'x' } }] }
	);
});

test('stripUndefined survives a JSON round trip', () => {
	const input = { ok: true, owner: undefined, github: { login: undefined, scopes: undefined, repoExists: false } };
	const output = stripUndefined(input);
	const json = JSON.stringify(output);
	assert.equal(json, JSON.stringify(JSON.parse(json)));
});

test('stripUndefined passes scalars through', () => {
	assert.equal(stripUndefined('text'), 'text');
	assert.equal(stripUndefined(42), 42);
	assert.equal(stripUndefined(null), null);
});
