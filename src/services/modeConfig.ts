import * as yaml from "yaml"
import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { t } from "../i18n"
import {
	modeConfigInputSchemaV1,
	modeConfigInputSchemaV2,
	ModeConfig,
	ModeConfigInputV1,
	ModeConfigInputV2,
	GroupOptions,
} from "../modeSchemas"

// Load global YAML modes (sets origin to "yaml")
async function loadGlobalYamlModes(context: vscode.ExtensionContext): Promise<Map<string, ModeConfig>> {
	const modesMap = new Map<string, ModeConfig>()
	const globalModesDir = path.join(context.globalStorageUri.fsPath, "modes")

	try {
		// Create global modes directory if it doesn't exist
		if (!fs.existsSync(globalModesDir)) {
			fs.mkdirSync(globalModesDir, { recursive: true })
			return modesMap
		}

		// Load YAML files from the directory
		const files = fs.readdirSync(globalModesDir).filter((file) => file.endsWith(".yaml"))

		for (const file of files) {
			try {
				const slug = path.basename(file, ".yaml")
				// Validate slug (alphanumeric and hyphens only)
				if (!/^[a-zA-Z0-9-]+$/.test(slug)) {
					console.warn(`Invalid slug format: ${slug}`)
					vscode.window.showWarningMessage(t("mode.migration_skip", { slug }))
					continue
				}

				const filePath = path.join(globalModesDir, file)
				let content: string

				try {
					content = fs.readFileSync(filePath, "utf8")
				} catch (fileError) {
					console.error(`Error reading global mode file ${file}:`, fileError)
					vscode.window.showErrorMessage(
						t("errors.cannot_access_path", { path: filePath, error: fileError.message }),
					)
					continue
				}

				let parsedContent
				try {
					parsedContent = yaml.parse(content)
				} catch (yamlError) {
					console.error(`YAML parsing error in global mode ${file}:`, yamlError)
					vscode.window.showWarningMessage(`${file}: ${yamlError.message}`)
					continue
				}

				// Schema validation
				const validationResult = modeConfigInputSchemaV2.safeParse(parsedContent)
				if (!validationResult.success) {
					console.warn(`Invalid mode config in ${file}:`, validationResult.error)
					vscode.window.showWarningMessage(`${file}: ${validationResult.error.message}`)
					continue
				}

				// Create ModeConfig object
				const modeConfig: ModeConfig = {
					...validationResult.data,
					slug,
					source: "global",
					origin: "yaml",
				}

				modesMap.set(slug, modeConfig)
			} catch (error) {
				console.error(`Error loading global mode ${file}:`, error)
				vscode.window.showErrorMessage(`${file}: ${error.message}`)
			}
		}
	} catch (dirError) {
		console.error(`Error accessing global modes directory:`, dirError)
		vscode.window.showErrorMessage(
			t("errors.cannot_access_path", { path: globalModesDir, error: dirError.message }),
		)
	}

	return modesMap
}

// Load project YAML modes (sets origin to "yaml")
async function loadProjectYamlModes(workspaceRoot: string): Promise<Map<string, ModeConfig>> {
	const modesMap = new Map<string, ModeConfig>()
	const projectModesDir = path.join(workspaceRoot, ".roo", "modes")

	try {
		// Return empty map if project modes directory doesn't exist
		if (!fs.existsSync(projectModesDir)) {
			return modesMap
		}

		// Load YAML files from the directory
		let files
		try {
			files = fs.readdirSync(projectModesDir).filter((file) => file.endsWith(".yaml"))
		} catch (dirError) {
			console.error(`Error reading project modes directory:`, dirError)
			vscode.window.showErrorMessage(
				t("errors.cannot_access_path", { path: projectModesDir, error: dirError.message }),
			)
			return modesMap
		}

		for (const file of files) {
			try {
				const slug = path.basename(file, ".yaml")
				// Validate slug (alphanumeric and hyphens only)
				if (!/^[a-zA-Z0-9-]+$/.test(slug)) {
					console.warn(`Invalid slug format: ${slug}`)
					vscode.window.showWarningMessage(t("mode.migration_skip", { slug }))
					continue
				}

				const filePath = path.join(projectModesDir, file)
				let content: string

				try {
					content = fs.readFileSync(filePath, "utf8")
				} catch (fileError) {
					console.error(`Error reading project mode file ${file}:`, fileError)
					vscode.window.showErrorMessage(
						t("errors.cannot_access_path", { path: filePath, error: fileError.message }),
					)
					continue
				}

				let parsedContent
				try {
					parsedContent = yaml.parse(content)
				} catch (yamlError) {
					console.error(`YAML parsing error in project mode ${file}:`, yamlError)
					vscode.window.showWarningMessage(`${file}: ${yamlError.message}`)
					continue
				}

				// Schema validation
				const validationResult = modeConfigInputSchemaV2.safeParse(parsedContent)
				if (!validationResult.success) {
					console.warn(`Invalid mode config in ${file}:`, validationResult.error)
					vscode.window.showWarningMessage(`${file}: ${validationResult.error.message}`)
					continue
				}

				// Create ModeConfig object
				const modeConfig: ModeConfig = {
					...validationResult.data,
					slug,
					source: "project",
					origin: "yaml",
				}

				modesMap.set(slug, modeConfig)
			} catch (error) {
				console.error(`Error loading project mode ${file}:`, error)
				vscode.window.showErrorMessage(`${file}: ${error.message}`)
			}
		}
	} catch (error) {
		console.error(`Error accessing project modes directory:`, error)
		vscode.window.showErrorMessage(t("errors.cannot_access_path", { path: projectModesDir, error: error.message }))
	}

	return modesMap
}

// Load all modes (global and project)
export async function loadAllModes(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<Map<string, ModeConfig>> {
	// Load existing mode settings from all sources
	const globalYamlModes = await loadGlobalYamlModes(context)
	const globalRoomodesModes = await loadGlobalRoomodesModes(context)
	const projectYamlModes = await loadProjectYamlModes(workspaceRoot)
	const projectRoomodesModes = await loadProjectRoomodesModes(workspaceRoot)

	// Merge with priority:
	// 1. Project YAML modes (.roo/modes/*.yaml) - highest priority
	// 2. Project .roomodes modes
	// 3. Global YAML modes (.roo/modes/*.yaml)
	// 4. Global .roomodes modes - lowest priority
	const allModes = new Map<string, ModeConfig>()

	// Add global .roomodes modes (lowest priority)
	for (const [slug, config] of globalRoomodesModes.entries()) {
		allModes.set(slug, config)
	}

	// Add global YAML modes (overrides global .roomodes)
	for (const [slug, config] of globalYamlModes.entries()) {
		allModes.set(slug, config)
	}

	// Add project .roomodes modes (overrides global modes)
	for (const [slug, config] of projectRoomodesModes.entries()) {
		allModes.set(slug, config)
	}

	// Add project YAML modes (highest priority)
	for (const [slug, config] of projectYamlModes.entries()) {
		allModes.set(slug, config)
	}

	return allModes
}

// Helper function to load modes from .roomodes file (sets origin to "json")
async function loadRoomodesModes(
	filePath: string,
	source: "global" | "project",
	fileLabel: string,
): Promise<Map<string, ModeConfig>> {
	const modesMap = new Map<string, ModeConfig>()

	// Return empty map if .roomodes file doesn't exist
	if (!fs.existsSync(filePath)) {
		return modesMap
	}

	try {
		// Read .roomodes file
		let content: string
		try {
			content = fs.readFileSync(filePath, "utf8")
		} catch (fileError) {
			console.error(`Error reading ${fileLabel} .roomodes file:`, fileError)
			vscode.window.showErrorMessage(t("errors.cannot_access_path", { path: filePath, error: fileError.message }))
			return modesMap
		}

		let modesData
		try {
			modesData = JSON.parse(content)
		} catch (jsonError) {
			// Display more specific error message when JSON parsing error occurs
			console.error(`JSON parsing error in ${fileLabel} .roomodes file:`, jsonError)

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
				file: `${fileLabel} .roomodes`,
			})
			vscode.window.showErrorMessage(errorMessage)
			return modesMap
		}

		// Check if modesData is an object and customModes property is an array
		if (!modesData || typeof modesData !== "object" || !Array.isArray(modesData.customModes)) {
			console.error(`Error in ${fileLabel} .roomodes file: modesData.customModes is not an array`)
			vscode.window.showErrorMessage(t("errors.invalid_roomodes_format", { source }))
			return modesMap
		}

		// Process each mode from customModes property
		for (const mode of modesData.customModes) {
			if (!mode.slug || !/^[a-zA-Z0-9-]+$/.test(mode.slug)) {
				console.warn(`Invalid slug format in ${fileLabel} .roomodes: ${mode.slug}`)
				vscode.window.showWarningMessage(t("mode.migration_skip", { slug: mode.slug || "unknown" }))
				continue
			}

			// Convert to internal format and set origin to "json"
			const modeConfig = convertV1ToInternal(mode, mode.slug, source, "json")
			modesMap.set(mode.slug, modeConfig)
		}
	} catch (error) {
		console.error(`Error loading ${fileLabel} .roomodes file:`, error)

		// Display message based on error type
		if (error.code === "ENOENT") {
			vscode.window.showErrorMessage(
				t("errors.file_not_found", { file: `${fileLabel} .roomodes`, message: error.message }),
			)
		} else if (error.code === "EACCES") {
			vscode.window.showErrorMessage(
				t("errors.file_access_denied", { file: `${fileLabel} .roomodes`, message: error.message }),
			)
		} else {
			vscode.window.showErrorMessage(
				t("errors.file_read_error", { file: `${fileLabel} .roomodes`, message: error.message }),
			)
		}
	}

	return modesMap
}

// Load modes from project .roomodes file (sets origin to "json")
async function loadProjectRoomodesModes(workspaceRoot: string): Promise<Map<string, ModeConfig>> {
	const roomodesPath = path.join(workspaceRoot, ".roomodes")
	return loadRoomodesModes(roomodesPath, "project", "project")
}

// Load modes from global .roomodes file (sets origin to "json")
async function loadGlobalRoomodesModes(context: vscode.ExtensionContext): Promise<Map<string, ModeConfig>> {
	const globalRoomodesPath = path.join(context.globalStorageUri.fsPath, ".roomodes")
	return loadRoomodesModes(globalRoomodesPath, "global", "global")
}

// Convert from V1 format (array-based) to internal format
function convertV1ToInternal(
	input: ModeConfigInputV1,
	slug: string,
	source: "global" | "project",
	origin: "yaml" | "json",
): ModeConfig {
	// Convert groups from array format to object format
	const groups: Record<string, GroupOptions | undefined> = {}

	// Check if input.groups is an array
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

// Convert from V2 format (object-based) to internal format
function convertV2ToInternal(
	input: ModeConfigInputV2,
	slug: string,
	source: "global" | "project",
	origin: "yaml" | "json" = "yaml",
): ModeConfig {
	return {
		slug,
		name: input.name,
		roleDefinition: input.roleDefinition,
		customInstructions: input.customInstructions,
		groups: input.groups,
		source,
		origin,
	}
}

// Save mode to appropriate location based on source and origin (yaml or json)
export function saveMode(mode: ModeConfig, workspaceRoot: string, context: vscode.ExtensionContext): void {
	try {
		// The source property indicates where the mode was loaded from
		// This ensures changes are saved back to the original source
		if (mode.source === "project") {
			// Check if this mode originated from JSON (.roomodes) or YAML (.roo/modes)
			if (mode.origin === "json") {
				// Save to project .roomodes file (JSON format)
				saveToRoomodes(mode, workspaceRoot)
			} else {
				// Save to project-specific YAML file
				const projectModesDir = path.join(workspaceRoot, ".roo", "modes")
				try {
					if (!fs.existsSync(projectModesDir)) {
						fs.mkdirSync(projectModesDir, { recursive: true })
					}
				} catch (dirError) {
					console.error(`Error creating project modes directory:`, dirError)
					vscode.window.showErrorMessage(
						t("errors.cannot_access_path", { path: projectModesDir, error: dirError.message }),
					)
					return
				}

				const filePath = path.join(projectModesDir, `${mode.slug}.yaml`)
				saveYamlFile(filePath, convertToYamlFormat(mode))
			}
		} else if (mode.source === "global") {
			// Check if this mode originated from global JSON (.roomodes) or global YAML (.roo/modes)
			if (mode.origin === "json") {
				// Save to global .roomodes file (JSON format)
				saveToGlobalRoomodes(mode, context)
			} else {
				// Save to global YAML file
				const globalModesDir = path.join(context.globalStorageUri.fsPath, "modes")
				try {
					if (!fs.existsSync(globalModesDir)) {
						fs.mkdirSync(globalModesDir, { recursive: true })
					}
				} catch (dirError) {
					console.error(`Error creating global modes directory:`, dirError)
					vscode.window.showErrorMessage(
						t("errors.cannot_access_path", { path: globalModesDir, error: dirError.message }),
					)
					return
				}

				const filePath = path.join(globalModesDir, `${mode.slug}.yaml`)
				saveYamlFile(filePath, convertToYamlFormat(mode))
			}
		}
	} catch (error) {
		console.error("Error saving mode:", error)
		vscode.window.showErrorMessage(`${mode.slug}: ${error.message}`)
	}
}

// Helper function to save mode to .roomodes file (JSON format)
function saveToRoomodesFile(mode: ModeConfig, filePath: string, fileLabel: string): void {
	// Read existing .roomodes file
	// modesData is an object with customModes property as an array
	let modesData: { customModes: any[] } = { customModes: [] }
	if (fs.existsSync(filePath)) {
		try {
			const content = fs.readFileSync(filePath, "utf8")
			const parsedData = JSON.parse(content)
			// Check if existing data is in new format (with customModes property) or old format (array)
			if (parsedData && typeof parsedData === "object" && Array.isArray(parsedData.customModes)) {
				modesData = parsedData
			} else if (Array.isArray(parsedData)) {
				// Convert old format to new format
				modesData = { customModes: parsedData }
			} else {
				// Use empty new format if neither
				modesData = { customModes: [] }
			}
		} catch (error) {
			console.error(`Error reading ${fileLabel} .roomodes file:`, error)

			// Display message based on error type
			if (error.code === "ENOENT") {
				vscode.window.showErrorMessage(
					t("errors.file_not_found", { file: `${fileLabel} .roomodes`, message: error.message }),
				)
			} else if (error.code === "EACCES") {
				vscode.window.showErrorMessage(
					t("errors.file_access_denied", { file: `${fileLabel} .roomodes`, message: error.message }),
				)
			} else {
				vscode.window.showErrorMessage(
					t("errors.file_read_error", { file: `${fileLabel} .roomodes`, message: error.message }),
				)
			}
			modesData = { customModes: [] }
		}
	}

	// Convert mode to JSON format
	const jsonMode = convertToJsonFormat(mode)

	// Update or add mode in customModes property
	const index = modesData.customModes.findIndex((m: any) => m.slug === mode.slug)
	if (index >= 0) {
		modesData.customModes[index] = jsonMode
	} else {
		modesData.customModes.push(jsonMode)
	}

	// Write back to .roomodes file
	try {
		fs.writeFileSync(filePath, JSON.stringify(modesData, null, 2), "utf8")
	} catch (writeError) {
		console.error(`Error writing ${fileLabel} .roomodes file:`, writeError)
		vscode.window.showErrorMessage(t("errors.cannot_access_path", { path: filePath, error: writeError.message }))
	}
}

// Save mode to project .roomodes file (JSON format)
function saveToRoomodes(mode: ModeConfig, workspaceRoot: string): void {
	const roomodesPath = path.join(workspaceRoot, ".roomodes")
	saveToRoomodesFile(mode, roomodesPath, "project")
}

// Save mode to global .roomodes file (JSON format)
function saveToGlobalRoomodes(mode: ModeConfig, context: vscode.ExtensionContext): void {
	const globalRoomodesPath = path.join(context.globalStorageUri.fsPath, ".roomodes")
	saveToRoomodesFile(mode, globalRoomodesPath, "global")
}

// Convert ModeConfig to JSON format (v1)
function convertToJsonFormat(mode: ModeConfig): any {
	// Convert groups from object format to array format
	const groups = []
	for (const [groupName, options] of Object.entries(mode.groups)) {
		if (options) {
			groups.push([groupName, options])
		} else {
			groups.push(groupName)
		}
	}

	return {
		slug: mode.slug,
		name: mode.name,
		roleDefinition: mode.roleDefinition,
		customInstructions: mode.customInstructions,
		groups,
		source: mode.source,
	}
}

// Create a new mode in YAML format
export function createNewMode(mode: ModeConfig, workspaceRoot: string): void {
	try {
		// Always create new modes in the project directory with YAML format
		const projectModesDir = path.join(workspaceRoot, ".roo", "modes")
		try {
			if (!fs.existsSync(projectModesDir)) {
				fs.mkdirSync(projectModesDir, { recursive: true })
			}
		} catch (dirError) {
			console.error(`Error creating project modes directory:`, dirError)
			vscode.window.showErrorMessage(
				t("errors.cannot_access_path", { path: projectModesDir, error: dirError.message }),
			)
			return
		}

		const filePath = path.join(projectModesDir, `${mode.slug}.yaml`)
		saveYamlFile(filePath, convertToYamlFormat(mode))
	} catch (error) {
		console.error("Error creating new mode:", error)
		vscode.window.showErrorMessage(`${mode.slug}: ${error.message}`)
	}
}

// Constants for file paths and URLs
export const SCHEMA_FILENAME = "custom-mode-schema.json"
export const SCHEMA_GITHUB_URL = `https://raw.githubusercontent.com/RooVetGit/Roo-Code/refs/heads/main/${SCHEMA_FILENAME}`

// Convert internal ModeConfig to V2 schema format
function convertInternalToV2(mode: ModeConfig): ModeConfigInputV2 {
	return {
		name: mode.name,
		roleDefinition: mode.roleDefinition,
		customInstructions: mode.customInstructions,
		groups: mode.groups,
	}
}

// Convert ModeConfig to YAML-friendly format (v2)
export function convertToYamlFormat(mode: ModeConfig): any {
	// Convert to V2 schema format before outputting to YAML
	return convertInternalToV2(mode)
}

// Write to YAML file (output null as empty string, add schema reference)
export function saveYamlFile(filePath: string, data: any): void {
	try {
		// Create a new YAML document with schema reference comment
		const doc = new yaml.Document(data)

		// Add schema reference as a comment at the top of the file
		doc.commentBefore = ` yaml-language-server: $schema=${SCHEMA_GITHUB_URL}`

		// Convert to string with nullStr: "" option to display edit: instead of edit: null
		const yamlContent = doc.toString({ nullStr: "" })

		try {
			fs.writeFileSync(filePath, yamlContent, "utf8")
		} catch (writeError) {
			console.error(`Error writing YAML file ${filePath}:`, writeError)
			vscode.window.showErrorMessage(
				t("errors.cannot_access_path", { path: filePath, error: writeError.message }),
			)
		}
	} catch (yamlError) {
		console.error(`Error creating YAML document:`, yamlError)
		vscode.window.showErrorMessage(`YAML error: ${yamlError.message}`)
	}
}

/**
 * Get line and column information from character position
 */
export function getLineInfoFromPosition(content: string, position: number): { line: number; column: number } | null {
	if (position < 0 || position >= content.length) {
		return null
	}

	const lines = content.substring(0, position).split("\n")
	const line = lines.length
	const column = lines[lines.length - 1].length + 1

	return { line, column }
}
