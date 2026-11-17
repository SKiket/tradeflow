-- Step 24e: seller chooses whether to restock when marking a return received.
-- NULL = not set (legacy returns, or no stock-tracked lines). true/false = choice.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS return_restocked BOOLEAN;

COMMENT ON COLUMN public.orders.return_restocked IS
  'When marking RETURNED: true = added back to stock, false = not restocked, NULL = unset/legacy/no tracked stock.';
