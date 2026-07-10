/**
 * Detect the Scrivener project(s) currently open in the desktop Scrivener app.
 *
 * The MCP server has no link to the running Scrivener application, so "which
 * project is open" cannot be read from our own state. On macOS we can ask the
 * app via AppleScript: the accessibility layer (System Events) exposes the
 * titles of Scrivener's open windows, and a main project window is titled with
 * the project name. We resolve those names to .scriv paths on disk.
 *
 * macOS only for now. Windows/Linux window enumeration is a different mechanism;
 * callers receive `supported: false` elsewhere and should fall back to
 * discover_projects / an explicit path.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Result of probing the running Scrivener app for open projects. */
export interface OpenProjectDetection {
	/** True only on platforms where detection is implemented (macOS). */
	supported: boolean;
	/** True when a Scrivener process with at least one window was found. */
	running: boolean;
	/** Open project window names, with the `.scriv` extension stripped. */
	names: string[];
	/** True when macOS blocked the Apple event (Automation permission not granted). */
	permissionDenied: boolean;
	/** True when the probe was killed by its timeout (often a pending TCC prompt). */
	timedOut: boolean;
}

// Sentinel returned by the AppleScript when Scrivener is not running, kept
// distinct from the empty-string "running but no windows" case.
const NOT_RUNNING = '___SCRIVENER_NOT_RUNNING___';

// Constant script — no user input is interpolated, so there is no injection
// surface. It returns the sentinel when the process is absent, otherwise the
// newline-joined window titles.
const WINDOW_NAMES_SCRIPT = `
tell application "System Events"
	if not (exists process "Scrivener") then return "${NOT_RUNNING}"
	set winNames to name of windows of process "Scrivener"
end tell
set AppleScript's text item delimiters to linefeed
return winNames as text
`;

/**
 * Probe the running Scrivener app for the names of open project windows.
 * Never throws: OS/permission/timeout failures are reported via the result.
 */
export async function detectOpenScrivenerProjects(): Promise<OpenProjectDetection> {
	const base: OpenProjectDetection = {
		supported: false,
		running: false,
		names: [],
		permissionDenied: false,
		timedOut: false,
	};

	if (process.platform !== 'darwin') {
		return base;
	}

	try {
		const { stdout } = await execFileAsync('osascript', ['-e', WINDOW_NAMES_SCRIPT], {
			timeout: 5000,
		});
		const out = stdout.trim();
		if (out === NOT_RUNNING) {
			return { ...base, supported: true, running: false };
		}
		const names = out
			.split('\n')
			.map((s) => s.trim())
			.filter(Boolean);
		return { ...base, supported: true, running: true, names };
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { killed?: boolean };
		const message = String(err.message ?? err);
		const timedOut = err.killed === true || /ETIMEDOUT|timed out/i.test(message);
		// TCC / Automation denial surfaces as errAEEventNotPermitted (-1743) or a
		// textual "not allowed / not authorized" message.
		const permissionDenied =
			!timedOut &&
			/-1743|not allowed|not authoriz|assistive access|osascript is not allowed/i.test(
				message
			);
		return { ...base, supported: true, timedOut, permissionDenied };
	}
}

/** A detected open project resolved to a file on disk. */
export interface ResolvedOpenProject {
	/** The project name as shown in Scrivener's window title. */
	name: string;
	/** Absolute path to the matching .scriv folder. */
	path: string;
}

/** Outcome of matching detected window names against .scriv paths on disk. */
export interface NameResolution {
	/** Names matched to exactly one or more .scriv paths (one entry per path). */
	resolved: ResolvedOpenProject[];
	/** Window names with no matching .scriv folder in the searched locations. */
	unresolved: string[];
}

/**
 * Match detected window names to discovered .scriv paths by basename.
 * Pure and deterministic — the OS-dependent probe is separate so this can be
 * unit-tested. A window title carries the project name without the `.scriv`
 * extension, so `NAME` matches a folder basename of `NAME.scriv`. A single name
 * may resolve to several paths when identically named projects exist in
 * different folders; all candidates are returned for the caller to disambiguate.
 */
export function resolveProjectNames(names: string[], projectPaths: string[]): NameResolution {
	const byBasename = new Map<string, string[]>();
	for (const p of projectPaths) {
		const key = path.basename(p, '.scriv');
		const list = byBasename.get(key);
		if (list) list.push(p);
		else byBasename.set(key, [p]);
	}

	const resolved: ResolvedOpenProject[] = [];
	const unresolved: string[] = [];
	for (const name of names) {
		const matches = byBasename.get(name);
		if (matches && matches.length > 0) {
			for (const match of matches) resolved.push({ name, path: match });
		} else {
			unresolved.push(name);
		}
	}
	return { resolved, unresolved };
}
