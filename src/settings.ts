import { App, PluginSettingTab, Setting } from "obsidian";
import type ObsyncPlugin from "./main";
import { createDeviceId } from "./util/device-id";
import { t } from "./i18n";

export type SetupMode = "primary" | "secondary";
export type SyncBackend = "standalone" | "hosted";

export interface PendingUploadState {
  uploadId: string;
  backend?: SyncBackend;
  tenantId?: string;
  transferToken?: string;
  vaultId: string;
  path: string;
  fileId: string;
  kind: string;
  sizeBytes: number;
  mtimeMs?: number;
  expectedHash?: string;
  expectedCurrentHash?: string;
  expectedCurrentSeq?: number;
  chunkSize: number;
  updatedAt: number;
}

export interface SkippedFileState {
  path: string;
  sizeBytes: number;
  reason: "large" | "attachments-disabled";
  skippedAt: number;
}

export interface StorageUsageState {
  vaultId: string;
  logicalBytes: number;
  physicalBytes: number;
  reservedBytes: number;
  quotaBytes?: number;
  refreshedAt: number;
}

export interface CompatibilityState {
  compatible: boolean;
  serverVersion?: string;
  protocolVersion?: number;
  minClientVersion?: string;
  latestClientVersion?: string;
  message?: string;
  checkedAt: number;
}

export interface PendingSeqUpdate {
  path: string;
  newPath?: string;
  kind: "upsert" | "rename" | "delete";
}

export interface ObsyncSettings {
  enabled: boolean;
  syncBackend: SyncBackend;
  serverUrl: string;
  authToken: string;
  hostedTenantId?: string;
  hostedVaultId?: string;
  hostedSyncBaseUrl?: string;
  userId: string;
  vaultName: string;
  vaultLocked: boolean;
  vaultId: string;
  deviceLabel: string;
  deviceId: string;
  deviceName: string;
  syncAttachments: boolean;
  syncObsidianConfig: boolean;
  maxAttachmentMB: number;
  ignoredPatterns: string[];
  lastCursor: number;
  fileIds: Record<string, string>;
  lastFileHashes: Record<string, string>;
  lastFileSeqs: Record<string, number>;
  pendingSeqUpdates: Record<string, PendingSeqUpdate>;
  pendingUploads: Record<string, PendingUploadState>;
  lastSkippedFiles: SkippedFileState[];
  lastStorageUsage?: StorageUsageState;
  lastCompatibility?: CompatibilityState;
  publishFolder: string;
  publishLinks: Record<string, string>;
}

export const DEFAULT_SETTINGS: ObsyncSettings = {
  enabled: true,
  syncBackend: "hosted",
  serverUrl: "https://obsync.ru",
  authToken: "",
  hostedTenantId: "",
  hostedVaultId: "",
  hostedSyncBaseUrl: "",
  userId: "",
  vaultName: "",
  vaultLocked: false,
  vaultId: "",
  deviceLabel: "pc",
  deviceId: "",
  deviceName: "",
  syncAttachments: true,
  syncObsidianConfig: false,
  maxAttachmentMB: 100,
  ignoredPatterns: [".obsidian/", ".trash/", ".DS_Store"],
  lastCursor: 0,
  fileIds: {},
  lastFileHashes: {},
  lastFileSeqs: {},
  pendingSeqUpdates: {},
  pendingUploads: {},
  lastSkippedFiles: [],
  publishFolder: "",
  publishLinks: {},
};

export async function normalizeSettings(settings: ObsyncSettings): Promise<ObsyncSettings> {
  const { publishMode: _legacyPublishMode, ...baseSettings } = settings as ObsyncSettings & {
    publishMode?: unknown;
  };
  return recomputeDerivedIds({
    ...baseSettings,
    enabled: true,
    syncBackend: settings.syncBackend === "hosted" ? "hosted" : "standalone",
    serverUrl: settings.serverUrl.replace(/\/+$/, ""),
    hostedTenantId: settings.hostedTenantId ?? "",
    hostedVaultId: settings.hostedVaultId ?? "",
    hostedSyncBaseUrl: settings.hostedSyncBaseUrl?.replace(/\/+$/, "") ?? "",
    fileIds: settings.fileIds ?? {},
    lastFileHashes: settings.lastFileHashes ?? {},
    lastFileSeqs: settings.lastFileSeqs ?? {},
    pendingSeqUpdates: settings.pendingSeqUpdates ?? {},
    pendingUploads: settings.pendingUploads ?? {},
    lastSkippedFiles: settings.lastSkippedFiles ?? [],
    syncObsidianConfig: false,
    publishFolder: normalizePublishFolder(settings.publishFolder ?? ""),
    publishLinks: settings.publishLinks ?? {},
  });
}

export function recomputeDerivedIds(settings: ObsyncSettings): ObsyncSettings {
  const syncBackend = settings.syncBackend === "hosted" ? "hosted" : "standalone";
  const keepStandaloneIdentity = syncBackend === "standalone" &&
    settings.vaultLocked &&
    Boolean(settings.vaultId) &&
    Boolean(settings.userId) &&
    Boolean(settings.deviceId);
  const userId = keepStandaloneIdentity
    ? settings.userId
    : deriveUserId(settings.authToken) || settings.userId || fallbackUserId();
  const deviceLabel = settings.deviceLabel || settings.deviceName || "device";
  const deviceId = keepStandaloneIdentity
    ? settings.deviceId
    : buildScopedId(userId, deviceLabel) || settings.deviceId || createDeviceId();
  const inferredVaultName = settings.vaultName || inferVaultName(settings.vaultId, userId);
  const hostedVaultId = settings.hostedVaultId ?? "";
  const vaultId = syncBackend === "hosted" && hostedVaultId
    ? hostedVaultId
    : settings.vaultLocked && settings.vaultId
      ? settings.vaultId
      : buildVaultId(userId, inferredVaultName);

  return {
    ...settings,
    syncBackend,
    userId,
    deviceLabel,
    deviceId,
    deviceName: deviceLabel,
    vaultName: inferredVaultName,
    vaultId,
  };
}

export function buildVaultId(userId: string, vaultName: string): string {
  return buildScopedId(userId, vaultName);
}

export function buildDeviceId(userId: string, deviceLabel: string): string {
  return buildScopedId(userId, deviceLabel);
}

function buildScopedId(userId: string, name: string): string {
  const user = slugify(userId);
  const suffix = slugify(name);
  if (!user || !suffix) return "";
  return `${user}-${suffix}`;
}

function inferVaultName(vaultId: string, userId: string): string {
  const normalizedVaultId = slugify(vaultId);
  const normalizedUserId = slugify(userId);
  if (!normalizedVaultId) return "";
  const prefix = `${normalizedUserId}-`;
  if (normalizedUserId && normalizedVaultId.startsWith(prefix)) {
    return normalizedVaultId.slice(prefix.length);
  }
  return normalizedVaultId;
}

function deriveUserId(authToken: string): string {
  if (!authToken.trim()) return "";

  let hash = 2166136261;
  for (const char of authToken.trim()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return `u${(hash >>> 0).toString(36)}`;
}

function fallbackUserId(): string {
  return `u${createDeviceId().replace(/^device-/, "").slice(0, 10)}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizePublishFolder(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/g, "");
}

export class ObsyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsyncPlugin) {
    super(app, plugin);
  }

  private createSettingsSection(containerEl: HTMLElement, title: string): HTMLElement {
    const sectionEl = containerEl.createDiv({ cls: "obsync-settings-section" });
    sectionEl.createEl("h2", { text: title });
    return sectionEl;
  }

  private ensureVaultNameFromObsidian(): void {
    const vaultNameGetter = this.app.vault as { getName?: () => string };
    const vaultName = vaultNameGetter.getName?.().trim();
    if (!vaultName) return;
    if (this.plugin.settings.vaultName === vaultName) return;

    this.plugin.settings.vaultName = vaultName;
    this.plugin.settings = recomputeDerivedIds(this.plugin.settings);
    void this.plugin.saveSettings();
  }

  private addIntro(containerEl: HTMLElement): void {
    const intro = containerEl.createDiv({ cls: "obsync-settings-intro" });
    intro.createEl("p", { text: t("settings_intro") });
  }

  display(): void {
    const { containerEl } = this;
    this.ensureVaultNameFromObsidian();
    containerEl.empty();
    this.addIntro(containerEl);

    const setupSection = this.createSettingsSection(
      containerEl,
      t("settings_section_connection"),
    );
    const connectionSection = this.createSettingsSection(
      containerEl,
      t("settings_section_sync"),
    );

    new Setting(setupSection)
      .setName(t("settings_device_name"))
      .addText((text) => {
        text
          .setPlaceholder(t("settings_device_name_placeholder"))
          .setValue(this.plugin.settings.deviceLabel)
          .onChange(async (value) => {
            this.plugin.settings.deviceLabel = value.trim();
            await this.plugin.refreshDerivedSettings();
          });
      });

    new Setting(setupSection)
      .setName(t("settings_connection_mode"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("hosted", t("settings_backend_hosted"))
          .addOption("standalone", t("settings_backend_standalone"))
          .setValue(this.plugin.settings.syncBackend)
          .onChange(async (value) => {
            this.plugin.settings.syncBackend = value === "hosted" ? "hosted" : "standalone";
            await this.plugin.refreshDerivedSettings();
            this.display();
          });
      });

    new Setting(setupSection)
      .setName(t("settings_server_url"))
      .addText((text) => {
        text
          .setPlaceholder(
            this.plugin.settings.syncBackend === "hosted"
              ? t("settings_server_url_placeholder_hosted")
              : t("settings_server_url_placeholder_standalone"),
          )
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim().replace(/\/+$/, "");
            await this.plugin.saveSettings();
          });
      });

    new Setting(setupSection)
      .setName(t("settings_access_token"))
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder(t("settings_access_token_placeholder"))
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = value.trim();
            await this.plugin.refreshDerivedSettings();
          });
      });

    new Setting(setupSection)
      .setName(t("settings_vault_name"))
      .addText((text) => {
        text
          .setPlaceholder(
            (this.app.vault as { getName?: () => string }).getName?.() ??
            t("settings_vault_name_placeholder"),
          )
          .setValue(this.plugin.settings.vaultName)
          .setDisabled(true);
      });

    new Setting(connectionSection)
      .setName(t("settings_sync_button"))
      .addButton((button) => {
        button
          .setButtonText(t("settings_sync_button"))
          .setCta()
          .onClick(async () => {
            await this.plugin.syncNow();
            this.display();
          });
      });

    const progressSetting = new Setting(connectionSection)
      .setName(t("settings_progress"))
      .setDesc(this.plugin.progressText || t("status_waiting"));
    this.plugin.progressStatusEl = progressSetting.descEl;
    this.plugin.progressStatusEl.addClass("obsync-progress-description");

    new Setting(connectionSection)
      .setName(t("settings_skipped_files"))
      .setDesc(this.plugin.skippedFilesText)
      .addButton((button) => {
        button
          .setButtonText(t("settings_clear"))
          .setDisabled(this.plugin.settings.lastSkippedFiles.length === 0)
          .onClick(async () => {
            await this.plugin.clearSkippedFiles();
            this.display();
          });
      });

    new Setting(connectionSection)
      .setName(t("settings_device_identity"))
      .setDesc([
        t("settings_identity_line_device", {
          value: this.plugin.settings.deviceId || t("settings_identity_value_unknown"),
        }),
        t("settings_identity_line_vault_id", {
          value: this.plugin.settings.vaultId || t("settings_identity_value_unknown"),
        }),
        t("settings_identity_line_vault_name", {
          value: this.plugin.settings.vaultName || t("settings_identity_value_unknown"),
        }),
      ].join("\n"));

    new Setting(connectionSection)
      .setName(t("settings_sync_attachments"))
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncAttachments);
        toggle.onChange(async (value) => {
          this.plugin.settings.syncAttachments = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(connectionSection)
      .setName(t("settings_storage"))
      .setDesc(this.plugin.storageUsageText)
      .addButton((button) => {
        button
          .setButtonText(t("settings_storage_refresh"))
          .onClick(async () => {
            await this.plugin.refreshStorageUsage();
            this.display();
          });
      });

    new Setting(connectionSection)
      .setName(t("settings_max_file_size"))
      .addText((text) => {
        text
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.maxAttachmentMB))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed > 0) {
              this.plugin.settings.maxAttachmentMB = parsed;
              await this.plugin.saveSettings();
            }
          });
      });
  }
}
