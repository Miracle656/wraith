import { createContext, createElement, useContext, type ReactNode } from "react";
import type { WraithClient } from "./client";

const WraithClientContext = createContext<WraithClient | null>(null);

/** Props for {@link WraithClientProvider}. */
export interface WraithClientProviderProps {
  /** A client created with `createWraithClient`. */
  client: WraithClient;
  children: ReactNode;
}

/**
 * Provides a Wraith API client to the hooks below it. Place inside (or beside)
 * your React Query `QueryClientProvider`.
 */
export function WraithClientProvider({
  client,
  children,
}: WraithClientProviderProps) {
  return createElement(
    WraithClientContext.Provider,
    { value: client },
    children,
  );
}

/** Read the Wraith client from context. Throws if no provider is present. */
export function useWraithClient(): WraithClient {
  const client = useContext(WraithClientContext);
  if (!client) {
    throw new Error(
      "useWraithClient must be used within a <WraithClientProvider>. " +
        "Wrap your app and pass a client from createWraithClient().",
    );
  }
  return client;
}
