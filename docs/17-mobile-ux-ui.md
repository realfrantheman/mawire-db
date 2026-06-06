# Mobile UX/UI Design System — MaWire Bank

## Design Principles

1. **Trust First**: security visible but not intrusive (biometric, shield icons, subtle lock indicators)
2. **Speed**: transactions complete in fewer than 3 taps; common flows optimized to <8 seconds
3. **Clarity**: financial data always unambiguous — amounts, dates, and status are never hidden behind jargon
4. **Accessibility**: WCAG 2.1 AA minimum, large text support, VoiceOver (iOS) and TalkBack (Android)
5. **Chilean Context**: CLP formatting ($ 1.234.567), RUT input auto-formatting (12.345.678-9), UF display (UF 456.7800)

---

## Design System Foundation

### Color Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `color.brand.navy` | `#0A1628` | Primary brand, navigation background, primary text on light |
| `color.brand.blue` | `#1B6EF3` | Primary interactive elements, links, CTAs |
| `color.brand.blue.light` | `#4F94F8` | Hover/pressed states, secondary highlights |
| `color.semantic.success` | `#00C896` | Positive balances, successful transactions, trust signals |
| `color.semantic.error` | `#FF3B30` | Errors, declined transactions, freeze states |
| `color.semantic.warning` | `#FF9500` | Pending states, overdraft warnings, biometric retry |
| `color.semantic.info` | `#0A84FF` | Informational banners, rate disclosures |
| `color.neutral.100` | `#F5F7FA` | Page background |
| `color.neutral.200` | `#E8ECF2` | Card backgrounds, dividers |
| `color.neutral.500` | `#8A94A6` | Secondary text, placeholders |
| `color.neutral.900` | `#111827` | Primary body text |

### Typography

Font family: **Inter** (full Latin character set, includes ñ, acute accents for Spanish)

| Scale Token | Size | Weight | Line Height | Usage |
|-------------|------|--------|-------------|-------|
| `text.display` | 32px | 700 | 40px | Balance hero display |
| `text.heading.1` | 24px | 700 | 32px | Screen titles |
| `text.heading.2` | 20px | 600 | 28px | Section headers |
| `text.heading.3` | 18px | 600 | 24px | Card titles |
| `text.body.large` | 16px | 400 | 24px | Primary body text |
| `text.body.regular` | 14px | 400 | 20px | Secondary content |
| `text.caption` | 12px | 400 | 16px | Labels, metadata |
| `text.overline` | 11px | 600 | 14px | Section labels (uppercase) |

Numeric variant: Inter Tabular Nums — always used for monetary amounts to prevent layout shift.

### Spacing System

Base unit: **4px**

| Token | Value | Usage |
|-------|-------|-------|
| `space.1` | 4px | Inline icon gap |
| `space.2` | 8px | Tight component padding |
| `space.3` | 12px | Default inner padding |
| `space.4` | 16px | Standard section padding |
| `space.5` | 20px | Card internal padding |
| `space.6` | 24px | Section gaps |
| `space.8` | 32px | Large section separators |
| `space.10` | 40px | Screen-level vertical rhythm |

### Component Library — MaWire Design System (MDS)

All components are defined as Figma component sets with design tokens exported to:
- iOS: Swift Package `MaWireDesignSystem`
- Android: Compose library `cl.mawire.mds`
- Web: React NPM package `@mawire/mds`

Core components:

| Component | States | Notes |
|-----------|--------|-------|
| `MDS.Button.Primary` | default, pressed, loading, disabled | Min touch target 44x44px |
| `MDS.Button.Secondary` | default, pressed, loading, disabled | Outlined style |
| `MDS.Button.Ghost` | default, pressed, disabled | Text-only, used for destructive actions |
| `MDS.Input.Text` | empty, focused, filled, error, disabled | With optional prefix/suffix icon |
| `MDS.Input.Amount` | empty, focused, filled, error | CLP keyboard, auto-formatting |
| `MDS.Input.RUT` | empty, focused, filled, error, validated | Auto-formats to 12.345.678-9 |
| `MDS.Card.Account` | default, selected, loading | Balance + account number |
| `MDS.Card.Transaction` | default, pending, failed, reversed | Merchant logo, amount, date |
| `MDS.BottomSheet` | collapsed, partial, expanded | Gesture-driven, handles navigation |
| `MDS.Alert.Banner` | info, success, warning, error | Dismissible, auto-dismiss option |
| `MDS.Badge` | count, status | For notifications and transaction status |
| `MDS.Skeleton` | loading | Matches component dimensions |
| `MDS.PinPad` | numeric, alphanumeric | Scrambled layout option for high-security |
| `MDS.BiometricPrompt` | face, fingerprint, loading, failed | OS-native biometric trigger |

---

## Consumer App — Complete Screen Inventory

### 1. Onboarding Flow (7 Screens)

#### Screen 1: Welcome

```
┌─────────────────────────────────┐
│                                 │
│         [MaWire Logo]           │
│                                 │
│    La banca que trabaja         │
│         para ti                 │
│                                 │
│  [Micro-animation: coins flow   │
│   into a phone — 3s loop]       │
│                                 │
│  ┌─────────────────────────┐    │
│  │     Abrir cuenta        │    │  ← Primary CTA: Electric Blue fill
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │     Iniciar sesión      │    │  ← Secondary CTA: outlined
│  └─────────────────────────┘    │
│                                 │
│  Powered by MaWire Bank S.A.    │
│  Regulado por la CMF            │
└─────────────────────────────────┘
```

**Interaction design:**
- Coins micro-animation: Lottie JSON, plays on loop, pauses if low power mode is on
- Primary CTA triggers account opening flow
- Secondary CTA triggers login flow
- "Regulado por la CMF" links to CMF registry listing — regulatory requirement
- No data collected on this screen

**UX rationale:** Value proposition stated before requesting any personal data. CMF badge reduces initial trust barrier.

---

#### Screen 2: RUT Entry

```
┌─────────────────────────────────┐
│  ← Cancelar                     │
│                                 │
│  Ingresa tu RUT                 │
│                                 │
│  ┌─────────────────────────┐    │
│  │  12.345.678-9           │    │  ← Auto-formatted as typed
│  └─────────────────────────┘    │
│  Tu RUT único de identidad      │
│                                 │
│  ●● Validando en CMF...         │  ← Spinner: real-time check
│     OR                          │
│  ✓ RUT válido                   │  ← Trust Green check
│     OR                          │
│  ✗ RUT no habilitado            │  ← Alert Red with explanation
│                                 │
│  [Numeric keyboard shown]       │
│                                 │
│  ┌─────────────────────────┐    │
│  │       Continuar         │    │  ← Disabled until valid
│  └─────────────────────────┘    │
└─────────────────────────────────┘
```

**Technical implementation:**
- RUT auto-formatting: insert dots at positions 3, 6, 9 from right; insert dash before check digit
- Luhn-equivalent RUT validation (modulo 11 algorithm) runs client-side instantly
- CMF pre-check API call fires after 500ms debounce following valid format detection
- Pre-check is a simple blacklist lookup — does not trigger a CMF inquiry
- Keyboard type: `UIKeyboardTypeNumberPad` (iOS) / `android:inputType="number"` (Android)
- Paste support: strip formatting from pasted text and re-apply

**UX rationale:** RUT is the universal identifier in Chile — every adult knows it. Auto-formatting reduces errors. Real-time CMF pre-check catches ineligible applicants early, before they invest time in the full flow, reducing frustration.

**Accessibility:**
- Input label: "Rol Único Tributario (RUT)"
- Error messages read by screen reader with assertive politeness level
- VoiceOver announces formatted value as "doce punto trescientos cuarenta y cinco punto seiscientos setenta y ocho guion nueve"

---

#### Screen 3: Document Capture

```
┌─────────────────────────────────┐
│  ← Volver          [Help icon]  │
│                                 │
│  Fotografía tu cédula de        │
│  identidad — parte frontal      │
│                                 │
│  ┌─────────────────────────┐    │
│  │                         │    │
│  │  [Camera preview]       │    │
│  │  ┌───────────────────┐  │    │  ← Overlay: ID card aspect ratio
│  │  │                   │  │    │     corner guides animate to green
│  │  │     [face area]   │  │    │     when card detected
│  │  │                   │  │    │
│  │  └───────────────────┘  │    │
│  │                         │    │
│  └─────────────────────────┘    │
│                                 │
│  Mueve el documento a la luz    │  ← Contextual guidance
│     OR                          │
│  Acerca la cédula               │
│     OR                          │
│  Capturando...  ●               │
│                                 │
│  [Subir desde galería]          │  ← Fallback option
└─────────────────────────────────┘
```

**Technical implementation:**
- Uses native camera with custom overlay (not WebView camera — performance requirement)
- Real-time frame analysis every 500ms: checks for card edges, blur, glare, lighting
- Auto-capture fires when: card edges detected, blur score <0.15, glare <20% of frame
- Document capture SDK: Jumio or similar — integrated via native SDK (not web redirect)
- Front capture followed by back capture in same session
- Quality feedback strings cycle based on which check is failing

**UX rationale:** Guided capture with auto-trigger reduces rejection rate by approximately 40% compared to manual capture. Specific, actionable feedback ("Mueve a la luz") performs significantly better than generic messages ("Error").

---

#### Screen 4: Liveness Check

```
┌─────────────────────────────────┐
│  ← Volver                       │
│                                 │
│  Verifica que eres tú           │
│                                 │
│  ┌─────────────────────────┐    │
│  │                         │    │
│  │  [Camera: front-facing] │    │
│  │       ┌─────┐           │    │  ← Circular frame, animates to
│  │       │     │           │    │     green when face detected
│  │       │ 😐  │           │    │
│  │       │     │           │    │
│  │       └─────┘           │    │
│  │                         │    │
│  └─────────────────────────┘    │
│                                 │
│  Mira directamente a la cámara  │
│                                 │
│  [Progress dots: ● ○ ○]         │
│                                 │
│  No necesitas moverte           │
└─────────────────────────────────┘
```

**Technical implementation:**
- Passive liveness only (ISO 30107-3 Level 1 compliant)
- No challenge-response (turn head, blink) — reduces drop-off by ~25%
- Liveness score compared against document photo from Screen 3
- Match threshold: >0.85 similarity score (configurable per risk tier)
- Failure: 3 attempts before soft rejection + manual review queue
- Session binding: liveness result cryptographically bound to document capture session ID

**UX rationale:** Passive liveness (just look at the camera) is less intimidating and has significantly lower failure rates than challenge-response, especially for older users. CMF does not prescribe a specific liveness level for account opening.

---

#### Screen 5: Review and Confirm

```
┌─────────────────────────────────┐
│  ← Volver                       │
│                                 │
│  Confirma tus datos             │
│                                 │
│  ┌───────────────────────────┐  │
│  │ Nombre        Juan Pérez  │  │  ← Extracted from OCR
│  │               [Editar]    │  │
│  ├───────────────────────────┤  │
│  │ RUT           12.345.678-9│  │
│  │               [Editar]    │  │
│  ├───────────────────────────┤  │
│  │ Fecha nac.    15/03/1985  │  │
│  │               [Editar]    │  │
│  └───────────────────────────┘  │
│                                 │
│  Usaremos tus datos para:       │
│  • Verificar tu identidad       │
│  • Cumplir con regulaciones CMF │
│  • Crear tu cuenta bancaria     │
│                                 │
│  Lee nuestra política de        │
│  privacidad ↗                   │
│                                 │
│  ┌─────────────────────────┐    │
│  │   Confirmar y continuar │    │
│  └─────────────────────────┘    │
└─────────────────────────────────┘
```

**Technical implementation:**
- OCR results displayed are the corrected output from the document SDK
- Each field edit opens a bottom sheet with appropriate keyboard
- Edited fields are flagged as `manually_corrected: true` in the KYC record
- Privacy notice is a CMF/Law 19.628 compliance requirement — must be shown before data storage
- Confirming stores data to encrypted KYC intake queue

**UX rationale:** Allowing correction at this stage prevents approximately 90% of manual review triggers. OCR errors on names with accents (José, María) are common — user correction is faster than back-office review.

---

#### Screen 6: Phone Verification

```
┌─────────────────────────────────┐
│  ← Volver                       │
│                                 │
│  Verifica tu número             │
│                                 │
│  Enviamos un código a           │
│  +56 9 **** 4521                │
│                                 │
│  ┌──┐  ┌──┐  ┌──┐  ┌──┐  ┌──┐  ┌──┐│
│  │  │  │  │  │  │  │  │  │  │  │  ││
│  └──┘  └──┘  └──┘  └──┘  └──┘  └──┘│
│                                 │
│  Reenviar código (00:47)        │  ← Countdown, then tappable
│                                 │
│  ¿Número incorrecto? Cambiarlo  │
│                                 │
│  [Numeric keyboard]             │
└─────────────────────────────────┘
```

**Technical implementation:**
- OTP: 6-digit TOTP, 180-second validity window
- Auto-read: iOS uses `ASAuthorizationSingleSignOnProvider` SMS OTP retrieval; Android uses SMS Retriever API (no SMS permission needed)
- Auto-submit when 6th digit entered — no button required
- Rate limiting: max 3 OTPs per session, 5 per 24h per phone number
- Phone number verified at OTP send time, not at entry screen
- OTP backend uses HMAC-SHA1 with counter to generate codes (RFC 6238)

**UX rationale:** Phone ownership is a strong fraud signal and enables future 2FA. Auto-read on Android covers approximately 85% of users. Resend countdown prevents OTP farming.

---

#### Screen 7: Account Created

```
┌─────────────────────────────────┐
│                                 │
│  [Confetti Lottie animation]    │
│                                 │
│         ¡Bienvenido/a!          │
│         Juan Pérez              │
│                                 │
│    Tu cuenta está lista         │
│                                 │
│  Número de cuenta               │
│  ┌─────────────────────────┐    │
│  │  00312 - 003 - 12345678 │    │  ← Tappable to copy
│  └─────────────────────────┘    │
│                                 │
│  Próximos pasos                 │
│  ○ Agrega fondos a tu cuenta    │
│  ○ Solicita tu tarjeta          │
│  ○ Configura Face ID            │
│                                 │
│  ┌─────────────────────────┐    │
│  │   Ir a mi cuenta        │    │
│  └─────────────────────────┘    │
└─────────────────────────────────┘
```

**Technical implementation:**
- Account number displayed immediately — provisioned synchronously during KYC approval path
- Confetti: Lottie animation (25 frames, no repeat after 2s) — respects "reduce motion" system setting
- "Próximos pasos" are interactive — tapping any item navigates to that feature
- Deep link registered: `mawire://account/new` so push notifications can return to this screen
- Account number tap copies to clipboard and shows MDS toast: "Número copiado"

**UX rationale:** Celebrating account creation reduces early churn. Showing the account number immediately proves the product works. Next steps reduce time-to-first-value.

---

### 2. Home Dashboard (Main Screen)

```
┌─────────────────────────────────┐
│  Hola, Juan 👋    [🔔 (3)]      │  ← Notification count badge
│  Viernes 6 junio                │
│                                 │
│  ┌─────────────────────────┐    │
│  │  Cuenta Corriente       │    │
│  │  ┌───────────────────┐  │    │
│  │  │  $ 1.234.567      │  │    │  ← 32px tabular font, CLP format
│  │  │  [👁 Ocultar]     │  │    │  ← Hides balance to •••.•••
│  │  └───────────────────┘  │    │
│  │  Disponible: $ 980.000  │    │  ← Available vs current
│  └─────────────────────────┘    │
│                                 │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐    │
│  │ ↑  │ │ $  │ │ ⊕  │ │ ⋯  │    │  ← Quick actions row
│  │Enviar Pagar Recargar Más│    │
│  └────┘ └────┘ └────┘ └────┘    │
│                                 │
│  Movimientos recientes          │
│  ┌─────────────────────────┐    │
│  │ [JUMBO]  Supermercado   │    │
│  │          -$ 47.300  12h │    │
│  ├─────────────────────────┤    │
│  │ [UBER]   Transporte     │    │
│  │          -$ 8.200   3h  │    │
│  ├─────────────────────────┤    │
│  │ [TRANSFER] Juan López   │    │
│  │          +$ 100.000 ayer│    │
│  └─────────────────────────┘    │
│  Ver todos los movimientos      │
│                                 │
│  ┌─────────────────────────┐    │
│  │ 📊 Gastaste 15% más en  │    │  ← Insights banner
│  │ restaurantes este mes   │    │
│  │ Ver desglose →          │    │
│  └─────────────────────────┘    │
│                                 │
│  Mis tarjetas                   │
│  [Virtual ●●●● 4521] [Física]  │
│                                 │
│ [🏠 Inicio] [💸 Mover] [💳 Tarjeta] [📊 Inversiones] [☰ Más]│
└─────────────────────────────────┘
```

**Layout specifications:**
- Top bar: 64px height, status bar aware
- Balance card: 160px height, rounded corners 16px, Deep Navy background
- Quick actions row: 88px height, 4 equal columns
- Transaction list items: 64px height each
- Insights banner: 72px height, Electric Blue left border 4px
- Bottom tab bar: 83px height (iOS) / 56dp (Android) + safe area

**Data loading strategy:**
- Balance: real-time from WebSocket subscription (updates within 2s of transaction)
- Recent transactions: cached, refreshed on pull-to-refresh or app foreground
- Insights: pre-computed batch job, cached 24h
- Skeleton loading shown for all sections on first load

**UX rationale:** Balance hidden by default protects privacy in public — user explicitly reveals it. Quick actions eliminate navigation for the top 4 use cases (approximately 90% of sessions). Insights create value passively without requiring user action.

---

### 3. Send Money / Transfer Flow (5 Screens)

#### Screen 1: Choose Recipient

```
┌─────────────────────────────────┐
│  ✕ Cancelar   Enviar dinero     │
│                                 │
│  ┌─────────────────────────┐    │
│  │ 🔍 Buscar por RUT, email│    │
│  └─────────────────────────┘    │
│                                 │
│  Recientes                      │
│  ┌───────┐ ┌───────┐ ┌───────┐  │
│  │  [M]  │ │  [P]  │ │  [+]  │  │  ← Avatar initials, then "New"
│  │ María │ │ Pedro │ │ Nuevo │  │
│  └───────┘ └───────┘ └───────┘  │
│                                 │
│  Frecuentes                     │
│  ┌─────────────────────────┐    │
│  │ [A]  Ana García         │    │
│  │      12.345.678-9       │    │
│  │      Banco Santander    │    │
│  ├─────────────────────────┤    │
│  │ [L]  Luis Torres        │    │
│  │      9.876.543-2        │    │
│  │      Banco de Chile     │    │
│  └─────────────────────────┘    │
│                                 │
│  [Nuevo destinatario]           │
└─────────────────────────────────┘
```

**Technical implementation:**
- Search: fuzzy match on name, exact match on RUT (strip formatting before compare)
- Recent recipients: local encrypted cache, last 10 unique recipients
- Frequent: backend-computed, updated weekly — recipients with >3 transfers in 90 days
- "Nuevo destinatario": opens form with fields: RUT, bank, account type, account number, name
- RUT entered for new recipient triggers background name lookup via SBIF interbank API

**UX rationale:** Recent recipients eliminate approximately 70% of manual entry. Showing bank name reduces wrong-bank errors. RUT name lookup prevents sending to wrong person.

---

#### Screen 2: Enter Amount

```
┌─────────────────────────────────┐
│  ← Volver                       │
│                                 │
│  Para: Ana García               │
│  Banco Santander — Cuenta Cte   │
│                                 │
│         $ 50.000                │  ← Large display, 40px tabular
│                                 │
│  Disponible: $ 980.000          │
│                                 │
│  Chips de monto rápido:         │
│  [$ 5.000] [$ 10.000] [$ 50.000] [$ 100.000]│
│                                 │
│  Concepto (opcional)            │
│  ┌─────────────────────────┐    │
│  │ Ej: arriendo enero      │    │
│  └─────────────────────────┘    │
│  Máx. 140 caracteres            │
│                                 │
│  [1][2][3]                      │
│  [4][5][6]  ← CLP numeric pad   │
│  [7][8][9]     (no decimal key) │
│  [.][0][⌫]                      │
│                                 │
│  ┌─────────────────────────┐    │
│  │       Continuar         │    │
│  └─────────────────────────┘    │
└─────────────────────────────────┘
```

**Technical implementation:**
- Amount input: custom numpad (no decimal — CLP is whole units)
- Validation: amount > 0, amount <= available balance, amount <= daily transfer limit
- Daily limit shown when approaching: "Límite diario: $ 5.000.000"
- Concept field: standard keyboard, 140 chars max (TEF standard)
- Quick chips auto-fill the amount field
- "Continuar" disabled until amount >0 and <=limit

---

#### Screen 3: Confirm Details

```
┌─────────────────────────────────┐
│  ← Volver      Confirmar envío  │
│                                 │
│  Resumen de transferencia       │
│                                 │
│  ┌─────────────────────────┐    │
│  │ Para          Ana García│    │
│  │ RUT        12.345.678-9 │    │
│  │ Banco    Banco Santander│    │
│  │ Tipo     Cuenta Cte.    │    │
│  │ N° cuenta  00-123-45678 │    │
│  ├─────────────────────────┤    │
│  │ Monto       $ 50.000    │    │
│  │ Comisión    $ 0          │    │  ← CLP 0 for standard TEF
│  │ Concepto    arriendo ene │    │
│  ├─────────────────────────┤    │
│  │ Total       $ 50.000    │    │
│  ├─────────────────────────┤    │
│  │ Llegada  En minutos     │    │  ← Settlement SLA
│  │ Tipo     TEF            │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │   Autorizar con Face ID │    │
│  └─────────────────────────┘    │
└─────────────────────────────────┘
```

**Fee logic:**
- TEF (standard): CLP 0 — standard interbank transfer, settles in minutes during business hours
- LBTR (same-day guaranteed): CLP 490 — shown when selected or when TEF unavailable (outside hours)
- International SWIFT: fee varies by amount and currency — fetched from fee schedule API

**Settlement time display logic:**
- Weekday 09:00–20:30 CLT: "En minutos"
- Outside hours: "Mañana hábil, antes de las 10:00"
- LBTR selected: "Hoy, antes del cierre LBTR (18:30)"

---

#### Screen 4: Biometric Confirm

```
┌─────────────────────────────────┐
│                                 │
│  Confirma con Face ID           │
│                                 │
│  Estás enviando                 │
│  $ 50.000                       │  ← Amount shown during biometric
│  a Ana García                   │     (prevents UI injection attacks)
│                                 │
│  [Face ID system prompt]        │
│                                 │
│  ─────── o ───────              │
│                                 │
│  Usar PIN de MaWire             │  ← Fallback for biometric failure
│                                 │
│  Cancelar                       │
└─────────────────────────────────┘
```

**Technical implementation:**
- iOS: `LAContext.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)`
- Android: `BiometricPrompt` with `BIOMETRIC_STRONG` authenticator
- Amount and recipient shown in app-controlled UI ABOVE the system biometric prompt
- This prevents a UI overlay attack where a different amount is shown during auth
- On biometric failure (3 attempts): fall back to MaWire 6-digit PIN
- PIN is a secondary auth factor, not just device PIN — stored as PBKDF2 hash server-side

---

#### Screen 5: Transfer Success

```
┌─────────────────────────────────┐
│                                 │
│  [Green checkmark animation]    │
│                                 │
│    ¡Transferencia enviada!      │
│                                 │
│  $ 50.000 → Ana García          │
│                                 │
│  N° operación: 20260606-123456  │
│  06/06/2026, 14:32              │
│                                 │
│  ┌─────────────────────────┐    │
│  │  Compartir comprobante  │    │  ← Share sheet: PDF or image
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │   Transferir de nuevo   │    │
│  └─────────────────────────┘    │
│                                 │
│  Volver al inicio               │
└─────────────────────────────────┘
```

**Technical implementation:**
- Success screen shown only after API confirms `202 Accepted` with transfer ID
- "Compartir comprobante": generates PDF using native PDF renderer with MaWire watermark and QR code linking to verification URL
- Verification URL: `https://verificar.mawire.cl/{transferId}` — publicly verifiable, no auth needed
- "Transferir de nuevo": pre-fills recipient from this transfer, clears amount
- Deep link: `mawire://transfers/{transferId}` — referenced in push notifications

---

### 4. Cards Management Screen

#### Virtual Card View

```
┌─────────────────────────────────┐
│  ← Volver           Mis tarjetas│
│                                 │
│  ┌─────────────────────────┐    │
│  │  MaWire Bank         ◻  │    │  ← Card art, Deep Navy gradient
│  │                         │    │
│  │  •••• •••• •••• 4521   │    │  ← Masked PAN
│  │                         │    │
│  │  JUAN PÉREZ   06/28    │    │
│  │  [Mostrar número]       │    │  ← Requires Face ID, shows 30s
│  └─────────────────────────┘    │
│                                 │
│  CVV: [Mostrar CVV]             │  ← Also requires biometric
│                                 │
│  Controles de tarjeta           │
│  ┌─────────────────────────┐    │
│  │ Congelar tarjeta    [ ] │    │  ← Toggle
│  │ Compras en internet [ ] │    │  ← Toggle
│  │ Compras inter.      [ ] │    │  ← International
│  │ Sin contacto        [✓] │    │  ← Contactless enabled
│  └─────────────────────────┘    │
│                                 │
│  Límites de tarjeta             │
│  Compras: $ 2.000.000/día       │
│  [Ajustar límites]              │
│                                 │
│  Agregar a Apple Pay / Google Pay│
└─────────────────────────────────┘
```

**PAN reveal implementation:**
- PAN reveal requires fresh biometric auth (not cached session auth)
- On success: full PAN displayed in monospace font for exactly 30 seconds
- Countdown timer visible: "Ocultando en: 28s"
- Screen capture blocked during reveal (iOS: `view.isSecureTextEntry`, Android: `FLAG_SECURE`)
- PAN never stored in app memory beyond display period — fetched from encrypted vault, displayed, then zeroed

**CVV reveal:**
- Dynamic CVV (dCVV) generated server-side, changes every 5 minutes
- Shown for 30 seconds same as PAN, same restrictions

---

#### Physical Card View

```
┌─────────────────────────────────┐
│  Tarjeta Física                 │
│                                 │
│  Estado del pedido:             │
│  ●━━━━●━━━━○━━━━○━━━━○          │
│  Solicitada Producción Enviada Entregada│
│                                 │
│  Estimado: 5-7 días hábiles     │
│  Dirección: Av. Providencia 123 │
│                                 │
│  ─────────────────────────────  │
│  Gestión de PIN                 │
│  [Cambiar PIN]                  │
│                                 │
│  ─────────────────────────────  │
│  ┌─────────────────────────┐    │
│  │ Reportar pérdida/robo   │    │  ← Alert Red border
│  └─────────────────────────┘    │
│                                 │
│  Solicitar reposición           │
└─────────────────────────────────┘
```

**Lost/stolen flow:**
- Tapping "Reportar pérdida/robo" shows confirmation bottom sheet with amount ($0 liability statement)
- Confirmed: card frozen immediately via API, fraud team notified
- Replacement card automatically ordered unless user cancels
- CMF requirement: confirmation SMS sent to registered phone within 60 seconds

---

### 5. Investments Screen

#### Portfolio Overview

```
┌─────────────────────────────────┐
│  Inversiones                    │
│                                 │
│  Total invertido                │
│  $ 2.345.000                    │
│  +4.2% este año  +$ 98.490      │  ← Trust Green for positive
│                                 │
│  [Chart: line graph]            │
│  [1D][1S][1M][1A][Todo]         │  ← Period selector
│                                 │
│  Mis fondos                     │
│  ┌─────────────────────────┐    │
│  │ MaWire Conservador      │    │
│  │ $ 1.200.000             │    │
│  │ TIR 4.2% · Bajo riesgo  │    │
│  │ Liquidez: diaria        │    │
│  ├─────────────────────────┤    │
│  │ MaWire Moderado         │    │
│  │ $ 845.000               │    │
│  │ TIR 6.8% · Riesgo medio │    │
│  │ Liquidez: 7 días        │    │
│  ├─────────────────────────┤    │
│  │ MaWire Agresivo         │    │
│  │ $ 300.000               │    │
│  │ TIR 11.2%* · Alto riesgo│    │
│  │ Liquidez: 30 días       │    │
│  └─────────────────────────┘    │
│  * Rentabilidad esperada, no    │
│    garantizada                  │  ← CMF regulatory disclaimer
│                                 │
│  APV (Ahorro Previsional)       │
│  APV Régimen A: Activo          │
│  APV Régimen B: No activo       │
│  [Activar APV B]                │
└─────────────────────────────────┘
```

**Regulatory requirements on this screen:**
- Risk classification displayed for every fund (CMF Circular 1869)
- "Rentabilidad pasada no garantiza rentabilidad futura" disclaimer visible
- TIR labeled as "esperada" for riskier funds
- Fund prospectus linked from each card (PDF in-app viewer)
- APV tax benefit explanation: "55% bonificación fiscal" clearly explained

**APV implementation:**
- APV A: 15% state bonus (up to UF 900/year) — displayed in UF
- APV B: deductible from taxable base up to UF 600/year
- SII (Chilean tax authority) integration: annual report pre-populated for Operación Renta

---

### 6. Support Screen

```
┌─────────────────────────────────┐
│  Ayuda y soporte                │
│                                 │
│  ┌─────────────────────────┐    │
│  │ 🤖 Pregunta a MaWire AI │    │
│  │ "¿En qué te puedo       │    │
│  │  ayudar hoy?"           │    │
│  └─────────────────────────┘    │
│                                 │
│  Autogestión                    │
│  ┌─────────────────────────┐    │
│  │ 📄 Cartolas y documentos│    │
│  ├─────────────────────────┤    │
│  │ 🔄 Disputar un cobro    │    │
│  ├─────────────────────────┤    │
│  │ 📋 Certificados SII     │    │
│  └─────────────────────────┘    │
│                                 │
│  Contactar a una persona        │
│  ┌─────────────────────────┐    │
│  │ 📹 Videollamada (L-V)   │    │
│  ├─────────────────────────┤    │
│  │ 📞 Llamar: 600 XXX XXXX │    │  ← CMF regulatory requirement
│  └─────────────────────────┘    │
│                                 │
│  ⚠️ Emergencias                 │
│  [Bloquear cuenta]              │  ← One-tap account freeze
└─────────────────────────────────┘
```

**Regulatory notes:**
- Human escalation is a CMF requirement — always reachable within 2 taps
- Phone number display is mandatory for licensed banking accounts
- Video call: requires agent availability hours (L-V 09:00-20:00 CLT) — shows wait time
- AI chatbot must self-identify as AI at the start of each conversation

---

## Business Banking App — Additional Screens

### Dashboard (Business)

```
┌─────────────────────────────────┐
│  Empresa Constructora S.A.      │
│  RUT: 76.543.210-K              │
│                                 │
│  Cuentas                        │
│  Cuenta Operaciones: $12.456.780│
│  Cuenta Nómina:      $ 4.230.000│
│                                 │
│  ┌─────────────────────────┐    │
│  │ ⏳ 3 aprobaciones pend. │    │  ← Badge count, Alert Orange
│  └─────────────────────────┘    │
│                                 │
│  Flujo de caja — últimos 30 días│
│  [Bar chart: daily in/out]      │
│                                 │
│  Próxima nómina: 28/06/2026     │
│  Empleados: 47  Total: $45.3M   │
│  [Revisar nómina]               │
└─────────────────────────────────┘
```

---

### Payroll Management

**Screen layout:**

- Header: pay period selector (month/year), total payroll amount
- Employee list: name, RUT, gross salary, AFP, Isapre, net salary
- Status per employee: OK, Pending document, On leave
- Bulk actions: import Excel, export Previred file, send to approval

**Previred integration:**
- Previred is Chile's mandatory payroll remittance system (Previred.com)
- MaWire generates the Previred-format XML file from payroll data
- File submitted via Previred API with MaWire's institutional credentials
- Payment of AFP/Isapre contributions debited from Nómina account automatically on submission

**Approval flow UI:**
```
Creator submits → Supervisor reviews → Treasurer approves → Payment executes
   [Draft]         [Pending review]      [Pending auth]        [Processing]
```

Each step sends push notification to the next approver's app.

---

### Treasury / Approvals

```
┌─────────────────────────────────┐
│  Aprobaciones pendientes (3)    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ Pago proveedor XYZ      │    │
│  │ $ 2.340.000             │    │
│  │ Solicitado por: María G  │    │
│  │ Motivo: Factura 4521    │    │
│  │ [Ver detalle] [Rechazar] [Aprobar]│
│  ├─────────────────────────┤    │
│  │ Transferencia nómina    │    │
│  │ $ 45.234.000            │    │
│  │ Solicitado por: RRHH    │    │
│  │ [Ver detalle] [Rechazar] [Aprobar]│
│  └─────────────────────────┘    │
│                                 │
│  [Aprobar todo con Face ID]     │  ← Bulk approve, single biometric
│                                 │
│  Ver historial de aprobaciones  │
└─────────────────────────────────┘
```

**4-eyes control implementation:**
- Each payment requires exactly 2 distinct approvers from the authorization group
- Creator cannot approve their own payment (enforced server-side, not just UI)
- Bulk approve: single biometric unlocks batch, each approval recorded individually in audit log
- Audit trail: every approval/rejection logged with user ID, timestamp, IP, device ID

---

## Accessibility Requirements

### Standards
- **WCAG 2.1 Level AA** — baseline requirement for all screens
- Target **Level AAA** for key financial flows (transfer confirmation, login)

### Contrast Ratios
| Element | Minimum Ratio | Target |
|---------|--------------|--------|
| Normal text (<18px) | 4.5:1 | 7:1 |
| Large text (≥18px bold or ≥24px) | 3:1 | 4.5:1 |
| UI components (buttons, inputs) | 3:1 | 4.5:1 |
| Amount text in balance card | 7:1 (Navy on white background version) | — |

### Touch Target Standards
- Minimum: 44x44 points (iOS) / 48x48dp (Android)
- Spacing between targets: minimum 8px
- Applies to: all buttons, toggles, list items, tab bar items

### Screen Reader Support
- All interactive elements: `accessibilityLabel` with context (not just icon name)
  - Bad: "bell icon"
  - Good: "Notificaciones, 3 sin leer"
- Amount fields: announce formatted value in words via `accessibilityValue`
  - "$1.234.567" announced as "un millón doscientos treinta y cuatro mil quinientos sesenta y siete pesos"
- Charts: provide `accessibilityHint` with summary data ("Inversión subió 4.2% en el último año")
- Modal and bottom sheet focus management: focus moves to first interactive element on open

### Dynamic Type
- All text elements respond to iOS Dynamic Type and Android font scale
- Layouts tested at 85%, 100%, 150%, 200% font scale
- No truncation for amounts or account numbers — layout reflows instead
- Maximum text size tested: iOS Accessibility Extra Extra Extra Large

### Reduce Motion
- All Lottie animations check `UIAccessibility.isReduceMotionEnabled` (iOS) / `Animator.getDurationScale()` (Android)
- Alternative: static image shown when reduce motion enabled
- Transitions: crossfade instead of slide when reduce motion active

### High Contrast Mode
- Additional color tokens defined for high contrast: `color.brand.blue.highContrast = #0040CC`
- Borders added to cards in high contrast mode (cards have no border in standard mode)

---

## Chilean Localization Reference

### Monetary Formatting

| Currency | Format | Example |
|----------|--------|---------|
| CLP | `$ X.XXX.XXX` (dot for thousands, no decimal) | `$ 1.234.567` |
| UF | `UF X.XXXX` (4 decimal places) | `UF 456.7800` |
| USD | `US$ X,XXX.XX` (comma for thousands, dot for decimal) | `US$ 1,234.56` |
| UTM | `UTM X.XXX` | `UTM 1.234` |

### Date and Time

| Format | Example |
|--------|---------|
| Date | `DD/MM/YYYY` → `06/06/2026` |
| Date (short) | `6 jun` |
| Date (long) | `Viernes 6 de junio de 2026` |
| Time | `HH:MM` 24-hour → `14:32` |
| Timezone | CLT (UTC-3) summer / CLST (UTC-4) winter — Chile observes DST |

### RUT Format
- Standard: `12.345.678-9`
- Acceptance: also accept `12345678-9`, `123456789`, strip and reformat
- Check digit: 0-9 and K (uppercase) — display K always as uppercase

### Banking-specific Chilean terms
| Term | Usage |
|------|-------|
| Cuenta Vista | Basic account (low KYC) |
| Cuenta Corriente | Full checking account |
| Cartola | Account statement |
| Giro | Withdrawal |
| Abono | Deposit |
| TEF | Electronic fund transfer (Transferencia Electrónica de Fondos) |
| LBTR | High-value same-day transfer (Liquidación Bruta en Tiempo Real) |
| AFP | Pension fund (Administradora de Fondos de Pensiones) |
| Isapre | Private health insurance |
| Fonasa | Public health system |
| APV | Voluntary pension savings (Ahorro Previsional Voluntario) |
| SII | Chilean tax authority (Servicio de Impuestos Internos) |
| CMF | Financial markets regulator (Comisión para el Mercado Financiero) |
| UAF | Financial intelligence unit (Unidad de Análisis Financiero) |
| Previred | Mandatory payroll remittance platform |
