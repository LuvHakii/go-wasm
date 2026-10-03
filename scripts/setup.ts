import { $ } from "bun";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { applyRules } from "./rules.ts";
import { checkRoot, GO, goEnv, lock, NATIVE_GO, REPO, ROOT, TOOLS } from "./common.ts";

checkRoot();
const { version, revision, sha256, url } = lock.go;
mkdirSync(`${ROOT}/downloads`, { recursive: true });
const archive = `${ROOT}/downloads/${version}.src.tar.gz`;
if (!existsSync(archive)) await $`curl -fsSL -o ${archive} ${url}`;
if (createHash("sha256").update(await Bun.file(archive).bytes()).digest("hex") !== sha256) {
	throw new Error(`source archive checksum mismatch: ${archive}`);
}
if (!existsSync(GO)) await $`tar -xzf ${archive} -C ${ROOT}`;
if (!(await Bun.file(`${GO}/VERSION`).text()).startsWith(`${version}\n`)) throw new Error("unexpected Go source VERSION");
const bootstrap = process.env.GOROOT_BOOTSTRAP ?? (await $`go env GOROOT`.text()).trim();
const env = goEnv({ GOROOT_BOOTSTRAP: bootstrap });
if (!existsSync(NATIVE_GO)) await $`./make.bash`.cwd(`${GO}/src`).env(env);
const builtVersion = (await $`${NATIVE_GO} version`.env(env).text()).trim();
if (!builtVersion.startsWith(`go version ${version} `)) throw new Error(`unexpected bootstrap: ${builtVersion}`);

if (!existsSync(`${TOOLS}/.git`)) {
	mkdirSync(TOOLS, { recursive: true });
	await $`git -C ${TOOLS} init -q`;
	await $`git -C ${TOOLS} remote add origin ${lock.tools.url}`;
}
await $`git -C ${TOOLS} fetch -q --depth 1 origin ${lock.tools.rev}`;
await $`git -C ${TOOLS} checkout -q --force FETCH_HEAD`;
await $`git -C ${TOOLS} clean -fdq`;

for (const dir of [TOOLS, `${TOOLS}/gopls`, `${REPO}/scripts/trim`]) await $`${NATIVE_GO} mod download`.cwd(dir).env(env);
await $`${NATIVE_GO} run . -tools ${TOOLS}`.cwd(`${REPO}/scripts/trim`).env(env);
cpSync(`${REPO}/scripts/overlay-tools`, TOOLS, { recursive: true });

const honnefVersion = (await $`${NATIVE_GO} list -m -f ${"{{.Version}}"} honnef.co/go/tools`.cwd(`${TOOLS}/gopls`).env(env).text()).trim();
const honnef = `${ROOT}/honnef-tools`;
rmSync(honnef, { recursive: true, force: true });
cpSync(`${ROOT}/module-cache/honnef.co/go/tools@${honnefVersion}`, honnef, { recursive: true });
const writable = (dir: string) => { chmodSync(dir, 0o755); for (const name of readdirSync(dir)) { const path = `${dir}/${name}`; if (statSync(path).isDirectory()) writable(path); else chmodSync(path, 0o644); } };
writable(honnef);
await applyRules(honnef, "honnef.yml");
await $`${NATIVE_GO} mod edit -replace=honnef.co/go/tools=../../honnef-tools`.cwd(`${TOOLS}/gopls`).env(env);
await Bun.write(`${ROOT}/source.json`, JSON.stringify({ version, revision, sha256, bootstrap, builtVersion, toolsRev: lock.tools.rev }, null, 2) + "\n");
console.log(JSON.stringify({ root: ROOT, version, revision, sha256, builtVersion, toolsRev: lock.tools.rev }));
