import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const i18nSource = readFileSync(`${publicDirectory}i18n.js`, "utf8");
const htmlSource = readFileSync(`${publicDirectory}index.html`, "utf8");

interface TranslationCatalog {
  readonly en: Readonly<Record<string, string>>;
  readonly tr: Readonly<Record<string, string>>;
}

interface I18nModule {
  readonly createI18n: (options: {
    readonly storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
    readonly browserLanguages: readonly string[];
  }) => {
    readonly language: "en" | "tr";
    t(key: string, values?: Readonly<Record<string, string>>): string;
    switchLanguage(): "en" | "tr";
  };
}

function translationCatalog(): TranslationCatalog {
  const catalogEnd = i18nSource.indexOf("function detectLanguage");
  expect(catalogEnd).toBeGreaterThan(0);
  const catalogSource = i18nSource
    .slice(0, catalogEnd)
    .replace("const catalogs =", "globalThis.translations =");
  const context: Record<string, unknown> = {};
  vm.createContext(context);
  vm.runInContext(catalogSource, context);
  return context.translations as TranslationCatalog;
}

function loadI18nModule(): I18nModule {
  const context: Record<string, unknown> = {};
  vm.createContext(context);
  vm.runInContext(
    `${i18nSource.replace("export function createI18n", "function createI18n")}\nglobalThis.createI18n = createI18n;`,
    context,
  );
  return context as unknown as I18nModule;
}

describe("retro console localization", () => {
  it("keeps the English and Turkish catalogs aligned", () => {
    const catalog = translationCatalog();
    expect(Object.keys(catalog.en).sort()).toEqual(Object.keys(catalog.tr).sort());
    expect(Object.values(catalog.en).every(Boolean)).toBe(true);
    expect(Object.values(catalog.tr).every(Boolean)).toBe(true);
  });

  it("resolves every HTML localization binding and defaults to global English", () => {
    const catalog = translationCatalog();
    const keys = [...htmlSource.matchAll(/data-i18n(?:-placeholder|-aria|-prompt)?="([^"]+)"/gu)]
      .map((match) => match[1])
      .filter((key): key is string => key !== undefined);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => catalog.en[key] === undefined)).toEqual([]);
    expect(htmlSource).toContain('<html lang="en">');
    expect(htmlSource).toContain('id="language-toggle"');
  });

  it("detects Turkish and persists an explicit language switch", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const i18n = loadI18nModule().createI18n({ storage, browserLanguages: ["tr-TR"] });
    expect(i18n.language).toBe("tr");
    expect(i18n.t("tab.wallet")).toBe("CÜZDAN");
    expect(i18n.switchLanguage()).toBe("en");
    expect(values.get("shadeguard:language")).toBe("en");
  });
});
