import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { KubectlV32Layer } from '@aws-cdk/lambda-layer-kubectl-v32';
import { SharedResources, DB_NAME } from './shared-resources';

const NAMESPACE = 'claude-gateway';
const SERVICE_ACCOUNT = 'claude-gateway';
const SYNCED_SECRET = 'claude-gateway-secrets';

export interface EksComputeProps {
  readonly shared: SharedResources;
  /** false = pass 1 (cluster + shared infra only); true = pass 2 (workload). */
  readonly imageReady: boolean;
  readonly imageTag: string;
  /** Required for pass 2 — the ALB host / gateway public_url. */
  readonly publicUrl?: string;
  /** VPN/corp CLIENT CIDR developers connect from (pass 2). */
  readonly ingressCidr?: string;
  /** ACM cert ARN — when set the Ingress serves HTTPS, else HTTP (test convenience). */
  readonly certArn?: string;
}

/**
 * The EKS (Auto Mode) compute path. Reuses the shared RDS, ECR image, and
 * Secrets Manager secrets — nothing is duplicated. Pass 1 provisions the cluster
 * and its IAM; pass 2 adds the Helm charts (Secrets Store CSI + AWS provider),
 * the gateway workload manifests, and the Pod Identity association.
 *
 * EKS Auto Mode is enabled through an escape hatch on the L2 cluster's underlying
 * CreateCluster custom resource (aws-cdk-lib has no native Auto Mode prop yet),
 * which keeps addManifest()/addHelmChart() working. See lib/README or the
 * memory note for why the Config.* override reaches the EKS API verbatim.
 */
export class EksCompute extends Construct {
  constructor(scope: Construct, id: string, props: EksComputeProps) {
    super(scope, id);

    const { shared } = props;
    const stack = cdk.Stack.of(this);
    const vpc = shared.vpc;

    // ── Cluster IAM role + 5 Auto Mode managed policies ───────────────────────
    const clusterRole = new iam.Role(this, 'ClusterRole', {
      assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
      description: 'Claude gateway EKS Auto Mode cluster role',
    });
    for (const p of [
      'AmazonEKSClusterPolicy',
      'AmazonEKSComputePolicy',
      'AmazonEKSBlockStoragePolicy',
      'AmazonEKSLoadBalancingPolicy',
      'AmazonEKSNetworkingPolicy',
    ]) {
      clusterRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(p));
    }
    // EKS Auto Mode / Pod Identity requires the cluster role to allow the
    // eks.amazonaws.com principal to also call sts:TagSession (in addition to
    // AssumeRole, added by assumedBy above).
    clusterRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:TagSession'],
        principals: [new iam.ServicePrincipal('eks.amazonaws.com')],
      }),
    );

    // ── Node IAM role + 2 managed policies ────────────────────────────────────
    const nodeRole = new iam.Role(this, 'NodeRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Claude gateway EKS Auto Mode node role',
    });
    for (const p of ['AmazonEKSWorkerNodeMinimalPolicy', 'AmazonEC2ContainerRegistryPullOnly']) {
      nodeRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(p));
    }

    // ── EKS cluster (L2 for kubectl/helm) + Auto Mode via escape hatch ────────
    const clusterName = 'claude-gateway';
    const cluster = new eks.Cluster(this, 'Cluster', {
      clusterName,
      version: eks.KubernetesVersion.V1_32,
      kubectlLayer: new KubectlV32Layer(this, 'KubectlLayer'),
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      role: clusterRole,
      defaultCapacity: 0, // Auto Mode manages compute; no self-managed node group
      // Auto Mode ships its own core add-ons — the self-managed bootstrap set
      // (kube-proxy, vpc-cni, coredns) must be OFF or CreateCluster is rejected.
      bootstrapSelfManagedAddons: false,
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
    });

    // Enable Auto Mode by injecting the compute/storage/LB config into the
    // CreateCluster custom resource's Config (spread verbatim into the EKS API).
    const cfnCluster = cluster.node
      .findChild('Resource')
      .node.findChild('Resource')
      .node.defaultChild as cdk.CfnResource;
    cfnCluster.addPropertyOverride('Config.computeConfig', {
      enabled: true,
      nodePools: ['general-purpose', 'system'],
      nodeRoleArn: nodeRole.roleArn,
    });
    cfnCluster.addPropertyOverride('Config.kubernetesNetworkConfig.elasticLoadBalancing', {
      enabled: true,
    });
    cfnCluster.addPropertyOverride('Config.storageConfig', {
      blockStorage: { enabled: true },
    });

    // The cluster's CreationRole must be able to PassRole the node role to EKS
    // (Auto Mode assigns it to the managed EC2 instances).
    const creationRole = cluster.node.findChild('Resource').node.findChild('CreationRole') as iam.Role;
    creationRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [nodeRole.roleArn] }),
    );
    // With authenticationMode=API(_AND_CONFIG_MAP), CDK's cluster handler creates
    // an EKS access entry so the creation role keeps kubectl/admin access — but
    // the auto-generated CreationRole isn't granted the access-entry actions, so
    // CreateCluster's follow-up CreateAccessEntry is denied and the stack rolls
    // back. Grant the access-entry management actions on this cluster (the ARN is
    // deterministic: the clusterName is fixed above).
    creationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'eks:CreateAccessEntry',
          'eks:DeleteAccessEntry',
          'eks:DescribeAccessEntry',
          'eks:ListAccessEntries',
          'eks:AssociateAccessPolicy',
          'eks:DisassociateAccessPolicy',
          'eks:ListAssociatedAccessPolicies',
        ],
        resources: [
          `arn:aws:eks:${stack.region}:${stack.account}:cluster/${clusterName}`,
          `arn:aws:eks:${stack.region}:${stack.account}:access-entry/${clusterName}/*`,
        ],
      }),
    );

    // ── Shared-layer connectivity for pods ────────────────────────────────────
    // Pods run on Auto Mode nodes that use the cluster security group for their
    // ENIs, so the shared RDS and VPC endpoints must accept that SG (the shared
    // workloadSg is the ECS task SG and doesn't cover EKS pods).
    const clusterSg = cluster.clusterSecurityGroup;
    shared.db.connections.allowFrom(clusterSg, ec2.Port.tcp(5432), 'EKS pods to RDS');
    shared.vpceSg.connections.allowFrom(clusterSg, ec2.Port.tcp(443), 'EKS pods to VPC endpoints');

    // ── Pod Identity role: Bedrock invoke + read the shared secrets ───────────
    // The gateway pod assumes this via EKS Pod Identity; the Secrets Store CSI
    // AWS provider uses the SAME identity to fetch the secrets it mounts.
    const podRole = new iam.Role(this, 'PodRole', {
      assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com'),
      description: 'Claude gateway pod identity role: Bedrock invoke + Secrets Manager read',
    });
    podRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:TagSession'],
        principals: [new iam.ServicePrincipal('pods.eks.amazonaws.com')],
      }),
    );
    podRole.addToPolicy(shared.bedrockInvokeStatement());
    podRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [shared.jwtSecret.secretArn, shared.oidcSecret.secretArn, shared.dbSecret.secretArn],
      }),
    );

    new cdk.CfnOutput(stack, 'ClusterName', { value: clusterName });
    new cdk.CfnOutput(stack, 'PodRoleArn', { value: podRole.roleArn });

    // Pass 1 stops here: cluster + shared infra exist, no workload yet.
    if (!props.imageReady) {
      new cdk.CfnOutput(stack, 'NextStep', {
        value:
          'Pass 1 complete (EKS cluster + RDS + secrets). Build + push the image, then re-run ' +
          'with -c imageReady=true -c imageTag=... -c publicUrl=... -c ingressCidr=...',
      });
      return;
    }

    // ── Pass 2: workload ──────────────────────────────────────────────────────
    const publicUrl = reqCtx(props.publicUrl, 'publicUrl');
    const ingressCidr = reqCtx(props.ingressCidr, 'ingressCidr');
    const recordHost = publicUrl.replace(/^https?:\/\//, '');
    const hasCert = !!props.certArn;

    this.addWorkload({
      cluster,
      shared,
      podRole,
      imageTag: props.imageTag,
      recordHost,
      ingressCidr,
      certArn: props.certArn,
      hasCert,
      publicUrl,
      clusterName,
    });
  }

  private addWorkload(o: {
    cluster: eks.Cluster;
    shared: SharedResources;
    podRole: iam.Role;
    imageTag: string;
    recordHost: string;
    ingressCidr: string;
    certArn?: string;
    hasCert: boolean;
    publicUrl: string;
    clusterName: string;
  }): void {
    const { cluster, shared, podRole } = o;
    const stack = cdk.Stack.of(this);
    const image = `${shared.repo.repositoryUri}:${o.imageTag}`;

    // ── Helm: Secrets Store CSI driver + AWS provider ─────────────────────────
    const csiDriver = cluster.addHelmChart('SecretsStoreCSI', {
      chart: 'secrets-store-csi-driver',
      repository: 'https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts',
      namespace: 'kube-system',
      release: 'csi-secrets-store',
      values: { syncSecret: { enabled: true }, enableSecretRotation: true },
    });
    const awsProvider = cluster.addHelmChart('AwsProvider', {
      chart: 'secrets-store-csi-driver-provider-aws',
      repository: 'https://aws.github.io/secrets-store-csi-driver-provider-aws',
      namespace: 'kube-system',
      release: 'secrets-provider-aws',
    });

    // ── Namespace + ServiceAccount ────────────────────────────────────────────
    const ns = cluster.addManifest('Namespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: NAMESPACE },
    });
    const sa = cluster.addManifest('ServiceAccount', {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: SERVICE_ACCOUNT, namespace: NAMESPACE },
    });
    sa.node.addDependency(ns);

    // ── Pod Identity association for the gateway SA ───────────────────────────
    // Depend on the cluster's CreateCluster resource only — NOT the whole L2
    // construct, which also parents the manifests (that would cycle:
    // Deployment → PodIdentity → cluster(+Deployment)).
    const podIdentity = new eks.CfnPodIdentityAssociation(this, 'PodIdentity', {
      clusterName: o.clusterName,
      namespace: NAMESPACE,
      serviceAccount: SERVICE_ACCOUNT,
      roleArn: podRole.roleArn,
    });
    podIdentity.node.addDependency(cluster.node.findChild('Resource'));

    // ── SecretProviderClass: mount the shared secrets, sync to a K8s Secret ───
    // The synced Secret's keys are the SAME env-var names the baked gateway.yaml
    // expands (${GATEWAY_JWT_SECRET} etc.), so the EKS pod reuses the exact ECS
    // image with no config divergence. The RDS secret is JSON, so jmesPath pulls
    // username/password into their own aliases.
    const spc = cluster.addManifest('SecretProviderClass', {
      apiVersion: 'secrets-store.csi.x-k8s.io/v1',
      kind: 'SecretProviderClass',
      metadata: { name: 'claude-gateway', namespace: NAMESPACE },
      spec: {
        provider: 'aws',
        parameters: {
          region: stack.region,
          objects: yamlList([
            { objectName: shared.jwtSecret.secretArn, objectType: 'secretsmanager', objectAlias: 'jwt-secret' },
            {
              objectName: shared.oidcSecret.secretArn,
              objectType: 'secretsmanager',
              objectAlias: 'oidc-client-secret',
            },
            {
              objectName: shared.dbSecret.secretArn,
              objectType: 'secretsmanager',
              jmesPath: [
                { path: 'username', objectAlias: 'db-username' },
                { path: 'password', objectAlias: 'db-password' },
              ],
            },
          ]),
        },
        secretObjects: [
          {
            secretName: SYNCED_SECRET,
            type: 'Opaque',
            data: [
              { objectName: 'jwt-secret', key: 'GATEWAY_JWT_SECRET' },
              { objectName: 'oidc-client-secret', key: 'OIDC_CLIENT_SECRET' },
              { objectName: 'db-username', key: 'DB_USER' },
              { objectName: 'db-password', key: 'DB_PASSWORD' },
            ],
          },
        ],
      },
    });
    spc.node.addDependency(ns, csiDriver, awsProvider);

    // ── Deployment (same image + ${ENV_VAR} expansion as ECS) ─────────────────
    const deployment = cluster.addManifest('Deployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'claude-gateway', namespace: NAMESPACE, labels: { app: 'claude-gateway' } },
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: 'claude-gateway' } },
        template: {
          metadata: { labels: { app: 'claude-gateway' } },
          spec: {
            serviceAccountName: SERVICE_ACCOUNT,
            containers: [
              {
                name: 'gateway',
                image,
                ports: [{ containerPort: 8080 }],
                env: [
                  { name: 'CLAUDE_GATEWAY_LOG_LEVEL', value: 'info' },
                  { name: 'CLAUDE_CONFIG_DIR', value: '/tmp/.claude' },
                  // DB_HOST is the non-secret RDS endpoint (host isn't in the secret).
                  { name: 'DB_HOST', value: shared.db.dbInstanceEndpointAddress },
                ],
                // The four secret env vars come from the CSI-synced K8s Secret.
                envFrom: [{ secretRef: { name: SYNCED_SECRET } }],
                // The volume mount is what triggers the CSI driver to fetch +
                // sync the secret; the gateway itself reads via env vars.
                volumeMounts: [
                  { name: 'secrets-store', mountPath: '/mnt/secrets-store', readOnly: true },
                  { name: 'tmp', mountPath: '/tmp' },
                ],
                readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, initialDelaySeconds: 10 },
                livenessProbe: { httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 15 },
              },
            ],
            volumes: [
              {
                name: 'secrets-store',
                csi: {
                  driver: 'secrets-store.csi.k8s.io',
                  readOnly: true,
                  volumeAttributes: { secretProviderClass: 'claude-gateway' },
                },
              },
              { name: 'tmp', emptyDir: {} },
            ],
          },
        },
      },
    });
    deployment.node.addDependency(spc, sa, podIdentity);

    // ── Service ───────────────────────────────────────────────────────────────
    const service = cluster.addManifest('Service', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'claude-gateway', namespace: NAMESPACE },
      spec: {
        selector: { app: 'claude-gateway' },
        ports: [{ port: 8080, targetPort: 8080, protocol: 'TCP' }],
        type: 'ClusterIP',
      },
    });
    service.node.addDependency(ns);

    // ── Auto Mode ALB Ingress (internal, IPv4-only) ───────────────────────────
    // Auto Mode's built-in load balancing controller reconciles this IngressClass
    // (controller eks.amazonaws.com/alb). IPv4-only: internal dual-stack ALBs
    // return public-range AAAA that /login rejects. Subnets are pinned to the
    // shared private subnets (reused-VPC subnets may lack the discovery tags).
    const privateSubnetIds = shared.vpc.privateSubnets.map((s) => s.subnetId).join(',');

    const ingressClassParams = cluster.addManifest('IngressClassParams', {
      apiVersion: 'eks.amazonaws.com/v1',
      kind: 'IngressClassParams',
      metadata: { name: 'claude-gateway-alb' },
      spec: { scheme: 'internal' },
    });
    const ingressClass = cluster.addManifest('IngressClass', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'IngressClass',
      metadata: { name: 'claude-gateway-alb' },
      spec: {
        controller: 'eks.amazonaws.com/alb',
        parameters: {
          apiGroup: 'eks.amazonaws.com',
          kind: 'IngressClassParams',
          name: 'claude-gateway-alb',
        },
      },
    });
    ingressClass.node.addDependency(ingressClassParams);

    const albAnnotations: Record<string, string> = {
      'alb.ingress.kubernetes.io/scheme': 'internal',
      'alb.ingress.kubernetes.io/ip-address-type': 'ipv4', // NOT dualstack — see above
      'alb.ingress.kubernetes.io/target-type': 'ip',
      'alb.ingress.kubernetes.io/subnets': privateSubnetIds,
      'alb.ingress.kubernetes.io/healthcheck-path': '/healthz',
      'alb.ingress.kubernetes.io/load-balancer-attributes': 'idle_timeout.timeout_seconds=3600',
      'alb.ingress.kubernetes.io/inbound-cidrs': o.ingressCidr,
    };
    if (o.hasCert) {
      albAnnotations['alb.ingress.kubernetes.io/listen-ports'] = '[{"HTTPS":443}]';
      albAnnotations['alb.ingress.kubernetes.io/certificate-arn'] = o.certArn!;
      albAnnotations['alb.ingress.kubernetes.io/ssl-policy'] = 'ELBSecurityPolicy-TLS13-1-2-2021-06';
    } else {
      albAnnotations['alb.ingress.kubernetes.io/listen-ports'] = '[{"HTTP":80}]';
    }

    const ingress = cluster.addManifest('Ingress', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: { name: 'claude-gateway', namespace: NAMESPACE, annotations: albAnnotations },
      spec: {
        ingressClassName: 'claude-gateway-alb',
        rules: [
          {
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: { service: { name: 'claude-gateway', port: { number: 8080 } } },
                },
              ],
            },
          },
        ],
      },
    });
    ingress.node.addDependency(service, ingressClass, deployment);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(stack, 'PublicUrl', { value: o.publicUrl });
    new cdk.CfnOutput(stack, 'OAuthRedirectUri', {
      value: `${o.publicUrl}/oauth/callback`,
      description: 'Register this redirect URI on your OIDC client',
    });
    new cdk.CfnOutput(stack, 'DbName', { value: DB_NAME });
    new cdk.CfnOutput(stack, 'AlbLookupHint', {
      value: `kubectl get ingress claude-gateway -n ${NAMESPACE} -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'`,
      description: 'Run this after the ingress reconciles to get the internal ALB DNS name',
    });
  }
}

/** Render an array of objects as a YAML block string (for CSI `objects`). */
function yamlList(items: Array<Record<string, unknown>>): string {
  const render = (v: unknown, indent: number): string => {
    const pad = '  '.repeat(indent);
    if (Array.isArray(v)) {
      return v.map((el) => `${pad}- ${render(el, indent + 1).trimStart()}`).join('\n');
    }
    if (v && typeof v === 'object') {
      return Object.entries(v as Record<string, unknown>)
        .map(([k, val], i) => {
          const prefix = i === 0 ? '' : pad;
          if (val && typeof val === 'object') {
            return `${prefix}${k}:\n${render(val, indent + 1)}`;
          }
          return `${prefix}${k}: ${JSON.stringify(val)}`;
        })
        .join('\n');
    }
    return JSON.stringify(v);
  };
  return items.map((it) => `- ${render(it, 1).trimStart()}`).join('\n');
}

/** Fail synth with a clear message when a pass-2 required input is missing. */
function reqCtx(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `Missing required context "${name}" for EKS pass 2. Deploy with: ` +
        `-c platform=eks -c imageReady=true -c imageTag=... -c publicUrl=... -c ingressCidr=... ` +
        `(or set imageReady=false for the pass-1 cluster-only deploy).`,
    );
  }
  return value;
}
