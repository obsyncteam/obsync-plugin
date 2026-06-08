import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  PluginSettingTab: class {},
  Setting: class {
    setName() { return this; }
    setDesc() { return this; }
    addText() { return this; }
    addDropdown() { return this; }
    addToggle() { return this; }
    addButton() { return this; }
  },
}));

vi.mock("./main", () => ({
  default: class {},
}));

import { recomputeDerivedIds, DEFAULT_SETTINGS } from "./settings";

describe("recomputeDerivedIds", () => {
  it("preserves standalone identity when vault is locked", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      syncBackend: "standalone" as const,
      authToken: "old-token",
      vaultLocked: true,
      vaultId: "vault-abc",
      userId: "user-xyz",
      deviceId: "device-123",
      deviceLabel: "pc",
      vaultName: "test-vault",
    };

    const changed = recomputeDerivedIds({
      ...settings,
      authToken: "new-token",
    });

    expect(changed.userId).toBe("user-xyz");
    expect(changed.vaultId).toBe("vault-abc");
    expect(changed.deviceId).toBe("device-123");
  });

  it("recalculates identity for unlocked standalone vault", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      syncBackend: "standalone" as const,
      authToken: "old-token",
      vaultLocked: false,
      vaultId: "vault-abc",
      userId: "user-xyz",
      deviceId: "device-123",
      deviceLabel: "pc",
      vaultName: "test-vault",
    };

    const changed = recomputeDerivedIds({
      ...settings,
      authToken: "new-token",
    });

    expect(changed.userId).not.toBe("user-xyz");
    expect(changed.vaultId).not.toBe("vault-abc");
  });

  it("recalculates identity for hosted backend even when vaultLocked is true", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      syncBackend: "hosted" as const,
      authToken: "old-token",
      vaultLocked: true,
      hostedVaultId: "hosted-vault-123",
      userId: "user-xyz",
      deviceId: "device-123",
      deviceLabel: "pc",
      vaultName: "test-vault",
    };

    const changed = recomputeDerivedIds({
      ...settings,
      authToken: "new-token",
    });

    expect(changed.vaultId).toBe("hosted-vault-123");
    expect(changed.userId).not.toBe("user-xyz");
  });
});
