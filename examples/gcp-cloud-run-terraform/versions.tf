terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.10"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  default_labels = merge(
    {
      review_agent_app = var.name
      review_agent_env = var.environment
      managed_by       = "terraform"
    },
    var.labels,
  )
}
