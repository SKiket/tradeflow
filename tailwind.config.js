/**
 * Tailwind v4 is CSS-first; this file is loaded from src/app/globals.css
 * via @config so brand colours stay sourced from the pack, not duplicated.
 */
const { copalla, tradeflow } = require("./brand/colours/tradeflow-tailwind.js");

/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      colors: {
        copalla,
        tradeflow,
      },
    },
  },
};
