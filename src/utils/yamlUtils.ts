import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as yaml from "yaml"
import { fileExistsAtPath } from "./fs"
import { type GroupOptions, type ModeConfig, modeConfigInputSchema, convertGroupsArrayToObject } from "../schemas/index"
import { logger } from "./logging"

// Schema URL for editor integration and validation
export const SCHEMA_GITHUB_URL =
	"https://raw.githubusercontent.com/RooVetGit/Roo-Code/refs/heads/main/custom-mode-schema.json"

/**
 * Create a YAML document with schema reference
 * @param data The data to convert to YAML
 * @returns A YAML document with schema reference
 */
export function createYamlDocument(data: any): yaml.Document {
	const doc = new yaml.Document(data)

	// Add schema reference for editor support and validation
	doc.commentBefore = ` yaml-language-server: $schema=${SCHEMA_GITHUB_URL}`

	return doc
}

/**
 * Save data as YAML file with proper formatting
 * @param filePath Path to save the YAML file
 * @param data Data to save as YAML
 */
export async function saveYamlFile(filePath: string, data: any): Promise<void> {
	const doc = createYamlDocument(data)

	// Use nullStr option to ensure null values appear as empty entries rather than explicit null
	const yamlContent = doc.toString({ nullStr: "" })

	// Ensure directory exists
	const dirPath = path.dirname(filePath)
	await fs.mkdir(dirPath, { recursive: true })

	// Write file
	await fs.writeFile(filePath, yamlContent, "utf-8")
}

/**
 * Load mode from YAML file
 * @param filePath Path to the YAML file
 * @returns ModeConfig object or null if file doesn't exist or is invalid
 */
export async function loadModeFromYamlFile(filePath: string): Promise<ModeConfig | null> {
	try {
		const exists = await fileExistsAtPath(filePath)
		if (!exists) {
			return null
		}

		// Extract slug from filename
		const fileName = path.basename(filePath)
		const slug = path.parse(fileName).name

		// Validate slug format
		if (!slug || !/^[a-zA-Z0-9-]+$/.test(slug)) {
			logger.warn(`Invalid slug in filename: ${fileName}`)
			return null
		}

		// Read and parse YAML file
		const content = await fs.readFile(filePath, "utf-8")
		const data = yaml.parse(content)

		// Validate mode data
		const result = modeConfigInputSchema.safeParse(data)
		if (!result.success) {
			logger.warn(`Invalid mode config in ${filePath}: ${result.error.message}`)
			return null
		}

		// Determine source based on file location
		const isProjectMode = filePath.includes(".roo/modes/")
		const source = isProjectMode ? ("project" as const) : ("global" as const)

		return {
			...result.data,
			slug,
			source,
			format: "yaml" as const,
		}
	} catch (error) {
		logger.error(`Failed to load mode from ${filePath}:`, error)
		return null
	}
}

/**
 * Load modes from a directory containing YAML files
 * @param dirPath Path to the directory containing YAML files
 * @returns Array of ModeConfig objects
 */
export async function loadModesFromDirectory(dirPath: string): Promise<ModeConfig[]> {
	try {
		const exists = await fileExistsAtPath(dirPath)
		if (!exists) {
			return []
		}

		const files = await fs.readdir(dirPath)

		// Only process YAML files
		const yamlFiles = files.filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))

		const modes: ModeConfig[] = []
		for (const file of yamlFiles) {
			const filePath = path.join(dirPath, file)
			const mode = await loadModeFromYamlFile(filePath)
			if (mode) {
				modes.push(mode)
			}
		}

		return modes
	} catch (error) {
		logger.error(`Failed to load modes from ${dirPath}:`, error)
		return []
	}
}

/**
 * Convert ModeConfig to YAML-friendly format (convert groups array to object)
 * @param mode ModeConfig object
 * @returns ModeConfig with groups in object format
 */
export function convertModeToYamlFormat(
	mode: ModeConfig,
): Omit<ModeConfig, "groups"> & { groups: Record<string, null | GroupOptions> } {
	const { slug, name, roleDefinition, customInstructions, groups, source, format } = mode

	// Convert groups from array format to object format
	const groupsObject = convertGroupsArrayToObject(groups)

	return {
		slug,
		name,
		roleDefinition,
		customInstructions,
		groups: groupsObject,
		source,
		format,
	}
}

/**
 * Save mode as YAML file
 * @param dirPath Directory to save the YAML file
 * @param mode ModeConfig object
 */
export async function saveModeAsYaml(dirPath: string, mode: ModeConfig): Promise<void> {
	try {
		// Ensure directory exists
		await fs.mkdir(dirPath, { recursive: true })

		// Apply trim() only when saving to file - preserves whitespace in UI but keeps files clean
		const trimmedMode = {
			...mode,
			roleDefinition: mode.roleDefinition?.trim() || "",
			customInstructions: mode.customInstructions?.trim(),
		}

		// Convert mode to YAML-friendly format
		const yamlMode = convertModeToYamlFormat(trimmedMode)

		// Remove properties that shouldn't be in the file
		const { slug, source: _source, format: _format, ...modeData } = yamlMode

		// Save as YAML file
		const filePath = path.join(dirPath, `${slug}.yaml`)
		await saveYamlFile(filePath, modeData)
	} catch (error) {
		logger.error(`Failed to save mode as YAML: ${error instanceof Error ? error.message : String(error)}`)
		throw error
	}
}
