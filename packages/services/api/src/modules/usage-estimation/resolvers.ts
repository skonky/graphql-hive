import { format } from 'date-fns';
import { GraphQLError } from 'graphql';
import { AuthManager } from '../auth/providers/auth-manager';
import { OrganizationAccessScope } from '../auth/providers/organization-access';
import { BillingProvider } from '../billing/providers/billing.provider';
import { RateLimitProvider } from '../rate-limit/providers/rate-limit.provider';
import { IdTranslator } from '../shared/providers/id-translator';
import { UsageEstimationModule } from './__generated__/types';
import { UsageEstimationProvider } from './providers/usage-estimation.provider';

export const resolvers: UsageEstimationModule.Resolvers = {
  Query: {
    async usageEstimation(_, args, { injector }) {
      const organizationId = await injector.get(IdTranslator).translateOrganizationId({
        organization: args.input.organization,
      });

      await injector.get(AuthManager).ensureOrganizationAccess({
        organization: organizationId,
        scope: OrganizationAccessScope.SETTINGS,
      });

      const billingRecord = await injector
        .get(BillingProvider)
        .getOrganizationBillingParticipant({ organization: organizationId });
      const organizationBillingCycleDay = billingRecord
        ? await injector
            .get(BillingProvider)
            .billingInfo(billingRecord)
            .then(r => r.renewalDay ?? 1)
        : 1;

      const window = await injector.get(RateLimitProvider).getWindow(organizationBillingCycleDay);
      const result = await injector.get(UsageEstimationProvider).estimateOperationsForOrganization({
        organizationId: organizationId,
        start: format(window.start, 'yyyyMMdd'),
        end: format(window.end, 'yyyyMMdd'),
      });

      if (!result && result !== 0) {
        throw new GraphQLError(`Failed to estimate usage, please try again later.`);
      }

      return {
        operations: result,
        periodStart: format(window.start, 'yyyy-MM-dd'),
        periodEnd: format(window.end, 'yyyy-MM-dd'),
      };
    },
  },
};
