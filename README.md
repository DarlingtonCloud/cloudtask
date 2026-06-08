# CloudTask — Production-Grade Task Management API on Azure

> A complete Node.js REST API deployed on Azure App Service, backed by Azure SQL Database, Blob Storage, and Key Vault — with zero secrets in code, private networking, CI/CD, and monitoring.

---

## Architecture

```
                    Internet
                       │
                  [App Service]  ◄── GitHub Actions CI/CD
                  (Node.js API)
                   │         │
              [Managed Identity]
              /        │        \
       [Key Vault]  [SQL DB]  [Blob Storage]
           │           │            │
       (secrets)   (tasks,      (file
                    users)    attachments)
           └───────────┴────────────┘
     ┌─────── Private Endpoints in VNet ──────────┐
     │ VNet: 10.0.0.0/16                           │
     │  snet-web:       10.0.1.0/24               │
     │  snet-data:      10.0.2.0/24               │
     │  snet-endpoints: 10.0.3.0/24               │
     └─────────────────────────────────────────────┘
           │
     [Log Analytics]  ◄── all diagnostic logs
     [Azure Monitor]  ◄── HTTP 5xx + latency alerts
     [Budget Alert]   ◄── cost threshold at $20/month
```

---

## Azure Resources Used

| Resource | Purpose | Tier |
|---|---|---|
| App Service | Hosts Node.js API | B1 Linux |
| Azure SQL Database | Tasks, users, assignments | Serverless Gen5 1vCore |
| Blob Storage | File attachments | Standard LRS |
| Key Vault | SQL connection string + secrets | Standard |
| VNet + Subnets | Network isolation | — |
| Private Endpoints | Block public SQL/Storage access | — |
| NSGs | Subnet traffic rules | — |
| Application Insights | Live telemetry + traces | Per-GB |
| Log Analytics | Centralised log store | Pay-per-GB |
| Azure Monitor Alerts | HTTP 5xx + latency | — |
| Cost Budget | Alert at 80% of $20 | — |

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check — DB + Storage connectivity |
| `GET` | `/api/tasks` | List all tasks (filter: `?status=todo`) |
| `POST` | `/api/tasks` | Create a new task |
| `GET` | `/api/tasks/:id` | Get a single task |
| `PUT` | `/api/tasks/:id` | Update a task |
| `DELETE` | `/api/tasks/:id` | Delete a task |
| `POST` | `/api/tasks/:id/attachments` | Upload a file (multipart/form-data, field: `file`) |
| `GET` | `/api/tasks/:id/attachments` | List attachments with 1-hour SAS download URLs |

### Example Request

```bash
# Create a task
curl -X POST https://<app-name>.azurewebsites.net/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Deploy to Azure",
    "status": "todo",
    "priority": "high"
  }'

# Upload a file attachment
curl -X POST https://<app-name>.azurewebsites.net/api/tasks/<task-id>/attachments \
  -F "file=@/path/to/document.pdf"
```

---

## Local Development

### Prerequisites
- Node.js 18+
- Azure CLI (`az login`)
- An Azure subscription

### Setup

```bash
# 1. Clone and install
git clone https://github.com/your-username/cloudtask.git
cd cloudtask
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Azure resource names

# 3. Run locally (connects to real Azure services via az login)
npm run dev

# 4. Run tests (fully mocked, no Azure needed)
npm test
```

---

## Deployment

### Step 1 — Provision Azure Resources

```bash
# Login to Azure
az login
az account set --subscription "<your-subscription-id>"

# Edit the CONFIGURATION section at the top of the script
nano infra/provision.sh

# Run provisioning (takes ~10 minutes)
chmod +x infra/provision.sh
./infra/provision.sh
```

### Step 2 — Add Managed Identity as SQL User

Open `infra/add-sql-mi-user.sql`, replace `<APP_NAME>` with your App Service name, then run it:

```
Azure Portal → SQL Database (cloudtask) → Query Editor → paste and run the SQL
```

### Step 3 — Set Up GitHub Actions

1. In the Azure Portal, go to your App Service → **Overview** → **Get publish profile**
2. Copy the entire XML content
3. In your GitHub repo: **Settings → Secrets → Actions → New repository secret**
   - `AZURE_WEBAPP_NAME` = your App Service name (from `infra/deployed-values.env`)
   - `AZURE_WEBAPP_PUBLISH_PROFILE` = the XML you copied

### Step 4 — Push to Deploy

```bash
git add .
git commit -m "initial deployment"
git push origin main
```

The GitHub Actions pipeline will run tests, then deploy automatically.

### Step 5 — Set Up Monitoring

```bash
source infra/deployed-values.env
chmod +x infra/monitoring.sh
./infra/monitoring.sh
```

---

## Security Design

| Security Control | Implementation |
|---|---|
| **Zero secrets in code** | Key Vault + Managed Identity |
| **No public SQL/Storage** | Private Endpoints in VNet |
| **Identity-based auth** | Managed Identity for all Azure service access |
| **Rate limiting** | 200 req/15min per IP via express-rate-limit |
| **Security headers** | helmet.js (CSP, HSTS, X-Frame-Options, etc.) |
| **Input validation** | All inputs validated before SQL queries |
| **Parameterised queries** | mssql named parameters prevent SQL injection |
| **File type allowlist** | Multer rejects disallowed MIME types |
| **HTTPS only** | App Service enforces TLS 1.2+ |
| **NSGs** | Subnet-level traffic rules |

---

## Cost Estimate

| Resource | Monthly Cost |
|---|---|
| App Service B1 | ~$13.14 |
| Azure SQL Serverless (auto-pauses) | ~$0–5 |
| Blob Storage (< 1 GB) | ~$0.02 |
| Key Vault (< 10k operations) | ~$0.03 |
| Log Analytics (< 1 GB/day) | ~$0 |
| **Total** | **~$15–20** |

> Budget alert fires at $16 (80% of $20 budget).

---

## Project Structure

```
cloudtask/
├── src/
│   ├── config/
│   │   ├── azure.js       # Azure SDK clients + Key Vault bootstrap
│   │   └── database.js    # SQL connection pool + schema migrations
│   ├── middleware/
│   │   └── index.js       # Error handler, request logger
│   ├── routes/
│   │   ├── tasks.js       # All task CRUD + attachment endpoints
│   │   └── health.js      # /api/health check
│   ├── app.js             # Express app factory
│   └── server.js          # Entry point with graceful shutdown
├── tests/
│   └── tasks.test.js      # Jest tests with Azure mocks
├── infra/
│   ├── provision.sh       # Full Azure provisioning script
│   ├── monitoring.sh      # Alerts + budget setup
│   └── add-sql-mi-user.sql # Grant SQL access to managed identity
├── .github/
│   └── workflows/
│       └── deploy.yml     # GitHub Actions CI/CD
├── api.http               # VS Code REST Client — test all endpoints
├── .env.example           # Environment variable template
└── package.json
```
