# What to set up in Supabase

A checklist for the owner. Nothing here is secret except the two keys marked *never in the repo*.
Until this exists, the identity and entitlement cards can only build their seams.

The whole backend is one table (`supabase/schema.sql`) and one boolean.

## 1. Create the project

1. <https://supabase.com/dashboard> → **New project**.
2. Organisation: the personal one. Name: `hardlyreader`. Region: whatever is closest to you
   (Vancouver → `us-west-1`/`ca-central-1`).
3. Database password: generate and put it in your password manager. It is never needed by the app.
4. Wait for provisioning (~2 min).

## 2. Collect the two public values

**Project Settings → API**:

| value | goes where | secret? |
|---|---|---|
| Project URL (`https://<ref>.supabase.co`) | `.env` → `PUBLIC_SUPABASE_URL` | no |
| `anon` `public` key | `.env` → `PUBLIC_SUPABASE_ANON_KEY` | no — it is publishable, RLS is what protects data |
| `service_role` key | **only** in the webhook's environment later | **yes — never in the repo, never in the app, never in chat** |

`.env.example` in the repo lists the two public names. `.env` itself is gitignored.

## 3. Apply the schema

1. **SQL Editor → New query** → paste the whole of `supabase/schema.sql` → **Run**.
2. Confirm in **Table Editor**: `entitlements` exists and shows *RLS enabled*.
3. Confirm the rules took, because this is the part that protects revenue:
   - **Authentication → Policies** shows one policy on `entitlements`: `read own entitlement`,
     command `SELECT`.
   - There is **no** INSERT, UPDATE or DELETE policy. That is deliberate — with RLS on, a client
     cannot write the row at all, even by hand-crafting a request.
   - `select proname, proacl from pg_proc where proname = 'set_entitlement';` → `EXECUTE` only for
     `service_role`, not for `anon` or `authenticated`.

## 4. Providers — only what sync needs

**Authentication → Providers**:

- **Email**: already on. Choose the flow you want:
  - *magic link / OTP* — no password to invent, one tap from an email. Easiest for a $10/year
    purchase, and recommended.
  - *email + password* — needs **Confirm email** decided; leaving it on means a reader must click
    before the session works.
- **Google** (do this now; it is the one that makes iPhone ↔ Linux tidy):
  1. Google Cloud Console → new project → **APIs & Services → OAuth consent screen** (External,
     add your own address as a test user).
  2. **Credentials → Create credentials → OAuth client ID → Web application**.
  3. Authorized redirect URI: `https://<ref>.supabase.co/auth/v1/callback`.
  4. Paste the Client ID and secret into Supabase → Authentication → Providers → **Google** → Enable.
- **Apple** (can wait, and needs the paid Apple Developer programme):
  1. Apple Developer → **Identifiers** → new **Services ID** (e.g. `ing.hardlysleep.hardlyreader.web`),
     enable *Sign in with Apple*, Return URL `https://<ref>.supabase.co/auth/v1/callback`.
  2. **Keys** → new key with *Sign in with Apple* enabled → download the `.p8` once.
  3. Supabase → Providers → **Apple**: Services ID, Team ID, Key ID, private key.

## 5. Where the app is allowed to come back to

**Authentication → URL Configuration**:

- **Site URL**: `https://bazzite-1.tail900410.ts.net:8457` for now (the PWA). Change it when there
  is a real domain.
- **Redirect URLs** (one per line):
  - `https://bazzite-1.tail900410.ts.net:8457/**`
  - `http://localhost:4179/**` (local dev)
  - a deferred entry for the native deep link once the app has one, e.g. `hardlyreader://auth`

Sessions: **Authentication → Sessions** — JWT expiry 3600s (default) and refresh-token rotation on
is the right default; the app refreshes on launch and resume.

## 6. Payments — the part after auth works

1. Stripe → **Products** → one product `HardlyReader Sync`, two prices:
   `$0.99 / month` and `$9.99 / year`, both recurring.
2. Record the two price IDs (`price_…`); the app never hardcodes them — the checkout endpoint reads
   them from the server.
3. Checkout is created **server-side** with `client_reference_id = <supabase user id>`, so the
   webhook can attribute the payment without trusting the browser.
4. Webhook endpoint: a Supabase **Edge Function** (or any small host) holding the
   `service_role` key; subscribe to `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.
   It calls `set_entitlement(...)`. Idempotent on the Stripe event id.

## 7. What to hand back

Tell me, and only these:

- the **project URL** and **anon key** (public, fine to paste or, better, put straight into `.env`);
- that the schema ran and the three RLS checks above pass;
- which providers are enabled;
- the two Stripe **price IDs**, once Stripe exists.

Never: the `service_role` key, the database password, or any Stripe secret key.

## 8. What the app does with it, so the setup matches the intent

Nobody signs in until they ask for sync:

```
Settings → Device sync           (free, no account, says what syncing is for)
   [Start HardlyReader Sync]
        ↓
sign in  (Google / Apple / email — the moment an account exists at all)
        ↓
pay      (web checkout, one price, all four providers)
        ↓
back in the app → entitlement refreshed → provider picker enabled
```

A reader using FreshRSS never reaches any of it: no account, no prompt, and no entitlement call on
that path — verified by grep, `cloudSync` appears nowhere in `src/state/reader.svelte.ts` or
`src/api/`.
