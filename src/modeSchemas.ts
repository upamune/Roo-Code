import { z } from "zod"

// Definition of tool groups, group options, and group entries
export const toolGroups = ["read", "edit", "browser", "command", "mcp", "modes"] as const
export const toolGroupsSchema = z.enum(toolGroups)

// Group options schema (common for both v1 and v2)
export const groupOptionsSchema = z.object({
	fileRegex: z.string().optional(),
	description: z.string().optional(),
})
export type GroupOptions = z.infer<typeof groupOptionsSchema>

// V1 schema (JSON format - array based)
export const groupEntrySchemaV1 = z.union([toolGroupsSchema, z.tuple([toolGroupsSchema, groupOptionsSchema])])
export type GroupEntryV1 = z.infer<typeof groupEntrySchemaV1>

export const groupEntryArraySchemaV1 = z.array(groupEntrySchemaV1).refine(
	(groups) => {
		const seen = new Set()
		return groups.every((group) => {
			const groupName = Array.isArray(group) ? group[0] : group
			if (seen.has(groupName)) {
				return false
			}
			seen.add(groupName)
			return true
		})
	},
	{ message: "Duplicate groups are not allowed" },
)

// V2 schema (YAML format - object based)
export const groupsSchemaV2 = z.record(toolGroupsSchema, groupOptionsSchema.nullish())

// Mode configuration input schema V1 (for JSON - backward compatibility)
export const modeConfigInputSchemaV1 = z.object({
	name: z.string().min(1, "Name is required"),
	roleDefinition: z.string().min(1, "Role definition is required"),
	customInstructions: z.string().optional(),
	groups: groupEntryArraySchemaV1,
})
export type ModeConfigInputV1 = z.infer<typeof modeConfigInputSchemaV1>

// Mode configuration input schema V2 (for YAML - new format)
export const modeConfigInputSchemaV2 = z.object({
	name: z.string().min(1, "Name is required"),
	roleDefinition: z.string().min(1, "Role definition is required"),
	customInstructions: z.string().optional(),
	groups: groupsSchemaV2,
})
export type ModeConfigInputV2 = z.infer<typeof modeConfigInputSchemaV2>

// Actual ModeConfig type used internally (includes slug, source, and origin)
export type ModeConfig = {
	slug: string
	name: string
	roleDefinition: string
	customInstructions?: string
	groups: Record<string, GroupOptions | undefined | null>
	source: "global" | "project" // Indicates where the mode was loaded from
	origin: "yaml" | "json" // Indicates the original file format
}
