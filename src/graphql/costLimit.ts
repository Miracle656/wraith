import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import { DocumentNode, GraphQLError, Kind, parse, visit } from "graphql";

export interface CostLimitOptions {
  maxDepth?: number;
  maxCost?: number;
  fieldCost?: Record<string, number>;
}

function computeDepth(doc: DocumentNode): number {
  let maxDepth = 0;

  visit(doc, {
    Field(_node, _key, _parent, _path, ancestors) {
      const depth =
        ancestors.filter((ancestor) => {
          if (Array.isArray(ancestor)) {
            return false;
          }

          return (ancestor as { kind?: string }).kind === Kind.FIELD;
        }).length + 1;

      maxDepth = Math.max(maxDepth, depth);
    },
  });

  return maxDepth;
}

function computeCost(doc: DocumentNode, options: CostLimitOptions): number {
  const fieldCost = options.fieldCost ?? {};
  let total = 0;

  visit(doc, {
    Field(node) {
      total += fieldCost[node.name.value] ?? 1;
    },
  });

  return total;
}

export function costLimitPlugin(options: CostLimitOptions = {}): ApolloServerPlugin<BaseContext> {
  const maxDepth = options.maxDepth ?? 10;
  const maxCost = options.maxCost ?? 1000;

  return {
    async requestDidStart(requestContext) {
      const query = requestContext.request?.query;
      if (!query) {
        return;
      }

      let doc: DocumentNode;
      try {
        doc = parse(query);
      } catch {
        return;
      }

      const depth = computeDepth(doc);
      if (depth > maxDepth) {
        throw new GraphQLError(
          `Query depth ${depth} exceeds the maximum allowed depth of ${maxDepth}`
        );
      }

      const cost = computeCost(doc, options);
      if (cost > maxCost) {
        throw new GraphQLError(
          `Query cost ${cost} exceeds the maximum allowed cost of ${maxCost}`
        );
      }
    },
  };
}
