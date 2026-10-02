import { $ } from "bun";
import { existsSync, statSync } from "node:fs";
import { goEnv, lock, ROOT, TINYGO, TINYGO_GOROOT } from "./common.ts";

const output = `${ROOT}/compile-tinygo.wasm`;
const env = goEnv({
	GOROOT: TINYGO_GOROOT, GOFLAGS: "-mod=mod", PATH: `${TINYGO}/bin:${ROOT}/go/bin:${process.env.PATH}`,
	XDG_CACHE_HOME: `${ROOT}/tinygo-cache`, GOCACHE: `${ROOT}/tinygo-cache/go-build`,
});
const started = Date.now();
const run = await $`/usr/bin/time -v ${TINYGO}/bin/tinygo build -target=wasip1 -no-debug -interp-timeout=150m ${`-ldflags=-X runtime.buildVersion=${lock.go.version}`} -o ${output} cmd/compile`.cwd(ROOT).env(env).nothrow();
const stderr = run.stderr.toString();
const peak = /Maximum resident set size \(kbytes\): (\d+)/.exec(stderr)?.[1];
console.log(stderr.split("\n").filter(line => !line.startsWith("\t")).slice(-40).join("\n"));
console.log(JSON.stringify({ exitCode: run.exitCode, minutes: Math.round((Date.now() - started) / 60000), peakRssMiB: peak ? Math.round(Number(peak) / 1024) : undefined, sizeBytes: existsSync(output) ? statSync(output).size : undefined }));
process.exit(run.exitCode);
