/**
 * This script generates a JSON schema from the Zod schema for mode settings.
 * The generated JSON schema is used for schema validation in YAML editors.
 *
 * Note: This script defines the schema directly to avoid module resolution issues,
 * but it should be kept in sync with src/schemas/modeSchemas.ts
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { zodToJsonSchema } from 'zod-to-json-schema'
import schemas from "../src/schemas"
const { modeConfigInputSchema } = schemas

// Output path for the JSON schema
const OUTPUT_PATH = path.join(process.cwd(), 'custom-mode-schema.json')

/**
 * Generate and save the JSON schema
 */
async function generateSchema() {
  try {
    // Generate schema from Zod schema
    const jsonSchema = zodToJsonSchema(modeConfigInputSchema, {
      $refStrategy: 'none',
      name: 'CustomModeSchema',
    })

    // Add metadata to the schema
    const schemaWithMeta = {
      ...jsonSchema,
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'Roo-Code Custom Mode Schema',
      description: 'Schema for Roo-Code custom mode configuration files',
    }

    // Format and save as JSON
    const jsonContent = JSON.stringify(schemaWithMeta, null, 2)
    await fs.writeFile(OUTPUT_PATH, jsonContent, 'utf-8')

    console.log(`JSON schema generated: ${OUTPUT_PATH}`)
  } catch (error) {
    console.error('Error generating JSON schema:', error)
    process.exit(1)
  }
}

// Execute the script
generateSchema()
