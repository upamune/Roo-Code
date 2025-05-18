import * as vscode from "vscode"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { customModesSettingsSchema } from "../../schemas"
import type { ModeConfig } from "../../schemas/index"
import { fileExistsAtPath } from "../../utils/fs"
import { arePathsEqual, getWorkspacePath } from "../../utils/path"
import { logger } from "../../utils/logging"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { YamlModesManager } from "./YamlModesManager"

const ROOMODES_FILENAME = ".roomodes"

export class CustomModesManager {
	private static readonly cacheTTL = 10_000

	private disposables: vscode.Disposable[] = []
	private isWriting = false
	private writeQueue: Array<() => Promise<void>> = []
	private cachedModes: ModeConfig[] | null = null
	private cachedAt = 0
	private yamlModesManager: YamlModesManager

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onUpdate: () => Promise<void>,
	) {
		// Initialize YAML modes manager
		this.yamlModesManager = new YamlModesManager(context, onUpdate)

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
			return result.data.customModes.map((mode) => ({ ...mode, source }))
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
				merged.push({ ...mode, source: "project" })
			}
		}

		// Add non-duplicate global modes
		for (const mode of globalModes) {
			if (!slugs.has(mode.slug)) {
				slugs.add(mode.slug)
				merged.push({ ...mode, source: "global" })
			}
		}

		return merged
	}

	public async getCustomModesFilePath(): Promise<string> {
		const settingsDir = await this.ensureSettingsDirectoryExists()
		const filePath = path.join(settingsDir, GlobalFileNames.customModes)
		const fileExists = await fileExistsAtPath(filePath)

		if (!fileExists) {
			await this.queueWrite(() => fs.writeFile(filePath, JSON.stringify({ customModes: [] }, null, 2)))
		}

		return filePath
	}

	private async watchCustomModesFiles(): Promise<void> {
		const settingsPath = await this.getCustomModesFilePath()

		// Watch settings file
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument(async (document) => {
				if (arePathsEqual(document.uri.fsPath, settingsPath)) {
					const content = await fs.readFile(settingsPath, "utf-8")

					const errorMessage =
						"Invalid custom modes format. Please ensure your settings follow the correct JSON format."

					let config: { customModes: ModeConfig[] }

					try {
						config = JSON.parse(content)
					} catch (error) {
						console.error(error)
						vscode.window.showErrorMessage(errorMessage)
						return
					}

					const result = customModesSettingsSchema.safeParse(config)

					if (!result.success) {
						vscode.window.showErrorMessage(errorMessage)
						return
					}

					// Get modes from .roomodes if it exists (takes precedence)
					const roomodesPath = await this.getWorkspaceRoomodes()
					const roomodesModes = roomodesPath ? await this.loadModesFromFile(roomodesPath) : []

					// Merge modes from both sources (.roomodes takes precedence)
					const mergedModes = await this.mergeCustomModes(roomodesModes, result.data.customModes)
					await this.context.globalState.update("customModes", mergedModes)
					this.clearCache()
					await this.onUpdate()
				}
			}),
		)

		// Watch .roomodes file if it exists
		const roomodesPath = await this.getWorkspaceRoomodes()

		if (roomodesPath) {
			this.disposables.push(
				vscode.workspace.onDidSaveTextDocument(async (document) => {
					if (arePathsEqual(document.uri.fsPath, roomodesPath)) {
						const settingsModes = await this.loadModesFromFile(settingsPath)
						const roomodesModes = await this.loadModesFromFile(roomodesPath)
						// .roomodes takes precedence
						const mergedModes = await this.mergeCustomModes(roomodesModes, settingsModes)
						await this.context.globalState.update("customModes", mergedModes)
						this.clearCache()
						await this.onUpdate()
					}
				}),
			)
		}
	}

	public async getCustomModes(): Promise<ModeConfig[]> {
		// Check if we have a valid cached result.
		const now = Date.now()

		if (this.cachedModes && now - this.cachedAt < CustomModesManager.cacheTTL) {
			return this.cachedModes
		}

		// Get modes from settings file.
		const settingsPath = await this.getCustomModesFilePath()
		const settingsModes = await this.loadModesFromFile(settingsPath)

		// Get modes from .roomodes if it exists.
		const roomodesPath = await this.getWorkspaceRoomodes()
		const roomodesModes = roomodesPath ? await this.loadModesFromFile(roomodesPath) : []

		// Get modes from YAML files
		const yamlModes = await this.yamlModesManager.getYamlModes()

		// Create maps to store modes by source and format.
		const projectJsonModes = new Map<string, ModeConfig>()
		const projectYamlModes = new Map<string, ModeConfig>()
		const globalJsonModes = new Map<string, ModeConfig>()
		const globalYamlModes = new Map<string, ModeConfig>()

		// Add project JSON modes (.roomodes)
		for (const mode of roomodesModes) {
			projectJsonModes.set(mode.slug, { ...mode, source: "project", format: "json" })
		}

		// Add global JSON modes (settings file)
		for (const mode of settingsModes) {
			globalJsonModes.set(mode.slug, { ...mode, source: "global", format: "json" })
		}

		// Add YAML modes (both project and global)
		for (const mode of yamlModes) {
			if (mode.source === "project") {
				projectYamlModes.set(mode.slug, mode)
			} else {
				globalYamlModes.set(mode.slug, mode)
			}
		}

		// Combine modes with priority: project YAML > project JSON > global YAML > global JSON
		const allSlugs = new Set<string>([
			...projectYamlModes.keys(),
			...projectJsonModes.keys(),
			...globalYamlModes.keys(),
			...globalJsonModes.keys(),
		])

		const mergedModes: ModeConfig[] = []

		// Add modes in priority order
		for (const slug of allSlugs) {
			// Check in priority order
			const mode =
				projectYamlModes.get(slug) ||
				projectJsonModes.get(slug) ||
				globalYamlModes.get(slug) ||
				globalJsonModes.get(slug)

			if (mode) {
				mergedModes.push(mode)
			}
		}

		await this.context.globalState.update("customModes", mergedModes)

		this.cachedModes = mergedModes
		this.cachedAt = now

		return mergedModes
	}

	public async updateCustomMode(slug: string, config: ModeConfig): Promise<void> {
		try {
			const isProjectMode = config.source === "project"
			const preferYaml = config.format === "yaml" || !config.format // Default to YAML if not specified

			// If YAML format is preferred, use YAML modes manager
			if (preferYaml) {
				await this.yamlModesManager.updateYamlMode(slug, config)
				return
			}

			// Otherwise, use JSON format (legacy)
			let targetPath: string

			if (isProjectMode) {
				const workspaceFolders = vscode.workspace.workspaceFolders

				if (!workspaceFolders || workspaceFolders.length === 0) {
					logger.error("Failed to update project mode: No workspace folder found", { slug })
					throw new Error("No workspace folder found for project-specific mode")
				}

				const workspaceRoot = getWorkspacePath()
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
				// Ensure source is set correctly based on target file.
				const modeWithSource = {
					...config,
					source: isProjectMode ? ("project" as const) : ("global" as const),
					format: "json" as const,
				}

				await this.updateModesInFile(targetPath, (modes) => {
					const updatedModes = modes.filter((m) => m.slug !== slug)
					updatedModes.push(modeWithSource)
					return updatedModes
				})

				this.clearCache()
				await this.refreshMergedState()
			})
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to update custom mode", { slug, error: errorMessage })
			vscode.window.showErrorMessage(`Failed to update custom mode: ${errorMessage}`)
		}
	}

	private async updateModesInFile(filePath: string, operation: (modes: ModeConfig[]) => ModeConfig[]): Promise<void> {
		let content = "{}"

		try {
			content = await fs.readFile(filePath, "utf-8")
		} catch (error) {
			// File might not exist yet.
			content = JSON.stringify({ customModes: [] })
		}

		let settings: { customModes: ModeConfig[] }

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
		const settingsPath = await this.getCustomModesFilePath()
		const roomodesPath = await this.getWorkspaceRoomodes()

		const settingsModes = await this.loadModesFromFile(settingsPath)
		const roomodesModes = roomodesPath ? await this.loadModesFromFile(roomodesPath) : []
		const mergedModes = await this.mergeCustomModes(roomodesModes, settingsModes)

		await this.context.globalState.update("customModes", mergedModes)

		this.clearCache()

		await this.onUpdate()
	}

	public async deleteCustomMode(slug: string): Promise<void> {
		try {
			// Get all modes to determine where the mode exists
			const allModes = await this.getCustomModes()
			const mode = allModes.find((m) => m.slug === slug)

			if (!mode) {
				throw new Error("Mode not found")
			}
			if (mode.source === undefined) {
				throw new Error("Mode source is undefined")
			}

			// If it's a YAML mode, use YAML modes manager
			if (mode.format === "yaml") {
				await this.yamlModesManager.deleteYamlMode(slug, mode.source)
				return
			}

			// Otherwise, it's a JSON mode (legacy)
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

				// Clear cache when modes are deleted
				this.clearCache()
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

	public async resetCustomModes(): Promise<void> {
		try {
			const filePath = await this.getCustomModesFilePath()
			await fs.writeFile(filePath, JSON.stringify({ customModes: [] }, null, 2))
			await this.context.globalState.update("customModes", [])
			this.clearCache()
			await this.onUpdate()
		} catch (error) {
			vscode.window.showErrorMessage(
				`Failed to reset custom modes: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private clearCache(): void {
		this.cachedModes = null
		this.cachedAt = 0
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose()
		}

		this.disposables = []

		// Dispose YAML modes manager
		this.yamlModesManager.dispose()
	}
}
