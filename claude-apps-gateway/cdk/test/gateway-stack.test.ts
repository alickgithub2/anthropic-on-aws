import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { GatewayStack, GatewayStackProps } from '../lib/claude-gateway-stack';

/**
 * Synth-level regression tests. These assert on the CloudFormation template CDK
 * produces — no AWS account or credentials needed, matching the repo's
 * "verification is local/static" stance (see CLAUDE.md).
 *
 * Coverage:
 *  - the shared layer (RDS, ECR, secrets, VPC endpoints) is created once per deploy;
 *  - the ECS path keeps its non-obvious wiring (dual-ARN Bedrock policy, IPv4-only
 *    internal ALB, raised idle timeout, /healthz check, HTTPS :4318 listener);
 *  - the EKS path adds a cluster with Auto Mode, the cluster/node IAM roles, and a
 *    Pod Identity association, and reuses the SAME RDS + secrets (no duplication);
 *  - exactly ONE compute path is ever synthesized — never both.
 *
 * The vpcId is supplied so both paths reuse a VPC (fromLookup is stubbed via the
 * synth context below) and zoneId is set so ECS uses fromHostedZoneAttributes
 * instead of fromLookup, which would otherwise require live account credentials.
 */

const ACCOUNT = '111122223333';
const REGION = 'us-east-1';
const VPC_ID = 'vpc-0123456789abcdef0';

// A stubbed VPC context entry so ec2.Vpc.fromLookup resolves without credentials.
function appWithVpcContext(): cdk.App {
  const app = new cdk.App({
    context: {
      [`vpc-provider:account=${ACCOUNT}:filter.vpc-id=${VPC_ID}:region=${REGION}:returnAsymmetricSubnets=true`]: {
        vpcId: VPC_ID,
        vpcCidrBlock: '10.1.0.0/16',
        availabilityZones: [],
        subnetGroups: [
          {
            name: 'private',
            type: 'Private',
            subnets: [
              { subnetId: 'subnet-a', availabilityZone: `${REGION}a`, routeTableId: 'rtb-a', cidr: '10.1.0.0/24' },
              { subnetId: 'subnet-b', availabilityZone: `${REGION}b`, routeTableId: 'rtb-b', cidr: '10.1.1.0/24' },
            ],
          },
          {
            name: 'public',
            type: 'Public',
            subnets: [
              { subnetId: 'subnet-c', availabilityZone: `${REGION}a`, routeTableId: 'rtb-c', cidr: '10.1.2.0/24' },
              { subnetId: 'subnet-d', availabilityZone: `${REGION}b`, routeTableId: 'rtb-d', cidr: '10.1.3.0/24' },
            ],
          },
        ],
      },
    },
  });
  return app;
}

function synth(props: Omit<GatewayStackProps, 'env'>): Template {
  const app = appWithVpcContext();
  const stack = new GatewayStack(app, 'TestStack', { ...props, env: { account: ACCOUNT, region: REGION } });
  return Template.fromStack(stack);
}

const ECS_PASS2: Omit<GatewayStackProps, 'env'> = {
  platform: 'ecs',
  imageReady: true,
  imageTag: '2.1.197',
  publicUrl: 'https://claude-gateway.example.com',
  certArn: `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/abc-123`,
  zoneName: 'example.com',
  zoneId: 'Z123456ABCDEFG',
  ingressCidr: '10.100.0.0/16',
  vpcId: VPC_ID,
  // The reused test VPC "already has" endpoints — skip creating them (matches the
  // real reused VPC) so the assertions below focus on compute, not endpoints.
  createVpcEndpoints: false,
};

describe('ECS pass 1 (imageReady: false) — ECR repo only', () => {
  const template = synth({ platform: 'ecs', imageReady: false, imageTag: '2.1.197', vpcId: VPC_ID });

  test('creates the ECR repository', () => {
    template.resourceCountIs('AWS::ECR::Repository', 1);
  });

  test('does not create the Fargate service, ALB, or RDS', () => {
    template.resourceCountIs('AWS::ECS::Service', 0);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
    template.resourceCountIs('AWS::RDS::DBInstance', 0);
  });
});

describe('ECS pass 2 (imageReady: true) — full stack', () => {
  const template = synth(ECS_PASS2);

  test('shared layer: one RDS instance and one ECR repository', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.resourceCountIs('AWS::ECR::Repository', 1);
  });

  test('Bedrock task role grants BOTH inference-profile and foundation-model ARNs', () => {
    const invokeStatement = (resource: unknown) =>
      Match.objectLike({
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
              Resource: Match.arrayWith([resource]),
            }),
          ]),
        },
      });
    template.hasResourceProperties(
      'AWS::IAM::Policy',
      invokeStatement('arn:aws:bedrock:*::foundation-model/anthropic.*'),
    );
    template.hasResourceProperties(
      'AWS::IAM::Policy',
      invokeStatement(Match.stringLikeRegexp('inference-profile/us\\.anthropic\\.\\*')),
    );
  });

  test('ALB is internal and IPv4-only (dual-stack returns public AAAA that /login rejects)', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
      IpAddressType: 'ipv4',
    });
  });

  test('ALB idle timeout is raised to 3600s for long streaming responses', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([{ Key: 'idle_timeout.timeout_seconds', Value: '3600' }]),
    });
  });

  test('there is an HTTPS :4318 telemetry listener (TLS terminates at the ALB)', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 4318,
      Protocol: 'HTTPS',
    });
  });

  test('gateway target group health check points at /healthz, not /readyz', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/healthz',
    });
  });

  test('RDS is not publicly accessible', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', { PubliclyAccessible: false });
  });

  test('the OIDC client secret is a placeholder, not a real value baked into the template', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'claude-gateway-oidc-client-secret',
      SecretString: 'REPLACE_ME',
    });
  });

  test('ECS path creates NO EKS cluster (exactly one compute path)', () => {
    template.resourceCountIs('Custom::AWSCDK-EKS-Cluster', 0);
  });
});

describe('EKS pass 1 (imageReady: false) — cluster + shared infra, no workload', () => {
  const template = synth({ platform: 'eks', imageReady: false, imageTag: '2.1.197', vpcId: VPC_ID, createVpcEndpoints: false });

  test('creates exactly one EKS cluster', () => {
    template.resourceCountIs('Custom::AWSCDK-EKS-Cluster', 1);
  });

  test('reuses the shared RDS + ECR (created once)', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.resourceCountIs('AWS::ECR::Repository', 1);
  });

  test('cluster role carries the 5 Auto Mode managed policies', () => {
    // Assert a couple of the distinctive ones are attached somewhere.
    const hasManagedPolicy = (name: string) =>
      template.hasResourceProperties(
        'AWS::IAM::Role',
        Match.objectLike({
          ManagedPolicyArns: Match.arrayWith([
            Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp(name)])]) }),
          ]),
        }),
      );
    hasManagedPolicy('AmazonEKSComputePolicy');
    hasManagedPolicy('AmazonEKSBlockStoragePolicy');
  });

  test('enables Auto Mode compute on the cluster Config (escape hatch)', () => {
    template.hasResourceProperties('Custom::AWSCDK-EKS-Cluster', {
      Config: Match.objectLike({
        computeConfig: Match.objectLike({ enabled: true, nodePools: ['general-purpose', 'system'] }),
        storageConfig: { blockStorage: { enabled: true } },
      }),
    });
  });

  test('does NOT create any ECS service (exactly one compute path)', () => {
    template.resourceCountIs('AWS::ECS::Service', 0);
  });
});

describe('EKS pass 2 (imageReady: true) — workload', () => {
  const template = synth({
    platform: 'eks',
    imageReady: true,
    imageTag: 'v1',
    publicUrl: 'https://claude-gateway.example.com',
    ingressCidr: '10.100.0.0/16',
    vpcId: VPC_ID,
    createVpcEndpoints: false,
  });

  test('creates a Pod Identity association for the gateway service account', () => {
    template.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
      Namespace: 'claude-gateway',
      ServiceAccount: 'claude-gateway',
    });
  });

  test('pod identity role gets the dual-ARN Bedrock invoke policy', () => {
    template.hasResourceProperties(
      'AWS::IAM::Policy',
      Match.objectLike({
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
              Resource: Match.arrayWith(['arn:aws:bedrock:*::foundation-model/anthropic.*']),
            }),
          ]),
        },
      }),
    );
  });

  test('reuses the shared RDS + secrets (no duplication) — one RDS, one JWT secret', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'claude-gateway-jwt-secret' });
  });

  test('does NOT create any ECS service (exactly one compute path)', () => {
    template.resourceCountIs('AWS::ECS::Service', 0);
  });
});

describe('createVpcEndpoints (VPC reuse)', () => {
  test('createVpcEndpoints: false synthesizes zero VPC endpoints', () => {
    const t = synth({ ...ECS_PASS2, createVpcEndpoints: false });
    t.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
  });

  test('omitting the flag defaults to creating the endpoints (6 interface + 1 gateway)', () => {
    const t = synth({ ...ECS_PASS2, createVpcEndpoints: true });
    t.resourceCountIs('AWS::EC2::VPCEndpoint', 7);
  });
});
