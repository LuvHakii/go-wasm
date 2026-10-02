import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { benchEdits, benchFiles, benchGoMod, benchPackage } from './bench-project';

const root = process.env.ROOT ?? `${process.env.HOME}/go-wasm-build`;
const goroot = `${root}/go`;
const go = `${goroot}/bin/go`;
const seedRoots = [
	'fmt', 'os', 'strings', 'sort', 'errors', 'sync', 'sync/atomic', 'time', 'bufio', 'bytes', 'io', 'io/fs', 'math', 'math/rand',
	'strconv', 'unicode', 'context', 'slices', 'maps', 'reflect', 'embed', 'flag', 'log', 'regexp', 'path', 'path/filepath',
	'encoding/json', 'text/template', 'unicode/utf8', 'container/list', 'math/bits', 'runtime/debug',
];
const runs = Number(process.env.RUNS ?? 3);
const baseEnv = { ...process.env, GOROOT: goroot, GOOS: 'wasip1', GOARCH: 'wasm', CGO_ENABLED: '0', GOEXPERIMENT: '', GOPROXY: 'off', GOTELEMETRY: 'off', GOENV: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '' };

const work = mkdtempSync(join(tmpdir(), 'bench-native-'));
const project = join(work, 'project');
const seed = join(work, 'seed-cache');
const write = (path: string, text: string) => { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), text); };
const reset = () => { rmSync(project, { recursive: true, force: true }); write('go.mod', benchGoMod); for (const [path, text] of Object.entries(benchFiles())) write(path, text); };

async function timed(args: string[], env: Record<string, string | undefined>, cwd: string) {
	const started = performance.now();
	const pin = process.env.PIN === '1';
	const proc = Bun.spawn(pin ? ['taskset', '-c', '0', go, ...args] : [go, ...args], { cwd, env: pin ? { ...env, GOMAXPROCS: '1' } : env, stdout: 'pipe', stderr: 'pipe' });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`go ${args.join(' ')}: ${out}${err}`);
	return performance.now() - started;
}

console.error('seeding std cache');
await timed(['build', '-trimpath', '-ldflags=-s -w', ...seedRoots], { ...baseEnv, GOCACHE: seed }, `${goroot}/src`);

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const configs: { label: string; parallel: number; seeded: boolean }[] = [
	{ label: '-p=1, std seeded (same as browser)', parallel: 1, seeded: true },
	{ label: '-p=16 (default), std seeded', parallel: 16, seeded: true },
	{ label: '-p=1, empty cache', parallel: 1, seeded: false },
];
const results: Record<string, Record<string, number>> = {};
for (const config of configs.filter(c => process.env.PIN !== '1' || c.parallel === 1 && c.seeded)) {
	const samples: Record<string, number[]> = {};
	for (let i = 0; i < runs; i++) {
		const cache = join(work, `cache-${i}`);
		rmSync(cache, { recursive: true, force: true });
		if (config.seeded) cpSync(seed, cache, { recursive: true }); else mkdirSync(cache);
		reset();
		const env = { ...baseEnv, GOCACHE: cache, GOFLAGS: `-p=${config.parallel} -trimpath` };
		const build = ['build', '-o', join(work, 'bench.wasm'), benchPackage];
		const step = async (label: string) => { (samples[label] ??= []).push(await timed(build, env, project)); };
		await step('cold');
		await step('no-op rebuild');
		for (const edit of benchEdits) { write(edit.path, edit.text); await step(edit.label); }
	}
	results[config.label] = Object.fromEntries(Object.entries(samples).map(([label, values]) => [label, Math.round(median(values))]));
}

const log = join(work, 'tools.log');
const wrapper = join(work, 'toolexec.sh');
writeFileSync(wrapper, '#!/bin/bash\ns=$(date +%s%N)\n"$@"\nrc=$?\ne=$(date +%s%N)\necho "$(basename "$1") $(( (e-s)/1000000 ))" >> "$TOOLLOG"\nexit $rc\n', { mode: 0o755 });
const cache = join(work, 'cache-tools');
cpSync(seed, cache, { recursive: true });
reset();
await timed(['build', '-toolexec', wrapper, '-o', join(work, 'bench.wasm'), benchPackage], { ...baseEnv, GOCACHE: cache, GOFLAGS: '-p=1 -trimpath', TOOLLOG: log }, project);
const tools: Record<string, { calls: number; totalMs: number; medianMs: number }> = {};
if (existsSync(log)) {
	const byTool: Record<string, number[]> = {};
	for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) { const [tool, ms] = line.split(' '); (byTool[tool!] ??= []).push(Number(ms)); }
	for (const [tool, values] of Object.entries(byTool)) tools[tool] = { calls: values.length, totalMs: values.reduce((a, b) => a + b, 0), medianMs: median(values) };
}
console.log(JSON.stringify({ goVersion: (await Bun.$`${go} version`.env(baseEnv).text()).trim(), cpus: navigator.hardwareConcurrency, runs, medianWallMs: results, toolexecColdSeededP1: tools }, null, 2));
rmSync(work, { recursive: true, force: true });
