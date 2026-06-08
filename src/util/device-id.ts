export function createDeviceId(): string {
  return `device-${createRandomId()}`;
}

export function createRandomId(bytes = 16): string {
  const cryptoApi = globalThis.crypto;
  if (bytes >= 16 && cryptoApi && "randomUUID" in cryptoApi) {
    return cryptoApi.randomUUID();
  }

  if (!cryptoApi?.getRandomValues) {
    throw new Error("Secure random API is unavailable");
  }

  const values = new Uint8Array(Math.max(1, bytes));
  cryptoApi.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}
