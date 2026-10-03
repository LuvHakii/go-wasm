import { $ } from "bun";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "..");
export const ROOT = resolve(process.env.ROOT ?? `${homedir()}/go-wasm-build`);
export const GO = `${REPO}/go`;
export const NATIVE_GO = `${GO}/bin/go`;
export const TOOLS = `${REPO}/tools`;
export const HONNEF = `${REPO}/honnef-tools`;
export const SOURCE = `${ROOT}/tool-source`;
export const TINYGO = `${ROOT}/tinygo`;
export const TINYGO_GOROOT = `${ROOT}/tinygo-goroot`;

export function checkRoot() {
	mkdirSync(ROOT, { recursive: true });
	const real = realpathSync(ROOT);
	if (real === "/tmp" || real.startsWith("/tmp/") || real.startsWith("/usr/") || real === REPO) {
		throw new Error("ROOT must be outside /tmp, /usr and the repository");
	}
}

export async function hash(path: string) {
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(path)) digest.update(chunk);
	return digest.digest("hex");
}

export function goEnv(extra: Record<string, string> = {}) {
	return {
		...process.env,
		GOENV: "off", GOTOOLCHAIN: "local", GOWORK: "off", CGO_ENABLED: "0", GOEXPERIMENT: "", GOFLAGS: "",
		GOCACHE: `${ROOT}/native-cache`, GOMODCACHE: `${ROOT}/module-cache`, GOPATH: `${ROOT}/gopath`, GOTELEMETRY: "off",
		...extra,
	};
}

export function exists(path: string) {
	return existsSync(path);
}

export async function pin(path: string) {
	return (await $`git -C ${REPO} rev-parse HEAD:${path}`.text()).trim();
}

export async function tagAt(path: string, sha: string) {
	const url = (await $`git -C ${REPO} config -f .gitmodules submodule.${path}.url`.text()).trim();
	const refs = (await $`git ls-remote --tags ${url}`.text()).split("\n");
	for (const line of refs) {
		const [commit, ref] = line.split("\t");
		if (commit === sha && ref) return ref.replace("refs/tags/", "").replace(/\^\{\}$/, "");
	}
}

export async function goVersion() {
	const sha = await pin("go");
	const tag = await tagAt("go", sha);
	if (!tag?.startsWith("go")) throw new Error(`go is pinned to ${sha}, which is not a release tag`);
	return tag;
}

if (import.meta.main) {
	const goRevision = await pin("go"), toolsRevision = await pin("tools"), tinygoRevision = await pin("tinygo");
	if (process.argv.includes("--json")) {
		const patches = [...new Bun.Glob("*").scanSync({ cwd: `${REPO}/patches` })].sort();
		console.log(JSON.stringify({ goRev: await goVersion(), goBaseCommit: goRevision, toolsRev: (await tagAt("tools", toolsRevision)) ?? toolsRevision, toolsBaseCommit: toolsRevision, tinygoBaseCommit: tinygoRevision, patches }, null, 2));
	} else {
		console.log(`GO_REVISION=${goRevision}`);
		console.log(`TOOLS_REVISION=${toolsRevision}`);
		console.log(`TINYGO_REVISION=${tinygoRevision}`);
	}
}
