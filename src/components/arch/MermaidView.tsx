import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";

let initialized = false;
function initMermaid() {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    securityLevel: "loose",
    fontFamily: "Inter, ui-sans-serif, system-ui",
    themeVariables: {
      background: "transparent",
      primaryColor: "#1f2a3d",
      primaryTextColor: "#e6edf3",
      primaryBorderColor: "#3b8fbf",
      lineColor: "#7dd3fc",
      actorBkg: "#22324a",
      actorBorder: "#5fb4e6",
      actorTextColor: "#e6edf3",
      signalColor: "#cbd5e1",
      signalTextColor: "#e6edf3",
      noteBkgColor: "#3b2a4d",
      noteTextColor: "#f5d0fe",
      noteBorderColor: "#a855f7",
    },
  });
  initialized = true;
}

export function MermaidView({ code, className }: { code: string; className?: string }) {
  const id = useId().replace(/:/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initMermaid();
    let cancelled = false;
    (async () => {
      try {
        const { svg } = await mermaid.render(`m-${id}`, code);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, id]);

  return (
    <div className={className}>
      {error ? (
        <pre className="text-xs text-destructive whitespace-pre-wrap p-3 mono">{error}</pre>
      ) : (
        <div ref={ref} className="w-full overflow-auto [&_svg]:max-w-full [&_svg]:h-auto" />
      )}
    </div>
  );
}
