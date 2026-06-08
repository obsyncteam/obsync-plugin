import { describe, expect, it } from "vitest";
import { validateVaultPath } from "./path-policy";

describe("validateVaultPath", () => {
  it("accepts regular vault paths and normalizes backslashes", () => {
    expect(validateVaultPath("notes/today.md")).toBe("notes/today.md");
    expect(validateVaultPath("notes\\today.md")).toBe("notes/today.md");
  });

  it("rejects absolute paths, Windows drive paths, and traversal", () => {
    expect(validateVaultPath("/notes/today.md")).toBeUndefined();
    expect(validateVaultPath("C:\\Users\\pavel\\vault\\note.md")).toBeUndefined();
    expect(validateVaultPath("../note.md")).toBeUndefined();
    expect(validateVaultPath("notes/../secret.md")).toBeUndefined();
    expect(validateVaultPath("notes/%2e%2e/secret.md")).toBeUndefined();
    expect(validateVaultPath("notes/%2Fsecret.md")).toBeUndefined();
    expect(validateVaultPath("notes/%5Csecret.md")).toBeUndefined();
  });

  it("rejects empty, dot, and control-character path segments", () => {
    expect(validateVaultPath("")).toBeUndefined();
    expect(validateVaultPath("notes//today.md")).toBeUndefined();
    expect(validateVaultPath("notes/./today.md")).toBeUndefined();
    expect(validateVaultPath("notes/\u0000today.md")).toBeUndefined();
  });

  it("blocks Obsidian internals by default", () => {
    expect(validateVaultPath(".obsidian/app.json")).toBeUndefined();
    expect(validateVaultPath(".obsidian/plugins/calendar/data.json")).toBeUndefined();
    expect(validateVaultPath(".obsidian/workspace.json")).toBeUndefined();
    expect(validateVaultPath(".obsidian/workspace-mobile.json")).toBeUndefined();
  });

  it("allows selected Obsidian config when policy explicitly permits it", () => {
    expect(validateVaultPath(".obsidian/app.json", { allowObsidianConfig: true })).toBe(
      ".obsidian/app.json",
    );
  });

  it("keeps the obsync plugin path blocked even with permissive policy", () => {
    expect(validateVaultPath(".obsidian/plugins/obsync", {
      allowObsidianConfig: true,
      allowObsidianPlugins: true,
    })).toBeUndefined();
    expect(validateVaultPath(".obsidian/plugins/obsync/data.json", {
      allowObsidianConfig: true,
      allowObsidianPlugins: true,
    })).toBeUndefined();
  });

  it("allows non-obsync plugin paths only when plugin policy permits them", () => {
    expect(validateVaultPath(".obsidian/plugins/calendar/data.json", {
      allowObsidianConfig: true,
    })).toBeUndefined();
    expect(validateVaultPath(".obsidian/plugins/calendar/data.json", {
      allowObsidianConfig: true,
      allowObsidianPlugins: true,
    })).toBe(".obsidian/plugins/calendar/data.json");
  });
});
