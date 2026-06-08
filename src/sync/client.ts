import type { ObsyncSettings } from "../settings";
import { issueHostedWsTicket, isHostedSync } from "./hosted-auth";
import type { ClientOperation, SyncClientEvent } from "./types";

type EventHandler = (event: SyncClientEvent) => void | Promise<void>;

export function computeReconnectDelay(
  reconnectAttempt: number,
  random: () => number = Math.random,
): number {
  const baseDelayMs = 1000;
  const maxDelayMs = 30000;
  const attempt = Math.max(0, Math.min(reconnectAttempt, 5));
  const rawDelayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(rawDelayMs * jitter);
}

export class SyncClient {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private manuallyClosed = false;
  private reconnectAttempts = 0;
  private readonly listeners = new Set<EventHandler>();

  constructor(
    private readonly getSettings: () => ObsyncSettings,
    private readonly saveSettings: () => Promise<void> = async () => {},
  ) {}

  onEvent(listener: EventHandler): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    void this.connectAsync();
  }

  private async connectAsync(): Promise<void> {
    const settings = this.getSettings();
    this.manuallyClosed = false;

    if (!settings.enabled) {
      this.emit({ type: "status", status: "фоновая синхронизация выключена" });
      return;
    }

    if (!settings.authToken) {
      this.emit({ type: "status", status: "не указан ключ доступа" });
      return;
    }

    if (!settings.vaultId) {
      this.emit({ type: "status", status: "не указано название хранилища" });
      return;
    }

    if (!settings.deviceId) {
      this.emit({ type: "status", status: "не указано название устройства" });
      return;
    }

    let url: string;
    try {
      url = await this.buildWebSocketUrl(settings);
    } catch (error) {
      const message = error instanceof Error ? error.message : "не удалось подготовить соединение";
      this.emit({ type: "status", status: message });
      this.scheduleReconnect();
      return;
    }

    if (this.manuallyClosed) return;

    this.emit({ type: "status", status: "подключение" });
    this.socket = new WebSocket(url);

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.emit({ type: "status", status: "подключено" });
    };

    this.socket.onclose = () => {
      this.emit({ type: "status", status: "соединение закрыто" });
      this.socket = undefined;
      this.scheduleReconnect();
    };

    this.socket.onerror = () => {
      this.emit({ type: "status", status: "ошибка соединения" });
    };

    this.socket.onmessage = (message) => {
      this.handleMessage(message.data);
    };
  }

  disconnect(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    this.emit({ type: "status", status: "соединение закрыто" });
  }

  send(operation: Omit<ClientOperation, "type">): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.emit({ type: "status", status: "нет соединения, изменение будет отправлено после переподключения" });
      return false;
    }

    this.socket.send(JSON.stringify({ type: "operation", ...operation }));
    return true;
  }

  sendMarkdownSnapshot(input: {
    sourcePath: string;
    sourceHash: string;
    sourceSeq: number;
    markdown: string;
  }): boolean {
    if (!isHostedSync(this.getSettings())) return false;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;

    this.socket.send(JSON.stringify({ type: "markdown_snapshot", ...input }));
    return true;
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimer) return;

    const delay = this.getReconnectDelay();

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private getReconnectDelay(): number {
    const delay = computeReconnectDelay(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    return delay;
  }

  private handleMessage(raw: unknown): void {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === "operation" && message.operation) {
        const serverSeq = Number(message.operation.serverSeq);
        if (Number.isFinite(serverSeq) && serverSeq <= this.getSettings().lastCursor) {
          return;
        }
        this.emit({ type: "operation", operation: message.operation });
        return;
      }

      if (message.type === "ack") {
        this.emit({
          type: "ack",
          opId: String(message.opId),
          serverSeq: Number(message.serverSeq),
        });
        return;
      }

      if (message.type === "error") {
        this.emit({ type: "error", message: String(message.message) });
      }
    } catch (error) {
      this.emit({
        type: "error",
        message: error instanceof Error ? error.message : "сервер прислал некорректное сообщение",
      });
    }
  }

  private async buildWebSocketUrl(settings: ObsyncSettings): Promise<string> {
    if (isHostedSync(settings)) {
      const ticket = await issueHostedWsTicket(settings, this.saveSettings);
      const url = new URL(ticket.sync.wsUrl);
      url.searchParams.set("cursor", String(settings.lastCursor));
      url.searchParams.set("deviceName", settings.deviceName || settings.deviceId);
      return url.toString();
    }

    const base = new URL(settings.serverUrl);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = "/sync";
    base.searchParams.set("token", settings.authToken);
    base.searchParams.set("vaultId", settings.vaultId);
    base.searchParams.set("deviceId", settings.deviceId);
    base.searchParams.set("deviceName", settings.deviceName || settings.deviceId);
    base.searchParams.set("cursor", String(settings.lastCursor));
    return base.toString();
  }

  private emit(event: SyncClientEvent): void {
    for (const listener of this.listeners) {
      void listener(event);
    }
  }
}
