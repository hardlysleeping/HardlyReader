# Billing: paying for HardlyReader Sync on the web

One subscription, two prices, one boolean. Paid for in a browser, on any platform the app
runs on, because a browser is the one payment surface a Flatpak, a PWA, a sideloaded iPhone
and a Linux desktop all have. This is why StoreKit and Play Billing are demoted in
`docs/accounts-and-entitlements.md`: they charge for the same feature and each buys one
platform, and neither is needed until a store demands it.

```
HardlyReader (any platform)
    │  POST /checkout  { plan: "monthly" | "yearly" }   Authorization: Bearer <supabase JWT>
    ▼
server/billing  ──► Stripe: create customer (once), create Checkout Session
    │                     │
    │  ◄── { url } ───────┘
    ▼
app opens the URL in the system browser  →  Stripe's page, card data never in the app
                                              │
                                    checkout.session.completed
                                    customer.subscription.updated
                                    customer.subscription.deleted
                                    invoice.payment_failed
                                              ▼
                        server/billing  ──► Postgres: entitlements.cloud_sync
                                              ▲
app comes back, refreshes  ── GET row ────────┘
```

The three files that matter:

| file | what it decides |
|---|---|
| `supabase/schema.sql` | `apply_stripe_event()`: event id spent once, customer → reader, late events lose |
| `server/billing/subscription-state.mjs` | a Stripe status, read as `cloud_sync` + `expires_at` |
| `server/billing/app.mjs` | four routes, and which reader an event belongs to |
| `src/api/billing.ts` | the app's four lines: ask, open, come back, refresh |

## 1. Prices live at Stripe

`STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY` are the only place a `price_…` id exists.
The app sends `monthly` or `yearly`; the service turns that into a price at checkout time,
and `GET /plans` returns Stripe's own `unit_amount` and `currency` formatted for display.
Consequences worth stating:

- changing a price is a dashboard change plus an env change, not a release;
- a client with an edited bundle cannot ask for a price this deployment does not sell
  (`plan_not_offered`);
- a webhook for a subscription on any other price grants nothing (`price_not_sold`) — that
  check is what stops a $0.01 price in the dashboard from unlocking the feature.

Both prices grant the same capability. There is still exactly one flag, `cloud_sync`.

## 2. Which reader an event belongs to

Written at **checkout creation**, from the reader's JWT (`GET /auth/v1/user`), into
`stripe_customers(user_id, customer_id)` — before the Checkout Session exists. The customer
is reused on a second purchase, so a reader who cancels and resubscribes has one identity at
Stripe and one row here.

The webhook never reads a user id from its body. It reads `customer`, looks the reader up,
and if there is no link it returns `unknown_customer` and writes nothing. A body can claim
any id; only the link table can say whose money it was. `tests/unit/billing-webhook.mjs`
asserts this by putting an attacker's user id in `metadata` and `client_reference_id` and
checking that it is never passed to the database.

## 3. Statuses, mapped honestly

`mapSubscription()` in `server/billing/subscription-state.mjs`. The row has two columns, so
the app's `grace` state has to be *written* rather than stored by name: true plus a date in
the future.

| Stripe status | `cloud_sync` | `expires_at` | why |
|---|---|---|---|
| `active` | true | period end | includes `cancel_at_period_end`: still paid up |
| `active`, period passed | false | period end | a stale cache is not a subscription |
| `trialing` | true | trial end (else period end) | |
| `past_due` | true | later of (period end, now) **+ 7 days** | dunning is not a customer who stopped paying |
| `canceled`, period not over | true | period end | cancelling is not a refund |
| `canceled`, period over | false | period end | |
| `unpaid` | true until the period ends, then false | period end | the period was paid for |
| `incomplete` / `incomplete_expired` | false | period end | the first payment never completed |
| `paused` | false | period end | |
| anything else | false | period end or `created` | a new Stripe status fails closed, and the log says why |

The 7 days is `GRACE_MS`. It is a choice, made once, in one place: long enough for a reissued
card and a week away, short enough that the row turns itself off without anyone pressing
anything. Stripe's own retries normally resolve it first with a `customer.subscription.updated`
that puts the date back to the plain period end.

Expiry **pauses sync and touches nothing else** — the same rule as
`docs/accounts-and-entitlements.md`: the local library, read state, stars and everything
already written to a cloud folder stay exactly where they are.

## 4. Idempotency, and the event that must not win

Stripe delivers at least once, and not always in order. Both are handled in one transaction,
in `apply_stripe_event()`:

1. **Spend the event id.** `insert … on conflict do nothing` into `stripe_events`. A conflict
   whose row was finished is `duplicate`: 200, nothing written. A conflict whose row was
   *claimed but never applied* (the process died between claim and write) is finished now —
   so a crash loses no grant, and the retry is the thing that heals it.
2. **Refuse an unknown customer** — `unknown_customer`, no row.
3. **Refuse a late delivery.** `event.created` older than `stripe_customers.last_event_created`
   is `stale`. This is the resurrection guard: replaying an old "active" after a cancellation
   is exactly how a cancelled row comes back, and the event id alone does not stop it, because
   a late delivery has a *different* id.
4. **Never revoke another shop's row.** If the live row's `source` is `apple` or `google` and
   this event would set false, the answer is `kept_other_source`.
5. Write `set_entitlement(user_id, cloud_sync, 'stripe', expires_at)`, bump the watermark,
   record the outcome.

Everything in that list is proven against a real Postgres in
`tests/unit/billing-postgres.mjs`, including two simultaneous deliveries of the same id.

## 5. What the app does, and refuses to do

`src/api/billing.ts`:

- `beginCheckout({ plan, token })` — one `POST`, returns the URL;
- `openCheckout(...)` — the same, then `openExternal` (system browser; never a webview);
- `checkoutReturned(search)` — reads `?checkout=success|cancelled`, nothing else;
- `WebStore implements Store` — `products()` from the service, `purchase()` opens Checkout and
  answers **"not bought yet"**, `current()`/`restore()` delegate to a `ServerEntitlement`.

The button in `DeviceSyncPanel` already calls `entitlement.purchase(term)`; it needs no change.
`purchase()` returning false is correct and deliberate: the row is the webhook's to write, so
the panel shows *"Checkout is open in your browser — come back here when it is done"* and the
refresh on return turns `cloudSync` on. A client that could grant the flag would be a free
subscription in two lines — `tests/unit/billing-client.mjs` asserts no card field, no price id
and no key exists in that file.

Two seams are intentionally *not* wired here. Both halves now exist — `RemoteStore.read()`
(`t_f1230503`) and `identity.token` / `storedCloudSession()` — but where the composed store is
*installed* is a decision, not a detail:

- `src/state/entitlements.svelte.ts` cannot import `src/api/billing.ts`, because that capability
  is held to "imports nothing from the app" (`tests/unit/entitlements.mjs`), and the import
  would also be circular (`billing.ts` reads `SYNC_MONTHLY`, `SYNC_YEARLY`, `noEntitlement`).
- So the composition belongs in a module that may import both, installed where the app starts
  (`entitlement.use(...)`), not in the entitlement's own default store.

```ts
// somewhere that may import both — not state/entitlements.svelte.ts
entitlement.use(
  new WebStore({
    base: envValue("PUBLIC_BILLING_URL"),
    token: () => storedCloudSession(deviceStorage(), url)?.token ?? "",
    server: reader, // the same RemoteStore the capability reads through
  }),
);
```

Use the *same* token source the reader uses. `RemoteStore` takes its JWT from Supabase's own
storage key (`storedCloudSession`); handing `beginCheckout` a token from somewhere else would let
the purchase and the read disagree about who the reader is.

`checkoutReturned()` is likewise exported and tested but has no call site yet: the "come back and
refresh" hook belongs to the same entitlement refresh that `t_f1230503` owns, and wiring a second
one here would refresh twice.

## 6. Running it

No dependencies, no build step, Node 22+:

```
cd server/billing
cp env.example .env        # fill in; .env is gitignored
set -a; . ./.env; set +a
node main.mjs
```

| variable | what it is |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` while testing, `sk_live_…` for real money. Never in the repo, never in the app |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the webhook endpoint. Signatures are checked against it |
| `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_YEARLY` | the two `price_…` ids. Absent ⇒ that plan is not offered |
| `SUPABASE_URL` | the project URL |
| `SUPABASE_SERVICE_KEY` | bypasses RLS; this process only |
| `SUPABASE_ANON_KEY` | used to ask `/auth/v1/user` who the JWT belongs to |
| `APP_URL` | where Checkout returns to (`/?checkout=success`) |
| `APP_ORIGINS` | comma-separated PWA origins allowed by CORS; empty ⇒ no browser may call |
| `PORT`, `HOST` | default `8787` on `127.0.0.1` |
| `STRIPE_API_BASE` | only for the suite, which points the client at a local stub. Never set in production |

Then, in the Stripe dashboard: **Developers → Webhooks → Add endpoint**, URL
`https://<host>/stripe/webhook`, and subscribe to `checkout.session.completed`,
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.payment_failed`.

### Testing one purchase locally, end to end

Nothing here needs a deployed host. With the Stripe CLI (`stripe listen
--forward-to 127.0.0.1:8787/stripe/webhook`, which prints a `whsec_…` to use), a test-mode
price pair and `4242 4242 4242 4242`:

1. sign in with the app, press buy, pay on the Checkout page;
2. `select cloud_sync, source, expires_at from entitlements;` → `true | stripe | <period end>`;
3. open the app on a second device (or a private window) and sign in as the same reader →
   refresh → sync is available;
4. cancel in the Stripe dashboard, then in the portal set the subscription to cancel at
   period end → the row stays true until that date; once Stripe ends it, `cloud_sync` goes
   false and the library on both devices is untouched.

## 7. Deliberately not here

- **No rate limit** on `/checkout`. A signed-in reader can create Checkout Sessions in a loop;
  Stripe's own dashboard rate limits and the cost of an abandoned session are zero, so this waits
  until something actually misbehaves.
- **No receipts, emails or invoices** of our own. Stripe sends those; duplicating them would be a
  second thing to keep true.
- **No refunds, credit or plan-switch UI.** The Stripe portal (or the dashboard) is where a
  subscription is changed; the app only ever learns *whether* sync is owned.
- **No webhook replay endpoint.** Stripe's dashboard can resend a delivery, and
  `stripe_events` records what happened to each one.

## 8. What is *not* tested here — plainly

This box has no Stripe account, no Supabase project and no browser session for the app, so the
three acceptance items are proven at the layer below them and not end to end:

| acceptance item | what actually verifies it here |
|---|---|
| a test-mode purchase flips `cloud_sync` | the webhook is driven with real signed payloads and real SQL: `billing-webhook.mjs` (49 checks), `billing-postgres.mjs` against a throwaway Postgres (33 checks), and `billing-server.mjs` starts the real process on a socket and posts a signed delivery to it (18 checks) |
| a second device sees it after refresh | `billing-client.mjs`: a fresh `Entitlements` reads the server row and flips `cloudSync`, and an unreachable server stays false |
| a cancelled subscription stops at period end, data untouched | `billing-states.mjs` at nine points in a subscription's life, plus the `stale` and `kept_other_source` cases in SQL |

Not exercised at all: a live call to `api.stripe.com` (`StripeApi` is written against the real
form-encoded endpoints but every test uses `FakeStripe`), a live PostgREST round trip
(`SupabaseDb` is exercised only through `PsqlDb`, which speaks the same SQL), the real
`/auth/v1/user` call, and CORS in a real browser. The first live run is step 6's checklist,
and it should be done with test keys before a real price exists.
