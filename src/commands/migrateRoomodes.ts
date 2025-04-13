import * as vscode from "vscode"
import * as fs from "fs"
import * as path from "path"
import * as yaml from "yaml"
import { ModeConfigInputV1, ModeConfig } from "../modeSchemas"
import { t } from "../i18n"
import { convertToYamlFormat, saveYamlFile, getLineInfoFromPosition } from "../services/modeConfig"

/**
 * Migrate .roomodes file to YAML format
 * This command reads the .roomodes file and converts each mode to YAML format
 * The YAML files are saved in the .roo/modes directory
 *
 * @param context The extension context
 */
export async function migrateRoomodes(context: vscode.ExtensionContext): Promise<void> {
	// Get workspace root path
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(t("mode.no_workspace"))
		return
	}

	const roomodesPath = path.join(workspaceRoot, ".roomodes")

	// Check if .roomodes file exists
	if (!fs.existsSync(roomodesPath)) {
		vscode.window.showInformationMessage(t("mode.no_roomodes"))
		return
	}

	try {
		// Read .roomodes file
		const content = fs.readFileSync(roomodesPath, "utf8")
		let modesData

		try {
			// Wrap JSON parsing in a separate try-catch block
			modesData = JSON.parse(content)
		} catch (jsonError: any) {
			// Display more specific error message when JSON parsing error occurs
			console.error("JSON parsing error:", jsonError)

			// Get error position information (if possible)
			let positionInfo = ""
			if (jsonError instanceof SyntaxError && jsonError.message.includes("position")) {
				const posMatch = jsonError.message.match(/position (\d+)/)
				if (posMatch && posMatch[1]) {
					const position = parseInt(posMatch[1])
					const lineInfo = getLineInfoFromPosition(content, position)
					if (lineInfo) {
						positionInfo = t("errors.line_number_info", { line: lineInfo.line })
					}
				}
			}

			// Build specific error message
			const errorMessage = t("errors.json_parse_error", {
				positionInfo,
				message: jsonError.message,
				file: ".roomodes",
			})
			vscode.window.showErrorMessage(errorMessage)
			return
		}

		// Create .roo/modes directory if it doesn't exist
		const modesDir = path.join(workspaceRoot, ".roo", "modes")
		if (!fs.existsSync(modesDir)) {
			fs.mkdirSync(modesDir, { recursive: true })
		}

		// Migrate each mode
		let migratedCount = 0
		const modes = Array.isArray(modesData?.customModes) ? modesData.customModes : []
		for (const mode of modes) {
			if (!mode.slug || !/^[a-zA-Z0-9-]+$/.test(mode.slug)) {
				vscode.window.showWarningMessage(t("mode.migration_skip", { slug: mode.slug }))
				continue
			}

			// Convert to internal format
			const internalMode = convertV1ToInternal(mode, mode.slug, "project", "json")

			// Save as YAML
			const yamlPath = path.join(modesDir, `${mode.slug}.yaml`)
			saveYamlFile(yamlPath, convertToYamlFormat(internalMode))
			migratedCount++
		}

		// Show success message
		if (migratedCount > 0) {
			vscode.window.showInformationMessage(t("mode.migration_success", { count: migratedCount.toString() }))
		} else {
			vscode.window.showInformationMessage(t("mode.migration_none"))
		}
	} catch (error: any) {
		// Output error details to console
		console.error("Mode migration error:", error)

		// Build error message
		let errorMessage = t("mode.migration_error", { message: error.message || "Unknown error" })

		// Additional information based on error type
		if (error.message && error.message.includes("is not iterable")) {
			errorMessage += "\n" + t("mode.migration_error_syntax")
		}

		// More specific error messages for file operation related errors
		if (error.code === "ENOENT") {
			const errorDetails = t("mode.migration_error_file_not_found")
			vscode.window.showErrorMessage(
				t("mode.migration_error_with_details", { message: errorMessage, details: errorDetails }),
			)
		} else if (error.code === "EACCES") {
			const errorDetails = t("mode.migration_error_permission")
			vscode.window.showErrorMessage(
				t("mode.migration_error_with_details", { message: errorMessage, details: errorDetails }),
			)
		} else if (error.code === "EISDIR") {
			const errorDetails = t("mode.migration_error_is_directory")
			vscode.window.showErrorMessage(
				t("mode.migration_error_with_details", { message: errorMessage, details: errorDetails }),
			)
		} else if (error.code === "ENOTDIR") {
			const errorDetails = t("mode.migration_error_not_directory")
			vscode.window.showErrorMessage(
				t("mode.migration_error_with_details", { message: errorMessage, details: errorDetails }),
			)
		} else {
			// Other errors
			vscode.window.showErrorMessage(errorMessage)
		}
	}
}

/**
 * Convert from V1 format (array-based) to internal format
 */
function convertV1ToInternal(
	input: any,
	slug: string,
	source: "global" | "project",
	origin: "yaml" | "json",
): ModeConfig {
	// Convert groups from array format to object format
	const groups: Record<string, any> = {}

	// Ensure input.groups is an array
	const groupsArray = Array.isArray(input.groups) ? input.groups : []

	for (const entry of groupsArray) {
		if (typeof entry === "string") {
			// Simple group without options
			groups[entry] = undefined
		} else if (Array.isArray(entry) && entry.length >= 2) {
			// Group with options [name, options]
			groups[entry[0]] = entry[1]
		}
	}

	return {
		slug,
		name: input.name || slug,
		roleDefinition: input.roleDefinition || "",
		customInstructions: input.customInstructions,
		groups,
		source,
		origin,
	}
}
