// One ECharts canvas that follows its container size and reports clicks by series and data index.
import { useEffect, useRef } from "react";
import { echarts } from "./echarts";

export function Chart({ option, onPick }: { option: Record<string, unknown>; onPick?: (seriesIndex: number, dataIndex: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof echarts.init>>(undefined);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => {
    const c = echarts.init(ref.current!, undefined, { renderer: "canvas" });
    chart.current = c;
    c.on("click", (p: { seriesIndex?: number; dataIndex?: number }) => pick.current?.(p.seriesIndex ?? 0, p.dataIndex ?? 0));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current!);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = undefined;
    };
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, true);
  }, [option]);
  return <div ref={ref} className={"chart" + (onPick ? " clickable" : "")} />;
}
