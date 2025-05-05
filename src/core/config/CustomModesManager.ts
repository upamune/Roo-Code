import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { customModesSettingsSchema, GroupEntry, ToolGroup } from "../../schemas"
import { ModeConfig } from "../../shared/modes"
import { fileExistsAtPath } from "../../utils/fs"
import { arePathsEqual, getWorkspacePath } from "../../utils/path"
import { logger } from "../../utils/logging"
import { GlobalFileNames } from "../../shared/globalFileNames"

const ROOMODES_FILENAME = ".roomodes"

export class CustomModesManager {
	private disposables: vscode.Disposable[] = []
	private isWriting = false
	private writeQueue: Array<() => Promise<void>> = []
	private isUpdatingMode = false
	private updatingModeSlug: string | null = null

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onUpdate: () => Promise<void>,
	) {
		// TODO: We really shouldn't have async methods in the constructor.
		this.watchCustomModesFiles()
	}

	private async queueWrite(operation: () => Promise<void>): Promise<void> {
		this.writeQueue.push(operation)
		if (!this.isWriting) {
			await this.processWriteQueue()
		}
	}

	private async processWriteQueue(): Promise<void> {
		if (this.isWriting || this.writeQueue.length === 0) {
			return
		}

		this.isWriting = true
		try {
			while (this.writeQueue.length > 0) {
				const operation = this.writeQueue.shift()
				if (operation) {
					await operation()
				}
			}
		} finally {
			this.isWriting = false
		}
	}

	private async getWorkspaceRoomodes(): Promise<string | undefined> {
		const workspaceFolders = vscode.workspace.workspaceFolders
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return undefined
		}
		const workspaceRoot = getWorkspacePath()
		const roomodesPath = path.join(workspaceRoot, ROOMODES_FILENAME)
		const exists = await fileExistsAtPath(roomodesPath)
		return exists ? roomodesPath : undefined
	}

	private async loadModesFromFile(filePath: string): Promise<ModeConfig[]> {
		try {
			const content = await fs.readFile(filePath, "utf-8")
			const settings = JSON.parse(content)
			const result = customModesSettingsSchema.safeParse(settings)
			if (!result.success) {
				return []
			}

			// Determine source based on file path
			const isRoomodes = filePath.endsWith(ROOMODES_FILENAME)
			const source = isRoomodes ? ("project" as const) : ("global" as const)

			// Add source to each mode
			return result.data.customModes.map((mode) => ({
				...mode,
				source,
			}))
		} catch (error) {
			const errorMsg = `Failed to load modes from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
			console.error(`[CustomModesManager] ${errorMsg}`)
			return []
		}
	}

	private async mergeCustomModes(projectModes: ModeConfig[], globalModes: ModeConfig[]): Promise<ModeConfig[]> {
		const slugs = new Set<string>()
		const merged: ModeConfig[] = []

		// Add project mode (takes precedence)
		for (const mode of projectModes) {
			if (!slugs.has(mode.slug)) {
				slugs.add(mode.slug)
				merged.push({
					...mode,
					source: "project",
				})
			}
		}

		// Add non-duplicate global modes
		for (const mode of globalModes) {
			if (!slugs.has(mode.slug)) {
				slugs.add(mode.slug)
				merged.push({
					...mode,
					source: "global",
				})
			}
		}

		return merged
	}

	async getCustomModesFilePath(): Promise<string> {
		const settingsDir = await this.ensureSettingsDirectoryExists()
		const filePath = path.join(settingsDir, GlobalFileNames.customModes)
		const fileExists = await fileExistsAtPath(filePath)
		if (!fileExists) {
			await this.queueWrite(async () => {
				await fs.writeFile(filePath, JSON.stringify({ customModes: [] }, null, 2))
			})
		}
		return filePath
	}
	private async watchCustomModesFiles(): Promise<void> {
		// Import necessary functions from modeConfig.ts
		const { loadAllModes } = await import("../../services/modeConfig")
		const settingsPath = await this.getCustomModesFilePath()
		const workspaceRoot = getWorkspacePath()

		// Function to refresh all modes with the correct priority
		const refreshAllModes = async (changedFilePath?: string) => {
			// モード更新中の場合はスキップ（変更の競合を防止）
			if (this.isUpdatingMode) {
				logger.info("Skipping mode refresh because a mode update is in progress", {
					updatingSlug: this.updatingModeSlug,
				})
				return
			}

			try {
				// Load all modes from all sources with the correct priority:
				// 1. Project YAML modes (.roo/modes/*.yaml) - highest priority
				// 2. Project .roomodes modes
				// 3. Global YAML modes (.roo/modes/*.yaml)
				// 4. Global .roomodes modes - lowest priority
				const allModes = await loadAllModes(this.context, workspaceRoot)

				// Convert Map to array for storage
				const modesArray = Array.from(allModes.values())

				// Update global state with merged modes
				await this.context.globalState.update("customModes", modesArray)
				await this.onUpdate()
			} catch (error) {
				console.error("Error refreshing modes:", error)
				vscode.window.showErrorMessage(
					`モードの更新中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		// Watch global settings file (.roomodes)
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument(async (document) => {
				if (arePathsEqual(document.uri.fsPath, settingsPath)) {
					await refreshAllModes(document.uri.fsPath)
				}
			}),
		)

		// Watch project .roomodes file if it exists
		const roomodesPath = await this.getWorkspaceRoomodes()
		if (roomodesPath) {
			this.disposables.push(
				vscode.workspace.onDidSaveTextDocument(async (document) => {
					if (arePathsEqual(document.uri.fsPath, roomodesPath)) {
						await refreshAllModes(document.uri.fsPath)
					}
				}),
			)
		}

		// Watch project .roo/modes directory for YAML files
		const projectModesDir = path.join(workspaceRoot, ".roo", "modes")
		if (await this.directoryExists(projectModesDir)) {
			this.disposables.push(
				vscode.workspace.onDidSaveTextDocument(async (document) => {
					if (document.uri.fsPath.startsWith(projectModesDir) && document.uri.fsPath.endsWith(".yaml")) {
						await refreshAllModes(document.uri.fsPath)
					}
				}),
			)
		}

		// Watch global .roo/modes directory for YAML files
		const globalModesDir = path.join(this.context.globalStorageUri.fsPath, "modes")
		if (await this.directoryExists(globalModesDir)) {
			this.disposables.push(
				vscode.workspace.onDidSaveTextDocument(async (document) => {
					if (document.uri.fsPath.startsWith(globalModesDir) && document.uri.fsPath.endsWith(".yaml")) {
						await refreshAllModes(document.uri.fsPath)
					}
				}),
			)
		}

		// Initial load of all modes
		await refreshAllModes()
	}

	// Helper method to check if a directory exists
	private async directoryExists(dirPath: string): Promise<boolean> {
		try {
			const stats = await fs.stat(dirPath)
			return stats.isDirectory()
		} catch (error) {
			return false
		}
	}

	async getCustomModes(): Promise<ModeConfig[]> {
		// Import loadAllModes function from modeConfig.ts
		const { loadAllModes } = await import("../../services/modeConfig")
		const workspaceRoot = getWorkspacePath()

		try {
			// Load all modes from all sources with the correct priority:
			// 1. Project YAML modes (.roo/modes/*.yaml) - highest priority
			// 2. Project .roomodes modes
			// 3. Global YAML modes (.roo/modes/*.yaml)
			// 4. Global .roomodes modes - lowest priority
			const allModes = await loadAllModes(this.context, workspaceRoot)

			// Convert Map to array for storage and return
			const modesArray = Array.from(allModes.values())

			// Convert the ModeConfig from modeSchemas.ts to the format expected by CustomModesManager
			const convertedModes = modesArray.map((mode) => {
				// Convert groups from Record<string, GroupOptions | undefined> to array format
				const groups: GroupEntry[] = []
				for (const [groupName, options] of Object.entries(mode.groups)) {
					if (options) {
						groups.push([groupName as ToolGroup, options])
					} else {
						groups.push(groupName as ToolGroup)
					}
				}

				// Return the converted mode
				return {
					slug: mode.slug,
					name: mode.name,
					roleDefinition: mode.roleDefinition,
					customInstructions: mode.customInstructions,
					groups,
					source: mode.source,
				}
			})

			// Update global state with merged modes
			await this.context.globalState.update("customModes", convertedModes)
			return convertedModes
		} catch (error) {
			console.error("Error loading custom modes:", error)
			vscode.window.showErrorMessage(
				`モードの読み込み中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`,
			)

			// Return empty array in case of error
			return []
		}
	}
	async updateCustomMode(slug: string, config: ModeConfig): Promise<void> {
		// モード更新中フラグをセット
		this.isUpdatingMode = true
		this.updatingModeSlug = slug

		try {
			const isProjectMode = config.source === "project"
			let targetPath: string

			// 新規モードの場合は常に.roo/modes配下に保存する
			const workspaceFolders = vscode.workspace.workspaceFolders
			if (!workspaceFolders || workspaceFolders.length === 0) {
				logger.error("Failed to update project mode: No workspace folder found", { slug })
				throw new Error("No workspace folder found for project-specific mode")
			}
			const workspaceRoot = getWorkspacePath()

			// 新規モードの場合は.roo/modes配下に保存する
			// 既存のモードの場合は元の場所に保存する
			const existingModes = await this.getCustomModes()
			const existingMode = existingModes.find((m) => m.slug === slug)

			if (!existingMode) {
				// 新規モードの場合は.roo/modes配下に保存する
				// 新規モードの場合は.roo/modes配下に保存する
				const { createNewMode } = await import("../../services/modeConfig")

				// groups配列をRecord形式に変換
				const groups: Record<string, { fileRegex?: string; description?: string } | null> = {}

				// configのgroupsが配列であることを確認
				const groupsArray = Array.isArray(config.groups) ? config.groups : []

				for (const entry of groupsArray) {
					if (typeof entry === "string") {
						// Simple group without options
						groups[entry] = null
					} else if (Array.isArray(entry) && entry.length >= 2) {
						// Group with options [name, options]
						groups[entry[0]] = entry[1] ?? null
					}
				}

				// 新規モードを作成
				createNewMode(
					{
						slug,
						name: config.name || slug,
						roleDefinition: config.roleDefinition || "",
						customInstructions: config.customInstructions,
						groups,
						source: "project",
						origin: "yaml",
					},
					workspaceRoot,
				)

				// 状態を更新
				await this.refreshMergedState()
				return
			}

			// 既存のモードの場合は元の場所に保存する
			if (isProjectMode) {
				targetPath = path.join(workspaceRoot, ROOMODES_FILENAME)
				const exists = await fileExistsAtPath(targetPath)
				logger.info(`${exists ? "Updating" : "Creating"} project mode in ${ROOMODES_FILENAME}`, {
					slug,
					workspace: workspaceRoot,
				})
			} else {
				targetPath = await this.getCustomModesFilePath()
			}

			await this.queueWrite(async () => {
				// Ensure source is set correctly based on target file
				const modeWithSource = {
					...config,
					source: isProjectMode ? ("project" as const) : ("global" as const),
				}

				await this.updateModesInFile(targetPath, (modes) => {
					const updatedModes = modes.filter((m) => m.slug !== slug)
					updatedModes.push(modeWithSource)
					return updatedModes
				})

				await this.refreshMergedState()
			})
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to update custom mode", { slug, error: errorMessage })
			vscode.window.showErrorMessage(`Failed to update custom mode: ${errorMessage}`)
		} finally {
			// 処理完了後、少し遅延させてからフラグをリセット（ファイル変更イベントとの競合を防止）
			setTimeout(() => {
				this.isUpdatingMode = false
				this.updatingModeSlug = null
			}, 1000) // 遅延時間を1秒に延長
		}
	}
	private async updateModesInFile(filePath: string, operation: (modes: ModeConfig[]) => ModeConfig[]): Promise<void> {
		let content = "{}"
		try {
			content = await fs.readFile(filePath, "utf-8")
		} catch (error) {
			// File might not exist yet
			content = JSON.stringify({ customModes: [] })
		}

		let settings
		try {
			settings = JSON.parse(content)
		} catch (error) {
			console.error(`[CustomModesManager] Failed to parse JSON from ${filePath}:`, error)
			settings = { customModes: [] }
		}
		settings.customModes = operation(settings.customModes || [])
		await fs.writeFile(filePath, JSON.stringify(settings, null, 2), "utf-8")
	}

	private async refreshMergedState(): Promise<void> {
		// 更新中のモードがある場合は、そのモードの更新が完了するまで待機
		if (this.isUpdatingMode) {
			logger.info("Waiting for mode update to complete before refreshing state", {
				updatingSlug: this.updatingModeSlug,
			})
			// 更新中のモードがある場合は、そのモードの更新が完了するまで待機
			await new Promise((resolve) => setTimeout(resolve, 500))
		}

		// Use the same logic as getCustomModes to ensure consistency
		const modes = await this.getCustomModes()
		await this.context.globalState.update("customModes", modes)
		await this.onUpdate()
	}

	async deleteCustomMode(slug: string): Promise<void> {
		try {
			const settingsPath = await this.getCustomModesFilePath()
			const roomodesPath = await this.getWorkspaceRoomodes()

			const settingsModes = await this.loadModesFromFile(settingsPath)
			const roomodesModes = roomodesPath ? await this.loadModesFromFile(roomodesPath) : []

			// Find the mode in either file
			const projectMode = roomodesModes.find((m) => m.slug === slug)
			const globalMode = settingsModes.find((m) => m.slug === slug)

			if (!projectMode && !globalMode) {
				throw new Error("Write error: Mode not found")
			}

			await this.queueWrite(async () => {
				// Delete from project first if it exists there
				if (projectMode && roomodesPath) {
					await this.updateModesInFile(roomodesPath, (modes) => modes.filter((m) => m.slug !== slug))
				}

				// Delete from global settings if it exists there
				if (globalMode) {
					await this.updateModesInFile(settingsPath, (modes) => modes.filter((m) => m.slug !== slug))
				}

				await this.refreshMergedState()
			})
		} catch (error) {
			vscode.window.showErrorMessage(
				`Failed to delete custom mode: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private async ensureSettingsDirectoryExists(): Promise<string> {
		const settingsDir = path.join(this.context.globalStorageUri.fsPath, "settings")
		await fs.mkdir(settingsDir, { recursive: true })
		return settingsDir
	}

	async resetCustomModes(): Promise<void> {
		try {
			const filePath = await this.getCustomModesFilePath()
			await fs.writeFile(filePath, JSON.stringify({ customModes: [] }, null, 2))
			await this.context.globalState.update("customModes", [])
			await this.onUpdate()
		} catch (error) {
			vscode.window.showErrorMessage(
				`Failed to reset custom modes: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose()
		}
		this.disposables = []
	}
}
