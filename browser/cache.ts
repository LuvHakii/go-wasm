import type { SavedFile } from './host';

export class PersistentCache {
	private directory: FileSystemDirectoryHandle | undefined;
	async open(identity: string): Promise<SavedFile[]> {
		if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return [];
		const root = await navigator.storage.getDirectory();
		this.directory = await root.getDirectoryHandle(`browser-go-${identity}`, { create: true });
		const files: SavedFile[] = [];
		for await (const [name, handle] of (this.directory as FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
			if (handle.kind !== 'file') continue;
			const path = decodeURIComponent(name);
			if (!path.startsWith('/cache/') && !path.startsWith('/home/.cache/')) continue;
			const file = await (await this.directory.getFileHandle(name)).getFile();
			files.push({ path, bytes: new Uint8Array(await file.arrayBuffer()), readonly: false });
		}
		return files;
	}
	async save(files: SavedFile[], deleted: string[]): Promise<void> {
		if (!this.directory) return;
		for (const file of files) {
			if (!file.path.startsWith('/cache/') && !file.path.startsWith('/home/.cache/')) continue;
			const handle = await this.directory.getFileHandle(encodeURIComponent(file.path), { create: true });
			const stream = await handle.createWritable();
			await stream.write(file.bytes.slice());
			await stream.close();
		}
		for (const path of deleted) {
			if (!path.startsWith('/cache/') && !path.startsWith('/home/.cache/')) continue;
			try { await this.directory.removeEntry(encodeURIComponent(path)); }
			catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error; }
		}
	}
}
