export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const data = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;

  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
