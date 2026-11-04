# Relayer API

HTTP + JSON, served by `services/relayer` (default port `8787`, `RELAYER_PORT`). CORS is open
(`access-control-allow-origin: *`). All amounts are decimal strings in 18-decimal wei-units
(tPOT, pPOT, tBNB and BNB.b alike); block numbers are decimal strings unless noted; timestamps
are ISO 8601 UTC. Errors are `{ "error": string, ...extra }` with a 4xx/5xx status.

Chains are named `"portaldot"` (Portaldot V3 testnet, EVM chain id 420420777) and `"bsc"` (BNB
Chain testnet, chain id 97). Explorer links point to testnet.bscscan.com for BSC and to the
block in polkadot.js apps for Portaldot (the Portaldot testnet has no EVM explorer).

## `GET /status`

Both light clients, the job counters and every address. Cached for 5 s.

```json
{
  "at": "2026-11-04T10:00:00.000Z",
  "portaldotToBsc": {
    "client": "0x… PortaldotLightClient on BSC",
    "setId": "503",
    "latestBlock": 298990,
    "beefyHead": 299001,
    "finalized": 299004,
    "lagBlocks": 14,
    "archived": 1312,
    "halted": null,
    "lastError": null,
    "lastTx": { "kind": "commitment", "tx": "0x…", "block": 298990, "setId": "503", "link": "https://testnet.bscscan.com/tx/0x…" }
  },
  "bscToPortaldot": {
    "client": "0x… ParliaClient on Portaldot",
    "trustedEpoch": "140468000",
    "activeFrom": "140468040",
    "validators": ["0x…", "… 9 addresses"],
    "epochTimestamp": "1793661415",
    "installedAt": "1793661520",
    "trustingPeriodSec": "1209600",
    "trustRemainingSec": "1165000",
    "trustAlert": null,
    "bscHead": "140470123",
    "liveOverlap": 8,
    "lastWindow": { "block": "140470002", "tx": "0x…", "headers": 49 },
    "lagBlocks": "121",
    "lastError": null
  },
  "jobs": {
    "transfers": { "locked": 0, "proven": 0, "finalized": 4, "failed": 0 },
    "orders": { "open": 1, "filled": 0, "settled": 2, "refunded": 1 }
  },
  "relayer": { "address": "0x…", "balances": { "portaldot": "812.5", "bsc": "0.091" } },
  "solver": { "address": "0x…", "limits": { "maxOutput": { "tPOT": "…", "tBNB": "…", "pPOT": "…", "BNB.b": "…" }, "minFeeBps": 20, "minDeadlineLeft": 120, "prefund": "500000000000000000" } },
  "demo": {
    "address": "0x…",
    "limits": {
      "perRequest": { "tPOT": "2000000000000000000", "tBNB": "2000000000000000", "pPOT": "…", "BNB.b": "…" },
      "perDay": { "tPOT": "40000000000000000000", "tBNB": "40000000000000000", "pPOT": "…", "BNB.b": "…" },
      "perIpPerHour": 3
    },
    "usedToday": { "tPOT": "3000000000000000000" }
  },
  "addresses": {
    "portaldot": { "Outbox": "0x…", "ParliaClient": "0x…", "BscVerifier": "0x…", "PortaldotGateway": "0x…", "OriginSettler": "0x…", "DestinationSettler": "0x…", "PotVault": "0x…", "BnbbVault": "0x…", "PotForwarder": "0x…", "BnbbForwarder": "0x…", "bnbb": "0x… BNB.b ERC-20 precompile", "bnbbAssetId": 9797 },
    "bsc": { "Outbox": "0x…", "PortaldotLightClient": "0x…", "PortaldotVerifier": "0x…", "PPOT": "0x…", "BscGateway": "0x…", "OriginSettler": "0x…", "DestinationSettler": "0x…", "PpotVault": "0x…", "BnbVault": "0x…", "PpotForwarder": "0x…", "BnbForwarder": "0x…" }
  }
}
```

- `portaldotToBsc` describes the BEEFY light client of Portaldot that lives on BSC. `latestBlock`
  is the newest BEEFY commitment it accepted; `lagBlocks = finalized - latestBlock`. `halted` is
  set (and stays set) if a whole session was missed and the client can no longer rotate.
  `lastTx.kind` is `commitment`, `header` or `rotate`. If the client cannot be read the object is
  `{ "client": "0x…", "error": "…" }`.
- `bscToPortaldot` describes the Parlia light client of BSC that lives on Portaldot. Until it
  is deployed (deploy phase B) it is `{ "deployed": false }` and only Portaldot → BSC is relayed.
  `trustRemainingSec` is how long windows above the trusted set still verify: the client trusts a
  set for `trustingPeriodSec` (14 days) from the earlier of its epoch block (`epochTimestamp`, BSC
  time) and the moment the client installed it (`installedAt`, Portaldot time), and accepts no
  window at all once that runs out. The relayer refreshes the trusted epoch every 3 days
  (`PARLIA_REFRESH_AFTER_SEC`); `trustAlert` is a message while less than 5 days remain
  (`PARLIA_TRUST_ALERT_SEC`), `null` otherwise. `liveOverlap` is how many validators of BSC's current set the client trusts (an epoch
  is submitted when it drops below 7 of 9). `lastWindow` / `lagBlocks` are `null` before the
  first window.
- `jobs` counts by state; see the job states below. `solver` and `demo` are `null` when off.

## `GET /transfers?limit=20&type=transfer|order`

Newest first, at most 100.

```json
{ "items": [ Job, … ] }
```

## `GET /transfers/:id`

`:id` is a transfer id (`portaldot:7`, `bsc:3`; URL-encode the colon as `%3A` or not), an
order id (`0x` + 64 hex), or the hash of the source transaction (the lock/burn, or the order's
`open`). `404 { "error": … }` if it is not indexed yet (the relayer picks events up from
finalized Portaldot blocks and from BSC blocks 15 deep, so give it ~15 s).

### Job: transfer (canonical bridge)

```json
{
  "id": "portaldot:7",
  "type": "transfer",
  "state": "locked | proven | finalized | failed",
  "from": "portaldot",
  "to": "bsc",
  "nonce": "7",
  "kind": 1,
  "kindName": "POT_TO_BSC | PPOT_TO_PORTALDOT | BNB_TO_PORTALDOT | BNBB_TO_BSC",
  "recipient": "0x…",
  "amount": "999000000000000000",
  "sourceTx": "0x…",
  "createdAt": "…",
  "updatedAt": "…",
  "error": null,
  "steps": [
    { "name": "locked", "at": "…", "chain": "portaldot", "tx": "0x…", "block": "299120", "link": "https://polkadot.js.org/apps/?rpc=…#/explorer/query/299120", "detail": null },
    { "name": "beefy", "at": "…", "chain": "bsc", "tx": "0x…", "block": null, "link": "https://testnet.bscscan.com/tx/0x…", "detail": "Portaldot header 299131 proven on BSC" },
    { "name": "finalized", "at": "…", "chain": "bsc", "tx": "0x…", "block": "47120345", "link": "https://testnet.bscscan.com/tx/0x…", "detail": null }
  ]
}
```

Step names: `locked` → (`beefy` for Portaldot → BSC, `parlia` for BSC → Portaldot: the
light-client transaction that made the source block provable, absent if another job already
did it) → `finalized`, then `vault repaid` when the recipient is an ERC-20 LP vault. `failed`
carries the last error in `detail` and `error`. `amount` for POT_TO_BSC is net of the 0.1%
bridge fee.

### Job: order (ERC-7683 fast path)

```json
{
  "id": "0x… orderId",
  "type": "order",
  "state": "open | filled | settled | refunded | failed",
  "from": "portaldot",
  "to": "bsc",
  "orderId": "0x…",
  "user": "0x…",
  "inputToken": "0x0000000000000000000000000000000000000000",
  "inputAmount": "10000000000000000000",
  "outputToken": "0x… pPOT",
  "outputAmount": "9960000000000000000",
  "recipient": "0x…",
  "fillDeadline": 1793700000,
  "fill": { "tx": "0x…", "block": "47120001", "filler": "0x…", "repayTo": "0x…" },
  "sourceTx": "0x… open tx",
  "createdAt": "…", "updatedAt": "…", "error": null,
  "steps": [ { "name": "opened", … }, { "name": "solver fill sent", … }, { "name": "filled", … }, { "name": "parlia", … }, { "name": "settled", … } ]
}
```

Step names: `opened`, `solver fill sent` / `solver passed` (detail = why), `vault fill` /
`vault passed`, `beefy` / `parlia`, `filled`, `settled` (escrow paid to `repayTo`),
`repayment bridged` (a vault's repayment sent home over the canonical bridge), `refunded`.
`fill` is `null` until filled. `fillDeadline` is unix seconds (a number).

## `GET /attacks`

The attack lab: each entry takes real proof material (an accepted commitment, header, window,
receipt or storage proof) and tampers with exactly one thing.

```json
{
  "total": 12,
  "ready": 10,
  "items": [
    {
      "id": "beefy-forged-signature",
      "title": "Forged BEEFY signature",
      "chain": "bsc",
      "description": "A real commitment of the current validator set, moved to the next block number so it is new, with one byte of the first signature changed.",
      "target": "PortaldotLightClient.submitCommitment",
      "address": "0x… the attacked contract",
      "expects": ["InvalidSignature"],
      "ready": true
    },
    { "id": "replayed-nonce", "…": "…", "ready": false, "missing": ["transferToBsc"] }
  ]
}
```

`ready` is false until the real material the attack starts from exists (e.g. a finalized
transfer); `missing` names it.

Attack ids: `beefy-forged-signature`, `beefy-stale-set`, `mmr-wrong-leaf`,
`header-not-in-mmr`, `tampered-storage-proof`, `replayed-nonce`, `parlia-forged-header`,
`parlia-too-few-sealers`, `receipt-not-included`, `settle-unfilled-order`,
`refund-filled-order`, `bnbb-beyond-locked`.

## `POST /attacks/:id`

No body. Runs the attack as an `eth_call` against the live contract (nothing is sent, nothing is
spent) and returns:

```json
{
  "id": "beefy-forged-signature",
  "title": "Forged BEEFY signature",
  "chain": "bsc",
  "target": "PortaldotLightClient.submitCommitment",
  "call": { "to": "0x…", "data": "0x…" },
  "reverted": true,
  "reason": "InvalidSignature(0)",
  "defended": true,
  "ms": 412
}
```

`reason` is the decoded custom error (with arguments), or `"false"` when a view verifier
returned false instead of reverting. `defended` is true when the reason is one of `expects`.
`404` for an unknown id, `409 { "error", "missing": [...] }` when not ready.

## `POST /demo/transfer`

Starts a canonical transfer from the server's demo key, so a visitor without a wallet can watch
one cross. Body:

```json
{ "route": "pot-to-bsc", "amount": "1.5", "recipient": "0x…" }
```

- `route`: `pot-to-bsc` (lock tPOT on Portaldot, pPOT minted on BSC), `bnb-to-portaldot` (lock
  tBNB on BSC, BNB.b released on Portaldot, with a 0.5 tPOT gas drop to a fresh account),
  `ppot-to-portaldot` (burn pPOT), `bnbb-to-bsc` (return BNB.b). The last two need the demo key
  to hold pPOT / BNB.b.
- `amount`: decimal string in whole units of the asset sent (tPOT amounts at most 14 decimals).
- `recipient`: the address that receives on the other chain.

Limits (defaults, configurable): at most 2 tPOT / 2 pPOT / 0.002 tBNB / 0.002 BNB.b per request,
40 tPOT / 0.04 tBNB per UTC day across all visitors, 3 requests per client IP per hour.

`202`:

```json
{
  "id": "portaldot:8",
  "route": "pot-to-bsc",
  "amount": "1500000000000000000",
  "recipient": "0x…",
  "tx": "0x…",
  "link": "https://polkadot.js.org/apps/?rpc=…#/explorer/query/299200",
  "statusUrl": "/transfers/portaldot%3A8"
}
```

Poll `statusUrl` for the timeline. Errors: `400` (bad route, address or amount, or above the
per-request cap: `{ "error", "cap" }`), `429` (daily budget or IP limit: `{ "error",
"retryAfterSec" }`), `503` (no demo key configured).
