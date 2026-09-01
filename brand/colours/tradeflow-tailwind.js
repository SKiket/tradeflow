/**
 * TradeFlow Brand — Tailwind CSS Colour Config
 * Add this inside your tailwind.config.js theme.extend.colors
 * Values match Copalla_Brand_Pack_v1/colours/copalla-tailwind.js exactly —
 * TradeFlow adds semantic aliases on top, it does not fork the palette.
 */

const copalla = {
  teal: {
    DEFAULT: '#177EA1',
    deep:    '#0E5F7A',
    pale:    '#E8F5FB',
  },
  mint:    '#3DD6C8',
  amber:   '#F5C518',
  orange:  '#F5A623',
  navy: {
    DEFAULT: '#1E3B5D',
    mid:     '#2D5480',
    deep:    '#122840',
  },
  slate:      '#8FA4AD',
  border:     '#D0E4EA',
  'off-white':'#F7FBFD',
};

const tradeflow = {
  cta: {
    DEFAULT: copalla.amber,
    hover:   copalla.orange,
    text:    copalla.navy.DEFAULT,
  },
  secondary: {
    DEFAULT: copalla.teal.DEFAULT,
    hover:   copalla.teal.deep,
  },
  dashboard: {
    chrome: copalla.navy.deep,
    accent: copalla.mint,
  },
  highlight: '#FDF3D3',
  // Default tenant accent for un-customised storefronts.
  // Real per-tenant values come from businesses.storefront_accent_color
  // at render time, not from this static config.
  'tenant-accent-default': copalla.amber,
};

module.exports = { copalla, tradeflow };

/*
 * Usage in tailwind classes:
 *   bg-copalla-navy          text-copalla-mint
 *   bg-tradeflow-cta          text-tradeflow-cta-text
 *   bg-tradeflow-dashboard-chrome
 */
