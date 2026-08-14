import { Injectable } from "@nestjs/common";
import type { StatusMachine } from "./status.types";

// Holds one machine per key. The state vocabulary is central (shared); transition
// EDGES are contributed by the owning stage — Stage 4+ call `contribute(...)` to
// append forward/reopen edges without touching Stage 3.
@Injectable()
export class StatusRegistry {
  private readonly machines = new Map<string, StatusMachine>();
  // Transitions contributed for a key before that key's own register() has run. NestJS calls
  // each module's onModuleInit in descending order of the module's computed "distance" from the
  // root (packages/@nestjs/core/scanner.js's calculateModulesDistance) — a single-pass, non-
  // fixed-point DFS. A module's distance is set by whichever import PATH reaches it first at
  // that traversal point and does not get revised once that module has been expanded, even if a
  // LATER-discovered path would imply a longer one — so a shared module gaining a brand new
  // importer elsewhere in the graph (e.g. a new feature module importing RfqModule) can shift
  // relative onModuleInit order in ways that are not obvious from the import declarations alone
  // (empirically hit in S5.5: AwardModule importing RfqModule flipped RfqModule.onModuleInit
  // ahead of LegsModule.onModuleInit, even though nothing about Legs/Rfq's own modules changed).
  // register()/contribute() for the SAME key should not have to care which module's onModuleInit
  // happens to run first — both always complete during app bootstrap, well before any real
  // fire()/get() call — so contribute() no longer requires register() to have already run;
  // register() merges in whatever was stashed here once it does run.
  private readonly pending = new Map<string, StatusMachine["transitions"]>();

  register(machine: StatusMachine): void {
    // Store an isolated copy so later `contribute(...)` calls (the extension seam) append to
    // the registry's own transitions array, never the module-level source singleton (e.g.
    // `legTransitions`) — which onModuleInit re-registers on every AppModule boot.
    const stashed = this.pending.get(machine.key);
    this.pending.delete(machine.key);
    this.machines.set(machine.key, {
      ...machine,
      transitions: [...machine.transitions, ...(stashed ?? [])],
    });
  }

  contribute(key: string, transitions: StatusMachine["transitions"]): void {
    const machine = this.machines.get(key);
    if (machine) {
      machine.transitions.push(...transitions);
      return;
    }
    this.pending.set(key, [...(this.pending.get(key) ?? []), ...transitions]);
  }

  get(key: string): StatusMachine {
    const machine = this.machines.get(key);
    if (!machine) throw new Error(`No status machine registered for key '${key}'`);
    return machine;
  }
}
