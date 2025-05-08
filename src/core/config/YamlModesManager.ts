import * as vscode from "vscode"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import type { ModeConfig } from "../../schemas/index"
import { fileExistsAtPath } from "../../utils/fs"
import { getWorkspacePath } from "../../utils/path"
import { logger } from "../../utils/logging"
import { loadModesFromDirectory, saveModeAsYaml } from "../../utils/yamlUtils"

export class YamlModesManager {
	private static readonly cacheTTL = 10_000

	private disposables: vscode.Disposable[] = []
	private isWriting = false
	private writeQueue: Array<() => Promise<void>> = []
	private cachedModes: ModeConfig[] | null = null
	private cachedAt = 0
	private editLock: Set<string> = new Set() // Tracks modes being edited in UI

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onUpdate: () => Promise<void>,
	) {
		this.watchYamlModesFiles()
	}

	private async queueWrite(operation: () => Promise<void>): Promise<void> {
		this.writeQueue.push(operation)

		if (!this.isWriting) {
			await this.processWriteQueue()
		}
	}

	private async processWriteQueue(): Promise<void> {
		if (this.writeQueue.length === 0) {
			return
		}

		this.isWriting = true

		try {
			const operation = this.writeQueue.shift()
			if (operation) {
				await operation()
			}
		} finally {
			this.isWriting = false

			if (this.writeQueue.length > 0) {
				await this.processWriteQueue()
			}
		}
	}

	private async watchYamlModesFiles(): Promise<void> {
		const workspacePath = getWorkspacePath()
		if (!workspacePath) {
			return
		}

		// Watch for changes in project .roo/modes directory
		const projectModesGlob = new vscode.RelativePattern(workspacePath, ".roo/modes/**/*.{yaml,yml}")

		// Create file watcher for project modes
		const projectWatcher = vscode.workspace.createFileSystemWatcher(projectModesGlob)
		this.disposables.push(projectWatcher)

		// Handle file changes
		projectWatcher.onDidChange(async (uri) => {
			const filePath = uri.fsPath
			const fileName = path.basename(filePath)
			const slug = path.parse(fileName).name

			// Skip if mode is being edited in UI
			if (this.editLock.has(slug)) {
				return
			}

			logger.info(`Project mode file changed: ${filePath}`)
			this.clearCache()
			await this.onUpdate()
		})

		// Handle file creation
		projectWatcher.onDidCreate(async (uri) => {
			logger.info(`Project mode file created: ${uri.fsPath}`)
			this.clearCache()
			await this.onUpdate()
		})

		// Handle file deletion
		projectWatcher.onDidDelete(async (uri) => {
			logger.info(`Project mode file deleted: ${uri.fsPath}`)
			this.clearCache()
			await this.onUpdate()
		})

		// Watch for changes in global modes directory
		const globalModesDir = path.join(this.context.globalStorageUri.fsPath, "modes")
		try {
			await fs.mkdir(globalModesDir, { recursive: true })

			// Create file watcher for global modes
			const globalModesGlob = new vscode.RelativePattern(vscode.Uri.file(globalModesDir), "**/*.{yaml,yml}")
			const globalWatcher = vscode.workspace.createFileSystemWatcher(globalModesGlob)
			this.disposables.push(globalWatcher)

			// Handle file changes
			globalWatcher.onDidChange(async (uri) => {
				const filePath = uri.fsPath
				const fileName = path.basename(filePath)
				const slug = path.parse(fileName).name

				// Skip if mode is being edited in UI
				if (this.editLock.has(slug)) {
					return
				}

				logger.info(`Global mode file changed: ${filePath}`)
				this.clearCache()
				await this.onUpdate()
			})

			// Handle file creation
			globalWatcher.onDidCreate(async (uri) => {
				logger.info(`Global mode file created: ${uri.fsPath}`)
				this.clearCache()
				await this.onUpdate()
			})

			// Handle file deletion
			globalWatcher.onDidDelete(async (uri) => {
				logger.info(`Global mode file deleted: ${uri.fsPath}`)
				this.clearCache()
				await this.onUpdate()
			})
		} catch (error) {
			logger.error(`Failed to set up global modes directory watcher: ${error}`)
		}
	}

	/**
	 * Get all modes from YAML files
	 */
	public async getYamlModes(): Promise<ModeConfig[]> {
		const now = Date.now()

		// Return cached modes if they're still valid
		if (this.cachedModes && now - this.cachedAt < YamlModesManager.cacheTTL) {
			return this.cachedModes
		}

		try {
			// Load modes from global storage
			const globalModesDir = path.join(this.context.globalStorageUri.fsPath, "modes")
			const globalModes = await loadModesFromDirectory(globalModesDir)

			// Load modes from project .roo/modes directory
			const workspacePath = getWorkspacePath()
			let projectModes: ModeConfig[] = []

			if (workspacePath) {
				const projectModesDir = path.join(workspacePath, ".roo", "modes")
				projectModes = await loadModesFromDirectory(projectModesDir)
			}

			// Create maps to store modes by source
			const projectModesMap = new Map<string, ModeConfig>()
			const globalModesMap = new Map<string, ModeConfig>()

			// Add project modes (they take precedence)
			for (const mode of projectModes) {
				projectModesMap.set(mode.slug, mode)
			}

			// Add global modes
			for (const mode of globalModes) {
				if (!projectModesMap.has(mode.slug)) {
					globalModesMap.set(mode.slug, mode)
				}
			}

			// Combine modes in the correct order: project modes first, then global modes
			const mergedModes = [...Array.from(projectModesMap.values()), ...Array.from(globalModesMap.values())]

			this.cachedModes = mergedModes
			this.cachedAt = now

			return mergedModes
		} catch (error) {
			logger.error(`Failed to load YAML modes: ${error}`)
			return []
		}
	}

	/**
	 * Update a mode in YAML format
	 */
	public async updateYamlMode(slug: string, config: ModeConfig): Promise<void> {
		// 編集ロックのタイムアウトを設定（5秒後に自動解除）
		const lockTimeout = setTimeout(() => {
			this.editLock.delete(slug)
			logger.debug(`Auto-releasing edit lock for ${slug} after timeout`)
		}, 5000)

		try {
			// Lock the mode to prevent file watcher from reloading while we're editing
			this.editLock.add(slug)
			logger.debug(`Edit lock acquired for ${slug}`)

			const isProjectMode = config.source === "project"
			let targetDir: string

			if (isProjectMode) {
				const workspacePath = getWorkspacePath()
				if (!workspacePath) {
					throw new Error("No workspace folder found for project-specific mode")
				}

				targetDir = path.join(workspacePath, ".roo", "modes")
			} else {
				targetDir = path.join(this.context.globalStorageUri.fsPath, "modes")
			}

			// Create full mode config
			const modeConfig: ModeConfig = {
				...config,
				slug,
				source: isProjectMode ? "project" : "global",
				format: "yaml",
			}

			// Save mode as YAML
			await this.queueWrite(async () => {
				await saveModeAsYaml(targetDir, modeConfig)
				this.clearCache()
				await this.onUpdate()
			})

			// 成功したらタイムアウトをクリア
			clearTimeout(lockTimeout)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to update YAML mode", { slug, error: errorMessage })
			vscode.window.showErrorMessage(`Failed to update YAML mode: ${errorMessage}`)
		} finally {
			// 編集ロックを解除する前に少し待機（ファイル変更イベントが処理される時間を確保）
			setTimeout(() => {
				this.editLock.delete(slug)
				logger.debug(`Edit lock released for ${slug}`)
			}, 500)
		}
	}

	/**
	 * Delete a mode in YAML format
	 */
	public async deleteYamlMode(slug: string, source: "global" | "project"): Promise<void> {
		try {
			let targetDir: string

			if (source === "project") {
				const workspacePath = getWorkspacePath()
				if (!workspacePath) {
					throw new Error("No workspace folder found for project-specific mode")
				}

				targetDir = path.join(workspacePath, ".roo", "modes")
			} else {
				targetDir = path.join(this.context.globalStorageUri.fsPath, "modes")
			}

			const filePath = path.join(targetDir, `${slug}.yaml`)
			const exists = await fileExistsAtPath(filePath)

			if (!exists) {
				throw new Error(`Mode file not found: ${filePath}`)
			}

			await this.queueWrite(async () => {
				await fs.unlink(filePath)
				this.clearCache()
				await this.onUpdate()
			})
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to delete YAML mode", { slug, error: errorMessage })
			vscode.window.showErrorMessage(`Failed to delete YAML mode: ${errorMessage}`)
		}
	}

	private clearCache(): void {
		this.cachedModes = null
		this.cachedAt = 0
	}

	public dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose()
		}
		this.disposables = []
	}
}
