# MaWire Bank — Digital Banking Platform Blueprint

A complete implementation-level blueprint for launching a fully regulated digital bank in Chile, designed for expansion across Latin America.

This document set is equivalent to a consulting engagement by McKinsey, BCG, Accenture, Deloitte, and a Tier-1 Banking Technology Vendor — produced by a team of 18 specialist personas covering every domain of modern digital banking.

---

## What Is This?

MaWire Bank is a greenfield digital banking platform designed to:

- Operate as a fully licensed financial institution under Chilean law (CMF, Banco Central, UAF)
- Serve Consumer, SME, Business, and Corporate banking segments
- Compete directly with BancoEstado, Banco Santander Chile, and neobanks like Tenpo and Mach
- Expand across Latin America starting with Colombia, Peru, and Mexico

---

## Regulatory Coverage

| Framework | Status |
|-----------|--------|
| CMF (Comisión para el Mercado Financiero) | ✅ Fully mapped |
| Banco Central de Chile | ✅ LBTR, TEF integration |
| Ley Fintec 21.521 | ✅ Open Finance architecture |
| UAF (AML/CFT) | ✅ Transaction monitoring + reporting |
| PCI-DSS Level 1 | ✅ Card processing architecture |
| ISO 27001 | ✅ Control mapping |
| SOC 2 Type II | ✅ Trust criteria mapping |
| FATCA / CRS | ✅ Reporting framework |
| KYC / AML | ✅ Full onboarding + monitoring |

---

## Document Index

| # | Section | Description |
|---|---------|-------------|
| [01](docs/01-business-model.md) | Business Model | Revenue model, product catalog, margins, 5-year projections |
| [02](docs/02-product-roadmap.md) | Product Roadmap | 4-phase roadmap, features, costs, team, regulatory milestones |
| [03](docs/03-architecture-overview.md) | System Architecture | Microservices, event-driven design, frontend, API gateway |
| [04](docs/04-core-banking.md) | Core Banking | Mambu vs Thought Machine vs Temenos evaluation + integration |
| [05](docs/05-ledger-system.md) | Ledger System | Double-entry ledger, PostgreSQL schema, settlement, reconciliation |
| [06](docs/06-payments-infrastructure.md) | Payments Infrastructure | TEF, LBTR, SWIFT, QR payments, Transbank integration |
| [07](docs/07-card-issuing.md) | Card Issuing | Visa/MC integration, Marqeta, Apple Pay, Google Pay, PCI scope |
| [08](docs/08-identity-kyc-onboarding.md) | Identity & KYC | Digital onboarding, Sumsub, Registro Civil, risk scoring |
| [09](docs/09-aml-platform.md) | AML Platform | Transaction monitoring, UAF reporting, sanctions screening |
| [10](docs/10-fraud-detection.md) | Fraud Detection | ML models, rules engine, device fingerprinting, behavioral biometrics |
| [11](docs/11-security-architecture.md) | Security Architecture | Zero Trust, HSM, PCI-DSS, ISO 27001, SOC 2 mapping |
| [12](docs/12-open-finance.md) | Open Finance | Ley Fintec consent management, OAuth 2.0 + FAPI 2.0, API catalogue |
| [13](docs/13-ai-banking-layer.md) | AI Banking Layer | Claude-powered assistant, RAG, spending insights, cash flow forecasting |
| [14](docs/14-cloud-infrastructure.md) | Cloud Infrastructure | AWS VPC design, EKS, multi-region DR, WAF, Shield Advanced |
| [15](docs/15-devops-architecture.md) | DevOps Architecture | CI/CD, GitOps, ArgoCD, Terraform, observability stack |
| [16](docs/16-database-architecture.md) | Database Architecture | PostgreSQL, Redis, Kafka, Redshift — per-service assignments |
| [17](docs/17-mobile-ux-ui.md) | Mobile UX/UI | Consumer and business app screen-by-screen design with UX rationale |
| [18](docs/18-banking-apis.md) | Banking APIs | OpenAPI 3.0 specs, webhooks, rate limiting, error codes |
| [19](docs/19-cost-model.md) | Cost Model | Infrastructure, compliance, vendor, and team costs at 4 scales |
| [20](docs/20-technical-due-diligence.md) | Technical Due Diligence | ADRs, risk matrix, investment readiness, remediation roadmap |

---

## Technology Stack Summary

### Frontend
- **Mobile**: Flutter (iOS + Android) — biometric, NFC, offline-first
- **Web**: Next.js 14 + TypeScript + Tailwind CSS
- **Admin Portals**: React — 5 separate portals (Ops, Compliance, Fraud, Treasury, Support)

### Backend
- **Language**: Go (core services), Python (ML/compliance), Node.js (notifications)
- **Architecture**: Microservices + Event-driven (Kafka)
- **Service Mesh**: Istio with mTLS
- **API Gateway**: Kong

### Core Banking
- **Recommendation**: Mambu (Phase 1-2) → Custom (Phase 3+)
- **Integration**: REST API + webhooks + custom ledger layer

### Infrastructure
- **Cloud**: AWS (sa-east-1 primary, us-east-1 DR)
- **Containers**: EKS (Kubernetes 1.30)
- **IaC**: Terraform + Terragrunt
- **GitOps**: ArgoCD

### Data
- **Primary**: Aurora PostgreSQL (per-service)
- **Cache**: ElastiCache Redis (Cluster mode)
- **Streaming**: Amazon MSK (Kafka)
- **Analytics**: Amazon Redshift
- **Vectors**: pgvector (AI/RAG)

### Security
- **Secrets**: HashiCorp Vault
- **HSM**: AWS CloudHSM (PCI card keys)
- **Zero Trust**: Istio + SPIFFE/SPIRE
- **SIEM**: Elastic SIEM + AWS Security Hub

### AI
- **LLM**: Anthropic Claude (claude-sonnet-4-6)
- **Embeddings**: text-embedding-3-small
- **Vector DB**: pgvector on PostgreSQL
- **ML**: LightGBM (fraud), XGBoost (categorization), ARIMA (forecasting)

---

## Cost Summary

| Scale | Monthly Infra | Team (monthly) | Compliance (annual) | Total Annual |
|-------|--------------|----------------|---------------------|--------------|
| MVP (0-10K users) | ~$15K | ~$120K | ~$250K | ~$1.9M |
| Growth (10K-100K) | ~$45K | ~$300K | ~$400K | ~$4.3M |
| Scale (100K-1M) | ~$150K | ~$700K | ~$600K | ~$10.8M |
| Enterprise (1M+) | ~$500K+ | ~$1.5M+ | ~$1M+ | ~$25M+ |

---

## Investment Requirements

| Round | Amount | Milestone | Valuation |
|-------|--------|-----------|-----------|
| Pre-seed | $2.5M | MVP launch, CMF filing | $8-12M |
| Seed | $5M | 50K users, regulatory approval | $20-30M |
| Series A | $20M | 200K users, full banking license | $80-120M |
| Series B | $50M | LATAM expansion | $300-500M |

---

## Team Structure at Launch

```
CEO / Founder
├── CTO
│   ├── Core Platform (8 engineers)
│   ├── Payments (5 engineers)
│   ├── Mobile (4 engineers)
│   ├── Data/ML (3 engineers)
│   ├── Platform/SRE (4 engineers)
│   └── Security (3 engineers)
├── CPO (Product + Design)
├── CFO
├── Chief Risk Officer
│   ├── AML Compliance Officer (OFCC)
│   ├── Credit Risk
│   └── Operational Risk
└── Chief Compliance Officer
    └── Regulatory Affairs
```

---

## Getting Started (for Engineering Teams)

1. Start with [Architecture Overview](docs/03-architecture-overview.md) for the complete system design
2. Review [Core Banking](docs/04-core-banking.md) for the Mambu integration approach
3. Read [Security Architecture](docs/11-security-architecture.md) before writing any code
4. Use [Database Architecture](docs/16-database-architecture.md) for service-level database decisions
5. Follow [DevOps Architecture](docs/15-devops-architecture.md) to set up CI/CD

---

*Blueprint produced by MaWire Bank founding team. All regulatory references are based on Chilean law as of 2026. Consult licensed legal counsel before regulatory submissions.*
