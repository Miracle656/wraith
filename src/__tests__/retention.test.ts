import { planPartitionRetention, type PartitionMetadata } from "../jobs/retention";

describe("planPartitionRetention", () => {
  it("compresses older partitions and archives partitions beyond the retention window", () => {
    const now = new Date("2024-12-15T00:00:00.000Z");
    const partitions: PartitionMetadata[] = [
      {
        name: "token_transfers_202406",
        schema: "wraith",
        parentTable: "token_transfers",
        rangeEnd: new Date("2024-06-01T00:00:00.000Z"),
        sizeBytes: 1_024,
      },
      {
        name: "token_transfers_202409",
        schema: "wraith",
        parentTable: "token_transfers",
        rangeEnd: new Date("2024-09-01T00:00:00.000Z"),
        sizeBytes: 2_048,
      },
      {
        name: "token_transfers_202411",
        schema: "wraith",
        parentTable: "token_transfers",
        rangeEnd: new Date("2024-11-01T00:00:00.000Z"),
        sizeBytes: 4_096,
      },
    ];

    const plan = planPartitionRetention(partitions, now, 3, 6);

    expect(plan.compress.map((partition) => partition.name)).toEqual(["token_transfers_202409"]);
    expect(plan.archive.map((partition) => partition.name)).toEqual(["token_transfers_202406"]);
  });
});
