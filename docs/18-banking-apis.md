# 18 — Banking APIs

## API Design Principles

- **REST over HTTP/2** for external APIs; gRPC for internal service-to-service calls
- **JSON** for all request/response bodies
- **ISO 8601** for all timestamps (`2026-06-06T14:32:00Z`)
- **Amounts**: integers in minor currency units (centavos for CLP — but CLP has 0 decimal places, so `amount: 1234567` = CLP $1,234,567)
- **Pagination**: cursor-based (not page/offset) for all list endpoints
- **Versioning**: URL path (`/v1/`, `/v2/`) with 12-month deprecation notice
- **Idempotency**: `Idempotency-Key: uuid-v4` header **required** for all POST/PATCH mutations
- **Rate limiting**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers on all responses

---

## Authentication Model

### Customer APIs (OAuth 2.0 + PKCE)

```
POST /auth/v1/token
  grant_type=authorization_code
  code=AUTH_CODE
  code_verifier=PKCE_VERIFIER
  client_id=mawire-mobile-app
  redirect_uri=mawire://oauth/callback

Response:
{
  "access_token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "rt_01HN4X...",
  "scope": "accounts:read transactions:read payments:write"
}
```

JWT Claims structure:
```json
{
  "sub": "cust_01HN4X2Y3Z",
  "iss": "https://auth.mawire.cl",
  "aud": "https://api.mawire.cl",
  "exp": 1749216720,
  "iat": 1749215820,
  "scope": "accounts:read transactions:read payments:write",
  "customer_tier": "premium",
  "kyc_level": "full",
  "mfa_verified": true,
  "device_id": "dev_01HN4X...",
  "jti": "01HN4X2Y3Z4W5V6U"
}
```

Signed with ES256 (ECDSA P-256). Public keys available at `/.well-known/jwks.json`.

### Partner APIs (OAuth 2.0 Client Credentials + MTLS)

```
POST /auth/v1/token
  grant_type=client_credentials
  client_id=partner_001
  client_secret=...
  scope=payments:initiate accounts:read

// Also requires MTLS: client presents certificate registered during partner onboarding
```

### Internal Service-to-Service (mTLS + SPIFFE)

No OAuth — mutual TLS via SPIFFE/SPIRE certificates issued per Kubernetes workload.

---

## API Gateway Configuration (Kong)

```yaml
# Rate limiting tiers
plugins:
  - name: rate-limiting-advanced
    config:
      strategy: redis
      limit:
        - consumer_groups: [anonymous]
          limit: 10
          window_size: 60
        - consumer_groups: [customer]
          limit: 1000
          window_size: 60
        - consumer_groups: [partner]
          limit: 5000
          window_size: 60

  - name: request-id
    config:
      header_name: X-Request-ID
      generator: uuid

  - name: response-transformer
    config:
      add:
        headers:
          - "X-RateLimit-Policy:$(consumer.group)"
          - "Strict-Transport-Security:max-age=31536000; includeSubDomains"
          - "X-Content-Type-Options:nosniff"
          - "X-Frame-Options:DENY"
```

---

## OpenAPI 3.0 Specification (Core Endpoints)

```yaml
openapi: 3.0.3
info:
  title: MaWire Bank Customer API
  version: 1.0.0
  description: |
    Customer-facing banking API. All amounts in CLP (centavos — but CLP has 
    no decimal places, so 1000000 = $1,000,000 CLP).
  contact:
    email: api@mawire.cl
  license:
    name: Proprietary

servers:
  - url: https://api.mawire.cl/v1
    description: Production

security:
  - BearerAuth: []

paths:

  # ─── ACCOUNTS ──────────────────────────────────────────────
  /accounts:
    get:
      operationId: listAccounts
      summary: List customer accounts
      tags: [Accounts]
      parameters:
        - $ref: '#/components/parameters/CursorParam'
        - $ref: '#/components/parameters/LimitParam'
      responses:
        '200':
          description: Paginated list of accounts
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data:
                    type: array
                    items:
                      $ref: '#/components/schemas/Account'
                  meta:
                    $ref: '#/components/schemas/Pagination'
              example:
                data:
                  - id: "acc_01HN4X2Y3Z"
                    account_number_masked: "****4521"
                    account_type: "CHECKING"
                    currency: "CLP"
                    balance:
                      available: 1234567
                      current: 1284567
                      pending: -50000
                      as_of: "2026-06-06T14:32:00Z"
                    status: "ACTIVE"
                    product_name: "Cuenta Vista MaWire"
                    opened_at: "2025-01-15T09:00:00Z"
                meta:
                  cursor: null
                  has_more: false
                  total_count: 2

  /accounts/{accountId}:
    get:
      operationId: getAccount
      summary: Get account details
      tags: [Accounts]
      parameters:
        - $ref: '#/components/parameters/AccountIdParam'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Account'
        '404':
          $ref: '#/components/responses/NotFound'

  /accounts/{accountId}/transactions:
    get:
      operationId: listTransactions
      summary: List account transactions
      tags: [Transactions]
      parameters:
        - $ref: '#/components/parameters/AccountIdParam'
        - name: from_date
          in: query
          schema:
            type: string
            format: date
          example: "2026-01-01"
        - name: to_date
          in: query
          schema:
            type: string
            format: date
          example: "2026-06-06"
        - name: category
          in: query
          schema:
            type: string
          example: "Supermercado"
        - $ref: '#/components/parameters/CursorParam'
        - $ref: '#/components/parameters/LimitParam'
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      $ref: '#/components/schemas/Transaction'
                  meta:
                    $ref: '#/components/schemas/Pagination'

  # ─── PAYMENTS ──────────────────────────────────────────────
  /payments/transfers:
    post:
      operationId: createTransfer
      summary: Create domestic bank transfer (TEF/LBTR)
      tags: [Payments]
      parameters:
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/TransferRequest'
            example:
              source_account_id: "acc_01HN4X2Y3Z"
              amount: 50000
              currency: "CLP"
              concept: "Pago arriendo junio 2026"
              recipient:
                bank_code: "001"
                account_number: "1234567890"
                account_type: "CHECKING"
                rut: "12345678-9"
                name: "María González López"
      responses:
        '201':
          description: Transfer created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Payment'
        '402':
          $ref: '#/components/responses/InsufficientFunds'
        '422':
          $ref: '#/components/responses/ValidationError'

  /payments/transfers/{paymentId}:
    get:
      operationId: getTransfer
      summary: Get transfer status
      tags: [Payments]
      parameters:
        - name: paymentId
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Payment'

  # ─── CARDS ─────────────────────────────────────────────────
  /cards:
    get:
      operationId: listCards
      summary: List customer cards
      tags: [Cards]
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      $ref: '#/components/schemas/Card'

  /cards/{cardId}/freeze:
    post:
      operationId: freezeCard
      summary: Freeze a card
      tags: [Cards]
      parameters:
        - name: cardId
          in: path
          required: true
          schema:
            type: string
        - $ref: '#/components/parameters/IdempotencyKeyHeader'
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                reason:
                  type: string
                  enum: [LOST, STOLEN, PRECAUTION]
      responses:
        '200':
          description: Card frozen

  # ─── LOANS ─────────────────────────────────────────────────
  /loans/applications:
    post:
      operationId: applyForLoan
      summary: Submit loan application
      tags: [Loans]
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/LoanApplicationRequest'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/LoanApplication'

components:

  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

  parameters:
    AccountIdParam:
      name: accountId
      in: path
      required: true
      schema:
        type: string
        pattern: '^acc_[A-Z0-9]{10,26}$'
    
    CursorParam:
      name: cursor
      in: query
      schema:
        type: string
      description: Opaque pagination cursor from previous response meta.cursor
    
    LimitParam:
      name: limit
      in: query
      schema:
        type: integer
        default: 20
        minimum: 1
        maximum: 100
    
    IdempotencyKeyHeader:
      name: Idempotency-Key
      in: header
      required: true
      schema:
        type: string
        format: uuid
      description: UUID v4 to ensure at-most-once execution

  schemas:
    Account:
      type: object
      required: [id, account_type, currency, balance, status]
      properties:
        id:
          type: string
          example: "acc_01HN4X2Y3Z"
        account_number_masked:
          type: string
          example: "****4521"
        account_type:
          type: string
          enum: [CHECKING, SAVINGS, INVESTMENT, LOAN]
        currency:
          type: string
          enum: [CLP, USD, EUR, UF]
        balance:
          type: object
          properties:
            available:
              type: integer
              description: Available balance in CLP (integer, no decimals)
            current:
              type: integer
            pending:
              type: integer
              description: Pending debits (negative) or credits (positive)
            as_of:
              type: string
              format: date-time
        status:
          type: string
          enum: [ACTIVE, FROZEN, CLOSED, PENDING]
        product_name:
          type: string
        opened_at:
          type: string
          format: date-time

    Transaction:
      type: object
      properties:
        id:
          type: string
        amount:
          type: integer
          description: Positive = credit, negative = debit
        currency:
          type: string
        description:
          type: string
          example: "SUPERMERCADO LIDER LAS CONDES"
        category:
          type: string
          example: "Supermercado"
        merchant:
          type: object
          properties:
            name:
              type: string
            mcc:
              type: string
              description: ISO 18245 Merchant Category Code
            city:
              type: string
            country:
              type: string
        type:
          type: string
          enum: [DEBIT, CREDIT, TRANSFER_OUT, TRANSFER_IN, FEE, REFUND, INTEREST]
        status:
          type: string
          enum: [PENDING, COMPLETED, REVERSED, FAILED]
        booking_date:
          type: string
          format: date
        value_date:
          type: string
          format: date
        balance_after:
          type: integer

    TransferRequest:
      type: object
      required: [source_account_id, amount, currency, recipient]
      properties:
        source_account_id:
          type: string
        amount:
          type: integer
          minimum: 1
          description: Amount in CLP (integer)
        currency:
          type: string
          enum: [CLP]
        concept:
          type: string
          maxLength: 140
          description: Transfer description (visible to recipient)
        recipient:
          type: object
          required: [bank_code, account_number, account_type, rut, name]
          properties:
            bank_code:
              type: string
              description: Chilean bank code per ACH Chile registry
              example: "001"
            account_number:
              type: string
            account_type:
              type: string
              enum: [CHECKING, SAVINGS, VISTA]
            rut:
              type: string
              pattern: '^\d{1,8}-[\dkK]$'
              example: "12345678-9"
            name:
              type: string
              maxLength: 200
        scheduled_date:
          type: string
          format: date
          description: If omitted, executes immediately

    Payment:
      type: object
      properties:
        id:
          type: string
        status:
          type: string
          enum: [PENDING, PROCESSING, COMPLETED, FAILED, RETURNED]
        amount:
          type: integer
        currency:
          type: string
        rail:
          type: string
          enum: [TEF, LBTR, SWIFT, VISA_DIRECT]
          description: Payment rail selected by routing engine
        estimated_settlement:
          type: string
          format: date-time
        created_at:
          type: string
          format: date-time
        completed_at:
          type: string
          format: date-time

    Card:
      type: object
      properties:
        id:
          type: string
        pan_masked:
          type: string
          example: "•••• •••• •••• 4521"
        card_type:
          type: string
          enum: [VIRTUAL, PHYSICAL]
        brand:
          type: string
          enum: [VISA, MASTERCARD]
        product:
          type: string
          enum: [DEBIT, CREDIT, PREPAID]
        status:
          type: string
          enum: [ACTIVE, FROZEN, BLOCKED, EXPIRED, CANCELLED]
        expiry_month:
          type: integer
        expiry_year:
          type: integer
        limits:
          type: object
          properties:
            daily_spend:
              type: integer
            daily_atm:
              type: integer
            monthly_spend:
              type: integer
        controls:
          type: object
          properties:
            international_enabled:
              type: boolean
            online_enabled:
              type: boolean
            contactless_enabled:
              type: boolean

    LoanApplicationRequest:
      type: object
      required: [product_type, amount, term_months, purpose]
      properties:
        product_type:
          type: string
          enum: [PERSONAL_LOAN, AUTO_LOAN, CREDIT_LINE]
        amount:
          type: integer
          minimum: 100000
          maximum: 50000000
          description: Requested amount in CLP
        term_months:
          type: integer
          enum: [6, 12, 18, 24, 36, 48, 60, 72]
        purpose:
          type: string
          enum: [EDUCATION, TRAVEL, HOME_IMPROVEMENT, VEHICLE, CONSOLIDATION, OTHER]
        monthly_income:
          type: integer
          description: Self-declared monthly income in CLP

    LoanApplication:
      type: object
      properties:
        id:
          type: string
        status:
          type: string
          enum: [PENDING, APPROVED, CONDITIONALLY_APPROVED, REJECTED, EXPIRED]
        requested_amount:
          type: integer
        approved_amount:
          type: integer
        interest_rate_annual:
          type: number
          description: Annual interest rate (CAE)
        monthly_payment:
          type: integer
        term_months:
          type: integer
        decision_reason:
          type: string
        expires_at:
          type: string
          format: date-time

    Pagination:
      type: object
      properties:
        cursor:
          type: string
          nullable: true
          description: Pass as cursor param in next request. null = no more pages.
        has_more:
          type: boolean
        total_count:
          type: integer

  responses:
    NotFound:
      description: Resource not found
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
    
    InsufficientFunds:
      description: Insufficient funds
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            error:
              code: "INSUFFICIENT_FUNDS"
              message: "Saldo insuficiente para esta transferencia"
              details:
                available_balance: 50000
                requested_amount: 100000
                currency: "CLP"
              request_id: "req_01HN4X..."
    
    ValidationError:
      description: Validation error
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'

    schemas:
      Error:
        type: object
        properties:
          error:
            type: object
            properties:
              code:
                type: string
              message:
                type: string
              details:
                type: object
              request_id:
                type: string
```

---

## Error Codes Reference

| Code | HTTP | Description |
|---|---|---|
| `INSUFFICIENT_FUNDS` | 402 | Account balance insufficient |
| `ACCOUNT_FROZEN` | 403 | Account is frozen by fraud/compliance |
| `TRANSFER_LIMIT_EXCEEDED` | 422 | Amount exceeds daily/monthly limit |
| `RECIPIENT_NOT_FOUND` | 422 | Recipient bank/account not found in ACH directory |
| `INVALID_RUT` | 422 | RUT fails checksum validation |
| `INVALID_ACCOUNT_NUMBER` | 422 | Account number format invalid for specified bank |
| `DUPLICATE_IDEMPOTENCY_KEY` | 409 | Request already processed; returns original response |
| `FRAUD_DETECTED` | 403 | Transaction blocked by fraud engine |
| `KYC_REQUIRED` | 403 | Higher KYC level needed for this operation |
| `COMPLIANCE_HOLD` | 403 | Account under compliance review |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `UNAUTHORIZED` | 401 | Invalid or expired token |
| `FORBIDDEN` | 403 | Valid token but insufficient scope |
| `PAYMENT_RAIL_UNAVAILABLE` | 503 | TEF/LBTR temporarily unavailable |
| `RECIPIENT_BANK_OFFLINE` | 503 | Recipient bank system unresponsive |

---

## Webhooks

### Event Payload Schema

```json
{
  "event_id": "evt_01HN4X2Y3Z",
  "event_type": "transaction.completed",
  "api_version": "2026-06-01",
  "created_at": "2026-06-06T14:32:11.456Z",
  "data": {
    "transaction_id": "txn_01HN4X...",
    "account_id": "acc_01HN4X...",
    "amount": -45000,
    "currency": "CLP",
    "status": "COMPLETED"
  }
}
```

Signature verification:
```
X-MaWire-Signature: t=1749216731,v1=hmac-sha256-hex-of-t.payload
```

Verify: `HMAC-SHA256(webhook_secret, "${timestamp}.${raw_body}")` must match `v1` value.

### All Event Types

```
account.created                   payment.initiated
account.frozen                    payment.settled
account.closed                    payment.failed
account.limit_changed             payment.returned
transaction.completed             card.issued
transaction.failed                card.activated
transaction.reversed              card.frozen
card.authorization.approved       kyc.completed
card.authorization.declined       fraud.alert.raised
loan.approved                     consent.revoked
loan.disbursed                    
```

### Delivery Guarantee

At-least-once delivery. Retry schedule: `1min → 5min → 15min → 1h → 4h → 24h → 72h`. After 72h without acknowledgment: dead letter queue, manual review.

Acknowledge with any 2xx response within 30 seconds. Anything else = retry.
