# Module

## Layout

Jedes Modul liegt unter `module/<name>` und besitzt:

- eigene `package.json`
- eigenes `node_modules`
- eigenen TypeScript-Build
- eigenen Runtime-Einstiegspunkt

Die Root-Konfiguration verweist Module ueber `settings.yml` mit:

- `module: "<name>"` fuer `module/<name>/dist/index.js`
- `name` als Service-Name
- `kind` fuer Discovery und `SERVICE_KIND`
- `permissions.networking`
- optional `environment`

## Startparameter

Die Root-Anwendung uebergibt Startparameter ueber Environment-Variablen:

- `SERVICE_NAME`
- `SERVICE_KIND`
- `MANAGER_SOCKET_PATH`
- `LISTEN_SOCKET_PATH`
- `DATA_PATH`

Zusaetzlich werden Eintraege aus `services[].environment` unveraendert an den Modulprozess weitergegeben.

## Kommunikations-Framework

`packages/framework` exportiert:

- Message-Typen
- Routing-Helfer
- `ModuleRuntime`
- Unix-Socket-Sendehilfen

Damit koennen Module:

1. ihren Service registrieren,
2. Status aendern,
3. Nachrichten empfangen,
4. Antworten an andere Services senden.

## Beispielmodul `ai-free`

Das Beispielmodul registriert sich als `ai`-Service und beantwortet `tool`-Nachrichten mit einer einfachen JSON-Antwort. Es dient als Vorlage fuer weitere Module wie RAG, Normalisierung oder Orchestrierung.
