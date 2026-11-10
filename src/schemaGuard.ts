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

/**
 * True when `prisma db push` failed because it could not reach the database,
 * as opposed to reaching it and being refused.
 *
 * The two used to be indistinguishable to the caller, and both were logged as
 * `refused_destructive`. They need opposite responses. A refusal is permanent
 * until someone changes the schema, so exiting is right. An unreachable
 * database is usually temporary, and exiting is what turned one into a trap on
 * 2026-11-10: the running instance was starving the database, so every deploy
 * carrying the fix failed its first connection, exited, and left the starving
 * instance in place.
 *
 *   P1001  Can't reach database server
 *   P1002  The database server was reached but timed out
 *   P1008  Operations timed out
 *   P1017  Server has closed the connection
 */
export function isDatabaseUnreachable(output: string): boolean {
  return /\bP10(01|02|08|17)\b/.test(output) || /can't reach database server/i.test(output);
}
