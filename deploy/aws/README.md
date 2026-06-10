# Deploy pack: AWS (ECS Fargate)

Enterprise target. Terraform provisions the backend on **ECS Fargate** behind an
**ALB**, with **RDS Postgres**, **Secrets Manager**, and a dedicated **KMS key**
for production BYOK envelope encryption (`OPENWOP_BYOK_KMS_KEY=aws-kms:<arn>` —
the AWS backend added in `backend/typescript/src/byok/kmsBackends.ts`).

> Status: syntax-reviewed scaffold. NOT applied live. Run `terraform validate`
> + `terraform plan` in your account and review before `apply`. Uses the default
> VPC for a small footprint — substitute your own VPC for production.

## What it creates

| Capability | Resource |
|---|---|
| Container runtime | ECS Fargate service + task (root Dockerfile image) |
| Relational store | RDS Postgres 16 → DSN in Secrets Manager |
| BYOK secret wrap | KMS key + alias; task role has `kms:Encrypt/Decrypt` |
| Secrets | Secrets Manager (session secret, storage DSN) |
| Edge / SSE | ALB (streams by default; 4000s idle timeout for long runs) |
| Identity | anon cookie; set `OPENWOP_OIDC_*` for Cognito/any OIDC |

## Deploy

```bash
# 1. Build + push the backend image to ECR (run from the repo root).
aws ecr create-repository --repository-name openwop-app || true
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
REPO="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/openwop-app"
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker build -t "$REPO:latest" .
docker push "$REPO:latest"

# 2. Apply the infra.
cd deploy/aws
terraform init
terraform apply -var="image=$REPO:latest" -var="region=$REGION"
```

`terraform output backend_url` prints the ALB URL; check `…/readiness`.

## Frontend (SPA)

Host the static SPA on **S3 + CloudFront** (not included in this Terraform to
keep it focused). Build `frontend/react` with `VITE_OPENWOP_BASE_URL` and
`VITE_OPENWOP_SSE_BASE_URL` pointed at the ALB/backend URL, upload `dist/` to a
bucket, front it with CloudFront, then set `-var="cors_origins=https://<cf-domain>"`
and re-apply so the backend allows the SPA origin. CloudFront must **not** buffer
`/api` (use a streaming-friendly cache policy / origin request policy) — the same
non-buffering-edge requirement every pack documents.

## Production notes

- Set `acm_certificate_arn` to terminate HTTPS at the ALB (HTTP redirects to
  HTTPS automatically). Without it the listener serves HTTP for eval only.
- `OPENWOP_DEPLOY_POSTURE=auth` is fully supported here: RDS + the KMS key meet
  the persistent-secret requirement out of the box. Wire `OPENWOP_OIDC_*` to
  Cognito (`https://cognito-idp.<region>.amazonaws.com/<pool>`) or any issuer.
- Move off the default VPC and add private subnets + NAT for the Fargate tasks
  in a real deployment.
