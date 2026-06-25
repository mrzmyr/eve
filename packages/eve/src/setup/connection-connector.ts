import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { createPromptCommandOutput, type ChannelSetupLog, withPhase } from "#setup/cli/index.js";
import type { ProcessOutputHandler } from "#setup/primitives/process-output.js";
import type { Prompter } from "#setup/prompter.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";

/** Controls connector selection while adding a Connect-backed connection. */
export interface SetupConnectionConnectorOptions {
  log: ChannelSetupLog;
  prompter: Prompter;
  projectRoot: string;
  slug: string;
  service: string;
  canonicalConnectorUid: string;
  signal?: AbortSignal;
  linkProject: () => Promise<string | undefined>;
}

/** Connector identity returned by the Vercel CLI. */
export interface ConnectConnectorRef {
  uid: string;
  id: string;
  name?: string;
}

export type SetupConnectionConnectorResult =
  | { kind: "existing"; connectorUid: string }
  | { kind: "created"; connectorUid: string; connectorId: string };

interface ProjectLink {
  projectId: string;
  orgId: string;
}

type ConnectorResolution =
  | { kind: "existing"; connector: ConnectConnectorRef }
  | { kind: "created"; connector: ConnectConnectorRef };

const CREATED_CONNECTOR = /\bConnector created:\s*(scl_[A-Za-z0-9_-]+)\b/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTerminalJsonObject(source: string): unknown {
  const clean = stripVTControlCharacters(source).trim();
  let start = clean.lastIndexOf("{");
  while (start >= 0) {
    try {
      return JSON.parse(clean.slice(start));
    } catch {
      start = clean.lastIndexOf("{", start - 1);
    }
  }
  return undefined;
}

function parseConnectorRef(value: unknown): ConnectConnectorRef | undefined {
  if (!isRecord(value) || typeof value["uid"] !== "string" || typeof value["id"] !== "string") {
    return undefined;
  }
  const connector: ConnectConnectorRef = { uid: value["uid"], id: value["id"] };
  if (typeof value["name"] === "string") connector.name = value["name"];
  return connector;
}

/** Parses a created connector that can issue user credentials. */
export function parseCreatedConnector(stdout: string): ConnectConnectorRef | undefined {
  const value = parseTerminalJsonObject(stdout);
  const connector = parseConnectorRef(value);
  if (!isRecord(value) || connector === undefined) return undefined;
  const subjects = value["supportedSubjectTypes"];
  return Array.isArray(subjects) && subjects.includes("user") ? connector : undefined;
}

/** Parses the service-scoped connector inventory returned by the Vercel CLI. */
export function parseConnectors(value: unknown, service: string): ConnectConnectorRef[] {
  if (!isRecord(value)) return [];
  const candidates = value["connectors"] ?? value["clients"];
  if (!Array.isArray(candidates)) return [];

  const connectors: ConnectConnectorRef[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate["service"] === "string" && candidate["service"] !== service) continue;
    const connector = parseConnectorRef(candidate);
    if (connector !== undefined) connectors.push(connector);
  }
  return connectors;
}

async function readProjectLink(projectRoot: string): Promise<ProjectLink | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(projectRoot, ".vercel", "project.json"), "utf8"),
    );
    return isRecord(value) &&
      typeof value["projectId"] === "string" &&
      typeof value["orgId"] === "string"
      ? { projectId: value["projectId"], orgId: value["orgId"] }
      : undefined;
  } catch {
    return undefined;
  }
}

async function ensureLinkedProject(options: SetupConnectionConnectorOptions): Promise<ProjectLink> {
  const expectedProjectId = await options.linkProject();
  const project = await readProjectLink(options.projectRoot);
  if (project === undefined || project.projectId !== expectedProjectId) {
    throw new Error("A linked Vercel project is required. Run `eve link`, then retry /connect.");
  }
  return project;
}

async function listConnectors(
  options: SetupConnectionConnectorOptions,
  onOutput: ProcessOutputHandler,
): Promise<ConnectConnectorRef[]> {
  const connectors: ConnectConnectorRef[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const args = ["connect", "list", "-F", "json", "--all-projects", "--service", options.service];
    if (cursor !== undefined) args.push("--next", cursor);
    const result = await captureVercel(args, {
      cwd: options.projectRoot,
      onOutput,
      signal: options.signal,
    });
    if (!result.ok) throw new Error(result.failure.message);
    const page = parseTerminalJsonObject(result.stdout);
    if (!isRecord(page) || !Array.isArray(page["connectors"] ?? page["clients"])) {
      throw new Error(`Vercel returned an invalid connector list for ${options.service}.`);
    }
    connectors.push(...parseConnectors(page, options.service));
    const next = typeof page["cursor"] === "string" ? page["cursor"] : undefined;
    if (next !== undefined && seenCursors.has(next)) {
      throw new Error(`The connector list repeated cursor ${next}.`);
    }
    if (next !== undefined) seenCursors.add(next);
    cursor = next;
  } while (cursor !== undefined);
  return connectors;
}

async function supportsUserAuthorization(
  options: SetupConnectionConnectorOptions,
  project: ProjectLink,
  connector: ConnectConnectorRef,
  onOutput: ProcessOutputHandler,
): Promise<boolean> {
  const endpoint = `/v1/connect/connectors/${encodeURIComponent(connector.id)}`;
  const result = await captureVercel(["api", endpoint, "--scope", project.orgId, "--raw"], {
    cwd: options.projectRoot,
    onOutput,
    signal: options.signal,
  });
  if (!result.ok) throw new Error(`Could not verify connector ${connector.uid}.`);
  const value = parseTerminalJsonObject(result.stdout);
  if (
    !isRecord(value) ||
    value["id"] !== connector.id ||
    value["uid"] !== connector.uid ||
    (typeof value["service"] === "string" && value["service"] !== options.service)
  ) {
    throw new Error(`Vercel returned invalid details for connector ${connector.uid}.`);
  }
  const subjects = value["supportedSubjectTypes"];
  return Array.isArray(subjects) && subjects.includes("user");
}

function connectorNames(connectors: readonly ConnectConnectorRef[]): Set<string> {
  const names = new Set<string>();
  for (const connector of connectors) {
    if (connector.name !== undefined) names.add(connector.name.toLowerCase());
    const uidName = connector.uid.slice(connector.uid.lastIndexOf("/") + 1).trim();
    if (uidName.length > 0) names.add(uidName.toLowerCase());
  }
  return names;
}

function nextConnectorName(slug: string, names: ReadonlySet<string>): string {
  if (!names.has(slug.toLowerCase())) return slug;
  let suffix = 2;
  while (names.has(`${slug}-${suffix}`.toLowerCase())) suffix += 1;
  return `${slug}-${suffix}`;
}

/** Removes a connector created by this setup attempt. */
export async function cleanupCreatedConnectionConnector(input: {
  log: ChannelSetupLog;
  projectRoot: string;
  connectorId: string;
}): Promise<void> {
  const removed = await runVercel(
    ["connect", "remove", input.connectorId, "--disconnect-all", "--yes"],
    { cwd: input.projectRoot, onOutput: createPromptCommandOutput(input.log) },
  );
  if (!removed) {
    throw new Error(
      `Could not remove connector ${input.connectorId}; run \`vercel connect remove ${input.connectorId} --disconnect-all --yes\`.`,
    );
  }
}

async function cleanupThenThrow(
  options: SetupConnectionConnectorOptions,
  connectorId: string,
  message: string,
): Promise<never> {
  try {
    await cleanupCreatedConnectionConnector({
      log: options.log,
      projectRoot: options.projectRoot,
      connectorId,
    });
  } catch (error) {
    const cleanup = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} ${cleanup}`);
  }
  options.signal?.throwIfAborted();
  throw new Error(message);
}

async function attach(
  options: SetupConnectionConnectorOptions,
  connectorUid: string,
  onOutput: ProcessOutputHandler,
): Promise<boolean> {
  return runVercel(["connect", "attach", connectorUid, "--yes"], {
    cwd: options.projectRoot,
    onOutput,
    signal: options.signal,
  });
}

async function resolveFallbackConnector(
  options: SetupConnectionConnectorOptions,
  project: ProjectLink,
  onOutput: ProcessOutputHandler,
  initialNotice: string,
): Promise<ConnectorResolution> {
  let notice = initialNotice;
  while (true) {
    const choice = await options.prompter.select<"find" | "create">({
      message: `Which connector should ${options.slug} use?`,
      hintLayout: "inline",
      notices: [{ tone: "warning", text: notice }],
      options: [
        { value: "find", label: "Find a new one", hint: "Browse existing connectors" },
        { value: "create", label: "Create a new one", hint: "Register another connector" },
      ],
    });
    const connectors = await listConnectors(options, onOutput);

    if (choice === "find") {
      const supported: ConnectConnectorRef[] = [];
      for (const connector of connectors) {
        if (await supportsUserAuthorization(options, project, connector, onOutput)) {
          supported.push(connector);
        }
      }
      if (supported.length === 0) {
        notice = `No existing ${options.service} connectors support user authorization.`;
        continue;
      }
      const byUid = new Map(supported.map((connector) => [connector.uid, connector]));
      const uid = await options.prompter.select<string>({
        message: `Select a connector for ${options.slug}`,
        search: true,
        placeholder: "type to search connectors",
        options: supported.map((connector) => ({
          value: connector.uid,
          label: connector.uid,
          hint: connector.name ?? connector.id,
        })),
      });
      const connector = byUid.get(uid);
      if (connector === undefined) throw new Error(`Connector ${uid} is no longer available.`);
      return { kind: "existing", connector };
    }

    const names = connectorNames(connectors);
    const name = (
      await options.prompter.text({
        message: "New connector name",
        defaultValue: nextConnectorName(options.slug, names),
        validate: (value) => {
          const normalized = value.trim().toLowerCase();
          if (normalized.length === 0) return "A name is required.";
          return names.has(normalized) ? "A connector with this name already exists." : undefined;
        },
      })
    ).trim();
    const transcript: string[] = [];
    const createOutput: ProcessOutputHandler = (line) => {
      transcript.push(line.text);
      onOutput(line);
    };
    const created = await withPhase(
      options.log,
      "Waiting for you to complete setup in the browser…",
      () =>
        runVercelCaptureStdout(
          ["connect", "create", options.service, "--name", name, "-F", "json"],
          { cwd: options.projectRoot, onOutput: createOutput, signal: options.signal },
        ),
      { kind: "external-action", emphasis: "browser" },
    );
    const raw = parseConnectorRef(parseTerminalJsonObject(created.stdout));
    const ownedId = raw?.id ?? CREATED_CONNECTOR.exec(transcript.join("\n"))?.[1];
    const connector = created.ok ? parseCreatedConnector(created.stdout) : undefined;
    if (connector !== undefined) return { kind: "created", connector };
    const message = created.ok
      ? `The ${options.service} connector does not support user authorization.`
      : `Could not create the ${options.service} connector.`;
    if (ownedId !== undefined) return cleanupThenThrow(options, ownedId, message);
    throw new Error(message);
  }
}

/** Attaches the canonical connector first, then offers explicit Find/Create fallbacks. */
export async function setupConnectionConnector(
  options: SetupConnectionConnectorOptions,
): Promise<SetupConnectionConnectorResult> {
  const onOutput = createPromptCommandOutput(options.log);
  const project = await ensureLinkedProject(options);

  if (await attach(options, options.canonicalConnectorUid, onOutput)) {
    options.log.success(`Attached ${options.canonicalConnectorUid} connector`);
    return { kind: "existing", connectorUid: options.canonicalConnectorUid };
  }
  options.signal?.throwIfAborted();

  const resolution = await resolveFallbackConnector(
    options,
    project,
    onOutput,
    `Could not attach ${options.canonicalConnectorUid}.`,
  );
  if (!(await attach(options, resolution.connector.uid, onOutput))) {
    if (resolution.kind === "created") {
      return cleanupThenThrow(
        options,
        resolution.connector.id,
        `Could not attach ${resolution.connector.uid} to the linked project.`,
      );
    }
    throw new Error(`Could not attach ${resolution.connector.uid} to the linked project.`);
  }
  options.log.success(`Attached ${resolution.connector.uid} connector`);
  return resolution.kind === "created"
    ? {
        kind: "created",
        connectorUid: resolution.connector.uid,
        connectorId: resolution.connector.id,
      }
    : { kind: "existing", connectorUid: resolution.connector.uid };
}
