import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { goEnv, hash, lock, NATIVE_GO, REPO, ROOT, SOURCE, TINYGO, TINYGO_GOROOT } from "./common.ts";

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
for (const [name, pkg] of [["link", "cmd/link"]] as const) {
	const output = `${out}/${name}.wasm`;
	const args = ["build", "-target=wasip1", "-no-debug", "-o", output, pkg];
	console.log(`tinygo ${args.join(" ")}`);
	await $`${tinygo} ${args}`.cwd(ROOT).env(env);
	const entry = manifest.artifacts.find((a: { path: string }) => a.path === `${name}.wasm`);
	if (!entry) throw new Error(`no manifest entry for ${name}.wasm`);
	const bytes = readFileSync(output);
	entry.sha256 = createHash("sha256").update(bytes).digest("hex");
	entry.size = bytes.length;
	built.push({ path: `${name}.wasm`, size: bytes.length });
}
manifest.provenance.tinygo = { commit: lock.tinygo.commit, artifact: lock.tinygo.artifact, patches: patchFiles, tools: built.map(b => b.path) };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ out, built }));
