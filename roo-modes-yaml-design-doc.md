# Design Document: Improving Roo-Code Mode Configuration

## 1. Goal

This document proposes improvements to the mode configuration mechanism in Roo-Code. Specifically, it suggests the following changes:

- Gradually deprecate or automatically migrate the existing project-level `.roomodes` file (JSON format).
- Introduce two locations for mode configurations:
    - **Project Modes:** Located within the project at `.roo/modes/${modeSlug}.yaml`.
    - **Global Modes:** Stored within the Roo-Code VS Code extension's dedicated storage area, accessible across workspaces within VS Code.
- Change the configuration file format from JSON to YAML.
- Split mode definitions into individual files.

## 2. Background

Currently, Roo-Code modes are primarily configured in a single project-level `.roomodes` file (JSON format). This presents challenges:

- **Difficulty in Editing:** JSON's limitations with comments and multi-line strings (like `roleDefinition`) hinder readability and ease of editing. YAML provides a more natural editing experience.
- **Developer Experience:** Leveraging schema-based autocompletion and validation is more straightforward with YAML combined with schema directives.
- **Mode Sharing and Management:** The single-file approach makes sharing difficult. A directory-based structure simplifies adding/removing modes.

This proposal addresses these issues by adopting YAML and splitting files.

## 3. Proposal

We propose migrating from the current project-level `.roomodes` system to a new approach using YAML, with modes defined in individual files within two distinct scopes: the Project and the VS Code extension's Global storage.

### 3.1. Configuration File Format Change (JSON to YAML)

- **Format:** Mode definitions will be written in YAML format.
- **Library:** The `js-yaml` library will be used for parsing YAML.
- **Data Structure (Zod Schema):** The filename represents the mode's `slug`. The `source` (`"global"` or `"project"`) is determined during loading.

```typescript
// Example: src/modeSchemas.ts
import { z } from "zod"

// Tool Groups, Group Options, Group Entry (Definitions remain as provided)
export const toolGroups = ["read", "edit", "browser", "command", "mcp", "modes"] as const
export const toolGroupsSchema = z.enum(toolGroups)
// ... (rest of ToolGroup, GroupOptions, GroupEntry, groupEntryArraySchema definitions) ...

// Mode Config Input Schema (Corresponds to YAML file content - slug & source removed)
export const modeConfigInputSchema = z.object({
	name: z.string().min(1, "Name is required"),
	roleDefinition: z.string().min(1, "Role definition is required"),
	customInstructions: z.string().optional(),
	groups: groupEntryArraySchema,
})
export type ModeConfigInput = z.infer<typeof modeConfigInputSchema>

// Actual ModeConfig type used internally (includes slug and source)
export type ModeConfig = ModeConfigInput & {
	slug: string
	source: "global" | "project" // Indicates where the mode was loaded from
}
```

### 3.2. Configuration File Location and Structure

- **Mode Scopes:** Roo-Code (specifically within the VS Code extension context) will load modes from two locations:
    1.  **Global Modes (VS Code Extension Storage):** Modes stored in a dedicated `modes` subdirectory within the VS Code extension's global storage area. This location is managed by the extension and persists across workspaces. The path is obtained via the VS Code API (e.g., `context.globalStorageUri`). Users typically do not interact with this directory directly via the file system.
    2.  **Project Modes (Local Storage):** Modes stored in the project's `.roo/modes/` directory.
- **File Placement:** Each mode definition resides in a separate YAML file named after the mode's `slug` (e.g., `my-mode.yaml`) within either the Global `modes` directory or the Project `modes` directory.
- **Loading Logic (within VS Code Extension):**
    1.  The extension first accesses its Global storage (`context.globalStorageUri`) to find its `modes` subdirectory and loads any valid modes found.
    2.  It then searches the current project's `.roo/modes/` directory and loads any valid modes found there.
    3.  For each file found:
        - The filename (without extension) is extracted as the `slug` and validated.
        - The file content is parsed (`js-yaml`).
        - The parsed object is validated (`modeConfigInputSchema`).
        - A `ModeConfig` object is created with the `slug` and the `source` (`"global"` or `"project"`).
    4.  **Override Rule:** If a mode with the same `slug` exists in both the Global and Project locations, the **Project-specific mode takes precedence** (it completely overrides the Global one).
- **File Naming Convention:** Filenames (`slug`) must consist only of alphanumeric characters and hyphens (`-`).
- **YAML Schema Directive:** Recommended for editor support via a comment like `# yaml-language-server: $schema=<schema_url>`.

```yaml
# Example: Extension Storage / modes / architect.yaml (Global Mode)
# yaml-language-server: $schema=https://raw.githubusercontent.com/RooVetGit/Roo-Code/refs/heads/main/custom-mode-schema.json
name: Standard Architect
roleDefinition: |
    You are a software architect focusing on standard cloud patterns.
    Provide high-level designs and component diagrams.
groups: [read]
```

```yaml
# Example: Project / .roo / modes / architect.yaml (Project Mode - Overrides Global 'architect')
# yaml-language-server: $schema=https://raw.githubusercontent.com/RooVetGit/Roo-Code/refs/heads/main/custom-mode-schema.json
name: Project-Specific Architect
roleDefinition: |
    You are the lead architect for *this* project.
    Design considering our specific tech stack (React, Node.js, PostgreSQL) and existing infrastructure.
customInstructions: Refer to the project's ADRs in the /docs/adr folder.
groups: [read, edit] # Allow editing project ADRs
```

```
# Example Directory Structures
# 1. Extension Storage (Conceptual Path - managed by VS Code)
<VSCODE_EXTENSION_STORAGE>/RooVetGit.Roo-Code/modes/
└── architect.yaml

# 2. Project Storage
<YOUR_PROJECT_ROOT>/.roo/modes/
├── architect.yaml       # This overrides the Global 'architect.yaml'
└── code-review.yaml
```

### 3.3. Backwards Compatibility and Auto-Migration

- **Automatic Migration (Project-Level Only):**
    - This process remains focused _only_ on the project's legacy `.roomodes` file.
    - On startup, if the project's `.roo/modes/` directory does _not_ exist, but the project's `.roomodes` file _does_, the extension will:
        1. Parse `.roomodes`.
        2. Validate slugs.
        3. Write each valid mode (excluding `slug`) to `${slug}.yaml` in a **newly created project `.roo/modes/` directory**.
        4. Inform the user.
        5. Leave the original `.roomodes` untouched.
    - This migration is independent of the Global extension storage.
- **Considerations:** Error handling for migration (permissions, invalid slugs) requires a fallback to using the `.roomodes` content for that session.

### 3.4. Improving Developer Experience with JSON Schema

- **Schema Generation:** Automatically generate `custom-mode-schema.json` from `modeConfigInputSchema` using `zod-to-json-schema`.
- **Schema Usage:**
    - Host the schema at a stable URL.
    - Encourage users to add the `$schema` directive comment in their project's YAML mode files for editor autocompletion and validation. The extension could potentially inject this dynamically or provide UI for managing modes in its Global storage.

## 4. Alternatives Considered

- **Single Project YAML/JSON:** Does not allow for reusable Global modes or easy file-based management.
- **TOML/Markdown+Frontmatter:** Less conventional or more complex parsing than YAML for this use case.
- **No Auto-Migration:** Creates friction for users with existing `.roomodes` files.

**Conclusion:** The proposed approach (YAML + split files + Global/Project scope + auto-migration for project `.roomodes` + schema utilization) best addresses the requirements, including the use of VS Code extension storage for Global modes, while improving usability and developer experience within the VS Code context.

## 5. Technical Details

- **Key Changes:**
    - Implement loading logic within the VS Code extension to read from both the extension's Global storage (`context.globalStorageUri`/modes) and the project's `.roo/modes/`, applying the override rule (Project over Global).
    - Implement project-level auto-migration logic within the extension.
    - Ensure the core Roo-Code tool (if run independently) gracefully handles not having access to the Global modes, or define an interface for the extension to pass the full mode context if needed.
- **Libraries:** `js-yaml`, `zod`, `zod-to-json-schema`.
- **File System Access:** Node.js modules (`fs`, `path`) for general logic, **VS Code API (`context.globalStorageUri`, `vscode.workspace.fs`)** for extension-specific file operations.
- **Error Handling:** Robust handling for file access errors (in both scopes), migration errors, validation errors.
- **Schema Generation:** Generate schema from `modeConfigInputSchema`.

## 6. Open Questions

- **Standard Global Dir (`~/.config/roo`, `~/.roo`):** Where should global configuration files be saved? While storing them under the home directory is common for CLI tools, I'm not completely clear about how to handle this for VSCode extensions.

- **Detailed Auto-Migration Error Handling:** Specific user messages and fallback behavior for project `.roomodes` migration failures.

- **Strictness of YAML Parse/Validation Errors:** Notification level when ignoring invalid mode files found in either Global or Project locations.
