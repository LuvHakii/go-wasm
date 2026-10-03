import { $ } from "bun";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { applyRules } from "./rules.ts";
import { checkRoot, GO, goEnv, goVersion, HONNEF, NATIVE_GO, pin, REPO, ROOT, TOOLS } from "./common.ts";

checkRoot();
await $`git -C ${REPO} submodule update --init --depth 1 go tools`;
const version = await goVersion(), toolsRevision = await pin("tools");

await Bun.write(`${GO}/VERSION`, `${version}\n`);
const bootstrap = process.env.GOROOT_BOOTSTRAP ?? (await $`go env GOROOT`.text()).trim();
const env = goEnv({ GOROOT_BOOTSTRAP: bootstrap });
const native = existsSync(NATIVE_GO) ? (await $`${NATIVE_GO} version`.env({ ...env, GOROOT: GO }).nothrow().text()).trim() : "";
if (!native.startsWith(`go version ${version} `)) await $`./make.bash`.cwd(`${GO}/src`).env(env);
const builtVersion = (await $`${NATIVE_GO} version`.env({ ...env, GOROOT: GO }).text()).trim();
if (!builtVersion.startsWith(`go version ${version} `)) throw new Error(`unexpected bootstrap: ${builtVersion}`);

const files = (dir: string) => [...new Bun.Glob("**/*").scanSync({ cwd: `${REPO}/${dir}`, onlyFiles: true })].sort().map(path => `${REPO}/${dir}/${path}`);
const inputs = [...files("scripts/trim"), ...files("scripts/overlay-tools"), `${REPO}/patches/honnef-doc-replaceall.yml`, `${REPO}/scripts/setup.ts`, `${REPO}/scripts/rules.ts`];
const digest = createHash("sha256");
for (const path of inputs) digest.update(path.slice(REPO.length)).update(readFileSync(path));
const want = `${toolsRevision} ${digest.digest("hex")}`;
const marker = `${TOOLS}/.patched`;
if ((await Bun.file(marker).text().catch(() => "")) !== want) {
	if (existsSync(`${TOOLS}/.git`)) {
		await $`git -C ${TOOLS} reset -q --hard`;
		await $`git -C ${TOOLS} clean -fdq`;
	}
	await $`git -C ${REPO} submodule update --init --depth 1 tools`;
	for (const dir of [TOOLS, `${TOOLS}/gopls`, `${REPO}/scripts/trim`]) await $`${NATIVE_GO} mod download`.cwd(dir).env({ ...env, GOROOT: GO });
	await $`${NATIVE_GO} run . -tools ${TOOLS}`.cwd(`${REPO}/scripts/trim`).env({ ...env, GOROOT: GO });
	cpSync(`${REPO}/scripts/overlay-tools`, TOOLS, { recursive: true });

	const honnefVersion = (await $`${NATIVE_GO} list -m -f ${"{{.Version}}"} honnef.co/go/tools`.cwd(`${TOOLS}/gopls`).env({ ...env, GOROOT: GO }).text()).trim();
	rmSync(HONNEF, { recursive: true, force: true });
	cpSync(`${ROOT}/module-cache/honnef.co/go/tools@${honnefVersion}`, HONNEF, { recursive: true });
	const writable = (dir: string) => { chmodSync(dir, 0o755); for (const name of readdirSync(dir)) { const path = `${dir}/${name}`; if (statSync(path).isDirectory()) writable(path); else chmodSync(path, 0o644); } };
	writable(HONNEF);
	await applyRules(HONNEF, "honnef-doc-replaceall.yml");
	await $`${NATIVE_GO} mod edit -replace=honnef.co/go/tools=../../honnef-tools`.cwd(`${TOOLS}/gopls`).env({ ...env, GOROOT: GO });
	await Bun.write(marker, want);
}
console.log(JSON.stringify({ root: ROOT, version, goRevision: await pin("go"), toolsRevision, builtVersion }));
