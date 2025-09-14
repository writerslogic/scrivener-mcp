/**
 * WebAssembly Type Definitions for Node.js Environment
 * Provides complete typing for WebAssembly APIs used in the application
 */

declare global {
	namespace WebAssembly {
		interface GlobalDescriptor {
			value: ValueType;
			mutable?: boolean;
		}

		interface MemoryDescriptor {
			initial: number;
			maximum?: number;
			shared?: boolean;
		}

		interface TableDescriptor {
			element: TableKind;
			initial: number;
			maximum?: number;
		}

		interface TagDescriptor {
			parameters: ValueType[];
		}

		type ImportExportKind = 'function' | 'table' | 'memory' | 'global' | 'tag';
		type ValueType = 'i32' | 'i64' | 'f32' | 'f64' | 'v128' | 'funcref' | 'externref';
		type ExportValue = Function | Global | Memory | Table | Tag;
		type Exports = Record<string, ExportValue>;
		type ImportValue = ExportValue;
		type Imports = Record<string, ModuleImports>;
		type ModuleImports = Record<string, ImportValue>;
		type TableKind = 'funcref' | 'externref';

		interface Global {
			// Note: Using 'any' here for WebAssembly spec compliance
			// WebAssembly global values can be of various types (i32, i64, f32, f64, etc.)
			value: any;
			valueOf(): any;
		}

		class Instance {
			constructor(module: Module, importObject?: Imports);
			readonly exports: Exports;
		}

		class Module {
			constructor(bytes: BufferSource);
			static customSections(moduleObject: Module, sectionName: string): ArrayBuffer[];
			static exports(moduleObject: Module): ModuleExportDescriptor[];
			static imports(moduleObject: Module): ModuleImportDescriptor[];
		}

		interface ModuleExportDescriptor {
			name: string;
			kind: ImportExportKind;
		}

		interface ModuleImportDescriptor {
			module: string;
			name: string;
			kind: ImportExportKind;
		}

		class Memory {
			constructor(descriptor: MemoryDescriptor);
			readonly buffer: ArrayBuffer;
			grow(delta: number): number;
		}

		class Table {
			// Note: Using 'any' here for WebAssembly spec compliance
			// Table values can be functions or external references
			constructor(descriptor: TableDescriptor, value?: any);
			readonly length: number;
			get(index: number): any;
			grow(delta: number, value?: any): number;
			set(index: number, value?: any): void;
		}

		class Tag {
			constructor(descriptor: TagDescriptor);
		}

		interface CompileError extends Error {
			name: 'CompileError';
		}

		interface LinkError extends Error {
			name: 'LinkError';
		}

		interface RuntimeError extends Error {
			name: 'RuntimeError';
		}

		function compile(bytes: BufferSource): Promise<Module>;
		function compileStreaming(source: Response | PromiseLike<Response>): Promise<Module>;
		function instantiate(
			bytes: BufferSource,
			importObject?: Imports
		): Promise<WebAssemblyInstantiatedSource>;
		function instantiate(moduleObject: Module, importObject?: Imports): Promise<Instance>;
		function instantiateStreaming(
			source: Response | PromiseLike<Response>,
			importObject?: Imports
		): Promise<WebAssemblyInstantiatedSource>;
		function validate(bytes: BufferSource): boolean;

		interface WebAssemblyInstantiatedSource {
			module: Module;
			instance: Instance;
		}
	}
}

export {};
