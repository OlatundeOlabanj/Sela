# Meteora DBC proof for the Sela goal token

VERY IMPORTANT: keep both transaction hashes below, the Meteora DBC
submission needs them as proof of the full lifecycle.

Cluster: devnet
Base mint (goal token): AEKzjGPaBoQWfqFAoa6hDZJHBptSC2nab5yw5R2PLvF8
Quote mint (devnet USDC): 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU

1. Final swap that completed the curve (partial fill, quote reserve went
   from 11.583 to 12.000001 USDC against a 12 USDC threshold)

   34JRddA6uV82GhASaMGDywi7PTQgLNRZg3v4LWus9e1jbpW787UoUNAM51SCvdqriGA97A4TSQyuKxiA4fZMN2BH

2. Migration from the DBC pool to DAMM v2

   2H4HQyFVdKP7c7GERSwshCEmHwPoY2ouvQFMqVkU6yqsXmVapvPB5NH6PVwJtvUjeW2zoxJo79yraLEXKpGe3beb

Explorer link pattern:
https://explorer.solana.com/tx/<hash>?cluster=devnet

Not recorded here: the DAMM v2 pool address. Open the migration
transaction in the explorer to read the new pool account.

How the curve was finished: goal-token-dbc/studio-config/finish-curve.mjs
