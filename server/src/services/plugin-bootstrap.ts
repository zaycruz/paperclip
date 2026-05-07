import type { PluginStatus } from "@paperclipai/shared";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";
import type { PluginLoader } from "./plugin-loader.js";
import type { pluginRegistryService } from "./plugin-registry.js";

type PluginRegistry = Pick<ReturnType<typeof pluginRegistryService>, "getByKey">;
type BootstrapPlugin = {
  id: string;
  pluginKey: string;
  status: PluginStatus;
  packagePath?: string | null;
};

type BootstrapLogger = {
  info?: (metadata: Record<string, unknown>, message: string) => void;
  warn?: (metadata: Record<string, unknown>, message: string) => void;
  error?: (metadata: Record<string, unknown>, message: string) => void;
};

export interface PluginBootstrapFailure {
  path: string;
  error: string;
}

export interface PluginBootstrapResult {
  paths: string[];
  attempted: number;
  installed: number;
  alreadyInstalled: number;
  loaded: number;
  skipped: number;
  failed: number;
  failures: PluginBootstrapFailure[];
}

export interface BootstrapConfiguredLocalPluginsInput {
  rawPaths?: string | null;
  loader: Pick<PluginLoader, "installPlugin" | "loadSingle" | "hasRuntimeServices">;
  registry: PluginRegistry;
  lifecycle: Pick<PluginLifecycleManager, "load" | "enable">;
  logger?: BootstrapLogger;
}

const ALREADY_INSTALLED_PREFIX = "Plugin already installed: ";

export function parseBootstrapPluginPaths(rawPaths?: string | null): string[] {
  const raw = rawPaths?.trim();
  if (!raw) return [];

  const parsed = parseJsonPathList(raw);
  const candidates = parsed ?? raw.split(/[,\n]/g);
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const candidate of candidates) {
    const path = candidate.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }

  return paths;
}

export async function bootstrapConfiguredLocalPlugins(
  input: BootstrapConfiguredLocalPluginsInput,
): Promise<PluginBootstrapResult> {
  const paths = parseBootstrapPluginPaths(input.rawPaths);
  const result: PluginBootstrapResult = {
    paths,
    attempted: paths.length,
    installed: 0,
    alreadyInstalled: 0,
    loaded: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };

  if (paths.length === 0) return result;

  input.logger?.info?.(
    { paths },
    "plugin-bootstrap: installing configured local plugins",
  );

  for (const localPath of paths) {
    try {
      const pluginKey = await installOrResolvePluginKey(input, localPath, result);
      if (!pluginKey) continue;

      const plugin = await input.registry.getByKey(pluginKey) as BootstrapPlugin | null;
      if (!plugin) {
        recordFailure(input, result, localPath, `Plugin install did not create registry row: ${pluginKey}`);
        continue;
      }

      const loaded = await loadBootstrapPlugin(input, plugin, localPath);
      if (loaded) {
        result.loaded += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      recordFailure(input, result, localPath, stringifyError(error));
    }
  }

  input.logger?.info?.(
    {
      attempted: result.attempted,
      installed: result.installed,
      alreadyInstalled: result.alreadyInstalled,
      loaded: result.loaded,
      skipped: result.skipped,
      failed: result.failed,
    },
    "plugin-bootstrap: configured local plugin bootstrap complete",
  );

  return result;
}

function parseJsonPathList(raw: string): string[] | null {
  if (!raw.startsWith("[")) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return null;
  }
}

async function installOrResolvePluginKey(
  input: BootstrapConfiguredLocalPluginsInput,
  localPath: string,
  result: PluginBootstrapResult,
): Promise<string | null> {
  try {
    const discovered = await input.loader.installPlugin({ localPath });
    const pluginKey = discovered.manifest?.id;
    if (!pluginKey) {
      recordFailure(input, result, localPath, "Plugin manifest did not include an id");
      return null;
    }
    result.installed += 1;
    return pluginKey;
  } catch (error) {
    const existingKey = getAlreadyInstalledPluginKey(error);
    if (!existingKey) throw error;
    result.alreadyInstalled += 1;
    return existingKey;
  }
}

async function loadBootstrapPlugin(
  input: BootstrapConfiguredLocalPluginsInput,
  plugin: BootstrapPlugin,
  localPath: string,
): Promise<boolean> {
  if (plugin.status === "installed") {
    await input.lifecycle.load(plugin.id);
    await activatePluginRuntime(input, plugin);
    input.logger?.info?.(
      { pluginId: plugin.id, pluginKey: plugin.pluginKey, path: localPath },
      "plugin-bootstrap: loaded installed plugin",
    );
    return true;
  }

  if (plugin.status === "error") {
    await input.lifecycle.enable(plugin.id);
    await activatePluginRuntime(input, plugin);
    input.logger?.info?.(
      { pluginId: plugin.id, pluginKey: plugin.pluginKey, path: localPath },
      "plugin-bootstrap: retried errored plugin",
    );
    return true;
  }

  input.logger?.info?.(
    { pluginId: plugin.id, pluginKey: plugin.pluginKey, path: localPath, status: plugin.status },
    "plugin-bootstrap: plugin already has non-bootstrap status",
  );
  return false;
}

async function activatePluginRuntime(
  input: BootstrapConfiguredLocalPluginsInput,
  plugin: BootstrapPlugin,
): Promise<void> {
  if (!input.loader.hasRuntimeServices()) return;
  const loadResult = await input.loader.loadSingle(plugin.id);
  if (!loadResult.success) {
    throw new Error(
      loadResult.error
      ?? `Failed to activate plugin ${plugin.pluginKey}`,
    );
  }
}

function getAlreadyInstalledPluginKey(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const status = "status" in error ? (error as { status?: unknown }).status : undefined;
  if (status !== 409) return null;

  const message = stringifyError(error);
  if (!message.startsWith(ALREADY_INSTALLED_PREFIX)) return null;
  const pluginKey = message.slice(ALREADY_INSTALLED_PREFIX.length).trim();
  return pluginKey || null;
}

function recordFailure(
  input: BootstrapConfiguredLocalPluginsInput,
  result: PluginBootstrapResult,
  path: string,
  error: string,
): void {
  result.failed += 1;
  result.failures.push({ path, error });
  input.logger?.error?.(
    { path, error },
    "plugin-bootstrap: failed to bootstrap configured local plugin",
  );
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
