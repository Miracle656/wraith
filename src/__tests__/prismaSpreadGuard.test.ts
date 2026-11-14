import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import type { Prisma } from "@prisma/client";
import { when } from "../prismaWhen";

/**
 * AST scanner that detects raw conditional spreads (`...(cond ? a : b)` or
 * `...(cond && a)`) inside Prisma `data`, `create`, `update`, or `where`
 * objects.
 *
 * Why this exists (#292):
 * TypeScript widens `{ ...(cond ? { wrongField: 123 } : {}) }` to an optional
 * union `{ wrongField?: number }`, which bypasses excess-property checking when
 * assigned to a Prisma input type whose fields are all optional. Using
 * `when<Prisma.SomeInput>(cond, { ... })` forces excess-property and value-type
 * checking at the call site before the spread happens.
 */
const PRISMA_OBJECT_PROP_NAMES = new Set(["data", "create", "update", "where"]);
const PRISMA_VAR_NAME_PATTERNS = /^(where|baseWhere|data|updateData|createData)$/;

export interface SpreadViolation {
  file: string;
  line: number;
  column: number;
  snippet: string;
}

function isUnsafePrismaSpread(node: ts.SpreadAssignment): boolean {
  let expr: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }
  if (ts.isConditionalExpression(expr)) {
    return true;
  }
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return true;
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "when" &&
    (!expr.typeArguments || expr.typeArguments.length === 0)
  ) {
    return true;
  }
  return false;
}

function isInsidePrismaPayloadObject(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name)) {
      if (PRISMA_OBJECT_PROP_NAMES.has(current.name.text)) {
        return true;
      }
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      if (PRISMA_VAR_NAME_PATTERNS.test(current.name.text)) {
        return true;
      }
      if (current.type && current.type.getText().includes("Prisma.")) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

export function findRawPrismaConditionalSpreadsInSource(
  sourceText: string,
  fileName = "snippet.ts",
): SpreadViolation[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: SpreadViolation[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isSpreadAssignment(node) &&
      isUnsafePrismaSpread(node) &&
      isInsidePrismaPayloadObject(node)
    ) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      violations.push({
        file: fileName,
        line: line + 1,
        column: character + 1,
        snippet: node.getText(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function collectTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("when<Target>() typed conditional spread helper (#292)", () => {
  it("returns the patch when the condition is truthy and an empty object when falsy", () => {
    const present = when<Prisma.NgnOrderUpdateInput>(true, {
      settledNGN: "5000",
    });
    expect(present).toEqual({ settledNGN: "5000" });

    const absent = when<Prisma.NgnOrderUpdateInput>(false, {
      settledNGN: "5000",
    });
    expect(absent).toEqual({});
  });

  it("rejects misspelled and mis-typed Prisma fields at compile time via @ts-expect-error", () => {
    const x: number | undefined = 5000;

    // 1. Valid fields and types compile cleanly:
    const validData: Prisma.NgnOrderUpdateInput = {
      status: "completed",
      ...when<Prisma.NgnOrderUpdateInput>(x != null, {
        settledNGN: String(x),
      }),
    };
    expect(validData).toEqual({ status: "completed", settledNGN: "5000" });

    // 2. Misspelled (`settledNgn`) or nonexistent (`depositTxHash` on NgnOrder)
    //    fields are rejected at compile time:
    const invalidFieldsPatch = when<Prisma.NgnOrderUpdateInput>(
      x != null,
      // @ts-expect-error — settledNgn (wrong casing) and depositTxHash (not on NgnOrder) must fail typecheck
      { settledNgn: 5000, depositTxHash: "0x1" },
    );
    expect(invalidFieldsPatch).toBeDefined();

    // 3. Wrong value type (`number` instead of `string` for `settledNGN`) is rejected:
    const invalidValueTypePatch = when<Prisma.NgnOrderUpdateInput>(
      x != null,
      // @ts-expect-error — settledNGN on NgnOrderUpdateInput is string | null, not number
      { settledNGN: 5000 },
    );
    expect(invalidValueTypePatch).toBeDefined();

    // 4. Omitting `<Target>` (`when(cond, { ... })`) is also rejected so callers cannot
    //    accidentally infer `Target` from the untyped object literal itself:
    const omittedTypeArgPatch = when(
      x != null,
      // @ts-expect-error — explicit `<Prisma.ModelInput>` type argument is required
      { settledNGN: "5000" },
    );
    expect(omittedTypeArgPatch).toBeDefined();
  });

  it("catches raw ...(cond ? { ... } : {}) spreads and untyped when() calls in Prisma data/where objects via the AST scanner", () => {
    const badSnippet = `
      import { prisma } from "../db";
      export async function badUpdate(x?: number) {
        await prisma.ngnOrder.update({
          where: { id: 1 },
          data: {
            status: "completed",
            ...(x != null ? { settledNgn: 5000, depositTxHash: "0x1" } : {}),
          },
        });
      }
    `;
    const violations = findRawPrismaConditionalSpreadsInSource(badSnippet, "badSnippet.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.snippet).toContain("settledNgn: 5000");

    const untypedWhenSnippet = `
      import { prisma } from "../db";
      import { when } from "../prismaWhen";
      export async function untypedUpdate(x?: number) {
        await prisma.ngnOrder.update({
          where: { id: 1 },
          data: {
            status: "completed",
            ...when(x != null, { settledNgn: 5000 }),
          },
        });
      }
    `;
    expect(findRawPrismaConditionalSpreadsInSource(untypedWhenSnippet, "untypedWhenSnippet.ts")).toHaveLength(1);

    const goodSnippet = `
      import { Prisma } from "@prisma/client";
      import { prisma } from "../db";
      import { when } from "../prismaWhen";
      export async function goodUpdate(x?: number) {
        await prisma.ngnOrder.update({
          where: { id: 1 },
          data: {
            status: "completed",
            ...when<Prisma.NgnOrderUpdateInput>(x != null, { settledNGN: String(x) }),
          },
        });
      }
    `;
    expect(findRawPrismaConditionalSpreadsInSource(goodSnippet, "goodSnippet.ts")).toEqual([]);
  });

  it("ensures no production file under src/ uses a raw conditional spread inside a Prisma data or where object", () => {
    const srcRoot = path.resolve(__dirname, "..");
    const files = collectTsFiles(srcRoot);
    const allViolations: SpreadViolation[] = [];

    for (const file of files) {
      const rel = path.relative(srcRoot, file);
      const content = fs.readFileSync(file, "utf8");
      allViolations.push(...findRawPrismaConditionalSpreadsInSource(content, rel));
    }

    expect(allViolations).toEqual([]);
  });
});
