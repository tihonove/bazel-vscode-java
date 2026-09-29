import { Span } from '@opentelemetry/api';
import { existsSync } from 'fs';
import { join } from 'path';
import { format } from 'util';
import {
	ExtensionContext,
	ProgressLocation,
	RelativePattern,
	TextDocument,
	Uri,
	commands,
	extensions,
	tasks,
	window,
	workspace,
} from 'vscode';
import {
	BazelLanguageServerTerminal,
	getBazelTerminal,
} from './bazelLangaugeServerTerminal';
import { getBazelProjectFile } from './bazelprojectparser';
import { BazelTaskManager } from './bazelTaskManager';
import { registerBuildifierFormatter } from './buildifier';
import { Cleanup } from './cleanup';
import { Commands, executeJavaLanguageServerCommand } from './commands';
import { BazelVscodeExtensionAPI } from './extension.api';
import { registerLSClient } from './loggingTCPServer';
import { BazelRunTargetProvider } from './provider/bazelRunTargetProvider';
import { BazelTaskProvider } from './provider/bazelTaskProvider';
import { ExtensionOtel, registerMetrics } from './tracing/otelUtils';
import {
	getWorkspaceRoot,
	initBazelProjectFile,
	isBazelWorkspaceRoot,
} from './util';

const workspaceRoot = getWorkspaceRoot();

export async function activate(
	context: ExtensionContext
): Promise<BazelVscodeExtensionAPI> {
	// activates
	// LS processes current .eclipse/.bazelproject file
	// if it DNE create one
	// register TCP port with LS
	// project view should reflect what's in the LS
	// show any directories listed in the .bazelproject file
	// fetch all projects loaded into LS and display those as well
	// show .eclipse folder
	//

	registerMetrics(context);

	window.registerTreeDataProvider(
		'bazelTaskOutline',
		BazelRunTargetProvider.instance
	);
	tasks.registerTaskProvider('bazel', new BazelTaskProvider());

	BazelLanguageServerTerminal.trace('extension activated');

	workspace.onDidSaveTextDocument((doc) => {
		if (doc.fileName.includes('bazelproject')) {
			toggleBazelProjectSyncStatus(doc);
		}
	});

	context.subscriptions.push(
		commands.registerCommand(
			Commands.OPEN_BAZEL_BUILD_STATUS_CMD,
			getBazelTerminal().show
		)
	);

	commands.executeCommand(
		'setContext',
		'isBazelWorkspaceRoot',
		isBazelWorkspaceRoot()
	);
	commands.executeCommand(
		'setContext',
		'isMultiRoot',
		workspace.workspaceFile?.fsPath.includes('code-workspace')
	);
	// create .eclipse/.bazelproject file if DNE
	if (isBazelWorkspaceRoot()) {
		initBazelProjectFile();
		const showBazelprojectConfig =
			workspace.getConfiguration('bazel.projectview');
		if (showBazelprojectConfig.get('open')) {
			openBazelProjectFile();
			showBazelprojectConfig.update('open', false); // only open this file on the first activation of this extension
		}
		context.subscriptions.push(
			commands.registerCommand(Commands.OPEN_BAZEL_PROJECT_FILE, () =>
				openBazelProjectFile()
			)
		);
	}

	context.subscriptions.push(
		commands.registerCommand(Commands.SYNC_PROJECTS_CMD, syncProjectView)
	);
	context.subscriptions.push(
		commands.registerCommand(Commands.UPDATE_CLASSPATHS_CMD, updateClasspaths)
	);
	context.subscriptions.push(
		commands.registerCommand(Commands.REFRESH_PROJECTS_CMD, refreshProjects)
	);
	context.subscriptions.push(
		commands.registerCommand(Commands.DEBUG_LS_CMD, runLSCmd)
	);
	context.subscriptions.push(
		commands.registerCommand(
			Commands.CLEAN_GENERATED_PROJECTS,
			Cleanup.cleanGeneratedProjects
		)
	);
	context.subscriptions.push(
		commands.registerCommand(Commands.CLEAN_BUNDLE_CACHE, () =>
			Cleanup.cleanBundleCache(context)
		)
	);
	context.subscriptions.push(
		commands.registerCommand(Commands.FULL_RESET, () => Cleanup.fullReset(context))
	);
	context.subscriptions.push(
		commands.registerCommand(
			Commands.BAZEL_TARGET_REFRESH,
			BazelTaskManager.refreshTasks
		)
	);
	context.subscriptions.push(
		commands.registerCommand(
			Commands.BAZEL_TARGET_RUN,
			BazelTaskManager.runTask
		)
	);
	context.subscriptions.push(
		commands.registerCommand(
			Commands.BAZEL_TARGET_KILL,
			BazelTaskManager.killTask
		)
	);

	registerBuildifierFormatter();

	// trigger a refresh of the tree view when any task get executed
	tasks.onDidStartTask((_) => BazelRunTargetProvider.instance.refresh());
	tasks.onDidEndTask((_) => BazelRunTargetProvider.instance.refresh());

	// always update the project view after the initial project load
	registerLSClient();

	ExtensionOtel.getInstance(context).tracer.startActiveSpan(
		'extension.activation',
		(span: Span) => {
			span.addEvent('activation success');
			span.end();
		}
	);

	return Promise.resolve({
		parseProjectFile: await getBazelProjectFile(),
	});
}

export function deactivate() {}

function syncProjectView(): void {
	if (!isRedhatJavaReady()) {
		window.showErrorMessage(
			'Unable to sync project view. Java language server is not ready'
		);
		return;
	}

	const launchMode = workspace
		.getConfiguration('java.server')
		.get('launchMode');
	// if the launchMode is not Standard it should be changed and the window reloaded to apply that change
	if (!launchMode || launchMode !== 'Standard') {
		workspace
			.getConfiguration('java.server')
			.update('launchMode', 'Standard')
			.then(() => commands.executeCommand('workbench.action.reloadWindow'));
	}

	executeJavaLanguageServerCommand(Commands.SYNC_PROJECTS);
}

function updateClasspaths(resource?: Uri) {
	if (!isRedhatJavaReady()) {
		window.showErrorMessage(
			'Unable to update classpath. Java language server is not ready'
		);
		return;
	}
	// invoked from the explorer context menu with the selected resource,
	// from the command palette without arguments (use the active editor)
	const uri = resource ?? window.activeTextEditor?.document.uri;
	if (!uri) {
		window.showErrorMessage(
			'Unable to update classpath. Select a file or folder of a Bazel project first'
		);
		return;
	}
	executeJavaLanguageServerCommand(
		Commands.UPDATE_CLASSPATHS,
		uri.toString()
	).then(
		() => {},
		(err) => window.showErrorMessage(`Unable to update classpath: ${err}`)
	);
}

interface RefreshProjectsResult {
	refreshedProjects: number;
	reprovisionedProjects: string[];
	classpathsRefreshed: number;
	fullSyncRequired: boolean;
	messages: string[];
}

/**
 * Incremental refresh of the Bazel projects: resources from disk, packages
 * with changed BUILD files and the classpaths depending on them. Use it after
 * a branch switch or pull instead of a full synchronization.
 */
function refreshProjects() {
	if (!isRedhatJavaReady()) {
		window.showErrorMessage(
			'Unable to refresh projects. Java language server is not ready'
		);
		return;
	}
	window.withProgress(
		{
			location: ProgressLocation.Notification,
			title: 'Bazel: refreshing Java projects from disk',
		},
		() =>
			executeJavaLanguageServerCommand<RefreshProjectsResult>(
				Commands.REFRESH_PROJECTS
			).then(
				(result) => {
					const reprovisioned = result?.reprovisionedProjects ?? [];
					const summary =
						`Bazel: refreshed ${result?.refreshedProjects ?? 0} project(s)` +
						(reprovisioned.length > 0
							? `, re-imported ${reprovisioned.length} package(s) with changed BUILD files (${reprovisioned.join(', ')}), updated ${result?.classpathsRefreshed ?? 0} classpath(s)`
							: ', no BUILD file changes');
					if (result?.fullSyncRequired) {
						window
							.showWarningMessage(
								`${summary}. A full synchronization is required: ${(result.messages ?? []).join(' ')}`,
								'Synchronize Projects'
							)
							.then((val) => {
								if (val === 'Synchronize Projects') {
									syncProjectView();
								}
							});
					} else {
						window.showInformationMessage(summary);
					}
				},
				(err) => window.showErrorMessage(`Bazel project refresh failed: ${err}`)
			)
	);
}

function runLSCmd() {
	if (!isRedhatJavaReady()) {
		window.showErrorMessage(
			'Unable to execute LS cmd. Java language server is not ready'
		);
		return;
	}
	window
		.showInputBox({
			value: Commands.JAVA_LS_LIST_SOURCEPATHS,
		})
		.then((cmd) => {
			if (cmd) {
				const [lsCmd, args] = cmd.trim().split(/\s(.*)/s);
				executeJavaLanguageServerCommand<any>(lsCmd, args).then(
					(resp) => BazelLanguageServerTerminal.info(format(resp)),
					(err) => BazelLanguageServerTerminal.error(format(err))
				);
			}
		});
}

function isRedhatJavaReady(): boolean {
	const javaExtension = extensions.getExtension('redhat.java')?.exports;
	if (javaExtension) {
		return javaExtension.status === 'Started';
	}
	return false;
}

function toggleBazelProjectSyncStatus(doc: TextDocument) {
	if (workspace.getConfiguration('bazel.projectview').get('notification')) {
		window
			.showWarningMessage(
				`The Bazel Project View changed. Do you want to synchronize? [details](https://github.com/salesforce/bazel-eclipse/blob/main/docs/common/projectviews.md#project-views)`,
				...['Java Projects', 'Do Nothing']
			)
			.then((val) => {
				if (val === 'Java Projects') {
					syncProjectView();
				} else if (val === 'Do Nothing') {
					workspace
						.getConfiguration('bazel.projectview')
						.update('notification', false);
				}
			});
	}
}

function openBazelProjectFile() {
	try {
		const projectViewPath = join(workspaceRoot, '.eclipse', '.bazelproject');
		if (existsSync(projectViewPath)) {
			workspace
				.openTextDocument(projectViewPath)
				.then((f) => window.showTextDocument(f));
		} else {
			window.showErrorMessage(`${projectViewPath} does not exist`);
		}
	} catch (err) {
		window.showErrorMessage(
			'Unable to open the bazel project file; invalid workspace'
		);
	}
}
