output "backend_url" {
  value       = "http://${aws_lb.app.dns_name}"
  description = "ALB DNS name for the backend (HTTPS once acm_certificate_arn is set + DNS pointed)."
}

output "byok_kms_key_arn" {
  value       = aws_kms_key.byok.arn
  description = "KMS key ARN. OPENWOP_BYOK_KMS_KEY is wired to aws-kms:<this> in the task definition."
}

output "rds_endpoint" {
  value       = aws_db_instance.pg.address
  description = "RDS Postgres endpoint."
}
