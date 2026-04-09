# Architektur

## Komponenten

1. **Broker**: nimmt JSON-Nachrichten ueber ein Unix-Socket entgegen, registriert Services, beantwortet Discovery-Anfragen und leitet Nachrichten weiter.
2. **Service Registry**: haelt Name, Typ, Status, Faehigkeiten und Ziel-Socket jedes Services.
3. **Subprocess Manager**: startet Module, verwaltet deren Laufzeit-Verzeichnisse und bindet sie an den Broker an.
4. **Framework**: liefert Modulen einen minimalen Client fuer Registrierungen, Senden, Empfangen und Routing-Helfer.
5. **Module**: eigenstaendige TypeScript-Prozesse mit eigener `package.json`, eigenem `node_modules` und persistentem Datenpfad.

## Datenfluss

1. Der Root-Prozess startet den Broker.
2. Der Subprozess-Manager legt Laufzeitverzeichnisse und Socket-Pfade an.
3. Jedes Modul startet mit:
   - `SERVICE_NAME`
   - `SERVICE_KIND`
   - `MANAGER_SOCKET_PATH`
   - `LISTEN_SOCKET_PATH`
   - `DATA_PATH`
4. Das Modul oeffnet sein Eingangs-Socket und sendet danach eine `register`-Nachricht an den Broker.
5. Der Broker speichert den Service und leitet spaetere Nachrichten anhand von `n` oder `t` weiter.

## Sandbox-Modell

- Im Devcontainer laeuft `bubblewrap` standardmaessig im Modus `auto`.
- Der Modul-Code wird read-only nach `/app` eingebunden.
- Persistente Daten werden read-write eingebunden und im Sandbox-Dateisystem als Symlink unter `/data/persistent` bereitgestellt.
- Die Socket-Pfade fuer Broker und Module werden gezielt in den Sandbox-Namespace eingebunden.

## Laufzeitstruktur

Zur Laufzeit entstehen:

- `broker.sock` und `<service>.sock` in einem kurzen Socket-Verzeichnis unter dem System-Temp-Pfad
- `data/<service>/` unter `.runtime/` fuer persistente Modul-Daten
