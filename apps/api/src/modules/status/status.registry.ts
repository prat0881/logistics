import { Injectable } from "@nestjs/common";
import type { StatusMachine } from "./status.types";

// Holds one machine per key. The state vocabulary is central (shared); transition
// EDGES are contributed by the owning stage — Stage 4+ call `contribute(...)` to
// append forward/reopen edges without touching Stage 3.
@Injectable()
export class StatusRegistry {
  private readonly machines = new Map<string, StatusMachine>();

  register(machine: StatusMachine): void {
    this.machines.set(machine.key, machine);
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
