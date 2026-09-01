# TradeFlow Brand Guidelines
Version 1.0 | August 2026
TradeFlow is a Copalla Ltd product. This guide is a child of
`Copalla_Brand_Pack_v1` — it inherits Copalla's mark, palette, and type
system unchanged, and adds the decisions specific to TradeFlow as a
commerce product with two very different audiences (sellers running
their own dashboard, and their customers browsing a public storefront).

Chosen direction: **Amber warmth** (Direction 3 of twelve reviewed) —
amber as TradeFlow's primary call-to-action colour, navy and teal
carried over from Copalla for structure and trust, off-white base,
warm without leaving the Copalla family.

---

## 1. The mark — never modified

TradeFlow uses the Copalla Nodes mark exactly as defined in
`Copalla_Brand_Pack_v1/README.md` — two overlapping outline rings
(Orbit Mint left, Signal Amber right) with a white, navy-stroked dot at
the intersection. Per Copalla's own rule, **the mark's source colours
are never altered.** TradeFlow's identity is expressed through the
wordmark and through how the surrounding palette is used — not by
reinventing the mark itself. This keeps every Copalla product
recognisably part of one family at a glance.

## 2. Two-tier branding model

TradeFlow has two audiences that should NOT look the same:

| Surface | Who sees it | Branding |
|---|---|---|
| Dashboard (`/dashboard/*`) | The seller, using their own working tool | Always TradeFlow/Copalla-branded. Never tenant-customised. Navy chrome, mint accent (see Direction 2, retained here for the dashboard specifically). |
| Storefront (`/s/[slug]`), checkout, tracking page (`/t/[orderRef]`) | The seller's own customers | TradeFlow-branded by default (amber CTA, off-white base), with room for the seller to personalise their own storefront's accent colour and logo — see Section 4. |

A buyer checking out on a seller's storefront should feel like they're
buying from that seller, not from "TradeFlow" as a visible middleman.
A seller managing their shop should always feel anchored in one
consistent, trustworthy tool.

## 3. Colour usage by surface

- **Storefront primary CTA** ("Order via WhatsApp", "Add to cart",
  "Place order"): amber background, navy text (`--tf-cta-bg` /
  `--tf-cta-text`). This is TradeFlow's signature action colour.
- **Secondary actions**: teal background, white text.
- **Checkout**: deliberately quieter than the storefront — navy for the
  primary "Pay securely" action, minimal decoration, per the Trust
  Checkout concept (Direction 11). This is the highest-stakes screen in
  the product; restraint reads as trustworthy here more than warmth
  does.
- **Dashboard chrome**: navy-deep background, mint accent — kept
  distinct from the storefront's amber so a seller never confuses
  "my own tool" with "what my customers see."
- **Tracking page**: off-white, minimal colour, mint used sparingly for
  positive status states (Delivered) — clarity over branding.

## 4. Tenant storefront personalisation

Each business can set its own storefront accent colour
(`businesses.storefront_accent_color`, hex, nullable) and continue
using their own `logo_url`/`banner_url` (already in the schema). When
unset, the storefront falls back to TradeFlow's own amber default —
every seller gets a good-looking shop from day one, personalisation is
additive, not required.

**What tenants CAN customise:** storefront accent colour, logo, banner
image.
**What tenants CANNOT customise:** the dashboard chrome, the Nodes mark
itself, typography (Syne/DM Sans stays fixed across every tenant — this
keeps the product feeling coherent even as colours vary).

## 5. Voice

TradeFlow's UI copy should be plain, direct, and unpretentious —
matching the actual product (a WhatsApp-first tool for small, real
businesses, not an enterprise SaaS). Prefer:
- "Order via WhatsApp" over "Initiate purchase flow"
- "We'll send order updates to this WhatsApp number" over
  "Notifications will be dispatched via configured channel"
- Plain confirmation states ("Order placed", "Payment received") over
  exclamation-heavy copy

## 6. Files in this pack

```
tradeflow_brand/
├── logos/svg/
│   ├── tradeflow-logo-primary-light.svg   Full lockup, light backgrounds
│   ├── tradeflow-logo-primary-dark.svg    Full lockup, navy background
│   ├── tradeflow-icon-transparent.svg     Mark only, transparent
│   ├── tradeflow-app-icon-512.svg         App icon, rounded square
│   ├── tradeflow-wordmark-navy.svg        Wordmark only, navy
│   └── tradeflow-wordmark-white.svg       Wordmark only, white
├── colours/
│   ├── tradeflow-colours.css              CSS custom properties
│   └── tradeflow-tailwind.js              Tailwind config extension
├── fonts/
│   └── tradeflow-typography.md            Type system + surface usage
└── guidelines/
    └── tradeflow-brand-guidelines.md      This file
```
