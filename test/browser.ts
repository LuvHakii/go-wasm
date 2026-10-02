import { cpSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { $ } from 'bun';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

let dist = './dist', scope = 'full', serve = false, host = '127.0.0.1', port = 0;
let positional = false;
for (const arg of Bun.argv.slice(2)) {
	if (arg === '--scope=step1') scope = 'step1';
	else if (arg === '--scope=bridge') scope = 'bridge';
	else if (arg === '--scope=runtime') scope = 'runtime';
	else if (arg === '--scope=editor') scope = 'editor';
	else if (arg === '--scope=build') scope = 'build';
	else if (arg === '--scope=capabilities') scope = 'capabilities';
	else if (arg === '--scope=bench') scope = 'bench';
	else if (arg === '--serve') serve = true;
	else if (arg.startsWith('--host=')) host = arg.slice(7);
	else if (arg.startsWith('--port=')) {
		port = Number(arg.slice(7));
		if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
	} else if (!arg.startsWith('-') && !positional) { dist = arg; positional = true; }
	else throw new Error(`Unknown argument: ${arg}`);
}
if (!serve && host !== '127.0.0.1') throw new Error('--host is only supported with --serve');
if (serve && scope === 'full') throw new Error('--serve needs an explicit --scope=step1|bridge|runtime|editor|build');
if (scope === 'full') {
    const scopes = ['step1', 'bridge', 'runtime', 'editor', 'build', 'capabilities'];
    for (const s of scopes) {
        const run = Bun.spawnSync(['bun', import.meta.path, dist, `--scope=${s}`], { stdout: 'inherit', stderr: 'inherit' });
        if (run.exitCode !== 0) { console.error(`scope ${s} failed`); process.exit(1); }
    }
    console.log(JSON.stringify({ ok: true, scopes, chromium: 'passed', safari: 'unverified: no Safari host; serve a scope with --serve and open it in Safari' }));
    process.exit(0);
}
const distPath = await realpath(resolve(dist));
const manifestFile = Bun.file(resolve(distPath, 'tool-manifest.json'));
const manifest: unknown = await manifestFile.json();
if (typeof manifest !== 'object' || manifest === null || !('artifacts' in manifest) || !Array.isArray(manifest.artifacts)) {
	throw new Error('Manifest must contain an artifacts array');
}
const routes: Record<string, Blob> = {
	'/': Bun.file(resolve(import.meta.dir, 'browser.html')),
	'/browser.html': Bun.file(resolve(import.meta.dir, 'browser.html')),
	'/source-lock.json': Bun.file(resolve(import.meta.dir, '../source-lock.json')),
	'/dist/tool-manifest.json': manifestFile,
};
for (const artifact of manifest.artifacts) {
	if (typeof artifact !== 'object' || artifact === null || !('path' in artifact) || typeof artifact.path !== 'string'
		|| !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(wasm|tar)$/.test(artifact.path)) throw new Error('Unsafe artifact path');
	const filePath = await realpath(resolve(distPath, artifact.path));
	if (!filePath.startsWith(distPath + sep)) throw new Error('Artifact escapes dist');
	const route = '/dist/' + artifact.path;
	if (Object.hasOwn(routes, route)) throw new Error('Duplicate manifest path');
	routes[route] = Bun.file(filePath);
}
const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, 'version-worker.ts')], target: 'browser', format: 'esm', minify: false });
if (!bundle.success || bundle.outputs.length !== 1) throw new Error('Version worker bundling failed: ' + bundle.logs.join('\n'));
const workerBundle = bundle.outputs[0];
if (!workerBundle) throw new Error('Version worker bundle missing');
routes['/version-worker.js'] = workerBundle;
if (scope === 'bridge') {
	const root = resolve(process.env.ROOT ?? `${homedir()}/go-wasm-build`);
	const bridge = `${root}/tools/go-wasm-bridge`;
	mkdirSync(bridge, { recursive: true });
	cpSync(resolve(import.meta.dir, 'bridge/main.go'), `${bridge}/main.go`);
	await $`${root}/go/bin/go build -buildvcs=false -o ${root}/bridge.wasm ./go-wasm-bridge`.cwd(`${root}/tools`).env({ ...process.env, GOOS: 'wasip1', GOARCH: 'wasm', GOEXPERIMENT: '', GOROOT: `${root}/tool-source`, GOTELEMETRY: 'off' });
	routes['/bridge.wasm'] = Bun.file(`${root}/bridge.wasm`);
	for (const name of ['bridge-worker', 'bridge-page']) {
		const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, `${name}.ts`)], target: 'browser', format: 'esm' });
		if (!built.success || !built.outputs[0]) throw new Error(built.logs.join('\n'));
		routes[`/${name}.js`] = built.outputs[0];
	}
	routes['/'] = new Blob(['<!doctype html><html lang="en"><meta charset="utf-8"><title>Go bridge acceptance</title><body><script type="module" src="/bridge-page.js"></script></body></html>']);
}
if (scope === 'runtime' || scope === 'editor' || scope === 'build' || scope === 'capabilities' || scope === 'bench') {
	routes['/probe.txt'] = new Blob(['probe-ok']);
	for (const [name, path] of [
		['tool-worker', '../browser/tool-worker.ts'], ['broker', '../browser/broker.ts'], ['runtime-page', './runtime-page.ts'],
	]) {
		if (!name || !path) throw new Error('Invalid runtime entrypoint');
		const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, path)], target: 'browser', format: 'esm' });
		if (!built.success || !built.outputs[0]) throw new Error(built.logs.join('\n'));
		routes[`/${name}.js`] = built.outputs[0];
	}
	routes['/'] = new Blob(['<!doctype html><html lang="en"><meta charset="utf-8"><title>Go runtime acceptance</title><body><script type="module" src="/runtime-page.js"></script></body></html>']);
}
function browserPssMiB(): number {
	let total = 0;
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			if (!/playwright|ms-playwright/.test(readFileSync(`/proc/${entry}/cmdline`, 'utf8'))) continue;
			total += Number(readFileSync(`/proc/${entry}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+) kB/m)?.[1] ?? 0);
		} catch {}
	}
	return total / 1024;
}

const headers = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'Cache-Control': 'no-store',
	'X-Content-Type-Options': 'nosniff',
};
const server = Bun.serve({
	hostname: host, port,
	fetch(request) {
		if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers });
		const path = new URL(request.url).pathname;
		if (!Object.hasOwn(routes, path)) return new Response('Not found', { status: 404, headers });
		const file = routes[path];
		const type = path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.tar') ? 'application/x-tar'
			: path.endsWith('.json') ? 'application/json' : path.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8';
		return new Response(request.method === 'HEAD' ? null : file, { headers: { ...headers, 'Content-Type': type } });
	},
});
const url = new URL(server.url);
url.searchParams.set('scope', scope);
if (process.env.BENCH_P) url.searchParams.set('p', process.env.BENCH_P);
if (process.env.WASI_TRACE) url.searchParams.set('trace', process.env.WASI_TRACE);
if (process.env.MEM_API) url.searchParams.set('mem', '1');
if (serve) {
	console.log(JSON.stringify({ url: url.href, scope, note: 'Open this same page in actual Safari. Remote hosts need HTTPS (or a localhost tunnel) for secure-context APIs. WebKit emulation is not Safari evidence.' }));
	process.once('SIGINT', () => server.stop(true));
	process.once('SIGTERM', () => server.stop(true));
} else {
	let browser;
	try {
		const { chromium } = await import('playwright');
		browser = await chromium.launch({ headless: !process.env.HEADFUL, args: process.env.CHROMIUM_ARGS ? process.env.CHROMIUM_ARGS.split(' ') : [] });
		const page = await browser.newPage();
		page.on('pageerror', error => console.error(error));
		let peakPssMiB = 0;
			const sampler = process.env.MEM_SAMPLE ? setInterval(() => { peakPssMiB = Math.max(peakPssMiB, browserPssMiB()); }, 200) : undefined;
			await page.goto(url.href, { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => '__done' in window && window.__done === true, null, { timeout: 600000 });
			if (sampler) { clearInterval(sampler); console.error(JSON.stringify({ peakPssMiB: Math.round(peakPssMiB) })); }
		const result: unknown = await page.evaluate(() => '__result' in window ? window.__result : null);
		console.log(JSON.stringify(result, null, 2));
		if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true) process.exitCode = 1;
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	} finally {
		try { await browser?.close(); } finally { server.stop(true); }
	}
}
