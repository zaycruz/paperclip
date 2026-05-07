import { describe, expect, it, vi } from "vitest";
import {
  bootstrapConfiguredLocalPlugins,
  parseBootstrapPluginPaths,
} from "../services/plugin-bootstrap.js";

function conflict(pluginKey: string) {
  const error = new Error(`Plugin already installed: ${pluginKey}`) as Error & { status: number };
  error.status = 409;
  return error;
}

describe("plugin bootstrap", () => {
  it("parses comma, newline, and JSON path lists with de-duping", () => {
    expect(parseBootstrapPluginPaths(" /opt/a, /opt/b\n/opt/a ")).toEqual([
      "/opt/a",
      "/opt/b",
    ]);
    expect(parseBootstrapPluginPaths(JSON.stringify(["/opt/a", "/opt/b", "/opt/a"]))).toEqual([
      "/opt/a",
      "/opt/b",
    ]);
    expect(parseBootstrapPluginPaths("")).toEqual([]);
  });

  it("installs a configured local plugin and loads its installed registry row", async () => {
    const loader = {
      installPlugin: vi.fn().mockResolvedValue({
        manifest: { id: "raava.monolith-fleet-connector" },
      }),
      hasRuntimeServices: vi.fn().mockReturnValue(true),
      loadSingle: vi.fn().mockResolvedValue({ success: true }),
    };
    const registry = {
      getByKey: vi.fn().mockResolvedValue({
        id: "plugin-row",
        pluginKey: "raava.monolith-fleet-connector",
        status: "installed",
        packagePath: "/opt/connector",
      }),
    };
    const lifecycle = {
      load: vi.fn().mockResolvedValue({}),
      enable: vi.fn().mockResolvedValue({}),
    };

    const result = await bootstrapConfiguredLocalPlugins({
      rawPaths: "/opt/connector",
      loader,
      registry,
      lifecycle,
    });

    expect(loader.installPlugin).toHaveBeenCalledWith({ localPath: "/opt/connector" });
    expect(registry.getByKey).toHaveBeenCalledWith("raava.monolith-fleet-connector");
    expect(lifecycle.load).toHaveBeenCalledWith("plugin-row");
    expect(loader.loadSingle).toHaveBeenCalledWith("plugin-row");
    expect(lifecycle.enable).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      attempted: 1,
      installed: 1,
      alreadyInstalled: 0,
      loaded: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it("keeps startup idempotent when the plugin is already ready", async () => {
    const loader = {
      installPlugin: vi.fn().mockRejectedValue(conflict("raava.monolith-fleet-connector")),
      hasRuntimeServices: vi.fn().mockReturnValue(true),
      loadSingle: vi.fn().mockResolvedValue({ success: true }),
    };
    const registry = {
      getByKey: vi.fn().mockResolvedValue({
        id: "plugin-row",
        pluginKey: "raava.monolith-fleet-connector",
        status: "ready",
      }),
    };
    const lifecycle = {
      load: vi.fn().mockResolvedValue({}),
      enable: vi.fn().mockResolvedValue({}),
    };

    const result = await bootstrapConfiguredLocalPlugins({
      rawPaths: "/opt/connector",
      loader,
      registry,
      lifecycle,
    });

    expect(lifecycle.load).not.toHaveBeenCalled();
    expect(lifecycle.enable).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      attempted: 1,
      installed: 0,
      alreadyInstalled: 1,
      loaded: 0,
      skipped: 1,
      failed: 0,
    });
  });

  it("loads an already installed plugin left before ready status", async () => {
    const loader = {
      installPlugin: vi.fn().mockRejectedValue(conflict("raava.monolith-fleet-connector")),
      hasRuntimeServices: vi.fn().mockReturnValue(true),
      loadSingle: vi.fn().mockResolvedValue({ success: true }),
    };
    const registry = {
      getByKey: vi.fn().mockResolvedValue({
        id: "plugin-row",
        pluginKey: "raava.monolith-fleet-connector",
        status: "installed",
      }),
    };
    const lifecycle = {
      load: vi.fn().mockResolvedValue({}),
      enable: vi.fn().mockResolvedValue({}),
    };

    const result = await bootstrapConfiguredLocalPlugins({
      rawPaths: "/opt/connector",
      loader,
      registry,
      lifecycle,
    });

    expect(lifecycle.load).toHaveBeenCalledWith("plugin-row");
    expect(loader.loadSingle).toHaveBeenCalledWith("plugin-row");
    expect(result).toMatchObject({
      attempted: 1,
      alreadyInstalled: 1,
      loaded: 1,
      failed: 0,
    });
  });

  it("does not override operator-disabled plugins", async () => {
    const loader = {
      installPlugin: vi.fn().mockRejectedValue(conflict("raava.monolith-fleet-connector")),
      hasRuntimeServices: vi.fn().mockReturnValue(true),
      loadSingle: vi.fn().mockResolvedValue({ success: true }),
    };
    const registry = {
      getByKey: vi.fn().mockResolvedValue({
        id: "plugin-row",
        pluginKey: "raava.monolith-fleet-connector",
        status: "disabled",
      }),
    };
    const lifecycle = {
      load: vi.fn().mockResolvedValue({}),
      enable: vi.fn().mockResolvedValue({}),
    };

    const result = await bootstrapConfiguredLocalPlugins({
      rawPaths: "/opt/connector",
      loader,
      registry,
      lifecycle,
    });

    expect(lifecycle.load).not.toHaveBeenCalled();
    expect(lifecycle.enable).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("records failures without aborting other configured plugins", async () => {
    const loader = {
      installPlugin: vi.fn()
        .mockRejectedValueOnce(new Error("missing package.json"))
        .mockResolvedValueOnce({ manifest: { id: "raava.monolith-fleet-connector" } }),
      hasRuntimeServices: vi.fn().mockReturnValue(true),
      loadSingle: vi.fn().mockResolvedValue({ success: true }),
    };
    const registry = {
      getByKey: vi.fn().mockResolvedValue({
        id: "plugin-row",
        pluginKey: "raava.monolith-fleet-connector",
        status: "installed",
      }),
    };
    const lifecycle = {
      load: vi.fn().mockResolvedValue({}),
      enable: vi.fn().mockResolvedValue({}),
    };

    const result = await bootstrapConfiguredLocalPlugins({
      rawPaths: "/bad,/opt/connector",
      loader,
      registry,
      lifecycle,
    });

    expect(lifecycle.load).toHaveBeenCalledWith("plugin-row");
    expect(loader.loadSingle).toHaveBeenCalledWith("plugin-row");
    expect(result).toMatchObject({
      attempted: 2,
      installed: 1,
      loaded: 1,
      failed: 1,
    });
    expect(result.failures).toEqual([{ path: "/bad", error: "missing package.json" }]);
  });
});
