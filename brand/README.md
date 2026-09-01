# TradeFlow Brand Pack v1.0
**August 2026 · Derived from Copalla Brand Pack v1.0**

Direction chosen: **Amber warmth** — amber primary CTA, Copalla navy and
teal retained for structure, off-white base. Full reasoning and usage
rules in `guidelines/tradeflow-brand-guidelines.md`.

## Quick start

### Logos
Use SVG files as the primary format. Never alter the Nodes mark's
source colours (inherited rule from Copalla). PNG rasters can be
exported from these SVGs later for contexts that don't support vector
(email, some social platforms) — none are included yet in this v1 pack.

### Colours
```css
@import url('tradeflow-colours.css');
background: var(--tf-cta-bg);
color: var(--tf-cta-text);
```
Or via Tailwind: `bg-tradeflow-cta text-tradeflow-cta-text`

### Fonts
```html
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet">
```

### The two-tier model, in one sentence
Dashboard = always TradeFlow-branded. Storefront/checkout/tracking =
TradeFlow-branded by default, personalisable per seller via
`storefront_accent_color`, `logo_url`, `banner_url`.

See `guidelines/tradeflow-brand-guidelines.md` for the full detail
before implementing.
