import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { applyRules } from "./rules.ts";
import { prepareSource } from "./source.ts";
import { GO, goEnv, hash, goVersion, NATIVE_GO, pin, REPO, ROOT, TINYGO, TINYGO_GOROOT, TOOLS } from "./common.ts";

const built = `${ROOT}/tinygo-out`;
const specs = [["link", "cmd/link", "", []], ["go", "cmd/go", "cmd_go_bootstrap", []], ["asm", "cmd/asm", "", []], ["gopls", ".", "", ["-stack-size=512KB"]], ["compile", "cmd/compile", "", ["-opt=1", "-stack-size=512KB"]]] as const;
const commit = await pin("tinygo");
const llvmRelease = "llvmorg-22.1.8", llvmAsset = "LLVM-22.1.8-Linux-X64";
const lldLibs = "-llldCOFF -llldCommon -llldELF -llldMachO -llldMinGW -llldWasm";

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
	const patched = await buildPatchedTinyGo();

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
		const started = performance.now();
		// The patched compiler gets its own cache: cached std objects must not be shared with the unpatched one.
		const toolEnv = name === "compile" ? { ...env, GOROOT: goroot, XDG_CACHE_HOME: `${ROOT}/tinygo-cache-patched`, GOCACHE: `${ROOT}/tinygo-cache-patched/go-build` } : { ...env, GOROOT: goroot };
		await $`${name === "compile" ? patched : tinygo} ${args}`.cwd(cwd).env(toolEnv);
		console.log(`tinygo ${name}: ${Math.round((performance.now() - started) / 1000)} s`);
	}));
	console.log(JSON.stringify({ built, tools: specs.map(([name]) => `${name}.wasm`) }));
}

// TinyGo built from the pinned commit with patches/tinygo-*.patch, linked against upstream's stock LLVM release (the wasm backend is untouched in TinyGo's LLVM fork).
async function buildPatchedTinyGo() {
	const llvm = `${ROOT}/llvm/${llvmAsset}`;
	if (!existsSync(`${llvm}/bin/llvm-config`)) {
		const tarball = `${ROOT}/downloads/${llvmAsset}.tar.xz`;
		if (!existsSync(tarball)) await $`gh release download ${llvmRelease} -R llvm/llvm-project -p ${`${llvmAsset}.tar.xz`} -D ${ROOT}/downloads`;
		mkdirSync(`${ROOT}/llvm`, { recursive: true });
		await $`tar -xJf ${tarball} -C ${ROOT}/llvm --wildcards ${`${llvmAsset}/include`} ${`${llvmAsset}/bin/llvm-config`} ${`${llvmAsset}/lib/lib*.a`} ${`${llvmAsset}/lib/libclang.so*`} ${`${llvmAsset}/lib/libclang-cpp.so*`}`;
		rmSync(tarball, { force: true });
	}
	const src = `${ROOT}/tinygo-src`;
	rmSync(src, { recursive: true, force: true });
	mkdirSync(src, { recursive: true });
	await $`git init -q ${src}`;
	await $`git -C ${src} fetch -q --depth 1 https://github.com/tinygo-org/tinygo.git ${commit}`;
	await $`git -C ${src} checkout -q FETCH_HEAD`;
	await applyRules(src, "tinygo-wasm-gc-roots.yml");
	const config = (...args: string[]) => $`${llvm}/bin/llvm-config ${args}`.text().then(text => text.trim());
	const system = (await config("--system-libs")).replace("/usr/lib/x86_64-linux-gnu/libzstd.a", "-lzstd").replace("/usr/lib/x86_64-linux-gnu/libz.a", "-lz");
	const ldflags = `-L${llvm}/lib -lclang -lclang-cpp -Wl,--start-group ${lldLibs} -Wl,--end-group ${await config("--ldflags", "--libs")} ${system} -lstdc++ -Wl,-rpath,${llvm}/lib`;
	const output = `${TINYGO}/bin/tinygo-patched`;
	await $`${NATIVE_GO} build -buildmode exe -o ${output} -tags ${"byollvm llvm22 osusergo"} .`.cwd(src).env(goEnv({
		GOROOT: GO, CGO_ENABLED: "1", CGO_CPPFLAGS: `${await config("--cppflags")} -I${llvm}/include`, CGO_CXXFLAGS: "-std=c++17", CGO_LDFLAGS: ldflags,
	}));
	console.log((await $`${output} version`.env({ ...process.env, TINYGOROOT: TINYGO }).text()).trim());
	return output;
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
	const tinygoFiles = ["patches/tinygo-wasip1.yml", "patches/go-tinygo-template-calls.yml", "patches/go-tinygo-ssa-cache.yml", "patches/tinygo-wasm-gc-roots.yml", ...files("scripts/trim"), ...files("scripts/overlay-tinygo"), ...files("scripts/overlay-tinygo-src")];
	const tinygoHashes: { path: string; sha256: string }[] = [];
	for (const path of tinygoFiles) tinygoHashes.push({ path, sha256: await hash(`${REPO}/${path}`) });
	manifest.provenance.tinygo = { commit, files: tinygoHashes, tools: sizes.map(b => b.path) };
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
	console.log(JSON.stringify({ out, built: sizes }));
}
