export interface DatabaseConfig {
	sqlite: {
		path: string;
		enabled: boolean;
	};
	neo4j: {
		uri: string;
		user: string;
		password: string;
		enabled: boolean;
		database?: string;
	};
}

export interface ProjectDatabasePaths {
	databaseDir: string;
	sqliteDb: string;
	neo4jData: string;
	configFile: string;
}

export const DEFAULT_DATABASE_CONFIG: Omit<DatabaseConfig, 'sqlite' | 'neo4j'> & {
	sqlite: Omit<DatabaseConfig['sqlite'], 'path'>;
	neo4j: Omit<DatabaseConfig['neo4j'], 'uri'>;
} = {
	sqlite: {
		enabled: true,
	},
	neo4j: {
		user: 'neo4j',
		password: 'scrivener-mcp',
		enabled: true,
		database: 'scrivener',
	},
};

/**
 * Generate database paths within a Scrivener project
 */
export function generateDatabasePaths(projectPath: string): ProjectDatabasePaths {
	const databaseDir = `${projectPath}/.scrivener-databases`;

	return {
		databaseDir,
		sqliteDb: `${databaseDir}/scrivener.db`,
		neo4jData: `${databaseDir}/neo4j-data`,
		configFile: `${databaseDir}/config.json`,
	};
}
