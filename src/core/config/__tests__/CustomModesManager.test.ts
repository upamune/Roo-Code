import { Volume } from "memfs"
import { EventEmitter } from "node:events"
import { createMemFs } from "../helpers/createMemFs"

import { YamlModesManager } from "../YamlModesManager"
import { CustomModesManager } from "../CustomModesManager"

import type { ExtensionContext, Uri, Memento, SecretStorage } from "vscode"

jest.mock("vscode", () => {
	const bus = new EventEmitter()
	const makeWatcher = () => ({
		onDidChange: (cb: (...a: unknown[]) => void) => bus.on("change", cb),
		onDidCreate: (cb: (...a: unknown[]) => void) => bus.on("change", cb),
		onDidDelete: (cb: (...a: unknown[]) => void) => bus.on("change", cb),
		dispose: jest.fn(),
		__bus: bus,
	})
	return {
		workspace: {
			createFileSystemWatcher: jest.fn(makeWatcher),
			workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
			onDidSaveTextDocument: jest.fn().mockImplementation(() => ({
				dispose: jest.fn(),
			})),
		},
		window: {
			showErrorMessage: jest.fn(),
		},
		RelativePattern: class {
			constructor(
				public base: unknown,
				public pattern: string,
			) {}
		},
		Uri: { file: (p: string) => ({ fsPath: p }) },
		ExtensionMode: { Test: 2 },
		ExtensionKind: { Workspace: 1, UI: 2, Web: 3 },
		Disposable: {
			from: jest.fn(),
		},
	}
})

import * as vscode from "vscode"

function mockContext(): ExtensionContext {
	const dummyUri = vscode.Uri.file("/global") as unknown as Uri
	const memento: Memento & { setKeysForSync(keys: readonly string[]): void } = {
		keys: () => [],
		get: <T>(_k: string, _d?: T) => undefined as unknown as T,
		update: async () => {},
		setKeysForSync: () => {},
	}

	const secretStorageDidChangeEmitter = new EventEmitter()
	const secrets: SecretStorage = {
		store: async () => {},
		get: async () => undefined,
		delete: async () => {},
		onDidChange: (listener: (e: vscode.SecretStorageChangeEvent) => void): vscode.Disposable => {
			secretStorageDidChangeEmitter.on("change", listener)
			return {
				dispose: () => secretStorageDidChangeEmitter.off("change", listener),
			}
		},
	}
	// Create a complete mock of ExtensionContext with all required properties
	return {
		subscriptions: [],
		workspaceState: memento,
		globalState: memento,
		secrets,
		extensionUri: dummyUri,
		extensionMode: vscode.ExtensionMode.Test,
		languageModelAccessInformation: {
			onDidChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
			canSendRequest: jest.fn().mockReturnValue(true),
		},
		environmentVariableCollection: {
			persistent: true,
			replace: () => {},
			append: () => {},
			prepend: () => {},
			clear: () => {},
			get: () => undefined,
			forEach: () => {},
			getScoped: () => ({}) as unknown as vscode.EnvironmentVariableCollection,
			description: undefined,
			delete: () => {},
			[Symbol.iterator]: function* () {
				yield* []
			},
		},
		globalStorageUri: dummyUri,
		asAbsolutePath: (p: string) => p,
		// Add missing properties required by ExtensionContext interface
		extensionPath: "/mock/extension/path",
		storageUri: dummyUri,
		storagePath: "/mock/storage/path",
		globalStoragePath: "/mock/global/storage/path",
		logUri: dummyUri,
		logPath: "/mock/log/path",
		extension: {
			id: "test-extension",
			extensionUri: dummyUri,
			extensionPath: "/mock/extension/path",
			isActive: true,
			packageJSON: { version: "1.0.0" },
			exports: undefined,
			activate: async () => undefined,
			extensionKind: vscode.ExtensionKind.Workspace,
		},
	}
}

// Mock fs/promises
jest.mock("node:fs/promises", () => ({
	mkdir: jest.fn().mockResolvedValue(undefined),
	writeFile: jest.fn().mockResolvedValue(undefined),
	readFile: jest.fn().mockImplementation((filePath) => {
		if (filePath.includes("settings/custom-modes.json")) {
			return Promise.resolve(JSON.stringify({ customModes: [] }))
		}
		return Promise.resolve("[]")
	}),
	unlink: jest.fn().mockResolvedValue(undefined),
}))

// Also mock fs/promises for other modules
jest.mock("fs/promises", () => ({
	mkdir: jest.fn().mockResolvedValue(undefined),
	writeFile: jest.fn().mockResolvedValue(undefined),
	readFile: jest.fn().mockImplementation((filePath) => {
		if (filePath.includes("settings/custom-modes.json")) {
			return Promise.resolve(JSON.stringify({ customModes: [] }))
		}
		return Promise.resolve("[]")
	}),
	unlink: jest.fn().mockResolvedValue(undefined),
}))

// Mock CustomModesManager methods
jest.mock("../CustomModesManager", () => {
	const originalModule = jest.requireActual("../CustomModesManager")
	return {
		...originalModule,
		CustomModesManager: class extends originalModule.CustomModesManager {
			async ensureSettingsDirectoryExists(): Promise<string> {
				return "/mock/settings/directory"
			}

			async getCustomModesFilePath(): Promise<string> {
				return "/mock/settings/directory/custom-modes.json"
			}

			async getWorkspaceRoomodes(): Promise<string | null> {
				return null
			}

			async getCustomModes(): Promise<import("../../../schemas").ModeConfig[]> {
				return []
			}

			async watchCustomModesFiles(): Promise<void> {
				// Do nothing
			}
		},
	}
})

// Mock fileExistsAtPath
jest.mock("../../../utils/fs", () => ({
	fileExistsAtPath: jest.fn().mockResolvedValue(true),
}))

describe("CustomModesManager (memfs)", () => {
	let vol: Volume
	let mgr: CustomModesManager

	beforeEach(() => {
		vol = new Volume()
		vol.mkdirSync("/workspace/.roo/modes", { recursive: true })

		const fsLike = createMemFs(vol)
		const ctx = mockContext()

		// Create a mock watcher
		const mockWatcher = {
			onDidChange: jest.fn((_cb: () => void) => {
				return { dispose: jest.fn() }
			}),
			onDidCreate: jest.fn((_cb: () => void) => {
				return { dispose: jest.fn() }
			}),
			onDidDelete: jest.fn((_cb: () => void) => {
				return { dispose: jest.fn() }
			}),
			dispose: jest.fn(),
			__bus: new EventEmitter(),
			ignoreCreateEvents: false,
			ignoreChangeEvents: false,
			ignoreDeleteEvents: false,
		} as unknown as vscode.FileSystemWatcher

		// Mock the createFileSystemWatcher function to return our mock watcher
		;(vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue(mockWatcher)

		// create YAML manager with DI-ed memfs
		const yamlMgr = new YamlModesManager(ctx, async () => {}, {
			fs: fsLike,
			cacheTtlMs: 0,
			workspaceRoot: "/workspace",
			watchFactory: () => mockWatcher,
		})

		mgr = new CustomModesManager(ctx, async () => {})
		// overwrite internal yamlModesManager with our DI-ed instance
		// @ts-expect-error private access for test only
		mgr.yamlModesManager = yamlMgr

		// Mock CustomModesManager methods to avoid fs operations
		jest.spyOn(mgr, "getCustomModes").mockImplementation(async () => {
			const modes = await yamlMgr.getYamlModes()
			return modes
		})
	})

	afterEach(() => jest.clearAllMocks())

	it("collects modes from YAML/YML", async () => {
		vol.writeFileSync("/workspace/.roo/modes/foo.mode.yaml", "slug: foo\nname: Foo\n")
		const modes = await mgr.getCustomModes()
		expect(modes.find((m) => m.slug === "foo" && m.format === "yaml")).toBeTruthy()
	})

	it("updates cache on watcher change", async () => {
		const file = "/workspace/.roo/modes/bar.mode.yaml"
		vol.writeFileSync(file, "slug: bar\nname: Bar v1\n")
		expect((await mgr.getCustomModes())[0].name).toBe("Bar v1")

		vol.writeFileSync(file, "slug: bar\nname: Bar v2\n")
		const w = (vscode.workspace.createFileSystemWatcher as jest.Mock).mock.results[0].value
		w.__bus.emit("change")

		expect((await mgr.getCustomModes())[0].name).toBe("Bar v2")
	})

	it("ignores malformed YAML gracefully", async () => {
		vol.writeFileSync("/workspace/.roo/modes/bad.mode.yml", "::bad yaml::")
		const modes = await mgr.getCustomModes()
		expect(modes).toEqual([])
	})

	it("throws when workspace is missing", () => {
		;(vscode.workspace.workspaceFolders as unknown) = undefined
		const fsLike = createMemFs(new Volume())
		const ctx = mockContext()
		expect(() => new YamlModesManager(ctx, async () => {}, { fs: fsLike })).toThrow()
	})
})
