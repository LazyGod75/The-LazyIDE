/** Live getters over the agents store ref — executeManagerAction must never
 *  read missions / autonomy from the render-time closure. */

export function liveManagerStoreView<T extends { missions: unknown; autonomyLevel: unknown }>(
  ref: { current: T },
): Pick<T, 'missions' | 'autonomyLevel'> {
  return {
    get missions() { return ref.current.missions; },
    get autonomyLevel() { return ref.current.autonomyLevel; },
  } as Pick<T, 'missions' | 'autonomyLevel'>;
}
