#!/bin/bash

# Configuration
PROJECT_ID="project-7d419673-e0b3-4ba1-9ba"
POOL_NAME="github-pool-v2"  # New name to avoid deletion latency issues
PROVIDER_NAME="github-provider"
SERVICE_ACCOUNT_NAME="github-actions-deployer"
REPO="alok-simplecrm/code-companion-backend"

echo "Starting fresh WIF setup..."

# 1. Create the Workload Identity Pool
gcloud iam workload-identity-pools create "$POOL_NAME" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --display-name="GitHub Actions Pool V2"

# 2. Create the Workload Identity Provider (Fixed mapping)
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_NAME" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="$POOL_NAME" \
  --display-name="GitHub Actions Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --issuer-uri="https://token.actions.githubusercontent.com"

# 3. Ensure Service Account exists (it should, but we check)
gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
  --project="${PROJECT_ID}" --display-name="GitHub Actions Deployer" || echo "Service account already exists."

# 4. Allow GitHub to impersonate the Service Account
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

gcloud iam service-accounts add-iam-policy-binding "${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/$POOL_NAME/attribute.repository/$REPO"

# 5. Output the values needed for GitHub Secrets
echo ""
echo "---------------------------------------------------------"
echo "ADD THESE TO GITHUB SECRETS (Settings > Secrets > Actions):"
echo ""
echo "GCP_PROJECT_ID: $PROJECT_ID"
echo "WIF_PROVIDER: projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/$POOL_NAME/providers/$PROVIDER_NAME"
echo "WIF_SERVICE_ACCOUNT: ${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
echo "---------------------------------------------------------"
