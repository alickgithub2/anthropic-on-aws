import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SharedResources } from './shared-resources';
import { EcsCompute } from './ecs-compute';
import { EksCompute } from './eks-compute';

/** The compute platforms the gateway can deploy onto — never both at once. */
export type Platform = 'ecs' | 'eks';

export interface GatewayStackProps extends cdk.StackProps {
  /** Which compute path to deploy. Exactly one — the app refuses both. */
  readonly platform: Platform;
  /** false = pass 1 (shared infra only); true = pass 2 (full stack incl. compute). */
  readonly imageReady: boolean;
  /** ECR image tag (defaults to the pinned claude version). */
  readonly imageTag: string;
  /** Internal ALB origin, e.g. https://claude-gateway.example.com (pass 2). */
  readonly publicUrl?: string;
  /** ACM cert ARN for publicUrl's hostname — IMPORTED. Omit to use managed-public mode. */
  readonly certArn?: string;
  /** Route 53 PRIVATE hosted-zone name, e.g. example.com (holds the A-record). */
  readonly zoneName?: string;
  /** Route 53 private hosted-zone id (optional; looked up from zoneName if omitted). */
  readonly zoneId?: string;
  /** PUBLIC hosted-zone id — managed mode only; used solely for ACM DNS validation. */
  readonly publicZoneId?: string;
  /** PUBLIC hosted-zone name — managed mode only; explicit, not derived from zoneName. */
  readonly publicZoneName?: string;
  /** Deploy the CloudWatch dashboard + alarms (default false). */
  readonly enableDashboard?: boolean;
  /** Daily cost-alarm threshold in USD (dashboard mode; enables the cost alarm when > 0). */
  readonly dailyCostThresholdUsd?: number;
  /** Optional email for an SNS alarm subscription (dashboard mode). */
  readonly alarmEmail?: string;
  /** VPN/corp CLIENT CIDR developers connect from — NOT the VPC CIDR (pass 2). */
  readonly ingressCidr?: string;
  /** Import an existing VPC instead of creating one. */
  readonly vpcId?: string;
  /** Create the VPC endpoints (default true; false when reusing a VPC that has them). */
  readonly createVpcEndpoints?: boolean;
}

/**
 * The Claude apps gateway stack. A shared data + networking layer (VPC endpoints,
 * RDS, ECR, secrets, log group) is created once, then EXACTLY ONE compute path —
 * ECS Fargate or EKS Auto Mode — is layered on top. The `platform` context flag
 * (`-c platform=ecs|eks`) selects it; the app never deploys both.
 *
 * Two-pass deploy (the only forced ordering is image-before-workload):
 *   Pass 1:  -c imageReady=false   → shared infra (+ EKS cluster on the eks path)
 *   build + push the image to the ECR repo printed by pass 1
 *   Pass 2:  -c imageReady=true    → the gateway workload on the chosen platform
 */
export class GatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    new cdk.CfnOutput(this, 'Platform', { value: props.platform });

    // ── Shared layer ──────────────────────────────────────────────────────────
    const shared = new SharedResources(this, 'Shared', {
      vpcId: props.vpcId,
      createVpcEndpoints: props.createVpcEndpoints,
    });

    // ECS pass 1 is ECR-repo-only (the image must exist before the service).
    // The EKS pass 1 still provisions the cluster + shared infra, because the
    // cluster is the long-lead resource and the workload is a fast pass-2 add.
    const ecsPass1 = props.platform === 'ecs' && !props.imageReady;
    if (ecsPass1) {
      new cdk.CfnOutput(this, 'NextStep', {
        value:
          'Pass 1 complete. Build + push the image to the repo above, then re-run: ' +
          'cdk deploy -c platform=ecs -c imageReady=true -c imageTag=... -c publicUrl=... -c zoneName=... -c ingressCidr=... ' +
          'and EITHER -c certArn=... (imported cert) OR -c publicZoneId=... -c publicZoneName=... ' +
          '(managed public cert).',
      });
      return;
    }

    // Everything else needs the full shared layer (VPC, RDS, secrets, log group).
    shared.provision();

    // ── Exactly one compute path ────────────────────────────────────────────
    if (props.platform === 'ecs') {
      new EcsCompute(this, 'Ecs', {
        shared,
        imageTag: props.imageTag,
        publicUrl: req(props.publicUrl, 'publicUrl'),
        ingressCidr: req(props.ingressCidr, 'ingressCidr'),
        certArn: props.certArn,
        zoneName: props.zoneName,
        zoneId: props.zoneId,
        publicZoneId: props.publicZoneId,
        publicZoneName: props.publicZoneName,
        enableDashboard: props.enableDashboard,
        dailyCostThresholdUsd: props.dailyCostThresholdUsd,
        alarmEmail: props.alarmEmail,
      });
    } else {
      new EksCompute(this, 'Eks', {
        shared,
        imageReady: props.imageReady,
        imageTag: props.imageTag,
        publicUrl: props.publicUrl,
        ingressCidr: props.ingressCidr,
        certArn: props.certArn,>>>>>>> e24e3b3 (docs: keep ADRs local — remove docs/adr, inline the rationale)
      });
    }
  }
}

/** Fail synth with a clear message when a pass-2 required input is missing. */
function req(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `Missing required context "${name}". For pass 2 deploy with: ` +
        `-c publicUrl=... -c zoneName=... -c ingressCidr=... and EITHER ` +
        `-c certArn=... (imported cert) OR -c publicZoneId=... -c publicZoneName=... ` +
        `(managed public cert). Or set imageReady=false for the pass-1 ECR-repo-only deploy.`,
    );
  }
  return value;
}
