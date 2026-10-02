import { $ } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..');
const root = resolve(process.env.ROOT ?? `${homedir()}/go-wasm-build`);
const dir = mkdtempSync(`${root}/compiler-smoke-`);
const go = `${root}/go/bin/go`;
const env = { ...process.env, GOROOT: `${root}/tool-source`, GOOS: 'wasip1', GOARCH: 'wasm', CGO_ENABLED: '0', GOEXPERIMENT: '', GOENV: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off', GOCACHE: `${root}/smoke-cache`, GOTELEMETRY: 'off' };
try {
	await Bun.write(`${dir}/go.mod`, 'module smoke\n\ngo 1.27.0\n');
	await Bun.write(`${dir}/main.go`, 'package main\nfunc main() { println("compiler smoke") }\n');
	const exports = await $`${go} list -export -deps -f ${'{{if .Export}}packagefile {{.ImportPath}}={{.Export}}{{end}}'} runtime`.env(env).cwd(dir).text();
	await Bun.write(`${dir}/importcfg`, exports);
	await $`node ${repo}/test/wasi-run.mjs ${repo}/dist/compile.wasm -p main -importcfg ${dir}/importcfg -o ${dir}/main.a ${dir}/main.go`.env(env);
	await $`node ${repo}/test/wasi-run.mjs ${repo}/dist/link.wasm -importcfg ${dir}/importcfg -o ${dir}/main.wasm ${dir}/main.a`.env(env);
	const result = await $`node ${repo}/test/wasi-run.mjs ${dir}/main.wasm`.env(env).quiet();
	if (result.stderr.toString().replace(/\(node:\d+\) ExperimentalWarning: WASI is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g, '').trim() !== 'compiler smoke') throw new Error(result.stderr.toString());
	for (const tool of ['compile', 'link']) {
		const rejected = await $`node ${repo}/test/wasi-run.mjs ${repo}/dist/${tool}.wasm -V=full`.env({ ...env, GOOS: 'linux', GOARCH: 'amd64' }).quiet().nothrow();
		if (rejected.exitCode === 0 || !rejected.stderr.toString().includes('unknown architecture "amd64"')) throw new Error(`${tool} accepted unsupported target`);
	}
	console.log(JSON.stringify({ ok: true, compiledAndLinkedInWasm: true, output: 'compiler smoke', unsupportedTargetsRejected: true }));
} finally {
	rmSync(dir, { recursive: true, force: true });
}
