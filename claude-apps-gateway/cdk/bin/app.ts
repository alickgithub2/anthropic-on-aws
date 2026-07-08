#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GatewayStack, Platform } from '../lib/claude-gateway-stack';

/**
 * CDK entry point for the Claude apps gateway (Bedrock upstream). A shared data +
 * networking layer is created once, then EXACTLY ONE compute path is layered on:
 *
 *   -c platform=ecs   → ECS Fargate behind an internal IPv4 ALB
 *   -c platform=eks   → EKS Auto Mode with an internal IPv4 ALB Ingress
 *
 * Platform defaults to `eks` when unset; any other value fails synth. The app
 * only ever synthesizes ONE platform — it cannot deploy both at once.
 *
 * Two-pass deploy (the only forced ordering is image-before-workload):
 *   Pass 1:  cdk deploy -c platform=<p> -c imageReady=false   # shared infra (+ EKS cluster)
 *   build + push the image to the ECR repo printed by pass 1
 *   Pass 2:  cdk deploy -c platform=<p> -c imageReady=true \
 *              -c imageTag=v1 -c publicUrl=https://gateway.example.com -c ingressCidr=10.0.0.0/8
 *
 * Context vars (pass with -c key=value, or set in cdk.json / cdk.context.json):
 *     platform        ecs | eks  (default eks)
 *     region          AWS region (default: CDK_DEFAULT_REGION or us-east-1)
 *     publicUrl       internal ALB origin, e.g. https://claude-gateway.example.com  (pass 2)
 *     imageTag        ECR image tag (default: the claudeVersion below)
 *     certArn         ACM cert ARN — IMPORTED mode. Omit for MANAGED public-cert mode.
 *     zoneName        Route 53 PRIVATE hosted-zone name (holds the A-record)   (required for pass 2)
 *     zoneId          private hosted-zone id (optional; looked up from zoneName if omitted)
 *     publicZoneId    PUBLIC hosted-zone id — MANAGED mode only (ACM DNS validation)
 *     publicZoneName  PUBLIC hosted-zone name — MANAGED mode only (explicit, not derived)
 *     enableDashboard "true" to deploy the CloudWatch dashboard + alarms (default off)
 *     dailyCostThresholdUsd  daily cost-alarm threshold in USD (dashboard mode)
 *     alarmEmail      optional email for an SNS alarm subscription (dashboard mode)
 *     ingressCidr     VPN/corp CLIENT CIDR developers connect from — NOT the VPC CIDR   (required for pass 2)
 *     vpcId           import an existing VPC instead of creating one (optional)
 *     createVpcEndpoints  "false" to skip VPC endpoint creation when reusing a VPC
 *                     (`vpcId`) that already has them; default true (optional)
 *     imageReady      "false" for pass 1 (repo only), "true"/unset for pass 2
 *   BUILD-TIME (stamped into the image by stamp-config.sh; shown here for parity,
 *   not passed to the running task — changing them means a new image, ADR 0001):
 *     claudeVersion   default 2.1.199
 *     oidcIssuer, oidcClientId, allowedEmailDomains
 */
const app = new cdk.App();

const ctx = (k: string): string | undefined => app.node.tryGetContext(k);
const region = ctx('region') ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
const claudeVersion = ctx('claudeVersion') ?? '2.1.199';

// ── Platform selection: exactly one, default eks, fail loudly on anything else ─
const platformRaw = (ctx('platform') ?? 'eks').toLowerCase();
if (platformRaw !== 'ecs' && platformRaw !== 'eks') {
  throw new Error(
    `Invalid platform "${platformRaw}". Deploy with -c platform=ecs OR -c platform=eks ` +
      `(default eks). The app deploys exactly one compute path — never both.`,
  );
}
const platform = platformRaw as Platform;

new GatewayStack(app, 'ClaudeGatewayStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  description: `Claude apps gateway on ${platform.toUpperCase()} with Amazon Bedrock (worked example)`,
  platform,
  publicUrl: ctx('publicUrl'),
  imageTag: ctx('imageTag') ?? claudeVersion,
  certArn: ctx('certArn'),
  zoneName: ctx('zoneName'),
  zoneId: ctx('zoneId'),
  publicZoneId: ctx('publicZoneId'),
  publicZoneName: ctx('publicZoneName'),
  enableDashboard: ctx('enableDashboard') === 'true',
  dailyCostThresholdUsd: ctx('dailyCostThresholdUsd') ? Number(ctx('dailyCostThresholdUsd')) : undefined,
  alarmEmail: ctx('alarmEmail'),
  ingressCidr: ctx('ingressCidr'),
  vpcId: ctx('vpcId'),
  // Default true; only 'false' opts out (for a reused VPC that already has endpoints).
  createVpcEndpoints: ctx('createVpcEndpoints') !== 'false',
  // Pass 1 sets imageReady=false; pass 2 (default) deploys the full stack.
  imageReady: ctx('imageReady') !== 'false',
});

app.synth();
