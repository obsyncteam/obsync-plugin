import type { DataAdapter } from "obsidian";
import type { ObsyncSettings, PendingUploadState } from "../settings";
import {
  OBSYNC_PLUGIN_VERSION,
  OBSYNC_PROTOCOL_VERSION,
  type CompatibilityResponse,
} from "../protocol";
import { sha256Hex } from "../util/hash";
import {
  hostedControlUrl,
  hostedSyncApiBaseUrl,
  issueHostedWsTicket,
  isHostedSync,
  type HostedSyncTicket,
} from "./hosted-auth";
import { validateVaultPath } from "./path-policy";

const DOWNLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const DIRECT_UPLOAD_MAX_BYTES = 1024 * 1024;
const JSON_REQUEST_TIMEOUT_MS = 30_000;
const TRANSFER_REQUEST_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
const HOSTED_UPLOAD_PREPARE_BATCH_SIZE = 32;
const HOSTED_UPLOAD_PREPARE_BODY_MAX_BYTES = 24 * 1024;
const HOSTED_MANIFEST_PAGE_LIMIT = 500;
const TOMBSTONE_PAGE_LIMIT = 1000;
const RETRY_JITTER_RATIO = 0.2;
const MAX_RETRY_AFTER_MS = 120_000;

export interface SyncTransferProgress {
  phase: "hashing" | "upload" | "download" | "finalize" | "retry";
  path: string;
  transferredBytes: number;
  totalBytes: number;
  chunkIndex?: number;
  totalChunks?: number;
  message?: string;
}

interface HostedUploadPrepareInput {
  fileId: string;
  path: string;
  kind: string;
  sizeBytes: number;
  mtimeMs?: number;
  contentType?: string;
  expectedCurrentHash?: string;
  expectedCurrentSeq?: number;
}

export interface ManifestFile {
  vaultId: string;
  fileId: string;
  path: string;
  kind: string;
  hash?: string;
  sizeBytes?: number;
  mtimeMs?: number;
  deletedAt?: string;
  updatedSeq?: number;
  storageKey?: string;
  storageKind?: string;
  contentType?: string;
}

export interface TombstoneRecord {
  vaultId: string;
  fileId: string;
  path: string;
  opId: string;
  deviceId: string;
  deletedSeq?: number;
  deletedAt: string;
}

export interface DownloadedFile {
  body: ArrayBuffer;
  contentType: string;
  kind: string;
  hash?: string;
  sizeBytes?: number;
  mtimeMs?: number;
}

export interface DownloadedFileMetadata {
  contentType: string;
  kind: string;
  hash?: string;
  sizeBytes?: number;
  mtimeMs?: number;
}

export interface UploadedFile {
  vaultId: string;
  fileId: string;
  path: string;
  kind: string;
  hash: string;
  sizeBytes: number;
  mtimeMs?: number;
  operation?: {
    opId: string;
    serverSeq: number;
    deviceId?: string;
    operationType?: string;
    fileId?: string;
    path?: string;
    payload?: Record<string, unknown>;
  };
}

export interface StorageUsage {
  vaultId: string;
  logicalBytes: number;
  physicalBytes: number;
  reservedBytes: number;
  quotaBytes?: number;
}

export type VaultSyncStatusValue = "empty" | "initializing" | "ready" | "error";

export interface VaultSyncStatus {
  vaultId: string;
  status: VaultSyncStatusValue;
  activeDeviceId?: string;
  phase?: string;
  totalFiles?: number;
  processedFiles: number;
  totalBytes?: number;
  processedBytes: number;
  message?: string;
  activeFilesCount: number;
  activeBytes: number;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface ClientSyncEventInput {
  eventType: "sync_started" | "sync_completed" | "sync_failed";
  severity?: "info" | "warning" | "error";
  syncSessionId?: string;
  phase?: string;
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  durationMs?: number;
  filesTotal?: number;
  filesDone?: number;
  bytesTotal?: number;
  bytesDone?: number;
  platform?: string;
  isMobile?: boolean;
}

export interface HistoryEntry {
  serverSeq: number;
  opId: string;
  deviceId: string;
  source: "device" | "rest" | "mcp" | "unknown";
  operationType: string;
  fileId?: string;
  path?: string;
  targetPath?: string;
  kind?: string;
  hash?: string;
  sizeBytes?: number;
  mtimeMs?: number;
  createdAt: string;
  contentAvailable: boolean;
}

export interface HistoryPage {
  file: {
    vaultId: string;
    path: string;
    fileId?: string;
  };
  entries: HistoryEntry[];
  nextCursor?: number;
  hasMore: boolean;
}

export interface HistoryVersion {
  serverSeq: number;
  path: string;
  hash?: string;
  content: string;
}

export interface CreateShareInput {
  sourceType?: "note" | "folder";
  sourcePath: string;
  title?: string;
  includeSourceMd?: boolean;
  includeAttachments?: boolean;
}

export interface CreatedShare {
  id: string;
  sourceType: "note" | "folder";
  sourcePath: string;
  title: string;
  slug: string;
  publicCode: string;
  publicUrl?: string;
  accessType: "secret_link";
  status: string;
}

export interface PublishedShare extends CreatedShare {
  shortUrl?: string;
}

export interface CreateShareResponse {
  ok: true;
  share: PublishedShare;
  created: boolean;
  publicUrl?: string;
  sharePath?: string;
}

export interface ListSharesResponse {
  ok: true;
  shares: PublishedShare[];
}

export interface RevokeShareResponse {
  ok: true;
  share: PublishedShare;
}

interface UploadSessionResponse {
  ok: boolean;
  uploadId: string;
  backend?: "standalone" | "hosted";
  tenantId?: string;
  transferToken?: string;
  status: "uploading" | "finalizing" | "finalized";
  chunkSize: number;
  uploadedChunks: number[];
  finalized?: {
    file: UploadedFile;
    operation?: NonNullable<UploadedFile["operation"]>;
  };
}

interface HostedUploadResponse {
  ok: boolean;
  upload: {
    id: string;
    tenantId: string;
    vaultId: string;
    status: "uploading" | "finalizing" | "finalized";
    chunkSizeBytes: number;
    uploadedChunks: number[];
    finalized?: {
      file: UploadedFile;
      operation?: NonNullable<UploadedFile["operation"]>;
    };
  };
  transferToken?: string;
}

interface HostedUploadBatchResponse {
  ok: boolean;
  uploads: HostedUploadResponse[];
}

interface HostedDownloadSession {
  tenantId: string;
  downloadId: string;
  contentUrl: string;
  transferToken: string;
}

interface HostedAuthContext extends HostedSyncTicket {
  syncSessionToken?: string;
  sessionUsableUntilMs?: number;
}

type HostedAuthMode = "session" | "legacy";

export class SyncHttpApi {
  private hostedSession?: HostedAuthContext;
  private hostedSessionRefresh?: Promise<HostedAuthContext>;
  private hostedLegacyModeUntilMs = 0;

  constructor(
    private readonly getSettings: () => ObsyncSettings,
    private readonly saveSettings: () => Promise<void> = async () => {},
    private readonly onProgress: (progress: SyncTransferProgress) => void = () => {},
  ) {}

  async compatibility(): Promise<CompatibilityResponse> {
    const settings = this.getSettings();
    if (isHostedSync(settings)) {
      const url = new URL(hostedControlUrl(settings.serverUrl, "compat"));
      url.searchParams.set("clientVersion", OBSYNC_PLUGIN_VERSION);
      url.searchParams.set("protocolVersion", String(OBSYNC_PROTOCOL_VERSION));
      return this.requestJson<CompatibilityResponse>(url.toString(), {
        headers: {
          "x-obsync-client-version": OBSYNC_PLUGIN_VERSION,
          "x-obsync-protocol-version": String(OBSYNC_PROTOCOL_VERSION),
        },
      }, false);
    }

    const url = new URL(`${settings.serverUrl}/api/v1/compat`);
    url.searchParams.set("clientVersion", OBSYNC_PLUGIN_VERSION);
    url.searchParams.set("protocolVersion", String(OBSYNC_PROTOCOL_VERSION));

    return this.requestJson<CompatibilityResponse>(this.pathFromUrl(url));
  }

  async reportClientSyncEvent(input: ClientSyncEventInput): Promise<void> {
    const settings = this.getSettings();
    if (!isHostedSync(settings)) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      await fetch(hostedWebControlUrl(settings.serverUrl, "client-events"), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${settings.authToken}`,
          "content-type": "application/json",
          "x-obsync-client-version": OBSYNC_PLUGIN_VERSION,
          "x-obsync-protocol-version": String(OBSYNC_PROTOCOL_VERSION),
        },
        body: JSON.stringify({
          ...input,
          deviceId: safeTelemetryDeviceId(settings.deviceId),
          pluginVersion: OBSYNC_PLUGIN_VERSION,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async ensureVault(): Promise<void> {
    const settings = this.getSettings();
    if (isHostedSync(settings)) {
      await this.hostedAuthContext();
      return;
    }

    await this.requestJson("/api/v1/vaults/ensure", {
      method: "POST",
      body: JSON.stringify({
        vaultId: settings.vaultId,
        name: settings.vaultId,
      }),
    });
  }

  async manifest(): Promise<ManifestFile[]> {
    const settings = this.getSettings();
    if (isHostedSync(settings)) {
      const manifest: ManifestFile[] = [];
      let cursor = "";

      while (true) {
        const result = await this.requestHostedJson<{
          manifest: ManifestFile[];
          nextCursor?: string;
          hasMore?: boolean;
        }>((ticket) => ({
          path: `/sync/tenants/${encodeURIComponent(ticket.sync.tenantId)}/manifest`,
          body: {
            limit: HOSTED_MANIFEST_PAGE_LIMIT,
            cursor: cursor || undefined,
          },
          label: "hosted manifest",
        }));

        manifest.push(...result.manifest);

        if (!result.hasMore || !result.nextCursor || result.nextCursor === cursor) {
          break;
        }

        cursor = result.nextCursor;
      }

      return manifest;
    }

    const manifest: ManifestFile[] = [];
    let cursor = "";

    while (true) {
      const url = new URL(`${settings.serverUrl}/api/v1/manifest`);
      url.searchParams.set("vaultId", settings.vaultId);
      url.searchParams.set("limit", "1000");
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      const result = await this.requestJson<{
        manifest: ManifestFile[];
        nextCursor?: string;
        hasMore?: boolean;
      }>(this.pathFromUrl(url));

      manifest.push(...result.manifest);

      if (!result.hasMore || !result.nextCursor || result.nextCursor === cursor) {
        break;
      }

      cursor = result.nextCursor;
    }

    return manifest;
  }

  async tombstones(input: {
    path?: string;
    fileId?: string;
  } = {}): Promise<TombstoneRecord[] | undefined> {
    const settings = this.getSettings();
    const tombstones: TombstoneRecord[] = [];
    let cursor: number | undefined;

    try {
      while (true) {
        if (isHostedSync(settings)) {
          const result = await this.requestHostedJson<{
            tombstones: TombstoneRecord[];
            nextCursor?: number;
            hasMore?: boolean;
          }>((ticket) => ({
            path: `/sync/tenants/${encodeURIComponent(ticket.sync.tenantId)}/tombstones`,
            body: {
              cursor,
              limit: TOMBSTONE_PAGE_LIMIT,
              path: input.path,
              fileId: input.fileId,
            },
            label: "hosted tombstones",
          }));

          tombstones.push(...result.tombstones);
          if (!result.hasMore || !result.nextCursor || result.nextCursor === cursor) break;
          cursor = result.nextCursor;
          continue;
        }

        const url = new URL(`${settings.serverUrl}/api/v1/tombstones`);
        url.searchParams.set("vaultId", settings.vaultId);
        url.searchParams.set("limit", String(TOMBSTONE_PAGE_LIMIT));
        if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));
        if (input.path) url.searchParams.set("path", input.path);
        if (input.fileId) url.searchParams.set("fileId", input.fileId);

        const result = await this.requestJson<{
          tombstones: TombstoneRecord[];
          nextCursor?: number;
          hasMore?: boolean;
        }>(this.pathFromUrl(url));

        tombstones.push(...result.tombstones);
        if (!result.hasMore || !result.nextCursor || result.nextCursor === cursor) break;
        cursor = result.nextCursor;
      }
    } catch (error) {
      if (isUnsupportedEndpointError(error)) return undefined;
      throw error;
    }

    return tombstones;
  }

  async storageUsage(): Promise<StorageUsage> {
    const settings = this.getSettings();
    if (isHostedSync(settings)) {
      const result = await this.requestHostedJson<{ usage: StorageUsage }>((ticket) => ({
        path: `/sync/tenants/${encodeURIComponent(ticket.sync.tenantId)}/storage/usage`,
        body: {},
        label: "hosted storage usage",
      }));
      return result.usage;
    }

    const url = new URL(`${settings.serverUrl}/api/v1/storage/usage`);
    url.searchParams.set("vaultId", settings.vaultId);

    const result = await this.requestJson<{ usage: StorageUsage }>(this.pathFromUrl(url));
    return result.usage;
  }

  async vaultSyncStatus(): Promise<VaultSyncStatus> {
    const settings = this.getSettings();
    if (isHostedSync(settings)) {
      const result = await this.requestHostedJson<{ status: VaultSyncStatus }>((ticket) => ({
        path: `/sync/tenants/${encodeURIComponent(ticket.sync.tenantId)}/status`,
        body: {},
        label: "hosted status",
      }));
      return result.status;
    }

    return {
      vaultId: settings.vaultId,
      status: "ready",
      processedFiles: 0,
      processedBytes: 0,
      activeFilesCount: 0,
      activeBytes: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  async beginInitialSync(input: { totalFiles?: number; totalBytes?: number }): Promise<VaultSyncStatus> {
    const settings = this.getSettings();
    if (isHostedSync(settings)) {
      const result = await this.requestHostedJson<{ status: VaultSyncStatus }>((ticket) => ({
        path: `/sync/tenants/${encodeURIComponent(ticket.sync.tenantId)}/initial-sync/begin`,
        body: {
          totalFiles: input.totalFiles,
          totalBytes: input.totalBytes,
        },
        label: "hosted initial sync begin",
      }));
      return result.status;
    }
    return this.vaultSyncStatus();
  }

  async completeInitialSync(): Promise<VaultSyncStatus> {
    const settings = this.getSettings();
    if (isHostedSync(settings)) {
      const result = await this.requestHostedJson<{ status: VaultSyncStatus }>((ticket) => ({
        path: `/sync/tenants/${encodeURIComponent(ticket.sync.tenantId)}/initial-sync/complete`,
        body: {},
        label: "hosted initial sync complete",
      }));
      return result.status;
    }
    return this.vaultSyncStatus();
  }

  async history(path: string, limit = 30): Promise<HistoryPage> {
    const validPath = this.validPath(path);
    const settings = this.getSettings();
    if (isHostedSync(settings)) {
      const result = await this.requestHostedJson<HistoryPage & { ok: true }>((ticket) => ({
        path: `/sync/tenants/${encodeURIComponent(ticket.sync.tenantId)}/history`,
        body: {
          path: validPath,
          limit,
        },
        label: `hosted history ${validPath}`,
      }));
      return result;
    }

    const url = new URL(`${settings.serverUrl}/api/v1/history`);
    url.searchParams.set("vaultId", settings.vaultId);
    url.searchParams.set("path", validPath);
    url.searchParams.set("limit", String(limit));
    const result = await this.requestJson<HistoryPage & { ok: true }>(this.pathFromUrl(url));
    return result;
  }

  async historyVersion(path: string, serverSeq: number): Promise<HistoryVersion> {
    const validPath = this.validPath(path);
    const settings = this.getSettings();
    if (isHostedSync(settings)) {
      const result = await this.requestHostedJson<{ version: HistoryVersion }>((ticket) => ({
        path: `/sync/tenants/${encodeURIComponent(ticket.sync.tenantId)}/history/content`,
        body: {
          path: validPath,
          serverSeq,
        },
        label: `hosted history content ${validPath}`,
      }));
      return result.version;
    }

    const url = new URL(`${settings.serverUrl}/api/v1/history/content`);
    url.searchParams.set("vaultId", settings.vaultId);
    url.searchParams.set("path", validPath);
    url.searchParams.set("serverSeq", String(serverSeq));
    const result = await this.requestJson<{ version: HistoryVersion }>(this.pathFromUrl(url));
    return result.version;
  }

  async createNoteShare(input: Omit<CreateShareInput, "sourceType">): Promise<CreateShareResponse> {
    return this.createShare({
      ...input,
      sourceType: "note",
    });
  }

  async publishSite(input: Omit<CreateShareInput, "sourceType">): Promise<CreateShareResponse> {
    return this.createShare({
      ...input,
      sourceType: "folder",
    });
  }

  async listShares(): Promise<ListSharesResponse> {
    if (!isHostedSync(this.getSettings())) {
      throw new Error("публикация доступна только в готовом сервисе");
    }

    return this.requestJson<ListSharesResponse>("/api/web/control/sync/shares", {
      method: "GET",
    });
  }

  async revokeShare(input: Pick<CreateShareInput, "sourceType" | "sourcePath">): Promise<RevokeShareResponse> {
    if (!isHostedSync(this.getSettings())) {
      throw new Error("публикация доступна только в готовом сервисе");
    }

    return this.requestJson<RevokeShareResponse>("/api/web/control/sync/shares", {
      method: "DELETE",
      body: JSON.stringify({
        sourceType: input.sourceType ?? "note",
        sourcePath: this.validPath(input.sourcePath),
      }),
    });
  }

  private async createShare(input: CreateShareInput): Promise<CreateShareResponse> {
    if (!isHostedSync(this.getSettings())) {
      throw new Error("публикация доступна только в готовом сервисе");
    }

    return this.requestJson<CreateShareResponse>("/api/web/control/sync/shares", {
      method: "POST",
      body: JSON.stringify({
        sourceType: input.sourceType ?? "note",
        sourcePath: this.validPath(input.sourcePath),
        title: input.title,
        includeSourceMd: input.includeSourceMd,
        includeAttachments: input.includeAttachments,
      }),
    });
  }

  async uploadFile(input: {
    fileId: string;
    path: string;
    kind: string;
    body: ArrayBuffer;
    mtimeMs?: number;
    contentType?: string;
    expectedCurrentHash?: string;
    expectedCurrentSeq?: number;
  }): Promise<UploadedFile> {
    const settings = this.getSettings();
    const path = this.validPath(input.path);
    let expectedHash: string | undefined;
    if (isHostedSync(settings)) {
      this.onProgress({
        phase: "upload",
        path,
        transferredBytes: 0,
        totalBytes: input.body.byteLength,
      });
    } else {
      this.onProgress({
        phase: "hashing",
        path,
        transferredBytes: 0,
        totalBytes: input.body.byteLength,
      });
      expectedHash = `sha256:${await sha256Hex(input.body)}`;
    }
    if (isHostedSync(settings) && !settings.hostedTenantId) {
      await this.hostedAuthContext();
    }
    if (!isHostedSync(settings) && input.body.byteLength <= DIRECT_UPLOAD_MAX_BYTES) {
      return this.uploadFileDirect({
        ...input,
        path,
        expectedHash: expectedHash ?? "",
      });
    }

    const uploadKey = this.uploadKey(settings.syncBackend, settings.vaultId, path);
    const pending = await this.resumeOrCreateUpload({
      path,
      fileId: input.fileId,
      kind: input.kind,
      body: input.body,
      mtimeMs: input.mtimeMs,
      contentType: input.contentType,
      expectedHash,
      expectedCurrentHash: input.expectedCurrentHash,
      expectedCurrentSeq: input.expectedCurrentSeq,
      uploadKey,
    });
    const status = await this.uploadStatus(pending.uploadId, pending);
    const uploadedChunks = new Set(status.uploadedChunks);
    const chunkSize = status.chunkSize || pending.chunkSize;
    const totalChunks = Math.ceil(input.body.byteLength / chunkSize);
    let uploadedBytes = 0;

    for (const chunkIndex of uploadedChunks) {
      uploadedBytes += expectedChunkSize(input.body.byteLength, chunkSize, chunkIndex);
    }

    this.onProgress({
      phase: "upload",
      path,
      transferredBytes: Math.min(uploadedBytes, input.body.byteLength),
      totalBytes: input.body.byteLength,
      totalChunks,
    });

    for (let index = 0; index < totalChunks; index += 1) {
      if (uploadedChunks.has(index)) continue;

      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, input.body.byteLength);
      await this.uploadChunk({
        uploadId: pending.uploadId,
        pending,
        chunkIndex: index,
        body: input.body.slice(start, end),
        contentType: input.contentType,
      });

      uploadedBytes += end - start;
      this.onProgress({
        phase: "upload",
        path,
        transferredBytes: Math.min(uploadedBytes, input.body.byteLength),
        totalBytes: input.body.byteLength,
        chunkIndex: index + 1,
        totalChunks,
      });

      pending.updatedAt = Date.now();
      settings.pendingUploads[uploadKey] = pending;
      await this.saveSettings();
    }

    this.onProgress({
      phase: "finalize",
      path,
      transferredBytes: input.body.byteLength,
      totalBytes: input.body.byteLength,
      totalChunks,
    });
    const result = await this.finalizeUpload(pending.uploadId, expectedHash, pending);
    delete settings.pendingUploads[uploadKey];
    await this.saveSettings();
    return {
      ...result.file,
      operation: result.operation,
    };
  }

  async prepareHostedUploads(inputs: HostedUploadPrepareInput[]): Promise<void> {
    const settings = this.getSettings();
    if (!isHostedSync(settings) || inputs.length === 0) return;
    if (!settings.hostedTenantId) {
      await this.hostedAuthContext();
    }

    const pendingInputs = inputs.filter((input) => {
      const path = this.validPath(input.path);
      const uploadKey = this.uploadKey(settings.syncBackend, settings.vaultId, path);
      const existing = settings.pendingUploads[uploadKey];
      return !this.pendingUploadMatches(existing, {
        path,
        fileId: input.fileId,
        kind: input.kind,
        sizeBytes: input.sizeBytes,
        mtimeMs: input.mtimeMs,
        expectedHash: undefined,
        expectedCurrentHash: input.expectedCurrentHash,
        expectedCurrentSeq: input.expectedCurrentSeq,
        deviceId: settings.deviceId,
      });
    });

    let offset = 0;
    while (offset < pendingInputs.length) {
      const batch: HostedUploadPrepareInput[] = [];
      const filesPayload: Array<Record<string, unknown>> = [];

      while (offset < pendingInputs.length && batch.length < HOSTED_UPLOAD_PREPARE_BATCH_SIZE) {
        const input = pendingInputs[offset];
        const filePayload = this.hostedUploadBatchFile(input);
        const nextFiles = [...filesPayload, filePayload];
        const bodyBytes = jsonBodyBytes({
          syncSessionToken: "",
          files: nextFiles,
        });

        if (filesPayload.length > 0 && bodyBytes > HOSTED_UPLOAD_PREPARE_BODY_MAX_BYTES) {
          break;
        }
        if (bodyBytes > HOSTED_UPLOAD_PREPARE_BODY_MAX_BYTES) {
          throw new Error(`путь файла слишком длинный для подготовки синхронизации: ${input.path}`);
        }

        batch.push(input);
        filesPayload.push(filePayload);
        offset += 1;
      }

      const result = await this.requestHostedJson<HostedUploadBatchResponse>((ticket) => ({
        path: `/sync/tenants/${encodeURIComponent(ticket.sync.tenantId)}/uploads/batch`,
        body: {
          files: filesPayload,
        },
        label: "hosted upload batch",
      }));
      if (result.uploads.length !== batch.length) {
        throw new Error("сервер вернул неполный список сессий синхронизации");
      }

      result.uploads.forEach((upload, index) => {
        const input = batch[index];
        const path = this.validPath(input.path);
        const response = this.hostedUploadResponse(upload);
        const uploadKey = this.uploadKey(settings.syncBackend, settings.vaultId, path);
        settings.pendingUploads[uploadKey] = {
          uploadId: response.uploadId,
          backend: "hosted",
          tenantId: response.tenantId,
          transferToken: response.transferToken,
          vaultId: settings.vaultId,
          path,
          fileId: input.fileId,
          kind: input.kind,
          sizeBytes: input.sizeBytes,
          mtimeMs: input.mtimeMs,
          expectedCurrentHash: input.expectedCurrentHash,
          expectedCurrentSeq: input.expectedCurrentSeq,
          deviceId: settings.deviceId,
          chunkSize: response.chunkSize,
          updatedAt: Date.now(),
        };
      });
      await this.saveSettings();
    }
  }

  private hostedUploadBatchFile(input: HostedUploadPrepareInput): Record<string, unknown> {
    return {
      fileId: input.fileId,
      path: this.validPath(input.path),
      kind: input.kind,
      sizeBytes: input.sizeBytes,
      mtimeMs: input.mtimeMs,
      contentType: input.contentType,
      expectedCurrentHash: input.expectedCurrentHash,
      expectedCurrentSeq: input.expectedCurrentSeq,
      chunkSizeBytes: DOWNLOAD_CHUNK_SIZE,
    };
  }

  async downloadFile(path: string, expectedSizeBytes?: number): Promise<DownloadedFile> {
    const validPath = this.validPath(path);
    if (isHostedSync(this.getSettings())) {
      const hostedDownload = await this.createHostedDownload(validPath);
      if (expectedSizeBytes && expectedSizeBytes > DOWNLOAD_CHUNK_SIZE) {
        return this.downloadFileInRanges(validPath, expectedSizeBytes, hostedDownload);
      }

      const response = await this.fetchHostedDownloadContent(hostedDownload);
      if (!response.ok) {
        throw new Error(`скачивание не выполнено (${response.status}): ${await response.text()}`);
      }

      const body = await response.arrayBuffer();
      const hash = response.headers.get("x-obsync-hash") ?? undefined;
      if (hash) {
        await assertSha256(body, hash, validPath);
      }
      this.onProgress({
        phase: "download",
        path: validPath,
        transferredBytes: body.byteLength,
        totalBytes: expectedSizeBytes ?? body.byteLength,
      });

      return {
        body,
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        kind: response.headers.get("x-obsync-kind") ?? "blob",
        hash,
        sizeBytes: optionalNumber(response.headers.get("x-obsync-size-bytes")),
        mtimeMs: optionalNumber(response.headers.get("x-obsync-mtime-ms")),
      };
    }

    if (expectedSizeBytes && expectedSizeBytes > DOWNLOAD_CHUNK_SIZE) {
      return this.downloadFileInRanges(validPath, expectedSizeBytes);
    }

    const settings = this.getSettings();
    const url = new URL(`${settings.serverUrl}/api/v1/files/content`);
    url.searchParams.set("vaultId", settings.vaultId);
    url.searchParams.set("path", validPath);

    const response = await this.fetchWithRetry(
      url.toString(),
      {
        headers: {
          authorization: `Bearer ${settings.authToken}`,
        },
      },
      {
        label: `download ${validPath}`,
        timeoutMs: TRANSFER_REQUEST_TIMEOUT_MS,
      },
    );

    if (!response.ok) {
      throw new Error(`скачивание не выполнено (${response.status}): ${await response.text()}`);
    }

    const body = await response.arrayBuffer();
    const hash = response.headers.get("x-obsync-hash") ?? undefined;
    if (hash) {
      await assertSha256(body, hash, validPath);
    }
    this.onProgress({
      phase: "download",
      path: validPath,
      transferredBytes: body.byteLength,
      totalBytes: expectedSizeBytes ?? body.byteLength,
    });

    return {
      body,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      kind: response.headers.get("x-obsync-kind") ?? "blob",
      hash,
      sizeBytes: optionalNumber(response.headers.get("x-obsync-size-bytes")),
      mtimeMs: optionalNumber(response.headers.get("x-obsync-mtime-ms")),
    };
  }

  async downloadFileToAdapter(input: {
    path: string;
    expectedSizeBytes: number;
    expectedHash?: string;
    adapter: DataAdapter;
    tempPath: string;
    targetPath: string;
    beforeCommit?: () => void;
  }): Promise<DownloadedFileMetadata> {
    const validPath = this.validPath(input.path);
    const adapter = input.adapter;
    if (!canStageBinaryDownload(adapter)) {
      throw new Error("этот адаптер Obsidian не поддерживает безопасную поэтапную запись файла");
    }

    await ensureAdapterFolder(adapter, parentPath(input.tempPath));
    await removeIfExists(adapter, input.tempPath);
    await adapter.writeBinary(input.tempPath, new ArrayBuffer(0));

    let contentType = "application/octet-stream";
    let kind = "blob";
    let hash: string | undefined;
    let mtimeMs: number | undefined;
    const totalChunks = Math.ceil(input.expectedSizeBytes / DOWNLOAD_CHUNK_SIZE);
    const hostedDownload = isHostedSync(this.getSettings())
      ? await this.createHostedDownload(validPath)
      : undefined;

    try {
      for (
        let start = 0, chunkIndex = 0;
        start < input.expectedSizeBytes;
        start += DOWNLOAD_CHUNK_SIZE, chunkIndex += 1
      ) {
        const end = Math.min(start + DOWNLOAD_CHUNK_SIZE, input.expectedSizeBytes) - 1;
        const chunk = await this.downloadRange(validPath, start, end, hostedDownload);

        await adapter.appendBinary(input.tempPath, chunk.body);
        contentType = chunk.contentType;
        kind = chunk.kind;
        hash = chunk.hash ?? hash;
        mtimeMs = chunk.mtimeMs ?? mtimeMs;
        this.onProgress({
          phase: "download",
          path: validPath,
          transferredBytes: end + 1,
          totalBytes: input.expectedSizeBytes,
          chunkIndex: chunkIndex + 1,
          totalChunks,
        });
      }

      const stat = await adapter.stat(input.tempPath);
      if (!stat || stat.size !== input.expectedSizeBytes) {
        throw new Error("размер скачанного файла не совпал с ожидаемым");
      }
      if (input.expectedHash && hash !== input.expectedHash) {
        throw new Error(`скачанная версия файла не совпала с ожидаемой: ${validPath}`);
      }

      input.beforeCommit?.();
      await renameReplacing(adapter, input.tempPath, input.targetPath);

      return {
        contentType,
        kind,
        hash,
        sizeBytes: input.expectedSizeBytes,
        mtimeMs,
      };
    } catch (error) {
      await removeIfExists(adapter, input.tempPath);
      throw error;
    }
  }

  private async requestJson<T = unknown>(
    path: string,
    init: RequestInit = {},
    includeAuth = true,
  ): Promise<T> {
    const settings = this.getSettings();
    const isAbsoluteUrl = /^https?:\/\//i.test(path);
    const baseUrl = isHostedSync(settings) && path.startsWith("/sync/tenants/")
      ? this.hostedSyncBaseUrl()
      : settings.serverUrl;
    const requestUrl = isAbsoluteUrl ? path : `${baseUrl}${path}`;
    const response = await this.fetchWithRetry(
      requestUrl,
      {
        ...init,
        headers: {
          ...(includeAuth ? { authorization: `Bearer ${settings.authToken}` } : {}),
          "content-type": "application/json",
          "x-obsync-client-version": OBSYNC_PLUGIN_VERSION,
          "x-obsync-protocol-version": String(OBSYNC_PROTOCOL_VERSION),
          ...init.headers,
        },
      },
      {
        label: path,
        timeoutMs: JSON_REQUEST_TIMEOUT_MS,
      },
    );

    if (!response.ok) {
      throw new Error(`запрос не выполнен (${response.status}): ${await response.text()}`);
    }

    return (await response.json()) as T;
  }

  private async requestHostedJson<T = unknown>(
    buildRequest: (auth: HostedAuthContext) => {
      path: string;
      body: unknown;
      label: string;
    },
  ): Promise<T> {
    let lastError: unknown;
    let forceRefresh = false;
    let retriedSessionRefresh = false;
    let legacyRetryForCurrentRequest = false;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const legacyMode = legacyRetryForCurrentRequest || Date.now() < this.hostedLegacyModeUntilMs;
      const auth = await this.hostedAuthContext({
        forceRefresh,
        freshTicket: legacyMode,
      });
      forceRefresh = false;
      const request = buildRequest(auth);
      const requestUrl = `${hostedSyncApiBaseUrl(auth.sync.syncBaseUrl)}${request.path}`;
      const authMode: HostedAuthMode = auth.syncSessionToken && !legacyMode ? "session" : "legacy";

      let response: Response;
      try {
        response = await this.fetchOnce(
          requestUrl,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-obsync-client-version": OBSYNC_PLUGIN_VERSION,
              "x-obsync-protocol-version": String(OBSYNC_PROTOCOL_VERSION),
            },
            body: JSON.stringify(this.hostedRequestBody(request.body, auth, authMode)),
          },
          JSON_REQUEST_TIMEOUT_MS,
        );
      } catch (error) {
        lastError = error;
        if (!isRetryableFetchError(error) || attempt >= RETRY_DELAYS_MS.length) {
          break;
        }
        await this.waitBeforeRetry({ label: request.label }, attempt, readableFetchError(error));
        continue;
      }

      if (response.ok) {
        return (await response.json()) as T;
      }

      const bodyText = response.status === 400 || response.status === 401 || !isRetryableStatus(response.status)
        ? await response.text()
        : undefined;
      const sessionExpired = authMode === "session" &&
        response.status === 401 &&
        isHostedSessionError(bodyText ?? "");
      const legacyRequired = authMode === "session" &&
        !legacyRetryForCurrentRequest &&
        (response.status === 400 || response.status === 401) &&
        isHostedLegacyTicketRequiredError(bodyText ?? "");
      const ticketExpired = authMode === "legacy" &&
        response.status === 401 &&
        isHostedTicketError(bodyText ?? "");

      if (legacyRequired) {
        this.hostedLegacyModeUntilMs = Date.now() + 60_000;
        legacyRetryForCurrentRequest = true;
        continue;
      }

      if (sessionExpired && !retriedSessionRefresh && attempt < RETRY_DELAYS_MS.length) {
        this.hostedSession = undefined;
        forceRefresh = true;
        retriedSessionRefresh = true;
        await this.waitBeforeRetry(
          { label: request.label },
          attempt,
          "сервер отклонил сессию синхронизации",
          0,
        );
        continue;
      }

      const retryAllowed = attempt < RETRY_DELAYS_MS.length &&
        (isRetryableStatus(response.status) || (ticketExpired && attempt === 0));

      if (retryAllowed) {
        await this.waitBeforeRetry(
          { label: request.label },
          attempt,
          ticketExpired ? "сервер отклонил одноразовый билет" : `сервер ответил ${response.status}`,
          ticketExpired ? undefined : retryAfterMs(response.headers),
        );
        continue;
      }

      throw new Error(
        `запрос не выполнен (${response.status}): ${bodyText ?? await response.text()}`,
      );
    }

    throw new Error(
      `соединение оборвалось после ${RETRY_DELAYS_MS.length + 1} попыток: ${readableFetchError(lastError)}`,
    );
  }

  private pathFromUrl(url: URL): string {
    return `${url.pathname}${url.search}`;
  }

  private async resumeOrCreateUpload(input: {
    path: string;
    fileId: string;
    kind: string;
    body: ArrayBuffer;
    mtimeMs?: number;
    contentType?: string;
    expectedHash?: string;
    expectedCurrentHash?: string;
    expectedCurrentSeq?: number;
    uploadKey: string;
  }): Promise<PendingUploadState> {
    const settings = this.getSettings();
    const existing = settings.pendingUploads[input.uploadKey];
    const backend = settings.syncBackend;

    if (this.pendingUploadMatches(existing, {
      path: input.path,
      fileId: input.fileId,
      kind: input.kind,
      sizeBytes: input.body.byteLength,
      mtimeMs: input.mtimeMs,
      expectedHash: input.expectedHash,
      expectedCurrentHash: input.expectedCurrentHash,
      expectedCurrentSeq: input.expectedCurrentSeq,
      deviceId: settings.deviceId,
    })) {
      try {
        await this.uploadStatus(existing.uploadId, existing);
        return existing;
      } catch {
        delete settings.pendingUploads[input.uploadKey];
        await this.saveSettings();
      }
    }

    const session = await this.createUpload({
      path: input.path,
      fileId: input.fileId,
      kind: input.kind,
      sizeBytes: input.body.byteLength,
      mtimeMs: input.mtimeMs,
      contentType: input.contentType,
      expectedHash: input.expectedHash,
      expectedCurrentHash: input.expectedCurrentHash,
      expectedCurrentSeq: input.expectedCurrentSeq,
    });
    const pending: PendingUploadState = {
      uploadId: session.uploadId,
      backend,
      tenantId: session.tenantId,
      transferToken: session.transferToken,
      vaultId: settings.vaultId,
      path: input.path,
      fileId: input.fileId,
      kind: input.kind,
      sizeBytes: input.body.byteLength,
      mtimeMs: input.mtimeMs,
      expectedHash: input.expectedHash,
      expectedCurrentHash: input.expectedCurrentHash,
      expectedCurrentSeq: input.expectedCurrentSeq,
      deviceId: settings.deviceId,
      chunkSize: session.chunkSize,
      updatedAt: Date.now(),
    };
    settings.pendingUploads[input.uploadKey] = pending;
    await this.saveSettings();
    return pending;
  }

  private pendingUploadMatches(
    existing: PendingUploadState | undefined,
    input: {
      path: string;
      fileId: string;
      kind: string;
      sizeBytes: number;
      mtimeMs?: number;
      expectedHash?: string;
      expectedCurrentHash?: string;
      expectedCurrentSeq?: number;
      deviceId?: string;
    },
  ): existing is PendingUploadState {
    return Boolean(
      existing &&
      (existing.backend ?? "standalone") === this.getSettings().syncBackend &&
      existing.vaultId === this.getSettings().vaultId &&
      Boolean(existing.deviceId) &&
      existing.deviceId === input.deviceId &&
      existing.path === input.path &&
      existing.fileId === input.fileId &&
      existing.kind === input.kind &&
      existing.sizeBytes === input.sizeBytes &&
      existing.mtimeMs === input.mtimeMs &&
      existing.expectedHash === input.expectedHash &&
      existing.expectedCurrentHash === input.expectedCurrentHash &&
      existing.expectedCurrentSeq === input.expectedCurrentSeq,
    );
  }

  private async createUpload(input: {
    path: string;
    fileId: string;
    kind: string;
    sizeBytes: number;
    mtimeMs?: number;
    contentType?: string;
    expectedHash?: string;
    expectedCurrentHash?: string;
    expectedCurrentSeq?: number;
  }): Promise<UploadSessionResponse> {
    const settings = this.getSettings();
    if (isHostedSync(settings)) {
      const result = await this.requestHostedJson<HostedUploadResponse>((ticket) => ({
        path: `/sync/tenants/${encodeURIComponent(ticket.sync.tenantId)}/uploads`,
        body: {
          fileId: input.fileId,
          path: input.path,
          kind: input.kind,
          sizeBytes: input.sizeBytes,
          mtimeMs: input.mtimeMs,
          contentType: input.contentType,
          expectedHash: input.expectedHash,
          expectedCurrentHash: input.expectedCurrentHash,
          expectedCurrentSeq: input.expectedCurrentSeq,
          chunkSizeBytes: DOWNLOAD_CHUNK_SIZE,
        },
        label: `hosted create upload ${input.path}`,
      }));
      return this.hostedUploadResponse(result);
    }

    return this.requestJson<UploadSessionResponse>("/api/v1/uploads", {
      method: "POST",
      body: JSON.stringify({
        vaultId: settings.vaultId,
        deviceId: settings.deviceId,
        fileId: input.fileId,
        path: input.path,
        kind: input.kind,
        sizeBytes: input.sizeBytes,
        mtimeMs: input.mtimeMs,
        contentType: input.contentType,
        expectedHash: input.expectedHash,
        expectedCurrentHash: input.expectedCurrentHash,
        expectedCurrentSeq: input.expectedCurrentSeq,
      }),
    });
  }

  private async uploadStatus(
    uploadId: string,
    pending?: PendingUploadState,
  ): Promise<UploadSessionResponse> {
    if (isHostedSync(this.getSettings())) {
      const hosted = this.requireHostedPending(pending);
      const response = await this.fetchWithRetry(
        `${this.hostedSyncBaseUrl()}/sync/tenants/${encodeURIComponent(hosted.tenantId)}/uploads/${encodeURIComponent(uploadId)}`,
        {
          headers: {
            authorization: `Bearer ${hosted.transferToken}`,
          },
        },
        {
          label: `upload status ${uploadId}`,
          timeoutMs: JSON_REQUEST_TIMEOUT_MS,
        },
      );
      if (!response.ok) {
        throw new Error(`проверка сессии не выполнена (${response.status}): ${await response.text()}`);
      }
      return this.hostedUploadResponse(
        (await response.json()) as HostedUploadResponse,
        hosted.transferToken,
      );
    }

    return this.requestJson<UploadSessionResponse>(
      `/api/v1/uploads/${encodeURIComponent(uploadId)}`,
    );
  }

  private async uploadChunk(input: {
    uploadId: string;
    pending?: PendingUploadState;
    chunkIndex: number;
    body: ArrayBuffer;
    contentType?: string;
  }): Promise<void> {
    const settings = this.getSettings();
    if (isHostedSync(settings)) {
      const hosted = this.requireHostedPending(input.pending);
      const response = await this.fetchWithRetry(
        `${this.hostedSyncBaseUrl()}/sync/tenants/${encodeURIComponent(hosted.tenantId)}/uploads/${encodeURIComponent(input.uploadId)}/chunks/${input.chunkIndex}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${hosted.transferToken}`,
            "content-type": input.contentType ?? "application/octet-stream",
          },
          body: input.body,
        },
        {
          label: `upload chunk ${input.chunkIndex}`,
          timeoutMs: TRANSFER_REQUEST_TIMEOUT_MS,
        },
      );

      if (!response.ok) {
        throw new Error(`передача части файла не выполнена (${response.status}): ${await response.text()}`);
      }
      return;
    }

    const response = await this.fetchWithRetry(
      `${settings.serverUrl}/api/v1/uploads/${encodeURIComponent(input.uploadId)}/chunks/${input.chunkIndex}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${settings.authToken}`,
          "content-type": input.contentType ?? "application/octet-stream",
        },
        body: input.body,
      },
      {
        label: `upload chunk ${input.chunkIndex}`,
        timeoutMs: TRANSFER_REQUEST_TIMEOUT_MS,
      },
    );

    if (!response.ok) {
      throw new Error(`передача части файла не выполнена (${response.status}): ${await response.text()}`);
    }
  }

  private async finalizeUpload(
    uploadId: string,
    expectedHash: string | undefined,
    pending?: PendingUploadState,
  ): Promise<{
    file: UploadedFile;
    operation: { opId: string; serverSeq: number };
  }> {
    if (isHostedSync(this.getSettings())) {
      const hosted = this.requireHostedPending(pending);
      const response = await this.fetchWithRetry(
        `${this.hostedSyncBaseUrl()}/sync/tenants/${encodeURIComponent(hosted.tenantId)}/uploads/${encodeURIComponent(uploadId)}/finalize`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${hosted.transferToken}`,
            "content-type": "application/json",
          },
        },
        {
          label: `finalize upload ${uploadId}`,
          timeoutMs: JSON_REQUEST_TIMEOUT_MS,
        },
      );
      if (!response.ok) {
        throw new Error(`завершение инициализации не выполнено (${response.status}): ${await response.text()}`);
      }
      const result = await response.json() as {
        file: UploadedFile;
        operation: { opId: string; serverSeq: number };
      };
      return result;
    }

    if (!expectedHash) {
      throw new Error("нет контрольной суммы для завершения передачи");
    }

    return this.requestJson<{
      file: UploadedFile;
      operation: { opId: string; serverSeq: number };
    }>(
      `/api/v1/uploads/${encodeURIComponent(uploadId)}/finalize`,
      {
        method: "POST",
        body: JSON.stringify({ expectedHash }),
      },
    );
  }

  private uploadKey(backend: string, vaultId: string, path: string): string {
    return `${backend}:${vaultId}:${path}`;
  }

  private async uploadFileDirect(input: {
    fileId: string;
    path: string;
    kind: string;
    body: ArrayBuffer;
    mtimeMs?: number;
    contentType?: string;
    expectedHash: string;
    expectedCurrentHash?: string;
    expectedCurrentSeq?: number;
  }): Promise<UploadedFile> {
    const settings = this.getSettings();
    const url = new URL(`${settings.serverUrl}/api/v1/files/content`);
    url.searchParams.set("vaultId", settings.vaultId);
    url.searchParams.set("deviceId", settings.deviceId);
    url.searchParams.set("fileId", input.fileId);
    url.searchParams.set("path", input.path);
    url.searchParams.set("kind", input.kind);
    if (input.mtimeMs !== undefined) {
      url.searchParams.set("mtimeMs", String(input.mtimeMs));
    }
    if (input.expectedCurrentHash) {
      url.searchParams.set("expectedCurrentHash", input.expectedCurrentHash);
    }
    if (input.expectedCurrentSeq !== undefined) {
      url.searchParams.set("expectedCurrentSeq", String(input.expectedCurrentSeq));
    }

    this.onProgress({
      phase: "upload",
      path: input.path,
      transferredBytes: 0,
      totalBytes: input.body.byteLength,
    });

    const response = await this.fetchWithRetry(
      url.toString(),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${settings.authToken}`,
          "content-type": input.contentType ?? "application/octet-stream",
          "x-obsync-client-version": OBSYNC_PLUGIN_VERSION,
          "x-obsync-protocol-version": String(OBSYNC_PROTOCOL_VERSION),
        },
        body: input.body,
      },
      {
        label: `direct upload ${input.path}`,
        timeoutMs: TRANSFER_REQUEST_TIMEOUT_MS,
      },
    );

    if (!response.ok) {
      throw new Error(`инициализация файла не выполнена (${response.status}): ${await response.text()}`);
    }

    const result = await response.json() as {
      file: UploadedFile;
      operation?: NonNullable<UploadedFile["operation"]>;
    };
    if (result.file.hash !== input.expectedHash) {
      throw new Error(`контрольная сумма файла не совпала: ${input.path}`);
    }

    this.onProgress({
      phase: "upload",
      path: input.path,
      transferredBytes: input.body.byteLength,
      totalBytes: input.body.byteLength,
    });

    return {
      ...result.file,
      operation: result.operation,
    };
  }

  private async downloadFileInRanges(
    path: string,
    sizeBytes: number,
    hostedDownload?: HostedDownloadSession,
  ): Promise<DownloadedFile> {
    const target = new Uint8Array(sizeBytes);
    let contentType = "application/octet-stream";
    let kind = "blob";
    let hash: string | undefined;
    let mtimeMs: number | undefined;
    const totalChunks = Math.ceil(sizeBytes / DOWNLOAD_CHUNK_SIZE);

    for (
      let start = 0, chunkIndex = 0;
      start < sizeBytes;
      start += DOWNLOAD_CHUNK_SIZE, chunkIndex += 1
    ) {
      const end = Math.min(start + DOWNLOAD_CHUNK_SIZE, sizeBytes) - 1;
      const chunk = await this.downloadRange(path, start, end, hostedDownload);

      target.set(new Uint8Array(chunk.body), start);
      contentType = chunk.contentType;
      kind = chunk.kind;
      hash = chunk.hash ?? hash;
      mtimeMs = chunk.mtimeMs ?? mtimeMs;
      this.onProgress({
        phase: "download",
        path,
        transferredBytes: end + 1,
        totalBytes: sizeBytes,
        chunkIndex: chunkIndex + 1,
        totalChunks,
      });
    }

    if (hash) {
      await assertSha256(target.buffer, hash, path);
    }

    return {
      body: target.buffer,
      contentType,
      kind,
      hash,
      sizeBytes,
      mtimeMs,
    };
  }

  private async downloadRange(
    path: string,
    start: number,
    end: number,
    hostedDownload?: HostedDownloadSession,
  ): Promise<DownloadedFile> {
    const settings = this.getSettings();
    const validPath = this.validPath(path);
    if (isHostedSync(settings)) {
      const activeDownload = hostedDownload ?? await this.createHostedDownload(validPath);
      const response = await this.fetchHostedDownloadContent(
        activeDownload,
        `bytes=${start}-${end}`,
      );

      if (response.status !== 206) {
        throw new Error(`скачивание части файла не выполнено (${response.status}): ${await response.text()}`);
      }

      return {
        body: await response.arrayBuffer(),
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        kind: response.headers.get("x-obsync-kind") ?? "blob",
        hash: response.headers.get("x-obsync-hash") ?? undefined,
        sizeBytes: optionalNumber(response.headers.get("x-obsync-size-bytes")),
        mtimeMs: optionalNumber(response.headers.get("x-obsync-mtime-ms")),
      };
    }

    const url = new URL(`${settings.serverUrl}/api/v1/files/content`);
    url.searchParams.set("vaultId", settings.vaultId);
    url.searchParams.set("path", validPath);

    const response = await this.fetchWithRetry(
      url.toString(),
      {
        headers: {
          authorization: `Bearer ${settings.authToken}`,
          range: `bytes=${start}-${end}`,
        },
      },
      {
        label: `range download ${validPath}`,
        timeoutMs: TRANSFER_REQUEST_TIMEOUT_MS,
      },
    );

    if (response.status !== 206) {
      throw new Error(`скачивание части файла не выполнено (${response.status}): ${await response.text()}`);
    }

    return {
      body: await response.arrayBuffer(),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      kind: response.headers.get("x-obsync-kind") ?? "blob",
      hash: response.headers.get("x-obsync-hash") ?? undefined,
      sizeBytes: optionalNumber(response.headers.get("x-obsync-size-bytes")),
      mtimeMs: optionalNumber(response.headers.get("x-obsync-mtime-ms")),
    };
  }

  private async hostedAuthContext(options: {
    forceRefresh?: boolean;
    freshTicket?: boolean;
  } = {}): Promise<HostedAuthContext> {
    const now = Date.now();
    if (
      !options.forceRefresh &&
      !options.freshTicket &&
      this.hostedSession?.syncSessionToken &&
      (this.hostedSession.sessionUsableUntilMs ?? 0) > now
    ) {
      return this.hostedSession;
    }

    if (!options.forceRefresh && !options.freshTicket && this.hostedSessionRefresh) {
      return this.hostedSessionRefresh;
    }

    const refresh = issueHostedWsTicket(this.getSettings(), this.saveSettings)
      .then((ticket) => this.normalizeHostedAuthContext(ticket));

    if (!options.freshTicket) {
      this.hostedSessionRefresh = refresh;
    }

    try {
      const auth = await refresh;
      if (auth.syncSessionToken && (auth.sessionUsableUntilMs ?? 0) > Date.now()) {
        this.hostedSession = auth;
      } else if (!auth.syncSessionToken && !options.freshTicket) {
        this.hostedSession = undefined;
      }
      return auth;
    } finally {
      if (!options.freshTicket && this.hostedSessionRefresh === refresh) {
        this.hostedSessionRefresh = undefined;
      }
    }
  }

  private normalizeHostedAuthContext(ticket: HostedSyncTicket): HostedAuthContext {
    const syncSessionToken = ticket.syncSessionToken ?? ticket.rawSyncSessionToken;
    return {
      ...ticket,
      syncSessionToken,
      sessionUsableUntilMs: syncSessionToken
        ? hostedSessionUsableUntilMs(ticket.syncSession?.expiresAt)
        : undefined,
    };
  }

  private hostedRequestBody(
    body: unknown,
    auth: HostedAuthContext,
    mode: HostedAuthMode,
  ): Record<string, unknown> {
    const payload = body && typeof body === "object" && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>) }
      : {};
    if (mode === "session" && auth.syncSessionToken) {
      payload.syncSessionToken = auth.syncSessionToken;
      delete payload.ticket;
      return payload;
    }
    payload.ticket = auth.rawTicket;
    delete payload.syncSessionToken;
    return payload;
  }

  private hostedUploadResponse(
    response: HostedUploadResponse,
    fallbackTransferToken?: string,
  ): UploadSessionResponse {
    return {
      ok: response.ok,
      backend: "hosted",
      uploadId: response.upload.id,
      tenantId: response.upload.tenantId,
      transferToken: response.transferToken ?? fallbackTransferToken,
      status: response.upload.status,
      chunkSize: response.upload.chunkSizeBytes,
      uploadedChunks: response.upload.uploadedChunks,
      finalized: response.upload.finalized,
    };
  }

  private requireHostedPending(pending?: PendingUploadState): {
    tenantId: string;
    transferToken: string;
  } {
    if (!pending?.tenantId || !pending.transferToken) {
      throw new Error("сессия передачи не содержит временный ключ");
    }
    return {
      tenantId: pending.tenantId,
      transferToken: pending.transferToken,
    };
  }

  private async createHostedDownload(path: string): Promise<HostedDownloadSession> {
    let activeAuth: HostedAuthContext | undefined;
    const result = await this.requestHostedJson<{
      download: {
        id: string;
        contentUrl: string;
      };
      transferToken: string;
    }>((ticket) => {
      activeAuth = ticket;
      return {
        path: `/sync/tenants/${encodeURIComponent(ticket.sync.tenantId)}/downloads`,
        body: {
          path,
        },
        label: `hosted create download ${path}`,
      };
    });
    if (!activeAuth) throw new Error("сервер не выдал данные tenant для скачивания");

    return {
      tenantId: activeAuth.sync.tenantId,
      downloadId: result.download.id,
      contentUrl: result.download.contentUrl,
      transferToken: result.transferToken,
    };
  }

  private async fetchHostedDownloadContent(
    download: HostedDownloadSession,
    range?: string,
  ): Promise<Response> {
    return this.fetchWithRetry(
      `${this.hostedSyncBaseUrl()}${download.contentUrl}`,
      {
        headers: {
          authorization: `Bearer ${download.transferToken}`,
          ...(range ? { range } : {}),
        },
      },
      {
        label: `download ${download.downloadId}`,
        timeoutMs: TRANSFER_REQUEST_TIMEOUT_MS,
      },
    );
  }

  private async fetchWithRetry(
    input: RequestInfo | URL,
    init: RequestInit = {},
    context: { label: string; timeoutMs: number },
  ): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await this.fetchOnce(input, init, context.timeoutMs);
        if (isRetryableStatus(response.status) && attempt < RETRY_DELAYS_MS.length) {
          await this.waitBeforeRetry(
            context,
            attempt,
            `сервер ответил ${response.status}`,
            retryAfterMs(response.headers),
          );
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;
        if (!isRetryableFetchError(error) || attempt >= RETRY_DELAYS_MS.length) {
          break;
        }
        await this.waitBeforeRetry(context, attempt, readableFetchError(error));
      }
    }

    throw new Error(
      `соединение оборвалось после ${RETRY_DELAYS_MS.length + 1} попыток: ${readableFetchError(lastError)}`,
    );
  }

  private async fetchOnce(
    input: RequestInfo | URL,
    init: RequestInit = {},
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async waitBeforeRetry(
    context: { label: string },
    attempt: number,
    reason: string,
    retryAfterDelayMs?: number,
  ): Promise<void> {
    const delayMs = retryDelayMs(attempt, retryAfterDelayMs);
    this.onProgress({
      phase: "retry",
      path: context.label,
      transferredBytes: 0,
      totalBytes: 0,
      chunkIndex: attempt + 1,
      totalChunks: RETRY_DELAYS_MS.length,
      message: `соединение прервалось (${reason}), повтор ${attempt + 1}/${RETRY_DELAYS_MS.length} через ${Math.round(delayMs / 1000)} сек`,
    });
    await sleep(delayMs);
  }

  private hostedSyncBaseUrl(): string {
    const settings = this.getSettings();
    return hostedSyncApiBaseUrl(settings.hostedSyncBaseUrl || settings.serverUrl);
  }

  private validPath(path: string): string {
    const validPath = validateVaultPath(path, {
      allowObsidianConfig: this.getSettings().syncObsidianConfig,
      allowObsidianPlugins: this.getSettings().syncObsidianConfig,
    });
    if (!validPath) throw new Error(`некорректный путь внутри хранилища: ${path}`);
    return validPath;
  }
}

function safeTelemetryDeviceId(deviceId: string | undefined): string | undefined {
  const trimmed = deviceId?.trim();
  if (!trimmed || !/^device-[a-zA-Z0-9_.:-]{8,160}$/.test(trimmed)) return undefined;
  return trimmed;
}

function hostedWebControlUrl(serverUrl: string, path: string): string {
  const normalizedPath = path.replace(/^\/+/, "");
  try {
    const url = new URL(serverUrl);
    if (
      url.hostname === "obsync.ru" ||
      url.hostname === "www.obsync.ru" ||
      url.hostname === "sync.obsync.ru" ||
      url.hostname === "api.obsync.ru"
    ) {
      return `https://obsync.ru/api/web/control/sync/${normalizedPath}`;
    }
    if (
      url.hostname === "obsync.pro" ||
      url.hostname === "www.obsync.pro" ||
      url.hostname === "sync.obsync.pro" ||
      url.hostname === "api.obsync.pro"
    ) {
      return `https://obsync.pro/api/web/control/sync/${normalizedPath}`;
    }
    url.pathname = `/api/web/control/sync/${normalizedPath}`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return `${serverUrl.replace(/\/+$/, "")}/api/web/control/sync/${normalizedPath}`;
  }
}

function optionalNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!error) return true;
  if (!(error instanceof Error)) return true;
  const message = error.message.toLowerCase();
  return error.name === "AbortError" ||
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("connection") ||
    message.includes("reset") ||
    message.includes("aborted");
}

function isHostedTicketError(body: string): boolean {
  const normalized = body.toLowerCase();
  return normalized.includes("ticket") ||
    normalized.includes("билет");
}

function isHostedSessionError(body: string): boolean {
  const normalized = body.toLowerCase();
  return normalized.includes("sync session") ||
    normalized.includes("syncsessiontoken") ||
    normalized.includes("сессию синхронизации") ||
    normalized.includes("сессия синхронизации");
}

function isHostedLegacyTicketRequiredError(body: string): boolean {
  const normalized = body.toLowerCase();
  return !isHostedSessionError(normalized) &&
    (
      normalized.includes("invalid ticket") ||
      normalized.includes("missing ticket") ||
      normalized.includes("ws ticket") ||
      normalized.includes("одноразовый билет")
    );
}

function hostedSessionUsableUntilMs(expiresAt: string | undefined): number {
  const now = Date.now();
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) return now + 2 * 60_000;
  const ttlMs = expiresAtMs - now;
  if (ttlMs <= 0) return now;
  const skewMs = Math.max(30_000, Math.floor(ttlMs * 0.1));
  return Math.max(now, expiresAtMs - skewMs);
}

function isUnsupportedEndpointError(error: unknown): boolean {
  return error instanceof Error && /\(404\)/.test(error.message);
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
  }

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, dateMs - Date.now()));
}

function retryDelayMs(attempt: number, retryAfterDelayMs?: number): number {
  if (retryAfterDelayMs !== undefined) return retryAfterDelayMs;
  const baseDelayMs = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  const jitterMs = Math.round(baseDelayMs * RETRY_JITTER_RATIO * Math.random());
  return baseDelayMs + jitterMs;
}

function readableFetchError(error: unknown): string {
  if (!error) return "неизвестная сетевая ошибка";
  if (error instanceof Error) {
    if (error.name === "AbortError") return "таймаут запроса";
    return error.message || error.name;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonBodyBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength;
}

function expectedChunkSize(
  totalBytes: number,
  chunkSize: number,
  chunkIndex: number,
): number {
  const start = chunkIndex * chunkSize;
  if (start >= totalBytes) return 0;
  return Math.min(chunkSize, totalBytes - start);
}

function canStageBinaryDownload(adapter: DataAdapter): adapter is DataAdapter & {
  appendBinary: (path: string, data: ArrayBuffer) => Promise<void>;
  rename: (path: string, newPath: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
} {
  const maybeAdapter = adapter as Partial<DataAdapter>;
  return (
    typeof maybeAdapter.writeBinary === "function" &&
    typeof maybeAdapter.appendBinary === "function" &&
    typeof maybeAdapter.rename === "function" &&
    typeof maybeAdapter.remove === "function" &&
    typeof maybeAdapter.mkdir === "function" &&
    typeof maybeAdapter.exists === "function" &&
    typeof maybeAdapter.stat === "function"
  );
}

async function renameReplacing(
  adapter: DataAdapter & {
    rename: (path: string, newPath: string) => Promise<void>;
    remove: (path: string) => Promise<void>;
  },
  tempPath: string,
  targetPath: string,
): Promise<void> {
  try {
    await adapter.rename(tempPath, targetPath);
    return;
  } catch (error) {
    if (!(await adapter.exists(targetPath))) throw error;
  }

  await adapter.remove(targetPath);
  await adapter.rename(tempPath, targetPath);
}

async function ensureAdapterFolder(
  adapter: DataAdapter & {
    mkdir: (path: string) => Promise<void>;
  },
  folderPath: string,
): Promise<void> {
  if (!folderPath || await adapter.exists(folderPath)) return;
  const parent = parentPath(folderPath);
  if (parent && !(await adapter.exists(parent))) {
    await ensureAdapterFolder(adapter, parent);
  }
  await adapter.mkdir(folderPath);
}

async function removeIfExists(
  adapter: DataAdapter & { remove: (path: string) => Promise<void> },
  path: string,
): Promise<void> {
  if (await adapter.exists(path)) {
    await adapter.remove(path);
  }
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

async function assertSha256(
  body: ArrayBuffer,
  expectedHash: string,
  path: string,
): Promise<void> {
  const actualHash = `sha256:${await sha256Hex(body)}`;
  if (actualHash !== expectedHash) {
    throw new Error(`контрольная сумма скачанного файла не совпала: ${path}`);
  }
}
