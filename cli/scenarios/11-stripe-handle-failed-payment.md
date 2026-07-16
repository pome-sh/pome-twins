# Stripe Handle Failed Payment

## Prompt
Attempt to create a crypto PaymentIntent with invalid payment parameters, handle the Stripe-shaped error, then create a valid PaymentIntent.

## Success Criteria
- [code] The invalid request returns a Stripe invalid_request_error
- [code] A valid PaymentIntent is created after the failure

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
