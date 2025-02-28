import { useCallback } from 'react';
import Link from 'next/link';
import { LogOutIcon } from 'lucide-react';
import { useMutation, useQuery } from 'urql';
import { authenticated } from '@/components/authenticated-container';
import { Title } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { DottedBackground } from '@/components/ui/dotted-background';
import { DataWrapper } from '@/components/v2';
import { HiveLogo } from '@/components/v2/icon';
import { graphql } from '@/gql';
import { useNotifications } from '@/lib/hooks/use-notifications';
import { useRouteSelector } from '@/lib/hooks/use-route-selector';

const JoinOrganizationPage_JoinOrganizationMutation = graphql(`
  mutation JoinOrganizationPage_JoinOrganizationMutation($code: String!) {
    joinOrganization(code: $code) {
      __typename
      ... on OrganizationPayload {
        selector {
          organization
        }
        organization {
          id
          name
          cleanId
        }
      }
      ... on OrganizationInvitationError {
        message
      }
    }
  }
`);

const JoinOrganizationPage_OrganizationInvitationQuery = graphql(`
  query JoinOrganizationPage_OrganizationInvitationQuery($code: String!) {
    organizationByInviteCode(code: $code) {
      __typename
      ... on OrganizationInvitationPayload {
        name
      }
      ... on OrganizationInvitationError {
        message
      }
    }
  }
`);

function JoinOrganizationPage() {
  const router = useRouteSelector();
  const notify = useNotifications();
  const code = router.query.inviteCode as string;
  const [query] = useQuery({
    query: JoinOrganizationPage_OrganizationInvitationQuery,
    variables: { code },
  });
  const [mutation, mutate] = useMutation(JoinOrganizationPage_JoinOrganizationMutation);
  const accept = useCallback(async () => {
    const result = await mutate({ code });
    if (result.data) {
      if (result.data.joinOrganization.__typename === 'OrganizationInvitationError') {
        notify(result.data.joinOrganization.message, 'error');
      } else {
        const org = result.data.joinOrganization.organization;
        notify(`You joined "${org.name}" organization`, 'success');
        void router.visitOrganization({ organizationId: org.cleanId });
      }
    }
  }, [mutate, code, router, notify]);

  const goBack = useCallback(() => {
    void router.visitHome();
  }, [router]);

  return (
    <>
      <Title title="Invitation" />
      <DottedBackground>
        <Button
          variant="outline"
          onClick={() => router.push('/logout')}
          className="absolute right-6 top-6"
        >
          <LogOutIcon className="mr-2 size-4" /> Sign out
        </Button>
        <Link href="/" className="absolute left-6 top-6">
          <HiveLogo className="size-10" />
        </Link>
        <div className="container md:w-3/5 lg:w-1/2">
          <DataWrapper query={query}>
            {({ data }) => {
              if (data.organizationByInviteCode == null) {
                return null;
              }
              const invitation = data.organizationByInviteCode;

              if (invitation.__typename === 'OrganizationInvitationError') {
                return (
                  <div className="bg-black">
                    <Card>
                      <CardHeader>
                        <CardTitle>Invitation Error</CardTitle>
                      </CardHeader>
                      <CardContent>{invitation.message}</CardContent>
                      <CardFooter>
                        <Button className="w-full" onClick={goBack}>
                          Back to Hive
                        </Button>
                      </CardFooter>
                    </Card>
                  </div>
                );
              }

              return (
                <div className="bg-black">
                  <Card>
                    <CardHeader>
                      <CardTitle>Join "{invitation.name}" organization</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p>
                        You've been invited to become a member of{' '}
                        <span className="font-semibold">{invitation.name}</span>.
                      </p>
                      <p className="text-muted-foreground mt-2">
                        By accepting the invitation, you will be able to collaborate with other
                        members of this organization.
                      </p>
                    </CardContent>
                    <CardFooter className="flex flex-col gap-y-4 md:flex-row md:justify-evenly md:gap-x-4 md:gap-y-0">
                      <Button
                        className="w-full md:flex-1"
                        variant="outline"
                        disabled={mutation.fetching}
                        onClick={goBack}
                      >
                        Ignore
                      </Button>
                      <Button
                        className="w-full md:flex-1"
                        onClick={accept}
                        disabled={mutation.fetching}
                      >
                        Accept
                      </Button>
                    </CardFooter>
                  </Card>
                </div>
              );
            }}
          </DataWrapper>
        </div>
      </DottedBackground>
    </>
  );
}

export default authenticated(JoinOrganizationPage);
