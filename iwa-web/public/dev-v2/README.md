# `public/dev-v2/` — DEV-ONLY V2 declare-capability check artifacts

This directory is **git-ignored** (`iwa-web/.gitignore`). It is only used by the
local dev route `/dev/v2-deploy-capability` (rendered only when
`import.meta.env.DEV`).

To run the declare fee-estimate part of that check, place the built Sierra class
here:

```
cp ../../contracts/starknet/target/dev/iwa_IwaCircleV2.contract_class.json \
   iwa-web/public/dev-v2/iwa_IwaCircleV2.contract_class.json
```

Expected Sierra class hash: `0x07744b6a83f5f7b24ece1e42d9d4116077ee04f3899bfe4e48e93c0a0bb0015a`
Expected compiled (CASM) class hash: `0x022abd3af698ad7971f53d33c52bf9b0c6931f33a248bf1f6590f1fed02e1dc8`

Never commit this file. Never ship it in a production build.
