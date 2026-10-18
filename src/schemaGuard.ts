/**
 * Deciding whether a refused `prisma db push` is safe to consent to.
 *
 * Separate from index.ts because that module runs `main()` on import — these
 * have to be testable without booting the server.
 */
import { execSync } from "child_process";

/**
 * Run `prisma db push`, keeping the output so the warnings can be read.
 *
 * `stdio: "inherit"` sends them to the console and nowhere else, which is why
 * the earlier version could only treat every refusal identically.
 */
export function pushSchema(extraArgs = ""): { ok: true } | { ok: false; output: string } {
  const command = `npx prisma db push${extraArgs ? ` ${extraArgs}` : ""}`;
  try {
    const out = execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    process.stdout.write(out);
    return { ok: true };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    process.stdout.write(output);
    return { ok: false, output };
  }
}

/**
 * True when every data-loss warning Prisma raised is an added unique
 * constraint, and there is at least one.
 *
 * Strict on purpose: an empty warning list returns false, so a failure with no
 * warnings at all — a connection error, a syntax error — is never mistaken for
 * something worth consenting to. The bullets look like:
 *
 *   • A unique constraint covering the columns `[network,publicId]` on the
 *     table `OfframpOrder` will be added. If there are existing duplicate
 *     values, this will fail.
 */
export function onlyAddsUniqueConstraints(output: string): boolean {
  const warnings = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("•"));

  if (warnings.length === 0) return false;
  return warnings.every((line) => /unique constraint .* will be added/i.test(line));
}

