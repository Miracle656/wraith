#!/usr/bin/env node
import "dotenv/config";
import { runBackfill } from "./ingest/backfill";

const USAGE = `Usage:
  ts-node src/cli.ts backfill --from <ledger> --to <ledger> [options]

Options:
  --from <num>          Start ledger (inclusive, required)
  --to <num>            End ledger (exclusive, required)
  --chunk-size <num>    Ledgers per chunk (default: 64)
  --concurrency <num>   Parallel chunks (default: 4)
  --force               Ignore existing cursor and restart

Environment:
  SOROBAN_RPC_URL       Stellar RPC endpoint
  STELLAR_NETWORK       testnet | mainnet
  SAC_CONTRACT_IDS      Comma-separated C... addresses
  EVENTS_BATCH_SIZE     Max events per RPC call (default: 10000)
`;

function parseArgs(argv: string[]): Record<string, string | number | boolean> {
  const args: Record<string, string | number | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        const num = Number(val);
        args[key] = Number.isFinite(num) ? num : val;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function cmdBackfill(
  fromLedger: number,
  toLedger: number,
  chunkSize: number | undefined,
  concurrency: number | undefined,
  force: boolean,
  signal: AbortSignal,
): Promise<void> {
  if (fromLedger >= toLedger) {
    console.error("ERROR: --from must be less than --to.\n");
    process.exit(1);
  }

  await runBackfill({ fromLedger, toLedger, chunkSize, concurrency, signal, force });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "backfill": {
      const stop = new AbortController();
      process.on("SIGINT", () => { console.log("\n[cli] SIGINT received — draining…"); stop.abort(); });
      process.on("SIGTERM", () => { console.log("\n[cli] SIGTERM received — draining…"); stop.abort(); });

      const args = parseArgs(rest);
      const fromLedger = args.from as number | undefined;
      const toLedger = args.to as number | undefined;

      if (fromLedger === undefined || toLedger === undefined) {
        console.error("ERROR: --from and --to are required.\n");
        console.error(USAGE);
        process.exit(1);
      }

      await cmdBackfill(
        fromLedger,
        toLedger,
        (args["chunk-size"] as number) || undefined,
        (args.concurrency as number) || undefined,
        args.force === true,
        stop.signal,
      );
      break;
    }
    default:
      console.error(`Unknown command: ${cmd ?? "(none)"}\n`);
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[cli] Fatal error:", err);
  process.exit(1);
});
