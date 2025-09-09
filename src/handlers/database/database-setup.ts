/**
 * Database Setup and Configuration Helper
 * Handles database installation detection and configuration
 */

import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import {
	AppError,
	ensureDir,
	ErrorCode,
	getEnv,
	safeParse,
	safeReadFile,
	writeJSON,
} from '../../utils/common.js';
import { waitForServiceReady } from '../../utils/condition-waiter.js';

const execAsync = promisify(exec);

export interface DatabaseSetupOptions {
	projectPath: string;
	interactive?: boolean;
	useEnvironmentVars?: boolean;
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
	/**
	 * Check if Neo4j is installed and running
	 */
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

		// Check if Neo4j is installed via command line
		try {
			const { stdout } = await execAsync('neo4j version 2>/dev/null');
			result.installed = true;
			result.version = stdout.trim();
		} catch {
			// Neo4j CLI not found
		}

		// Check if Docker is available
		try {
			await execAsync('docker --version 2>/dev/null');
			result.dockerAvailable = true;

			// Check if Neo4j container is running
			const { stdout } = await execAsync('docker ps --format "table {{.Names}}" 2>/dev/null');
			if (stdout.includes('neo4j')) {
				result.installed = true;
				result.running = true;
			}
		} catch {
			// Docker not available
		}

		// Check if Neo4j server is responding
		try {
			const neo4j = await import('neo4j-driver');
			const driver = neo4j.default.driver(
				'bolt://localhost:7687',
				neo4j.default.auth.basic('neo4j', 'neo4j')
			);
			await driver.verifyConnectivity();
			await driver.close();
			result.running = true;
		} catch {
			// Server not responding
		}

		return result;
	}

	/**
	 * Get database credentials from environment or config
	 */
	static async getCredentials(options: DatabaseSetupOptions): Promise<DatabaseCredentials> {
		const credentials: DatabaseCredentials = {
			neo4j: {
				uri: getEnv('NEO4J_URI', 'bolt://localhost:7687') || 'bolt://localhost:7687',
				user: getEnv('NEO4J_USER', 'neo4j') || 'neo4j',
				password: getEnv('NEO4J_PASSWORD', '') || '',
				database: getEnv('NEO4J_DATABASE', 'scrivener') || 'scrivener',
			},
		};

		// Check for .env file in project
		const envPath = path.join(options.projectPath, '.env');
		try {
			const envContent = await safeReadFile(envPath);
			const envVars = this.parseEnvFile(envContent);

			if (envVars.NEO4J_URI) credentials.neo4j.uri = envVars.NEO4J_URI;
			if (envVars.NEO4J_USER) credentials.neo4j.user = envVars.NEO4J_USER;
			if (envVars.NEO4J_PASSWORD) credentials.neo4j.password = envVars.NEO4J_PASSWORD;
			if (envVars.NEO4J_DATABASE) credentials.neo4j.database = envVars.NEO4J_DATABASE;
		} catch {
			// .env file not found or not readable
		}

		// Check for user config file
		const configPath = path.join(
			options.projectPath,
			'.scrivener-databases',
			'credentials.json'
		);
		try {
			const configContent = await safeReadFile(configPath);
			const config = safeParse(configContent, {}) as Record<string, unknown>;
			if (config.neo4j) {
				Object.assign(credentials.neo4j, config.neo4j);
			}
		} catch {
			// Config file not found
		}

		return credentials;
	}

	/**
	 * Setup Neo4j using Docker if not installed
	 */
	static async setupNeo4jWithDocker(): Promise<boolean> {
		try {
			console.log('Setting up Neo4j with Docker...');

			// Pull Neo4j image
			await execAsync('docker pull neo4j:latest');

			// Run Neo4j container
			const runCommand = `
				docker run -d \
				--name scrivener-neo4j \
				-p 7474:7474 -p 7687:7687 \
				-e NEO4J_AUTH=neo4j/scrivener-mcp \
				-e NEO4J_PLUGINS='["apoc"]' \
				-v scrivener-neo4j-data:/data \
				neo4j:latest
			`
				.replace(/\s+/g, ' ')
				.trim();

			await execAsync(runCommand);

			// Wait for Neo4j to start
			await this.waitForNeo4j();

			console.log('Neo4j container started successfully');
			return true;
		} catch (error) {
			console.error('Failed to setup Neo4j with Docker:', error);
			return false;
		}
	}

	/**
	 * Wait for Neo4j to become available
	 */
	private static async waitForNeo4j(maxAttempts = 30): Promise<void> {
		const neo4j = await import('neo4j-driver');

		// Use condition-based waiting instead of loop with fixed delays
		await waitForServiceReady('localhost', 7687, maxAttempts * 1000);

		// Final connectivity verification
		try {
			const driver = neo4j.default.driver(
				'bolt://localhost:7687',
				neo4j.default.auth.basic('neo4j', 'scrivener-mcp')
			);
			await driver.verifyConnectivity();
			await driver.close();
		} catch (error) {
			throw new AppError(
				'Neo4j service is running but authentication failed',
				ErrorCode.INITIALIZATION_ERROR,
				{ originalError: (error as Error).message }
			);
		}
	}

	/**
	 * Generate setup instructions for manual installation
	 */
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
        -p 7474:7474 -p 7687:7687 \\
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

	/**
	 * Parse .env file content
	 */
	private static parseEnvFile(content: string): Record<string, string> {
		const vars: Record<string, string> = {};
		const lines = content.split('\n');

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;

			const [key, ...valueParts] = trimmed.split('=');
			if (key && valueParts.length > 0) {
				let value = valueParts.join('=').trim();
				// Remove quotes if present
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

	/**
	 * Save credentials securely
	 */
	static async saveCredentials(
		projectPath: string,
		credentials: Partial<DatabaseCredentials>
	): Promise<void> {
		const configPath = path.join(projectPath, '.scrivener-databases', 'credentials.json');
		const configDir = path.dirname(configPath);

		await ensureDir(configDir);

		// Load existing config
		let existing: Record<string, unknown> = {};
		try {
			const content = await safeReadFile(configPath);
			existing = safeParse(content, {});
		} catch {
			// File doesn't exist yet
		}

		// Merge credentials
		const updated = {
			...existing,
			...credentials,
			updatedAt: new Date().toISOString(),
		};

		// Save with restricted permissions
		await writeJSON(configPath, updated);
		// Set restricted permissions after writing
		await fs.chmod(configPath, 0o600); // Read/write for owner only
	}
}
