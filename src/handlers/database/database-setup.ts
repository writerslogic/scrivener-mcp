import { readProjectTextFile, assertProjectArtifactPath } from '../../utils/scrivener-utils.js';
/**
 * Database Setup and Configuration Helper
 * Handles database installation detection and configuration
 */

import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { ensureDir, getEnv, writeJSON } from '../../utils/common.js';

const execAsync = promisify(exec);

export interface DatabaseSetupOptions {
	projectPath: string;
	interactive?: boolean;
	useEnvironmentVars?: boolean;
	bindAddress?: string;
}

export interface DatabaseCredentials {
	neo4j: {
		uri: string;
		user: string;
		password: string;
		database: string;
	};
}

export class DatabaseSetup {
	static async checkNeo4jAvailability(): Promise<{
		installed: boolean;
		running: boolean;
		version?: string;
		dockerAvailable?: boolean;
	}> {
		const result = {
			installed: false,
			running: false,
			version: undefined as string | undefined,
			dockerAvailable: false,
		};

		try {
			const { stdout } = await execAsync('neo4j version 2>/dev/null');
			result.installed = true;
			result.version = stdout.trim();
		} catch {
			// Neo4j CLI not found
		}

		try {
			await execAsync('docker --version 2>/dev/null');
			result.dockerAvailable = true;

			const { stdout } = await execAsync('docker ps --format "table {{.Names}}" 2>/dev/null');
			if (stdout.includes('neo4j')) {
				result.installed = true;
				result.running = true;
			}
		} catch {
			// Docker not available
		}

		try {
			const neo4j = await import('neo4j-driver');
			const driver = neo4j.default.driver(
				'bolt://localhost:7687',
				neo4j.default.auth.basic('neo4j', 'neo4j')
			);
			try {
				await driver.verifyConnectivity();
			} finally {
				await driver.close();
			}
			result.running = true;
		} catch {
			// Server not responding
		}

		return result;
	}

	static async getCredentials(options: DatabaseSetupOptions): Promise<DatabaseCredentials> {
		const credentials: DatabaseCredentials = {
			neo4j: {
				uri: getEnv('NEO4J_URI', 'bolt://localhost:7687') || 'bolt://localhost:7687',
				user: getEnv('NEO4J_USER', 'neo4j') || 'neo4j',
				password: getEnv('NEO4J_PASSWORD', '') || '',
				database: getEnv('NEO4J_DATABASE', 'scrivener') || 'scrivener',
			},
		};

		const envPath = path.join(options.projectPath, '.env');
		const envContent = await readProjectTextFile(options.projectPath, envPath, {
			maxBytes: 64 * 1024,
			optional: true,
		});
		if (envContent !== undefined) {
			const envVars = this.parseEnvFile(envContent);
			if (envVars.NEO4J_URI) credentials.neo4j.uri = envVars.NEO4J_URI;
			if (envVars.NEO4J_USER) credentials.neo4j.user = envVars.NEO4J_USER;
			if (envVars.NEO4J_PASSWORD) credentials.neo4j.password = envVars.NEO4J_PASSWORD;
			if (envVars.NEO4J_DATABASE) credentials.neo4j.database = envVars.NEO4J_DATABASE;
		}
		const config = await this.readCredentialConfig(options.projectPath);
		if (config.neo4j !== undefined) {
			if (!config.neo4j || typeof config.neo4j !== 'object' || Array.isArray(config.neo4j))
				throw new Error('Invalid Neo4j credential configuration');
			const values = config.neo4j as Record<string, unknown>;
			for (const key of ['uri', 'user', 'password', 'database'] as const) {
				const value = values[key];
				if (value === undefined) continue;
				if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value))
					throw new Error('Invalid Neo4j credential field');
				credentials.neo4j[key] = value;
			}
		}

		return credentials;
	}

	/**
	 * Setup Neo4j using Docker if not installed
	 */
	static async setupNeo4jWithDocker(options: DatabaseSetupOptions): Promise<boolean> {
		const { Neo4jAutoInstaller } = await import('./auto-installer.js');
		const result = await Neo4jAutoInstaller.install({
			method: 'docker',
			interactive: options.interactive ?? false,
			projectPath: options.projectPath,
			autoStart: true,
			bindAddress: options.bindAddress,
		});
		return result.success;
	}

	static getSetupInstructions(): string {
		return `
Database Setup Instructions
===========================

SQLite:
-------
SQLite is automatically handled by the application.
No manual installation required.

Neo4j (Optional but Recommended):
----------------------------------
Neo4j provides advanced graph analytics for your writing project.

Option 1: Docker (Recommended)
-------------------------------
1. Install Docker: https://docs.docker.com/get-docker/
2. Run: docker run -d --name scrivener-neo4j \\
        -p 127.0.0.1:7474:7474 -p 127.0.0.1:7687:7687 \\
        -e NEO4J_AUTH=neo4j/your-password \\
        neo4j:latest

Option 2: Native Installation
-----------------------------
1. Download Neo4j: https://neo4j.com/download/
2. Install and start Neo4j
3. Set initial password when prompted
4. Default connection: bolt://localhost:7687

Option 3: Neo4j AuraDB (Cloud)
------------------------------
1. Sign up at: https://neo4j.com/cloud/aura-free/
2. Create a free instance
3. Note your connection URI and credentials

Configuration:
-------------
Create a .env file in your project root:
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=scrivener

Or set environment variables before running the application.

The application will work with SQLite only if Neo4j is not available,
but you'll miss out on advanced features like:
- Character relationship mapping
- Story structure visualization
- Plot complexity analysis
- Narrative flow optimization
`.trim();
	}

	private static parseEnvFile(content: string): Record<string, string> {
		const vars: Record<string, string> = {};
		const lines = content.split('\n');

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;

			const [key, ...valueParts] = trimmed.split('=');
			if (key && valueParts.length > 0) {
				let value = valueParts.join('=').trim();

				if (
					(value.startsWith('"') && value.endsWith('"')) ||
					(value.startsWith("'") && value.endsWith("'"))
				) {
					value = value.slice(1, -1);
				}
				vars[key.trim()] = value;
			}
		}

		return vars;
	}

	static async saveCredentials(
		projectPath: string,
		credentials: Partial<DatabaseCredentials>
	): Promise<void> {
		const configPath = path.join(projectPath, '.scrivener-databases', 'credentials.json');
		const configDir = path.dirname(configPath);

		await ensureDir(configDir);
		const directory = await fs.lstat(configDir);
		if (!directory.isDirectory() || directory.isSymbolicLink())
			throw new Error('Credential directory must be a real directory');
		await fs.chmod(configDir, 0o700);

		const existing = await this.readCredentialConfig(projectPath);
		assertProjectArtifactPath(projectPath, configPath);

		const updated = {
			...existing,
			...credentials,
			updatedAt: new Date().toISOString(),
		};

		await writeJSON(configPath, updated);

		await fs.chmod(configPath, 0o600); // Read/write for owner only
	}
	private static async readCredentialConfig(
		projectPath: string
	): Promise<Record<string, unknown>> {
		const content = await readProjectTextFile(
			projectPath,
			path.join(projectPath, '.scrivener-databases', 'credentials.json'),
			{ maxBytes: 64 * 1024, optional: true }
		);
		if (content === undefined) return {};
		try {
			const value: unknown = JSON.parse(content);
			if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
			return value as Record<string, unknown>;
		} catch {
			throw new Error('Invalid database credential configuration');
		}
	}
}
