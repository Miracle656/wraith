# @wraith/react-query

Typed [React Query](https://tanstack.com/query) hooks for the
[Wraith](https://github.com/Miracle656/wraith) Soroban token-transfer indexer
and money rails.

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

### Cash-Out Order Flow (`/offramp`)

Order creation and bank verification use `useMutation`, and `useOfframpOrderStatus`
sends the per-order `accessToken` returned by `POST /offramp/orders` as a
`Bearer` token:

```tsx
import {
  useCreateOfframpOrder,
  useOfframpOrderStatus,
  useVerifyOfframpBank,
} from "@wraith/react-query";

const verifyBank = useVerifyOfframpBank();
const createOrder = useCreateOfframpOrder();

// Poll status once `createOrder.data` returns `{ id, accessToken }`:
const orderStatus = useOfframpOrderStatus(
  {
    orderId: createOrder.data?.id ?? "",
    accessToken: createOrder.data?.accessToken ?? "",
  },
  { enabled: Boolean(createOrder.data?.id && createOrder.data?.accessToken) },
);
```

## Hooks

### Queries (`useQuery`)

| Resource  | Hook                       | Endpoint                               |
| --------- | -------------------------- | -------------------------------------- |
| Transfers | `useIncomingTransfers`     | `GET /transfers/incoming/{address}`    |
| Transfers | `useOutgoingTransfers`     | `GET /transfers/outgoing/{address}`    |
| Transfers | `useAddressTransfers`      | `GET /transfers/address/{address}`     |
| Transfers | `useTransactionTransfers`  | `GET /transfers/tx/{txHash}`           |
| Accounts  | `useAccountSummary`        | `GET /accounts/{address}/summary`      |
| Accounts  | `useAccountTransfers`      | `GET /accounts/{address}/transfers`    |
| Assets    | `usePopularAssets`         | `GET /assets/popular`                  |
| NFTs      | `useNftTransfers`          | `GET /nfts/transfers`                  |
| Webhooks  | `useWebhooks`              | `GET /webhooks`                        |
| Webhooks  | `useWebhookDeliveries`     | `GET /webhooks/{id}/deliveries`        |
| Host fns  | `useHostFunctionLogs`      | `GET /host-fn/{contractId}`            |
| Search    | `useSearch`                | `GET /search`                          |
| Candles   | `useCandles`               | `GET /candles/{bucket}/{contractId}`   |
| Fees      | `useFees`                  | `GET /fees`                            |
| Fees      | `useFeeReport`             | `GET /fees/report`                     |
| Offramp   | `useOfframpAvailability`   | `GET /offramp/availability`            |
| Offramp   | `useOfframpRate`           | `GET /offramp/rate`                    |
| Offramp   | `useOfframpTrustline`      | `GET /offramp/trustline`               |
| Offramp   | `useOfframpOrderStatus`    | `GET /offramp/orders/{orderId}`        |
| NGN       | `useNgnCustomerStatus`     | `GET /ngn/customers/status`            |
| NGN       | `useNgnDataBundles`        | `GET /ngn/bills/data-bundles`          |
| NGN       | `useNgnOnrampOrderStatus`  | `GET /ngn/onramp/orders/{orderId}`     |
| NGN       | `useNgnBillStatus`         | `GET /ngn/bills/{orderId}`             |
| Status    | `useStatus`                | `GET /status`                          |

### Mutations (`useMutation`)

| Resource | Hook                    | Endpoint                    |
| -------- | ----------------------- | --------------------------- |
| Offramp  | `useVerifyOfframpBank`  | `POST /offramp/verify-bank` |
| Offramp  | `useCreateOfframpOrder` | `POST /offramp/orders`      |

### Coverage Notes (`openapi.json` vs. Undocumented NGN Routes)

- **Covered from `openapi.json`:** All `/offramp/*`, `/fees`, `/fees/report`, `/search`, `/ngn/customers/status`, and `/ngn/bills/data-bundles` endpoints are typed directly from `src/schema.d.ts`.
- **Single-network OHLC candles (`useCandles`):** `GET /candles/{bucket}/{contractId}` is registered in `src/openapi/build.ts` only when `OHLC_REFRESH_INTERVAL_MS` is set; `useCandles` provides explicit TypeScript types matching `candlesResponseSchema`.
- **NGN order and bill reads (`useNgnOnrampOrderStatus`, `useNgnBillStatus`):** Both hooks strictly require `{ customerRef, orderId }` (`NgnOrderLookupParams`) with no single-identifier shortcut, matching the server's authorization model.
- **Remaining NGN write/rate routes (`#291`):** `POST /ngn/customers`, `POST /ngn/customers/kyc`, `GET /ngn/onramp/rate`, `POST /ngn/onramp/orders`, and `POST /ngn/bills` are listed in `KNOWN_UNDOCUMENTED` in `src/__tests__/openapiCoverage.test.ts` pending OpenAPI schema addition under `#291`.

Each query hook takes its path/query params and an optional React Query `options`
object. Non-2xx responses reject with a `WraithError` (`.status`, `.body`). Use
the exported `queryKeys` factory to invalidate or prefetch:

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
