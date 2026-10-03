import { $ } from "bun";
import { readFileSync } from "node:fs";
import { REPO } from "./common.ts";

const ASTGREP = `${REPO}/node_modules/.bin/ast-grep`;

export async function applyRules(root: string, name: string) {
	const file = `${REPO}/patches/${name}`;
	const expect = new Map<string, number>();
	const targets = new Set<string>();
	for (const doc of readFileSync(file, "utf8").split(/^---$/m)) {
		const id = /^id: (\S+)/m.exec(doc)?.[1], count = /expect: (\d+)/.exec(doc)?.[1];
		if (!id || !count) throw new Error(`${name}: every rule needs an id and metadata.expect`);
		expect.set(id, Number(count));
		const files = /^files: \[(.+)\]$/m.exec(doc)?.[1];
		if (!files) throw new Error(`${name}: rule ${id} needs a files list`);
		for (const target of files.split(",")) targets.add(target.trim());
	}
	const scan = await $`${ASTGREP} scan -r ${file} ${[...targets]} --json=stream`.cwd(root).quiet().nothrow();
	const hits = new Map<string, number>();
	for (const line of scan.stdout.toString().split("\n")) {
		if (!line) continue;
		const id: string = JSON.parse(line).ruleId;
		hits.set(id, (hits.get(id) ?? 0) + 1);
	}
	for (const [id, want] of expect) {
		const got = hits.get(id) ?? 0;
		if (got !== want) throw new Error(`rule ${id} matched ${got} times, expected ${want}; update patches/${name} for this version`);
	}
	await $`${ASTGREP} scan -r ${file} ${[...targets]} -U`.cwd(root).quiet();
}
