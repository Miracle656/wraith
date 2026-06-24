/**
 * Tests for GraphQL server and resolvers.
 */

import { createGraphQLServer } from "../api/graphql";
import { ApolloServer } from "@apollo/server";

describe("GraphQL Server", () => {
  it("should create a valid GraphQL server", () => {
    const server = createGraphQLServer();
    expect(server).toBeDefined();
    expect(server instanceof ApolloServer).toBe(true);
  });
});
