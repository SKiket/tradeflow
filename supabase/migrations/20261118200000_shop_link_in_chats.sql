-- Step 24g: seller preference for sharing shop/product links in WhatsApp.
-- Additive only. Default matches previous behaviour expectation: share when
-- asked and when it helps (suggested greetings / unmatched / out-of-stock).

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS shop_link_in_chats text NOT NULL DEFAULT 'ask_and_suggest';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'businesses_shop_link_in_chats_check'
  ) THEN
    ALTER TABLE public.businesses
      ADD CONSTRAINT businesses_shop_link_in_chats_check
      CHECK (shop_link_in_chats IN ('off', 'ask', 'ask_and_suggest'));
  END IF;
END $$;

COMMENT ON COLUMN public.businesses.shop_link_in_chats IS
  'WhatsApp shop/product link sharing: off | ask | ask_and_suggest';
