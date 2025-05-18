import type { Volume } from "memfs"
import type { FileSystemLike, DirEntryLike } from "../YamlModesManager"

/**
 * Build a FileSystemLike adapter around the given memfs Volume.
 * @param vol An empty (or pre-filled) memfs Volume instance.
 */
export function createMemFs(vol: Volume): FileSystemLike {
	const p = vol.promises

	return {
		readFile: (file, enc = "utf8") => p.readFile(file, { encoding: enc }) as Promise<string>,

		writeFile: (file, data) => p.writeFile(file, data),

		mkdir: (dir, opts) => p.mkdir(dir, opts),

		stat: (target) => p.stat(target),

		/**
		 * memfsʼ readdir lacks the `withFileTypes` option, so we emulate the
		 * Dirent-like API required by YamlModesManager.
		 */
		async readdir(dir): Promise<DirEntryLike[]> {
			const names = (await p.readdir(dir)) as string[]
			return Promise.all(
				names.map(async (name) => {
					const s = await p.stat(`${dir}/${name}`)
					return {
						name,
						isFile: () => s.isFile(),
						isDirectory: () => s.isDirectory(),
					}
				}),
			)
		},
	}
}
