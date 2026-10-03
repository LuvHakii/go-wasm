import { $ } from "bun";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { generatedSources, prepareSource } from "./source.ts";
import { checkRoot, GO, goVersion, hash, NATIVE_GO as nativeGo, pin, REPO as repo, ROOT as root, SOURCE as source, TOOLS as tools } from "./common.ts";

checkRoot();
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
	const version = await goVersion(), goRevision = await pin("go"), toolsRevision = await pin("tools");
	if ((await $`git -C ${tools} rev-parse HEAD`.text()).trim() !== toolsRevision) throw new Error("tools checkout differs from its pin; run setup");
	if (!(await Bun.file(`${tools}/.patched`).text().catch(() => "")).startsWith(toolsRevision)) throw new Error("tools is not patched for its pin; run setup");
	const nativeVersion = (await $`${nativeGo} version`.env({ ...env, GOROOT: GO }).text()).trim();
	if (!nativeVersion.startsWith(`go version ${version} `)) throw new Error(`unexpected native bootstrap: ${nativeVersion}`);
	await prepareSource(source);
	const { GOOS: _os, GOARCH: _arch, ...hostEnv } = env;
	const patches: { path: string; sha256: string; target: "go" }[] = [];
	const patchFiles = ["patches/go-browser-toolexec.yml", "patches/honnef-doc-replaceall.yml"];
	const goFiles = (dir: string) => [...new Bun.Glob("**/*.go").scanSync({ cwd: `${repo}/${dir}` })].sort().map(p => `${dir}/${p}`);
	for (const path of [...goFiles("scripts/trim"), ...patchFiles, ...goFiles("scripts/overlay"), ...goFiles("scripts/overlay-tools")]) {
		patches.push({ path, sha256: await hash(`${repo}/${path}`), target: "go" });
	}

	staging = mkdtempSync(`${repo}/.dist-stage-`);
	// cmd_go_bootstrap swaps net/http, vcs and auth for stubs: the browser go command never fetches.
	const buildTool = async (name: string, pkg: string, cwd: string, tags = "") => {
		await $`${nativeGo} build -mod=readonly -buildvcs=false -trimpath -tags=${tags} -ldflags=${buildSettings.ldflags} -o ${staging}/${name}.wasm ${pkg}`.env(env).cwd(cwd);
		return { path: `${name}.wasm`, goVersion: version, goSourceRevision: goRevision, buildSettings, toolPackage: pkg };
	};
	// Independent builds share the content-addressed GOCACHE; asm must finish before stubobj, which edits the obj packages it reads.
	const earlier = await Promise.all([buildTool("go", "cmd/go", source, "cmd_go_bootstrap"), buildTool("link", "cmd/link", source), buildTool("asm", "cmd/asm", source), buildTool("gopls", ".", `${tools}/gopls`)]);
	await $`${nativeGo} run . -stubobj ${source}`.cwd(`${repo}/scripts/trim`).env({ ...hostEnv, GOROOT: GO });
	// compile, the std list and the two std seeds read nothing the others write.
	const compiled = buildTool("compile", "cmd/compile", source);

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
	const seeds = await Promise.all(["wasip1", "js"].map(async GOOS => {
		const cachePath = `${GOOS}_wasm`;
		const GOCACHE = `${seedRoot}/${cachePath}`;
		mkdirSync(GOCACHE, { recursive: true });
		await $`${nativeGo} build -mod=readonly -trimpath -ldflags=${buildSettings.ldflags} ${seedRoots}`.env({ ...env, GOOS, GOCACHE }).cwd(source);
		const entryFiles = [...new Bun.Glob("[0-9a-f][0-9a-f]/*").scanSync({ cwd: GOCACHE, onlyFiles: true })].length;
		if (entryFiles === 0) throw new Error(`standard library cache is empty for ${GOOS}/wasm`);
		return { GOOS, GOARCH: "wasm", CGO_ENABLED: "0", GOEXPERIMENT: "", GOFLAGS: "", trimpath: true, ldflags: buildSettings.ldflags, cachePath, entryFiles };
	}));
	const buildMetadata = [...earlier, await compiled];
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
		schemaVersion: 1, goVersion: version, goSourceRevision: goRevision,
		buildSettings, artifacts, toolBuildSettings: { trimpath: true, mod: "readonly", GOWORK: "off", GOTOOLCHAIN: "local" },
		toolVersions: { go: version, compile: version, link: version, asm: version, gopls: "(devel)" },
		provenance: { toolsRevision, toolsSourceSha256, sourceFileCount: toolsSources.length, untrackedSources: untracked, moduleFiles, patches, nativeGoVersion: nativeVersion, nativeToolHashes, generatedSources, buildMetadata },
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
