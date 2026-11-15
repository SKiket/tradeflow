import * as Sentry from "@sentry/nextjs";

import { sentrySharedOptions } from "@/lib/sentry/scrub";

Sentry.init({
  ...sentrySharedOptions(),
});
