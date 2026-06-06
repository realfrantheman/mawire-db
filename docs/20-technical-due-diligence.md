# 20 — Technical Due Diligence Review

## Executive Summary

**Platform**: MaWire Bank — Digital Banking Platform for Chile
**Review Scope**: Full technical, regulatory, and commercial assessment
**Assessment Date**: June 2026
**Rating**: **INVESTABLE — with conditions** (Series A ready; Banking License: 18-24 months)

---

## Scoring Summary

| Domain | Score (1-10) | Confidence |
|---|---|---|
| Architecture Quality | 8.5 | High |
| Security Posture | 7.0 | Medium |
| Regulatory Compliance | 6.5 | Medium |
| Scalability | 8.0 | High |
| Engineering Team | 7.5 | Medium |
| Technology Risk | 7.0 | High |
| Operational Maturity | 5.5 | Medium |
| **Overall** | **7.1** | **High** |

---

## Architecture Decision Records (ADRs)

### ADR-001: Core Banking — Mambu vs Custom Build

```
Title:    Core Banking Platform Selection
Status:   ACCEPTED
Date:     2025-Q4
Authors:  CTO, Architecture Team

Context:
MaWire needs to serve customer-facing banking products within 12 months.
Engineering team has 20 engineers. Building a core banking system from scratch
requires 18-24 months and $5-8M in dedicated engineering. Time-to-market is
critical for fundraising milestones.

Options Evaluated:
A) Mambu (cloud-native SaaS) — fastest, highest opex at scale
B) Thought Machine Vault — most flexible, highest capex + complexity
C) Custom Build — maximum control, highest risk and timeline
D) Hybrid: Mambu + Custom Ledger (chosen)

Decision:
Mambu for product configuration, customer accounts, and balance management.
Custom double-entry ledger for financial accounting, regulatory reporting,
and immutable audit trail. Custom payment orchestration layer.

Rationale:
- Mambu has LATAM banking references (Nubank used Mambu early stage)
- 6-9 month time to production vs 18+ months for custom build
- CMF regulatory capability available in Mambu product set
- Custom ledger gives full accounting control without core banking complexity
- Mambu abstraction layer enables future migration

Consequences:
- Opex: ~$720K/month at 1M users (mitigated by: renegotiate at scale, or migrate)
- Vendor risk: Mambu SLA 99.9% uptime; acceptable for Phase 1-2
- Lock-in risk: mitigated by abstraction layer (IAccountRepository interface)

Review Trigger: When Mambu costs exceed $500K/month, reassess custom build ROI.
Review Date: Month 24 post-launch.
```

### ADR-002: Mobile Framework — Flutter vs React Native

```
Title:    Mobile Application Framework Selection
Status:   ACCEPTED
Date:     2025-Q4

Context:
Need native biometrics, NFC (for contactless payments), offline support,
smooth animations (60fps+ for banking UI), and efficient development across
iOS and Android. CMF requires biometric authentication for high-value operations.

Decision: Flutter

Rationale:
- True native rendering (Skia/Impeller) vs JS bridge in React Native
- First-class biometric support via local_auth package
- NFC support via nfc_manager (Visa/MC tokenization)
- Single Dart codebase vs JavaScript (better type safety)
- Faster startup: Dart AOT compilation vs JS JIT
- Flutter has stronger financial services adoption in LATAM (Nubank, Inter Bank)
- Offline-first architecture simpler with Flutter's state management (Riverpod)

Consequences:
- Smaller Dart/Flutter talent pool in Chile vs React Native
- Mitigation: remote engineers, training program, Flutter's growing adoption
- Some third-party SDKs (BioCatch, ThreatMetrix) have Flutter wrappers

Review Date: Month 18.
```

### ADR-003: Event Streaming — Kafka (MSK) vs RabbitMQ vs SQS

```
Title:    Event Streaming Platform
Status:   ACCEPTED
Date:     2025-Q4

Decision: Apache Kafka via AWS MSK

Rationale:
- Log compaction: enables event sourcing pattern for ledger
- Consumer groups: multiple services can independently replay events
- Ordering guarantees per partition (critical for financial state machines)
- Retention: replay months of events for ML training or audit
- MSK: managed Kafka eliminates operational burden
- RabbitMQ: better for task queues, not event streaming at scale
- SQS: simpler but lacks replay, compaction, ordering guarantees

Consequences:
- Higher cost than SQS (~$540/mo Phase 1 vs ~$50 for SQS)
- Operational complexity: partition management, consumer lag monitoring
- Mitigation: MSK handles most ops; Datadog for lag alerting
```

### ADR-004: Database — Aurora PostgreSQL as Primary

```
Title:    Primary Database Technology
Status:   ACCEPTED
Date:     2025-Q4

Decision: Aurora PostgreSQL (AWS) for all transactional workloads

Rationale:
- ACID transactions required for all financial data (ledger, accounts, payments)
- PostgreSQL: battle-tested, extensions (pgvector, pg_stat_statements)
- Aurora: 5× performance vs standard PostgreSQL, automatic storage scaling
- Multi-AZ by default: RTO < 30s automatic failover
- Point-in-time recovery: 5-minute RPO for regulatory disaster recovery
- Team expertise: PostgreSQL most familiar to engineering team

Alternatives rejected:
- CockroachDB: Active-Active multi-region, but immature for complex financial queries
- DynamoDB: NoSQL, ill-suited for relational financial data
- Oracle: Licensing cost, not cloud-native

Consequences:
- Single-vendor dependency (AWS)
- Mitigation: documented migration path to CockroachDB at Phase 4 for LATAM scale
```

### ADR-005: Service Mesh — Istio for Zero Trust

```
Title:    Zero Trust Network — Service Mesh Selection
Status:   ACCEPTED
Date:     2025-Q4

Decision: Istio with mTLS

Rationale:
- PCI-DSS Requirement 1.1: network security between CDE and other zones
- Istio: automatic mTLS between all pods (no code changes required)
- Istio: fine-grained AuthorizationPolicy (service A can only call endpoint X of service B)
- Circuit breaking: prevent cascade failures across services
- Observability: distributed tracing, golden signals per service

Consequences:
- Latency overhead: ~5ms p99 per hop (acceptable; p99 target is 300ms end-to-end)
- Operational complexity: Istio control plane requires dedicated expertise
- Mitigation: dedicated SRE owns Istio configuration; Istio Ambient mode (sidecarless) as future upgrade path
```

---

## Risk Assessment Matrix

### Critical Risks

| Risk | Severity | Likelihood | Impact | Owner | Mitigation |
|---|---|---|---|---|---|
| CMF banking license denied | CRITICAL | Low | Business-ending | CEO/CLO | Start with Fintech license (lower bar); hire ex-CMF advisor |
| Mambu outage (SLA breach) | HIGH | Low | Revenue loss, reputational | CTO | Circuit breakers, degraded mode (read-only), SLA: 4hr RTO |
| Payments rail disruption (ACH Chile) | HIGH | Medium | Payment failures | Payments Lead | Multi-rail routing, LBTR fallback, manual payments desk |
| Card data breach (PCI scope) | CRITICAL | Low | License revocation, fines | CISO | HSM, tokenization, network isolation, annual pentest |
| Key person risk (CTO departure) | HIGH | Medium | Architecture knowledge loss | CEO | Architecture documentation (this document), succession plan |
| Funding gap (runway) | HIGH | Medium | Cessation | CEO/CFO | 18-month runway minimum before Series A raise |
| UAF fine for AML non-compliance | HIGH | Low | CLP 10B+ fine | CCO | ComplyAdvantage deployment, dedicated AML analyst |

### Regulatory Gaps (Pre-Launch)

| Gap | Regulation | Severity | Remediation | Timeline |
|---|---|---|---|---|
| No certified AML Compliance Officer | UAF Res. 150 | CRITICAL | Hire OFCC (Oficial de Cumplimiento) | Month 2 |
| PCI-DSS audit not completed | PCI-DSS | CRITICAL | Engage QSA, target Level 2 | Month 6 |
| CMF Fintech registration pending | Ley 21.521 | CRITICAL | Submit application | Month 3 |
| Privacy policy not finalized | Ley 19.628 | HIGH | External legal review | Month 4 |
| ISO 27001 not certified | CMF IT guidelines | MEDIUM | Gap analysis now, cert by Month 18 | Month 18 |
| SOC 2 Type II not completed | Investor requirement | MEDIUM | Start ISAE 3402 engagement | Month 12 |
| Consumer protection procedures | Sernac | MEDIUM | Draft procedures, register with Sernac | Month 6 |

### Technology Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Mambu API breaking changes | MEDIUM | Pin Mambu API version, contract tests |
| Kafka consumer lag storm | MEDIUM | Auto-scaling consumer groups, lag alerts |
| pgvector performance at 1B embeddings | MEDIUM | Migrate to Pinecone or Qdrant at scale |
| Flutter SDK breaking changes | LOW | Version pinning, CI upgrade testing |
| LLM provider outage (Anthropic) | LOW | Graceful degradation (disable AI features) |

---

## Scalability Assessment

### Bottleneck Analysis by User Volume

| Users | Bottleneck | Threshold | Solution | Lead Time |
|---|---|---|---|---|
| 0–50K | None (over-provisioned) | — | Current arch | — |
| 50K–200K | Aurora write IOPS | ~100K TPS | Add read replicas | 1 day |
| 200K–500K | Auth service (JWTs) | ~5K req/s | Horizontal pod scaling + Redis sessions | 1 hour |
| 500K–1M | Ledger write throughput | ~10K ledger/s | Aurora Limitless or vertical scaling | 1 week |
| 1M–5M | Mambu API rate limits | Mambu-specific | Negotiate dedicated infrastructure | 2 months |
| 5M+ | Everything | — | Distributed architecture, LATAM sharding | 6 months |

---

## Due Diligence Findings by Investment Stage

### Seed / Pre-Series A ($2.5M) — INVESTABLE

**Strengths:**
- Architecture is modern and defensible (microservices, event-driven, cloud-native)
- Regulatory strategy is coherent (Fintech license first, banking license later)
- Team composition covers critical functions
- Core technology choices are battle-tested (PostgreSQL, Kafka, Flutter)

**Conditions:**
- Penetration test must be completed before customer go-live
- AML Compliance Officer must be hired within 60 days
- CMF Fintech registration must be submitted within 90 days

### Series A ($8M) — INVESTABLE with milestones

**Requirements (must be met before close):**
- 5,000+ active customers (MAU)
- CMF Fintech license obtained
- PCI-DSS Level 2 SAQ completed
- AML officer + UAF registration complete
- At least 6 months production history, no major incidents

**Key Metrics to Track:**
- Monthly Active Users (MAU): target 10K at close
- Transaction success rate: >99.5%
- NPS: >50
- CAC: <$15
- Monthly churn: <2%

### Series B ($25M) — INVESTABLE with regulatory milestone

**Requirements:**
- 50K+ MAU, positive unit economics trajectory
- SOC 2 Type II report issued
- ISO 27001 certified (or on track)
- Banking license application submitted to CMF
- Loan book: $5M+ deployed with <3% NPL
- LATAM expansion technical design complete

### Banking License Application (CMF) — 18-24 months

**Hard requirements for Ley General de Bancos license:**
- Minimum capital: UF 800,000 (~$35M USD at current UF value)
- Approved board of directors (majority independent)
- Risk management framework (CMF Circular 3.459 compliant)
- IT security audit by CMF-approved auditor
- Business continuity plan tested annually
- Liquidity Coverage Ratio (LCR) framework implemented
- Credit risk models validated by independent party

**Current gaps for banking license:**
1. Capital: insufficient (requires $35M minimum)
2. Board: not constituted
3. Risk framework: draft exists, requires CMF review
4. IT audit: not yet conducted

**Acquisition Readiness:**
- Strategic acquirer (incumbent bank): attractive at $30-50M at 50K users if NIM proven
- PE buyout: needs $10M+ ARR, $5M EBITDA trajectory visible
- LATAM bank acquirer: most likely exit at $100M+ with 200K+ users and LATAM expansion

---

## Remediation Roadmap

### P0 — Before Customer Go-Live (Month 1-3)

- [ ] Hire OFCC (AML Compliance Officer)
- [ ] Submit CMF Fintech license application (Ley 21.521)
- [ ] Complete penetration test (CREST-certified firm)
- [ ] Deploy ComplyAdvantage for sanctions screening
- [ ] Implement data backup and DR test
- [ ] Complete consumer protection procedures (Sernac filing)
- [ ] Privacy policy and terms of service (legal review)

### P1 — First 6 Months Post-Launch

- [ ] PCI-DSS Level 2 SAQ (engage QSA by Month 2)
- [ ] Complete ISO 27001 gap analysis
- [ ] SOC 2 Type II observation period start
- [ ] UAF registration completed
- [ ] FATCA/CRS registration with SII
- [ ] Bug bounty program launch (HackerOne)
- [ ] Conduct first tabletop incident response exercise

### P2 — Month 6-18

- [ ] ISO 27001 certification achieved
- [ ] Second penetration test (semi-annual cadence)
- [ ] SOC 2 Type II report issued
- [ ] Board of directors constituted (for banking license preparation)
- [ ] Risk management framework formal documentation
- [ ] Begin CMF pre-consultation for banking license

### P3 — Month 18-30 (Series B + Banking License)

- [ ] Banking license application submitted to CMF
- [ ] Capital raise for UF 800K requirement
- [ ] First LATAM market (Colombia) technical design
- [ ] FINREP reporting framework implemented
- [ ] LCR monitoring live
- [ ] Independent credit model validation
