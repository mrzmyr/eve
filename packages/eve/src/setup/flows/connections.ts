import {
  CONNECTION_CATALOG,
  ensureConnectionDependencies,
  listAuthoredConnections,
} from "#setup/scaffold/index.js";
import { createPromptCommandOutput, withPhase } from "#setup/cli/index.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { runPackageManagerInstall } from "#setup/primitives/pm/run.js";
import { toErrorMessage } from "#shared/errors.js";

import { interactiveAsker } from "../ask.js";
import { addConnections, type AddConnectionsDeps } from "../boxes/add-connections.js";
import { selectConnections } from "../boxes/select-connections.js";
import {
  detectDeployment,
  isProjectResolved,
  projectResolutionFromDeployment,
} from "../project-resolution.js";
import type { Prompter, SelectOption, SingleSelectOptions } from "../prompter.js";
import { runInteractive, type AnySetupBox } from "../runner.js";
import { createDefaultSetupState, snapshotSetupState, type SetupState } from "../state.js";
import { WizardCancelledError } from "../step.js";
import {
  getVercelAuthStatus,
  vercelAuthBlockerReason,
  type VercelAuthStatus,
} from "../vercel-project.js";
import { withSpinner } from "../with-spinner.js";

import { prompterSink } from "./in-project.js";

export const CONNECTIONS_PROMPT_MESSAGE =
  "Select an MCP server to add to your agent through Vercel Connect";

const USER_AUTH_CONNECTIONS = CONNECTION_CATALOG.filter(
  (entry) => entry.slug === "linear" || entry.slug === "notion",
);
const USER_AUTH_CONNECTION_SLUGS = new Set(USER_AUTH_CONNECTIONS.map((entry) => entry.slug));

export interface ConnectionsFlowDeps {
  detectDeployment: typeof detectDeployment;
  detectPackageManager: typeof detectPackageManager;
  getVercelAuthStatus: typeof getVercelAuthStatus;
  ensureConnectionDependencies: typeof ensureConnectionDependencies;
  listAuthoredConnections: typeof listAuthoredConnections;
  runPackageManagerInstall: typeof runPackageManagerInstall;
  addConnections?: AddConnectionsDeps;
}

export type ConnectionsFlowResult =
  | { kind: "done"; addedConnections: readonly string[] }
  | { kind: "cancelled" }
  | { kind: "failed"; addedConnections: readonly string[]; message: string };

function connectionBlocker(
  authStatus: VercelAuthStatus,
  projectLinked: boolean,
): string | undefined {
  return vercelAuthBlockerReason(authStatus) ?? (projectLinked ? undefined : "Run eve link first");
}

function connectionRows(
  authored: ReadonlySet<string>,
  authStatus: VercelAuthStatus,
  projectLinked: boolean,
): SelectOption<string>[] {
  const blocker = connectionBlocker(authStatus, projectLinked);
  const rows: SelectOption<string>[] = USER_AUTH_CONNECTIONS.map((entry) => {
    if (authored.has(entry.slug)) {
      return {
        value: entry.slug,
        label: entry.label,
        completed: true,
        focusHint: "Already added",
      };
    }
    if (blocker !== undefined) {
      return {
        value: entry.slug,
        label: entry.label,
        disabled: true,
        disabledReason: blocker,
        disabledReasonTone: "warning",
      };
    }
    return { value: entry.slug, label: entry.label, hint: entry.hint };
  });
  rows.push({ value: "done", label: "Done" });
  return rows;
}

async function pickConnection(input: {
  authored: ReadonlySet<string>;
  authStatus: VercelAuthStatus;
  projectLinked: boolean;
  prompter: Prompter;
}): Promise<string | undefined> {
  const options = connectionRows(input.authored, input.authStatus, input.projectLinked);
  const request: SingleSelectOptions<string> = {
    message: CONNECTIONS_PROMPT_MESSAGE,
    options,
    search: true,
    placeholder: "type to search MCP servers",
  };
  if (
    !options.some(
      (option) => option.value !== "done" && option.disabled !== true && option.completed !== true,
    )
  ) {
    request.initialValue = "done";
  }
  try {
    return await input.prompter.select(request);
  } catch (error) {
    if (error instanceof WizardCancelledError) return undefined;
    throw error;
  }
}

async function installConnectionDependencies(input: {
  appRoot: string;
  deps: ConnectionsFlowDeps;
  prompter: Prompter;
  signal?: AbortSignal;
}): Promise<void> {
  const packageManager = await input.deps.detectPackageManager(input.appRoot);
  await input.deps.ensureConnectionDependencies({ projectRoot: input.appRoot });
  const installed = await withPhase(
    input.prompter.log,
    `Installing connection dependencies (${packageManager.kind} install)...`,
    () =>
      input.deps.runPackageManagerInstall(packageManager.kind, input.appRoot, {
        onOutput: createPromptCommandOutput(input.prompter.log),
        signal: input.signal,
      }),
  );
  if (!installed) {
    throw new Error(`Dependency installation failed. Run \`${packageManager.kind} install\`.`);
  }
}

/** Runs the searchable `/connect` task list and existing connection setup boxes. */
export async function runConnectionsFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  deps?: Partial<ConnectionsFlowDeps>;
}): Promise<ConnectionsFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: ConnectionsFlowDeps = {
    detectDeployment,
    detectPackageManager,
    ensureConnectionDependencies,
    getVercelAuthStatus,
    listAuthoredConnections,
    runPackageManagerInstall,
    ...input.deps,
  };
  const [deployment, initialAuthored, authStatus] = await withSpinner(
    prompter,
    "Checking the project…",
    () =>
      Promise.all([
        deps.detectDeployment(appRoot, { signal }),
        deps.listAuthoredConnections(appRoot),
        deps.getVercelAuthStatus(appRoot, { signal }),
      ]),
  );
  signal?.throwIfAborted();

  let state: SetupState = {
    ...createDefaultSetupState(),
    project: projectResolutionFromDeployment(deployment),
    projectPath: { kind: "resolved", inPlace: true, path: appRoot },
  };
  let authored = new Set(initialAuthored);
  const added: string[] = [];
  let dependenciesReady = false;

  while (true) {
    const selected = await pickConnection({
      authored,
      authStatus,
      projectLinked: isProjectResolved(state.project),
      prompter,
    });
    if (selected === undefined || selected === "done") {
      return added.length === 0 && selected === undefined
        ? { kind: "cancelled" }
        : { kind: "done", addedConnections: added };
    }
    if (authored.has(selected) || !USER_AUTH_CONNECTION_SLUGS.has(selected)) continue;

    const boxes: AnySetupBox<SetupState>[] = [
      selectConnections({ asker: interactiveAsker(prompter), presetConnections: [selected] }),
      addConnections({
        prompter,
        signal,
        deps: deps.addConnections,
        beforeScaffold: async () => {
          if (dependenciesReady) return;
          await installConnectionDependencies({ appRoot, deps, prompter, signal });
          dependenciesReady = true;
        },
      }),
    ];
    try {
      const result = await runInteractive(boxes, state, prompterSink(prompter), {
        snapshot: snapshotSetupState,
        signal,
      });
      if (result.kind !== "done") {
        return added.length === 0
          ? { kind: "cancelled" }
          : { kind: "done", addedConnections: added };
      }
      state = result.state;
      authored = new Set(await deps.listAuthoredConnections(appRoot));
      if (!authored.has(selected)) continue;
      added.push(selected);
    } catch (error) {
      authored = new Set(await deps.listAuthoredConnections(appRoot));
      if (!authored.has(selected)) throw error;
      if (!added.includes(selected)) added.push(selected);
      return { kind: "failed", addedConnections: added, message: toErrorMessage(error) };
    }
  }
}
