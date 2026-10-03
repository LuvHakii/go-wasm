import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { applyRules } from "./rules.ts";
import { prepareSource } from "./source.ts";
import { GO, goEnv, hash, goVersion, NATIVE_GO, pin, REPO, ROOT, TINYGO, TINYGO_GOROOT, TOOLS } from "./common.ts";

const built = `${ROOT}/tinygo-out`;
const specs = [["link", "cmd/link", "", []], ["go", "cmd/go", "cmd_go_bootstrap", []], ["asm", "cmd/asm", "", []], ["gopls", ".", "", ["-stack-size=512KB"]], ["compile", "cmd/compile", "", ["-opt=1", "-gc=leaking", "-stack-size=512KB"]]] as const;
const commit = await pin("tinygo");

if (process.argv.includes("--merge")) await merge();
else await build();

// Builds the TinyGo tools into ROOT/tinygo-out from its own copy of the Go tree, so it can run beside build.ts.
async function build() {
	const version = await goVersion();
	const download = `${ROOT}/downloads/tinygo-${commit.slice(0, 8)}.tar.gz`;
	mkdirSync(`${ROOT}/downloads`, { recursive: true });
	if (!existsSync(download)) {
		const repo = "tinygo-org/tinygo";
		const runs: { id: number; name: string; conclusion: string | null }[] = JSON.parse(await $`gh api ${`repos/${repo}/actions/runs?head_sha=${commit}&per_page=100`}`.text()).workflow_runs;
		const run = runs.find(candidate => candidate.name === "Linux" && candidate.conclusion === "success");
		if (!run) throw new Error(`no successful Linux CI run for tinygo ${commit}; bump the tinygo pin to a commit that has one`);
		const listed: { id: number; name: string; expired: boolean }[] = JSON.parse(await $`gh api ${`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`}`.text()).artifacts;
		const artifact = listed.find(candidate => /^tinygo.*\.linux-amd64\.tar\.gz$/.test(candidate.name) && !candidate.expired);
		if (!artifact) throw new Error(`the TinyGo artifact for ${commit} has expired (CI artifacts last 90 days); bump the tinygo pin to a newer commit`);
		await Bun.write(download, (await $`gh api repos/${repo}/actions/artifacts/${artifact.id}/zip`.quiet()).stdout);
	}

	rmSync(TINYGO, { recursive: true, force: true });
	await $`tar -xzf ${download} -C ${ROOT}`;
	const tinygo = `${TINYGO}/bin/tinygo`;
	const reported = (await $`${tinygo} version`.text()).trim();
	if (!reported.includes(commit.slice(0, 8))) throw new Error(`unexpected TinyGo: ${reported}`);

	await applyRules(TINYGO, "tinygo-wasip1.yml");
	cpSync(`${REPO}/scripts/overlay-tinygo-src`, TINYGO, { recursive: true });

	await prepareSource(TINYGO_GOROOT);
	await $`${NATIVE_GO} run . -stubobj ${TINYGO_GOROOT}`.cwd(`${REPO}/scripts/trim`).env(goEnv({ GOROOT: GO }));
	rmSync(`${TINYGO}/src/internal/abi`, { recursive: true, force: true });
	cpSync(`${TINYGO_GOROOT}/src/internal/abi`, `${TINYGO}/src/internal/abi`, { recursive: true });
	for (const name of readdirSync(`${TINYGO}/src/internal/abi`)) if (name.endsWith("_test.go")) rmSync(`${TINYGO}/src/internal/abi/${name}`);
	mkdirSync(`${TINYGO_GOROOT}/bin`, { recursive: true });
	cpSync(NATIVE_GO, `${TINYGO_GOROOT}/bin/go`);

	cpSync(`${REPO}/scripts/overlay-tinygo`, TINYGO_GOROOT, { recursive: true });
	await applyRules(TINYGO_GOROOT, "go-tinygo-template-calls.yml");
	await applyRules(TINYGO_GOROOT, "go-tinygo-ssa-cache.yml");
	await $`${NATIVE_GO} run . -tinygo ${TINYGO_GOROOT}`.cwd(`${REPO}/scripts/trim`).env(goEnv({ GOROOT: GO }));

	const asmGoroot = `${ROOT}/tinygo-goroot-asm`;
	rmSync(asmGoroot, { recursive: true, force: true });
	cpSync(TINYGO_GOROOT, asmGoroot, { recursive: true });
	rmSync(`${asmGoroot}/src/cmd/internal/obj`, { recursive: true, force: true });
	cpSync(`${GO}/src/cmd/internal/obj`, `${asmGoroot}/src/cmd/internal/obj`, { recursive: true });

	rmSync(built, { recursive: true, force: true });
	mkdirSync(built, { recursive: true });
	const env = goEnv({
		GOROOT: TINYGO_GOROOT, GOFLAGS: "-mod=mod", PATH: `${TINYGO}/bin:${GO}/bin:${process.env.PATH}`,
		XDG_CACHE_HOME: `${ROOT}/tinygo-cache`, GOCACHE: `${ROOT}/tinygo-cache/go-build`,
	});
	await Promise.all(specs.map(async ([name, pkg, tags, flags]) => {
		const [goroot, cwd] = name === "asm" ? [asmGoroot, ROOT] : name === "gopls" ? [TINYGO_GOROOT, `${TOOLS}/gopls`] : [TINYGO_GOROOT, ROOT];
		const args = ["build", "-target=wasip1", "-no-debug", "-interp-timeout=30m", ...flags, `-ldflags=-X runtime.buildVersion=${version}`, ...(tags ? [`-tags=${tags}`] : []), "-o", `${built}/${name}.wasm`, pkg];
		console.log(`tinygo ${args.join(" ")}`);
		await $`${tinygo} ${args}`.cwd(cwd).env({ ...env, GOROOT: goroot });
	}));
	console.log(JSON.stringify({ built, tools: specs.map(([name]) => `${name}.wasm`) }));
}

// Lays the TinyGo tools over a copy of dist/ and rewrites their manifest entries.
async function merge() {
	const dist = `${REPO}/dist`;
	const out = `${REPO}/dist-tinygo`;
	if (!existsSync(`${dist}/tool-manifest.json`)) throw new Error("dist/ is missing; run build.ts first");
	rmSync(out, { recursive: true, force: true });
	cpSync(dist, out, { recursive: true });
	const manifestPath = `${out}/tool-manifest.json`;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const sizes: { path: string; size: number }[] = [];
	for (const [name] of specs) {
		const entry = manifest.artifacts.find((a: { path: string }) => a.path === `${name}.wasm`);
		if (!entry) throw new Error(`no manifest entry for ${name}.wasm`);
		const bytes = readFileSync(`${built}/${name}.wasm`);
		writeFileSync(`${out}/${name}.wasm`, bytes);
		entry.sha256 = createHash("sha256").update(bytes).digest("hex");
		entry.size = bytes.length;
		sizes.push({ path: `${name}.wasm`, size: bytes.length });
	}
	const files = (dir: string) => [...new Bun.Glob("**/*.go").scanSync({ cwd: `${REPO}/${dir}` })].sort().map(path => `${dir}/${path}`);
	const tinygoFiles = ["patches/tinygo-wasip1.yml", "patches/go-tinygo-template-calls.yml", "patches/go-tinygo-ssa-cache.yml", ...files("scripts/trim"), ...files("scripts/overlay-tinygo"), ...files("scripts/overlay-tinygo-src")];
	const tinygoHashes: { path: string; sha256: string }[] = [];
	for (const path of tinygoFiles) tinygoHashes.push({ path, sha256: await hash(`${REPO}/${path}`) });
	manifest.provenance.tinygo = { commit, files: tinygoHashes, tools: sizes.map(b => b.path) };
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
	console.log(JSON.stringify({ out, built: sizes }));
}
