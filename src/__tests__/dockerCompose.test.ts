/**
 * docker-compose.yml against the env contract in .env.example (#194).
 *
 * The point of this file is drift: a key added to .env.example and not to the
 * compose service is exactly the failure the issue describes, and it is silent
 * — the container just starts without it. So the check is derived from
 * .env.example rather than from a hand-maintained list that has to be
 * remembered, and it compares *declared keys*, not substrings: searching the
 * raw text for "SAC_CONTRACT_IDS" is satisfied by "SAC_CONTRACT_IDS_TESTNET",
 * and searching for "CONTRACT_IDS" is satisfied by either, so a substring test
 * passes on a file that declares none of them.
 */

import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";

const ROOT = path.join(__dirname, "../..");
const COMPOSE_PATH = path.join(ROOT, "docker-compose.yml");
const ENV_EXAMPLE_PATH = path.join(ROOT, ".env.example");

/** These files are checked out with CRLF on Windows; anchored matches need LF. */
const read = (file: string): string => readFileSync(file, "utf-8").split("\r\n").join("\n");

/**
 * Keys that belong in .env.example but deliberately not in the dev compose
 * file. Empty today; anything added here needs a reason next to it.
 */
const NOT_IN_COMPOSE = new Set<string>([]);

/** Uncommented `KEY=` lines in .env.example. */
function envExampleKeys(content: string): string[] {
  return [
    ...new Set(
      content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => !line.startsWith("#") && line.includes("="))
        .map((line) => line.split("=")[0].trim())
        .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key)),
    ),
  ];
}

/**
 * Env keys the wraith service declares, from its own `environment:` block.
 *
 * Anchored on `  wraith:` rather than the first `environment:` in the file —
 * the db service has one too, and reading that one silently reports every
 * application key as missing.
 */
function composeEnvKeys(content: string, service = "wraith"): string[] {
  const lines = content.split("\n");
  const serviceAt = lines.findIndex((l) => l === `  ${service}:`);
  if (serviceAt === -1) return [];

  const body = lines.slice(serviceAt + 1);
  const end = body.findIndex((l) => /^ {0,2}\S/.test(l));
  const serviceLines = end === -1 ? body : body.slice(0, end);

  const envAt = serviceLines.findIndex((l) => /^ {4}environment:\s*$/.test(l));
  if (envAt === -1) return [];

  const keys: string[] = [];
  for (const line of serviceLines.slice(envAt + 1)) {
    if (/^ {0,4}\S/.test(line)) break; // back out to the service's own keys
    const match = /^ {6}([A-Z][A-Z0-9_]*):/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

function hasDockerCompose(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("docker-compose.yml", () => {
  const composeContent = read(COMPOSE_PATH);
  const envExampleContent = read(ENV_EXAMPLE_PATH);

  it("does not carry the obsolete top-level version key", () => {
    expect(composeContent).not.toMatch(/^version:/m);
  });

  it("declares every env key .env.example documents", () => {
    const declared = new Set(composeEnvKeys(composeContent));
    // Guard the guard: if the environment block stops being found, every key
    // below would "pass" as missing-from-an-empty-set, so assert it parsed.
    expect(declared.size).toBeGreaterThan(0);

    const missing = envExampleKeys(envExampleContent)
      .filter((key) => !NOT_IN_COMPOSE.has(key))
      .filter((key) => !declared.has(key));

    expect(missing).toEqual([]);
  });

  it("passes each overridable key through from the host environment", () => {
    // A key declared as ${OTHER_NAME:-...} is a typo that silently reads the
    // wrong variable, so the reference has to match the key it is assigned to.
    const passthrough = [
      ...composeContent.matchAll(/^ {6}([A-Z][A-Z0-9_]*):\s*\$\{([A-Z][A-Z0-9_]*)/gm),
    ];
    for (const [, key, ref] of passthrough) expect(ref).toBe(key);
    expect(passthrough.length).toBeGreaterThan(10);
  });

  it("offers redis behind the cache profile, so a plain `up` does not start it", () => {
    expect(composeContent).toMatch(/^ {2}redis:$/m);
    expect(composeContent).toMatch(/profiles:\s*\n\s*- cache/);
  });

  it("declares the dual-network and cache keys the app reads", () => {
    const declared = new Set(composeEnvKeys(composeContent));
    for (const key of [
      "DIRECT_DATABASE_URL",
      "RETENTION_DAYS",
      "STELLAR_NETWORK",
      "NETWORKS",
      "SAC_CONTRACT_IDS",
      "SAC_CONTRACT_IDS_TESTNET",
      "SAC_CONTRACT_IDS_MAINNET",
      "CONTRACT_IDS",
      "CACHE_ENABLED",
      "REDIS_URL",
    ]) {
      expect(declared).toContain(key);
    }
  });

  // Docker is not a prerequisite for the unit suite (integration tests are
  // vitest + Docker), so this is skipped rather than failed when absent.
  const withDocker = hasDockerCompose() ? it : it.skip;
  withDocker("resolves with `docker compose config`", () => {
    const out = execFileSync("docker", ["compose", "config"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
    expect(out).toContain("wraith");
  });
});
