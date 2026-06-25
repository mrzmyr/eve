import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { AddConnectionsDeps } from "#setup/boxes/add-connections.js";
import type { DeploymentInfo } from "#setup/project-resolution.js";
import type { PrompterValue, SelectOption, SingleSelectOptions } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";

import {
  CONNECTIONS_PROMPT_MESSAGE,
  runConnectionsFlow,
  type ConnectionsFlowDeps,
} from "./connections.js";

const APP_ROOT = "/app/agent";
const LINKED: DeploymentInfo = { state: "linked", projectId: "prj_1", orgId: "org_1" };

function scriptConnectionList(picks: ReadonlyArray<PrompterValue | "cancel">) {
  const queue = [...picks];
  const paints: SelectOption<PrompterValue>[][] = [];
  const requests: SingleSelectOptions<PrompterValue>[] = [];
  return {
    paints,
    requests,
    single(options: SingleSelectOptions<PrompterValue>): PrompterValue {
      if (options.message !== CONNECTIONS_PROMPT_MESSAGE) {
        throw new Error(`Unexpected select: ${options.message}`);
      }
      requests.push(options);
      paints.push(options.options);
      const next = queue.shift();
      if (next === undefined) throw new Error("Connection list exhausted its scripted picks.");
      if (next === "cancel") throw new WizardCancelledError();
      return next;
    },
  };
}

function addConnectionDeps(): AddConnectionsDeps {
  return {
    ensureConnection: vi.fn<AddConnectionsDeps["ensureConnection"]>(async (options) => ({
      slug: options.slug ?? options.entry.slug,
      protocol: options.protocol,
      action: "created",
      filePath: `${APP_ROOT}/agent/connections/${options.slug ?? options.entry.slug}.ts`,
      filesWritten: [`${APP_ROOT}/agent/connections/${options.slug ?? options.entry.slug}.ts`],
      filesSkipped: [],
      packageJsonUpdated: [],
      envKeysAdded: [],
      envKeysRequired: [],
    })),
    setupConnectionConnector: vi.fn<AddConnectionsDeps["setupConnectionConnector"]>(async () => ({
      kind: "existing",
      connectorUid: "mcp.linear.app/linear",
    })),
    listAuthoredConnections: vi.fn(async () => []),
    cleanupCreatedConnectionConnector: vi.fn(async () => {}),
  };
}

function flowDeps(overrides: Partial<ConnectionsFlowDeps> = {}): ConnectionsFlowDeps {
  return {
    detectDeployment: vi.fn(async () => LINKED),
    detectPackageManager: vi.fn<ConnectionsFlowDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "default",
    })),
    ensureConnectionDependencies: vi.fn(async () => []),
    getVercelAuthStatus: vi.fn<ConnectionsFlowDeps["getVercelAuthStatus"]>(
      async () => "authenticated",
    ),
    listAuthoredConnections: vi.fn(async () => []),
    runPackageManagerInstall: vi.fn(async () => true),
    addConnections: addConnectionDeps(),
    ...overrides,
  };
}

describe("runConnectionsFlow", () => {
  it("adds a catalog connection and repaints the searchable list", async () => {
    const listAuthoredConnections = vi
      .fn(async () => [] as string[])
      .mockResolvedValueOnce([])
      .mockResolvedValue(["linear"]);
    const list = scriptConnectionList(["linear", "done"]);
    const fake = createFakePrompter({ single: list.single });
    const addConnections = addConnectionDeps();
    const ensureConnectionDependencies = vi.fn(async () => []);
    const runPackageManagerInstall = vi.fn(async () => true);

    await expect(
      runConnectionsFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        deps: flowDeps({
          ensureConnectionDependencies,
          listAuthoredConnections,
          runPackageManagerInstall,
          addConnections,
        }),
      }),
    ).resolves.toEqual({ kind: "done", addedConnections: ["linear"] });

    expect(list.requests[0]).toMatchObject({
      search: true,
      placeholder: "type to search MCP servers",
    });
    expect(list.requests[0]).not.toHaveProperty("hintLayout");
    expect(list.paints[0]?.map((row) => row.value)).toEqual(["linear", "notion", "done"]);
    expect(list.paints[1]?.find((row) => row.value === "linear")).toMatchObject({
      completed: true,
      focusHint: "Already added",
    });
    expect(addConnections.setupConnectionConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalConnectorUid: "mcp.linear.app/linear",
        service: "mcp.linear.app",
      }),
    );
    expect(runPackageManagerInstall).toHaveBeenCalledWith("pnpm", APP_ROOT, expect.any(Object));
    expect(ensureConnectionDependencies).toHaveBeenCalledWith({ projectRoot: APP_ROOT });
    expect(runPackageManagerInstall.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(addConnections.ensureConnection).mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(addConnections.setupConnectionConnector).mock.invocationCallOrder[0],
    ).toBeLessThan(runPackageManagerInstall.mock.invocationCallOrder[0]!);
  });

  it("defaults to Done when every catalog connection is already authored", async () => {
    const list = scriptConnectionList(["done"]);
    await runConnectionsFlow({
      appRoot: APP_ROOT,
      prompter: createFakePrompter({ single: list.single }).prompter,
      deps: flowDeps({
        listAuthoredConnections: vi.fn(async () => ["linear", "notion"]),
      }),
    });

    expect(list.requests[0]?.initialValue).toBe("done");
  });

  it("points blocked rows at login or eve link and treats Esc as cancellation", async () => {
    const loggedOutList = scriptConnectionList(["cancel"]);
    const loggedOut = createFakePrompter({ single: loggedOutList.single });
    await expect(
      runConnectionsFlow({
        appRoot: APP_ROOT,
        prompter: loggedOut.prompter,
        deps: flowDeps({
          detectDeployment: vi.fn<ConnectionsFlowDeps["detectDeployment"]>(async () => ({
            state: "unlinked",
          })),
          getVercelAuthStatus: vi.fn<ConnectionsFlowDeps["getVercelAuthStatus"]>(
            async () => "logged-out",
          ),
        }),
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(loggedOutList.paints[0]?.find((row) => row.value === "linear")).toMatchObject({
      disabled: true,
      disabledReason: "Log in to Vercel first, see /vc:login",
    });

    const unlinkedList = scriptConnectionList(["done"]);
    await runConnectionsFlow({
      appRoot: APP_ROOT,
      prompter: createFakePrompter({ single: unlinkedList.single }).prompter,
      deps: flowDeps({
        detectDeployment: vi.fn<ConnectionsFlowDeps["detectDeployment"]>(async () => ({
          state: "unlinked",
        })),
      }),
    });
    expect(unlinkedList.paints[0]?.find((row) => row.value === "linear")).toMatchObject({
      disabled: true,
      disabledReason: "Run eve link first",
    });
  });

  it("does not mutate dependencies when connector selection is cancelled", async () => {
    const list = scriptConnectionList(["linear"]);
    const addConnections = addConnectionDeps();
    vi.mocked(addConnections.setupConnectionConnector).mockRejectedValueOnce(
      new WizardCancelledError(),
    );
    const ensureConnectionDependencies = vi.fn(async () => []);
    const runPackageManagerInstall = vi.fn(async () => true);

    await expect(
      runConnectionsFlow({
        appRoot: APP_ROOT,
        prompter: createFakePrompter({ single: list.single }).prompter,
        deps: flowDeps({
          addConnections,
          ensureConnectionDependencies,
          runPackageManagerInstall,
        }),
      }),
    ).resolves.toEqual({ kind: "cancelled" });

    expect(ensureConnectionDependencies).not.toHaveBeenCalled();
    expect(runPackageManagerInstall).not.toHaveBeenCalled();
  });
});
