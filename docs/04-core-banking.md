# MaWire Bank — Core Banking Vendor Evaluation and Integration Architecture

**Classification:** Internal Technical Documentation  
**Audience:** CTO, Engineering Leadership, CFO, CMF Technical Review  
**Version:** 1.0  
**Date:** 2026-06-06

---

## Table of Contents

1. [Vendor Comparison Matrix](#1-vendor-comparison-matrix)
   - 1.1 [Mambu](#11-mambu)
   - 1.2 [Thought Machine Vault](#12-thought-machine-vault)
   - 1.3 [Temenos Transact](#13-temenos-transact)
   - 1.4 [Finastra Fusion](#14-finastra-fusion)
   - 1.5 [Tuum](#15-tuum)
   - 1.6 [Finxact (Fiserv)](#16-finxact-fiserv)
2. [Recommendation: Mambu + Custom Ledger Hybrid](#2-recommendation-mambu--custom-ledger-hybrid)
3. [Integration Architecture](#3-integration-architecture)
4. [Sample Mambu API Calls](#4-sample-mambu-api-calls)

---

## 1. Vendor Comparison Matrix

### Summary Scorecard

| Criterion | Mambu | Thought Machine | Temenos | Finastra | Tuum | Finxact |
|---|---|---|---|---|---|---|
| Cloud-native | ✅ | ✅ | Partial | Partial | ✅ | ✅ |
| API-first | ✅ | ✅ | Partial | ✅ | ✅ | ✅ |
| LATAM/Chile presence | ✅ Strong | Limited | ✅ Present | ✅ Present | Limited | None |
| CMF compliance ready | ✅ | Needs custom work | ✅ (legacy) | ✅ (legacy) | Needs custom work | None |
| Time to production | 6–9 months | 18–24 months | 18–36 months | 18–36 months | 12–18 months | 12–18 months |
| Customization depth | Medium | Very High | High (complex) | High (complex) | Medium | Medium |
| Vendor lock-in risk | Medium | High | High | High | Medium | Medium |
| Total Cost (Year 1, 100K accounts) | $1.2–2.4M | $8–20M | $10–25M | $8–20M | $800K–1.5M | $1.5–3M |

---

### 1.1 Mambu

#### Architecture

Mambu is a cloud-native, API-first core banking platform delivered as a SaaS multi-tenant product. The platform is built on a microservices architecture hosted on AWS, with tenants sharing infrastructure but logically isolated at the database layer. Mambu exposes all functionality via REST APIs (v2, documented as OpenAPI 3.0 specifications) and emits real-time events via a configurable webhook system.

The core data model in Mambu is centered on **Loan Accounts** and **Deposit Accounts**, each configured by a **Product** definition. Products define account behavior: interest calculation method, fee structures, repayment schedules, allowed currencies, and balance limits. Products are configured via the Mambu UI or API without code changes — this is Mambu's primary value proposition.

**Key architectural components:**
- **Mambu Engine:** The core processing engine handles account state machines, interest accrual, fee posting, and balance updates.
- **Mambu APIs:** REST API v2 covers all product configuration, account management, transaction posting, and reporting. The API follows RESTful conventions with JSON payloads and uses API keys or OAuth 2.0 client credentials for authentication.
- **Mambu Webhooks:** Configurable HTTP webhook calls for all key events (account opened, transaction posted, account status changed). Webhooks include retry logic (exponential backoff, up to 5 retries) and a signature header for payload verification.
- **Mambu Data API:** A separate read-optimized API for bulk data extraction, designed for regulatory reporting and data warehouse feeds.

#### Deployment Model

Mambu is fully SaaS — MaWire Bank does not manage any Mambu infrastructure. The multi-tenant deployment runs on AWS `us-east-1` and `eu-west-1`, with data residency election possible. For Chilean CMF compliance and data sovereignty requirements, MaWire Bank must negotiate a **data residency agreement** specifying that customer data and transaction data remain in AWS `us-east-1` (closest available) or, if Mambu enables it, `sa-east-1` (São Paulo). As of 2026, Mambu offers data residency options for LATAM customers; this is a contractual negotiation point and must be confirmed in the MSA before signing.

#### Pricing

Mambu's pricing is subscription-based, not perpetual license:

| Volume Tier | Per Account/Month | Included Transactions | Overage |
|---|---|---|---|
| 0–50,000 accounts | $2.00 | 20/account/month | $0.05/txn |
| 50,001–250,000 | $1.20 | 25/account/month | $0.04/txn |
| 250,001–1,000,000 | $0.75 | 30/account/month | $0.03/txn |
| 1,000,001+ | Negotiated | Negotiated | Negotiated |

**Year 1 cost estimate (MaWire Bank projections):**
- Year 1: 30,000 accounts → ~$720K/year base + platform fee (~$200K) + implementation services (~$400K) = **$1.32M Year 1**
- Year 2: 100,000 accounts → ~$1.44M/year base + implementation amortized = **$1.8M Year 2**
- Year 3: 300,000 accounts → ~$1.08M/year (volume discount) + ongoing support = **$1.4M Year 3**

These figures assume MaWire Bank configures Mambu to handle deposit products (cuentas corrientes, cuentas ahorro) and consumer loan products, which covers 80% of the product catalog.

#### LATAM Presence and Chilean References

Mambu has substantial LATAM presence:
- **Nubank (Brazil):** Nubank was built on Mambu before migrating to a custom core at scale (~70M customers). Nubank's use of Mambu validated its API-first model for digital banks.
- **RappiPay (Colombia/México):** RappiPay's banking license in Colombia uses Mambu for deposit account management.
- **Mercado Pago (Argentina/Mexico):** Uses Mambu for portions of its lending book.
- **Chile references:** As of 2026, at least two Chilean fintech lenders (operating under Ley de Fintechs — Ley 21.521) use Mambu for their loan origination platform. CMF has reviewed Mambu-based systems during those entities' licensing processes, creating regulatory familiarity.

#### CMF Regulatory Compliance

Mambu does not provide CMF-specific regulatory reports out of the box. What it does provide:
- Complete transaction history via the Data API, suitable for feeding MaWire Bank's `reporting-service` for CMF F01/F02/F04 generation
- Configurable interest rate caps (allowing enforcement of TMC — Tasa Máxima Convencional)
- Audit trail of all account and transaction mutations via the Data API
- SOC 2 Type II and ISO 27001 certifications (required by CMF Circular 59 for cloud-hosted systems)

MaWire Bank is responsible for building CMF-specific regulatory report generation on top of the Mambu data. This is handled by the `reporting-service` which reads from Mambu's Data API and the custom `ledgerdb`.

#### Integration Complexity

Mambu's REST API is straightforward to integrate with. The primary integration patterns are:

1. **Synchronous REST calls** for account creation, transaction posting, product queries
2. **Webhooks** for real-time event notification (Mambu → MaWire Bank's `account-service`)
3. **Data API** for bulk extract (nightly batch for reconciliation and regulatory reporting)

The integration surface is clean and well-documented. Mambu Professional Services estimates 6–9 months from contract signing to production readiness for a new digital bank, assuming MaWire Bank provides its own integration engineering team.

#### Pros and Cons

**Pros:**
- Fastest time to production among all evaluated vendors (6–9 months)
- LATAM digital bank reference customers demonstrate proven model
- Modern REST API with good documentation and Postman collections
- No infrastructure management overhead
- Product configuration via UI reduces engineering dependency for product changes
- CMF regulatory familiarity from existing Chilean fintech clients

**Cons:**
- Limited customization: complex product structures (e.g., UF-denominated loans with variable amortization and CMF-mandated specific disclosures) require creative use of Mambu's product configuration or workarounds
- Vendor lock-in: migrating away from Mambu at scale (500K+ accounts) is a multi-year engineering project
- Pricing at scale: at 1M+ accounts, Mambu's per-account fee exceeds the cost of operating a custom core on cloud infrastructure
- Multi-tenant SaaS: shared infrastructure means Mambu's incidents affect all tenants (Mambu has maintained 99.9% uptime historically, but CMF requires MaWire Bank to have business continuity plans for third-party system outages)
- Data residency: requires explicit contractual negotiation and may limit certain deployment options

---

### 1.2 Thought Machine Vault

#### Architecture

Thought Machine Vault is a cloud-native core banking system built on the concept of **Smart Contracts** (called **Contract Language** or CL), which are Python programs that define the complete behavior of a banking product. Unlike traditional core banking systems where product behavior is configured via parameters, Vault's Smart Contracts are code — they define exactly how interest accrues, how fees are calculated, how balances are affected by each transaction type, and what states an account can move through.

**Smart Contract example (simplified Chilean savings account):**

```python
# vault_contract_cl/cuenta_ahorro_cl.py
# Thought Machine Vault Smart Contract — Chilean Savings Account (CL)
# Defines product behavior for a CLP savings account with monthly interest

api = "4.0.0"
version = "1.0.0"
display_name = "Cuenta Ahorro CLP — MaWire Bank"

# Supported denomination
supported_denominations = ["CLP"]

# Parameters defined at product level (configurable per customer)
parameters = [
    Parameter(
        name="interest_rate_annual",
        shape=NumberShape(
            min_value=Decimal("0"),
            max_value=Decimal("0.20"),  # CMF TMC cap
            step=Decimal("0.0001"),
        ),
        level=Level.TEMPLATE,
        description="Annual nominal interest rate",
        default_value=Decimal("0.03"),  # 3.0% p.a.
    ),
    Parameter(
        name="monthly_withdrawal_limit",
        shape=NumberShape(min_value=Decimal("1"), max_value=Decimal("10"), step=Decimal("1")),
        level=Level.TEMPLATE,
        description="CMF-mandated monthly free withdrawal limit (Cuenta Ahorro)",
        default_value=Decimal("3"),
    ),
]

# Interest accrual hook — called daily by Vault scheduler
@requires(parameters=True, balances="latest")
def scheduled_code(event_type: str, effective_date: datetime, vault: Any) -> None:
    if event_type == "ACCRUE_INTEREST":
        annual_rate = vault.get_parameter_timeseries(name="interest_rate_annual").latest()
        daily_rate = annual_rate / Decimal("365")
        balance = vault.get_balance_timeseries().latest()[
            BalanceCoordinate(
                account_address="DEFAULT",
                asset="COMMERCIAL_BANK_MONEY",
                denomination="CLP",
                phase=Phase.COMMITTED,
            )
        ].net

        if balance > Decimal("0"):
            accrual_amount = (balance * daily_rate).quantize(Decimal("1"))  # CLP has no decimal
            vault.make_internal_transfer_instructions(
                amount=accrual_amount,
                denomination="CLP",
                from_account_id=vault.account_id,
                from_account_address="INTERNAL_CONTRA",
                to_account_id=vault.account_id,
                to_account_address="ACCRUED_INTEREST",
                instruction_details={"event_type": "DAILY_INTEREST_ACCRUAL"},
            )
```

This level of programmability is Vault's key differentiator. Any product behavior is expressible in Python. The tradeoff is development complexity — building and testing Smart Contracts requires specialized expertise, and Thought Machine provides training and certification for "Smart Contract Engineers."

#### Pricing

Thought Machine Vault is licensed under a combination of:
- **Initial implementation fee:** $5–15M depending on scope, negotiated per client. This covers Vault infrastructure setup, Smart Contract development services, and integration engineering support.
- **Per-account monthly fee:** $0.15–0.50/account/month for hosted deployment on GCP or AWS.
- **Annual platform fee:** $500K–2M/year for enterprise support, Smart Contract review, and platform updates.

**Total Year 1 cost estimate for MaWire Bank (30,000 accounts):** $6–16M (implementation-heavy), with subsequent years dropping to $800K–2M/year.

#### Deployment

Vault can be deployed on GCP (preferred by Thought Machine, using GKE) or on-premises in a customer-managed Kubernetes cluster. AWS deployment is possible but less well-supported. For MaWire Bank operating in Chile, GCP `southamerica-east1` (São Paulo) would be the nearest region, adding some latency for Chilean users (~85ms São Paulo ↔ Santiago).

#### Pros and Cons

**Pros:**
- Maximum product flexibility: any banking product behavior expressible in Python Smart Contracts
- True cloud-native architecture with event-driven design from the ground up
- Strong security model with full audit trail built into the platform
- Increasingly adopted by Tier 1 banks (JPMorgan Chase, Lloyds Banking Group) — growing ecosystem and credibility

**Cons:**
- Very high upfront cost ($5–15M implementation) is prohibitive for a de-novo bank pre-revenue
- Smart Contract development requires specialized training; finding Thought Machine-certified engineers in Chile or LATAM is currently difficult
- No Chilean or LATAM production references as of 2026
- CMF regulatory familiarity is zero — MaWire Bank would be the first CMF-regulated entity on Vault, requiring CMF to review and approve a novel system architecture (estimated 6–12 additional months in licensing timeline)
- Smaller partner/integrations ecosystem vs Temenos or Mambu

---

### 1.3 Temenos Transact

#### Architecture

Temenos Transact (formerly T24) is the flagship product of Temenos AG, a Geneva-based banking software company. It has been deployed at over 3,000 banks in 150+ countries and is the world's most widely deployed core banking system by number of installations. Transact runs on a JBASE database (a MultiValue database with a proprietary BASIC dialect for business logic — jBC), with more recent versions supporting deployment on top of relational databases (Oracle, Microsoft SQL Server) via an abstraction layer.

The architecture is fundamentally **not cloud-native** at its core. Temenos has built a "cloud edition" (Temenos Infinity for the digital banking layer, Temenos Transact as the core) that packages the traditional system in Docker containers and adds REST APIs via an API gateway wrapper. However, the underlying JBASE processing engine retains its batch-oriented, single-node-primary design. Horizontal scaling is achieved through functional decomposition (separate JBASE nodes for different modules) rather than stateless microservices.

**JBASE dependency:** The primary concern for MaWire Bank is the JBASE database dependency. JBASE is a proprietary MultiValue database — there is no open-source alternative, no cloud-managed service, and DBA expertise is scarce (and expensive). Any customization requires jBC programming expertise. The Chilean market has minimal JBASE/Temenos developer talent.

#### Pricing

Temenos operates on a traditional enterprise software licensing model:
- **Perpetual license:** $4–12M initial license fee
- **Annual maintenance:** 18–22% of license value ($720K–$2.64M/year)
- **Implementation services:** $6–15M (typically 2–3x license value for a full greenfield implementation)
- **Cloud edition subscription:** $2–5M/year for managed hosting

**Total cost for MaWire Bank (greenfield, 3-year TCO):** $18–45M. This is not appropriate for a de-novo digital bank.

#### LATAM Presence

Temenos has substantial LATAM presence: Banco de Chile, BancoEstado (partially), and numerous regional banks in Peru, Colombia, and Mexico use Temenos Transact or its predecessor T24. The CMF is familiar with Temenos-based implementations, which is a regulatory advantage. However, all Chilean Temenos installations are at established banks with existing Temenos teams; MaWire Bank starting a greenfield Temenos implementation would face a 3–5 year runway to production.

#### Pros and Cons

**Pros:**
- Proven at massive scale (Tier 1 banks with 10M+ accounts)
- Comprehensive feature set covering every banking product type
- CMF regulatory familiarity and existing Chilean references
- Massive ecosystem: thousands of pre-built integrations, extensive partner network

**Cons:**
- Not truly cloud-native; JBASE architecture limits scalability patterns
- Highest TCO of all evaluated options for MaWire Bank's scale
- JBASE/jBC expertise is extremely scarce in Chile
- 18–36 month implementation timeline is incompatible with MaWire Bank's go-to-market timeline
- Legacy architecture with modern API wrapper creates impedance mismatch with MaWire Bank's microservices design

---

### 1.4 Finastra Fusion

#### Architecture

Finastra (formed by the merger of Misys and D+H in 2017, now a Fiserv subsidiary) offers **Fusion Essence** (cloud-native, for digital banks) and **Fusion Tempos** / **Fusion Equation** (traditional cores for community and retail banks). Fusion Essence is the relevant product for MaWire Bank.

**Open Banking via OpenBankingAPI.net:** Finastra operates OpenBankingAPI.net, a marketplace of API-based banking services. This is genuinely valuable for MaWire Bank's Open Banking strategy under Chile's Ley de Fintechs — Finastra's marketplace includes pre-built connectors for payment rails, KYC vendors, and AML platforms.

**Architecture:** Fusion Essence uses a microservices architecture with REST APIs, event streaming (Kafka), and cloud-native deployment (AWS or Azure). It is more genuinely cloud-native than Temenos Transact.

#### Pricing

- **Fusion Essence SaaS:** $1.5–4M/year for 100,000 accounts, depending on product modules licensed
- **Implementation services:** $3–8M for greenfield deployment
- **OpenBankingAPI.net marketplace:** transaction-based pricing for marketplace APIs

#### Pros and Cons

**Pros:**
- More modern architecture than Temenos; genuinely microservices-based
- OpenBankingAPI.net marketplace accelerates third-party integrations
- Enterprise-grade compliance and audit capabilities
- Growing LATAM presence (primarily Brazil and Mexico as of 2026)

**Cons:**
- Limited Chile/CMF-specific regulatory coverage
- Implementation timeline (18–30 months for full deployment) is too long for MaWire Bank
- Higher cost than Mambu for the same account volume
- Smaller product team focus on LATAM vs US/Europe market

---

### 1.5 Tuum

#### Architecture

Tuum (formerly Modularbank) is an Estonian-founded, European-market-focused cloud-native core banking system. It follows a microservices architecture with a module-based product catalog: banks license only the modules they need (accounts, payments, lending, cards). The API surface is REST-first with OpenAPI 3.0 documentation.

Tuum's architecture is genuinely modern: stateless microservices, event-driven with Kafka, PostgreSQL as the primary datastore, and Kubernetes-native deployment. From a technical architecture standpoint, Tuum is the closest to MaWire Bank's own design principles.

**LATAM expansion:** Tuum began LATAM expansion in 2024, with a São Paulo presence and initial clients in Brazil and Colombia. As of 2026, there are no Chilean CMF-regulated clients on Tuum. The platform has not been reviewed by CMF.

#### Pricing

- **Per account/month:** $0.40–1.20 (similar to Mambu but with lower base platform fee)
- **Implementation services:** $500K–1.5M (lighter implementation due to modern APIs)
- **Annual Year 1 estimate (30,000 accounts):** ~$700K–1M all-in

#### Pros and Cons

**Pros:**
- Lowest TCO at MaWire Bank's initial scale
- Modern microservices architecture aligns with MaWire Bank's design
- Competitive pricing with Mambu
- Module-based licensing — pay only for what's used

**Cons:**
- No Chilean production reference or CMF regulatory precedent
- Smaller company (200–300 employees) — counterparty risk if Tuum faces financial difficulties
- LATAM support and professional services are nascent
- English-only support documentation (Spanish localization limited)
- Lower brand recognition may complicate CMF licensing discussions (regulators prefer known systems with audit history)

---

### 1.6 Finxact (Fiserv)

#### Architecture

Finxact was founded as a cloud-native, event-driven core banking system and acquired by Fiserv in 2022. The core is built on a modern microservices architecture with a NoSQL document store (Couchbase) as the primary database, event streaming via Kafka, and REST/GraphQL APIs.

The Finxact data model is interesting: account state is stored as JSON documents, allowing extremely flexible product definitions without schema migration. However, this flexibility comes at the cost of relational consistency guarantees — financial calculations that span multiple documents require application-level distributed transaction management.

**US market focus:** Finxact's client base is almost entirely US-based community banks and credit unions. Fiserv acquired Finxact to modernize its US-focused core banking portfolio. LATAM market investment is minimal.

#### Pricing

- **SaaS subscription:** $1–3M/year for 100,000 accounts (US market pricing; LATAM discount may apply)
- **Implementation:** $2–5M
- **Note:** Fiserv's post-acquisition pricing and strategy for Finxact is in flux as of 2026

#### Pros and Cons

**Pros:**
- True cloud-native architecture with modern technology stack
- Event-driven design aligns with MaWire Bank's architecture
- Backed by Fiserv's resources and stability

**Cons:**
- No LATAM presence; no CMF regulatory experience
- Couchbase NoSQL primary store creates consistency concerns for financial ledger data
- Fiserv acquisition has slowed Finxact's product roadmap (internal prioritization conflicts)
- Would require MaWire Bank to be a pioneer in CMF regulation for Finxact — high regulatory risk

---

## 2. Recommendation: Mambu + Custom Ledger Hybrid

### Decision

**MaWire Bank will adopt a hybrid architecture: Mambu as the product configuration and account management layer, plus a custom double-entry ledger service (`ledger-service`) as the authoritative accounting record, plus custom payment orchestration via `payment-service`.**

This is not a default "buy everything from one vendor" decision or a "build everything custom" decision. It is a deliberate architectural choice based on the specific constraints and requirements of launching a regulated Chilean digital bank in 2026.

### Justification

#### Why Mambu (and not Thought Machine, Temenos, Finastra, Tuum, or Finxact)

**Time to market:** MaWire Bank's CMF banking license application requires demonstrating a functional core banking system to the CMF within 12 months of application approval. Mambu's 6–9 month production timeline is the only option that fits this window without extraordinary risk. Thought Machine (18–24 months), Temenos (18–36 months), and Finastra (18–30 months) all miss this window.

**CMF regulatory precedent:** Mambu has been reviewed by CMF in the context of fintech lenders operating under Ley 21.521. There is documented regulatory familiarity. Tuum and Finxact have none. This matters: CMF's technology review team needs to understand the architecture of the core banking system, and a Mambu review is a known quantity vs. an entirely novel review that could add 6–12 months to the licensing timeline.

**Cost-appropriate for scale:** MaWire Bank's Year 1 projected account count (30,000 accounts) and Year 3 projection (300,000 accounts) fit comfortably in Mambu's pricing curve at a cost that a de-novo digital bank can sustain pre-profitability. Thought Machine's $5–15M implementation fee would consume MaWire Bank's entire Series A capital.

**API-first integration model:** Mambu's REST API integrates cleanly with MaWire Bank's Go-based microservices. There is no JBASE complexity, no proprietary database, and no specialized talent requirement beyond standard REST API integration.

#### Why the Custom Ledger (and not relying on Mambu's ledger)

Mambu's internal ledger is adequate for Mambu's own accounting purposes but has specific limitations for a CMF-regulated bank:

1. **Regulatory reporting precision:** CMF F01/F02 reports require a trial balance computed from a double-entry ledger where every CLP is traceable to a specific journal entry. Mambu's internal transaction records are structured for product management, not regulatory accounting. Extracting a CMF-compliant trial balance from Mambu's data model requires significant transformation work that is more reliably done from a purpose-built double-entry ledger.

2. **Immutability and hash chaining:** CMF and the SBIF audit requirements mandate tamper-evident financial records. MaWire Bank's custom `ledger-service` implements SHA-256 hash chaining at the journal entry level. Mambu's SaaS platform provides SOC 2 controls but does not expose the underlying tamper evidence mechanism to MaWire Bank.

3. **Multi-currency precision:** CLP amounts require integer arithmetic (no decimal places). UF-denominated loan balances require 6-decimal precision. Mambu handles this adequately, but the mapping between Mambu's internal precision and the CMF reporting format requires a controlled transformation layer. Owning the ledger makes this transformation explicit and auditable.

4. **FX conversion recording:** Multi-currency transactions (e.g., CLP ↔ USD) require recording the conversion rate, both leg amounts, and the contra entry in the ledger at the moment of conversion. Mambu's FX handling is product-configuration-driven and less flexible for recording complex multi-leg FX journal entries that satisfy CMF reporting requirements.

5. **Audit independence:** Having an independent ledger that reconciles against Mambu's records provides a control layer. If Mambu has a data corruption incident, MaWire Bank's own ledger is the authoritative record. This independence is also a strong argument to CMF that MaWire Bank has not outsourced its core financial record-keeping entirely to a third party.

#### Why Custom Payment Orchestration

Mambu's payment integration model (TEF, LBTR) would require routing all Chilean payment rail traffic through Mambu's API, which introduces Mambu's SLA into every customer payment. MaWire Bank's custom `payment-service` connects directly to COMBANC's TEF system and the Banco Central's LBTR API, with Mambu being notified of the payment outcome for account balance updating. This gives MaWire Bank direct control over payment processing latency and reliability.

#### Why This Beats Pure-Play Alternatives

| Approach | Pros | Cons |
|---|---|---|
| **100% Mambu** | Simplest initial setup | Regulatory reporting limitations, no tamper-evident ledger, Mambu payment routing |
| **100% Custom Build** | Maximum control, optimal regulatory fit | 3–4 year build timeline, $10M+ engineering cost, misses CMF licensing window |
| **Thought Machine Vault** | Maximum flexibility | $6–16M Year 1 cost, no LATAM references, 18–24 month timeline |
| **Mambu + Custom Ledger (recommended)** | Fast launch, regulatory-grade accounting, cost-appropriate | Medium complexity, two systems to reconcile daily |

The hybrid approach delivers: production in 9 months (Mambu's timeline), regulatory-grade double-entry accounting (custom ledger), direct payment rail control (custom payment service), and a migration path away from Mambu if unit economics at 1M+ accounts warrant building a custom core.

---

## 3. Integration Architecture

### 3.1 Authentication with Mambu

MaWire Bank's microservices authenticate to Mambu using OAuth 2.0 Client Credentials flow. Each service that calls Mambu (primarily `account-service` and `loan-service`) has its own OAuth client ID and secret, stored in AWS Secrets Manager. Tokens are cached in memory with a 5-minute buffer before expiry.

```go
// mambu/auth/client.go
package mambuauth

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "net/url"
    "strings"
    "sync"
    "time"
)

type TokenResponse struct {
    AccessToken string `json:"access_token"`
    ExpiresIn   int    `json:"expires_in"`
    TokenType   string `json:"token_type"`
}

type MambuTokenManager struct {
    mu           sync.RWMutex
    token        string
    expiresAt    time.Time
    tokenURL     string
    clientID     string
    clientSecret string
    httpClient   *http.Client
}

func (m *MambuTokenManager) GetToken(ctx context.Context) (string, error) {
    m.mu.RLock()
    if time.Now().Add(5 * time.Minute).Before(m.expiresAt) {
        token := m.token
        m.mu.RUnlock()
        return token, nil
    }
    m.mu.RUnlock()

    m.mu.Lock()
    defer m.mu.Unlock()

    // Double-check after acquiring write lock
    if time.Now().Add(5 * time.Minute).Before(m.expiresAt) {
        return m.token, nil
    }

    data := url.Values{
        "grant_type":    {"client_credentials"},
        "client_id":     {m.clientID},
        "client_secret": {m.clientSecret},
        "scope":         {"mambu:api:read mambu:api:write"},
    }

    req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.tokenURL,
        strings.NewReader(data.Encode()))
    if err != nil {
        return "", fmt.Errorf("creating token request: %w", err)
    }
    req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

    resp, err := m.httpClient.Do(req)
    if err != nil {
        return "", fmt.Errorf("fetching mambu token: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return "", fmt.Errorf("mambu token endpoint returned %d", resp.StatusCode)
    }

    var tokenResp TokenResponse
    if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
        return "", fmt.Errorf("decoding token response: %w", err)
    }

    m.token = tokenResp.AccessToken
    m.expiresAt = time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
    return m.token, nil
}
```

### 3.2 Webhook Configuration

MaWire Bank registers webhooks with Mambu for all account and transaction events. Mambu's webhook delivery includes a `X-Mambu-Signature` header — an HMAC-SHA256 signature of the payload using a shared secret, allowing the receiving service to verify authenticity.

**Registered webhook endpoints:**

| Mambu Event | MaWire Bank Endpoint | Handler Service |
|---|---|---|
| `DEPOSIT_ACCOUNT_CREATED` | `https://webhooks.mawire.cl/mambu/accounts/created` | `account-service` |
| `DEPOSIT_ACCOUNT_STATE_CHANGED` | `https://webhooks.mawire.cl/mambu/accounts/state` | `account-service` |
| `DEPOSIT_TRANSACTION_CREATED` | `https://webhooks.mawire.cl/mambu/transactions/created` | `ledger-service` |
| `LOAN_ACCOUNT_CREATED` | `https://webhooks.mawire.cl/mambu/loans/created` | `loan-service` |
| `LOAN_REPAYMENT_MADE` | `https://webhooks.mawire.cl/mambu/loans/repayment` | `loan-service` |
| `LOAN_INSTALLMENT_DUE` | `https://webhooks.mawire.cl/mambu/loans/installment-due` | `loan-service` |

**Webhook signature verification (Go):**

```go
// mambu/webhooks/verifier.go
package mambuwebhooks

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "net/http"
)

// VerifySignature validates the Mambu HMAC-SHA256 webhook signature.
// Mambu computes: HMAC-SHA256(secret, payload_body)
func VerifySignature(r *http.Request, secret []byte) ([]byte, error) {
    body, err := io.ReadAll(io.LimitReader(r.Body, 5*1024*1024)) // 5MB limit
    if err != nil {
        return nil, fmt.Errorf("reading request body: %w", err)
    }

    sig := r.Header.Get("X-Mambu-Signature")
    if sig == "" {
        return nil, fmt.Errorf("missing X-Mambu-Signature header")
    }

    mac := hmac.New(sha256.New, secret)
    mac.Write(body)
    expected := hex.EncodeToString(mac.Sum(nil))

    if !hmac.Equal([]byte(sig), []byte(expected)) {
        return nil, fmt.Errorf("signature mismatch: webhook may be tampered")
    }

    return body, nil
}
```

### 3.3 Data Synchronization Strategy

The synchronization between Mambu and MaWire Bank's internal systems follows a **webhook-primary, batch-reconciliation-secondary** pattern:

**Real-time path (webhooks):**
1. Customer opens account → Mambu sends `DEPOSIT_ACCOUNT_CREATED` webhook → `account-service` creates local account record → publishes `account.opened` Kafka event
2. Transaction posted in Mambu → `DEPOSIT_TRANSACTION_CREATED` webhook → `ledger-service` creates corresponding journal entry

**Reconciliation path (nightly batch):**
Every night at 02:00 CLT, the `reporting-service` calls Mambu's Data API to extract all transactions for the day (paginated, up to 10,000 records per page). This is compared against the custom `ledgerdb` journal entries. Any discrepancy (transaction in Mambu with no corresponding journal entry, or vice versa) triggers a `reconciliation.discrepancy` alert for the Operations team.

```python
# reporting/reconciliation/mambu_reconciler.py
import asyncio
import httpx
from datetime import date, datetime
from decimal import Decimal
from dataclasses import dataclass
from typing import AsyncIterator

@dataclass
class ReconciliationResult:
    run_date: date
    mambu_transaction_count: int
    ledger_transaction_count: int
    matched_count: int
    mambu_only: list[str]   # transaction IDs in Mambu but not ledger
    ledger_only: list[str]   # journal entry IDs in ledger but not Mambu
    amount_discrepancy_clp: Decimal

class MambuReconciler:
    def __init__(self, mambu_client: 'MambuDataAPIClient', ledger_db_pool):
        self._mambu = mambu_client
        self._db = ledger_db_pool

    async def reconcile_day(self, target_date: date) -> ReconciliationResult:
        # Fetch all Mambu transactions for the day (paginated)
        mambu_txns = {
            txn["encodedKey"]: Decimal(str(txn["amount"]))
            async for txn in self._mambu.get_transactions_for_date(target_date)
        }

        # Fetch all ledger journal entries for the day
        async with self._db.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT reference_id, SUM(amount) as total_amount
                FROM journal_entry_lines
                JOIN journal_entries je ON journal_entry_lines.journal_entry_id = je.id
                WHERE je.value_date = $1
                  AND journal_entry_lines.debit_credit = 'D'
                  AND je.source_system = 'MAMBU'
                GROUP BY reference_id
                """,
                target_date,
            )
        ledger_txns = {row["reference_id"]: row["total_amount"] for row in rows}

        mambu_keys = set(mambu_txns.keys())
        ledger_keys = set(ledger_txns.keys())

        matched = mambu_keys & ledger_keys
        mambu_only = list(mambu_keys - ledger_keys)
        ledger_only = list(ledger_keys - mambu_keys)

        # Compute amount discrepancy for matched transactions
        amount_discrepancy = sum(
            abs(mambu_txns[k] - ledger_txns[k]) for k in matched
        )

        return ReconciliationResult(
            run_date=target_date,
            mambu_transaction_count=len(mambu_txns),
            ledger_transaction_count=len(ledger_txns),
            matched_count=len(matched),
            mambu_only=mambu_only,
            ledger_only=ledger_only,
            amount_discrepancy_clp=amount_discrepancy,
        )
```

### 3.4 Rollback Handling

When a MaWire Bank transaction fails after Mambu has already recorded a debit or credit, a compensating transaction (reversal) must be posted to Mambu via the Mambu API before the overall transaction is marked as failed. This is handled by the `transaction-service` saga orchestrator.

**Saga compensating actions:**

| Step | Forward Action | Compensating Action |
|---|---|---|
| 1. Ledger debit | POST journal entry (debit source) | POST reversal journal entry |
| 2. Mambu account debit | POST Mambu withdrawal transaction | POST Mambu deposit transaction (reversal) |
| 3. Payment submission | Submit to COMBANC TEF | Call COMBANC recall API (if within recall window) |

The reversal to Mambu uses the `CORRECTION` transaction type to ensure proper accounting treatment and CMF audit trail integrity. The original transaction ID is recorded in the reversal's `notes` field.

---

## 4. Sample Mambu API Calls

### 4.1 Account Creation (Cuenta Corriente)

**Request:**

```http
POST https://mawirebank.mambu.com/api/deposits
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json
Idempotency-Key: cust_01926b3f_account_001
Accept: application/vnd.mambu.v2+json

{
  "accountHolderKey": "8a818c2c7f3e4b5d017f3e5a0c3d001a",
  "accountHolderType": "CLIENT",
  "name": "Cuenta Corriente — Juan Pérez",
  "accountType": "CURRENT_ACCOUNT",
  "productTypeKey": "8a818c2c7f3e4b5d017f3e5a0c3d002b",
  "currencyCode": "CLP",
  "internalControls": {
    "maxWithdrawalAmount": 5000000,
    "recommendedDepositAmount": 0
  },
  "interestSettings": {
    "interestRateSettings": {
      "encodedKey": null,
      "interestRate": 0.0,
      "interestRateSource": "FIXED_INTEREST_RATE",
      "interestRateTerms": "FIXED",
      "interestRateReviewCount": 1,
      "interestRateReviewUnit": "MONTHS"
    }
  },
  "overdraftSettings": {
    "allowOverdraft": false
  },
  "customInformation": [
    {
      "customFieldKey": "rut_cliente",
      "value": "12345678-9"
    },
    {
      "customFieldKey": "sucursal_apertura",
      "value": "DIGITAL"
    },
    {
      "customFieldKey": "mawire_customer_id",
      "value": "01926b3f-7c2a-7000-b4e3-d3f9c8a2e1f0"
    }
  ]
}
```

**Response (HTTP 201 Created):**

```json
{
  "encodedKey": "8a818c2c7f3e4b5d017f3e5b1c4e003c",
  "id": "ACCT-000123456",
  "name": "Cuenta Corriente — Juan Pérez",
  "accountState": "PENDING_APPROVAL",
  "accountSubState": "NONE",
  "accountType": "CURRENT_ACCOUNT",
  "productTypeKey": "8a818c2c7f3e4b5d017f3e5a0c3d002b",
  "productName": "Cuenta Corriente MaWire",
  "currencyCode": "CLP",
  "accountHolderKey": "8a818c2c7f3e4b5d017f3e5a0c3d001a",
  "accountHolderType": "CLIENT",
  "creationDate": "2026-06-06T14:23:45+00:00",
  "approvedDate": null,
  "activationDate": null,
  "lastModifiedDate": "2026-06-06T14:23:45+00:00",
  "balances": {
    "totalBalance": 0,
    "lockedBalance": 0,
    "reservedAmount": 0,
    "technicalOverdraftAmount": 0,
    "overdraftAmount": 0,
    "overdraftInterestDue": 0,
    "feesDue": 0,
    "holdBalance": 0,
    "availableBalance": 0
  },
  "internalControls": {
    "maxWithdrawalAmount": 5000000,
    "recommendedDepositAmount": 0
  },
  "overdraftSettings": {
    "allowOverdraft": false,
    "overdraftLimit": 0
  },
  "customInformation": [
    {
      "customFieldKey": "rut_cliente",
      "customField": { "id": "rut_cliente", "name": "RUT Cliente" },
      "value": "12345678-9"
    },
    {
      "customFieldKey": "mawire_customer_id",
      "customField": { "id": "mawire_customer_id", "name": "MaWire Customer ID" },
      "value": "01926b3f-7c2a-7000-b4e3-d3f9c8a2e1f0"
    }
  ],
  "_links": [
    {
      "rel": "self",
      "href": "https://mawirebank.mambu.com/api/deposits/ACCT-000123456"
    }
  ]
}
```

### 4.2 Account Activation

After Mambu account creation (status `PENDING_APPROVAL`), MaWire Bank's `account-service` approves and activates the account once KYC is confirmed:

```http
POST https://mawirebank.mambu.com/api/deposits/ACCT-000123456:changeState
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json
Accept: application/vnd.mambu.v2+json

{
  "action": "APPROVE",
  "notes": "KYC verified — Truora session ID: TRU-20260606-001234. Approved by: kyc-service automated review."
}
```

Then activate:

```http
POST https://mawirebank.mambu.com/api/deposits/ACCT-000123456:changeState
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "action": "OPEN",
  "notes": "Account opened — initial deposit not required for Cuenta Corriente."
}
```

### 4.3 Posting a Transaction (Withdrawal)

```http
POST https://mawirebank.mambu.com/api/deposits/ACCT-000123456/withdrawal-transactions
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json
Idempotency-Key: txn_01926b3f_20260606_001
Accept: application/vnd.mambu.v2+json

{
  "amount": 150000,
  "valueDate": "2026-06-06T14:23:44Z",
  "notes": "TEF transfer to 76543210-K. MaWire TxnID: 01926b3f-7c2a-7000-b4e3-d3f9c8a2e1f0",
  "paymentOrderId": "01926b3f-7c2a-7000-b4e3-d3f9c8a2e1f0",
  "externalId": "TEF-COMBANC-20260606-00123456",
  "transactionDetails": {
    "transactionChannelId": "TEF",
    "transactionChannelKey": "8a818c2c7f3e4b5d017f3e5a0c3d003d"
  }
}
```

**Response (HTTP 201 Created):**

```json
{
  "encodedKey": "8a818c2c7f3e4b5d017f3e5c2d5f004e",
  "id": "TXNID-000987654",
  "externalId": "TEF-COMBANC-20260606-00123456",
  "paymentOrderId": "01926b3f-7c2a-7000-b4e3-d3f9c8a2e1f0",
  "type": "WITHDRAWAL",
  "amount": 150000,
  "currencyCode": "CLP",
  "accountBalances": {
    "totalBalance": 850000
  },
  "valueDate": "2026-06-06T14:23:44+00:00",
  "bookingDate": "2026-06-06T14:23:45+00:00",
  "creationDate": "2026-06-06T14:23:45.123+00:00",
  "parentAccountKey": "8a818c2c7f3e4b5d017f3e5b1c4e003c",
  "notes": "TEF transfer to 76543210-K. MaWire TxnID: 01926b3f-7c2a-7000-b4e3-d3f9c8a2e1f0"
}
```

---

## Integration Architecture Diagram

```mermaid
graph TB
    subgraph "MaWire Bank Internal Systems"
        AccSvc[account-service<br/>Go]
        LoanSvc[loan-service<br/>Go]
        LedgerSvc[ledger-service<br/>Go]
        TxnSvc[transaction-service<br/>Go]
        PaySvc[payment-service<br/>Go]
        RptSvc[reporting-service<br/>Python]
        WebhookGW[Webhook Gateway<br/>Kong / nginx]
        Kafka[Apache Kafka — MSK]
        AccDB[(accountdb<br/>PostgreSQL)]
        LedgerDB[(ledgerdb<br/>PostgreSQL)]
    end

    subgraph "Mambu Cloud Platform"
        MambuAPI[Mambu REST API v2<br/>deposits / loans / clients]
        MambuData[Mambu Data API<br/>bulk extract]
        MambuWebhooks[Mambu Webhook Engine]
        MambuOAuth[Mambu OAuth 2.0<br/>Token Endpoint]
    end

    subgraph "AWS Services"
        SecretsManager[AWS Secrets Manager<br/>Client ID / Secret]
        S3Reports[S3 — mawire-regulatory-reports]
    end

    subgraph "External Payment Rails"
        COMBANC[COMBANC TEF]
        BCL[Banco Central LBTR]
    end

    AccSvc -->|POST /api/deposits — create account| MambuAPI
    AccSvc -->|POST :changeState — approve/activate| MambuAPI
    LoanSvc -->|POST /api/loans — create loan| MambuAPI
    LoanSvc -->|POST repayment-transactions| MambuAPI
    TxnSvc -->|POST withdrawal-transactions| MambuAPI

    AccSvc -->|fetch client credentials| SecretsManager
    LoanSvc -->|fetch client credentials| SecretsManager

    AccSvc -->|OAuth 2.0 client_credentials| MambuOAuth
    LoanSvc -->|OAuth 2.0 client_credentials| MambuOAuth

    MambuWebhooks -->|HTTPS POST + HMAC-SHA256 sig| WebhookGW
    WebhookGW -->|DEPOSIT_ACCOUNT_CREATED| AccSvc
    WebhookGW -->|DEPOSIT_TRANSACTION_CREATED| LedgerSvc
    WebhookGW -->|LOAN_REPAYMENT_MADE| LoanSvc

    AccSvc -->|account.opened event| Kafka
    LedgerSvc -->|journal entry created| LedgerDB
    LedgerSvc -->|ledger.journal_entry.created| Kafka

    RptSvc -->|nightly batch: paginated pull| MambuData
    RptSvc -->|reconcile vs| LedgerDB
    RptSvc -->|store regulatory reports| S3Reports

    TxnSvc -->|orchestrate payment| PaySvc
    PaySvc -->|TEF| COMBANC
    PaySvc -->|LBTR| BCL

    COMBANC -->|settlement confirmation| PaySvc
    PaySvc -->|notify settlement| TxnSvc
    TxnSvc -->|post withdrawal to Mambu| MambuAPI

    style MambuAPI fill:#4A90D9,color:#fff
    style MambuData fill:#4A90D9,color:#fff
    style MambuWebhooks fill:#4A90D9,color:#fff
    style MambuOAuth fill:#4A90D9,color:#fff
```

---

*Document version 1.0 — MaWire Bank Engineering — Classification: Internal*
