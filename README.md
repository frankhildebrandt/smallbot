# SmallBot

SmallBot ist ein leichtgewichtiges TypeScript-Basisprojekt fuer einen JSON-basierten Message Broker mit Service Discovery und einem Subprozess-Manager fuer isolierte Module.

## Schnellstart

```bash
npm install
npm run start
```

Der Start-Workflow kompiliert zuerst alle TypeScript-Pakete mit `tsc` und startet danach den Broker. Standardmaessig wird ein Beispielmodul `ai:1` geladen.

## Kernideen

- kompakte JSON-Nachrichten mit den Feldern `s`, `t`, `m`, `c`, `i`
- optionales Routing ueber `v` und `n`
- Service Discovery ueber `d` und `q`
- Subprozess-Manager mit Bubblewrap-Sandbox im Devcontainer
- wiederverwendbares Kommunikations-Framework unter `packages/framework`
- Module als eigenstaendige TypeScript-Pakete unter `module/<name>`

## Struktur

| Pfad | Inhalt |
| --- | --- |
| `src/` | Broker, Discovery, Prozess-Manager und App-Start |
| `packages/framework/` | NPM-Framework fuer Modul-Kommunikation |
| `module/ai-free/` | Beispielmodul fuer freie AI-Inference |
| `docs/` | Architektur-, Protokoll- und Betriebsdokumentation |
| `.devcontainer/` | Devcontainer-Setup mit Node.js und Bubblewrap |

## Konfiguration

Die Anwendung wird ueber Umgebungsvariablen gesteuert:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `SMALLBOT_RUNTIME_DIR` | `.runtime` | Laufzeitdaten, Sockets und persistente Modul-Daten |
| `SMALLBOT_SOCKET_DIR` | system temp dir | Kurzer Unix-Socket-Pfad fuer Broker und Module |
| `SMALLBOT_SANDBOX_MODE` | `auto` | `auto`, `bwrap` oder `process` |
| `SMALLBOT_DISABLE_MODULES` | `0` | Beispielmodule beim Start ueberspringen |
| `SMALLBOT_AI_MODULE_PATH` | `module/ai-free/dist/index.js` | Einstiegspunkt des Beispielmoduls |
| `SMALLBOT_DEFAULT_AI_NAME` | `ai:1` | Service-Name des Beispielmoduls |

## Dokumentation

- `docs/architecture.md`
- `docs/protocol.md`
- `docs/modules.md`
