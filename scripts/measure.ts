import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createBrotliCompress, createGzip } from "node:zlib";

const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg.startsWith("-"))) throw new Error("usage: bun scripts/measure.ts [dist-directory]");
const dist = resolve(args[0] ?? "./dist");
const manifest: unknown = await Bun.file(`${dist}/tool-manifest.json`).json();
if (!manifest || typeof manifest !== "object" || !("schemaVersion" in manifest) || manifest.schemaVersion !== 1 || !("artifacts" in manifest) || !Array.isArray(manifest.artifacts)) {
	throw new Error("expected schemaVersion 1 tool-manifest.json with artifacts");
}
const artifacts: { path: string; sha256: string; size: number }[] = [];
const seen = new Set<string>();
for (const item of manifest.artifacts) {
	if (!item || typeof item !== "object" || !("path" in item) || typeof item.path !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.path) || item.path === "tool-manifest.json" || !("sha256" in item) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) || !("size" in item) || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0 || seen.has(item.path)) {
		throw new Error("invalid or duplicate manifest artifact");
	}
	seen.add(item.path);
	artifacts.push({ path: item.path, sha256: item.sha256, size: item.size });
}
for (const required of ["gopls.wasm", "go.wasm", "compile.wasm", "link.wasm", "goroot.tar", "std-cache.tar"]) {
	if (!seen.has(required)) throw new Error(`missing required artifact: ${required}`);
}
seen.add("tool-manifest.json");
const entries = await readdir(dist, { withFileTypes: true });
for (const entry of entries) {
	if (!entry.isFile() || !seen.has(entry.name)) throw new Error(`unlisted downloadable asset: ${entry.name}`);
}
if (entries.length !== seen.size) throw new Error("manifest assets are missing from dist");

const gzip = { level: 9, windowBits: 15, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const brotli = { quality: 11, lgwin: 22, mode: "generic" };
async function compressedSize(path: string, compression: "gzip" | "brotli") {
	let size = 0;
	const sink = new Writable({ write(chunk: Buffer, _encoding, done) { size += chunk.byteLength; done(); } });
	const transform = compression === "gzip" ? createGzip(gzip) : createBrotliCompress({ params: {
		[constants.BROTLI_PARAM_QUALITY]: brotli.quality,
		[constants.BROTLI_PARAM_LGWIN]: brotli.lgwin,
		[constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
	} });
	await pipeline(createReadStream(path), transform, sink);
	return size;
}

const assets: { path: string; sha256: string; raw: number; gzip: number; brotli: number }[] = [];
for (const item of [...artifacts, { path: "tool-manifest.json", sha256: "", size: -1 }]) {
	const path = `${dist}/${item.path}`;
	const digest = createHash("sha256");
	let raw = 0;
	for await (const chunk of createReadStream(path)) { digest.update(chunk); raw += chunk.byteLength; }
	const sha256 = digest.digest("hex");
	if (item.path !== "tool-manifest.json" && (sha256 !== item.sha256 || raw !== item.size)) throw new Error(`artifact hash/size mismatch: ${item.path}`);
	assets.push({ path: item.path, sha256, raw, gzip: await compressedSize(path, "gzip"), brotli: await compressedSize(path, "brotli") });
}
const total = assets.reduce((sum, asset) => ({ raw: sum.raw + asset.raw, gzip: sum.gzip + asset.gzip, brotli: sum.brotli + asset.brotli }), { raw: 0, gzip: 0, brotli: 0 });
console.log(JSON.stringify({
	schemaVersion: 1, dist, compression: { gzip, brotli, aggregation: "sum of individually compressed downloadable assets, including manifest", runtime: { bun: Bun.version, zlib: process.versions.zlib, brotli: process.versions.brotli } },
	assets, total, observations: { browserTimings: "not measured by this command", runtimeMemory: "not measured by this command", goHeap: "not measured by this command" },
}, null, 2));
