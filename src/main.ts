import { Modal, Notice, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import {
  DEFAULT_SETTINGS,
  mergeSettingsWithDefaults,
  normalizeSettings,
  ObsyncSettingTab,
  recomputeDerivedIds,
  shouldSyncBlobFiles,
  type PendingUploadState,
  type SkippedFileState,
  type StorageUsageState,
  type ObsyncSettings,
} from "./settings";
import { MESSAGES, t, type I18nKey } from "./i18n";
import {
  OBSYNC_MIN_SERVER_PROTOCOL_VERSION,
  OBSYNC_PLUGIN_VERSION,
} from "./protocol";
import { SyncClient } from "./sync/client";
import { EchoSuppression } from "./sync/echo-suppression";
import { VaultEventBridge } from "./sync/fs-events";
import {
  SyncHttpApi,
  type ClientSyncEventInput,
  type CreateShareResponse,
  type HistoryEntry,
  type ManifestFile,
  type PublishedShare,
  type StorageUsage,
  type SyncTransferProgress,
  type TombstoneRecord,
  type UploadedFile,
} from "./sync/http-api";
import { isHostedSync } from "./sync/hosted-auth";
import { validateVaultPath } from "./sync/path-policy";
import type { ServerOperation, SyncClientEvent } from "./sync/types";
import { createRandomId } from "./util/device-id";
import { sha256Hex } from "./util/hash";

const HOSTED_UPLOAD_WINDOW_SIZE = 32;
const STARTUP_SAFE_MODE_FAILURES = 3;
const MAX_VAULT_PATH_SEGMENT_BYTES = 255;
const TEXT_ENCODER = new TextEncoder();

type WriteResult = "created" | "updated" | "conflict" | "skipped";

interface ManualSyncContext {
  api: SyncHttpApi;
  bridge: VaultEventBridge;
}

interface UploadStats {
  uploaded: number;
  skipped: number;
  skippedFiles: SkippedFileState[];
}

interface UploadPreconditions {
  expectedCurrentHash?: string;
  expectedCurrentSeq?: number;
}

interface UploadOptions {
  preconditionsByPath?: Map<string, UploadPreconditions>;
}

interface ManualUploadProgress {
  label: string;
  startedAt: number;
  totalFiles: number;
  totalBytes: number;
  processedFiles: number;
  processedBytes: number;
  preparingFrom?: number;
  preparingTo?: number;
  activeFiles: Record<string, {
    fileIndex: number;
    phase: SyncTransferProgress["phase"];
    transferredBytes: number;
    totalBytes: number;
  }>;
}

interface DownloadStats {
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
}

export default class ObsyncPlugin extends Plugin {
  settings: ObsyncSettings = DEFAULT_SETTINGS;
  statusText = t("status_not_started");
  progressText = t("status_waiting");
  progressStatusEl?: HTMLElement;

  private syncClient?: SyncClient;
  private httpApi?: SyncHttpApi;
  private bridge?: VaultEventBridge;
  private readonly echoSuppression = new EchoSuppression(3000);
  private syncJobRunning = false;
  private publicationJobRunning = false;
  private readonly postSyncQueue: Array<{ label: string; run: () => Promise<void> }> = [];
  private activeManualUploadProgress?: ManualUploadProgress;
  private activeDownloadSkippedFiles: SkippedFileState[] = [];
  private shareIndicatorObserver?: MutationObserver;
  private shareIndicatorRefreshTimer?: number;
  private shareCatalogLastLoadedAt = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new ObsyncSettingTab(this.app, this));

    this.addCommand({
      id: "obsync-show-status",
      name: t("cmd_show_status"),
      callback: () => {
        this.notice(this.statusText);
      },
    });

    this.addCommand({
      id: "obsync-show-note-history",
      name: t("cmd_open_note_history"),
      callback: () => {
        void this.showCurrentNoteHistory();
      },
    });

    this.addCommand({
      id: "obsync-publish-current-note",
      name: t("cmd_share_current_note"),
      callback: () => {
        void this.shareCurrentNote();
      },
    });

    this.addCommand({
      id: "obsync-publish-site",
      name: t("cmd_publish_site"),
      callback: () => {
        void this.publishSite();
      },
    });

    this.registerFileMenu();
    this.registerShareIndicators();
    this.registerVaultEvents();

    if (this.settings.safeMode) {
      const message = this.settings.lastStartupFailure || t("status_waiting");
      this.statusText = t("status_safe_mode", { message });
      this.setProgress(this.statusText);
    } else if (this.settings.enabled) {
      const startupTimer = window.setTimeout(() => {
        void this.startSync().catch((error) => {
          void this.handleStartupSyncError(error).catch((handlerError) => {
            console.warn("[obsync] startup error handler failed", handlerError);
          });
        });
      }, 500);
      this.register(() => window.clearTimeout(startupTimer));
    }
  }

  onunload(): void {
    this.syncClient?.disconnect();
    this.bridge?.dispose();
    this.shareIndicatorObserver?.disconnect();
    if (this.shareIndicatorRefreshTimer) {
      window.clearTimeout(this.shareIndicatorRefreshTimer);
    }
    this.echoSuppression.clear();
  }

  async loadSettings(): Promise<void> {
    const loaded = mergeSettingsWithDefaults(await this.loadData());
    const normalized = await normalizeSettings(loaded);
    const shouldSave = normalizedSettingsChanged(loaded, normalized);
    this.settings = normalized;
    if (shouldSave) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settingsForDisk());
  }

  async refreshDerivedSettings(): Promise<void> {
    this.settings = recomputeDerivedIds(this.settings);
    await this.saveSettings();
  }

  get storageUsageText(): string {
    if (!this.settings.lastStorageUsage) {
      return t("storage_usage_not_loaded", { refreshLabel: t("settings_storage_refresh") });
    }

    return this.formatStorageUsage(this.settings.lastStorageUsage);
  }

  get compatibilityText(): string {
    const state = this.settings.lastCompatibility;
    if (!state) {
      return t("compatibility_not_checked", { version: OBSYNC_PLUGIN_VERSION });
    }

    const status = state.compatible
      ? t("compatibility_status_compatible")
      : t("compatibility_status_incompatible");
    const server = state.serverVersion
      ? t("compatibility_server_label", { value: state.serverVersion })
      : t("compatibility_server_unknown");
    const protocol = state.protocolVersion !== undefined
      ? t("compatibility_protocol_label", { value: state.protocolVersion })
      : t("compatibility_protocol_unknown");
    const latest = state.latestClientVersion
      ? t("compatibility_latest_label", { value: state.latestClientVersion })
      : t("compatibility_latest_unknown");
    const message = state.message ? ` ${state.message}` : "";

    return t("compatibility_text", {
      version: OBSYNC_PLUGIN_VERSION,
      status,
      server,
      protocol,
      latest,
      message: message ? `.${message}` : "",
    });
  }

  get skippedFilesText(): string {
    const skipped = this.settings.lastSkippedFiles;
    if (!skipped.length) return t("skipped_files_none");

    const shown = skipped
      .slice(0, 5)
      .map((file) => `${file.path} (${this.formatBytes(file.sizeBytes)})`)
      .join(", ");
    const more = skipped.length > 5 ? t("skipped_files_more", { count: skipped.length - 5 }) : "";
    return t("skipped_files_summary", {
      count: skipped.length,
      files: shown,
      more,
    });
  }

  canInstallVault(): boolean {
    const hasVaultIdentity = this.settings.syncBackend === "hosted"
      ? Boolean(this.settings.authToken.trim()) && Boolean(this.settings.deviceLabel.trim())
      : Boolean(this.settings.vaultName.trim()) && Boolean(this.settings.vaultId);

    return (
      !this.settings.vaultLocked &&
      Boolean(this.settings.authToken.trim()) &&
      hasVaultIdentity &&
      Boolean(this.settings.deviceLabel.trim())
    );
  }

  async restartSync(): Promise<void> {
    this.syncClient?.disconnect();
    this.settings.safeMode = false;
    this.settings.consecutiveStartupFailures = 0;
    this.settings.lastStartupFailure = undefined;
    this.settings.lastStartupFailureAt = undefined;
    await this.saveSettings();
    await this.startSync();
  }

  async resumeBackgroundSync(): Promise<void> {
    this.settings.enabled = true;
    await this.restartSync();
  }

  async installVault(): Promise<void> {
    if (this.syncJobRunning || this.publicationJobRunning) {
      this.notice("notice_sync_already_running");
      return;
    }

    await this.ensureManualSyncReady();
    if (!this.canInstallVault()) {
      this.notice("notice_install_vault_name_required");
      return;
    }

    const { api, bridge } = this.manualSyncContext();

    this.syncJobRunning = true;
    try {
      await api.ensureVault();
      const manifest = await api.manifest();
      const serverFiles = this.activeServerFiles(manifest, bridge);

      if (serverFiles.length > 0) {
        this.setProgress(
          t("progress_init_server_copy_exists", {
            count: serverFiles.length,
            syncLabel: t("settings_sync_button"),
          }),
        );
        this.notice(
          "notice_server_copy_exists",
          { syncLabel: t("settings_sync_button") },
          12000,
        );
        return;
      }

      const files = this.syncableLocalFiles(bridge);
      if (files.length === 0) {
        this.setProgress(t("progress_init_no_local_files"));
        this.notice("notice_no_files_to_sync");
        return;
      }

      const stats = await this.uploadFiles(api, files);
      this.settings.vaultLocked = true;
      this.repairCursorFromKnownFileSeqs();
      await this.saveSettings();
      this.setProgress(
        t("progress_sync_completed", {
          uploaded: stats.uploaded,
          created: 0,
          updated: 0,
          skipped: stats.skipped,
          suffix: this.skippedSuffix(stats),
        }),
      );
      this.notice("notice_sync_completed_uploaded", { count: stats.uploaded }, 8000);
    } catch (error) {
      const message = this.errorMessage(error);
      this.setProgress(t("progress_error", { message }));
      this.notice("notice_sync_error", { message });
      console.error("[obsync] install failed", error);
    } finally {
      this.syncJobRunning = false;
      void this.drainPostSyncQueue();
    }
  }

  async syncNow(): Promise<void> {
    if (this.syncJobRunning || this.publicationJobRunning) {
      this.notice("notice_sync_already_running");
      return;
    }

    await this.ensureManualSyncReady();
    const { api, bridge } = this.manualSyncContext();
    const syncSessionId = `sync_${createRandomId(12)}`;
    const syncStartedAt = Date.now();

    this.syncJobRunning = true;
    this.activeDownloadSkippedFiles = [];
    try {
      this.reportClientSyncEvent(api, {
        eventType: "sync_started",
        severity: "info",
        syncSessionId,
        phase: "manual_sync",
      });
      await api.ensureVault();
      const hostedStatus = isHostedSync(this.settings)
        ? await api.vaultSyncStatus()
        : undefined;
      const manifest = await api.manifest();
      const serverFiles = this.downloadableServerFiles(manifest, bridge);
      const serverByPath = new Map(serverFiles.map((file) => [file.path, file]));
      const localFiles = this.syncableLocalFiles(bridge);
      const localByPath = new Map(localFiles.map((file) => [file.path, file]));
      const syncFilePaths = new Set([
        ...serverByPath.keys(),
        ...localByPath.keys(),
      ]);
      const totalSyncBytes = Array.from(syncFilePaths).reduce((sum, path) => {
        const localBytes = localByPath.get(path)?.stat.size ?? 0;
        const serverBytes = serverByPath.get(path)?.sizeBytes ?? 0;
        return sum + Math.max(localBytes, serverBytes);
      }, 0);
      if (
        hostedStatus &&
        hostedStatus.status !== "ready" &&
        hostedStatus.activeDeviceId &&
        hostedStatus.activeDeviceId !== this.settings.deviceId
      ) {
        const filesText = hostedStatus.activeFilesCount > 0
          ? t("progress_hosted_files_upload_count", { count: hostedStatus.activeFilesCount })
          : t("progress_hosted_copy_empty");
        this.setProgress(
          t("progress_hosted_wait", { filesText }),
        );
        this.notice("notice_hosted_wait", undefined, 12000);
        this.reportClientSyncEvent(api, {
          eventType: "sync_failed",
          severity: "warning",
          syncSessionId,
          phase: "manual_sync",
          durationMs: Date.now() - syncStartedAt,
          errorCode: "sync_error",
          errorMessage: "sync_error",
          filesTotal: syncFilePaths.size,
          filesDone: 0,
          bytesTotal: totalSyncBytes,
          bytesDone: 0,
        });
        return;
      }
      const downloadStats: DownloadStats = {
        created: 0,
        updated: 0,
        skipped: 0,
        conflicts: 0,
      };
      const uploadQueue = new Map<string, TFile>();
      const uploadPreconditionsByPath = new Map<string, UploadPreconditions>();
      const preUploadSkippedFiles: SkippedFileState[] = [];
      const totalServerBytes = serverFiles.reduce(
        (sum, file) => sum + (file.sizeBytes ?? 0),
        0,
      );
      const manifestByPath = new Map(
        manifest
          .filter((file) => file.kind !== "folder")
          .map((file) => [file.path, file]),
      );
      const localFilesMissingOnServer = localFiles.filter((file) => !serverByPath.has(file.path));
      const tombstones = localFilesMissingOnServer.length > 0
        ? await api.tombstones()
        : [];
      const deleteContextUnavailable = localFilesMissingOnServer.length > 0 && tombstones === undefined;
      const tombstoneRecords = tombstones ?? [];
      const tombstonesByPath = new Map(tombstoneRecords.map((tombstone) => [tombstone.path, tombstone]));
      const tombstonesByFileId = new Map(tombstoneRecords.map((tombstone) => [tombstone.fileId, tombstone]));
      let processedServerBytes = 0;

      for (let index = 0; index < serverFiles.length; index += 1) {
        const serverFile = serverFiles[index];
        processedServerBytes += serverFile.sizeBytes ?? 0;
        const totalFiles = serverFiles.length || 1;
        this.setProgress(
          [
            t("progress_check_server_files", {
              current: index + 1,
              total: totalFiles,
            }),
            `${this.formatBytes(processedServerBytes)}/${this.formatBytes(totalServerBytes)}`,
          ].join("\n"),
        );

        const localFile = localByPath.get(serverFile.path);
        if (!localFile) {
          this.applyWriteResult(
            downloadStats,
            await this.downloadServerFile(api, bridge, serverFile, false),
          );
          continue;
        }

        if (!serverFile.hash) {
          downloadStats.skipped += 1;
          continue;
        }

        const localHash = await this.localFileHash(localFile);
        if (localHash === serverFile.hash) {
          this.trackServerFile(serverFile);
          downloadStats.skipped += 1;
          continue;
        }

        const lastHash = this.settings.lastFileHashes[serverFile.path];
        if (lastHash && lastHash === localHash) {
          this.applyWriteResult(
            downloadStats,
            await this.downloadServerFile(api, bridge, serverFile, true),
          );
          continue;
        }

        if (lastHash && lastHash === serverFile.hash) {
          uploadQueue.set(localFile.path, localFile);
          continue;
        }

        if (!lastHash && (localFile.stat.mtime >= (serverFile.mtimeMs ?? 0))) {
          uploadQueue.set(localFile.path, localFile);
          continue;
        }

        this.applyWriteResult(
          downloadStats,
          await this.downloadServerFile(api, bridge, serverFile, false),
        );
      }

      for (const localFile of localFiles) {
        if (!serverByPath.has(localFile.path)) {
          if (deleteContextUnavailable) {
            preUploadSkippedFiles.push(this.skippedFile(localFile, "delete-context-unavailable"));
            continue;
          }

          const manifestFile = manifestByPath.get(localFile.path);
          if (manifestFile?.deletedAt) {
            if (this.settings.deletedServerFilePolicy === "server_wins") {
              preUploadSkippedFiles.push(this.skippedFile(localFile, "server-deleted"));
              continue;
            }
            if (this.settings.deletedServerFilePolicy === "conflict_copy") {
              const conflictFile = await this.renameToConflictCopy(localFile);
              uploadQueue.set(conflictFile.path, conflictFile);
              uploadPreconditionsByPath.set(conflictFile.path, {});
              continue;
            }
          }

          const tombstone = this.tombstoneForLocalFile(
            localFile,
            tombstonesByPath,
            tombstonesByFileId,
          );
          if (
            tombstone &&
            await this.handleServerDeletedLocalFile(
              localFile,
              tombstone,
              uploadQueue,
              uploadPreconditionsByPath,
              preUploadSkippedFiles,
            )
          ) {
            continue;
          }

          uploadQueue.set(localFile.path, localFile);
          uploadPreconditionsByPath.set(localFile.path, {});
        }
      }

      const initialHostedUpload = Boolean(
        hostedStatus &&
        hostedStatus.status !== "ready" &&
        (!hostedStatus.activeDeviceId || hostedStatus.activeDeviceId === this.settings.deviceId) &&
        localFiles.length > 0,
      );
      if (initialHostedUpload) {
        await api.beginInitialSync({
          totalFiles: localFiles.length,
          totalBytes: localFiles.reduce((sum, file) => sum + file.stat.size, 0),
        });
      }

      const uploadStats = await this.uploadFiles(
        api,
        [...uploadQueue.values()],
        { preconditionsByPath: uploadPreconditionsByPath },
      );
      if (preUploadSkippedFiles.length > 0 || this.activeDownloadSkippedFiles.length > 0) {
        uploadStats.skipped += preUploadSkippedFiles.length;
        uploadStats.skippedFiles = [
          ...this.activeDownloadSkippedFiles,
          ...preUploadSkippedFiles,
          ...uploadStats.skippedFiles,
        ];
        this.settings.lastSkippedFiles = this.mergeSkippedFiles(uploadStats.skippedFiles);
      }

      if (initialHostedUpload) {
        const readyStatus = await api.completeInitialSync();
        if (readyStatus.status === "ready") {
          this.settings.vaultLocked = true;
        }
      } else if (
        serverFiles.length === 0 &&
        uploadStats.uploaded > 0
      ) {
        this.settings.vaultLocked = true;
      }
      this.repairCursorFromKnownFileSeqs();
      await this.saveSettings();
      this.setProgress(
        t("progress_sync_completed", {
          uploaded: uploadStats.uploaded,
          created: downloadStats.created,
          updated: downloadStats.updated,
          skipped: uploadStats.skipped + downloadStats.skipped,
          suffix: this.skippedSuffix(uploadStats),
        }),
      );
      this.reportClientSyncEvent(api, {
        eventType: "sync_completed",
        severity: "info",
        syncSessionId,
        phase: "manual_sync",
        durationMs: Date.now() - syncStartedAt,
        filesTotal: syncFilePaths.size,
        filesDone: syncFilePaths.size,
        bytesTotal: totalSyncBytes,
        bytesDone: totalSyncBytes,
      });
      this.notice("notice_sync_completed");
    } catch (error) {
      const message = this.errorMessage(error);
      this.setProgress(t("progress_error", { message }));
      this.notice("notice_sync_error", { message });
      this.reportClientSyncEvent(api, {
        eventType: "sync_failed",
        severity: "error",
        syncSessionId,
        phase: "manual_sync",
        durationMs: Date.now() - syncStartedAt,
        errorCode: this.syncErrorCode(error),
        errorMessage: this.safeSyncTelemetryMessage(error),
      });
      console.error("[obsync] sync failed", error);
    } finally {
      this.syncJobRunning = false;
      void this.drainPostSyncQueue();
    }
  }

  private manualSyncContext(): ManualSyncContext {
    const api = this.httpApi ?? new SyncHttpApi(
      () => this.settings,
      () => this.saveSettings(),
      (progress) => this.handleTransferProgress(progress),
    );
    const bridge = this.bridge ?? new VaultEventBridge(
      this.app.vault,
      () => this.settings,
      this.syncClient ?? new SyncClient(() => this.settings, () => this.saveSettings()),
      api,
      this.echoSuppression,
    );

    return { api, bridge };
  }

  private activeServerFiles(
    manifest: ManifestFile[],
    bridge: VaultEventBridge,
  ): ManifestFile[] {
    return manifest.filter((file) => {
      if (file.deletedAt) return false;
      if (file.kind === "folder") return false;
      const skipReason = this.serverPathLocalSkipReason(file.path);
      if (skipReason) {
        this.addSkippedServerFile(file, skipReason);
        return false;
      }
      if (bridge.isIgnored(file.path)) return false;
      return true;
    });
  }

  private downloadableServerFiles(
    manifest: ManifestFile[],
    bridge: VaultEventBridge,
  ): ManifestFile[] {
    return this.activeServerFiles(manifest, bridge).filter((file) => {
      if (!file.storageKey) return false;
      if (file.kind !== "markdown" && !shouldSyncBlobFiles(this.settings)) {
        this.addSkippedServerFile(file, "attachments-disabled");
        return false;
      }
      return true;
    });
  }

  private syncableLocalFiles(bridge: VaultEventBridge): TFile[] {
    return this.app.vault.getFiles().filter((file) => {
      if (bridge.isIgnored(file.path)) return false;
      if (this.kindForFile(file) !== "markdown" && !shouldSyncBlobFiles(this.settings)) {
        return false;
      }
      return true;
    });
  }

  private tombstoneForLocalFile(
    file: TFile,
    tombstonesByPath: Map<string, TombstoneRecord>,
    tombstonesByFileId: Map<string, TombstoneRecord>,
  ): TombstoneRecord | undefined {
    const knownFileId = this.settings.fileIds[file.path];
    if (knownFileId) {
      const byFileId = tombstonesByFileId.get(knownFileId);
      if (byFileId) return byFileId;
    }
    return tombstonesByPath.get(file.path);
  }

  private async handleServerDeletedLocalFile(
    file: TFile,
    tombstone: TombstoneRecord,
    uploadQueue: Map<string, TFile>,
    uploadPreconditionsByPath: Map<string, UploadPreconditions>,
    skippedFiles: SkippedFileState[],
  ): Promise<boolean> {
    const knownFileId = this.settings.fileIds[file.path];
    const lastHash = this.settings.lastFileHashes[file.path];
    const lastSeq = this.settings.lastFileSeqs[file.path];
    const matchesKnownFile = Boolean(knownFileId && knownFileId === tombstone.fileId);
    if (!lastHash && !matchesKnownFile) return false;
    if (
      tombstone.deletedSeq !== undefined &&
      lastSeq !== undefined &&
      tombstone.deletedSeq < lastSeq
    ) {
      return false;
    }

    const localHash = await this.localFileHash(file);
    if (lastHash && localHash === lastHash) {
      await this.deleteLocalFileFromServerDeletion(file);
      skippedFiles.push(this.skippedFile(file, "server-deleted"));
      return true;
    }

    const conflictFile = await this.renameToConflictCopy(file);
    uploadQueue.set(conflictFile.path, conflictFile);
    uploadPreconditionsByPath.set(conflictFile.path, {});
    return true;
  }

  private async uploadFiles(
    api: SyncHttpApi,
    files: TFile[],
    options: UploadOptions = {},
  ): Promise<UploadStats> {
    const maxBytes = this.settings.maxAttachmentMB * 1024 * 1024;
    const totalBytes = files.reduce((sum, file) => sum + file.stat.size, 0);
    const uploadStartedAt = Date.now();
    const uploadProgress: ManualUploadProgress = {
      label: t("progress_init_label"),
      startedAt: uploadStartedAt,
      totalFiles: files.length,
      totalBytes,
      processedFiles: 0,
      processedBytes: 0,
      activeFiles: {},
    };
    this.activeManualUploadProgress = uploadProgress;
    this.setProgress(this.formatUploadProgress());

    const concurrency = this.uploadConcurrency(files);
    let uploaded = 0;
    let skipped = 0;
    const skippedFiles: SkippedFileState[] = [];

    const uploadOne = async (index: number): Promise<void> => {
      const file = files[index];
      const kind = this.kindForFile(file);
      uploadProgress.activeFiles[file.path] = {
        fileIndex: index + 1,
        phase: "upload",
        transferredBytes: 0,
        totalBytes: file.stat.size,
      };
      this.setProgress(this.formatUploadProgress());

      if (kind !== "markdown" && !shouldSyncBlobFiles(this.settings)) {
        skipped += 1;
        skippedFiles.push(this.skippedFile(file, "attachments-disabled"));
        uploadProgress.processedFiles += 1;
        uploadProgress.processedBytes += file.stat.size;
        delete uploadProgress.activeFiles[file.path];
        this.setProgress(this.formatUploadProgress());
        return;
      }

      if (file.stat.size > maxBytes) {
        skipped += 1;
        skippedFiles.push(this.skippedFile(file, "large"));
        uploadProgress.processedFiles += 1;
        uploadProgress.processedBytes += file.stat.size;
        delete uploadProgress.activeFiles[file.path];
        this.setProgress(this.formatUploadProgress());
        return;
      }

      const fileId = this.fileIdForPath(file.path);
      const preconditions = this.uploadPreconditions(file, options);
      const body = await this.readFileBody(file, kind);
      const result = await api.uploadFile({
        fileId,
        path: file.path,
        kind,
        body,
        mtimeMs: file.stat.mtime,
        contentType: this.contentTypeForKind(kind),
        expectedCurrentHash: preconditions.expectedCurrentHash,
        expectedCurrentSeq: preconditions.expectedCurrentSeq,
      });

      this.settings.lastFileHashes[file.path] = result.hash;
      this.settings.fileIds[file.path] = result.fileId;
      if (result.operation?.serverSeq) {
        this.settings.lastFileSeqs[file.path] = result.operation.serverSeq;
        if (kind === "markdown") {
          this.syncClient?.sendMarkdownSnapshot({
            sourcePath: file.path,
            sourceHash: result.hash,
            sourceSeq: result.operation.serverSeq,
            markdown: new TextDecoder().decode(body),
          });
        }
      }
      this.notifyUploadedFile(result);
      uploaded += 1;
      uploadProgress.processedFiles += 1;
      uploadProgress.processedBytes += file.stat.size;
      delete uploadProgress.activeFiles[file.path];
      this.setProgress(this.formatUploadProgress());
    };

    const prepareHostedWindow = async (fromIndex: number, toIndex: number): Promise<void> => {
      if (!isHostedSync(this.settings)) return;

      const windowFiles = files.slice(fromIndex, toIndex).filter((file) => {
        const kind = this.kindForFile(file);
        if (kind !== "markdown" && !shouldSyncBlobFiles(this.settings)) return false;
        return file.stat.size <= maxBytes;
      });
      if (windowFiles.length === 0) return;

      uploadProgress.preparingFrom = fromIndex + 1;
      uploadProgress.preparingTo = toIndex;
      this.setProgress(this.formatUploadProgress());
      await api.prepareHostedUploads(windowFiles.map((file) => ({
        ...this.hostedUploadPrepareInput(file, options),
      })));
      uploadProgress.preparingFrom = undefined;
      uploadProgress.preparingTo = undefined;
      this.setProgress(this.formatUploadProgress());
    };

    const uploadWindow = async (fromIndex: number, toIndex: number): Promise<void> => {
      let nextIndex = fromIndex;
      const worker = async (): Promise<void> => {
        while (nextIndex < toIndex) {
          const index = nextIndex;
          nextIndex += 1;
          await uploadOne(index);
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, toIndex - fromIndex) }, () => worker()));
    };

    const uploadInWindows = async (): Promise<void> => {
      if (!isHostedSync(this.settings)) {
        await uploadWindow(0, files.length);
        return;
      }

      for (let fromIndex = 0; fromIndex < files.length; fromIndex += HOSTED_UPLOAD_WINDOW_SIZE) {
        const toIndex = Math.min(files.length, fromIndex + HOSTED_UPLOAD_WINDOW_SIZE);
        await prepareHostedWindow(fromIndex, toIndex);
        await uploadWindow(fromIndex, toIndex);
      }
    };

    try {
      await uploadInWindows();
      this.settings.lastSkippedFiles = skippedFiles.slice(0, 50);
      return { uploaded, skipped, skippedFiles };
    } finally {
      this.activeManualUploadProgress = undefined;
    }
  }

  private uploadConcurrency(files: TFile[]): number {
    if (files.length < 2) return 1;
    if (this.settings.syncBackend !== "hosted") return 1;
    if (this.clientRuntimeFields().isMobile) return 1;
    return Math.min(4, files.length);
  }

  private uploadPreconditions(file: TFile, options: UploadOptions): UploadPreconditions {
    const override = options.preconditionsByPath?.get(file.path);
    if (override) return override;
    return {
      expectedCurrentHash: this.settings.lastFileHashes[file.path],
      expectedCurrentSeq: this.settings.lastFileSeqs[file.path],
    };
  }

  private hostedUploadPrepareInput(file: TFile, options: UploadOptions) {
    const kind = this.kindForFile(file);
    const preconditions = this.uploadPreconditions(file, options);
    return {
      fileId: this.fileIdForPath(file.path),
      path: file.path,
      kind,
      sizeBytes: file.stat.size,
      mtimeMs: file.stat.mtime,
      contentType: this.contentTypeForKind(kind),
      expectedCurrentHash: preconditions.expectedCurrentHash,
      expectedCurrentSeq: preconditions.expectedCurrentSeq,
    };
  }

  private async renameToConflictCopy(file: TFile): Promise<TFile> {
    const originalPath = file.path;
    const conflictPath = this.uniqueConflictCopyPath(originalPath);
    this.echoSuppression.suppress(originalPath);
    this.echoSuppression.suppress(conflictPath);
    await this.app.vault.rename(file, conflictPath);
    delete this.settings.lastFileHashes[originalPath];
    delete this.settings.lastFileSeqs[originalPath];
    delete this.settings.fileIds[originalPath];
    const renamed = this.app.vault.getAbstractFileByPath(conflictPath);
    if (!(renamed instanceof TFile)) {
      throw new Error(t("error_file_not_found"));
    }
    return renamed;
  }

  private async deleteLocalFileFromServerDeletion(file: TFile): Promise<void> {
    const originalPath = file.path;
    this.echoSuppression.suppress(originalPath);
    await this.app.vault.delete(file, true);
    delete this.settings.lastFileHashes[originalPath];
    delete this.settings.lastFileSeqs[originalPath];
    delete this.settings.fileIds[originalPath];
  }

  private uniqueConflictCopyPath(path: string): string {
    const slashIndex = path.lastIndexOf("/");
    const folder = slashIndex >= 0 ? `${path.slice(0, slashIndex)}/` : "";
    const fileName = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
    const dotIndex = fileName.lastIndexOf(".");
    const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
    const extension = dotIndex > 0 ? fileName.slice(dotIndex) : "";
    const device = this.settings.deviceLabel.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "device";
    const timestamp = new Date()
      .toISOString()
      .replace(/\D/g, "")
      .slice(0, 14);

    for (let index = 0; index < 100; index += 1) {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      const candidate = `${folder}${baseName}.obsync-conflict-${device}-${timestamp}${suffix}${extension}`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    return `${folder}${baseName}.obsync-conflict-${device}-${timestamp}-${createRandomId(6)}${extension}`;
  }

  private registerFileMenu(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFolder && file.path) {
          menu.addItem((item) => {
            item
              .setTitle(t("menu_publish_folder"))
              .setIcon("globe")
              .onClick(() => {
                void this.publishFolderAsSite(file);
              });
          });
          const siteUrl = this.sharedUrl("folder", file.path);
          if (siteUrl) {
            menu.addItem((item) => {
              item
                .setTitle(t("menu_copy_link"))
                .setIcon("copy")
                .onClick(() => {
                  void this.copySharedUrl("folder", file.path);
                });
            });
            menu.addItem((item) => {
              item
                .setTitle(t("menu_unpublish"))
                .setIcon("trash")
                .onClick(() => {
                  void this.unpublishSource("folder", file.path);
                });
            });
            menu.addItem((item) => {
              item
                .setTitle(t("menu_manage_publish"))
                .setIcon("external-link")
                .onClick(() => this.openPublicationManager());
            });
          }
          return;
        }

        if (!(file instanceof TFile) || this.kindForFile(file) !== "markdown") return;
        const noteUrl = this.sharedUrl("note", file.path);

        menu.addItem((item) => {
          item
            .setTitle(t("menu_share"))
            .setIcon("share")
            .onClick(() => {
              void this.shareCurrentNote(file);
            });
        });
        if (noteUrl) {
          menu.addItem((item) => {
            item
              .setTitle(t("menu_copy_link"))
              .setIcon("copy")
              .onClick(() => {
                void this.copySharedUrl("note", file.path);
              });
          });
          menu.addItem((item) => {
            item
              .setTitle(t("menu_unpublish"))
              .setIcon("trash")
              .onClick(() => {
                void this.unpublishSource("note", file.path);
              });
          });
          menu.addItem((item) => {
            item
              .setTitle(t("menu_manage_link"))
              .setIcon("external-link")
              .onClick(() => this.openPublicationManager());
          });
        }
      }),
    );
  }

  private async publishFolderAsSite(folder: TFolder): Promise<void> {
    this.settings.publishFolder = folder.path;
    await this.saveSettings();
    await this.publishSite();
  }

  private async downloadServerFile(
    api: SyncHttpApi,
    bridge: VaultEventBridge,
    file: ManifestFile,
    overwrite: boolean,
  ): Promise<WriteResult> {
    void api;
    let result: WriteResult;
    try {
      result = await bridge.writeDownloadedFileFromServer({
        path: file.path,
        kind: file.kind,
        hash: file.hash,
        sizeBytes: file.sizeBytes,
        overwrite,
      });
    } catch (error) {
      if (!this.isUnsupportedLocalWrite(error)) throw error;
      this.addSkippedServerFile(file, "unsupported-path");
      console.warn("[obsync] skipped unsupported local file", { path: file.path, error });
      return "skipped";
    }

    if (file.hash && result !== "conflict") {
      this.trackServerFile(file);
    } else if (result === "conflict") {
      this.notice("notice_conflict_kept_local", { path: file.path });
    }

    return result;
  }

  private trackServerFile(file: ManifestFile): void {
    this.settings.fileIds[file.path] = file.fileId;
    if (file.hash) this.settings.lastFileHashes[file.path] = file.hash;
    if (file.updatedSeq !== undefined) {
      this.settings.lastFileSeqs[file.path] = file.updatedSeq;
    }
  }

  private applyWriteResult(stats: DownloadStats, result: WriteResult): void {
    if (result === "created") stats.created += 1;
    if (result === "updated") stats.updated += 1;
    if (result === "skipped") stats.skipped += 1;
    if (result === "conflict") stats.conflicts += 1;
  }

  private async localFileHash(file: TFile): Promise<string> {
    const kind = this.kindForFile(file);
    const body = kind === "markdown"
      ? await this.app.vault.read(file)
      : await this.app.vault.readBinary(file);
    return `sha256:${await sha256Hex(body)}`;
  }

  private async readFileBody(file: TFile, kind: string): Promise<ArrayBuffer> {
    if (kind === "markdown") {
      return new TextEncoder().encode(await this.app.vault.read(file)).buffer;
    }

    return this.app.vault.readBinary(file);
  }

  private contentTypeForKind(kind: string): string {
    return kind === "markdown"
      ? "text/markdown; charset=utf-8"
      : "application/octet-stream";
  }

  private notifyUploadedFile(file: UploadedFile): void {
    const operation = file.operation;
    this.syncClient?.send({
      opId: operation?.opId ?? this.createManualOpId("file_upsert"),
      operationType: operation?.operationType ?? "file_upsert",
      fileId: operation?.fileId ?? file.fileId,
      path: operation?.path ?? file.path,
      payload: operation?.payload ?? {
        kind: file.kind,
        hash: file.hash,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        contentStored: true,
      },
    });
  }

  private createManualOpId(kind: string): string {
    return `${this.settings.deviceId}:${kind}:manual:${Date.now()}:${createRandomId(8)}`;
  }

  private fileIdForPath(path: string): string {
    const existing = this.settings.fileIds[path];
    if (existing) return existing;

    const generated = `file-${Date.now().toString(36)}-${createRandomId(6)}`;
    this.settings.fileIds[path] = generated;
    return generated;
  }

  private async startSync(): Promise<void> {
    const normalized = await normalizeSettings(this.settings);
    const shouldSave = normalizedSettingsChanged(this.settings, normalized);
    this.settings = normalized;
    if (shouldSave) await this.saveSettings();

    if (!this.settings.enabled) {
      this.statusText = t("sync_status_client_disabled");
      this.setProgress(this.statusText);
      return;
    }

    if (this.settings.safeMode) {
      const message = this.settings.lastStartupFailure || t("status_waiting");
      this.statusText = t("status_safe_mode", { message });
      this.setProgress(this.statusText);
      return;
    }

    this.httpApi = new SyncHttpApi(
      () => this.settings,
      () => this.saveSettings(),
      (progress) => this.handleTransferProgress(progress),
    );

    if (this.hasCompatibilityInputs()) {
      try {
        await this.assertServerCompatibility(this.httpApi);
      } catch (error) {
        const message = this.errorMessage(error);
        this.statusText = t("status_compatibility_failed", { message });
        this.setProgress(this.statusText);
        this.notice("status_compatibility_failed", { message }, 12000);
        console.warn("[obsync] compatibility check failed", error);
        if (!isHostedSync(this.settings)) return;
      }
    }

    this.syncClient = new SyncClient(() => this.settings, () => this.saveSettings());
    this.syncClient.onEvent((event) => this.handleSyncEvent(event));
    this.bridge = new VaultEventBridge(
      this.app.vault,
      () => this.settings,
      this.syncClient,
      this.httpApi,
      this.echoSuppression,
    );

    this.settings.consecutiveStartupFailures = 0;
    this.settings.lastStartupFailure = undefined;
    this.settings.lastStartupFailureAt = undefined;
    await this.saveSettings();
    this.syncClient.connect();
  }

  private async handleStartupSyncError(error: unknown): Promise<void> {
    const message = this.errorMessage(error);
    this.settings.consecutiveStartupFailures = (this.settings.consecutiveStartupFailures ?? 0) + 1;
    this.settings.lastStartupFailure = message.slice(0, 240);
    this.settings.lastStartupFailureAt = Date.now();
    if (this.settings.consecutiveStartupFailures >= STARTUP_SAFE_MODE_FAILURES) {
      this.settings.safeMode = true;
      this.statusText = t("status_safe_mode", { message });
      this.setProgress(this.statusText);
    } else {
      this.statusText = t("status_startup_failed", { message });
      this.setProgress(t("progress_connection_error", { message }));
    }
    await this.saveSettings();
    this.notice("status_startup_failed", { message }, 12000);
    console.warn("[obsync] startup sync failed", error);
  }

  private settingsForDisk(): ObsyncSettings {
    return {
      ...this.settings,
      pendingUploads: this.cleanStalePendingUploads(this.settings.pendingUploads),
    };
  }

  private cleanStalePendingUploads(
    pending: Record<string, PendingUploadState>,
  ): Record<string, PendingUploadState> {
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const result: Record<string, PendingUploadState> = {};
    for (const [key, state] of Object.entries(pending)) {
      if (state && now - state.updatedAt < maxAgeMs) {
        result[key] = state;
      }
    }
    return result;
  }

  async uploadLocalVault(): Promise<void> {
    await this.installVault();
  }

  async downloadVaultFromServer(): Promise<void> {
    await this.syncNow();
  }

  async refreshStorageUsage(): Promise<void> {
    try {
      await this.ensureManualSyncReady();
      const api = this.httpApi ?? new SyncHttpApi(
        () => this.settings,
        () => this.saveSettings(),
        (progress) => this.handleTransferProgress(progress),
      );
      const usage = await api.storageUsage();
      this.settings.lastStorageUsage = {
        ...usage,
        refreshedAt: Date.now(),
      };
      await this.saveSettings();
      this.setProgress(t("progress_storage_updated", {
        usage: this.formatStorageUsage(this.settings.lastStorageUsage),
      }));
      this.notice("notice_storage_updated");
    } catch (error) {
      const message = this.errorMessage(error);
      this.setProgress(t("progress_storage_error", { message }));
      this.notice("notice_storage_update_failed", { message }, 12000);
    }
  }

  async clearSkippedFiles(): Promise<void> {
    this.settings.lastSkippedFiles = [];
    await this.saveSettings();
  }

  async showCurrentNoteHistory(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || this.kindForFile(file) !== "markdown") {
      this.notice("notice_open_markdown_first");
      return;
    }

    try {
      await this.ensureManualSyncReady();
      const { api, bridge } = this.manualSyncContext();
      if (bridge.isIgnored(file.path)) {
        this.notice("notice_note_ignored_by_sync");
        return;
      }
      const history = await api.history(file.path, 30);
      new NoteHistoryModal(this, file.path, history.entries).open();
    } catch (error) {
      const message = this.errorMessage(error);
      this.notice("notice_history_failed", { message }, 12000);
      console.error("[obsync] history failed", error);
    }
  }

  async shareCurrentNote(fileOverride?: TFile): Promise<void> {
    if (this.syncJobRunning) {
      this.enqueueAfterSync(t("queue_share_note"), () => this.shareCurrentNote(fileOverride));
      return;
    }
    if (this.publicationJobRunning) {
      this.notice("notice_publication_already_running");
      return;
    }

    const file = fileOverride ?? this.app.workspace.getActiveFile();
    if (!file || this.kindForFile(file) !== "markdown") {
      this.notice("notice_open_markdown_for_share");
      return;
    }
    if (this.settings.syncBackend !== "hosted") {
      this.notice("notice_publication_hosted_only", undefined, 10000);
      return;
    }

    try {
      await this.ensureManualSyncReady();
      const { api, bridge } = this.manualSyncContext();
      if (bridge.isIgnored(file.path)) {
        this.notice("notice_note_excluded_from_sync");
        return;
      }

      this.publicationJobRunning = true;
      const uploadStats = await this.uploadChangedFilesForPublication(api, [file]);
      if (uploadStats.uploaded === 0) {
        this.setProgress(
          `${t("progress_share_uptodate", { suffix: this.skippedSuffix(uploadStats) })}`,
        );
      }
      await this.saveSettings();

      const result = await api.createNoteShare({
        sourcePath: file.path,
        title: file.basename,
        includeAttachments: shouldSyncBlobFiles(this.settings),
      });
      const shareUrl = this.publishUrlForResult(result, "note", file.path);
      await this.saveSettings();
      void this.refreshShareCatalogFromServer(true);
      this.scheduleShareIndicatorRefresh();
      const copied = shareUrl ? await this.copyToClipboard(shareUrl) : false;
      this.setProgress([
        result.created
          ? t("progress_share_created")
          : t("progress_share_updated"),
        shareUrl ? shareUrl : t("progress_share_account_fallback"),
      ].join("\n"));
      if (shareUrl) {
        if (copied) {
          this.notice("notice_note_link_copied", undefined, 12000);
        } else {
          this.notice("notice_note_link_copied_value", { value: shareUrl }, 12000);
        }
      } else {
        this.notice("notice_note_link_account", undefined, 12000);
      }
    } catch (error) {
      const message = this.errorMessage(error);
      this.notice("notice_share_failed", { message }, 12000);
      console.error("[obsync] note share failed", error);
    } finally {
      this.publicationJobRunning = false;
    }
  }

  async publishSite(): Promise<void> {
    if (this.syncJobRunning) {
      this.enqueueAfterSync(t("queue_publish_site"), () => this.publishSite());
      return;
    }
    if (this.publicationJobRunning) {
      this.notice("notice_publication_already_running");
      return;
    }
    if (this.settings.syncBackend !== "hosted") {
      this.notice("notice_publication_hosted_only", undefined, 10000);
      return;
    }

    const folderPath = this.settings.publishFolder.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/g, "");
    if (!folderPath) {
      this.notice("error_missing_publish_folder", undefined, 10000);
      return;
    }
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) {
      this.notice("error_publish_folder_not_found", { value: folderPath }, 10000);
      return;
    }

    try {
      await this.ensureManualSyncReady();
      const { api, bridge } = this.manualSyncContext();
      if (bridge.isIgnored(folderPath)) {
        this.notice("notice_note_excluded_from_sync");
        return;
      }
      const files = this.app.vault.getFiles().filter((file) => {
        return file.path.startsWith(`${folderPath}/`) &&
          this.kindForFile(file) === "markdown" &&
          !bridge.isIgnored(file.path);
      });
      if (!files.length) {
        this.notice("error_publish_folder_no_markdown", undefined, 10000);
        return;
      }

      this.publicationJobRunning = true;
      const uploadStats = await this.uploadChangedFilesForPublication(api, files);
      if (uploadStats.uploaded === 0) {
        this.setProgress(
          `${t("progress_publish_site_uptodate", { suffix: this.skippedSuffix(uploadStats) })}`,
        );
      }
      await this.saveSettings();

      const result = await api.publishSite({
        sourcePath: folderPath,
        title: folder.name,
        includeAttachments: shouldSyncBlobFiles(this.settings),
      });
      const shareUrl = this.publishUrlForResult(result, "folder", folderPath);
      await this.saveSettings();
      void this.refreshShareCatalogFromServer(true);
      this.scheduleShareIndicatorRefresh();
      const copied = shareUrl ? await this.copyToClipboard(shareUrl) : false;
      this.setProgress([
        result.created
          ? t("progress_publish_created")
          : t("progress_publish_rebuilt"),
        shareUrl ? shareUrl : t("progress_publish_account_fallback"),
      ].join("\n"));
      if (shareUrl) {
        if (copied) {
          this.notice("notice_publish_link_copied", undefined, 12000);
        } else {
          this.notice("notice_publish_link_copied_value", { value: shareUrl }, 12000);
        }
      } else {
        this.notice("notice_publish_link_account", undefined, 12000);
      }
    } catch (error) {
      const message = this.errorMessage(error);
      this.notice("notice_publish_site_failed", { message }, 12000);
      console.error("[obsync] site publish failed", error);
    } finally {
      this.publicationJobRunning = false;
    }
  }

  async showHistoryVersion(path: string, serverSeq: number): Promise<void> {
    const version = await this.loadHistoryVersion(path, serverSeq);
    new HistoryContentModal(this, path, version.serverSeq, version.content).open();
  }

  private async uploadChangedFilesForPublication(
    api: SyncHttpApi,
    files: TFile[],
  ): Promise<UploadStats> {
    if (!files.length) return { uploaded: 0, skipped: 0, skippedFiles: [] };

    this.setProgress(t("progress_uploading_label"));
    const manifest = await api.manifest();
    const serverByPath = new Map(
      manifest
        .filter((file) => !file.deletedAt && file.kind !== "folder")
        .map((file) => [file.path, file]),
    );
    const changedFiles: TFile[] = [];
    const uploadPreconditionsByPath = new Map<string, UploadPreconditions>();

    for (const file of files) {
      const serverFile = serverByPath.get(file.path);
      if (!serverFile?.hash) {
        changedFiles.push(file);
        uploadPreconditionsByPath.set(file.path, {});
        continue;
      }

      const localHash = await this.localFileHash(file);
      if (serverFile.hash === localHash) {
        this.trackServerFile(serverFile);
        continue;
      }

      changedFiles.push(file);
    }

    if (!changedFiles.length) {
      return { uploaded: 0, skipped: 0, skippedFiles: [] };
    }

    try {
      return await this.uploadFiles(api, changedFiles, { preconditionsByPath: uploadPreconditionsByPath });
    } catch (error) {
      throw new Error(
        t("notice_upload_before_publish_error", {
          count: changedFiles.length,
          message: this.errorMessage(error),
        }),
      );
    }
  }

  async restoreHistoryVersion(path: string, serverSeq: number): Promise<void> {
    if (this.syncJobRunning) {
      this.notice("notice_sync_job_running");
      return;
    }

    const version = await this.loadHistoryVersion(path, serverSeq);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new Error(t("error_note_not_found"));
    }

    this.syncJobRunning = true;
    try {
      const { api } = this.manualSyncContext();
      const currentServerFile = (await api.manifest()).find((item) => item.path === path);
      if (currentServerFile) {
        this.trackServerFile(currentServerFile);
      }

      if (currentServerFile?.hash && currentServerFile.hash === version.hash) {
        this.echoSuppression.suppress(path);
        await this.app.vault.modify(file, version.content);
        await this.saveSettings();
        this.notice("notice_restore_aligned", { version: version.serverSeq });
        return;
      }

      const encoded = new TextEncoder().encode(version.content);
      const body = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
      const result = await api.uploadFile({
        fileId: this.fileIdForPath(path),
        path,
        kind: "markdown",
        body,
        mtimeMs: Date.now(),
        contentType: "text/markdown; charset=utf-8",
        expectedCurrentHash: this.settings.lastFileHashes[path],
        expectedCurrentSeq: this.settings.lastFileSeqs[path],
      });
      this.settings.lastFileHashes[path] = result.hash;
      this.settings.fileIds[path] = result.fileId;
      if (result.operation?.serverSeq) {
        this.settings.lastFileSeqs[path] = result.operation.serverSeq;
        this.syncClient?.sendMarkdownSnapshot({
          sourcePath: path,
          sourceHash: result.hash,
          sourceSeq: result.operation.serverSeq,
          markdown: version.content,
        });
      }
      this.echoSuppression.suppress(path);
      await this.app.vault.modify(file, version.content);
      await this.saveSettings();

      if (result.operation?.serverSeq) {
        this.notice("notice_restore_aligned", { version: version.serverSeq });
      }
    } finally {
      this.syncJobRunning = false;
    }
  }

  async compareHistoryVersion(path: string, serverSeq: number): Promise<void> {
    const version = await this.loadHistoryVersion(path, serverSeq);
    const current = this.app.vault.getAbstractFileByPath(path);
    if (!(current instanceof TFile)) {
      throw new Error(t("error_note_not_found"));
    }
    const currentContent = await this.app.vault.read(current);
    new HistoryDiffModal(this, path, version.serverSeq, version.content, currentContent).open();
  }

  private async loadHistoryVersion(path: string, serverSeq: number): Promise<{
    serverSeq: number;
    hash?: string;
    content: string;
  }> {
    await this.ensureManualSyncReady();
    const api = this.httpApi ?? new SyncHttpApi(
      () => this.settings,
      () => this.saveSettings(),
      (progress) => this.handleTransferProgress(progress),
    );
    return api.historyVersion(path, serverSeq);
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        this.bridge?.handleCreate(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        this.bridge?.handleModify(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        this.bridge?.handleDelete(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        this.bridge?.handleRename(file, oldPath);
      }),
    );
  }

  private async handleSyncEvent(event: SyncClientEvent): Promise<void> {
    if (event.type === "status") {
      this.statusText = this.tStatus(event.status);
      return;
    }

    if (event.type === "ack") {
      this.settings.lastCursor = Math.max(this.settings.lastCursor, event.serverSeq);
      this.applyPendingSeqUpdate(event.opId, event.serverSeq);
      await this.saveSettings();
      return;
    }

    if (event.type === "operation") {
      try {
        if (this.isStaleSyncOperation(event.operation)) {
          this.advanceCursor(event.operation.serverSeq);
          await this.saveSettings();
          return;
        }
        const skipReason = this.serverOperationLocalSkipReason(event.operation);
        if (skipReason) {
          this.addSkippedServerOperation(event.operation, skipReason);
          this.advanceCursor(event.operation.serverSeq);
          await this.saveSettings();
          return;
        }
        await this.bridge?.applyRemoteOperation(event.operation);
        this.advanceCursor(event.operation.serverSeq);
        await this.saveSettings();
      } catch (error) {
        if (this.isUnsupportedLocalWrite(error)) {
          this.addSkippedServerOperation(event.operation, "unsupported-path");
          this.advanceCursor(event.operation.serverSeq);
          await this.saveSettings();
          console.warn("[obsync] skipped unsupported live operation", {
            path: event.operation.path,
            error,
          });
          return;
        }
        const message = this.errorMessage(error);
        this.setProgress(t("status_apply_changes_error", { message }));
        console.error("[obsync] remote apply failed", error);
      }
      return;
    }

    if (event.type === "error") {
      this.statusText = t("ui_error_message", { message: event.message });
      console.warn("[obsync]", event.message);
    }
  }

  private async ensureManualSyncReady(): Promise<void> {
    const normalized = await normalizeSettings(this.settings);
    const shouldSave = normalizedSettingsChanged(this.settings, normalized);
    this.settings = normalized;
    if (shouldSave) await this.saveSettings();

    if (!this.settings.authToken) {
      throw new Error(t("sync_status_no_token"));
    }

    if (!this.settings.serverUrl) {
      throw new Error(t("notice_sync_url_missing"));
    }

    if (
      this.settings.syncBackend !== "hosted" &&
      (!this.settings.vaultName.trim() || !this.settings.vaultId)
    ) {
      throw new Error(t("sync_status_no_vault_name"));
    }

    if (!this.settings.deviceLabel.trim() || !this.settings.deviceId) {
      throw new Error(t("sync_status_no_device_name"));
    }

    const api = this.httpApi ?? new SyncHttpApi(
      () => this.settings,
      () => this.saveSettings(),
      (progress) => this.handleTransferProgress(progress),
    );
    await this.assertServerCompatibility(api);

    if (!this.settings.vaultId) {
      throw new Error(t("notice_server_id_missing"));
    }
  }

  private hasCompatibilityInputs(): boolean {
    return Boolean(
      this.settings.serverUrl &&
      this.settings.authToken &&
      this.settings.deviceId,
    );
  }

  private async assertServerCompatibility(api: SyncHttpApi): Promise<void> {
    const compatibility = await api.compatibility();
    this.settings.lastCompatibility = {
      compatible: compatibility.compatible,
      serverVersion: compatibility.serverVersion,
      protocolVersion: compatibility.protocolVersion,
      minClientVersion: compatibility.minClientVersion,
      latestClientVersion: compatibility.latestClientVersion,
      message: compatibility.message,
      checkedAt: Date.now(),
    };
    await this.saveSettings();

    if (compatibility.protocolVersion < OBSYNC_MIN_SERVER_PROTOCOL_VERSION) {
      throw new Error(
        t("compatibility_protocol_too_low", {
          actual: compatibility.protocolVersion,
          required: OBSYNC_MIN_SERVER_PROTOCOL_VERSION,
        }),
      );
    }

    if (!compatibility.compatible) {
      throw new Error(
        compatibility.message ??
          t("compatibility_server_incompatible", {
            version: OBSYNC_PLUGIN_VERSION,
          }),
      );
    }
  }

  private applyPendingSeqUpdate(opId: string, serverSeq: number): void {
    const pending = this.settings.pendingSeqUpdates[opId];
    if (!pending) return;

    if (pending.kind === "delete") {
      delete this.settings.lastFileSeqs[pending.path];
      delete this.settings.lastFileHashes[pending.path];
      delete this.settings.fileIds[pending.path];
    } else if (pending.kind === "rename" && pending.newPath) {
      this.settings.lastFileSeqs[pending.newPath] = serverSeq;
      delete this.settings.lastFileSeqs[pending.path];
    } else {
      this.settings.lastFileSeqs[pending.path] = serverSeq;
    }

    delete this.settings.pendingSeqUpdates[opId];
  }

  private isStaleSyncOperation(operation: { serverSeq: number; path?: string }): boolean {
    if (operation.serverSeq <= this.settings.lastCursor) return true;
    if (!operation.path) return false;
    const lastSeq = this.settings.lastFileSeqs[operation.path];
    return lastSeq !== undefined && operation.serverSeq <= lastSeq;
  }

  private advanceCursor(serverSeq: number | undefined): void {
    if (serverSeq === undefined || !Number.isFinite(serverSeq)) return;
    this.settings.lastCursor = Math.max(this.settings.lastCursor, serverSeq);
  }

  private repairCursorFromKnownFileSeqs(): void {
    for (const seq of Object.values(this.settings.lastFileSeqs)) {
      this.advanceCursor(seq);
    }
  }

  private setProgress(progress: string): void {
    this.progressText = progress;
    if (this.progressStatusEl) {
      this.progressStatusEl.setText(progress);
    }
  }

  private notice(
    key: I18nKey | string,
    vars?: Record<string, string | number | boolean>,
    timeout = 12000,
  ): void {
    const message = key in MESSAGES.en ? t(key as I18nKey, vars) : key;
    new Notice(`${t("notice_prefix")}: ${message}`, timeout);
  }

  private tStatus(status: string): string {
    const statusMap: Record<string, I18nKey> = {
      "фоновая синхронизация выключена": "sync_status_client_disabled",
      "не указан ключ доступа": "sync_status_no_token",
      "не указано название хранилища": "sync_status_no_vault_name",
      "не указано название устройства": "sync_status_no_device_name",
      "подключение": "sync_status_connection",
      "подключено": "sync_status_connected",
      "соединение закрыто": "sync_status_disconnected",
      "ошибка соединения": "sync_status_connection_error",
      "нет соединения, изменение будет отправлено после переподключения": "sync_status_offline_change_queued",
      "не удалось подготовить соединение": "sync_status_connection_failed",
      "background sync disabled": "sync_status_client_disabled",
      "no access token provided": "sync_status_no_token",
      "no vault name set": "sync_status_no_vault_name",
      "no device name set": "sync_status_no_device_name",
      "connection": "sync_status_connection",
      "connected": "sync_status_connected",
      "connection closed": "sync_status_disconnected",
      "connection error": "sync_status_connection_error",
      "no connection, change will be sent after reconnect": "sync_status_offline_change_queued",
    };
    const key = statusMap[status.trim()];
    return key ? t(key) : status;
  }

  private enqueueAfterSync(label: string, run: () => Promise<void>): void {
    this.postSyncQueue.push({ label, run });
    this.setProgress(
      t("notice_queue_summary", {
        label,
        message: t("status_waiting"),
      }),
    );
    this.notice("notice_queue_summary", {
      label,
      message: t("status_waiting"),
    }, 10000);
  }

  private async drainPostSyncQueue(): Promise<void> {
    if (this.publicationJobRunning || this.syncJobRunning || this.postSyncQueue.length === 0) return;
    const queue = this.postSyncQueue.splice(0);
    for (const item of queue) {
      try {
        await item.run();
      } catch (error) {
        const message = this.errorMessage(error);
        this.notice("notice_queue_failed", {
          label: item.label,
          message,
        }, 12000);
      }
    }
  }

  private handleTransferProgress(progress: SyncTransferProgress): void {
    if (progress.phase === "retry") {
      this.setProgress([
        t("progress_retrying", {
          current: progress.chunkIndex ?? 1,
          total: progress.totalChunks ?? 1,
        }),
        progress.message ?? t("progress_retry_default_message"),
      ].join("\n"));
      return;
    }

    const batch = this.activeManualUploadProgress;
    if (batch?.activeFiles[progress.path]) {
      batch.activeFiles[progress.path] = {
        ...batch.activeFiles[progress.path],
        phase: progress.phase,
        transferredBytes: progress.transferredBytes,
        totalBytes: progress.totalBytes,
      };
      this.setProgress(this.formatUploadProgress());
      return;
    }

    this.setProgress(
      [
        t("progress_init_label"),
        `${this.formatBytes(progress.transferredBytes)}/${this.formatBytes(progress.totalBytes)}${this.chunkProgressSuffix(progress)}`,
      ].join("\n"),
    );
  }

  private formatUploadProgress(): string {
    const batch = this.activeManualUploadProgress;
    if (!batch) {
      return t("upload_progress_no_active");
    }

    if (batch.preparingFrom !== undefined && batch.preparingTo !== undefined) {
      return [
        t("progress_uploaded_label", {
          current: batch.processedFiles,
          total: batch.totalFiles,
        }),
        t("progress_upload_preparing", {
          from: batch.preparingFrom,
          to: batch.preparingTo,
          total: batch.totalFiles,
        }),
      ].join("\n");
    }

    const active = Object.entries(batch.activeFiles);
    const activeBytes = active.reduce((sum, [, file]) => sum + Math.min(file.transferredBytes, file.totalBytes), 0);
    const doneBytes = Math.min(batch.processedBytes + activeBytes, batch.totalBytes);
    const percent = batch.totalBytes > 0
      ? Math.min(100, (doneBytes / batch.totalBytes) * 100)
      : 100;
    const elapsedSeconds = Math.max(1, (Date.now() - batch.startedAt) / 1000);
    const speedBytes = doneBytes > 0 ? doneBytes / elapsedSeconds : 0;
    const remainingBytes = Math.max(0, batch.totalBytes - doneBytes);
    const eta = speedBytes > 0
      ? this.formatDuration(remainingBytes / speedBytes)
      : t("duration_calculating");

    return [
      t("progress_uploaded_label", {
        current: batch.processedFiles,
        total: batch.totalFiles,
      }),
      `${this.formatBytes(doneBytes)}/${this.formatBytes(batch.totalBytes)} · ${
        percent.toFixed(percent < 10 ? 1 : 0)}% · ${t("progress_upload_remaining", { eta })}`,
    ].join("\n");
  }

  private chunkProgressSuffix(progress: SyncTransferProgress): string {
    return progress.totalChunks
      ? t("progress_upload_chunk", {
        current: progress.chunkIndex ?? 0,
        total: progress.totalChunks,
      })
      : "";
  }

  private publishUrlForResult(
    result: CreateShareResponse,
    sourceType: "note" | "folder",
    sourcePath: string,
  ): string | undefined {
    const key = `${sourceType}:${sourcePath}`;
    const freshUrl = result.share.shortUrl || result.publicUrl || result.share.publicUrl || result.sharePath;
    if (freshUrl) {
      const url = freshUrl.startsWith("http")
        ? freshUrl
        : new URL(freshUrl, `${this.settings.serverUrl.replace(/\/+$/, "")}/`).toString();
      this.settings.publishLinks[key] = url;
      return url;
    }
    return this.settings.publishLinks[key];
  }

  private async copyToClipboard(value: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private registerShareIndicators(): void {
    const refresh = () => this.refreshShareIndicators();
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleShareIndicatorRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleShareIndicatorRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleShareIndicatorRefresh()));

    this.shareIndicatorObserver = new MutationObserver(() => this.scheduleShareIndicatorRefresh());
    this.shareIndicatorObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    this.register(() => this.shareIndicatorObserver?.disconnect());

    const timer = window.setTimeout(refresh, 750);
    this.register(() => window.clearTimeout(timer));
    const serverTimer = window.setTimeout(() => {
      void this.refreshShareCatalogFromServer(true);
    }, 1200);
    this.register(() => window.clearTimeout(serverTimer));
    this.registerInterval(window.setInterval(() => {
      void this.refreshShareCatalogFromServer();
    }, 60_000));
  }

  private scheduleShareIndicatorRefresh(): void {
    if (this.shareIndicatorRefreshTimer) {
      window.clearTimeout(this.shareIndicatorRefreshTimer);
    }
    this.shareIndicatorRefreshTimer = window.setTimeout(() => {
      this.shareIndicatorRefreshTimer = undefined;
      this.refreshShareIndicators();
    }, 100);
  }

  private refreshShareIndicators(): void {
    this.refreshShareIndicatorRows(
      ".workspace-leaf-content[data-type='file-explorer'] .nav-file-title",
      "note",
    );
    this.refreshShareIndicatorRows(
      ".workspace-leaf-content[data-type='file-explorer'] .nav-folder-title",
      "folder",
    );
  }

  private refreshShareIndicatorRows(selector: string, sourceType: "note" | "folder"): void {
    const titles = document.querySelectorAll<HTMLElement>(selector);
    for (const title of Array.from(titles)) {
      const path = this.fileExplorerPath(title);
      const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
      const shouldShow = sourceType === "note"
        ? file instanceof TFile && this.kindForFile(file) === "markdown"
        : file instanceof TFolder;
      const existing = title.querySelector<HTMLElement>(".obsync-share-indicator");
      const url = path ? this.sharedUrl(sourceType, path) : undefined;

      if (!shouldShow || !path || !url) {
        existing?.remove();
        title.classList.remove("obsync-share-row");
        title.classList.remove("obsync-share-row-folder");
        continue;
      }

      title.classList.add("obsync-share-row");
      title.classList.toggle("obsync-share-row-folder", sourceType === "folder");
      const indicator = existing ?? this.createShareIndicator(sourceType);
      indicator.classList.toggle("obsync-share-indicator-folder", sourceType === "folder");
      indicator.setAttribute("aria-label", t("indicator_copy_label"));
      indicator.setAttribute("title", sourceType === "folder"
        ? t("indicator_copy_folder_title")
        : t("indicator_copy_note_title"));
      indicator.dataset.path = path;
      indicator.dataset.sourceType = sourceType;

      if (!existing) {
        title.appendChild(indicator);
      }
    }
  }

  private createShareIndicator(sourceType: "note" | "folder"): HTMLElement {
      const button = document.createElement("button");
    button.type = "button";
    button.className = "obsync-share-indicator";
    button.dataset.sourceType = sourceType;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const path = button.dataset.path;
      if (!path) return;

      const type = button.dataset.sourceType === "folder" ? "folder" : "note";
      const url = this.sharedUrl(type, path);
      if (url) {
        void this.copyToClipboard(url).then((copied) => {
          const label = type === "folder" ? t("label_copy_link_folder") : t("label_copy_link");
          if (copied) {
            this.notice("notice_copy_folder_copied", { label }, 8000);
          } else {
            this.notice("notice_copy_folder_value", {
              label,
              value: url,
            }, 8000);
          }
        });
      }
    });
    return button;
  }

  private async refreshShareCatalogFromServer(force = false): Promise<void> {
    if (this.settings.syncBackend !== "hosted" || !this.settings.authToken.trim()) return;
    const now = Date.now();
    if (!force && now - this.shareCatalogLastLoadedAt < 55_000) return;
    this.shareCatalogLastLoadedAt = now;

    try {
      const api = this.httpApi ?? new SyncHttpApi(
        () => this.settings,
        () => this.saveSettings(),
        (progress) => this.handleTransferProgress(progress),
      );
      const response = await api.listShares();
      if (this.applyShareCatalog(response.shares)) {
        await this.saveSettings();
      }
      this.scheduleShareIndicatorRefresh();
    } catch (error) {
      console.warn("[obsync] share catalog refresh failed", error);
    }
  }

  private applyShareCatalog(shares: PublishedShare[]): boolean {
    const activeKeys = new Set<string>();
    let changed = false;
    for (const share of shares) {
      if (share.status === "revoked" || share.status === "expired" || share.status === "failed") continue;
      const key = this.publishLinkKey(share.sourceType, share.sourcePath);
      activeKeys.add(key);
      const url = share.shortUrl || share.publicUrl;
      if (url && this.settings.publishLinks[key] !== url) {
        this.settings.publishLinks[key] = url;
        changed = true;
      }
    }

    for (const key of Object.keys(this.settings.publishLinks)) {
      if ((key.startsWith("note:") || key.startsWith("folder:")) && !activeKeys.has(key)) {
        delete this.settings.publishLinks[key];
        changed = true;
      }
    }
    return changed;
  }

  private async copySharedUrl(sourceType: "note" | "folder", sourcePath: string): Promise<void> {
    const url = this.sharedUrl(sourceType, sourcePath);
    if (!url) {
      this.notice("notice_copy_link_missing", undefined, 8000);
      void this.refreshShareCatalogFromServer(true);
      return;
    }
    const copied = await this.copyToClipboard(url);
    if (copied) {
      this.notice("notice_link_copied", undefined, 8000);
    } else {
      this.notice("notice_copy_folder_value", {
        label: t("label_copy_link"),
        value: url,
      }, 8000);
    }
  }

  private async unpublishSource(sourceType: "note" | "folder", sourcePath: string): Promise<void> {
    if (this.publicationJobRunning) {
      this.notice("notice_publication_already_running");
      return;
    }
    if (this.settings.syncBackend !== "hosted") {
      this.notice("notice_publication_hosted_only", undefined, 10000);
      return;
    }

    this.publicationJobRunning = true;
    try {
      await this.ensureManualSyncReady();
      const { api } = this.manualSyncContext();
      await api.revokeShare({ sourceType, sourcePath });
      delete this.settings.publishLinks[this.publishLinkKey(sourceType, sourcePath)];
      await this.saveSettings();
      this.scheduleShareIndicatorRefresh();
      this.setProgress(
        sourceType === "note"
          ? t("progress_unpublish_note")
          : t("progress_unpublish_site"),
      );
      this.notice("notice_unpublish_done", undefined, 8000);
      void this.refreshShareCatalogFromServer(true);
    } catch (error) {
      const message = this.errorMessage(error);
      this.notice("notice_unpublish_failed", { message }, 12000);
      console.error("[obsync] unpublish failed", error);
    } finally {
      this.publicationJobRunning = false;
    }
  }

  private openPublicationManager(): void {
    const baseUrl = this.settings.serverUrl.replace(/\/+$/, "") || "https://obsync.ru";
    window.open(`${baseUrl}/account`, "_blank", "noopener");
  }

  private fileExplorerPath(title: HTMLElement): string | undefined {
    const direct = title.dataset.path;
    if (direct) return direct;
    const withPath = title.closest<HTMLElement>("[data-path]");
    return withPath?.dataset.path;
  }

  private sharedUrl(sourceType: "note" | "folder", sourcePath: string): string | undefined {
    return this.settings.publishLinks[this.publishLinkKey(sourceType, sourcePath)];
  }

  private publishLinkKey(sourceType: "note" | "folder", sourcePath: string): string {
    return `${sourceType}:${sourcePath}`;
  }

  private skippedFile(file: TFile, reason: SkippedFileState["reason"]): SkippedFileState {
    return {
      path: file.path,
      sizeBytes: file.stat.size,
      reason,
      skippedAt: Date.now(),
    };
  }

  private addSkippedServerFile(file: ManifestFile, reason: SkippedFileState["reason"]): void {
    const skipped = {
      path: file.path,
      sizeBytes: file.sizeBytes ?? 0,
      reason,
      skippedAt: Date.now(),
    };
    this.activeDownloadSkippedFiles = this.mergeSkippedFiles([
      skipped,
      ...this.activeDownloadSkippedFiles,
    ]);
    this.settings.lastSkippedFiles = this.mergeSkippedFiles([
      skipped,
      ...this.settings.lastSkippedFiles,
    ]);
  }

  private addSkippedServerOperation(
    operation: ServerOperation,
    reason: SkippedFileState["reason"],
  ): void {
    if (!operation.path) return;
    const sizeBytes = typeof operation.payload.sizeBytes === "number"
      ? operation.payload.sizeBytes
      : 0;
    this.addSkippedServerFile({
      vaultId: operation.vaultId,
      fileId: operation.fileId ?? operation.path,
      path: operation.path,
      kind: typeof operation.payload.kind === "string" ? operation.payload.kind : "markdown",
      sizeBytes,
      updatedSeq: operation.serverSeq,
    }, reason);
  }

  private serverOperationLocalSkipReason(operation: ServerOperation): SkippedFileState["reason"] | undefined {
    if (!operation.path) return undefined;
    const pathReason = this.serverPathLocalSkipReason(operation.path);
    if (pathReason) return pathReason;
    const kind = typeof operation.payload.kind === "string" ? operation.payload.kind : undefined;
    if (kind && kind !== "markdown" && !shouldSyncBlobFiles(this.settings)) {
      return "attachments-disabled";
    }
    return undefined;
  }

  private serverPathLocalSkipReason(path: string): SkippedFileState["reason"] | undefined {
    const validPath = validateVaultPath(path, {
      allowObsidianConfig: true,
      allowObsidianPlugins: true,
    });
    if (validPath) return undefined;
    return this.hasPathSegmentOverLocalLimit(path) ? "path-segment-too-long" : "unsupported-path";
  }

  private hasPathSegmentOverLocalLimit(path: string): boolean {
    return path
      .normalize("NFC")
      .replace(/\\/g, "/")
      .split("/")
      .some((segment) => TEXT_ENCODER.encode(segment).byteLength > MAX_VAULT_PATH_SEGMENT_BYTES);
  }

  private mergeSkippedFiles(files: SkippedFileState[]): SkippedFileState[] {
    const byPath = new Map<string, SkippedFileState>();
    for (const file of files) {
      if (!byPath.has(file.path)) byPath.set(file.path, file);
    }
    return [...byPath.values()].slice(0, 50);
  }

  private isUnsupportedLocalWrite(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b(?:401|403|404|409|412|500|502|503|504)\b/.test(message)) return false;
    if (/invalid (?:or expired )?(?:ws )?ticket|invalid sync session|inactive device|token/i.test(message)) {
      return false;
    }
    return /FILE_NOTCREATED|not\s*created|ENAMETOOLONG|EINVAL|EACCES|EPERM|ENOENT/i.test(message);
  }

  private skippedSuffix(stats: UploadStats): string {
    const largeCount = stats.skippedFiles.filter((file) => file.reason === "large").length;
    if (largeCount === 0) return t("skipped_files_limit_suffix_zero");
    return t("skipped_files_limit_suffix", { count: largeCount });
  }

  private formatStorageUsage(usage: StorageUsage | StorageUsageState): string {
    const quota = usage.quotaBytes;
    const used = usage.logicalBytes + usage.reservedBytes;
    const quotaText = quota
      ? `${this.formatBytes(used)}/${this.formatBytes(quota)} (${Math.min(100, (used / quota) * 100).toFixed(1)}%)`
      : `${this.formatBytes(used)}, ${t("storage_quota_unknown")}`;
    const refreshed = "refreshedAt" in usage
      ? t("storage_refreshed_at", { value: new Date(usage.refreshedAt).toLocaleString() })
      : "";
    const parts = t("storage_parts", {
      logical: this.formatBytes(usage.logicalBytes),
      physical: this.formatBytes(usage.physicalBytes),
      reserved: this.formatBytes(usage.reservedBytes),
    });

    return `${quotaText}; ${parts}${refreshed}`;
  }

  private kindForFile(file: TFile): string {
    return file.extension.toLowerCase() === "md" ? "markdown" : "blob";
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  private formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 1) return t("duration_less_minute");
    const rounded = Math.ceil(seconds);
    if (rounded < 60) return t("duration_seconds", { count: rounded });
    const minutes = Math.ceil(rounded / 60);
    if (minutes < 60) return t("duration_minutes", { count: minutes });
    const hours = Math.floor(minutes / 60);
    const tailMinutes = minutes % 60;
    return tailMinutes > 0
      ? t("duration_hours_minutes", { hours, minutes: tailMinutes })
      : t("duration_hours", { hours });
  }

  private reportClientSyncEvent(
    api: SyncHttpApi | undefined,
    input: ClientSyncEventInput,
  ): void {
    if (!api) return;
    const runtime = this.clientRuntimeFields();
    void api.reportClientSyncEvent({
      ...runtime,
      ...input,
    }).catch((error) => {
      console.warn("[obsync] client sync event report failed", this.errorMessage(error));
    });
  }

  private clientRuntimeFields(): Pick<ClientSyncEventInput, "platform" | "isMobile"> {
    const userAgent = typeof navigator === "undefined"
      ? ""
      : navigator.userAgent.toLowerCase();
    if (!userAgent) return {};
    if (userAgent.includes("android")) return { platform: "android", isMobile: true };
    if (userAgent.includes("iphone") || userAgent.includes("ipad") || userAgent.includes("ios")) {
      return { platform: "ios", isMobile: true };
    }
    if (userAgent.includes("windows")) return { platform: "windows", isMobile: false };
    if (userAgent.includes("mac os")) return { platform: "macos", isMobile: false };
    if (userAgent.includes("linux")) return { platform: "linux", isMobile: false };
    return {};
  }

  private syncErrorCode(error: unknown): string {
    const message = this.errorMessage(error).toLowerCase();
    if (message.includes("failed to fetch")) return "failed_to_fetch";
    const status = /\((\d{3})\)/.exec(message);
    if (status) return `http_${status[1]}`;
    if (message.includes("timeout") || message.includes("таймаут")) return "timeout";
    if (message.includes("network") || message.includes("connection")) return "network";
    return "sync_error";
  }

  private safeSyncTelemetryMessage(error: unknown): string {
    const code = this.syncErrorCode(error);
    if (code === "failed_to_fetch") return "failed_to_fetch";
    if (code.startsWith("http_")) return code;
    if (code === "timeout") return "timeout";
    if (code === "network") return "network";
    return "sync_error";
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
  }
}

class NoteHistoryModal extends Modal {
  constructor(
    private readonly plugin: ObsyncPlugin,
    private readonly path: string,
    private readonly entries: HistoryEntry[],
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t("history_modal_title") });
    contentEl.createEl("p", { text: this.path });

    if (this.entries.length === 0) {
      contentEl.createEl("p", { text: t("history_modal_empty") });
      return;
    }

    for (const entry of this.entries) {
      const row = contentEl.createDiv();
      row.style.borderTop = "1px solid var(--background-modifier-border)";
      row.style.padding = "10px 0";

      row.createEl("strong", {
        text: `${historyActionLabel(entry)} - ${new Date(entry.createdAt).toLocaleString()}`,
      });
      row.createEl("div", {
        text: t("history_entry_meta", {
          source: entry.source,
          deviceId: entry.deviceId,
          seq: t("history_seq_label", { value: entry.serverSeq }),
        }),
      });
      row.createEl("div", {
        text: historyMeta(entry),
      });

      const actions = row.createDiv();
      actions.style.display = "flex";
      actions.style.gap = "8px";
      actions.style.marginTop = "8px";

      const openButton = actions.createEl("button", { text: t("history_modal_open_version") });
      openButton.disabled = !entry.contentAvailable;
      openButton.onclick = () => {
        void this.plugin.showHistoryVersion(this.path, entry.serverSeq).catch((error) => {
          const message = errorMessage(error);
          new Notice(`${t("notice_prefix")}: ${t("notice_history_failed", { message })}`, 12000);
        });
      };

      const compareButton = actions.createEl("button", { text: t("history_modal_compare") });
      compareButton.disabled = !entry.contentAvailable;
      compareButton.onclick = () => {
        void this.plugin.compareHistoryVersion(this.path, entry.serverSeq).catch((error) => {
          const message = errorMessage(error);
          new Notice(`${t("notice_prefix")}: ${t("notice_diff_failed", { message })}`, 12000);
        });
      };

      if (!entry.contentAvailable) {
        row.createEl("small", {
          text: t("history_modal_missing_content"),
        });
      }
    }
  }
}

class HistoryContentModal extends Modal {
  constructor(
    private readonly plugin: ObsyncPlugin,
    private readonly path: string,
    private readonly serverSeq: number,
    private readonly content: string,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t("history_version_title") });
    contentEl.createEl("p", {
      text: t("history_version_path", {
        path: this.path,
        seq: t("history_seq_label", { value: this.serverSeq }),
      }),
    });
    contentEl.createEl("p", {
      text: t("history_diff_label", {
        path: this.path,
        seq: t("history_seq_label", { value: this.serverSeq }),
      }),
    });
    const pre = contentEl.createEl("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.maxHeight = "60vh";
    pre.style.overflow = "auto";
    pre.setText(this.content);

    const actions = contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.marginTop = "8px";

    const restoreButton = actions.createEl("button", { text: t("history_restore_title") });
    restoreButton.onclick = () => {
      void this.plugin.restoreHistoryVersion(this.path, this.serverSeq).catch((error) => {
        const message = errorMessage(error);
        new Notice(`${t("notice_prefix")}: ${t("notice_restore_failed", { message })}`, 12000);
      });
    };
  }
}

class HistoryDiffModal extends Modal {
  constructor(
    private readonly plugin: ObsyncPlugin,
    private readonly path: string,
    private readonly serverSeq: number,
    private readonly oldContent: string,
    private readonly currentContent: string,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t("history_diff_title") });
    contentEl.createEl("p", {
      text: t("history_diff_to_current", {
        path: this.path,
        seq: t("history_seq_label", { value: this.serverSeq }),
      }),
    });
    const pre = contentEl.createEl("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.maxHeight = "60vh";
    pre.style.overflow = "auto";

    for (const line of diffLines(this.oldContent, this.currentContent)) {
      const span = pre.createEl("span");
      span.setText(`${line.prefix} ${line.text}\n`);
      if (line.prefix === "+") span.style.color = "var(--text-success)";
      if (line.prefix === "-") span.style.color = "var(--text-error)";
    }
  }
}

function historyActionLabel(entry: HistoryEntry): string {
  if (entry.operationType === "file_upsert") return t("history_action_updated");
  if (entry.operationType === "mkdir") return t("history_action_created");
  if (entry.operationType === "delete") return t("history_action_deleted");
  if (entry.operationType === "rename") return t("history_action_renamed", {
    target: entry.targetPath ?? "unknown",
  });
  return entry.operationType;
}

const NORMALIZED_SETTINGS_KEYS: Array<keyof ObsyncSettings> = [
  "enabled",
  "safeMode",
  "consecutiveStartupFailures",
  "lastStartupFailure",
  "lastStartupFailureAt",
  "syncBackend",
  "serverUrl",
  "hostedTenantId",
  "hostedVaultId",
  "hostedSyncBaseUrl",
  "userId",
  "vaultName",
  "vaultLocked",
  "vaultId",
  "deviceLabel",
  "deviceId",
  "deviceName",
  "fileSyncMode",
  "syncAttachments",
  "syncObsidianConfig",
  "deletedServerFilePolicy",
  "maxAttachmentMB",
  "ignoredPatterns",
  "lastCursor",
  "fileIds",
  "lastFileHashes",
  "lastFileSeqs",
  "pendingSeqUpdates",
  "pendingUploads",
  "lastSkippedFiles",
  "lastStorageUsage",
  "lastCompatibility",
  "publishFolder",
  "publishLinks",
];

function normalizedSettingsChanged(before: ObsyncSettings, after: ObsyncSettings): boolean {
  if ("publishMode" in (before as ObsyncSettings & { publishMode?: unknown })) return true;
  return NORMALIZED_SETTINGS_KEYS.some((key) => !Object.is(before[key], after[key]));
}

function historyMeta(entry: HistoryEntry): string {
  const parts = [
    entry.kind,
    entry.hash,
    entry.sizeBytes === undefined ? undefined : `${entry.sizeBytes} B`,
  ].filter(Boolean);
  return parts.join(" / ") || t("history_meta_unknown");
}

function diffLines(
  oldContent: string,
  currentContent: string,
): Array<{ prefix: " " | "+" | "-"; text: string }> {
  const oldLines = oldContent.split(/\r?\n/);
  const newLines = currentContent.split(/\r?\n/);
  if (oldLines.length * newLines.length > 40_000) {
    return [
      { prefix: "-", text: oldContent },
      { prefix: "+", text: currentContent },
    ];
  }

  const table: number[][] = Array.from(
    { length: oldLines.length + 1 },
    () => Array(newLines.length + 1).fill(0),
  );
  for (let left = oldLines.length - 1; left >= 0; left -= 1) {
    for (let right = newLines.length - 1; right >= 0; right -= 1) {
      table[left][right] = oldLines[left] === newLines[right]
        ? table[left + 1][right + 1] + 1
        : Math.max(table[left + 1][right], table[left][right + 1]);
    }
  }

  const result: Array<{ prefix: " " | "+" | "-"; text: string }> = [];
  let left = 0;
  let right = 0;
  while (left < oldLines.length && right < newLines.length) {
    if (oldLines[left] === newLines[right]) {
      result.push({ prefix: " ", text: oldLines[left] });
      left += 1;
      right += 1;
    } else if (table[left + 1][right] >= table[left][right + 1]) {
      result.push({ prefix: "-", text: oldLines[left] });
      left += 1;
    } else {
      result.push({ prefix: "+", text: newLines[right] });
      right += 1;
    }
  }
  while (left < oldLines.length) {
    result.push({ prefix: "-", text: oldLines[left] });
    left += 1;
  }
  while (right < newLines.length) {
    result.push({ prefix: "+", text: newLines[right] });
    right += 1;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
