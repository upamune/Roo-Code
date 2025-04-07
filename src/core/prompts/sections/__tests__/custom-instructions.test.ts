import { loadRuleFiles, addCustomInstructions } from "../custom-instructions"
import fs from "fs/promises"
import path from "path"
import { PathLike } from "fs"

// Mock fs/promises
jest.mock("fs/promises")

// Create mock functions
const readFileMock = jest.fn()
const statMock = jest.fn()
const readdirMock = jest.fn()

// Replace fs functions with our mocks
fs.readFile = readFileMock as any
fs.stat = statMock as any
fs.readdir = readdirMock as any

// Mock path.resolve and path.join to be predictable in tests
jest.mock("path", () => ({
	...jest.requireActual("path"),
	resolve: jest.fn().mockImplementation((...args) => args.join("/")),
	join: jest.fn().mockImplementation((...args) => args.join("/")),
	relative: jest.fn().mockImplementation((from, to) => to),
}))

// Mock process.cwd
const originalCwd = process.cwd
beforeAll(() => {
	process.cwd = jest.fn().mockReturnValue("/fake/cwd")
})

afterAll(() => {
	process.cwd = originalCwd
})

describe("loadRuleFiles", () => {
	beforeEach(() => {
		jest.clearAllMocks()
	})

	it("should read and trim file content", async () => {
		// Simulate no .roo/rules directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })
		readFileMock.mockResolvedValue("  content with spaces  ")
		const result = await loadRuleFiles("/fake/path")
		expect(readFileMock).toHaveBeenCalled()
		expect(result).toBe("\n# Rules from .roorules:\ncontent with spaces\n")
	})

	it("should handle ENOENT error", async () => {
		// Simulate no .roo/rules directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })
		readFileMock.mockRejectedValue({ code: "ENOENT" })
		const result = await loadRuleFiles("/fake/path")
		expect(result).toBe("")
	})

	it("should handle EISDIR error", async () => {
		// Simulate no .roo/rules directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })
		readFileMock.mockRejectedValue({ code: "EISDIR" })
		const result = await loadRuleFiles("/fake/path")
		expect(result).toBe("")
	})

	it("should throw on unexpected errors", async () => {
		// Simulate no .roo/rules directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })
		const error = new Error("Permission denied") as NodeJS.ErrnoException
		error.code = "EPERM"
		readFileMock.mockRejectedValue(error)

		await expect(async () => {
			await loadRuleFiles("/fake/path")
		}).rejects.toThrow()
	})

	it("should not combine content from multiple rule files when they exist", async () => {
		// Simulate no .roo/rules directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })
		readFileMock.mockImplementation((filePath: PathLike) => {
			if (filePath.toString().endsWith(".roorules")) {
				return Promise.resolve("roo rules content")
			}
			if (filePath.toString().endsWith(".clinerules")) {
				return Promise.resolve("cline rules content")
			}
			return Promise.reject({ code: "ENOENT" })
		})

		const result = await loadRuleFiles("/fake/path")
		expect(result).toBe("\n# Rules from .roorules:\nroo rules content\n")
	})

	it("should handle when no rule files exist", async () => {
		// Simulate no .roo/rules directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })
		readFileMock.mockRejectedValue({ code: "ENOENT" })

		const result = await loadRuleFiles("/fake/path")
		expect(result).toBe("")
	})

	it("should skip directories with same name as rule files", async () => {
		// Simulate no .roo/rules directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })
		readFileMock.mockImplementation((filePath: PathLike) => {
			if (filePath.toString().endsWith(".roorules")) {
				return Promise.reject({ code: "EISDIR" })
			}
			if (filePath.toString().endsWith(".clinerules")) {
				return Promise.reject({ code: "EISDIR" })
			}
			return Promise.reject({ code: "ENOENT" })
		})

		const result = await loadRuleFiles("/fake/path")
		expect(result).toBe("")
	})

	it("should use .roo/rules/ directory when it exists and has files", async () => {
		// Simulate .roo/rules directory exists
		statMock.mockResolvedValueOnce({
			isDirectory: jest.fn().mockReturnValue(true),
		} as any)

		// Simulate listing files
		readdirMock.mockResolvedValueOnce([
			{ name: "file1.txt", isFile: () => true },
			{ name: "file2.txt", isFile: () => true },
		] as any)

		// Simulate file stats
		statMock.mockImplementation(
			() =>
				({
					isFile: jest.fn().mockReturnValue(true),
				}) as any,
		)

		// Simulate file reading
		readFileMock.mockImplementation((filePath: PathLike) => {
			if (filePath.toString().includes("file1.txt")) {
				return Promise.resolve("content of file1")
			}
			if (filePath.toString().includes("file2.txt")) {
				return Promise.resolve("content of file2")
			}
			return Promise.reject({ code: "ENOENT" })
		})

		const result = await loadRuleFiles("/fake/path")
		expect(result).toContain("# Rules from /fake/path/.roo/rules")
		expect(result).toContain("# Filename: /fake/path/.roo/rules/file1.txt")
		expect(result).toContain("content of file1")
		expect(result).toContain("# Filename: /fake/path/.roo/rules/file2.txt")
		expect(result).toContain("content of file2")
	})

	it("should fall back to .roorules when .roo/rules/ is empty", async () => {
		// Simulate .roo/rules directory exists
		statMock.mockResolvedValueOnce({
			isDirectory: jest.fn().mockReturnValue(true),
		} as any)

		// Simulate empty directory
		readdirMock.mockResolvedValueOnce([])

		// Simulate .roorules exists
		readFileMock.mockImplementation((filePath: PathLike) => {
			if (filePath.toString().endsWith(".roorules")) {
				return Promise.resolve("roo rules content")
			}
			return Promise.reject({ code: "ENOENT" })
		})

		const result = await loadRuleFiles("/fake/path")
		expect(result).toBe("\n# Rules from .roorules:\nroo rules content\n")
	})

	it("should handle errors when reading directory", async () => {
		// Simulate .roo/rules directory exists
		statMock.mockResolvedValueOnce({
			isDirectory: jest.fn().mockReturnValue(true),
		} as any)

		// Simulate error reading directory
		readdirMock.mockRejectedValueOnce(new Error("Failed to read directory"))

		// Simulate .roorules exists
		readFileMock.mockImplementation((filePath: PathLike) => {
			if (filePath.toString().endsWith(".roorules")) {
				return Promise.resolve("roo rules content")
			}
			return Promise.reject({ code: "ENOENT" })
		})

		const result = await loadRuleFiles("/fake/path")
		expect(result).toBe("\n# Rules from .roorules:\nroo rules content\n")
	})
})

describe("addCustomInstructions", () => {
	beforeEach(() => {
		jest.clearAllMocks()
	})

	it("should combine all instruction types when provided", async () => {
		// Simulate no .roo/rules-test-mode directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })

		readFileMock.mockResolvedValue("mode specific rules")

		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/fake/path",
			"test-mode",
			{ language: "es" },
		)

		expect(result).toContain("Language Preference:")
		expect(result).toContain("Español") // Check for language name
		expect(result).toContain("(es)") // Check for language code in parentheses
		expect(result).toContain("Global Instructions:\nglobal instructions")
		expect(result).toContain("Mode-specific Instructions:\nmode instructions")
		expect(result).toContain("Rules from .roorules-test-mode:\nmode specific rules")
	})

	it("should return empty string when no instructions provided", async () => {
		// Simulate no .roo/rules directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })

		readFileMock.mockRejectedValue({ code: "ENOENT" })

		const result = await addCustomInstructions("", "", "/fake/path", "", {})
		expect(result).toBe("")
	})

	it("should handle missing mode-specific rules file", async () => {
		// Simulate no .roo/rules-test-mode directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })

		readFileMock.mockRejectedValue({ code: "ENOENT" })

		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/fake/path",
			"test-mode",
		)

		expect(result).toContain("Global Instructions:")
		expect(result).toContain("Mode-specific Instructions:")
		expect(result).not.toContain("Rules from .clinerules-test-mode")
	})

	it("should handle unknown language codes properly", async () => {
		// Simulate no .roo/rules-test-mode directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })

		readFileMock.mockRejectedValue({ code: "ENOENT" })

		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/fake/path",
			"test-mode",
			{ language: "xyz" }, // Unknown language code
		)

		expect(result).toContain("Language Preference:")
		expect(result).toContain('"xyz" (xyz) language') // For unknown codes, the code is used as the name too
		expect(result).toContain("Global Instructions:\nglobal instructions")
	})

	it("should throw on unexpected errors", async () => {
		// Simulate no .roo/rules-test-mode directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })

		const error = new Error("Permission denied") as NodeJS.ErrnoException
		error.code = "EPERM"
		readFileMock.mockRejectedValue(error)

		await expect(async () => {
			await addCustomInstructions("", "", "/fake/path", "test-mode")
		}).rejects.toThrow()
	})

	it("should skip mode-specific rule files that are directories", async () => {
		// Simulate no .roo/rules-test-mode directory
		statMock.mockRejectedValueOnce({ code: "ENOENT" })

		readFileMock.mockImplementation((filePath: PathLike) => {
			if (filePath.toString().includes(".clinerules-test-mode")) {
				return Promise.reject({ code: "EISDIR" })
			}
			return Promise.reject({ code: "ENOENT" })
		})

		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/fake/path",
			"test-mode",
		)

		expect(result).toContain("Global Instructions:\nglobal instructions")
		expect(result).toContain("Mode-specific Instructions:\nmode instructions")
		expect(result).not.toContain("Rules from .clinerules-test-mode")
	})

	it("should use .roo/rules-test-mode/ directory when it exists and has files", async () => {
		// Simulate .roo/rules-test-mode directory exists
		statMock.mockResolvedValueOnce({
			isDirectory: jest.fn().mockReturnValue(true),
		} as any)

		// Simulate listing files
		readdirMock.mockResolvedValueOnce([
			{ name: "rule1.txt", isFile: () => true },
			{ name: "rule2.txt", isFile: () => true },
		] as any)

		// Simulate file stats
		statMock.mockImplementation(
			() =>
				({
					isFile: jest.fn().mockReturnValue(true),
				}) as any,
		)

		// Simulate file reading
		readFileMock.mockImplementation((filePath: PathLike) => {
			if (filePath.toString().includes("rule1.txt")) {
				return Promise.resolve("mode specific rule 1")
			}
			if (filePath.toString().includes("rule2.txt")) {
				return Promise.resolve("mode specific rule 2")
			}
			return Promise.reject({ code: "ENOENT" })
		})

		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/fake/path",
			"test-mode",
			{ language: "es" },
		)

		expect(result).toContain("# Rules from /fake/path/.roo/rules-test-mode")
		expect(result).toContain("# Filename: /fake/path/.roo/rules-test-mode/rule1.txt")
		expect(result).toContain("mode specific rule 1")
		expect(result).toContain("# Filename: /fake/path/.roo/rules-test-mode/rule2.txt")
		expect(result).toContain("mode specific rule 2")
	})

	it("should fall back to .roorules-test-mode when .roo/rules-test-mode/ does not exist", async () => {
		// Simulate .roo/rules-test-mode directory does not exist
		statMock.mockRejectedValueOnce({ code: "ENOENT" })

		// Simulate .roorules-test-mode exists
		readFileMock.mockImplementation((filePath: PathLike) => {
			if (filePath.toString().includes(".roorules-test-mode")) {
				return Promise.resolve("mode specific rules from file")
			}
			return Promise.reject({ code: "ENOENT" })
		})

		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/fake/path",
			"test-mode",
		)

		expect(result).toContain("Rules from .roorules-test-mode:\nmode specific rules from file")
	})

	it("should fall back to .clinerules-test-mode when .roo/rules-test-mode/ and .roorules-test-mode do not exist", async () => {
		// Simulate .roo/rules-test-mode directory does not exist
		statMock.mockRejectedValueOnce({ code: "ENOENT" })

		// Simulate file reading
		readFileMock.mockImplementation((filePath: PathLike) => {
			if (filePath.toString().includes(".roorules-test-mode")) {
				return Promise.reject({ code: "ENOENT" })
			}
			if (filePath.toString().includes(".clinerules-test-mode")) {
				return Promise.resolve("mode specific rules from cline file")
			}
			return Promise.reject({ code: "ENOENT" })
		})

		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/fake/path",
			"test-mode",
		)

		expect(result).toContain("Rules from .clinerules-test-mode:\nmode specific rules from cline file")
	})

	it("should correctly format content from directories when using .roo/rules-test-mode/", async () => {
		// Need to reset mockImplementation first to avoid interference from previous tests
		statMock.mockReset()
		readFileMock.mockReset()

		// Simulate .roo/rules-test-mode directory exists
		statMock.mockImplementationOnce(() =>
			Promise.resolve({
				isDirectory: jest.fn().mockReturnValue(true),
			} as any),
		)

		// Simulate directory has files
		readdirMock.mockResolvedValueOnce([{ name: "rule1.txt", isFile: () => true }] as any)

		// Set up stat mock for checking files
		let statCallCount = 0
		statMock.mockImplementation(() => {
			statCallCount++
			return Promise.resolve({
				isFile: jest.fn().mockReturnValue(true),
				isDirectory: jest.fn().mockReturnValue(false),
			} as any)
		})

		// Set up read file mock for both rule files and fallback files
		readFileMock.mockImplementation((filePath: PathLike) => {
			if (filePath.toString().includes("rule1.txt")) {
				return Promise.resolve("mode specific rule content")
			}
			// Make sure we return ENOENT for all other files to test fallback behavior
			return Promise.reject({ code: "ENOENT" })
		})

		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/fake/path",
			"test-mode",
		)

		expect(result).toContain("# Rules from /fake/path/.roo/rules-test-mode")
		expect(result).toContain("# Filename: /fake/path/.roo/rules-test-mode/rule1.txt")
		expect(result).toContain("mode specific rule content")
	})
})

// Test directory existence checks through loadRuleFiles
describe("Directory existence checks", () => {
	beforeEach(() => {
		jest.clearAllMocks()
	})

	it("should detect when directory exists", async () => {
		// Mock the stats to indicate the directory exists
		statMock.mockResolvedValueOnce({
			isDirectory: jest.fn().mockReturnValue(true),
		} as any)

		// Simulate empty directory to test that stats is called
		readdirMock.mockResolvedValueOnce([])

		// For loadRuleFiles to return something for testing
		readFileMock.mockResolvedValueOnce("fallback content")

		await loadRuleFiles("/fake/path")

		// Verify stat was called to check directory existence
		expect(statMock).toHaveBeenCalledWith("/fake/path/.roo/rules")
	})

	it("should handle when directory does not exist", async () => {
		// Mock the stats to indicate the directory doesn't exist
		statMock.mockRejectedValueOnce({ code: "ENOENT" })

		// Mock file read to verify fallback
		readFileMock.mockResolvedValueOnce("fallback content")

		const result = await loadRuleFiles("/fake/path")

		// Verify it fell back to reading rule files directly
		expect(result).toBe("\n# Rules from .roorules:\nfallback content\n")
	})
})

// Indirectly test readTextFilesFromDirectory and formatDirectoryContent through loadRuleFiles
describe("Rules directory reading", () => {
	beforeEach(() => {
		jest.clearAllMocks()
	})

	it("should correctly format multiple files from directory", async () => {
		// Simulate .roo/rules directory exists
		statMock.mockResolvedValueOnce({
			isDirectory: jest.fn().mockReturnValue(true),
		} as any)

		// Simulate listing multiple files and a directory
		readdirMock.mockResolvedValueOnce([
			{ name: "file1.txt", isFile: () => true },
			{ name: "file2.txt", isFile: () => true },
			{ name: "subdir", isFile: () => false }, // This should be filtered out
		] as any)

		// Simulate file stats
		statMock.mockImplementation((path) => {
			if (path.toString().includes("subdir")) {
				return Promise.resolve({
					isFile: jest.fn().mockReturnValue(false),
				} as any)
			}
			return Promise.resolve({
				isFile: jest.fn().mockReturnValue(true),
			} as any)
		})

		// Simulate file reading
		readFileMock.mockImplementation((filePath: PathLike) => {
			if (filePath.toString().includes("file1.txt")) {
				return Promise.resolve("content of file1")
			}
			if (filePath.toString().includes("file2.txt")) {
				return Promise.resolve("content of file2")
			}
			return Promise.reject({ code: "ENOENT" })
		})

		const result = await loadRuleFiles("/fake/path")
		expect(result).toContain("# Rules from /fake/path/.roo/rules")
		expect(result).toContain("# Filename: /fake/path/.roo/rules/file1.txt")
		expect(result).toContain("content of file1")
		expect(result).toContain("# Filename: /fake/path/.roo/rules/file2.txt")
		expect(result).toContain("content of file2")
		// Verify subdirectory was filtered out
		expect(result).not.toContain("subdir")
	})

	it("should handle empty file list gracefully", async () => {
		// Simulate .roo/rules directory exists
		statMock.mockResolvedValueOnce({
			isDirectory: jest.fn().mockReturnValue(true),
		} as any)

		// Simulate empty directory
		readdirMock.mockResolvedValueOnce([])

		// For loadRuleFiles to return something for testing
		readFileMock.mockResolvedValueOnce("fallback content")

		const result = await loadRuleFiles("/fake/path")
		expect(result).toBe("\n# Rules from .roorules:\nfallback content\n")
	})
})
