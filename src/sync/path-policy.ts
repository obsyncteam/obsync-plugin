export interface VaultPathPolicy {
  allowObsidianConfig?: boolean;
  allowObsidianPlugins?: boolean;
}

const MAX_VAULT_PATH_LENGTH = 4096;
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ENCODED_TRAVERSAL = /%(?:2e|2f|5c)/i;

const ALWAYS_BLOCKED_PATHS = new Set([
  ".obsidian/plugins/obsync",
  ".obsidian/cache",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
]);

export function validateVaultPath(
  path: string,
  policy: VaultPathPolicy = {},
): string | undefined {
  const normalized = path.normalize("NFC").replace(/\\/g, "/");
  if (!normalized) return undefined;
  if (normalized.length > MAX_VAULT_PATH_LENGTH) return undefined;
  if (CONTROL_CHARS.test(normalized)) return undefined;
  if (ENCODED_TRAVERSAL.test(path)) return undefined;
  if (normalized.startsWith("/") || WINDOWS_DRIVE_PATH.test(normalized)) return undefined;

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return undefined;
  }

  if (isBlockedInternalPath(normalized)) return undefined;
  if (!policy.allowObsidianPlugins && isObsidianPluginPath(normalized)) return undefined;
  if (!policy.allowObsidianConfig && isObsidianConfigPath(normalized)) return undefined;

  return normalized;
}

function isBlockedInternalPath(path: string): boolean {
  const normalized = path.toLowerCase();
  if (isVolatileWorkspacePath(normalized)) return true;

  return [...ALWAYS_BLOCKED_PATHS].some((blockedPath) => (
    normalized === blockedPath || normalized.startsWith(`${blockedPath}/`)
  ));
}

function isVolatileWorkspacePath(path: string): boolean {
  return path.startsWith(".obsidian/workspace") && path.endsWith(".json");
}

function isObsidianPluginPath(path: string): boolean {
  return path === ".obsidian/plugins" || path.startsWith(".obsidian/plugins/");
}

function isObsidianConfigPath(path: string): boolean {
  return path === ".obsidian" || path.startsWith(".obsidian/");
}
