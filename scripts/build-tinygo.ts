import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { goEnv, hash, lock, NATIVE_GO, REPO, ROOT, SOURCE, TINYGO, TINYGO_GOROOT, TOOLS } from "./common.ts";

const download = `${ROOT}/downloads/tinygo-${lock.tinygo.commit.slice(0, 8)}.tar.gz`;
mkdirSync(`${ROOT}/downloads`, { recursive: true });
if (!existsSync(download)) {
	const response = await $`gh api repos/${lock.tinygo.repo}/actions/artifacts/${lock.tinygo.artifact}/zip`.quiet().nothrow();
	if (response.exitCode !== 0) throw new Error(`TinyGo artifact ${lock.tinygo.artifact} unavailable (expires ${lock.tinygo.expires}); bump source-lock.json\n${response.stderr}`);
	await Bun.write(download, response.stdout);
}
if (await hash(download) !== lock.tinygo.sha256) throw new Error("TinyGo artifact checksum mismatch");

rmSync(TINYGO, { recursive: true, force: true });
await $`tar -xzf ${download} -C ${ROOT}`;
const tinygo = `${TINYGO}/bin/tinygo`;
const reported = (await $`${tinygo} version`.text()).trim();
if (!reported.includes(lock.tinygo.commit.slice(0, 8))) throw new Error(`unexpected TinyGo: ${reported}`);

const patchFiles = [...new Bun.Glob("tinygo-*.patch").scanSync({ cwd: `${REPO}/patches` })].sort();
for (const file of patchFiles) {
	const applied = await $`git apply -v ${REPO}/patches/${file}`.cwd(TINYGO).quiet().nothrow();
	const text = applied.stdout.toString() + applied.stderr.toString();
	if (applied.exitCode !== 0 || text.includes("offset")) throw new Error(`patch ${file} does not apply cleanly\n${text}`);
	console.log(`patch ${file}`);
}

rmSync(`${TINYGO}/src/internal/abi`, { recursive: true, force: true });
cpSync(`${SOURCE}/src/internal/abi`, `${TINYGO}/src/internal/abi`, { recursive: true });
for (const name of readdirSync(`${TINYGO}/src/internal/abi`)) if (name.endsWith("_test.go")) rmSync(`${TINYGO}/src/internal/abi/${name}`);

rmSync(TINYGO_GOROOT, { recursive: true, force: true });
cpSync(SOURCE, TINYGO_GOROOT, { recursive: true });
mkdirSync(`${TINYGO_GOROOT}/bin`, { recursive: true });
cpSync(NATIVE_GO, `${TINYGO_GOROOT}/bin/go`);

cpSync(`${REPO}/scripts/overlay-tinygo`, TINYGO_GOROOT, { recursive: true });
const callMarkers: [string, string][] = [
	["text/template/exec.go", "evalCallSig"], ["text/template/funcs.go", "addValueFuncsSig"], ["cmd/go/internal/list/list.go", "template.Fn0"],
	["cmd/compile/internal/ssagen/ssa.go", "new(ssa.Cache)"],
];
for (const [target, marker] of callMarkers) {
	const file = `${TINYGO_GOROOT}/src/${target}`;
	await $`${ROOT}/bin/gopatch -p ${REPO}/scripts/gopatch/tinygo.patch ${file}`;
	if (!(await Bun.file(file).text()).includes(marker)) throw new Error(`gopatch tinygo.patch did not apply to ${target}; update scripts/gopatch/tinygo.patch for this Go version`);
}

const asmGoroot = `${ROOT}/tinygo-goroot-asm`;
rmSync(asmGoroot, { recursive: true, force: true });
cpSync(TINYGO_GOROOT, asmGoroot, { recursive: true });
rmSync(`${asmGoroot}/src/cmd/internal/obj`, { recursive: true, force: true });
cpSync(`${ROOT}/go/src/cmd/internal/obj`, `${asmGoroot}/src/cmd/internal/obj`, { recursive: true });

const dist = `${REPO}/dist`;
const out = `${REPO}/dist-tinygo`;
rmSync(out, { recursive: true, force: true });
cpSync(dist, out, { recursive: true });

const env = goEnv({
	GOROOT: TINYGO_GOROOT, GOFLAGS: "-mod=mod", PATH: `${TINYGO}/bin:${ROOT}/go/bin:${process.env.PATH}`,
	XDG_CACHE_HOME: `${ROOT}/tinygo-cache`, GOCACHE: `${ROOT}/tinygo-cache/go-build`,
});
const manifestPath = `${out}/tool-manifest.json`;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const built: { path: string; size: number }[] = [];
for (const [name, pkg, tags, goroot, cwd] of [["link", "cmd/link", "", TINYGO_GOROOT, ROOT], ["go", "cmd/go", "cmd_go_bootstrap", TINYGO_GOROOT, ROOT], ["asm", "cmd/asm", "", asmGoroot, ROOT], ["gopls", ".", "", TINYGO_GOROOT, `${TOOLS}/gopls`]] as const) {
	const output = `${out}/${name}.wasm`;
	const args = ["build", "-target=wasip1", "-no-debug", "-interp-timeout=30m", `-ldflags=-X runtime.buildVersion=${lock.go.version}`, ...(tags ? [`-tags=${tags}`] : []), "-o", output, pkg];
	console.log(`tinygo ${args.join(" ")}`);
	await $`${tinygo} ${args}`.cwd(cwd).env({ ...env, GOROOT: goroot });
	const entry = manifest.artifacts.find((a: { path: string }) => a.path === `${name}.wasm`);
	if (!entry) throw new Error(`no manifest entry for ${name}.wasm`);
	const bytes = readFileSync(output);
	entry.sha256 = createHash("sha256").update(bytes).digest("hex");
	entry.size = bytes.length;
	built.push({ path: `${name}.wasm`, size: bytes.length });
}
const tinygoFiles = [...patchFiles.map(p => `patches/${p}`), "scripts/gopatch/tinygo.patch", ...[...new Bun.Glob("**/*.go").scanSync({ cwd: `${REPO}/scripts/overlay-tinygo` })].sort().map(p => `scripts/overlay-tinygo/${p}`)];
const tinygoHashes: { path: string; sha256: string }[] = [];
for (const path of tinygoFiles) tinygoHashes.push({ path, sha256: await hash(`${REPO}/${path}`) });
manifest.provenance.tinygo = { commit: lock.tinygo.commit, artifact: lock.tinygo.artifact, files: tinygoHashes, tools: built.map(b => b.path) };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ out, built }));
