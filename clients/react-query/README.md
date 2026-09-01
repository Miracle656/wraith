# @wraith/react-query

Typed [React Query](https://tanstack.com/query) hooks for the
[Wraith](https://github.com/Miracle656/wraith) Soroban token-transfer indexer.

The request/response types are **generated from `openapi.json`** with
[`openapi-typescript`](https://openapi-ts.dev/), and the network layer is
[`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) — so the hooks are
fully typed end to end with no hand-maintained models. Regenerate any time the
API changes (see [Regenerating](#regenerating)).

## Install

```bash
npm install @wraith/react-query @tanstack/react-query
```

`@tanstack/react-query` and `react` are peer dependencies.

## Usage

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createWraithClient,
  WraithClientProvider,
  useIncomingTransfers,
  usePopularAssets,
} from "@wraith/react-query";

const queryClient = new QueryClient();
const wraith = createWraithClient({ baseUrl: "https://wraith.example.com" });

function App({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <WraithClientProvider client={wraith}>{children}</WraithClientProvider>
    </QueryClientProvider>
  );
}

function Transfers({ address }: { address: string }) {
  const { data, isLoading, error } = useIncomingTransfers(address, { limit: 100 });
  if (isLoading) return <p>Loading…</p>;
  if (error) return <p>{error.message}</p>; // error is a typed WraithError
  return (
    <ul>
      {data?.transfers?.map((t) => (
        <li key={t.eventId}>
          {t.contractId} {t.displayAmount ?? t.amount}
        </li>
      ))}
    </ul>
  );
}
```

## Hooks

Every list endpoint of the API has a hook:

| Resource  | Hook                                                                            | Endpoint                          |
| --------- | ------------------------------------------------------------------------------ | --------------------------------- |
| Transfers | `useIncomingTransfers`                                                          | `GET /transfers/incoming/{address}` |
| Transfers | `useOutgoingTransfers`                                                          | `GET /transfers/outgoing/{address}` |
| Transfers | `useAddressTransfers`                                                           | `GET /transfers/address/{address}`  |
| Transfers | `useTransactionTransfers`                                                       | `GET /transfers/tx/{txHash}`        |
| Accounts  | `useAccountSummary`                                                             | `GET /accounts/{address}/summary`   |
| Accounts  | `useAccountTransfers`                                                           | `GET /accounts/{address}/transfers` |
| Assets    | `usePopularAssets`                                                              | `GET /assets/popular`               |
| NFTs      | `useNftTransfers`                                                               | `GET /nfts/transfers`               |
| Webhooks  | `useWebhooks`                                                                   | `GET /webhooks`                     |
| Webhooks  | `useWebhookDeliveries`                                                          | `GET /webhooks/{id}/deliveries`     |
| Host fns  | `useHostFunctionLogs`                                                           | `GET /host-fn/{contractId}`         |
| Status    | `useStatus`                                                                     | `GET /status`                       |

Each hook takes its path params, an optional typed `query` object, and an
optional React Query `options` object. Non-2xx responses reject with a
`WraithError` (`.status`, `.body`). Use the exported `queryKeys` factory to
invalidate or prefetch:

```ts
queryClient.invalidateQueries({ queryKey: queryKeys.transfers.all });
```

## Regenerating

The committed `src/schema.d.ts` is generated from the repo's `openapi.json`:

```bash
npm run generate   # openapi-typescript ../../openapi.json -o src/schema.d.ts
```

CI runs this and fails if the committed schema is stale (see
`.github/workflows/react-query-sdk.yml`), so the client never drifts from the
spec.

## Development

```bash
npm install
npm run generate
npm run typecheck
npm test
```
