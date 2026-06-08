import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  getLanguage: () => "en",
}));

import { MESSAGES, resolveLanguage, t } from "./i18n";

describe("resolveLanguage", () => {
  it("returns ru for ru-RU", () => {
    expect(resolveLanguage("ru-RU")).toBe("ru");
  });

  it("returns ru for ru-BY", () => {
    expect(resolveLanguage("ru-BY")).toBe("ru");
  });

  it("returns en for non-ru locales", () => {
    expect(resolveLanguage("en-US")).toBe("en");
    expect(resolveLanguage("de-DE")).toBe("en");
  });

  it("defaults to en on unknown language", () => {
    expect(resolveLanguage("zz-ZZ")).toBe("en");
  });
});

describe("t", () => {
  it("interpolates variables", () => {
    const label = t("duration_seconds", { count: 5 });
    expect(label).toBe("5 sec");
  });

  it("falls back to interpolation markers for unknown vars", () => {
    const label = t("status_not_started", { value: "ignore" } as never);
    expect(label).toBe("not started");
  });

  it("uses Russian locale for Russian-like language tags", () => {
    expect(resolveLanguage("RU-ru")).toBe("ru");
  });

  it("keeps Russian error copy translated", () => {
    expect(MESSAGES.ru.ui_error_message).toBe("ошибка: {{message}}");
    expect(MESSAGES.en.notice_upload_before_publish_error).not.toContain("item");
    expect(MESSAGES.ru.notice_upload_before_publish_error).not.toContain("item");
  });

  it("does not contain malformed interpolation markers", () => {
    for (const dictionary of Object.values(MESSAGES)) {
      for (const message of Object.values(dictionary)) {
        expect(message).not.toMatch(/\{\{[a-zA-Z0-9_]+}(?!})/);
      }
    }
  });
});
