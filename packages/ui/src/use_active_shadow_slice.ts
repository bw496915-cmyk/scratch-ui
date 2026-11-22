import { useSyncExternalStore } from "react"

import {
  type ActiveShadowSlice,
  EMPTY_SHADOW_SLICE,
  getShadowSliceSnapshot,
  subscribeShadowSliceUrl,
} from "./desk_quick_jump.ts"

export function useActiveShadowSlice(): ActiveShadowSlice {
  return useSyncExternalStore(
    subscribeShadowSliceUrl,
    getShadowSliceSnapshot,
    () => EMPTY_SHADOW_SLICE,
  )
}
