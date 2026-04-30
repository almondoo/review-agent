terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = merge(
      {
        "review-agent.app" = var.name
        "review-agent.env" = var.environment
        "managed-by"       = "terraform"
      },
      var.tags,
    )
  }
}
