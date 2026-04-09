# Protokoll

## Basisnachricht

```json
{"s":"agt:1","t":"ai:1","m":"welche informationen liegen vor","c":"tool","i":"{uuid}"}
```

| Feld | Bedeutung |
| --- | --- |
| `s` | Source |
| `t` | Finales Target |
| `m` | Nachricht oder Payload |
| `c` | Command |
| `i` | UUID |

## Nachricht mit Routing

```json
{"s":"agt:1","v":"rag:1:enrich,rag:4:enrich,comp:1:normalize","n":"rag:4","t":"ai:1","m":"welche informationen liegen vor","c":"tool","i":"{uuid}"}
```

| Feld | Bedeutung |
| --- | --- |
| `v` | Komma-separierte Routing-Kette `target:command` |
| `n` | Naechstes Ziel innerhalb der Routing-Kette |

Das Framework enthaelt Helfer zum Parsen von `v` und zum Fortschalten von `n`.

## Discovery

```json
{"s":"agt:1","d":"ai","q":"free","i":"{uuid}"}
```

| Feld | Bedeutung |
| --- | --- |
| `d` | Gesuchter Service-Typ |
| `q` | Query, z. B. Status oder Capability |

Der Broker antwortet mit:

```json
{"s":"broker:1","t":"agt:1","c":"discovery:result","m":{"services":[{"name":"ai:1","kind":"ai","state":"free"}]},"i":"{uuid}"}
```

## Broker-interne Commands

- `register`: Service meldet sich mit `kind`, `listenSocketPath`, `state`, `capabilities`
- `state`: Service aktualisiert seinen Status
- `tool`: Fachnachricht zwischen Diensten
- `result`: Antwort eines Services
- `error`: Fehlerantwort des Brokers
