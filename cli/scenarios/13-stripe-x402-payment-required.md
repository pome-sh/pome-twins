# Stripe x402 Payment Required

## Prompt
Request the Stripe clone x402 protected resource, inspect the 402 challenge, construct an X-PAYMENT response for the advertised `payTo` address and amount, and retry until the resource unlocks.

## Success Criteria
- [code] The first request returns 402 Payment Required
- [code] The retry includes X-PAYMENT and returns 200
- [code] A backing PaymentIntent reaches succeeded

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
