/**
 * The boot-time schema guard.
 *
 * It decides whether a refused `prisma db push` is safe to consent to. Getting
 * that wrong in either direction is expensive: too strict and the service sits
 * in a crash loop over a harmless index (which happened); too loose and a
 * column of offramp orders — records of real naira paid to real bank accounts —
 * disappears during a routine deploy.
 */
import { onlyAddsUniqueConstraints } from "../schemaGuard";

/** Verbatim from the Render deploy that put wraith in a crash loop. */
const ADDED_UNIQUE_CONSTRAINT = `
⚠️  There might be data loss when applying the changes:

  • A unique constraint covering the columns \`[network,publicId]\` on the table \`OfframpOrder\` will be added. If there are existing duplicate values, this will fail.


Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss
`;

describe("onlyAddsUniqueConstraints", () => {
  it("consents to an added unique constraint", () => {
    // Nothing is dropped: the index either builds or fails on a duplicate.
    expect(onlyAddsUniqueConstraints(ADDED_UNIQUE_CONSTRAINT)).toBe(true);
  });

  it("consents when every warning is an added constraint", () => {
    const output = `
⚠️  There might be data loss when applying the changes:

  • A unique constraint covering the columns \`[network,publicId]\` on the table \`OfframpOrder\` will be added. If there are existing duplicate values, this will fail.
  • A unique constraint covering the columns \`[network,orderId]\` on the table \`NgnOrder\` will be added. If there are existing duplicate values, this will fail.
`;
    expect(onlyAddsUniqueConstraints(output)).toBe(true);
  });

  // The reason the guard exists.
  it("refuses a dropped column", () => {
    const output = `
⚠️  There might be data loss when applying the changes:

  • You are about to drop the column \`settledNGN\` on the \`OfframpOrder\` table, which still contains 412 non-null values.
`;
    expect(onlyAddsUniqueConstraints(output)).toBe(false);
  });

  // The dangerous case: one real drop hiding behind something harmless. All or
  // nothing is what makes this safe.
  it("refuses a drop even when an added constraint is alongside it", () => {
    const output = `
⚠️  There might be data loss when applying the changes:

  • A unique constraint covering the columns \`[network,publicId]\` on the table \`OfframpOrder\` will be added. If there are existing duplicate values, this will fail.
  • You are about to drop the column \`depositTxHash\` on the \`OfframpOrder\` table, which still contains 97 non-null values.
`;
    expect(onlyAddsUniqueConstraints(output)).toBe(false);
  });

  it("refuses a narrowed column type", () => {
    const output = `
⚠️  There might be data loss when applying the changes:

  • You are about to alter the column \`amountNGN\` on the \`OfframpOrder\` table, which contains 412 non-null values. The data in that column will be cast from \`Text\` to \`Decimal(10,2)\`.
`;
    expect(onlyAddsUniqueConstraints(output)).toBe(false);
  });

  // A failure with no warnings is not a data-loss refusal at all — it is a
  // connection error, a bad DATABASE_URL, a syntax error. Consenting to those
  // would retry with --accept-data-loss for no reason.
  it("refuses when there are no warnings to read", () => {
    expect(onlyAddsUniqueConstraints("")).toBe(false);
    expect(
      onlyAddsUniqueConstraints("Error: P1001: Can't reach database server at `db:5432`"),
    ).toBe(false);
  });
});
