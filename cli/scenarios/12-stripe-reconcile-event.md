# Stripe Reconcile Event

## Prompt
Create and settle a crypto PaymentIntent, then inspect the emitted Stripe events and balance transaction.

## Success Criteria
- [code] payment_intent.succeeded is emitted
- [code] A charge and balance transaction are created for the PaymentIntent

## Seed State
```json
{
  "api_keys": [
    {
      "key": "sk_test_pome_default",
      "sid": "default",
      "account_id": "acct_default"
    }
  ]
}
```

## Config
```yaml
twins: ["stripe"]
timeout: 60
passThreshold: 100
```
