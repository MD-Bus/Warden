import { useEffect, useState } from "react"
import { useFetchers, useNavigation } from "react-router"

/** Thin bar at the top of the window while a page or a background request is loading. */
export function NavigationProgress() {
  const navigation = useNavigation()
  const fetchers = useFetchers()
  const busy = navigation.state !== "idle" || fetchers.some((f) => f.state !== "idle")
  const [visible, setVisible] = useState(false)

  // Wait first, so an ordinary page change shows no bar: it only appears when a page is taking time.
  useEffect(() => {
    if (!busy) {
      setVisible(false)
      return
    }
    const timer = setTimeout(() => setVisible(true), 300)
    return () => clearTimeout(timer)
  }, [busy])

  return (
    <div
      role="progressbar"
      aria-hidden={!visible}
      aria-busy={visible}
      className={`pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden transition-opacity duration-150 ${visible ? "opacity-100" : "opacity-0"}`}
    >
      <div className="h-full w-1/3 animate-[bf-progress_1s_ease-in-out_infinite] bg-primary" />
    </div>
  )
}
