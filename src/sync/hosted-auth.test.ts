import { describe, expect, it } from "vitest";
import { hostedSyncApiBaseUrl } from "./hosted-auth";

describe("hostedSyncApiBaseUrl", () => {
  it("keeps the origin for legacy tenant sync URLs", () => {
    expect(hostedSyncApiBaseUrl("https://sync.obsync.ru/sync/tenants/ten_1"))
      .toBe("https://sync.obsync.ru");
  });

  it("keeps a runtime prefix while stripping the tenant route", () => {
    expect(hostedSyncApiBaseUrl("https://sync.obsync.ru/rt/ru-002/sync/tenants/ten_1"))
      .toBe("https://sync.obsync.ru/rt/ru-002");
  });

  it("keeps already-normalized runtime base URLs", () => {
    expect(hostedSyncApiBaseUrl("https://sync.obsync.ru/rt/ru-002/"))
      .toBe("https://sync.obsync.ru/rt/ru-002");
  });
});
