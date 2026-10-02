import { $ } from "bun";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync } from "node:fs";
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
await $`${NATIVE_GO} install github.com/uber-go/gopatch@v0.4.0`.env({ ...env, GOBIN: `${ROOT}/bin` });
await Bun.write(`${ROOT}/source.json`, JSON.stringify({ version, revision, sha256, bootstrap, builtVersion, toolsRev: lock.tools.rev }, null, 2) + "\n");
console.log(JSON.stringify({ root: ROOT, version, revision, sha256, builtVersion, toolsRev: lock.tools.rev }));
