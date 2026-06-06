# 19 — Cost Model

## Methodology

All costs in USD unless noted. Exchange rate assumption: CLP 950/USD. Costs are monthly unless marked annual. Infrastructure costs are AWS sa-east-1 (São Paulo) pricing, which carries a ~20% premium over us-east-1.

---

## Phase 1: MVP Launch (0–10,000 Users)

### Infrastructure (Monthly)

| Component | Service | Spec | Cost/mo |
|---|---|---|---|
| Kubernetes (EKS) | EKS control plane | — | $73 |
| App nodes | 6× m6i.xlarge | 4 vCPU, 16GB | $840 |
| Aurora PostgreSQL | db.r6g.large writer + 1 replica | 2 vCPU, 16GB | $480 |
| ElastiCache Redis | cache.r6g.large cluster | 2 vCPU, 13GB | $240 |
| MSK Kafka | 3× kafka.m5.large | — | $540 |
| S3 (storage) | 5TB + requests | — | $120 |
| CloudFront CDN | 1TB transfer | — | $85 |
| AWS WAF | 1M requests | — | $60 |
| Load Balancer (ALB) | 2× ALB | — | $50 |
| AWS Shield Standard | Included | — | $0 |
| CloudWatch / X-Ray | Logs + traces | — | $150 |
| Secrets Manager | 50 secrets | — | $25 |
| KMS | 5 keys + 1M API calls | — | $30 |
| NAT Gateways | 3× (one per AZ) | — | $100 |
| Data transfer | Intra-AZ + egress | — | $200 |
| **Infrastructure Total** | | | **$2,993/mo** |

### Vendor Costs (Monthly)

| Vendor | Purpose | Pricing Basis | Est. Cost/mo |
|---|---|---|---|
| Mambu | Core banking | $1.50/account/mo × 8,000 active accounts | $12,000 |
| Sumsub | KYC verification | $2.50/verification × 300 new users/mo | $750 |
| ComplyAdvantage | AML/Sanctions | Base plan ~$2,500/mo | $2,500 |
| Marqeta | Card processing | $0.10/card tx × 50K tx/mo | $5,000 |
| Twilio | SMS notifications | $0.025/SMS × 30K/mo | $750 |
| SendGrid | Email | $0.001/email × 50K/mo | $50 |
| Firebase (FCM) | Push notifications | Free tier | $0 |
| Anthropic Claude | AI assistant | $0.018/1K tokens × 5M tokens/mo | $90 |
| Datadog | Monitoring | Pro plan, 20 hosts | $1,500 |
| HashiCorp Vault | Secrets management | HCP Vault Starter | $600 |
| PagerDuty | On-call alerts | Team plan | $300 |
| LaunchDarkly | Feature flags | Starter | $200 |
| **Vendor Total** | | | **$23,740/mo** |

### Compliance & Security (Annual)

| Item | Frequency | Cost |
|---|---|---|
| PCI-DSS SAQ D (Level 2) | Annual | $25,000 |
| ISO 27001 gap analysis | Year 1 | $30,000 |
| Penetration testing | Semi-annual | $40,000/year |
| Legal / regulatory counsel (CMF) | Ongoing | $80,000/year |
| CMF banking license application | One-time | $50,000 |
| UAF compliance officer training | Annual | $5,000 |
| **Compliance Total (annualized)** | | **$230,000/year → $19,167/mo** |

### Engineering Team (Monthly, Chile-based)

| Role | Count | Salary CLP/mo | Cost USD/mo |
|---|---|---|---|
| Engineering Lead | 1 | CLP 7,500,000 | $7,895 |
| Senior Backend Engineers (Go) | 4 | CLP 5,500,000 each | $23,158 |
| Senior Backend Engineers (Python) | 2 | CLP 5,000,000 each | $10,526 |
| Mobile Engineers (Flutter) | 3 | CLP 5,000,000 each | $15,789 |
| DevOps/Platform Engineer | 2 | CLP 5,500,000 each | $11,579 |
| Security Engineer | 1 | CLP 6,000,000 | $6,316 |
| QA Engineer | 2 | CLP 3,500,000 each | $7,368 |
| Product Manager | 1 | CLP 5,000,000 | $5,263 |
| Designer (UX) | 1 | CLP 4,000,000 | $4,211 |
| Compliance Engineer | 1 | CLP 5,000,000 | $5,263 |
| Overhead (benefits, office, tools) | +30% | — | $29,150 |
| **Team Total** | **18** | | **$125,518/mo** |

### Phase 1 Total Monthly Burn Rate

| Category | Monthly |
|---|---|
| Infrastructure | $2,993 |
| Vendors | $23,740 |
| Compliance (amortized) | $19,167 |
| Engineering Team | $125,518 |
| **Total** | **$171,418/mo → ~$2.06M/year** |

**Phase 1 Capital Required (12 months): ~$2.5M USD** (includes buffer, working capital, regulatory capital for Fintech license).

---

## Phase 2: Growth (10,000–100,000 Users)

### Infrastructure Scaling (Monthly Delta from Phase 1)

| Change | Delta Cost |
|---|---|
| Scale EKS to 12 app nodes (m6i.2xlarge) | +$2,800 |
| Aurora: add read replicas per service | +$1,440 |
| Redis: upgrade to cluster mode (6 shards r6g.large) | +$800 |
| MSK: scale to 6 brokers | +$540 |
| AWS Shield Advanced (required at scale) | +$3,000 |
| Datadog: scale to 50 hosts | +$2,000 |
| Additional S3, CloudFront (10TB) | +$400 |
| **Phase 2 Infrastructure Total** | **~$14,000/mo** |

### Vendor Scaling (100K users)

| Vendor | New Basis | Cost/mo |
|---|---|---|
| Mambu | $1.20/account × 80K accounts | $96,000 |
| Sumsub | $2.00/verification × 2,000 new/mo | $4,000 |
| ComplyAdvantage | Growth plan ~$8,000/mo | $8,000 |
| Marqeta | $0.08/tx × 500K tx/mo | $40,000 |
| Twilio | $0.025/SMS × 200K/mo | $5,000 |
| Anthropic Claude | $0.018/1K × 50M tokens/mo | $900 |
| Feedzai (transaction monitoring) | $0.007/tx × 500K/mo | $3,500 |
| **Phase 2 Vendor Total** | | **~$167,400/mo** |

### Engineering Team Expansion

| New Hires | Count | Monthly Cost |
|---|---|---|
| Backend Engineers | +6 | +$31,578 |
| Mobile Engineers | +2 | +$10,526 |
| Data Engineer (ML) | +2 | +$10,526 |
| SRE Engineers | +3 | +$17,368 |
| Security Engineers | +1 | +$6,316 |
| Overhead 30% | — | +$22,895 |
| **Team Addition Total** | +14 → 32 total | **+$99,209/mo** |

**Phase 2 Total Monthly Burn: ~$442K/mo → $5.3M/year**

---

## Phase 3: Scale (100,000–1,000,000 Users)

### Infrastructure (1M users)

| Component | Spec | Monthly |
|---|---|---|
| EKS nodes | 30× m6i.4xlarge + 6× r6i.4xlarge (ML) | $15,000 |
| Aurora PostgreSQL | db.r6g.4xlarge per service cluster, 2 replicas | $18,000 |
| Aurora Limitless (ledger) | Distributed writer tier | $8,000 |
| ElastiCache Redis | 6 shards × r6g.2xlarge | $4,000 |
| MSK Kafka | 9 brokers × kafka.m5.4xlarge | $6,500 |
| ClickHouse | 3× c6a.8xlarge | $2,800 |
| Redshift | ra3.4xlarge × 3 | $4,500 |
| CloudFront | 50TB transfer | $2,000 |
| Shield Advanced | — | $3,000 |
| Monitoring (Datadog) | 150 hosts | $9,000 |
| All other AWS services | — | $8,000 |
| **Infrastructure Total** | | **$80,800/mo** |

### Vendor Scaling (1M users)

| Vendor | Basis | Monthly |
|---|---|---|
| Mambu | $0.90/account × 800K active | $720,000 |
| Marqeta | $0.06/tx × 5M tx/mo | $300,000 |
| ComplyAdvantage | Enterprise: $30,000/mo | $30,000 |
| Sumsub | $1.50/verification × 10K/mo | $15,000 |
| Twilio | $0.02/SMS × 1M/mo | $20,000 |
| Anthropic Claude | $0.015/1K × 500M tokens/mo | $7,500 |
| **Vendor Total** | | **~$1,092,500/mo** |

> **Note**: At 1M users, Mambu costs ~$720K/mo. This is the primary driver for considering a custom core banking build or negotiating an enterprise deal. At $8.6M/year for just Mambu, the ROI on a $5M custom core banking build is compelling within 18 months.

### Phase 3 Total: ~$1.8M/mo ($21.6M/year)

---

## Unit Economics Model

### Revenue Per User (Year 2 Stabilized)

| Revenue Source | ARPU/mo (CLP) | ARPU/mo (USD) |
|---|---|---|
| Net Interest Margin (30% of users with loan avg $2M CLP) | CLP 2,100 | $2.21 |
| Interchange (debit) | CLP 800 | $0.84 |
| Interchange (credit) | CLP 1,200 | $1.26 |
| Monthly fee (50% on paid plan CLP 2,995) | CLP 1,498 | $1.58 |
| FX spread | CLP 300 | $0.32 |
| Investment management | CLP 200 | $0.21 |
| **Total ARPU** | **CLP 6,098** | **$6.42** |

### CAC (Customer Acquisition Cost)

| Channel | CAC (CLP) | CAC (USD) |
|---|---|---|
| Referral program | CLP 5,000 | $5.26 |
| Digital ads (Meta/Google) | CLP 15,000 | $15.79 |
| Influencer / brand | CLP 12,000 | $12.63 |
| Blended CAC (Year 1) | **CLP 10,000** | **$10.53** |

### LTV / CAC Ratio

| Metric | Value |
|---|---|
| Monthly ARPU | $6.42 |
| Monthly gross margin | 58% → $3.72 |
| Monthly churn rate (Year 2) | 1.5% |
| LTV (1 / churn × monthly margin) | $248 |
| Blended CAC | $10.53 |
| **LTV/CAC Ratio** | **23.5×** |
| Payback period | ~3 months |

> LTV/CAC of 23.5× is strong (>3× is acceptable for investors). Key risk: these numbers require active product engagement and loan book growth. Churn above 3% cuts LTV to $124 and ratio to 11.8×.

---

## 5-Year Total Cost of Ownership

| Year | Users (MAU) | Revenue ($) | COGS ($) | Gross Margin | OpEx ($) | EBITDA ($) |
|---|---|---|---|---|---|---|
| Y1 | 15,000 | $1.16M | $0.81M | 30% | $2.50M | ($2.15M) |
| Y2 | 75,000 | $5.78M | $3.29M | 43% | $5.30M | ($2.81M) |
| Y3 | 250,000 | $19.26M | $9.48M | 51% | $12.00M | ($2.22M) |
| Y4 | 600,000 | $46.22M | $20.30M | 56% | $22.00M | $3.92M |
| Y5 | 1,200,000 | $92.45M | $38.26M | 59% | $38.00M | $16.19M |

**Break-even: Year 4 (Month ~38)**. Requires ~$20M total funding through breakeven.

Funding requirements:
- Seed / Pre-Series A: $2.5M (MVP)
- Series A: $8M (growth to 75K users)
- Series B: $20M (scale + LATAM)
