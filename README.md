This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Verify scripts

Run the suite sequentially (never in parallel) with:

```bash
# Terminal 1 — Next.js with mocked Twilio (required for WhatsApp paths)
# Ensure .env.local contains: TWILIO_DRY_RUN=true
npm run dev

# Terminal 2
node scripts/verify-all.mjs
```

`verify-all.mjs` cleans leftover test rows, seeds `EK-Pousser_D`, forces `TWILIO_DRY_RUN=true` for child processes (never real Twilio), runs scripts in a fixed order (never parallel), prints a PASS/FAIL/KNOWN table, and exits non-zero on unexpected failures. Known failures live in `scripts/KNOWN_FAILURES.md`.

| Need | Scripts |
| --- | --- |
| Local Next on `BASE_URL` (default `http://localhost:3000`) + `TWILIO_DRY_RUN=true` on the server | Most WhatsApp / inbox / draft / support / returns verifies |
| Stripe TEST keys + a charges-enabled Connect account with **transfers** capability | `verify-payment-intent`, `verify-billing*`, `verify-pricing`, `verify-refunds`, `verify-storefront-checkout`, disputes |
| Seed catalog (`[order_parse_seed]`) via `seed-ek-pousser-catalog.mjs` | order-parse, draft-order, support-catalog, refunds, fulfil-order |
| Cleanup leftovers | `node scripts/cleanup-verify-leftovers.mjs` (add `--delete` to remove) |

Never use real Twilio sends in verifies (mock / dry-run only; test numbers in the `+447700900xxx` range).

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
