# OpenWOP app — AWS deploy pack (Fargate + RDS + Secrets Manager + KMS + ALB).
#
# Provisions the backend on ECS Fargate behind an Application Load Balancer,
# with RDS Postgres for storage, Secrets Manager for the session/admin/BYOK
# secrets, and a KMS key for production BYOK envelope encryption
# (OPENWOP_BYOK_KMS_KEY=aws-kms:<key-arn>). The SPA (S3 + CloudFront) is left to
# the README so this file stays focused on the backend control plane.
#
# Status: syntax-reviewed scaffold. Run `terraform init && terraform validate &&
# terraform plan` in your account before apply — it has NOT been applied live.
# Uses the default VPC to keep the footprint small; swap in your own VPC for
# production.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region
}

locals {
  name = var.name_prefix
  tags = { Project = "openwop-app", ManagedBy = "terraform" }
}

# ── Network (default VPC for a small footprint) ──────────────────────────────
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# ── Generated secrets ────────────────────────────────────────────────────────
resource "random_password" "session" {
  length  = 48
  special = false
}

resource "random_password" "db" {
  length  = 32
  special = false
}

# ── KMS key for BYOK envelope encryption ─────────────────────────────────────
resource "aws_kms_key" "byok" {
  description             = "${local.name} OpenWOP BYOK envelope key"
  deletion_window_in_days = 14
  enable_key_rotation     = true
  tags                    = local.tags
}

resource "aws_kms_alias" "byok" {
  name          = "alias/${local.name}-byok"
  target_key_id = aws_kms_key.byok.key_id
}

# ── Secrets Manager ──────────────────────────────────────────────────────────
resource "aws_secretsmanager_secret" "session" {
  name = "${local.name}-session-secret"
  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "session" {
  secret_id     = aws_secretsmanager_secret.session.id
  secret_string = random_password.session.result
}

resource "aws_secretsmanager_secret" "storage_dsn" {
  name = "${local.name}-storage-dsn"
  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "storage_dsn" {
  secret_id     = aws_secretsmanager_secret.storage_dsn.id
  secret_string = "postgres://${var.db_username}:${random_password.db.result}@${aws_db_instance.pg.address}:5432/${var.db_name}"
}

# ── RDS Postgres ─────────────────────────────────────────────────────────────
resource "aws_security_group" "db" {
  name   = "${local.name}-db"
  vpc_id = data.aws_vpc.default.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_db_instance" "pg" {
  identifier             = "${local.name}-pg"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = var.db_instance_class
  allocated_storage      = 20
  db_name                = var.db_name
  username               = var.db_username
  password               = random_password.db.result
  vpc_security_group_ids = [aws_security_group.db.id]
  skip_final_snapshot    = true
  publicly_accessible    = false
  tags                   = local.tags
}

# ── ALB ──────────────────────────────────────────────────────────────────────
resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = data.aws_vpc.default.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_lb" "app" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids
  # SSE correctness: do NOT enable response buffering. The ALB streams by
  # default; keep the idle timeout long enough for live run streams.
  idle_timeout = 4000
  tags         = local.tags
}

resource "aws_lb_target_group" "app" {
  name        = "${local.name}-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "ip"
  health_check {
    path     = "/readiness"
    matcher  = "200"
    interval = 30
    timeout  = 5
  }
  tags = local.tags
}

resource "aws_lb_listener" "https" {
  count             = var.acm_certificate_arn == "" ? 0 : 1
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# HTTP listener: forwards directly when no ACM cert is supplied (dev), else
# redirects to HTTPS.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = var.acm_certificate_arn == "" ? "forward" : "redirect"
    target_group_arn = var.acm_certificate_arn == "" ? aws_lb_target_group.app.arn : null
    dynamic "redirect" {
      for_each = var.acm_certificate_arn == "" ? [] : [1]
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

# ── ECS Fargate service ──────────────────────────────────────────────────────
resource "aws_security_group" "app" {
  name   = "${local.name}-app"
  vpc_id = data.aws_vpc.default.id
  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_ecs_cluster" "app" {
  name = local.name
  tags = local.tags
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = 14
  tags              = local.tags
}

# Execution role — pulls the image + reads secrets at task launch.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "${local.name}-exec-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.session.arn, aws_secretsmanager_secret.storage_dsn.arn]
    }]
  })
}

# Task role — the running container; needs KMS encrypt/decrypt for BYOK.
resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "task_kms" {
  name = "${local.name}-task-kms"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Encrypt", "kms:Decrypt"]
      Resource = [aws_kms_key.byok.arn]
    }]
  })
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "backend"
    image     = var.image
    essential = true
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "8080" },
      { name = "OPENWOP_DEPLOY_POSTURE", value = var.deploy_posture },
      { name = "OPENWOP_COOKIE_SECURE", value = "true" },
      { name = "OPENWOP_SURFACE_BACKEND", value = "durable" },
      { name = "OPENWOP_BYOK_KMS_KEY", value = "aws-kms:${aws_kms_key.byok.arn}" },
      { name = "OPENWOP_CORS_ORIGINS", value = var.cors_origins },
    ]
    secrets = [
      { name = "OPENWOP_SESSION_SECRET", valueFrom = aws_secretsmanager_secret.session.arn },
      { name = "OPENWOP_STORAGE_DSN", valueFrom = aws_secretsmanager_secret.storage_dsn.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "backend"
      }
    }
  }])

  tags = local.tags
}

resource "aws_ecs_service" "app" {
  name            = local.name
  cluster         = aws_ecs_cluster.app.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "backend"
    container_port   = 8080
  }

  depends_on = [aws_lb_listener.http]
  tags       = local.tags
}
