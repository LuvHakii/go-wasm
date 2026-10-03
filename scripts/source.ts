import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { applyRules } from "./rules.ts";
import { GO, goEnv, goVersion, NATIVE_GO, REPO, TOOLS } from "./common.ts";

export const generatedSources = [
	"src/cmd/cgo/zdefaultcc.go", "src/cmd/go/internal/cfg/zdefaultcc.go", "src/cmd/internal/objabi/zbootstrap.go",
	"src/internal/buildcfg/zbootstrap.go", "src/internal/runtime/sys/zversion.go", "src/time/tzdata/zzipdata.go",
];

// A pristine copy of the pinned Go tree with the codemod, rules and overlays applied; build.ts and build-tinygo.ts each take their own.
export async function prepareSource(dest: string) {
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(dest, { recursive: true });
	await $`git -C ${GO} archive --format=tar HEAD | tar -x -C ${dest}`;
	await Bun.write(`${dest}/VERSION`, `${await goVersion()}\n`);
	cpSync(`${GO}/pkg/tool`, `${dest}/pkg/tool`, { recursive: true });
	cpSync(`${GO}/pkg/include`, `${dest}/pkg/include`, { recursive: true });
	for (const path of generatedSources) {
		if (!existsSync(`${GO}/${path}`)) throw new Error(`missing native make.bash-generated source: ${path}`);
		mkdirSync(dirname(`${dest}/${path}`), { recursive: true });
		cpSync(`${GO}/${path}`, `${dest}/${path}`);
	}

	// Source changes: one name-anchored AST codemod plus new overlay files. No line-based diffs.
	await $`${NATIVE_GO} run . ${dest}`.cwd(`${REPO}/scripts/trim`).env(goEnv({ GOROOT: GO }));
	await applyRules(dest, "go-browser-toolexec.yml");
	cpSync(`${REPO}/scripts/overlay`, dest, { recursive: true });
	cpSync(`${TOOLS}/internal/browserhost`, `${dest}/src/internal/browserhost`, { recursive: true });
}
