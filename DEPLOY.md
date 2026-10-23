# Deploy to GCP (Cloud Run + Cloud SQL)

The whole stack runs as one service (`@ask/api`): REST API + background jobs +
the hosted MCP endpoint (`/mcp`). GCP hosts it natively — a warm Cloud Run
service plus Cloud SQL for Postgres with `pgvector`. No rearchitecting.

> **⚠️ Single instance only.** The cron jobs (index / decay / warm /
> backfill) must run in exactly ONE process — a second instance means duplicate
> runs. (Postgres LISTEN is per SSE client and harmless across instances.) Pin
> `--min-instances=1 --max-instances=1`.

Set these once:

```bash
export PROJECT_ID=<your-project>
export REGION=us-central1
export INSTANCE=ask-db
export DB=ask
export DBUSER=ask
```

## 1. Authenticate + enable APIs

```bash
gcloud auth login
gcloud config set project "$PROJECT_ID"
gcloud config set run/region "$REGION"

gcloud services enable \
  run.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
```

## 2. Cloud SQL (Postgres + pgvector)

```bash
gcloud sql instances create "$INSTANCE" \
  --database-version=POSTGRES_16 --tier=db-g1-small --region="$REGION"

gcloud sql databases create "$DB" --instance="$INSTANCE"
gcloud sql users create "$DBUSER" --instance="$INSTANCE" --password='<STRONG_PASSWORD>'

# Enable pgvector (opens a psql prompt; run the CREATE EXTENSION, then \q):
gcloud sql connect "$INSTANCE" --user="$DBUSER" --database="$DB"
#   CREATE EXTENSION IF NOT EXISTS vector;
```

Note the instance connection name (`PROJECT:REGION:INSTANCE`):

```bash
gcloud sql instances describe "$INSTANCE" --format='value(connectionName)'
```

## 3. Run migrations

> **`ask-db` is private-IP only** (no public IP — see [Networking](#networking-private-ip)).
> A laptop `cloud-sql-proxy` can't reach it directly; go through the `ask-bastion`
> IAP tunnel.

```bash
# one terminal — IAP SSH port-forward: laptop 127.0.0.1:5433 -> bastion -> DB private IP:
gcloud compute ssh ask-bastion --zone=us-central1-a --tunnel-through-iap \
  -- -N -L 5433:<DB_PRIVATE_IP>:5432

# another terminal, from the repo root — SSL is enforced (ENCRYPTED_ONLY):
export DATABASE_URL="postgresql://$DBUSER:<PASSWORD>@127.0.0.1:5433/$DB?sslmode=require"
pnpm db:migrate
```

(Get the DB private IP with
`gcloud sql instances describe ask-db --format='value(ipAddresses[].ipAddress)'`.)

## 4. Secrets

Create secrets from your `.env.local` values (never commit them). The runtime
DATABASE_URL uses the Cloud Run unix socket, not the proxy:

```bash
CONN=$(gcloud sql instances describe "$INSTANCE" --format='value(connectionName)')
printf 'postgresql://%s:%s@/%s?host=/cloudsql/%s' "$DBUSER" '<PASSWORD>' "$DB" "$CONN" \
  | gcloud secrets create database-url --data-file=-

for s in anthropic-key voyage-key api-keys ask-api-key; do
  gcloud secrets create "$s" --replication-policy=automatic
done
# then add each value:
printf '<value>' | gcloud secrets versions add anthropic-key --data-file=-
# …repeat for voyage-key, api-keys (e.g. "devkey123:prod:admin:private"), ask-api-key

```

Grant the Cloud Run runtime service account access (the default compute SA works
to start):

```bash
PN=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
for s in database-url anthropic-key voyage-key api-keys ask-api-key; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
done
```

## 5. Deploy

```bash
CONN=$(gcloud sql instances describe "$INSTANCE" --format='value(connectionName)')

gcloud run deploy ask-anything \
  --source . \
  --region "$REGION" \
  --min-instances=1 --max-instances=1 \
  --no-cpu-throttling --cpu=1 --memory=1Gi \
  --timeout=3600 \
  --add-cloudsql-instances "$CONN" \
  --network=ask-net --subnet=ask-central1 --vpc-egress=private-ranges-only \
  --set-env-vars "LLM_PROVIDER=vertex,ASK_ANSWER_MODEL=gemini-2.5-flash,ASK_CHEAP_MODEL=gemini-2.5-flash-lite,EMBEDDINGS_PROVIDER=vertex,EMBEDDINGS_MODEL=gemini-embedding-001,EMBEDDING_DIM=1024,RERANK_ENABLED=true,RERANK_PROVIDER=vertex,RERANK_MODEL=semantic-ranker-default@latest,GOOGLE_VERTEX_PROJECT=$PROJECT_ID,GOOGLE_VERTEX_LOCATION=us-central1,PRIVATE_EGRESS_ALLOWED=true" \
  --set-secrets "DATABASE_URL=database-url:latest,API_KEYS=api-keys:latest,ASK_API_KEY=ask-api-key:latest" \
  --allow-unauthenticated
```

> **Git on the host.** Registered sources are cloned with `git` inside the
> service, into `ASK_WORKDIR` (set it to a writable path; Cloud Run's
> filesystem is ephemeral, so every cold start re-clones). The shipped `git`
> adapter indexes public repositories only; private repositories are a
> planned adapter (ADR-0020).

> **Networking**: `--network/--subnet/--vpc-egress` give Cloud Run Direct VPC
> egress into `ask-net`, so the `--add-cloudsql-instances` connector reaches the
> DB over its private IP. `private-ranges-only` sends just RFC1918 through the VPC;
> Vertex/Anthropic keep normal egress. See [Networking](#networking-private-ip).

> **Models run on Vertex** — Gemini 2.5 Flash (answers), Flash-Lite (cheap ops),
> `gemini-embedding-001` @ 1024 dims (embeddings), and the Vertex Ranking API
> (rerank). No model API keys needed — the Cloud Run runtime SA authenticates to
> Vertex via ADC. Grant it `roles/aiplatform.user` and
> `roles/discoveryengine.editor`.

- **`--allow-unauthenticated` is required** for the public MCP endpoint. The
  service is reachable without a GCP identity token, but every `/v1/*` route
  still enforces the `API_KEYS` bearer key at the app layer. Only `/mcp` (the
  MCP Streamable HTTP transport, public by design, pinned to public visibility)
  and `/health` are open.
- `--timeout=3600` gives SSE streams headroom.
- `ASK_API_URL` / `ASK_API_KEY` are client-side settings (the `ask` CLI and the
  stdio MCP proxy). The service does not read them; `ask-api-key` is kept as a
  secret so laptops running the CLI / eval can pull it.

## 6. Verify

```bash
URL=$(gcloud run services describe ask-anything --region "$REGION" --format='value(status.url)')
curl -s "$URL/health"      # {"status":"ok",...}  (needs --allow-unauthenticated, else use IAM)
gcloud run services logs read ask-anything --region "$REGION" --limit=50
# look for: "ask-api listening"
```

Cron jobs (index/decay/warm/backfill) fire on their schedules inside the
same instance. Pending proposals are reviewed with the `ask` CLI or
the management MCP over the REST API (`GET /v1/proposals`).

## 7. Custom domain

Serve the public endpoint at **`https://<your-domain>/mcp`** (e.g.
`mcp.example.com`) via a Cloud Run domain mapping. The example below assumes
Any DNS host works.

```bash
# The parent domain must be verified under this account first
# (gcloud domains list-user-verified / gcloud domains verify <domain>).
gcloud beta run domain-mappings create \
  --service ask-anything --domain <your-domain> --region us-central1
```

The command prints one DNS record. Add it at your DNS host (the parent zone):

| Type  | Name          | Target                  | Proxy         |
|-------|---------------|-------------------------|---------------|
| CNAME | `<subdomain>` | `ghs.googlehosted.com.` | **DNS only** ⚠️ |

> ⚠️ **Grey cloud (DNS only), not proxied.** Cloud Run provisions and renews a
> Google-managed TLS cert against the origin; a proxying CDN in front of it
> breaks issuance and causes redirect loops. If you want a proxying CDN in
> front, that's a different topology (serverless NEG + external HTTPS LB), not a
> domain mapping.

Cert issuance is Google-side and can take 15 min–several hours. Check status:

```bash
gcloud beta run domain-mappings describe --domain <your-domain> \
  --region us-central1 --format='value(status.conditions)'
# CertificateProvisioned: status True  → then TLS serves within a few minutes.
```

Verify once live:

```bash
curl -s -X POST https://<your-domain>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
# → serverInfo: {"name":"<ASK_NAME>",...}   (default "ask-anything")
```

## Networking (private IP)

`ask-db` has **no public IP** — it is reachable only over its private IP from the
`ask-net` VPC (Cloud Run via Direct VPC egress; humans via the IAP bastion). This
is a one-time setup; the resources persist.

```bash
gcloud services enable compute.googleapis.com servicenetworking.googleapis.com

# VPC + subnet (Private Google Access on so in-VPC hosts can reach Google APIs)
gcloud compute networks create ask-net --subnet-mode=custom
gcloud compute networks subnets create ask-central1 \
  --network=ask-net --region="$REGION" --range=<SUBNET_CIDR> \
  --enable-private-ip-google-access

# Private Services Access range + peering (Cloud SQL private IP is allocated here)
gcloud compute addresses create ask-psa --global --purpose=VPC_PEERING \
  --addresses=<PSA_RANGE> --prefix-length=16 --network=ask-net
gcloud services vpc-peerings connect --service=servicenetworking.googleapis.com \
  --ranges=ask-psa --network=ask-net

# Give the instance a private IP on ask-net, then remove the public IP
gcloud sql instances patch ask-db --network=projects/$PROJECT_ID/global/networks/ask-net
gcloud sql instances patch ask-db --no-assign-ip

# IAP bastion for admin/migration access (no public IP; reached via IAP tunnel)
gcloud compute firewall-rules create ask-allow-iap-ssh \
  --network=ask-net --direction=INGRESS --action=ALLOW \
  --rules=tcp:22 --source-ranges=35.235.240.0/20
gcloud compute instances create ask-bastion \
  --zone=us-central1-a --machine-type=e2-micro \
  --network-interface=subnet=ask-central1,no-address \
  --image-family=debian-12 --image-project=debian-cloud
```

Cloud Run reaches the DB through the connector over private IP because the deploy
sets `--network/--subnet/--vpc-egress` (step 5). For laptop DB access (migrations,
ad-hoc SQL), use the bastion IAP tunnel shown in step 3.

## Updating

```bash
gcloud run deploy ask-anything --source . --region "$REGION"   # flags persist across deploys
```

New DB migrations: re-run step 3 (bastion tunnel + `pnpm db:migrate`) before
deploying the code that needs them.
