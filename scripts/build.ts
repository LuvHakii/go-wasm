import { $ } from "bun";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { checkRoot, hash, lock, NATIVE_GO as nativeGo, REPO as repo, ROOT as root, SOURCE as source, TOOLS as tools } from "./common.ts";

checkRoot();
const archive = `${root}/downloads/${lock.go.version}.src.tar.gz`;
const buildSettings = { GOOS: "wasip1", GOARCH: "wasm", CGO_ENABLED: "0", GOEXPERIMENT: "", ldflags: "-s -w" };
const env = {
	...process.env,
	GOENV: "off", GOTOOLCHAIN: "local", GOWORK: "off", CGO_ENABLED: "0", GOEXPERIMENT: "", GOFLAGS: "",
	GOOS: "wasip1", GOARCH: "wasm", GOROOT: source,
	GOCACHE: `${root}/tool-cache`, GOMODCACHE: `${root}/module-cache`, GOPATH: `${root}/gopath`, GOTMPDIR: `${root}/tmp`,
	GOPROXY: "off", GOTOOLDIR: "", GOCACHEPROG: "", GO111MODULE: "on", GOTELEMETRY: "off",
};
mkdirSync(env.GOTMPDIR, { recursive: true });

const buildLock = `${root}/build.lock`;
mkdirSync(buildLock);
let staging: string | undefined;
try {
	if (await hash(archive) !== lock.go.sha256) throw new Error("source archive checksum differs from source-lock.json; run setup");
	const toolsRevision = (await $`git -C ${tools} rev-parse HEAD`.text()).trim();
	if (toolsRevision !== lock.tools.rev) throw new Error("x/tools checkout differs from source-lock.json; run setup");
	const nativeVersion = (await $`${nativeGo} version`.env({ ...env, GOROOT: `${root}/go` }).text()).trim();
	if (!nativeVersion.startsWith(`go version ${lock.go.version} `)) throw new Error(`unexpected native bootstrap: ${nativeVersion}`);
	rmSync(source, { recursive: true, force: true });
	mkdirSync(source, { recursive: true });
	await $`tar -xzf ${archive} --strip-components=1 -C ${source}`;
	const sourceVersion = (await Bun.file(`${source}/VERSION`).text()).split("\n")[0];
	if (sourceVersion !== lock.go.version) throw new Error("source archive VERSION differs from source-lock.json");
	cpSync(`${root}/go/pkg/tool`, `${source}/pkg/tool`, { recursive: true });
	cpSync(`${root}/go/pkg/include`, `${source}/pkg/include`, { recursive: true });
	const generatedSources = [
		"src/cmd/cgo/zdefaultcc.go", "src/cmd/go/internal/cfg/zdefaultcc.go", "src/cmd/internal/objabi/zbootstrap.go",
		"src/internal/buildcfg/zbootstrap.go", "src/internal/runtime/sys/zversion.go", "src/time/tzdata/zzipdata.go",
	];
	for (const path of generatedSources) {
		if (!existsSync(`${root}/go/${path}`)) throw new Error(`missing native make.bash-generated source: ${path}`);
		mkdirSync(dirname(`${source}/${path}`), { recursive: true });
		cpSync(`${root}/go/${path}`, `${source}/${path}`);
	}

	// Source changes: one name-anchored AST codemod plus new overlay files. No line-based diffs.
	const { GOOS: _os, GOARCH: _arch, ...hostEnv } = env;
	await $`${nativeGo} run . ${source}`.cwd(`${repo}/scripts/trim`).env({ ...hostEnv, GOROOT: `${root}/go` });
	// gopatch silently does nothing when its pattern misses, so every target must gain its browser call.
	const insertions: [string, string][] = [
		["cmd/go/internal/work/shell.go", "browserRunOut"],
		["cmd/go/internal/work/buildid.go", "browserToolID"],
		["cmd/go/internal/base/tool.go", "browserToolPath"],
	];
	for (const [target, marker] of insertions) {
		const file = `${source}/src/${target}`;
		await $`${root}/bin/gopatch -p ${repo}/scripts/gopatch/browser.patch ${file}`;
		if (!(await Bun.file(file).text()).includes(marker)) throw new Error(`gopatch browser.patch did not apply to ${target}; update scripts/gopatch for this Go version`);
	}
	cpSync(`${repo}/scripts/overlay`, source, { recursive: true });
	cpSync(`${tools}/internal/browserhost`, `${source}/src/internal/browserhost`, { recursive: true });
	const patches: { path: string; sha256: string; target: "go" }[] = [];
	const gopatchFiles = [...new Bun.Glob("*.patch").scanSync({ cwd: `${repo}/scripts/gopatch` })].sort().map(p => `scripts/gopatch/${p}`);
	const patchFiles = [...new Bun.Glob("*.patch").scanSync({ cwd: `${repo}/patches` })].sort().map(p => `patches/${p}`);
	const goFiles = (dir: string) => [...new Bun.Glob("**/*.go").scanSync({ cwd: `${repo}/${dir}` })].sort().map(p => `${dir}/${p}`);
	for (const path of [...goFiles("scripts/trim"), ...patchFiles, ...gopatchFiles, ...goFiles("scripts/overlay"), ...goFiles("scripts/overlay-tools")]) {
		patches.push({ path, sha256: await hash(`${repo}/${path}`), target: "go" });
	}

	staging = mkdtempSync(`${repo}/.dist-stage-`);
	const buildMetadata: { path: string; goVersion: string; goSourceRevision: string; buildSettings: typeof buildSettings; sourceArchiveSha256: string; toolPackage: string }[] = [];
	for (const [name, pkg, cwd] of [
		["go", "cmd/go", source], ["link", "cmd/link", source], ["asm", "cmd/asm", source], ["gopls", ".", `${tools}/gopls`], ["compile", "cmd/compile", source],
	]) {
		if (!name || !pkg || !cwd) throw new Error("invalid tool build specification");
		// asm needs the real arch assemblers, so only compile (built last) gets constants-only obj packages.
		if (name === "compile") await $`${nativeGo} run . -stubobj ${source}`.cwd(`${repo}/scripts/trim`).env({ ...hostEnv, GOROOT: `${root}/go` });
		// cmd_go_bootstrap swaps net/http, vcs and auth for stubs: the browser go command never fetches.
		const tags = name === "go" ? "cmd_go_bootstrap" : "";
		await $`${nativeGo} build -mod=readonly -buildvcs=false -trimpath -tags=${tags} -ldflags=${buildSettings.ldflags} -o ${staging}/${name}.wasm ${pkg}`.env(env).cwd(cwd);
		buildMetadata.push({ path: `${name}.wasm`, goVersion: lock.go.version, goSourceRevision: lock.go.revision, buildSettings, sourceArchiveSha256: lock.go.sha256, toolPackage: pkg });
	}

	const bundledPaths = ["lib", "pkg/include", "VERSION", "go.env", "LICENSE", "PATENTS"];
	const selectedSources = new Set<string>();
	const template = '{{.Dir}}|{{join .GoFiles ","}}|{{join .SFiles ","}}|{{join .HFiles ","}}|{{join .EmbedFiles ","}}|{{join .SysoFiles ","}}';
	for (const GOOS of ["wasip1", "js"]) {
		const listed = await $`${nativeGo} list -mod=readonly -f ${template} std`.env({ ...env, GOOS }).cwd(source).text();
		for (const line of listed.trim().split("\n")) {
			const [directory, ...groups] = line.split("|");
			if (!directory || !directory.startsWith(`${source}/src/`)) throw new Error(`Unexpected standard package directory: ${directory}`);
			for (const name of groups.flatMap(group => group.split(",")).filter(Boolean)) {
				const path = `${directory.slice(source.length + 1)}/${name}`;
				if (path.split("/").includes("..")) throw new Error(`Unsafe source path: ${path}`);
				selectedSources.add(path);
			}
		}
	}
	bundledPaths.push(...[...selectedSources].sort());
	const tarFlags = ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--format=posix", "--pax-option=delete=atime,delete=ctime"];
	const fileList = `${root}/goroot-files.txt`;
	await Bun.write(fileList, bundledPaths.join("\n") + "\n");
	await $`tar ${tarFlags} -cf ${staging}/goroot.tar -C ${source} -T ${fileList}`;
	// Packages outside this closure compile on demand in the browser and persist in OPFS.
	const seedRoots = [
		"fmt", "os", "strings", "sort", "errors", "sync", "sync/atomic", "time", "bufio", "bytes", "io", "io/fs", "math", "math/rand",
		"strconv", "unicode", "context", "slices", "maps", "reflect", "embed", "flag", "log", "regexp", "path", "path/filepath",
		"encoding/json", "text/template", "unicode/utf8", "container/list", "math/bits", "runtime/debug",
	];
	const seedRoot = `${root}/std-cache`;
	rmSync(seedRoot, { recursive: true, force: true });
	mkdirSync(seedRoot, { recursive: true });
	const seeds: { GOOS: string; GOARCH: string; CGO_ENABLED: string; GOEXPERIMENT: string; GOFLAGS: string; trimpath: boolean; ldflags: string; cachePath: string; entryFiles: number }[] = [];
	for (const GOOS of ["wasip1", "js"]) {
		const cachePath = `${GOOS}_wasm`;
		const GOCACHE = `${seedRoot}/${cachePath}`;
		mkdirSync(GOCACHE, { recursive: true });
		await $`${nativeGo} build -mod=readonly -trimpath -ldflags=${buildSettings.ldflags} ${seedRoots}`.env({ ...env, GOOS, GOCACHE }).cwd(source);
		const entryFiles = [...new Bun.Glob("[0-9a-f][0-9a-f]/*").scanSync({ cwd: GOCACHE, onlyFiles: true })].length;
		if (entryFiles === 0) throw new Error(`standard library cache is empty for ${GOOS}/wasm`);
		seeds.push({ GOOS, GOARCH: "wasm", CGO_ENABLED: "0", GOEXPERIMENT: "", GOFLAGS: "", trimpath: true, ldflags: buildSettings.ldflags, cachePath, entryFiles });
	}
	await $`tar ${tarFlags} -cf ${staging}/std-cache.tar -C ${seedRoot} wasip1_wasm`;
	await $`tar ${tarFlags} -cf ${staging}/std-cache-js.tar -C ${seedRoot} js_wasm`;

	const moduleFiles = [];
	for (const path of ["go.mod", "go.sum", "gopls/go.mod", "gopls/go.sum"]) moduleFiles.push({ path, sha256: await hash(`${tools}/${path}`) });
	const tracked = (await $`git -C ${tools} ls-files -z -- '*.go' go.mod go.sum gopls/go.mod gopls/go.sum`.text()).split("\0").filter(Boolean);
	const untracked = (await $`git -C ${tools} ls-files --others --exclude-standard -z`.text()).split("\0").filter(path => path.endsWith(".go") || path.endsWith("go.mod") || path.endsWith("go.sum"));
	const toolsSources = [];
	for (const path of [...new Set([...tracked, ...untracked])].filter(path => existsSync(`${tools}/${path}`)).sort()) toolsSources.push({ path, sha256: await hash(`${tools}/${path}`) });
	const toolsSourceSha256 = createHash("sha256").update(JSON.stringify(toolsSources)).digest("hex");
	const nativeToolHashes = [];
	for (const platform of readdirSync(`${source}/pkg/tool`)) {
		for (const name of readdirSync(`${source}/pkg/tool/${platform}`)) {
			const path = `pkg/tool/${platform}/${name}`;
			if (statSync(`${source}/${path}`).isFile()) nativeToolHashes.push({ path, sha256: await hash(`${source}/${path}`) });
		}
	}
	const artifacts: { path: string; kind: "tool" | "goroot" | "std-cache"; sha256: string; size: number }[] = [];
	for (const path of ["gopls.wasm", "go.wasm", "compile.wasm", "link.wasm", "asm.wasm", "goroot.tar", "std-cache.tar", "std-cache-js.tar"]) {
		const kind = path === "goroot.tar" ? "goroot" : path.startsWith("std-cache") ? "std-cache" : "tool";
		artifacts.push({ path, kind, sha256: await hash(`${staging}/${path}`), size: statSync(`${staging}/${path}`).size });
	}
	const manifest = {
		schemaVersion: 1, goVersion: lock.go.version, goSourceRevision: lock.go.revision, goSourceSha256: lock.go.sha256,
		buildSettings, artifacts, toolBuildSettings: { trimpath: true, mod: "readonly", GOWORK: "off", GOTOOLCHAIN: "local" },
		toolVersions: { go: lock.go.version, compile: lock.go.version, link: lock.go.version, asm: lock.go.version, gopls: "(devel)" },
		provenance: { toolsRevision, toolsSourceSha256, sourceFileCount: toolsSources.length, untrackedSources: untracked, moduleFiles, patches, nativeGoVersion: nativeVersion, nativeToolHashes, generatedSources, sourceArchiveSha256: lock.go.sha256, sourceArchiveUrl: lock.go.url, buildMetadata },
		goroot: { mountPath: "/goroot", bundledPaths },
		stdCache: { browserCompatibility: "requires browser acceptance for these artifact hashes", layout: "<goos>_wasm/<Go content-addressed cache entries>", archives: { wasip1: "std-cache.tar", js: "std-cache-js.tar" }, seeds },
	};
	await Bun.write(`${staging}/tool-manifest.json`, JSON.stringify(manifest, null, 2) + "\n");

	const dist = `${repo}/dist`;
	const previous = `${repo}/.dist-previous`;
	if (existsSync(previous)) throw new Error(".dist-previous exists; recover it before replacing dist");
	if (existsSync(dist)) renameSync(dist, previous);
	try { renameSync(staging, dist); }
	catch (error) { if (existsSync(previous)) renameSync(previous, dist); throw error; }
	staging = undefined;
	rmSync(previous, { recursive: true, force: true });
	console.log(JSON.stringify({ dist, artifacts, stdCacheBrowserCompatibility: "unverified" }));
} finally {
	if (staging) rmSync(staging, { recursive: true, force: true });
	rmSync(buildLock, { recursive: true, force: true });
}
