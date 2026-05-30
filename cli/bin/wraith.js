#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { WebSocket } from 'ws';

// Determine the Wraith API base URL from env or default to public hosted instance
const WRAITH_URL = process.env.WRAITH_URL || 'https://api.wraith.veil.co';

const program = new Command();

program
  .name('wraith')
  .description('👻 CLI for Wraith — Stellar Soroban incoming token transfer indexer')
  .version('1.0.0');

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(str, startLength = 6, endLength = 6) {
  if (!str) return 'null';
  if (str.length <= startLength + endLength + 3) return str;
  return `${str.substring(0, startLength)}...${str.substring(str.length - endLength)}`;
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toISOString().replace('T', ' ').substring(0, 19);
  } catch {
    return dateStr;
  }
}

async function apiRequest(endpoint, queryParams = {}, options = {}) {
  const urlObj = new URL(`${WRAITH_URL}${endpoint}`);
  Object.entries(queryParams).forEach(([key, val]) => {
    if (val !== undefined && val !== null && val !== '') {
      urlObj.searchParams.append(key, val);
    }
  });

  try {
    const response = await fetch(urlObj.toString(), options);
    if (!response.ok) {
      let errText = response.statusText;
      try {
        const errJson = await response.json();
        if (errJson && errJson.error) {
          errText = errJson.error;
        }
      } catch {}
      throw new Error(`API Error (${response.status}): ${errText}`);
    }
    return await response.json();
  } catch (err) {
    throw new Error(`Connection to Wraith API failed at ${WRAITH_URL}.\nDetails: ${err.message}`);
  }
}

// ── Command: transfers ────────────────────────────────────────────────────────

program
  .command('transfers')
  .description('Query token transfers for a given Stellar address')
  .requiredOption('-a, --account <address>', 'Stellar G... address to query')
  .option('-c, --contract <id>', 'Filter by token contract ID (C...)')
  .option('-d, --direction <type>', 'Transfer direction: incoming, outgoing, or all', 'all')
  .option('--from-ledger <num>', 'Filter from a specific ledger sequence')
  .option('--to-ledger <num>', 'Filter to a specific ledger sequence')
  .option('--from-date <date>', 'Filter from a specific ISO 8601 date')
  .option('--to-date <date>', 'Filter to a specific ISO 8601 date')
  .option('--event-type <types>', 'Comma-separated event types (transfer,mint,burn,clawback)')
  .option('--limit <limit>', 'Page size limit (default: 50, max: 200)')
  .option('--offset <offset>', 'Pagination offset (default: 0)')
  .option('--json', 'Output raw machine-readable JSON')
  .action(async (options) => {
    try {
      const address = options.account;
      const direction = options.direction.toLowerCase();
      
      let endpoint = `/transfers/address/${address}`;
      if (direction === 'incoming') {
        endpoint = `/transfers/incoming/${address}`;
      } else if (direction === 'outgoing') {
        endpoint = `/transfers/outgoing/${address}`;
      } else if (direction !== 'all') {
        console.error(chalk.red(`Error: Invalid direction "${direction}". Use 'incoming', 'outgoing', or 'all'.`));
        process.exit(1);
      }

      const params = {
        contractId: options.contract,
        fromLedger: options.fromLedger,
        toLedger: options.toLedger,
        fromDate: options.fromDate,
        toDate: options.toDate,
        eventType: options.eventType,
        limit: options.limit,
        offset: options.offset,
      };

      const result = await apiRequest(endpoint, params);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.transfers || result.transfers.length === 0) {
        console.log(chalk.yellow('No transfers found matching the criteria.'));
        return;
      }

      console.log(chalk.bold(`\n👻 Transfers for ${chalk.cyan(address)}`));
      console.log(chalk.gray(`Showing ${result.transfers.length} of ${result.total} total transfers\n`));

      const table = new Table({
        head: [
          chalk.blue('Date (UTC)'),
          chalk.blue('Type'),
          direction === 'all' ? chalk.blue('Dir') : null,
          chalk.blue('From Address'),
          chalk.blue('To Address'),
          chalk.blue('Amount'),
          chalk.blue('Token / Contract'),
          chalk.blue('Ledger'),
          chalk.blue('Tx Hash'),
        ].filter(Boolean),
        colWidths: [21, 10, direction === 'all' ? 10 : null, 18, 18, 16, 18, 10, 14].filter(Boolean),
        wordWrap: true,
      });

      result.transfers.forEach((t) => {
        const typeColor = t.eventType === 'mint' ? chalk.green 
                        : t.eventType === 'burn' ? chalk.red 
                        : t.eventType === 'clawback' ? chalk.red 
                        : chalk.white;
                        
        const dirColor = t.direction === 'incoming' ? chalk.green : chalk.red;

        const row = [
          formatDate(t.ledgerClosedAt),
          typeColor(t.eventType),
          direction === 'all' ? dirColor(t.direction || '') : null,
          truncate(t.fromAddress),
          truncate(t.toAddress),
          chalk.bold(t.displayAmount),
          chalk.cyan(truncate(t.contractId)),
          t.ledger.toString(),
          truncate(t.txHash, 6, 4),
        ].filter(Boolean);

        table.push(row);
      });

      console.log(table.toString());
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// ── Command: summary ──────────────────────────────────────────────────────────

program
  .command('summary <address>')
  .description('Get token balance and transaction activity summaries')
  .option('-c, --contract <id>', 'Filter summary by token contract ID (C...)')
  .option('--from-date <date>', 'Filter from a specific ISO 8601 date')
  .option('--to-date <date>', 'Filter to a specific ISO 8601 date')
  .option('--json', 'Output raw machine-readable JSON')
  .action(async (address, options) => {
    try {
      const params = {
        contractId: options.contract,
        fromDate: options.fromDate,
        toDate: options.toDate,
      };

      const result = await apiRequest(`/summary/${address}`, params);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.tokens || result.tokens.length === 0) {
        console.log(chalk.yellow('No token summary records found for this account.'));
        return;
      }

      console.log(chalk.bold(`\n📊 Token Summary for ${chalk.cyan(address)}`));
      if (result.window?.fromDate || result.window?.toDate) {
        const start = result.window.fromDate ? formatDate(result.window.fromDate) : 'Beginning';
        const end = result.window.toDate ? formatDate(result.window.toDate) : 'Present';
        console.log(chalk.gray(`Timeframe: ${start} to ${end}`));
      }
      console.log();

      const table = new Table({
        head: [
          chalk.blue('Token / Contract'),
          chalk.blue('Total Received'),
          chalk.blue('Total Sent'),
          chalk.blue('Net Flow'),
          chalk.blue('Tx Count'),
        ],
        colWidths: [22, 18, 18, 18, 10],
      });

      result.tokens.forEach((t) => {
        const netFlowBig = BigInt(t.netFlow);
        const netFlowColor = netFlowBig > 0n ? chalk.green : netFlowBig < 0n ? chalk.red : chalk.white;

        table.push([
          chalk.cyan(truncate(t.contractId)),
          t.displayTotalReceived,
          t.displayTotalSent,
          netFlowColor(t.displayNetFlow),
          t.txCount.toString(),
        ]);
      });

      console.log(table.toString());
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// ── Command: watch ────────────────────────────────────────────────────────────

program
  .command('watch <address>')
  .description('Stream live incoming/outgoing transfers for an address via WebSockets')
  .option('-c, --contract <id>', 'Filter events by token contract ID (C...)')
  .option('--json', 'Output live events as raw JSON lines')
  .action((address, options) => {
    const wsUrl = WRAITH_URL.replace(/^http/, 'ws') + `/subscribe/${address}`;

    if (!options.json) {
      console.log(chalk.bold(`\n👀 Watching transfers for ${chalk.cyan(address)}`));
      console.log(chalk.gray(`Connecting to stream at: ${wsUrl}`));
      if (options.contract) {
        console.log(chalk.gray(`Filter: showing only contract ${chalk.cyan(options.contract)}`));
      }
      console.log(chalk.gray('Press Ctrl+C to stop.\n'));
    }

    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      if (!options.json) {
        console.log(chalk.green('⚡ Connection established! Listening for new events...\n'));
      }
    });

    ws.on('message', (data) => {
      try {
        const transfer = JSON.parse(data.toString());

        // Apply contract filter locally if requested
        if (options.contract && transfer.contractId !== options.contract) {
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(transfer));
          return;
        }

        const dateStr = formatDate(transfer.ledgerClosedAt).split(' ')[1] || transfer.ledgerClosedAt;
        const amt = chalk.bold(transfer.displayAmount);
        const token = chalk.cyan(truncate(transfer.contractId, 6, 6));

        let action = '';
        if (transfer.eventType === 'mint') {
          action = `${chalk.green('MINT')} ${amt} ${token} to ${chalk.yellow(truncate(transfer.toAddress))}`;
        } else if (transfer.eventType === 'burn') {
          action = `${chalk.red('BURN')} ${amt} ${token} from ${chalk.yellow(transfer.fromAddress ? truncate(transfer.fromAddress) : 'null')}`;
        } else if (transfer.eventType === 'clawback') {
          action = `${chalk.red('CLAWBACK')} ${amt} ${token} from ${chalk.yellow(transfer.fromAddress ? truncate(transfer.fromAddress) : 'null')}`;
        } else {
          // Standard transfer
          if (transfer.fromAddress === address) {
            action = `${chalk.red('SENT')} ${amt} ${token} -> ${chalk.yellow(truncate(transfer.toAddress))}`;
          } else {
            action = `${chalk.green('RECV')} ${amt} ${token} <- ${chalk.yellow(truncate(transfer.fromAddress))}`;
          }
        }

        console.log(`[${chalk.gray(dateStr)}] Ledger ${chalk.blue(transfer.ledger)} | ${action}`);
      } catch (err) {
        if (!options.json) {
          console.error(chalk.red(`Error processing live event: ${err.message}`));
        }
      }
    });

    ws.on('error', (err) => {
      console.error(chalk.red(`WebSocket Connection Error: ${err.message}`));
      process.exit(1);
    });

    ws.on('close', (code, reason) => {
      if (!options.json) {
        console.log(chalk.yellow(`\n🔌 Connection closed by server (code ${code}): ${reason.toString() || 'No reason specified'}`));
      }
      process.exit(0);
    });

    // Clean exit on Ctrl+C
    process.on('SIGINT', () => {
      ws.close();
      if (!options.json) {
        console.log(chalk.gray('\nStopped watching. Goodbye!'));
      }
      process.exit(0);
    });
  });

// ── Command: webhooks ─────────────────────────────────────────────────────────

const webhooks = program
  .command('webhooks')
  .description('Manage webhook subscriptions (subcommand)');

webhooks
  .command('list')
  .description('List all registered webhooks')
  .option('--json', 'Output raw machine-readable JSON')
  .action(async (options) => {
    try {
      const result = await apiRequest('/webhooks');

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result || result.length === 0) {
        console.log(chalk.yellow('No webhooks registered.'));
        return;
      }

      console.log(chalk.bold('\n🪝  Active Webhooks\n'));
      const table = new Table({
        head: [chalk.blue('ID'), chalk.blue('URL'), chalk.blue('Events'), chalk.blue('Created At')],
        colWidths: [8, 40, 30, 22],
      });

      result.forEach((w) => {
        table.push([
          w.id.toString(),
          w.url,
          w.events ? w.events.join(', ') : 'all',
          formatDate(w.createdAt),
        ]);
      });

      console.log(table.toString());
    } catch (err) {
      if (err.message.includes('404')) {
        console.log(chalk.yellow('\n⚠️  Webhook management is not supported by the current Wraith API server (returned 404).'));
        console.log(chalk.gray('The webhooks command is fully prepared and will function once the REST API endpoints are online.'));
      } else {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    }
  });

webhooks
  .command('create <url>')
  .description('Register a new webhook subscription')
  .option('-e, --events <list>', 'Comma-separated event types to subscribe to (e.g. transfer,mint)')
  .option('--json', 'Output raw machine-readable JSON')
  .action(async (url, options) => {
    try {
      const params = {
        url,
        events: options.events ? options.events.split(',').map(e => e.trim()) : undefined,
      };

      const result = await apiRequest('/webhooks', {}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.green(`\n✅ Webhook successfully created with ID ${chalk.bold(result.id)}!`));
      console.log(chalk.gray(`Subscribed URL: ${chalk.cyan(url)}`));
    } catch (err) {
      if (err.message.includes('404')) {
        console.log(chalk.yellow('\n⚠️  Webhook management is not supported by the current Wraith API server (returned 404).'));
        console.log(chalk.gray('The webhooks command is fully prepared and will function once the REST API endpoints are online.'));
      } else {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    }
  });

webhooks
  .command('delete <id>')
  .description('Delete a webhook subscription')
  .option('--json', 'Output raw machine-readable JSON')
  .action(async (id, options) => {
    try {
      const result = await apiRequest(`/webhooks/${id}`, {}, {
        method: 'DELETE',
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.green(`\n✅ Webhook ID ${chalk.bold(id)} successfully deleted.`));
    } catch (err) {
      if (err.message.includes('404')) {
        console.log(chalk.yellow('\n⚠️  Webhook management is not supported by the current Wraith API server (returned 404).'));
        console.log(chalk.gray('The webhooks command is fully prepared and will function once the REST API endpoints are online.'));
      } else {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    }
  });

program.parse(process.argv);
