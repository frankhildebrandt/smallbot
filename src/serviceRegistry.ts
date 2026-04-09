import { ServiceRecord } from "./messages.js";

export class ServiceRegistry {
  readonly #services = new Map<string, ServiceRecord>();

  upsert(service: ServiceRecord): void {
    this.#services.set(service.name, service);
  }

  get(name: string): ServiceRecord | undefined {
    return this.#services.get(name);
  }

  list(): ServiceRecord[] {
    return Array.from(this.#services.values()).sort((left, right) => left.name.localeCompare(right.name));
  }

  find(kind: string, query?: string): ServiceRecord[] {
    return this.list().filter((service) => {
      if (service.kind !== kind) {
        return false;
      }

      if (!query) {
        return true;
      }

      if (service.state === query) {
        return true;
      }

      if (service.name.includes(query)) {
        return true;
      }

      return service.capabilities.some((capability) => capability.includes(query));
    });
  }
}
