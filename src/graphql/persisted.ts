import { readFileSync } from "fs";
import path from "path";
import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import { GraphQLError } from "graphql";

type AllowList = Record<string, string>;

let allowList: AllowList | null = null;

function allowListPath(): string {
  return path.resolve(
    process.env.PERSISTED_QUERIES_PATH ?? path.join(process.cwd(), "persisted-queries.json")
  );
}

function loadAllowList(): AllowList {
  if (allowList !== null) {
    return allowList;
  }

  try {
    allowList = JSON.parse(readFileSync(allowListPath(), "utf8")) as AllowList;
  } catch {
    allowList = {};
  }

  return allowList;
}

export function getPersistedQuery(hash: string): string | undefined {
  return loadAllowList()[hash];
}

export function resetPersistedQueryCache(): void {
  allowList = null;
}

export const persistedQueryPlugin: ApolloServerPlugin<BaseContext> = {
  async requestDidStart(requestContext) {
    const { request } = requestContext;
    const hash = request?.extensions?.persistedQuery?.sha256Hash;

    if (!hash) {
      if (process.env.NODE_ENV === "production") {
        throw new GraphQLError("Persisted query hash is required in production");
      }
      return;
    }

    const query = getPersistedQuery(hash);
    if (query) {
      request.query = query;
      delete request.extensions?.persistedQuery;
      return;
    }

    if (process.env.NODE_ENV === "production") {
      throw new GraphQLError(`Persisted query not found for hash ${hash}`);
    }
  },
};
