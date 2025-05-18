import * as vscode from "vscode"
import { EventEmitter } from "node:events"
import { parse as parseYaml, stringify as dumpYaml } from "yaml"
import * as nodeFs from "node:fs/promises"
import * as path from "node:path"

import type { ModeConfig } from "../../schemas/index"

export interface DirEntryLike {
	name: string
	isFile(): boolean
	isDirectory(): boolean
}

export interface FileSystemLike {
	readFile(p: string, enc?: BufferEncoding): Promise<string>
	writeFile(p: string, d: string): Promise<void>
	mkdir(p: string, o?: { recursive: boolean }): Promise<string | undefined> // node returns string|undefined
	stat(p: string): Promise<{
		isFile(): boolean
		isDirectory(): boolean
	}>
	readdir(p: string): Promise<DirEntryLike[]>
}

const nodeFsAdapter: FileSystemLike = {
	readFile: (p, enc = "utf8") => nodeFs.readFile(p, { encoding: enc }) as Promise<string>,
	writeFile: (p, d) => nodeFs.writeFile(p, d),
	mkdir: (p, o) => nodeFs.mkdir(p, o),
	stat: (p) => nodeFs.stat(p),
	readdir: (p) => nodeFs.readdir(p, { withFileTypes: true }) as unknown as Promise<DirEntryLike[]>,
}

export interface YamlModesManagerOptions {
	/** テスト用に FS 実装を差し替える */
	fs?: FileSystemLike
	/** テスト用に TTL を短縮 */
	cacheTtlMs?: number
	/** テスト用ワークスペース Root */
	workspaceRoot?: string
	/** テスト用に Watcher を差し替え */
	watchFactory?: () => vscode.FileSystemWatcher
}

export class YamlModesManager {
	public dispose(): void {
		this.watcher.dispose()
	}
	public async getYamlModes(): Promise<ModeConfig[]> {
		return (await this.getModes()).map((m) => ({ ...m, format: "yaml" }))
	}
	public async updateYamlMode(slug: string, config: ModeConfig): Promise<void> {
		const filePath = this.getSingleYamlPath(slug, config.source)
		await this.fs.mkdir(path.dirname(filePath), { recursive: true })
		await this.fs.writeFile(filePath, dumpYaml({ ...config, slug }, { indent: 2 }))
		this.invalidate()
		await this.onUpdate()
	}
	public async deleteYamlMode(slug: string, source: "project" | "global"): Promise<void> {
		const filePath = this.getSingleYamlPath(slug, source)
		try {
			await nodeFs.unlink(filePath)
		} catch {
			/* ignore */
		}
		this.invalidate()
		await this.onUpdate()
	}

	private readonly fs: FileSystemLike
	private readonly ttl: number
	private readonly root: string
	private readonly watcher: vscode.FileSystemWatcher
	private readonly bus = new EventEmitter()
	private cache: ModeConfig[] | null = null
	private stamp = 0

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onUpdate: () => Promise<void>,
		opts: YamlModesManagerOptions = {},
	) {
		this.fs = opts.fs ?? nodeFsAdapter
		this.ttl = opts.cacheTtlMs ?? 10_000
		this.root = opts.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""
		if (!this.root) throw new Error("YamlModesManager: workspace not found")

		const pattern = new vscode.RelativePattern(this.root, ".roo/modes/**/*.{yaml,yml}")
		this.watcher = opts.watchFactory?.() ?? vscode.workspace.createFileSystemWatcher(pattern)

		this.watcher.onDidChange(this.invalidate)
		this.watcher.onDidCreate(this.invalidate)
		this.watcher.onDidDelete(this.invalidate)
	}

	private invalidate = () => {
		this.cache = null
		this.bus.emit("invalidate")
	}

	private async getModes(): Promise<ModeConfig[]> {
		const now = Date.now()
		if (this.cache && now - this.stamp < this.ttl) return this.cache

		const fresh = await this.scanModes()
		this.cache = fresh
		this.stamp = now
		return fresh
	}

	private async scanModes(): Promise<ModeConfig[]> {
		const base = `${this.root}/.roo/modes`
		await this.fs.mkdir(base, { recursive: true }).catch(() => void 0)

		const bucket: ModeConfig[] = []
		await this.walk(base, bucket, "project")
		return bucket
	}

	private async walk(dir: string, bucket: ModeConfig[], source: "project" | "global"): Promise<void> {
		let entries: DirEntryLike[] = []
		try {
			entries = await this.fs.readdir(dir)
		} catch {
			return
		}

		for (const e of entries) {
			const full = `${dir}/${e.name}`
			if (e.isDirectory()) {
				await this.walk(full, bucket, source)
			} else if (e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml"))) {
				try {
					const raw = await this.fs.readFile(full, "utf8")
					const mode = parseYaml(raw) as ModeConfig
					if (mode?.slug) {
						bucket.push({ ...mode, source })
					}
				} catch {
					/* ignore malformed yaml */
				}
			}
		}
	}

	private getSingleYamlPath(slug: string, source = "project"): string {
		if (source === "project") {
			return path.join(this.root, ".roo/modes", `${slug}.mode.yaml`)
		}
		return path.join(this.context.globalStorageUri.fsPath, "yaml-modes", `${slug}.mode.yaml`)
	}
}
