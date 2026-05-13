import { describe, expect, it } from "vitest";
import { buildSshCommandManagedRuntimeRemoteCommand } from "./ssh.js";

describe("buildSshCommandManagedRuntimeRemoteCommand", () => {
  it("inlines sh scripts so exported environment is visible to the script", () => {
    expect(
      buildSshCommandManagedRuntimeRemoteCommand({
        command: "sh",
        args: ["-lc", "printf '%s' \"$PAPERCLIP_VALUE\""],
        cwd: "/srv/paperclip workspace",
        env: { PAPERCLIP_VALUE: "hello world" },
      }),
    ).toBe("cd '/srv/paperclip workspace' && export PAPERCLIP_VALUE='hello world'; printf '%s' \"$PAPERCLIP_VALUE\"");
  });

  it("preserves explicit bash invocations instead of flattening them into the ssh shell", () => {
    expect(
      buildSshCommandManagedRuntimeRemoteCommand({
        command: "bash",
        args: ["-lc", "printf '%s' \"$BASH_VERSION:$PAPERCLIP_VALUE\""],
        cwd: "/srv/paperclip",
        env: { PAPERCLIP_VALUE: "hello world" },
      }),
    ).toBe(
      "cd '/srv/paperclip' && env PAPERCLIP_VALUE='hello world' exec 'bash' '-lc' 'printf '\"'\"'%s'\"'\"' \"$BASH_VERSION:$PAPERCLIP_VALUE\"'",
    );
  });
});
