# PizzaHub Server

Express + MongoDB API for the PizzaHub pizza ordering platform.

- **Live API:** https://pizzahub-server-sigma.vercel.app
- **Live site:** https://pizzahub-client-sooty.vercel.app
- **Client repository:** https://github.com/HelloRudra/Pizzahub_client
- **Server repository:** https://github.com/HelloRudra/Pizzahub_server

## Features

- JWT verification middleware (JWKS) and role-based middleware for admin, vendor and customer
- Menu items API with search, category and location filters, price sorting and pagination
- Free plan limit of 3 active items; unlimited for Premium vendors
- Orders API with duplicate prevention, vendor accept/reject (once) and customer cancel
- Admin API for statistics, blocking users and read-only transactions
- Stripe Checkout sessions and a signature-verified webhook that activates Premium
- Resource ownership checks, input validation, and 401/403 responses

## Technology Stack

express, cors, dotenv, mongodb, jose, stripe

## Installation

```bash
git clone https://github.com/HelloRudra/Pizzahub_server.git
cd Pizzahub_server
npm install
npm run dev
```

The API runs on http://localhost:5000.

## Environment Variables

Create a `.env` file with these names (never commit real values):

```
PORT=
MONGODB_URI=
DB_NAME=
CLIENT_URL=
AUTH_URL=
STRIPE_SECRET_KEY=
STRIPE_PRICE_ID=
STRIPE_WEBHOOK_SECRET=
```

`AUTH_URL` must equal the client URL, because tokens are verified against its public keys.

## API Overview

| Route | Access |
|---|---|
| `GET /api/menu-items`, `/featured`, `/:id` | Public |
| `POST/PATCH/DELETE /api/menu-items...` | Vendor (own items) |
| `GET/PATCH/DELETE /api/menu-items/admin...` | Admin |
| `POST /api/orders` | Customer |
| `PATCH /api/orders/:id/status` | Vendor (own orders) |
| `PATCH /api/orders/:id/cancel` | Customer (own orders) |
| `GET /api/admin/...` | Admin |
| `POST /api/payments/checkout` | Vendor |
| `POST /api/stripe/webhook` | Stripe only (signature verified) |

## Payment Security

- The checkout session uses the vendor id from the verified token, never from the request body.
- Premium is activated only after the Stripe webhook signature is verified. The success page redirect does nothing.
- Transactions are inserted once per Stripe session (upsert), so retried webhooks create no duplicates.
- There are no routes to edit or delete transactions.