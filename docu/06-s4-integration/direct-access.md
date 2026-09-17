# Direct S/4 access for local development

Normally every S/4 call goes through the BTP destination and the Cloud
Connector. For local development the transport layer
(`code/srv/srv/utils/s4-http-client.js`) can call a system directly when
two things are set:

| Variable | Meaning |
|---|---|
| `ADOPTOPS_S4_URL_OVERRIDES` | `DEST=url[,DEST=url]`: base URL used instead of the destination for that destination name, e.g. `S4H_2023=http://vhcala4hci:50000` |
| `ADOPTOPS_S4_DIRECT_USER` / `ADOPTOPS_S4_DIRECT_PASSWORD` | Basic credentials for the direct call |

The override applies only when both are present. On a connection-level
failure the override is parked for five minutes and the call falls back to
the connectivity proxy.

## TLS verification (safety default, roadmap A7)

Direct `https://` calls verify the server certificate. That is the default
and needs no setting. A lab appliance with a self-signed certificate opts
out explicitly:

```bash
ADOPTOPS_S4_DIRECT_INSECURE_TLS=on
```

Accepted values are `on`, `true`, `yes` and `1`; anything else keeps
verification on. The server logs one warning per process when the opt-out
is active, so it cannot go unnoticed in a deployed instance. Plain `http://`
overrides are unaffected.

Before A7 the flag defaulted to `on`, which meant every direct HTTPS call
skipped certificate checks unless someone remembered to switch it off. The
local scripts in `code/package.json` use a plain-http override for the A4H
lab box and are not affected by the change.

## Not for Cloud Foundry

The override and the credentials are development conveniences. A deployed
instance routes through destinations in the subscriber subaccount
(`.claude/rules/sap-backend.md`) and must not carry any of these variables.
