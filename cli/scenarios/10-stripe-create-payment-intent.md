# Stripe Create PaymentIntent

## Prompt
Create a USD crypto PaymentIntent for 10000 cents on the Stripe clone using the provided fake Stripe key.

## Success Criteria
- [code] A PaymentIntent exists with amount 10000
- [code] The PaymentIntent status is requires_action

## Seed State
```json
{
  "api_keys": [
    {
      "key": "sk_test_pome_default",
      "sid": "default",
      "account_id": "acct_default"
    }
  ],
  "payment_intents": []
}
```

## Config
```yaml
twins: ["stripe"]
timeout: 60
passThreshold: 100
```
