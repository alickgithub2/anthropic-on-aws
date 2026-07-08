import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';

/** Postgres database name — shared by both compute paths. */
export const DB_NAME = 'claude_gateway';

export interface SharedResourcesProps {
  /** Import an existing VPC instead of creating one. */
  readonly vpcId?: string;
  /**
   * Create the interface + S3 VPC endpoints (default true). Set false ONLY when
   * reusing a VPC (`vpcId`) that ALREADY provides private egress to Bedrock,
   * Secrets Manager, ECR, CloudWatch Logs/Monitoring, and S3 — otherwise the
   * gateway loses its "AWS traffic never touches the internet" posture. AWS
   * permits only one private-DNS-enabled interface endpoint per service per VPC,
   * so recreating endpoints a reused VPC already has fails the deploy.
   */
  readonly createVpcEndpoints?: boolean;
}

/**
 * The data + platform-agnostic layer shared by BOTH the ECS and EKS compute
 * paths: one VPC, the private VPC endpoints, one RDS PostgreSQL instance, one ECR
 * repository, the gateway-owned secrets, and the CloudWatch log group.
 *
 * Neither compute path duplicates any of these — the EKS Deployment references
 * the SAME ECR image the ECS service would, connects to the SAME RDS instance,
 * and mounts the SAME Secrets Manager secrets. The ECR repository is created in
 * the constructor so the pass-1 (imageReady=false) deploy can provision just the
 * repo; the rest of the shared layer is created by `provision()`.
 */
export class SharedResources extends Construct {
  /** ECR repository (the pass-1 target); always available. */
  public readonly repo: ecr.Repository;

  // The fields below are populated by provision(); undefined during a pass-1
  // ECR-only deploy that never calls it.
  public vpc!: ec2.IVpc;
  public db!: rds.DatabaseInstance;
  public dbSecret!: secretsmanager.ISecret;
  public jwtSecret!: secretsmanager.Secret;
  public oidcSecret!: secretsmanager.Secret;
  public logGroup!: logs.LogGroup;
  /** SG the compute workload attaches to; already allowed into RDS + endpoints. */
  public workloadSg!: ec2.SecurityGroup;
  /** VPC endpoints SG (443 from the workload); exposed so compute can extend it. */
  public vpceSg!: ec2.SecurityGroup;

  private readonly props: SharedResourcesProps;

  constructor(scope: Construct, id: string, props: SharedResourcesProps = {}) {
    super(scope, id);
    this.props = props;

    // ── ECR repository (the pass-1 target) ────────────────────────────────────
    // Created first so the image can be built + pushed before the compute path
    // that consumes it exists. ONE repo, shared by ECS and EKS.
    this.repo = new ecr.Repository(this, 'Repo', {
      repositoryName: 'claude-gateway',
      imageScanOnPush: true,
      // Example posture: clean teardown. Harden for production (see README).
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    new cdk.CfnOutput(cdk.Stack.of(this), 'EcrRepositoryUri', { value: this.repo.repositoryUri });
  }

  /**
   * Provision the rest of the shared layer (VPC, endpoints, RDS, secrets, log
   * group). Called for every deploy EXCEPT a pass-1 ECR-only ECS deploy.
   */
  public provision(): void {
    const props = this.props;

    // ── VPC ───────────────────────────────────────────────────────────────────
    // NAT is retained for the IdP leg only (public OIDC issuer); all AWS-service
    // traffic uses the VPC endpoints below and never touches the internet.
    this.vpc = props.vpcId
      ? (ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId }) as ec2.IVpc)
      : new ec2.Vpc(this, 'Vpc', {
          maxAzs: 2,
          natGateways: 1,
          ipProtocol: ec2.IpProtocol.IPV4_ONLY,
          subnetConfiguration: [
            { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
            { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
          ],
        });

    // ── Interface VPC endpoints (AWS backbone, no internet) + S3 gateway ──────
    // See props doc for when to opt out with createVpcEndpoints=false.
    const createVpcEndpoints = props.createVpcEndpoints ?? true;
    this.vpceSg = new ec2.SecurityGroup(this, 'VpceSg', {
      vpc: this.vpc,
      description: 'VPC endpoints: 443 from the gateway workload SG',
      allowAllOutbound: true,
    });
    if (createVpcEndpoints) {
      const addIfaceEndpoint = (id: string, svc: ec2.InterfaceVpcEndpointAwsService) =>
        this.vpc.addInterfaceEndpoint(id, {
          service: svc,
          securityGroups: [this.vpceSg],
          privateDnsEnabled: true,
        });
      addIfaceEndpoint('BedrockRuntimeEndpoint', ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME);
      addIfaceEndpoint('SecretsManagerEndpoint', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER);
      addIfaceEndpoint('EcrApiEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR);
      addIfaceEndpoint('EcrDockerEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER);
      addIfaceEndpoint('CloudWatchLogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS);
      addIfaceEndpoint('CloudWatchMonitoringEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING);
      this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    }

    // ── Workload security group (ECS tasks or EKS pods) ───────────────────────
    // The ALB SG is created by the compute path (ECS pattern, or the EKS ALB
    // controller). Here we own the workload SG and its egress to the endpoints.
    this.workloadSg = new ec2.SecurityGroup(this, 'WorkloadSg', {
      vpc: this.vpc,
      description: 'Gateway workload: egress to RDS + VPC endpoints',
      allowAllOutbound: true,
    });
    this.vpceSg.connections.allowFrom(this.workloadSg, ec2.Port.tcp(443), 'workload to VPC endpoints');

    // ── RDS PostgreSQL 16 (private, encrypted, managed master secret) ─────────
    // Example posture: easy teardown. See README "Productionising" to harden.
    // ONE instance, shared by both compute paths.
    this.db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      databaseName: DB_NAME,
      credentials: rds.Credentials.fromGeneratedSecret('gateway'),
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(1),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.dbSecret = this.db.secret!;
    // RDS SG: 5432 from the workload SG ONLY (never a CIDR).
    this.db.connections.allowFrom(this.workloadSg, ec2.Port.tcp(5432), 'gateway workload to RDS');

    // ── Gateway-owned secrets (DB creds come from the RDS-managed secret) ─────
    this.jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: 'claude-gateway-jwt-secret',
      description: 'Claude gateway JWT signing secret (>=32 bytes)',
      generateSecretString: {
        // >= 32 bytes of entropy; no JSON wrapper — the whole string is the secret.
        passwordLength: 44,
        excludePunctuation: false,
      },
    });
    this.oidcSecret = new secretsmanager.Secret(this, 'OidcClientSecret', {
      secretName: 'claude-gateway-oidc-client-secret',
      description: 'Claude gateway OIDC client secret — set the real value after deploy',
      // Placeholder; replace with the real OIDC client secret:
      //   aws secretsmanager put-secret-value --secret-id claude-gateway-oidc-client-secret \
      //     --secret-string '<your-oidc-client-secret>'
      secretStringValue: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
    });

    // ── Log group (gateway stderr: audit events + operational logs) ───────────
    this.logGroup = new logs.LogGroup(this, 'GatewayLogGroup', {
      logGroupName: '/claude-gateway/gateway',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Outputs shared by both platforms ──────────────────────────────────────
    new cdk.CfnOutput(cdk.Stack.of(this), 'RdsEndpoint', { value: this.db.dbInstanceEndpointAddress });
  }

  /**
   * The dual-ARN Bedrock invoke policy statement, identical for ECS task roles
   * and the EKS pod-identity role. BOTH inference-profile (us.anthropic.*) AND
   * foundation-model (anthropic.*) ARNs — missing either yields 403 on invoke.
   */
  public bedrockInvokeStatement(): iam.PolicyStatement {
    const stack = cdk.Stack.of(this);
    return new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.*`,
        'arn:aws:bedrock:*::foundation-model/anthropic.*',
      ],
    });
  }
}
