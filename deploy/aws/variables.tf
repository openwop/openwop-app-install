variable "region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region."
}

variable "name_prefix" {
  type        = string
  default     = "openwop-app"
  description = "Prefix for all resource names."
}

variable "image" {
  type        = string
  description = "Backend container image (push the root Dockerfile to ECR first; see README)."
}

variable "deploy_posture" {
  type        = string
  default     = "cookie-per-visitor"
  description = "OPENWOP_DEPLOY_POSTURE: cookie-per-visitor | bearer-shared | auth."
}

variable "cors_origins" {
  type        = string
  default     = ""
  description = "Comma-separated allowed SPA origins (the CloudFront/S3 URL)."
}

variable "acm_certificate_arn" {
  type        = string
  default     = ""
  description = "ACM cert ARN for HTTPS on the ALB. Empty = HTTP-only (dev/eval)."
}

variable "db_name" {
  type    = string
  default = "openwop"
}

variable "db_username" {
  type    = string
  default = "openwop"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "task_cpu" {
  type    = string
  default = "512"
}

variable "task_memory" {
  type    = string
  default = "1024"
}

variable "desired_count" {
  type    = number
  default = 1
}
