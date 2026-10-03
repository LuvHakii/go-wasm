import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { applyRules } from "./rules.ts";
import { GO, goEnv, hash, goVersion, NATIVE_GO, pin, REPO, ROOT, SOURCE, TINYGO, TINYGO_GOROOT, TOOLS } from "./common.ts";

const commit = await pin("tinygo"), version = await goVersion();
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

rmSync(`${TINYGO}/src/internal/abi`, { recursive: true, force: true });
cpSync(`${SOURCE}/src/internal/abi`, `${TINYGO}/src/internal/abi`, { recursive: true });
for (const name of readdirSync(`${TINYGO}/src/internal/abi`)) if (name.endsWith("_test.go")) rmSync(`${TINYGO}/src/internal/abi/${name}`);

rmSync(TINYGO_GOROOT, { recursive: true, force: true });
cpSync(SOURCE, TINYGO_GOROOT, { recursive: true });
mkdirSync(`${TINYGO_GOROOT}/bin`, { recursive: true });
cpSync(NATIVE_GO, `${TINYGO_GOROOT}/bin/go`);

cpSync(`${REPO}/scripts/overlay-tinygo`, TINYGO_GOROOT, { recursive: true });
await applyRules(TINYGO_GOROOT, "go-tinygo-template-calls.yml");
await applyRules(TINYGO_GOROOT, "go-tinygo-ssa-cache.yml");

const asmGoroot = `${ROOT}/tinygo-goroot-asm`;
rmSync(asmGoroot, { recursive: true, force: true });
cpSync(TINYGO_GOROOT, asmGoroot, { recursive: true });
rmSync(`${asmGoroot}/src/cmd/internal/obj`, { recursive: true, force: true });
cpSync(`${GO}/src/cmd/internal/obj`, `${asmGoroot}/src/cmd/internal/obj`, { recursive: true });

const dist = `${REPO}/dist`;
const out = `${REPO}/dist-tinygo`;
rmSync(out, { recursive: true, force: true });
cpSync(dist, out, { recursive: true });

const env = goEnv({
	GOROOT: TINYGO_GOROOT, GOFLAGS: "-mod=mod", PATH: `${TINYGO}/bin:${GO}/bin:${process.env.PATH}`,
	XDG_CACHE_HOME: `${ROOT}/tinygo-cache`, GOCACHE: `${ROOT}/tinygo-cache/go-build`,
});
const manifestPath = `${out}/tool-manifest.json`;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const built: { path: string; size: number }[] = [];
const specs = [["link", "cmd/link", "", TINYGO_GOROOT, ROOT, []], ["go", "cmd/go", "cmd_go_bootstrap", TINYGO_GOROOT, ROOT, []], ["asm", "cmd/asm", "", asmGoroot, ROOT, []], ["gopls", ".", "", TINYGO_GOROOT, `${TOOLS}/gopls`, ["-stack-size=512KB"]]] as const;
await Promise.all(specs.map(async ([name, pkg, tags, goroot, cwd, flags]) => {
	const args = ["build", "-target=wasip1", "-no-debug", "-interp-timeout=30m", ...flags, `-ldflags=-X runtime.buildVersion=${version}`, ...(tags ? [`-tags=${tags}`] : []), "-o", `${out}/${name}.wasm`, pkg];
	console.log(`tinygo ${args.join(" ")}`);
	await $`${tinygo} ${args}`.cwd(cwd).env({ ...env, GOROOT: goroot });
}));
for (const [name] of specs) {
	const entry = manifest.artifacts.find((a: { path: string }) => a.path === `${name}.wasm`);
	if (!entry) throw new Error(`no manifest entry for ${name}.wasm`);
	const bytes = readFileSync(`${out}/${name}.wasm`);
	entry.sha256 = createHash("sha256").update(bytes).digest("hex");
	entry.size = bytes.length;
	built.push({ path: `${name}.wasm`, size: bytes.length });
}
const overlays = (dir: string) => [...new Bun.Glob("**/*.go").scanSync({ cwd: `${REPO}/${dir}` })].sort().map(path => `${dir}/${path}`);
const tinygoFiles = ["patches/tinygo-wasip1.yml", "patches/go-tinygo-template-calls.yml", "patches/go-tinygo-ssa-cache.yml", ...overlays("scripts/overlay-tinygo"), ...overlays("scripts/overlay-tinygo-src")];
const tinygoHashes: { path: string; sha256: string }[] = [];
for (const path of tinygoFiles) tinygoHashes.push({ path, sha256: await hash(`${REPO}/${path}`) });
manifest.provenance.tinygo = { commit, files: tinygoHashes, tools: built.map(b => b.path) };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ out, built }));
