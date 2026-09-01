# TradeFlow Brand — Typography Guide
Version 1.0 | August 2026
Same type system as Copalla Brand Pack v1.0 (Syne + DM Sans) — TradeFlow
does not introduce a third typeface. This document adds TradeFlow
surface-specific usage notes only.

---

## Typefaces (inherited from Copalla, unchanged)

### Primary: Syne
- **Use for:** Display, headings, wordmark, all prominent text
- **Weights used:** 800 (Display), 700 (Heading), 600 (Sub-heading)
- **Google Fonts:** https://fonts.google.com/specimen/Syne
- **Import:** `@import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&display=swap');`

### Secondary: DM Sans
- **Use for:** Body copy, UI labels, captions, navigation
- **Weights used:** 300 (Light), 400 (Regular), 500 (Medium), 600 (Semi-bold)
- **Google Fonts:** https://fonts.google.com/specimen/DM+Sans
- **Import:** `@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap');`

### Combined import for TradeFlow's codebase
```html
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet">
```

---

## Type Scale (unchanged from Copalla)

| Role        | Font      | Weight | Size    | Line Height | Letter Spacing |
|-------------|-----------|--------|---------|-------------|-----------------|
| Display     | Syne      | 800    | 48–64px | 1.0         | -1px            |
| H1          | Syne      | 700    | 36–40px | 1.1         | -0.5px          |
| H2          | Syne      | 700    | 28–32px | 1.15        | -0.3px          |
| H3          | Syne      | 600    | 22–24px | 1.2         | 0               |
| Sub-heading | DM Sans   | 500    | 18–20px | 1.3         | 0               |
| Body        | DM Sans   | 400    | 15–16px | 1.7         | 0               |
| Body small  | DM Sans   | 400    | 13–14px | 1.6         | 0               |
| Label/Tag   | DM Sans   | 600    | 10–11px | 1.4         | 2.5–3.5px       |
| Caption     | DM Sans   | 300    | 11–12px | 1.5         | 0.5px           |

---

## TradeFlow surface-specific usage

- **Storefront (`/s/[slug]`):** Business/product names use Syne 700
  (H2/H3 scale) so each seller's shop still reads as a real, considered
  shopfront even without custom branding. Prices and descriptions stay
  DM Sans — never set a price in Syne, it reads as decorative rather
  than factual.
- **Checkout:** Deliberately restrained — DM Sans throughout except the
  page heading. This is the highest-trust moment in the product; Syne's
  bold display character is right for browsing, not for the payment
  screen.
- **Dashboard:** DM Sans-led, consistent with Copalla's own product
  usage — a seller's working tool should feel efficient, not decorative.
  Syne reserved for section H2/H3 headings only (Orders, Products,
  Settings), never for data values, table cells, or button labels.
- **Tracking page:** DM Sans throughout, one Syne H2 for the order
  reference — this page is read once, quickly, and should prioritise
  clarity over branding presence.

---

## System Fallbacks (unchanged from Copalla)

- **Syne → Arial Black, Impact, sans-serif**
- **DM Sans → -apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif**

---

## Rules (unchanged from Copalla)

- Never use Syne below 12px
- Labels and tags are always uppercase with letter-spacing ≥ 2.5px
- Body text is always DM Sans Regular or Medium — never Syne
- Minimum body text size is 13px for accessibility
- Prices, quantities, and other factual data are always DM Sans,
  never Syne, on every TradeFlow surface without exception
