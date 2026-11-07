import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DOMAIN_ROOT = resolve(import.meta.dir, "../../../src/wagering/domain");
const ALLOWED_PACKAGES = new Set(["node:crypto"]);

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });

const importsOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].flatMap(([, source]) => (source ? [source] : []));

describe("domain isolation", () => {
  const files = sourceFiles(DOMAIN_ROOT);

  test("finds the domain files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test.each(files)("%s does not depend on frameworks or databases", (file) => {
    const external = importsOf(file).filter((source) => !source.startsWith("."));

    expect(external.filter((source) => !ALLOWED_PACKAGES.has(source))).toEqual([]);
  });

  test.each(files)("%s imports nothing outside the domain", (file) => {
    const outside = importsOf(file)
      .filter((source) => source.startsWith("."))
      .map((source) => resolve(dirname(file), source))
      .filter((path) => !path.startsWith(DOMAIN_ROOT));

    expect(outside).toEqual([]);
  });

  test.each(files)("%s uses no decorators", (file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(/^\s*@\w+/m);
  });
});

describe("money", () => {
  test("no monetary value is typed as number", () => {
    const offenders = sourceFiles(DOMAIN_ROOT).filter((file) =>
      /\b(amount|balance|money|cents)\w*\s*[?]?:\s*number\b/i.test(readFileSync(file, "utf8")),
    );

    expect(offenders).toEqual([]);
  });
});
