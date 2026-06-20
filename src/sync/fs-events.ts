import { Notice, Platform, TFile, TFolder, type TAbstractFile, type Vault } from "obsidian";
import type { ObsyncSettings } from "../settings";
import { Debouncer } from "../util/debounce";
import { createRandomId } from "../util/device-id";
import { sha256Hex } from "../util/hash";
import type { SyncClient } from "./client";
import type { EchoSuppression } from "./echo-suppression";
import type { SyncHttpApi } from "./http-api";
import { validateVaultPath } from "./path-policy";
import type { ServerOperation } from "./types";

const OBSIDIAN_CONFIG_ROOT = ".obsidian";
const STAGED_DOWNLOAD_MIN_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TEMP_ROOT = ".obsidian/plugins/obsync/tmp-downloads";
const ALWAYS_IGNORED_PATHS = new Set([
  ".obsidian/plugins/obsync",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
]);

export class VaultEventBridge {
  private readonly debouncer = new Debouncer();
  private readonly queuedUpserts = new Set<string>();
  private flushTimer?: number;
  private flushingUpserts = false;
  private retryDelayMs = 2_000;
  private lastRetryNoticeAt = 0;

  constructor(
    private readonly vault: Vault,
    private readonly getSettings: () => ObsyncSettings,
    private readonly client: SyncClient,
    private readonly httpApi: SyncHttpApi,
    private readonly echoSuppression: EchoSuppression,
  ) {}

  dispose(): void {
    this.debouncer.clear();
    if (this.flushTimer) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.queuedUpserts.clear();
  }

  handleCreate(file: TAbstractFile): void {
    if (this.shouldIgnore(file.path)) return;
    if (this.echoSuppression.shouldSuppress(file.path)) return;

    this.queueUpsert(file);
  }

  handleModify(file: TAbstractFile): void {
    if (this.shouldIgnore(file.path)) return;
    if (this.echoSuppression.shouldSuppress(file.path)) return;

    this.debouncer.run(file.path, 500, () => this.queueUpsert(file));
  }

  handleDelete(file: TAbstractFile): void {
    if (this.shouldIgnore(file.path)) return;
    if (this.echoSuppression.shouldSuppress(file.path)) return;

    const settings = this.getSettings();
    const fileId = this.fileIdForPath(file.path);
    const expectedHash = settings.lastFileHashes[file.path];
    const expectedSeq = settings.lastFileSeqs[file.path];
    delete settings.lastFileHashes[file.path];
    delete settings.lastFileSeqs[file.path];
    delete settings.fileIds[file.path];
    const opId = this.createOpId("delete");
    settings.pendingSeqUpdates[opId] = { path: file.path, kind: "delete" };
    this.client.send({
      opId,
      operationType: "delete",
      fileId,
      path: file.path,
      payload: {
        kind: this.kindFor(file),
        expectedHash,
        expectedSeq,
      },
    });
  }

  handleRename(file: TAbstractFile, oldPath: string): void {
    if (this.shouldIgnore(file.path) || this.shouldIgnore(oldPath)) return;
    if (
      this.echoSuppression.shouldSuppress(file.path) ||
      this.echoSuppression.shouldSuppress(oldPath)
    ) {
      return;
    }

    const settings = this.getSettings();
    const knownHash = settings.lastFileHashes[oldPath];
    const knownSeq = settings.lastFileSeqs[oldPath];
    const fileId = this.fileIdForPath(oldPath);
    if (knownHash) {
      settings.lastFileHashes[file.path] = knownHash;
      delete settings.lastFileHashes[oldPath];
    }
    if (knownSeq !== undefined) {
      settings.lastFileSeqs[file.path] = knownSeq;
      delete settings.lastFileSeqs[oldPath];
    }
    settings.fileIds[file.path] = fileId;
    delete settings.fileIds[oldPath];

    const opId = this.createOpId("rename");
    settings.pendingSeqUpdates[opId] = {
      path: oldPath,
      newPath: file.path,
      kind: "rename",
    };
    this.client.send({
      opId,
      operationType: "rename",
      fileId,
      path: oldPath,
      payload: {
        kind: this.kindFor(file),
        newPath: file.path,
        expectedHash: knownHash,
        expectedSeq: knownSeq,
      },
    });
  }

  async applyRemoteOperation(operation: ServerOperation): Promise<void> {
    if (operation.deviceId === this.getSettings().deviceId) return;

    const path = operation.path;
    if (!path || this.shouldIgnore(path)) return;

    if (operation.operationType === "delete") {
      await this.applyRemoteDelete(path);
      delete this.getSettings().lastFileHashes[path];
      delete this.getSettings().lastFileSeqs[path];
      delete this.getSettings().fileIds[path];
      return;
    }

    if (operation.operationType === "rename") {
      const newPath = stringPayload(operation.payload, "newPath");
      const validNewPath = newPath
        ? validateVaultPath(newPath, {
            allowObsidianConfig: this.getSettings().syncObsidianConfig,
            allowObsidianPlugins: this.getSettings().syncObsidianConfig,
          })
        : undefined;
      if (validNewPath) {
        await this.applyRename(path, validNewPath);
        const knownHash = this.getSettings().lastFileHashes[path];
        if (knownHash) {
          this.getSettings().lastFileHashes[validNewPath] = knownHash;
          delete this.getSettings().lastFileHashes[path];
        }
        this.getSettings().lastFileSeqs[validNewPath] = operation.serverSeq;
        delete this.getSettings().lastFileSeqs[path];
        const fileId = operation.fileId ?? this.getSettings().fileIds[path];
        if (fileId) {
          this.getSettings().fileIds[validNewPath] = fileId;
          delete this.getSettings().fileIds[path];
        }
      }
      return;
    }

    if (operation.operationType === "file_upsert") {
      const kind = stringPayload(operation.payload, "kind");
      const content = stringPayload(operation.payload, "content");
      if (kind === "markdown" && content !== undefined) {
        const hash = `sha256:${await sha256Hex(content)}`;
        const result = await this.writeDownloadedFile({
          path,
          kind,
          body: new TextEncoder().encode(content).buffer,
          hash,
          overwrite: false,
        });
        if (result !== "conflict") {
          this.getSettings().lastFileHashes[path] = hash;
          this.getSettings().lastFileSeqs[path] = operation.serverSeq;
          if (operation.fileId) this.getSettings().fileIds[path] = operation.fileId;
        } else {
          new Notice(`obsync conflict: kept local note "${path}" unchanged`);
        }
        return;
      }

      const hash = stringPayload(operation.payload, "hash");
      const result = await this.writeDownloadedFileFromServer({
        path,
        kind: kind ?? "blob",
        hash,
        sizeBytes: numberPayload(operation.payload, "sizeBytes"),
        overwrite: kind === "markdown" ? false : true,
      });
      if (hash && result !== "conflict") {
        this.getSettings().lastFileHashes[path] = hash;
        this.getSettings().lastFileSeqs[path] = operation.serverSeq;
        if (operation.fileId) this.getSettings().fileIds[path] = operation.fileId;
      }
    }
  }

  isIgnored(path: string): boolean {
    return this.shouldIgnore(path);
  }

  async writeDownloadedFile(input: {
    path: string;
    kind: string;
    body: ArrayBuffer;
    contentType?: string;
    hash?: string;
    overwrite?: boolean;
  }): Promise<"created" | "updated" | "conflict" | "skipped"> {
    if (this.shouldIgnore(input.path)) return "skipped";

    if (input.kind === "markdown" || input.path.toLowerCase().endsWith(".md")) {
      const content = new TextDecoder().decode(input.body);
      return this.writeDownloadedMarkdown(input.path, content, input.hash, input.overwrite);
    }

    return this.writeDownloadedBinary(input.path, input.body, input.hash, input.overwrite);
  }

  async writeDownloadedFileFromServer(input: {
    path: string;
    kind: string;
    hash?: string;
    sizeBytes?: number;
    overwrite?: boolean;
  }): Promise<"created" | "updated" | "conflict" | "skipped"> {
    if (this.shouldIgnore(input.path)) return "skipped";

    const stagedTarget = this.stagedDownloadTarget(input);
    if (stagedTarget) {
      if (stagedTarget.result === "conflict" && stagedTarget.exists) {
        return "conflict";
      }

      await this.ensureParentFolders(stagedTarget.targetPath);
      this.echoSuppression.suppress(stagedTarget.tempPath);
      this.echoSuppression.suppress(stagedTarget.targetPath);
      await this.httpApi.downloadFileToAdapter({
        path: input.path,
        expectedSizeBytes: input.sizeBytes ?? 0,
        adapter: this.vault.adapter,
        tempPath: stagedTarget.tempPath,
        targetPath: stagedTarget.targetPath,
        beforeCommit: () => this.echoSuppression.suppress(stagedTarget.targetPath),
      });
      return stagedTarget.result;
    }

    const downloaded = await this.httpApi.downloadFile(input.path, input.sizeBytes);
    return this.writeDownloadedFile({
      path: input.path,
      kind: input.kind,
      body: downloaded.body,
      contentType: downloaded.contentType,
      hash: downloaded.hash ?? input.hash,
      overwrite: input.overwrite,
    });
  }

  private queueUpsert(file: TAbstractFile): void {
    if (file instanceof TFolder) {
      const fileId = this.fileIdForPath(file.path);
      const opId = this.createOpId("folder_upsert");
      this.getSettings().pendingSeqUpdates[opId] = {
        path: file.path,
        kind: "upsert",
      };
      this.client.send({
        opId,
        operationType: "folder_upsert",
        fileId,
        path: file.path,
        payload: {
          kind: "folder",
        },
      });
      return;
    }

    if (!(file instanceof TFile)) return;

    this.queuedUpserts.add(file.path);
    this.scheduleUpsertFlush(300);
  }

  private scheduleUpsertFlush(delayMs: number): void {
    if (this.flushTimer) {
      window.clearTimeout(this.flushTimer);
    }
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushQueuedUpserts();
    }, delayMs);
  }

  private async flushQueuedUpserts(): Promise<void> {
    if (this.flushingUpserts) return;
    this.flushingUpserts = true;
    try {
      while (this.queuedUpserts.size > 0) {
        const path = this.queuedUpserts.values().next().value as string | undefined;
        if (!path) return;
        this.queuedUpserts.delete(path);

        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || this.shouldIgnore(file.path)) continue;

        try {
          await this.sendFileUpsert(file);
          this.retryDelayMs = 2_000;
        } catch (error) {
          this.queuedUpserts.add(path);
          const delay = this.retryDelayMs;
          this.retryDelayMs = Math.min(60_000, Math.round(this.retryDelayMs * 1.8));
          this.notifyRetry(path, error, delay);
          this.scheduleUpsertFlush(delay);
          return;
        }
      }
    } finally {
      this.flushingUpserts = false;
    }
  }

  private notifyRetry(path: string, error: unknown, delayMs: number): void {
    const now = Date.now();
    if (now - this.lastRetryNoticeAt < 30_000) return;
    this.lastRetryNoticeAt = now;
    const message = error instanceof Error && error.message
      ? error.message
      : "сетевая ошибка";
    new Notice(
      `obsync: изменение «${path}» будет отправлено повторно через ${Math.round(delayMs / 1000)} сек. ${message}`,
      12000,
    );
  }

  private async sendFileUpsert(file: TFile): Promise<void> {
    const kind = this.kindFor(file);
    if (kind !== "markdown" && !this.getSettings().syncAttachments) return;

    const maxBytes = this.getSettings().maxAttachmentMB * 1024 * 1024;
    if (file.stat.size > maxBytes) return;

    const markdown = kind === "markdown" ? await this.vault.read(file) : undefined;
    const body = markdown !== undefined
      ? new TextEncoder().encode(markdown).buffer
      : await this.vault.readBinary(file);
    const fileId = this.fileIdForPath(file.path);
    const expectedCurrentHash = this.getSettings().lastFileHashes[file.path];
    const expectedCurrentSeq = this.getSettings().lastFileSeqs[file.path];

    const uploaded = await this.httpApi.uploadFile({
      fileId,
      path: file.path,
      kind,
      body,
      mtimeMs: file.stat.mtime,
      contentType: kind === "markdown"
        ? "text/markdown; charset=utf-8"
        : "application/octet-stream",
      expectedCurrentHash,
      expectedCurrentSeq,
    });

    this.getSettings().lastFileHashes[file.path] = uploaded.hash;
    if (uploaded.operation?.serverSeq) {
      this.getSettings().lastFileSeqs[file.path] = uploaded.operation.serverSeq;
      if (markdown !== undefined) {
        this.client.sendMarkdownSnapshot({
          sourcePath: file.path,
          sourceHash: uploaded.hash,
          sourceSeq: uploaded.operation.serverSeq,
          markdown,
        });
      }
    }
    this.getSettings().fileIds[file.path] = uploaded.fileId;
    if (uploaded.operation) {
      this.client.send({
          opId: uploaded.operation.opId,
          operationType: uploaded.operation.operationType ?? "file_upsert",
          fileId: uploaded.operation.fileId ?? uploaded.fileId,
          path: uploaded.operation.path ?? file.path,
          payload: uploaded.operation.payload ?? {},
      });
      return;
    }

    const opId = this.createOpId("file_upsert");
    this.getSettings().pendingSeqUpdates[opId] = {
      path: file.path,
      kind: "upsert",
    };
    this.client.send({
      opId,
      operationType: "file_upsert",
      fileId: uploaded.fileId,
      path: file.path,
      payload: {
        kind,
        hash: uploaded.hash,
        sizeBytes: uploaded.sizeBytes,
        mtimeMs: uploaded.mtimeMs ?? file.stat.mtime,
        contentStored: true,
        expectedHash: expectedCurrentHash,
        expectedSeq: expectedCurrentSeq,
      },
    });
  }

  private async applyMarkdown(path: string, content: string): Promise<void> {
    await this.ensureParentFolders(path);
    const existing = this.vault.getAbstractFileByPath(path);

    this.echoSuppression.suppress(path);

    if (existing instanceof TFile) {
      const current = await this.vault.read(existing);
      if (current !== content) {
        await this.vault.modify(existing, content);
      }
      return;
    }

    if (!existing) {
      await this.vault.create(path, content);
    }
  }

  private async writeDownloadedMarkdown(
    path: string,
    content: string,
    hash?: string,
    overwrite = false,
  ): Promise<"created" | "updated" | "conflict" | "skipped"> {
    await this.ensureParentFolders(path);
    const existing = this.vault.getAbstractFileByPath(path);

    if (!existing) {
      this.echoSuppression.suppress(path);
      await this.vault.create(path, content);
      return "created";
    }

    if (existing instanceof TFile) {
      const current = await this.vault.read(existing);
      if (current === content) return "skipped";

      if (overwrite || current.trim().length === 0) {
        this.echoSuppression.suppress(path);
        await this.vault.modify(existing, content);
        return "updated";
      }

      const lastHash = this.getSettings().lastFileHashes[path];
      if (lastHash !== undefined) {
        const currentHash = `sha256:${await sha256Hex(current)}`;
        if (currentHash !== lastHash) {
          return "conflict";
        }
      }

      this.echoSuppression.suppress(path);
      await this.vault.modify(existing, content);
      return "updated";
    }

    return "skipped";
  }

  private async writeDownloadedBinary(
    path: string,
    body: ArrayBuffer,
    hash?: string,
    overwrite = false,
  ): Promise<"created" | "updated" | "conflict" | "skipped"> {
    await this.ensureParentFolders(path);
    const existing = this.vault.getAbstractFileByPath(path);
    this.echoSuppression.suppress(path);

    if (!existing) {
      await this.vault.createBinary(path, body);
      return "created";
    }

    if (existing instanceof TFile) {
      const current = await this.vault.readBinary(existing);
      if (arrayBuffersEqual(current, body)) return "skipped";

      if (overwrite || current.byteLength === 0) {
        await this.vault.modifyBinary(existing, body);
        return "updated";
      }

      const conflictPath = this.conflictPath(
        path,
        hash ?? `sha256:${await sha256Hex(body)}`,
      );
      const existingConflict = this.vault.getAbstractFileByPath(conflictPath);
      if (existingConflict instanceof TFile) {
        const existingConflictBody = await this.vault.readBinary(existingConflict);
        if (arrayBuffersEqual(existingConflictBody, body)) return "conflict";
      }

      await this.ensureParentFolders(conflictPath);
      this.echoSuppression.suppress(conflictPath);
      await this.vault.createBinary(conflictPath, body);
      return "conflict";
    }

    return "skipped";
  }

  private async applyDelete(path: string): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(path);
    if (!existing) return;

    this.echoSuppression.suppress(path);
    await this.vault.delete(existing, true);
  }

  private async applyRemoteDelete(path: string): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(path);
    if (!existing) return;

    if (existing instanceof TFolder) {
      if (existing.children.length === 0) {
        await this.applyDelete(path);
      }
      return;
    }

    if (!(existing instanceof TFile)) return;

    const lastHash = this.getSettings().lastFileHashes[path];
    if (!lastHash) {
      await this.renameRemoteDeleteConflict(existing);
      return;
    }

    const localHash = await this.fileHash(existing);
    if (localHash === lastHash) {
      await this.applyDelete(path);
      return;
    }

    await this.renameRemoteDeleteConflict(existing, localHash);
  }

  private async renameRemoteDeleteConflict(file: TFile, hash?: string): Promise<void> {
    const conflictPath = this.uniqueConflictPath(file.path, hash);
    await this.ensureParentFolders(conflictPath);
    this.echoSuppression.suppress(file.path);
    this.echoSuppression.suppress(conflictPath);
    await this.vault.rename(file, conflictPath);
    new Notice(`obsync: kept local changes as "${conflictPath}"`);
  }

  private async applyRename(path: string, newPath: string): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(path);
    if (!existing) return;

    await this.ensureParentFolders(newPath);
    this.echoSuppression.suppress(path);
    this.echoSuppression.suppress(newPath);
    await this.vault.rename(existing, newPath);
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();

    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.vault.getAbstractFileByPath(current);
      if (!existing) {
        this.echoSuppression.suppress(current);
        await this.vault.createFolder(current);
      }
    }
  }

  private shouldIgnore(path: string): boolean {
    const normalizedPath = validateVaultPath(path, {
      allowObsidianConfig: this.getSettings().syncObsidianConfig,
      allowObsidianPlugins: this.getSettings().syncObsidianConfig,
    });
    if (!normalizedPath) return true;

    if (this.isAlwaysIgnored(normalizedPath)) return true;

    const settings = this.getSettings();
    if (this.isObsidianConfigPath(normalizedPath) && !settings.syncObsidianConfig) {
      return true;
    }

    return settings.ignoredPatterns.some((pattern) => {
      if (!pattern) return false;
      const normalizedPattern = this.normalizePath(pattern);
      if (
        settings.syncObsidianConfig &&
        (normalizedPattern === ".obsidian" || normalizedPattern === ".obsidian/")
      ) {
        return false;
      }

      return (
        normalizedPath === normalizedPattern ||
        normalizedPath.startsWith(normalizedPattern) ||
        normalizedPath.includes(normalizedPattern)
      );
    });
  }

  private isAlwaysIgnored(path: string): boolean {
    return (
      ALWAYS_IGNORED_PATHS.has(path) ||
      path.startsWith(".obsidian/plugins/obsync/") ||
      this.isVolatileWorkspacePath(path) ||
      this.isConflictPath(path) ||
      path === ".obsidian/cache" ||
      path.startsWith(".obsidian/cache/") ||
      path === DOWNLOAD_TEMP_ROOT ||
      path.startsWith(`${DOWNLOAD_TEMP_ROOT}/`)
    );
  }

  private isVolatileWorkspacePath(path: string): boolean {
    const normalized = path.toLowerCase();
    return normalized.startsWith(".obsidian/workspace") && normalized.endsWith(".json");
  }

  private isObsidianConfigPath(path: string): boolean {
    return path === OBSIDIAN_CONFIG_ROOT || path.startsWith(`${OBSIDIAN_CONFIG_ROOT}/`);
  }

  private normalizePath(path: string): string {
    return path.replace(/\\/g, "/");
  }

  private isConflictPath(path: string): boolean {
    const name = path.split("/").pop() ?? path;
    return (
      /\.remote-conflict-[a-f0-9]{12}(?=\.|$)/.test(name) ||
      /\.conflict-\d{8}T\d{6}(?=\.|$)/.test(name)
    );
  }

  private kindFor(file: TAbstractFile): string {
    if (file instanceof TFolder) return "folder";
    if (file instanceof TFile && file.extension.toLowerCase() === "md") return "markdown";
    return "blob";
  }

  private fileIdForPath(path: string): string {
    const settings = this.getSettings();
    const existing = settings.fileIds[path];
    if (existing) return existing;

    const generated = `file-${Date.now().toString(36)}-${createRandomId(6)}`;
    settings.fileIds[path] = generated;
    return generated;
  }

  private createOpId(kind: string): string {
    return `${this.getSettings().deviceId}:${kind}:${Date.now()}:${createRandomId(8)}`;
  }

  private conflictPath(path: string, hash?: string): string {
    const dot = path.lastIndexOf(".");
    const suffix = hash
      ? `remote-conflict-${hash.replace(/^sha256:/, "").slice(0, 12)}`
      : `conflict-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`;
    if (dot <= 0) return `${path}.${suffix}`;
    return `${path.slice(0, dot)}.${suffix}${path.slice(dot)}`;
  }

  private uniqueConflictPath(path: string, hash?: string): string {
    const base = this.conflictPath(path, hash);
    if (!this.vault.getAbstractFileByPath(base)) return base;

    const dot = base.lastIndexOf(".");
    for (let index = 2; index < 100; index += 1) {
      const candidate = dot <= 0
        ? `${base}-${index}`
        : `${base.slice(0, dot)}-${index}${base.slice(dot)}`;
      if (!this.vault.getAbstractFileByPath(candidate)) return candidate;
    }

    return this.conflictPath(path);
  }

  private async fileHash(file: TFile): Promise<string> {
    if (file.extension.toLowerCase() === "md") {
      return `sha256:${await sha256Hex(await this.vault.read(file))}`;
    }
    return `sha256:${await sha256Hex(await this.vault.readBinary(file))}`;
  }

  private stagedDownloadTarget(input: {
    path: string;
    kind: string;
    hash?: string;
    sizeBytes?: number;
    overwrite?: boolean;
  }):
    | {
      targetPath: string;
      tempPath: string;
      result: "created" | "updated" | "conflict";
      exists: boolean;
    }
    | undefined {
    if (!Platform.isDesktopApp) return undefined;
    if (!input.sizeBytes || input.sizeBytes <= STAGED_DOWNLOAD_MIN_BYTES) return undefined;
    if (input.kind === "markdown" || input.path.toLowerCase().endsWith(".md")) return undefined;
    if (!canAdapterStageBinaryDownload(this.vault.adapter)) return undefined;

    const existing = this.vault.getAbstractFileByPath(input.path);
    const tempPath = this.tempDownloadPath(input.path, input.hash);

    if (!existing) {
      return {
        targetPath: input.path,
        tempPath,
        result: "created",
        exists: false,
      };
    }

    if (!(existing instanceof TFile)) return undefined;

    if (input.overwrite || existing.stat.size === 0) {
      return {
        targetPath: input.path,
        tempPath,
        result: "updated",
        exists: true,
      };
    }

    const conflictPath = this.conflictPath(input.path, input.hash);
    return {
      targetPath: conflictPath,
      tempPath,
      result: "conflict",
      exists: this.vault.getAbstractFileByPath(conflictPath) instanceof TFile,
    };
  }

  private tempDownloadPath(path: string, hash?: string): string {
    const suffix = hash
      ? hash.replace(/^sha256:/, "").slice(0, 16)
      : createRandomId(8);
    const safeName = path
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]+/g, "_")
      .slice(0, 80) || "download";

    return `${DOWNLOAD_TEMP_ROOT}/${Date.now()}-${suffix}-${safeName}.part`;
  }
}

function stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function numberPayload(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayBuffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftView = new Uint8Array(left);
  const rightView = new Uint8Array(right);
  for (let index = 0; index < leftView.length; index += 1) {
    if (leftView[index] !== rightView[index]) return false;
  }
  return true;
}

function canAdapterStageBinaryDownload(adapter: unknown): boolean {
  const maybeAdapter = adapter as Record<string, unknown>;
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
