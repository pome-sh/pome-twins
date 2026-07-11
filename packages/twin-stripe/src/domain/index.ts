// SPDX-License-Identifier: Apache-2.0
//
// Domain barrel (F-684): re-exports only, per the repo barrel policy
// (scripts/lint-code-health.mjs). The StripeDomain coordinator lives in
// ./stripe-domain.ts; per-table domain modules sit alongside it.
export { StripeDomain } from "./stripe-domain.js";
export { PaymentIntentsDomain, piUnexpectedState } from "./payment-intents.js";
export type { CreatePIInput, ListPIsInput } from "./payment-intents.js";
export { ChargesDomain } from "./charges.js";
export type { ListChargesInput } from "./charges.js";
export { BalanceDomain } from "./balance.js";
export type { ListBalanceTxInput } from "./balance.js";
export { EventsDomain } from "./events.js";
export type { ListEventsInput } from "./events.js";
export { RefundsDomain } from "./refunds.js";
export type { CreateRefundInput, ListRefundsInput } from "./refunds.js";
export { CustomersDomain } from "./customers.js";
export type { CustomerFieldsInput, ListCustomersInput } from "./customers.js";
export { PaymentMethodsDomain } from "./payment-methods.js";
export type {
  CreatePaymentMethodInput,
  ListCustomerPaymentMethodsInput,
} from "./payment-methods.js";
export { BillingDomain } from "./billing.js";
export type {
  CreatePriceInput,
  CreateSubscriptionInput,
  ListBillingInput,
  ProductFieldsInput,
  UpdateSubscriptionInput,
} from "./billing.js";
export { ensureStripeTables, resetStripeTables } from "./schema.js";
