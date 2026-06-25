import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";

import {
  parseConnectors,
  parseCreatedConnector,
  setupConnectionConnector,
} from "./connection-connector.js";

vi.mock("#setup/primitives/run-vercel.js", () => ({
  captureVercel: vi.fn(),
  runVercel: vi.fn(),
  runVercelCaptureStdout: vi.fn(),
}));

const capture = vi.mocked(captureVercel);
const run = vi.mocked(runVercel);
const create = vi.mocked(runVercelCaptureStdout);
const SERVICE = "mcp.linear.app";
const CANONICAL_UID = "mcp.linear.app/linear";

describe("connector response parsing", () => {
  it("parses terminal JSON and rejects created connectors without user support", () => {
    const response = { uid: "linear/acme", id: "scl_1", supportedSubjectTypes: ["user"] };
    expect(
      parseCreatedConnector(`Connector ready\n\u001B[32m${JSON.stringify(response)}\u001B[0m`),
    ).toEqual({
      uid: "linear/acme",
      id: "scl_1",
    });
    expect(
      parseCreatedConnector(JSON.stringify({ ...response, supportedSubjectTypes: ["app"] })),
    ).toBeUndefined();
    expect(
      parseConnectors(
        {
          connectors: [
            { uid: "linear/acme", id: "scl_1", name: "acme", service: SERVICE },
            { uid: "notion/acme", id: "scl_2", service: "mcp.notion.com" },
          ],
        },
        SERVICE,
      ),
    ).toEqual([{ uid: "linear/acme", id: "scl_1", name: "acme" }]);
  });
});

describe("setupConnectionConnector", () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await mkdtemp(join(tmpdir(), "eve-connect-"));
    await mkdir(join(projectRoot, ".vercel"), { recursive: true });
    await writeFile(
      join(projectRoot, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_1", orgId: "org_1" }),
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  function options(prompter = createFakePrompter().prompter) {
    return {
      log: prompter.log,
      prompter,
      projectRoot,
      slug: "linear",
      service: SERVICE,
      canonicalConnectorUid: CANONICAL_UID,
      linkProject: async () => "prj_1",
    };
  }

  it("attaches the canonical connector without listing or creating", async () => {
    run.mockResolvedValue(true);

    await expect(setupConnectionConnector(options())).resolves.toEqual({
      kind: "existing",
      connectorUid: CANONICAL_UID,
    });
    expect(capture).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("paginates and offers only existing connectors that support user authorization", async () => {
    run.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    capture
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          connectors: [{ uid: "linear/app", id: "scl_app" }],
          cursor: "next_page",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({ connectors: [{ uid: "linear/user", id: "scl_user" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          uid: "linear/app",
          id: "scl_app",
          service: SERVICE,
          supportedSubjectTypes: ["app"],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          uid: "linear/user",
          id: "scl_user",
          service: SERVICE,
          supportedSubjectTypes: ["user"],
        }),
      });
    const answers = ["find", "linear/user"];
    const fake = createFakePrompter({ single: () => answers.shift()! });

    await expect(setupConnectionConnector(options(fake.prompter))).resolves.toEqual({
      kind: "existing",
      connectorUid: "linear/user",
    });
    expect(capture).toHaveBeenCalledWith(
      expect.arrayContaining(["--next", "next_page"]),
      expect.any(Object),
    );
    expect(fake.selectMessages).toEqual([
      "Which connector should linear use?",
      "Select a connector for linear",
    ]);
  });

  it("removes a created connector when attach fails", async () => {
    run.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    capture.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        connectors: [{ uid: CANONICAL_UID, id: "scl_existing", name: "Linear" }],
      }),
    });
    create.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        uid: "linear/linear-2",
        id: "scl_created",
        supportedSubjectTypes: ["user"],
      }),
    });
    const fake = createFakePrompter({
      single: () => "create",
      text: (input) => input.defaultValue!,
    });

    await expect(setupConnectionConnector(options(fake.prompter))).rejects.toThrow(
      "Could not attach linear/linear-2",
    );
    expect(create).toHaveBeenCalledWith(
      ["connect", "create", SERVICE, "--name", "linear-2", "-F", "json"],
      expect.any(Object),
    );
    expect(run).toHaveBeenLastCalledWith(
      ["connect", "remove", "scl_created", "--disconnect-all", "--yes"],
      expect.any(Object),
    );
  });

  it("recovers a partially created connector id from CLI progress and removes it", async () => {
    run.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    capture.mockResolvedValue({ ok: true, stdout: JSON.stringify({ connectors: [] }) });
    create.mockImplementation(async (_args, createOptions) => {
      createOptions.onOutput?.({ stream: "stderr", text: "Connector created: scl_partial" });
      return { ok: false, stdout: "" };
    });
    const fake = createFakePrompter({ single: () => "create", text: () => "acme" });

    await expect(setupConnectionConnector(options(fake.prompter))).rejects.toThrow(
      `Could not create the ${SERVICE} connector`,
    );
    expect(run).toHaveBeenLastCalledWith(
      ["connect", "remove", "scl_partial", "--disconnect-all", "--yes"],
      expect.any(Object),
    );
  });
});
