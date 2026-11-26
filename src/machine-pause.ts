// Pause all on a machine's row (Build 7 M3, specs/machine-connections.md section 7): every role that is on switches off
// and drains, and one click puts those same roles back. Which roles it switched off is kept in one setting, by machine id,
// so the click back works from any browser and after a restart. Pure apart from the store it is given.
import type { Store } from './db.ts';
import { isRole, type Role } from './machine-roles.ts';

const PAUSED = 'machines-paused';
type Kept = Record<string, Role[]>;
type Settings = Pick<Store, 'getSetting' | 'setSetting' | 'deleteSetting'>;

/** The roles Pause all switched off on a machine and that are still to come back; null when it isn't paused. */
export function pausedRoles(store: Pick<Store, 'getSetting'>, machineId: number): Role[] | null {
  const list = store.getSetting<Kept>(PAUSED)?.[machineId];
  return Array.isArray(list) && list.length ? list.filter(isRole) : null;
}

/** Keep (or, with an empty list, forget) the roles Pause all switched off on a machine. */
export function setPaused(store: Settings, machineId: number, roles: readonly Role[]) {
  const { [machineId]: _, ...rest } = store.getSetting<Kept>(PAUSED) ?? {};
  const next: Kept = roles.length ? { ...rest, [machineId]: [...new Set(roles)] } : rest;
  if (Object.keys(next).length) store.setSetting(PAUSED, next);
  else store.deleteSetting(PAUSED);
}

/** A role switched on by hand while paused is back already: Resume brings back only the rest. */
export function unpause(store: Settings, machineId: number, role: Role) {
  const list = pausedRoles(store, machineId);
  if (list?.includes(role))
    setPaused(
      store,
      machineId,
      list.filter((r) => r !== role),
    );
}
