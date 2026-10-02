import { $ } from "bun";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import lock from "../source-lock.json";

export { lock };

export const REPO = resolve(import.meta.dir, "..");
export const ROOT = resolve(process.env.ROOT ?? `${homedir()}/go-wasm-build`);
export const GO = `${ROOT}/go`;
export const NATIVE_GO = `${GO}/bin/go`;
export const TOOLS = `${ROOT}/tools`;
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

export async function patches(dir: string, files: string[]) {
	await $`git -C ${dir} checkout -- .`;
	await $`git -C ${dir} clean -fdq`;
	for (const file of files) {
		const out = await $`git -C ${dir} apply -v ${REPO}/patches/${file}`.quiet().nothrow();
		const text = out.stdout.toString() + out.stderr.toString();
		if (out.exitCode !== 0 || text.includes("offset")) throw new Error(`patch ${file} does not apply cleanly\n${text}`);
		console.log(`patch ${file}`);
	}
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

if (import.meta.main) {
	console.log(`GO_VERSION=${lock.go.version}`);
	console.log(`TOOLS_REV=${lock.tools.rev}`);
	console.log(`TINYGO_COMMIT=${lock.tinygo.commit}`);
}
