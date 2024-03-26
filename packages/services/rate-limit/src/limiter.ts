import { addMonths, endOfDay, format, setDate, startOfDay, subMonths } from 'date-fns';
import LRU from 'tiny-lru';
import type { ServiceLogger } from '@hive/service-common';
import { createStorage as createPostgreSQLStorage, Interceptor } from '@hive/storage';
import type { UsageEstimatorApi } from '@hive/usage-estimator';
import { createTRPCProxyClient, httpLink } from '@trpc/client';
import { createOrganizationConfigStore, DEFAULT_RETENTION } from './config-store';
import { createEmailScheduler } from './emails';
import { createOrganizationIdStore } from './id-store';
import { rateLimitOperationsEventOrg } from './metrics';

export type RateLimitCheckResponse = {
  /**
   * An indicator that refers to the hard-limit state of the org.
   * If this is set to "true" -> usage is limited and no data is processed.
   */
  limited: boolean;
  /**
   * An indicator that tells about the usage of the org. We are using that for UI indicators.
   * This is a number between 0-1 (or higher in case of non-limited orgs)
   */
  usagePercentage: number;
  /**
   * The quota of the org.
   */
  quota: number;
  /**
   * The current usage of the org.
   */
  current: number;
};

const UNKNOWN_RATE_LIMIT_OBJ: RateLimitCheckResponse = {
  current: -1,
  quota: -1,
  usagePercentage: 0,
  limited: false,
};

export type CachedRateLimitInfo = {
  operations: RateLimitCheckResponse;
  retentionInDays: number;
};

export type Limiter = ReturnType<typeof createRateLimiter>;

type RateLimitWindow = {
  start: Date;
  end: Date;
};

export function createRateLimiter(config: {
  logger: ServiceLogger;
  usageEstimator: {
    endpoint: string;
  };
  emails?: {
    endpoint: string;
  };
  storage: {
    connectionString: string;
    additionalInterceptors?: Interceptor[];
  };
}) {
  const usageEstimator = createTRPCProxyClient<UsageEstimatorApi>({
    links: [
      httpLink({
        url: `${config.usageEstimator.endpoint}/trpc`,
        fetch,
      }),
    ],
  });
  const emails = createEmailScheduler(config.emails);
  const cache = LRU<CachedRateLimitInfo>(1000, 60_000);
  const { logger } = config;
  const postgres$ = createPostgreSQLStorage(
    config.storage.connectionString,
    1,
    config.storage.additionalInterceptors,
  );
  const orgConfigStore = createOrganizationConfigStore({
    postgres$,
    cache: {
      max: 1000,
      ttl: 60_000,
    },
  });
  const idStore = createOrganizationIdStore({ postgres$, logger, refreshIntervalMs: 30_000 });

  return {
    logger,
    async readiness() {
      return await (await postgres$).isReady();
    },
    async getRetention(targetId: string) {
      const orgId = await idStore.lookup(targetId);

      if (!orgId) {
        return DEFAULT_RETENTION;
      }

      const orgConfig = await orgConfigStore.get(orgId);

      return orgConfig.retentionInDays;
    },
    targetIdToOrgId(targetId: string) {
      return idStore.lookup(targetId);
    },
    async checkLimit(organizationId: string): Promise<RateLimitCheckResponse> {
      const orgConfig = await orgConfigStore.get(organizationId);
      console.log('orgConfig', organizationId, orgConfig);

      if (!orgConfig) {
        return UNKNOWN_RATE_LIMIT_OBJ;
      }

      const window = buildRateLimitWindow(orgConfig.billingCycleDay);
      console.log('window', window);
      const orgData = cache.get(organizationId);
      console.log('orgData in cache?', orgData);

      if (orgData) {
        return orgData.operations;
      }

      try {
        console.log('fetching rate limit info from source...');

        const actualUsage = await usageEstimator.estimateOperationsForOrganization.query({
          organizationId,
          start: format(window.start, 'yyyyMMdd'),
          end: format(window.end, 'yyyyMMdd'),
        });
        const noLimits = orgConfig.plan === 'ENTERPRISE' || orgConfig.limit === 0;
        const isLimited = noLimits ? false : actualUsage > orgConfig.limit;
        const usagePercentage = actualUsage / orgConfig.limit;

        console.log({
          noLimits,
          isLimited,
          actualUsage,
          usagePercentage,
        });

        const rateLimitData: CachedRateLimitInfo = {
          operations: {
            current: actualUsage,
            quota: orgConfig.limit,
            limited: isLimited,
            usagePercentage,
          },
          retentionInDays: orgConfig.retentionInDays,
        };

        if (usagePercentage >= 1) {
          rateLimitOperationsEventOrg
            .labels({ orgId: organizationId, orgName: orgConfig.name })
            .inc();
          logger.info(
            `Organization "${orgConfig.name}"/"${organizationId}" is now being rate-limited for operations (${actualUsage}/${orgConfig.limit})`,
          );

          emails.limitExceeded({
            organization: {
              id: organizationId,
              cleanId: orgConfig.cleanId,
              name: orgConfig.name,
              email: orgConfig.ownerEmail,
            },
            period: {
              start: window.start.getTime(),
              end: window.end.getTime(),
            },
            usage: {
              quota: orgConfig.limit,
              current: actualUsage,
            },
          });
        } else if (usagePercentage >= 0.9) {
          emails.limitWarning({
            organization: {
              id: organizationId,
              cleanId: orgConfig.cleanId,
              name: orgConfig.name,
              email: orgConfig.ownerEmail,
            },
            period: {
              start: window.start.getTime(),
              end: window.end.getTime(),
            },
            usage: {
              quota: orgConfig.limit,
              current: actualUsage,
            },
          });
        }

        cache.set(organizationId, rateLimitData);

        return rateLimitData.operations;
      } catch (e) {
        return UNKNOWN_RATE_LIMIT_OBJ;
      }
    },
    async start() {
      await idStore.start();
      logger.info(`Rate-limit service starting...`);
    },
    async stop() {
      logger.info('Stopping service...');
      idStore.stop();
      await (await postgres$).destroy();
      logger.info('Rate-limit service stopped');
    },
  };
}

export function buildRateLimitWindow(billingCycleDay: number): RateLimitWindow {
  const now = new Date();
  const currentMonthCycleDate = setDate(now, billingCycleDay);
  const range =
    currentMonthCycleDate > now
      ? {
          start: startOfDay(subMonths(currentMonthCycleDate, 1)),
          end: endOfDay(currentMonthCycleDate),
        }
      : {
          start: startOfDay(currentMonthCycleDate),
          end: endOfDay(addMonths(currentMonthCycleDate, 1)),
        };

  return {
    start: range.start,
    end: range.end,
  };
}
