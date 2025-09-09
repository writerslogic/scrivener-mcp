/**
 * Permission Management Utilities
 * Handles sudo requirements and permission checks gracefully
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { getLogger } from '../core/logger.js';
import { ApplicationError, ErrorCode } from '../core/errors.js';

const execAsync = promisify(exec);
const logger = getLogger('permission-manager');

export interface PermissionCheckResult {
	hasPermission: boolean;
	needsSudo: boolean;
	method: 'root' | 'sudo' | 'user' | 'none';
	error?: string;
}

export interface PermissionManagerOptions {
	operation: string;
	interactive?: boolean;
	timeout?: number;
}

export class PermissionManager {
	/**
	 * Check if current user can perform system operations
	 */
	static async checkSystemPermissions(): Promise<PermissionCheckResult> {
		try {
			// Check if running as root
			if (process.getuid && process.getuid() === 0) {
				return {
					hasPermission: true,
					needsSudo: false,
					method: 'root',
				};
			}

			// Check if sudo is available and accessible
			const sudoResult = await PermissionManager.checkSudo();
			if (sudoResult.hasPermission) {
				return sudoResult;
			}

			// Check if user has direct permissions for common operations
			const userResult = await PermissionManager.checkUserPermissions();
			return userResult;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			logger.warn('Permission check failed', { error: errorMessage });
			return {
				hasPermission: false,
				needsSudo: false,
				method: 'none',
				error: errorMessage,
			};
		}
	}

	/**
	 * Check sudo availability and permissions
	 */
	private static async checkSudo(): Promise<PermissionCheckResult> {
		try {
			// Check if sudo command exists
			await execAsync('which sudo', { timeout: 2000 });

			// Check if sudo is configured (non-interactive check)
			try {
				await execAsync('sudo -n true', { timeout: 5000 });
				// If we get here, sudo worked without password
				return {
					hasPermission: true,
					needsSudo: true,
					method: 'sudo',
				};
			} catch (sudoError) {
				// sudo failed, likely requires password
				return {
					hasPermission: false,
					needsSudo: true,
					method: 'sudo',
					error: 'Sudo requires password (non-interactive mode)',
				};
			}
		} catch (error) {
			return {
				hasPermission: false,
				needsSudo: false,
				method: 'none',
				error: 'Sudo not available',
			};
		}
	}

	/**
	 * Check user permissions for package management
	 */
	private static async checkUserPermissions(): Promise<PermissionCheckResult> {
		try {
			// Check if user can write to common installation directories
			const testPaths = ['/usr/local/bin', '/opt', `${process.env.HOME}/.local/bin`];

			for (const testPath of testPaths) {
				try {
					// Try to access the directory (non-destructive check)
					await execAsync(`test -w "${testPath}" 2>/dev/null`, { timeout: 2000 });
					return {
						hasPermission: true,
						needsSudo: false,
						method: 'user',
					};
				} catch {
					// Try next path
					continue;
				}
			}

			return {
				hasPermission: false,
				needsSudo: true,
				method: 'none',
				error: 'No writable installation directories found',
			};
		} catch (error) {
			return {
				hasPermission: false,
				needsSudo: false,
				method: 'none',
				error: (error as Error).message,
			};
		}
	}

	/**
	 * Execute command with appropriate permissions
	 */
	static async executeWithPermissions(
		command: string,
		options: PermissionManagerOptions
	): Promise<{ stdout: string; stderr: string }> {
		// Validate command for basic safety
		if (!command || typeof command !== 'string' || command.trim().length === 0) {
			throw new ApplicationError('Invalid command provided', ErrorCode.VALIDATION_ERROR, {
				operation: options.operation,
			});
		}

		// Basic command injection protection
		const dangerousPatterns = [
			/[;&|`$()]/, // Command chaining, substitution
			/\s(rm|dd|format)\s/i, // Dangerous commands
		];

		for (const pattern of dangerousPatterns) {
			if (pattern.test(command)) {
				logger.warn('Potentially dangerous command blocked', {
					command: command.slice(0, 50),
					operation: options.operation,
				});
				throw new ApplicationError(
					`Command contains potentially dangerous patterns`,
					ErrorCode.VALIDATION_ERROR,
					{ operation: options.operation }
				);
			}
		}

		const permissions = await PermissionManager.checkSystemPermissions();

		if (!permissions.hasPermission) {
			throw new ApplicationError(
				`Cannot execute ${options.operation}: ${permissions.error || 'Insufficient permissions'}`,
				ErrorCode.PERMISSION_DENIED,
				{
					operation: options.operation,
					method: permissions.method,
					needsSudo: permissions.needsSudo,
				}
			);
		}

		let finalCommand = command.trim();

		// Add sudo if needed and available
		if (permissions.needsSudo && permissions.method === 'sudo') {
			// Use non-interactive sudo to prevent hanging
			finalCommand = `sudo -n ${finalCommand}`;
		}

		try {
			logger.debug(`Executing with permissions: ${finalCommand}`);
			const result = await execAsync(finalCommand, {
				timeout: options.timeout || 30000,
			});

			return result;
		} catch (error) {
			const execError = error as any;
			if (
				execError.code === 1 &&
				execError.stderr?.includes('sudo: a password is required')
			) {
				throw new ApplicationError(
					`${options.operation} requires sudo password (running in non-interactive mode)`,
					ErrorCode.PERMISSION_DENIED,
					{
						operation: options.operation,
						suggestion: 'Run with sudo privileges or use Docker alternative',
					}
				);
			}
			throw error;
		}
	}

	/**
	 * Get installation alternatives when permissions are insufficient
	 */
	static getAlternatives(operation: string, platformInfo: any): string[] {
		const alternatives: string[] = [];

		// Always suggest Docker as a permission-free alternative
		if (platformInfo.packageManagers?.includes('docker')) {
			alternatives.push('Use Docker (no system permissions required)');
		}

		// Suggest user-space package managers
		switch (platformInfo.platform) {
			case 'darwin':
				alternatives.push('Install Homebrew to user directory');
				break;
			case 'linux':
				alternatives.push('Use user-space package managers (AppImage, Flatpak)');
				alternatives.push('Install to ~/.local directory');
				break;
			case 'win32':
				alternatives.push('Use Windows Package Manager or Chocolatey');
				break;
		}

		// Suggest embedded alternatives
		alternatives.push('Use embedded queue mode (no external dependencies)');

		return alternatives;
	}
}

/**
 * Higher-order function to wrap installation methods with permission handling
 */
export function withPermissionHandling<T extends any[], R>(
	fn: (...args: T) => Promise<R>,
	operation: string
) {
	return async (...args: T): Promise<R> => {
		try {
			return await fn(...args);
		} catch (error) {
			// Check if it's a permission error
			const message = (error as Error).message.toLowerCase();
			if (
				message.includes('permission denied') ||
				message.includes('sudo') ||
				message.includes('not allowed') ||
				message.includes('access denied')
			) {
				const permissions = await PermissionManager.checkSystemPermissions();
				const alternatives = PermissionManager.getAlternatives(operation, {
					platform: process.platform,
				});

				throw new ApplicationError(
					`${operation} failed due to insufficient permissions`,
					ErrorCode.PERMISSION_DENIED,
					{
						originalError: (error as Error).message,
						permissions,
						alternatives,
						suggestion: alternatives[0] || 'Use alternative installation method',
					}
				);
			}
			throw error;
		}
	};
}
