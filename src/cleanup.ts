import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { ExtensionContext, window } from 'vscode';
import { getWorkspaceRoot } from './util';

/**
 * Cleanup helpers.
 *
 * Everything runs in a visible terminal on purpose: these commands delete
 * things, so the user should see exactly what is executed and what it printed.
 *
 * Paths to *other* extensions' state are derived from our own storage URIs
 * rather than guessed, so they are correct for local, Remote SSH and
 * profile-specific installs alike:
 *   globalStorage/<us>        -> globalStorage/redhat.java
 *   workspaceStorage/<hash>/<us> -> workspaceStorage/<hash>/redhat.java/jdt_ws
 */
export namespace Cleanup {
	interface CleanupStep {
		label: string;
		path: string;
	}

	function redhatGlobalStorage(context: ExtensionContext): string {
		return join(dirname(context.globalStorageUri.fsPath), 'redhat.java');
	}

	function redhatWorkspaceStorage(context: ExtensionContext): string | undefined {
		const storage = context.storageUri?.fsPath;
		return storage ? join(dirname(storage), 'redhat.java') : undefined;
	}

	function run(title: string, steps: CleanupStep[]) {
		const existing = steps.filter((s) => existsSync(s.path));
		if (existing.length === 0) {
			window.showInformationMessage(`${title}: nothing to clean.`);
			return;
		}

		window
			.showWarningMessage(
				`${title}\n\nThis will delete:\n${existing
					.map((s) => `• ${s.path}`)
					.join('\n')}`,
				{ modal: true },
				'Delete'
			)
			.then((choice) => {
				if (choice !== 'Delete') {
					return;
				}
				const terminal = window.createTerminal('Bazel Java: cleanup');
				terminal.show();
				for (const step of existing) {
					terminal.sendText(`echo "==> ${step.label}"`);
					terminal.sendText(`du -sh '${step.path}' 2>/dev/null`);
					terminal.sendText(`rm -rf '${step.path}' && echo "    removed"`);
				}
				terminal.sendText('echo "==> done"');
			});
	}

	/** Generated Eclipse projects and the stray output folder, both inside the repo. */
	export function cleanGeneratedProjects() {
		const root = getWorkspaceRoot();
		run('Clean generated Eclipse projects', [
			{ label: 'generated Eclipse projects', path: join(root, '.eclipse', 'projects') },
			{ label: 'stray Eclipse output folder', path: join(root, 'bin') },
		]);
	}

	/**
	 * OSGi bundle registry of the Java language server. It is shared across ALL
	 * VS Code profiles, so stale bundles keep loading even in windows where this
	 * extension is not installed.
	 */
	export function cleanBundleCache(context: ExtensionContext) {
		const redhat = redhatGlobalStorage(context);
		const steps: CleanupStep[] = [];
		for (const version of safeVersions(redhat)) {
			steps.push({
				label: `OSGi bundle cache (${version})`,
				path: join(redhat, version, 'config_linux', 'org.eclipse.osgi'),
			});
		}
		run('Clean language server bundle cache', steps);
	}

	/** Everything above plus this workspace's Java model. */
	export function fullReset(context: ExtensionContext) {
		const root = getWorkspaceRoot();
		const redhat = redhatGlobalStorage(context);
		const steps: CleanupStep[] = [
			{ label: 'generated Eclipse projects', path: join(root, '.eclipse', 'projects') },
			{ label: 'stray Eclipse output folder', path: join(root, 'bin') },
		];
		for (const version of safeVersions(redhat)) {
			steps.push({
				label: `OSGi bundle cache (${version})`,
				path: join(redhat, version, 'config_linux', 'org.eclipse.osgi'),
			});
		}
		const workspaceStorage = redhatWorkspaceStorage(context);
		if (workspaceStorage) {
			steps.push({
				label: 'Java workspace model (jdt_ws)',
				path: join(workspaceStorage, 'jdt_ws'),
			});
		}
		run('Full reset of the Java/Bazel IDE state', steps);
	}

	function safeVersions(redhatStorage: string): string[] {
		if (!existsSync(redhatStorage)) {
			return [];
		}
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { readdirSync } = require('fs');
		return readdirSync(redhatStorage, { withFileTypes: true })
			.filter((e: any) => e.isDirectory())
			.map((e: any) => e.name);
	}
}
