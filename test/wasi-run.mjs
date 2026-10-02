import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';

const [binary, ...args] = process.argv.slice(2);
if (!binary) throw new Error('usage: node test/wasi-run.mjs binary [args]');
const wasi = new WASI({ version: 'preview1', args: [binary, ...args], env: process.env, preopens: { '/': '/' }, returnOnExit: true });
const { instance } = await WebAssembly.instantiate(await readFile(binary), wasi.getImportObject());
process.exitCode = wasi.start(instance);
