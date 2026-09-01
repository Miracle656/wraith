import { PrismaClient, Prisma } from "@prisma/client";

export interface RouterOptions {
  replicaUrls: string[];
  healthCheckIntervalMs?: number;
}

export function withReadReplicas(primary: PrismaClient, options: RouterOptions) {
  if (options.replicaUrls.length === 0) {
    return primary;
  }

  const replicas = options.replicaUrls.map((url) => ({
    client: new PrismaClient({ datasourceUrl: url }),
    healthy: true,
  }));

  let currentIndex = 0;

  function getReplica(): PrismaClient {
    const healthyReplicas = replicas.filter((r) => r.healthy);
    if (healthyReplicas.length === 0) {
      return primary;
    }
    const replica = healthyReplicas[currentIndex % healthyReplicas.length].client;
    currentIndex = (currentIndex + 1) % healthyReplicas.length;
    return replica;
  }

  // Health check loop
  const interval = setInterval(async () => {
    for (const replica of replicas) {
      try {
        await replica.client.$queryRaw`SELECT 1`;
        replica.healthy = true;
      } catch (err) {
        replica.healthy = false;
        console.warn(`[Router] Replica health check failed, marking unhealthy.`);
      }
    }
  }, options.healthCheckIntervalMs ?? 10000);

  // Allow process to exit without waiting for interval
  if (interval.unref) {
    interval.unref();
  }

  // Intercept reads and route them
  const extension = primary.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const isRead = [
            "findUnique",
            "findUniqueOrThrow",
            "findFirst",
            "findFirstOrThrow",
            "findMany",
            "count",
            "aggregate",
            "groupBy",
          ].includes(operation);

          if (isRead) {
            const context = Prisma.getExtensionContext(this);
            const isTransaction = !("$transaction" in context);

            if (!isTransaction) {
              const replica = getReplica();
              if (replica !== primary) {
                try {
                  return await (replica as any)[model][operation](args);
                } catch (error) {
                  // Fallback to primary on immediate query failure
                  return query(args);
                }
              }
            }
          }

          return query(args);
        },
      },
    },
  });

  return extension as unknown as PrismaClient;
}
