import type { ObsyncSettings } from "../settings";
import {
  OBSYNC_PLUGIN_VERSION,
  OBSYNC_PROTOCOL_VERSION,
} from "../protocol";

const TICKET_TIMEOUT_MS = 30_000;
const TICKET_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];

export interface HostedSyncTicket {
  ticket: string;
  rawTicket: string;
  sync: {
    tenantId: string;
    vaultId: string;
    deviceId: string;
    syncBaseUrl: string;
    wsUrl: string;
  };
}

export function isHostedSync(settings: ObsyncSettings): boolean {
  return settings.syncBackend === "hosted";
}

export async function issueHostedWsTicket(
  settings: ObsyncSettings,
  saveSettings: () => Promise<void> = async () => {},
): Promise<HostedSyncTicket> {
  const ticketUrl = hostedControlUrl(settings.serverUrl, "ws-tickets");
  let response: Response;
  try {
    response = await fetchTicketWithRetry(ticketUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.authToken}`,
        "content-type": "application/json",
        "x-obsync-client-version": OBSYNC_PLUGIN_VERSION,
        "x-obsync-protocol-version": String(OBSYNC_PROTOCOL_VERSION),
      },
      body: JSON.stringify({
        deviceId: settings.deviceId || settings.deviceLabel || "device",
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`не удалось получить билет синхронизации с ${ticketUrl}: ${message}`);
  }

  if (!response.ok) {
    throw new Error(
      `сервер не выдал билет синхронизации (${response.status}): ${readableTicketError(await response.text())}`,
    );
  }

  const result = (await response.json()) as HostedSyncTicket;
  settings.hostedTenantId = result.sync.tenantId;
  settings.hostedVaultId = result.sync.vaultId;
  settings.hostedSyncBaseUrl = hostedSyncApiBaseUrl(result.sync.syncBaseUrl);
  settings.vaultId = result.sync.vaultId;
  settings.deviceId = result.sync.deviceId || settings.deviceId;
  if (!settings.vaultName) {
    settings.vaultName = result.sync.vaultId;
  }
  await saveSettings();
  return result;
}

export function hostedControlUrl(serverUrl: string, path: string): string {
  const normalizedPath = path.replace(/^\/+/, "");
  try {
    const url = new URL(serverUrl);
    if (url.hostname === "obsync.ru" || url.hostname === "www.obsync.ru" || url.hostname === "sync.obsync.ru") {
      return `https://api.obsync.ru/api/control/v1/sync/${normalizedPath}`;
    }
    url.pathname = `/api/control/v1/sync/${normalizedPath}`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return `${serverUrl.replace(/\/+$/, "")}/api/control/v1/sync/${normalizedPath}`;
  }
}

async function fetchTicketWithRetry(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TICKET_RETRY_DELAYS_MS.length; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TICKET_TIMEOUT_MS);
    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (isRetryableStatus(response.status) && attempt < TICKET_RETRY_DELAYS_MS.length) {
        await sleep(TICKET_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (!isRetryableFetchError(error) || attempt >= TICKET_RETRY_DELAYS_MS.length) {
        break;
      }
      await sleep(TICKET_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw new Error(readableFetchError(lastError));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!error) return true;
  if (!(error instanceof Error)) return true;
  const message = error.message.toLowerCase();
  return error.name === "AbortError" ||
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("connection") ||
    message.includes("reset") ||
    message.includes("aborted");
}

function readableFetchError(error: unknown): string {
  if (!error) return "неизвестная сетевая ошибка";
  if (error instanceof Error) {
    if (error.name === "AbortError") return "таймаут запроса";
    return error.message || error.name;
  }
  return String(error);
}

function readableTicketError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const value = typeof parsed.error === "string"
      ? parsed.error
      : typeof parsed.message === "string"
        ? parsed.message
        : "";
    if (value === "device rate limit exceeded") {
      return "слишком много запросов от устройства, повторите синхронизацию через минуту";
    }
    if (value) return value;
  } catch {
    // Plain text response, handled below.
  }
  return body.trim() || "неизвестная ошибка";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hostedSyncApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/sync\/tenants\/[^/]+$/i, "") || "/";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/sync\/tenants\/[^/]+$/i, "");
  }
}
