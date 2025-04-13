import { zodToJsonSchema } from 'zod-to-json-schema';
import * as fs from 'fs';
import * as path from 'path';
import { modeConfigInputSchemaV2 } from '../src/modeSchemas';
import { fileURLToPath } from 'url';

// ESM module polyfill for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SCHEMA_FILENAME = 'custom-mode-schema.json';
export const SCHEMA_GITHUB_URL = `https://raw.githubusercontent.com/RooVetGit/Roo-Code/refs/heads/main/${SCHEMA_FILENAME}`;

/**
 * Generate JSON schema for mode configuration from Zod schema
 */
function generateModeConfigSchema() {
    // Generate schema only for V2 (YAML format)
    const jsonSchema = zodToJsonSchema(modeConfigInputSchemaV2, {
        name: 'ModeConfig',
        $refStrategy: 'none',
    });
    
    // Write schema to file at the root of the project
    const outputPath = path.join(__dirname, '..', SCHEMA_FILENAME);
    fs.writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2), 'utf8');
    console.log(`Mode config schema generated at ${outputPath}`);
}

async function main() {
    generateModeConfigSchema();
}

main();