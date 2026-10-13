/**
 * dsh-github-upload — bounded filesystem walk + secret scan.
 *
 * The walk is deliberately conservative: it skips `.git`, respects a hard file
 * budget, never follows symlinks, and stops reading a file the moment the byte
 * ceiling is reached. Nothing here can walk out of the project root.
 */

import { readdir, readFile, stat, lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { looksBinary, scanText, sensitivePathKind } from './detect.js';

const SKIP_DIRS = new Set([
	'.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build',
	'.next', '.nuxt', '.cache', '.gradle', '.idea', '.vscode', 'Library', 'Temp', 'obj',
	'.mypy_cache', '.pytest_cache', '.ruff_cache', 'coverage', '.pnpm-store', '.npm',
	'bin', 'out', '.godot', '.import', 'cmake-build-debug', 'vendor', 'Pods'
]);

/** Top-level names, used for stack detection. */
export async function listTopLevel(projectDir) {
	const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
	const files = [];
	const dirs = [];
	for (const entry of entries) {
		if (entry.isDirectory()) dirs.push(entry.name);
		else if (entry.isFile()) files.push(entry.name);
	}
	return { files, dirs };
}

/**
 * Walk a project and report findings.
 *
 * @param {string} projectDir
 * @param {{ maxFiles?: number, maxDepth?: number, maxBytesPerFile?: number }} limits
 * @returns {Promise<{ findings: object[], scannedFiles: number, skippedLarge: number, truncated: boolean, totalBytes: number }>}
 */
export async function scanProject(projectDir, limits = {}) {
	const maxFiles = Number.isFinite(limits.maxFiles) ? limits.maxFiles : 20000;
	const maxDepth = Number.isFinite(limits.maxDepth) ? limits.maxDepth : 12;
	const maxBytesPerFile = Number.isFinite(limits.maxBytesPerFile) ? limits.maxBytesPerFile : 512 * 1024;

	const findings = [];
	let scannedFiles = 0;
	let skippedLarge = 0;
	let totalBytes = 0;
	let truncated = false;

	/** @type {{ dir: string, depth: number }[]} */
	const queue = [{ dir: projectDir, depth: 0 }];

	while (queue.length > 0) {
		if (scannedFiles >= maxFiles) {
			truncated = true;
			break;
		}
		const { dir, depth } = queue.shift();
		if (depth > maxDepth) {
			truncated = true;
			continue;
		}
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const absolute = join(dir, entry.name);
			const relPath = relative(projectDir, absolute).split(sep).join('/');

			// A symlink is reported but never followed: the target may sit outside
			// the project and must not be judged, read, or uploaded by accident.
			if (entry.isSymbolicLink()) {
				findings.push({ kind: 'symlink', path: relPath, note: '符号链接，内容不会被读取' });
				continue;
			}
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.git')) continue;
				const nameFinding = sensitivePathKind(`${relPath}/x`);
				if (nameFinding === 'dir') {
					findings.push({ kind: 'sensitive-dir', path: relPath, note: '目录名是凭据类路径' });
					continue;
				}
				queue.push({ dir: absolute, depth: depth + 1 });
				continue;
			}
			if (!entry.isFile()) continue;

			scannedFiles += 1;
			if (scannedFiles > maxFiles) {
				truncated = true;
				break;
			}

			if (sensitivePathKind(relPath) !== undefined) {
				findings.push({ kind: 'sensitive-file', path: relPath, note: '文件名属于常见凭据/密钥文件' });
			}
			if (looksBinary(relPath)) continue;

			const info = await lstat(absolute).catch(() => undefined);
			if (info === undefined) continue;
			if (info.size > maxBytesPerFile) {
				skippedLarge += 1;
				continue;
			}
			const bytes = await readFile(absolute).catch(() => undefined);
			if (bytes === undefined) continue;
			totalBytes += bytes.byteLength;
			// A NUL byte in the first block means binary regardless of extension.
			if (bytes.subarray(0, 8000).includes(0)) continue;
			const hits = scanText(bytes.toString('utf8'));
			if (hits.length > 0) {
				findings.push({ kind: 'secret-content', path: relPath, signatures: hits, note: '内容命中凭据特征' });
			}
		}
	}

	return { findings, scannedFiles, skippedLarge, truncated, totalBytes };
}

/** Total size of a directory tree, bounded by a file budget. */
export async function measureProject(projectDir, maxFiles = 60000) {
	let bytes = 0;
	let files = 0;
	const queue = [projectDir];
	while (queue.length > 0 && files < maxFiles) {
		const dir = queue.shift();
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.git')) continue;
				queue.push(join(dir, entry.name));
				continue;
			}
			if (!entry.isFile()) continue;
			const info = await stat(join(dir, entry.name)).catch(() => undefined);
			if (info === undefined) continue;
			bytes += info.size;
			files += 1;
		}
	}
	return { files, bytes };
}

export { SKIP_DIRS };
