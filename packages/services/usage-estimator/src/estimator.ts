import { ClickHouse, HttpClient, OperationsReader, sql } from '@hive/api';
import type { ServiceLogger } from '@hive/service-common';

export type Estimator = ReturnType<typeof createEstimator>;

export function createEstimator(config: {
  logger: ServiceLogger;
  clickhouse: {
    protocol: string;
    host: string;
    port: number;
    username: string;
    password: string;
    onReadEnd?: (
      label: string,
      timings: {
        totalSeconds: number;
        elapsedSeconds?: number;
      },
    ) => void;
  };
}) {
  const { logger } = config;
  const httpClient = new HttpClient();
  const clickhouse = new ClickHouse(config.clickhouse, httpClient, config.logger);
  const operationsReader = new OperationsReader(clickhouse, logger);

  return {
    readiness() {
      return true;
    },
    async start() {
      logger.info('Usage Estimator started');
    },
    async stop() {
      logger.info('Usage Estimator stopped');
    },
    async estimateOperationsForAllTargets(input: { startTime: Date; endTime: Date }) {
      const filter = operationsReader.createFilter({
        period: {
          from: input.startTime,
          to: input.endTime,
        },
      });

      return await clickhouse.query<{
        total: string;
        target: string;
      }>({
        query: sql`
          SELECT
            target,
            sum(total) as total
          FROM operations_hourly
          ${filter}
          GROUP BY target
        `,
        queryId: 'usage_estimator_count_operations_all',
        timeout: 60_000,
      });
    },
    async estimateCollectedOperationsForOrganization(input: {
      organizationId: string;
      start: string; // YYYYMMDD
      end: string; // YYYYMMDD
    }) {
      return await clickhouse.query<{
        total: string;
      }>({
        query: sql`
          SELECT 
            sum(total) as total
          FROM daily_overview
          PREWHERE organization = ${input.organizationId} AND toYYYYMMDD(date) BETWEEN ${input.start} AND ${input.end}
          GROUP BY organization
        `,
        queryId: 'usage_estimator_count_operations',
        timeout: 15_000,
      });
    },
  };
}
