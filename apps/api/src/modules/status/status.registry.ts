import { Injectable } from "@nestjs/common";
import type { StatusMachine } from "./status.types";

// Holds one machine per key. The state vocabulary is central (shared); transition
// EDGES are contributed by the owning stage — Stage 4+ call `contribute(...)` to
// append forward/reopen edges without touching Stage 3.
@Injectable()
export class StatusRegistry {
  private readonly machines = new Map<string, StatusMachine>();

  register(machine: StatusMachine): void {
    // Store an isolated copy so later `contribute(...)` calls (the extension seam) append to
    // the registry's own transitions array, never the module-level source singleton (e.g.
    // `legTransitions`) — which onModuleInit re-registers on every AppModule boot.
    this.machines.set(machine.key, { ...machine, transitions: [...machine.transitions] });
  }

  contribute(key: string, transitions: StatusMachine["transitions"]): void {
    this.get(key).transitions.push(...transitions);
  }

  get(key: string): StatusMachine {
    const machine = this.machines.get(key);
    if (!machine) throw new Error(`No status machine registered for key '${key}'`);
    return machine;
  }
}
