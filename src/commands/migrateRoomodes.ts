import * as vscode from "vscode"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { fileExistsAtPath } from "../utils/fs"
import { saveModeAsYaml } from "../utils/yamlUtils"
import type { ModeConfig } from "../schemas/index"
import { logger } from "../utils/logging"

const ROOMODES_FILENAME = ".roomodes"

/**
 * Command to migrate .roomodes file to YAML format
 * @param context VS Code extension context
 */
export async function migrateRoomodesCommand(_context: vscode.ExtensionContext): Promise<void> {
	// Get workspace folders
	const workspaceFolders = vscode.workspace.workspaceFolders
	if (!workspaceFolders || workspaceFolders.length === 0) {
		vscode.window.showErrorMessage("No workspace folder found.")
		return
	}

	// For each workspace folder
	for (const folder of workspaceFolders) {
		const workspacePath = folder.uri.fsPath
		await migrateRoomodes(workspacePath)
	}
}

/**
 * Migrate .roomodes file to YAML format
 * @param workspacePath Path to the workspace
 */
export async function migrateRoomodes(workspacePath: string): Promise<void> {
	const roomodesPath = path.join(workspacePath, ROOMODES_FILENAME)
	const rooModesDir = path.join(workspacePath, ".roo", "modes")

	try {
		// Check if .roomodes exists
		const roomodesExists = await fileExistsAtPath(roomodesPath)
		if (!roomodesExists) {
			vscode.window.showInformationMessage(`No ${ROOMODES_FILENAME} file found in ${workspacePath}.`)
			return
		}

		// Read and parse .roomodes file
		const content = await fs.readFile(roomodesPath, "utf-8")
		const settings = JSON.parse(content)

		// Extract custom modes
		const { customModes } = settings
		if (!Array.isArray(customModes) || customModes.length === 0) {
			vscode.window.showInformationMessage(`No custom modes found in ${ROOMODES_FILENAME} file.`)
			return
		}

		// Create target directory
		await fs.mkdir(rooModesDir, { recursive: true })

		// Migrate each mode
		let migratedCount = 0
		for (const mode of customModes) {
			const { slug, ...modeData } = mode

			// Validate slug
			if (!slug || typeof slug !== "string" || !/^[a-zA-Z0-9-]+$/.test(slug)) {
				logger.warn(`Invalid slug in ${ROOMODES_FILENAME}: ${slug}`)
				continue
			}

			// Create ModeConfig object
			const modeConfig: ModeConfig = {
				...modeData,
				slug,
				source: "project",
				format: "yaml",
			}

			// Save as YAML file
			await saveModeAsYaml(rooModesDir, modeConfig)
			migratedCount++
		}

		// Show success message
		vscode.window.showInformationMessage(
			`${migratedCount} modes migrated from ${ROOMODES_FILENAME} to .roo/modes/ directory.`,
		)
	} catch (error) {
		// Show error message
		vscode.window.showErrorMessage(
			`Error occurred during mode migration: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}
