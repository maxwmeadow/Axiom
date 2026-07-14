// Infra service registry — fetched once from archd so the renderer and daemon
// can never disagree on a service definition (INFRA_LAYER_PLAN.md). Layered
// resolution (embedded + ~/.config/axiom + workspace .axiom/) happens in Go;
// the renderer only ever sees the resolved result.
import { create } from 'zustand'
import type { InfraRegistry, InfraService, InfraCategory } from '../../shared/types'

interface RegistryState {
  categories: { id: InfraCategory; edgeKinds: string[] }[]
  services: InfraService[]
  byId: Map<string, InfraService>
  loaded: boolean
  fetchRegistry: () => Promise<void>
}

export const useRegistryStore = create<RegistryState>((set, get) => ({
  categories: [],
  services: [],
  byId: new Map(),
  loaded: false,

  fetchRegistry: async () => {
    if (get().loaded) return
    try {
      const res = await fetch('http://127.0.0.1:7743/api/registry/services')
      if (!res.ok) throw new Error(await res.text())
      const reg = await res.json() as InfraRegistry
      set({
        categories: reg.categories ?? [],
        services: reg.services ?? [],
        byId: new Map((reg.services ?? []).map(s => [s.id, s])),
        loaded: true,
      })
    } catch (err) {
      console.error('[registry] fetch failed:', err)
    }
  },
}))

/** Resolve a node's service to its registry entry (undefined for generics). */
export function useInfraService(serviceId: string): InfraService | undefined {
  return useRegistryStore(s => (serviceId ? s.byId.get(serviceId) : undefined))
}

/** Edge kinds legal for a category ('' if unknown). */
export function edgeKindsFor(category: string): string[] {
  return useRegistryStore.getState().categories.find(c => c.id === category)?.edgeKinds ?? []
}
