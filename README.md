# SmallBot

SmallBot ist ein leichtgewichtiges TypeScript-Basisprojekt fuer einen JSON-basierten Message Broker mit Service Discovery und einem Subprozess-Manager fuer isolierte Module.

## Schnellstart

```bash
npm install
npm run start
```

Der Start-Workflow kompiliert zuerst alle TypeScript-Pakete mit `tsc` und startet danach den Broker. Die Datei `settings.yml` im Projekt-Root ist verpflichtend und definiert die zu startenden Services.
Nach dem Start oeffnet der Host eine einfache TUI auf `stdin`/`stdout`. Der erste eingebaute Befehl ist `/quit`; alternativ beendet auch `2x ESC` den Host. Beide Wege stoppen alle verwalteten Modulprozesse und beenden danach die App.

## Kernideen

- kompakte JSON-Nachrichten mit den Feldern `s`, `t`, `m`, `c`, `i`
- optionales Routing ueber `v` und `n`
- Service Discovery ueber `d` und `q`
- Subprozess-Manager mit Bubblewrap-Sandbox im Devcontainer
- wiederverwendbares Kommunikations-Framework unter `packages/framework`
- Module als eigenstaendige TypeScript-Pakete unter `module/<name>`
- Websuche als deduplizierender Multi-Source-Service ueber freie HTTP-Endpunkte

## Struktur

| Pfad | Inhalt |
| --- | --- |
| `src/` | Broker, Discovery, Prozess-Manager und App-Start |
| `packages/framework/` | NPM-Framework fuer Modul-Kommunikation |
| `module/ai-free/` | Beispielmodul fuer freie AI-Inference |
| `module/web-search/` | Websuchmodul mit freier Multi-Source-Aggregation und URL-Dedupe |
| `docs/` | Architektur-, Protokoll- und Betriebsdokumentation |
| `.devcontainer/` | Devcontainer-Setup mit Node.js und Bubblewrap |

## Konfiguration

Die Anwendung wird ueber `settings.yml` im Projekt-Root konfiguriert:

```yaml
runtimeDir: ".runtime"
socketDir: "/tmp/smallbot"
sandboxMode: "auto"

services:
  - name: "ai:1"
    kind: "ai"
    module: "ai-free"
    permissions:
      networking: true
    environment:
      PROVIDER: "openai"
      OPEN_AI_KEY: "replace-me"
  - name: "search:1"
    kind: "search"
    module: "web-search"
    permissions:
      networking: true
    environment:
      SEARCH_SEARXNG_BASE_URL: "https://searx.example.com"
```

Wichtige Regeln:

- `settings.yml` ist verpflichtend; ohne Datei startet SmallBot nicht.
- `services[].module` wird immer als `module/<name>/dist/index.js` aufgeloest.
- `services[].kind` ist Pflicht und steuert Discovery sowie `SERVICE_KIND`.
- `services[].environment` reicht beliebige String-Werte an das Modul weiter.
- `WORKER_MESSAGE_BUS_TIMEOUT_MS` kann fuer das `task-worker`-Modul den Request/Response-Timeout auf dem MessageBus ueberschreiben. Standard sind `30000` ms.
- `task-worker`-AI-Tools lassen sich pro Tool ueber `services[].environment` schalten, zum Beispiel mit `WORKER_TOOL_WEB_SEARCH_ENABLED: "false"` oder `WORKER_TOOL_EXECUTE_TYPESCRIPT_ENABLED: "false"`. Standard ist jeweils aktiviert.
- `SEARCH_SEARXNG_BASE_URL` aktiviert optional einen zusaetzlichen SearXNG-JSON-Provider fuer das `web-search`-Modul.
- Das `ai-free`-Modul unterstuetzt `PROVIDER=openai`, `PROVIDER=azureai` und `PROVIDER=openrouter`.
- `azureai` erwartet `AZUREAI_API_KEY` oder `AZURE_AI_API_KEY`, `AZUREAI_MODEL` oder `AZURE_AI_MODEL` sowie `AZUREAI_BASE_URL` oder `AZURE_AI_BASE_URL`.
- `openrouter` erwartet `OPENROUTER_API_KEY` und `OPENROUTER_MODEL`; optional koennen `OPENROUTER_BASE_URL`, `OPENROUTER_SITE_URL` und `OPENROUTER_APP_NAME` gesetzt werden.
- `services[].permissions.networking` wird hart durchgesetzt. Wenn die Policy auf der aktuellen Plattform nicht sicher umsetzbar ist, bricht der Start ab.

Die bisherigen globalen Env-Variablen `SMALLBOT_RUNTIME_DIR`, `SMALLBOT_SOCKET_DIR` und `SMALLBOT_SANDBOX_MODE` bleiben als Fallback fuer die gleichnamigen Top-Level-Werte erhalten, aber der offizielle Konfigurationspfad ist `settings.yml`.

## Dokumentation

- `docs/architecture.md`
- `docs/protocol.md`
- `docs/modules.md`
