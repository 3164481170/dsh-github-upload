/**
 * Apply-harness: run the plugin's apply() against a mock ctx that records every
 * registration. Proves the plugin wires its tools and routes without a live Host.
 */

const calls = [];

function makeCtx(services) {
	const ctx = {
		logger: { info: m => calls.push(['log', m]), warn: m => calls.push(['warn', m]) },
		effect: (fn, label) => { calls.push(['effect', label]); return () => {}; },
		get: name => services[name],
		// Real Cordis hands the callback a *derived* context whose own properties
		// carry the injected services. Model exactly that — a callback reading
		// `webCtx.webServer` must see the service, not undefined.
		inject: (names, cb) => {
			calls.push(['inject', names.join(',')]);
			const missing = names.filter(n => services[n] === undefined);
			if (missing.length > 0) {
				calls.push(['inject-deferred', missing.join(',')]);
				return;
			}
			const derived = { ...ctx };
			for (const name of names) derived[name] = services[name];
			cb(derived);
		},
		on: () => () => {}
	};
	return ctx;
}

const services = {
	subprocess: { resolveExecutable: async () => 'git', spawn: () => { throw new Error('not used'); } },
	tools: {
		register: definition => {
			calls.push(['tool', definition.name]);
			return () => {};
		}
	},
	webServer: {
		register: route => {
			calls.push(['route', route.path]);
			return () => {};
		}
	},
	credentials: {
		resolve: async () => undefined,
		describe: async () => ({ configured: false, writable: true }),
		set: async () => {},
		unset: async () => {}
	},
	sandboxPolicy: { workspaceRoot: process.cwd() }
};

const mod = await import('../lib/index.js');
console.log('name          :', mod.name);
console.log('inject        :', JSON.stringify(mod.inject));
console.log('Config is fn  :', typeof mod.Config);

let ok = true;
try {
	mod.apply(makeCtx(services), {
		tokenRef: 'GITHUB_TOKEN',
		defaultPrivate: true,
		defaultBranch: 'main',
		commitMessage: '',
		allowSensitive: false,
		timeoutMs: 600000,
		maxScanFiles: 8000
	});
} catch (error) {
	ok = false;
	console.log('\nAPPLY THREW:', error);
	console.log(error.stack);
}

console.log('\n=== 调用记录 ===');
for (const entry of calls) console.log(' ', entry[0].padEnd(16), entry.slice(1).join(' '));
console.log('\napply threw:', ok ? 'no' : 'YES');

// ---- also verify apply() tolerates a composition with no tools/webServer ----
console.log('\n=== 最小组合（只有 subprocess）===');
let minimalOk = true;
try {
	mod.apply(makeCtx({ subprocess: services.subprocess }), {});
} catch (error) {
	minimalOk = false;
	console.log('minimal APPLY THREW:', error.message);
}
console.log('minimal apply threw:', minimalOk ? 'no' : 'YES');
