import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { SharedResources } from './shared-resources';

export interface EcsComputeProps {
  readonly shared: SharedResources;
  readonly imageTag: string;
  readonly publicUrl: string;
  readonly ingressCidr: string;
  /**
   * ACM cert ARN for publicUrl's hostname. When provided the ALB serves HTTPS on
   * 443 (+ the HTTPS :4318 telemetry listener); when omitted it serves plain HTTP
   * on 80 (a worked-example / test convenience — production must supply a cert).
   */
  readonly certArn?: string;
  /** Route 53 hosted-zone name; when set an alias record is created for publicUrl. */
  readonly zoneName?: string;
  /** Route 53 hosted-zone id (optional; looked up from zoneName if omitted). */
  readonly zoneId?: string;
}

/**
 * The ECS Fargate compute path: a gateway service behind an internal IPv4 ALB,
 * reusing the shared RDS, ECR, and secrets. Mirrors what setup.sh provisions.
 *
 * When a cert is supplied the full HTTPS posture (443 + the HTTPS :4318 ADOT
 * telemetry listener + optional Route 53 record) is created, exactly as before;
 * without one the ALB serves plain HTTP on 80 so the worked example still
 * deploys end-to-end for testing.
 */
export class EcsCompute extends Construct {
  public readonly albDnsName: string;

  constructor(scope: Construct, id: string, props: EcsComputeProps) {
    super(scope, id);

    const { shared } = props;
    const stack = cdk.Stack.of(this);
    const vpc = shared.vpc;
    const taskSg = shared.workloadSg;
    const hasCert = !!props.certArn;
    // publicUrl is https://<host>; the record name is the host part.
    const recordHost = props.publicUrl.replace(/^https?:\/\//, '');

    // ── ECS cluster ───────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, clusterName: 'claude-gateway' });

    // ── Gateway task role: dual-ARN Bedrock policy ────────────────────────────
    // auth: {} in gateway.yaml picks this up via the ECS container-credentials
    // endpoint (no IMDS, no hop-limit trap).
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Claude gateway task role: Bedrock invoke',
    });
    taskRole.addToPolicy(shared.bedrockInvokeStatement());

    // ── Gateway Fargate service behind an internal IPv4 ALB ───────────────────
    // IPv4-only on purpose: internal dual-stack ALBs return public-range AAAA
    // records that /login rejects.
    const image = ecs.ContainerImage.fromEcrRepository(shared.repo, props.imageTag);
    const listenerProtocol = hasCert ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP;

    // A Route 53 record is created only when a zone AND a cert are supplied —
    // aliasing an HTTP-only ALB under an https:// public_url would mislead.
    const domainZone =
      hasCert && props.zoneName
        ? props.zoneId
          ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
              hostedZoneId: props.zoneId,
              zoneName: props.zoneName,
            })
          : route53.HostedZone.fromLookup(this, 'Zone', { domainName: props.zoneName, privateZone: true })
        : undefined;

    const fargate = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Gateway', {
      cluster,
      serviceName: 'claude-gateway',
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 2, // zero-downtime rolling deploys + AZ resilience
      minHealthyPercent: 100, // keep all replicas up during a rolling deploy (stateless)
      circuitBreaker: { rollback: true }, // fail a bad deploy fast instead of hanging
      publicLoadBalancer: false, // internal ALB → private IPs only (satisfies /login)
      ipAddressType: elbv2.IpAddressType.IPV4,
      openListener: false, // don't open to 0.0.0.0/0; restrict to ingressCidr below
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [taskSg],
      protocol: listenerProtocol,
      ...(hasCert
        ? {
            certificate: acm.Certificate.fromCertificateArn(this, 'Cert', props.certArn!),
            sslPolicy: elbv2.SslPolicy.TLS13_RES,
          }
        : {}),
      idleTimeout: cdk.Duration.seconds(3600), // long streaming responses
      ...(domainZone ? { domainName: recordHost, domainZone } : {}),
      healthCheckGracePeriod: cdk.Duration.seconds(120),
      taskImageOptions: {
        image,
        containerPort: 8080,
        taskRole,
        // NO non-secret app config here — it's baked into the image (ADR 0001).
        environment: {
          CLAUDE_GATEWAY_LOG_LEVEL: 'info',
          CLAUDE_CONFIG_DIR: '/tmp/.claude',
          DB_HOST: shared.db.dbInstanceEndpointAddress,
        },
        secrets: {
          GATEWAY_JWT_SECRET: ecs.Secret.fromSecretsManager(shared.jwtSecret),
          OIDC_CLIENT_SECRET: ecs.Secret.fromSecretsManager(shared.oidcSecret),
          DB_USER: ecs.Secret.fromSecretsManager(shared.dbSecret, 'username'),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(shared.dbSecret, 'password'),
        },
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'gateway', logGroup: shared.logGroup }),
      },
    });

    // Restrict the ALB ingress to the VPN/corp client CIDR (not 0.0.0.0/0).
    fargate.loadBalancer.connections.allowFrom(
      ec2.Peer.ipv4(props.ingressCidr),
      ec2.Port.tcp(hasCert ? 443 : 80),
      'developers to ALB',
    );

    // Health check → /healthz (liveness). Keeps replicas in rotation during a
    // Postgres blip; pointing it at /readyz would drain all replicas at once.
    fargate.targetGroup.configureHealthCheck({ path: '/healthz', healthyHttpCodes: '200' });

    // ── Telemetry: HTTPS :4318 listener + ADOT collector (cert path only) ─────
    // The gateway requires https:// for a non-loopback forward_to and offers no
    // custom-CA/skip-verify, so the collector must sit behind the ALB's
    // publicly-trusted cert. Skipped entirely on the HTTP (no-cert) path.
    if (hasCert) {
      this.addTelemetry(fargate, taskSg, props.certArn!, recordHost, shared);
    }

    this.albDnsName = fargate.loadBalancer.loadBalancerDnsName;

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(stack, 'AlbDnsName', { value: fargate.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(stack, 'PublicUrl', { value: props.publicUrl });
    new cdk.CfnOutput(stack, 'OAuthRedirectUri', {
      value: `${props.publicUrl}/oauth/callback`,
      description: 'Register this redirect URI on your OIDC client',
    });
    new cdk.CfnOutput(stack, 'TaskRoleArn', { value: taskRole.roleArn });
  }

  /**
   * A separate small ADOT-collector Fargate service reached over the gateway
   * ALB's HTTPS :4318 listener (not a sidecar — the gateway's SSRF guard blocks
   * loopback). Preserved from the original stack; only reached on the cert path.
   */
  private addTelemetry(
    fargate: ecsPatterns.ApplicationLoadBalancedFargateService,
    taskSg: ec2.ISecurityGroup,
    certArn: string,
    recordHost: string,
    shared: SharedResources,
  ): void {
    const stack = cdk.Stack.of(this);
    const cluster = fargate.cluster;

    const otelSg = new ec2.SecurityGroup(this, 'OtelSg', {
      vpc: cluster.vpc,
      description: 'ADOT collector: 4318 (OTLP) + 13133 (health) from the ALB only',
      allowAllOutbound: true,
    });

    const adotConfig = [
      'extensions:',
      '  health_check:',
      '    endpoint: 0.0.0.0:13133',
      'receivers:',
      '  otlp:',
      '    protocols:',
      '      http:',
      '        endpoint: 0.0.0.0:4318',
      'processors:',
      '  batch: {}',
      'exporters:',
      '  awsemf:',
      '    namespace: ClaudeGateway',
      '    log_group_name: /claude-gateway/otel-metrics',
      'service:',
      '  extensions: [health_check]',
      '  pipelines:',
      '    metrics:',
      '      receivers: [otlp]',
      '      processors: [batch]',
      '      exporters: [awsemf]',
    ].join('\n');

    const otelTaskDef = new ecs.FargateTaskDefinition(this, 'OtelTaskDef', { cpu: 256, memoryLimitMiB: 512 });
    otelTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudwatch:PutMetricData',
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogGroups',
          'logs:DescribeLogStreams',
        ],
        resources: ['*'],
      }),
    );
    otelTaskDef.addContainer('aws-otel-collector', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-observability/aws-otel-collector:latest'),
      environment: { AOT_CONFIG_CONTENT: adotConfig },
      portMappings: [{ containerPort: 4318 }, { containerPort: 13133 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'otel', logGroup: shared.logGroup }),
    });
    const otelService = new ecs.FargateService(this, 'OtelService', {
      cluster,
      taskDefinition: otelTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
      securityGroups: [otelSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const otelListener = fargate.loadBalancer.addListener('OtelListener', {
      port: 4318,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [acm.Certificate.fromCertificateArn(this, 'OtelCert', certArn)],
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
    });
    otelListener.addTargets('OtelTargets', {
      port: 4318,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [otelService.loadBalancerTarget({ containerName: 'aws-otel-collector', containerPort: 4318 })],
      healthCheck: { port: '13133', path: '/', healthyHttpCodes: '200' },
      deregistrationDelay: cdk.Duration.seconds(10),
    });
    fargate.loadBalancer.connections.allowFrom(taskSg, ec2.Port.tcp(4318), 'gateway to ALB (OTLP/HTTPS)');
    otelSg.connections.allowFrom(fargate.loadBalancer, ec2.Port.tcp(4318), 'ALB to collector (OTLP)');
    otelSg.connections.allowFrom(fargate.loadBalancer, ec2.Port.tcp(13133), 'ALB to collector (health)');

    new cdk.CfnOutput(stack, 'OtelForwardTo', {
      value: `https://${recordHost}:4318`,
      description: 'gateway.yaml telemetry.forward_to (ADOT collector via the gateway ALB)',
    });
  }
}
