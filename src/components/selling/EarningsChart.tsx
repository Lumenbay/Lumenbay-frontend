"use client";

import { useMemo, useState } from "react";
import { TrendingUp, BarChart2 } from "lucide-react";
import { Panel, xlm } from "@/components/orders/OrderParts";
import type { OrderSummary } from "@/lib/orders/queries";
import { getWeeklyEarnings } from "@/lib/orders/weeklyEarnings";

interface EarningsChartProps {
  orders: OrderSummary[];
  loading?: boolean;
}

export default function EarningsChart({ orders, loading }: EarningsChartProps) {
  const [activeWeekIndex, setActiveWeekIndex] = useState<number | null>(null);

  const summary = useMemo(() => getWeeklyEarnings(orders), [orders]);
  const { weeks, totalEarnings, averageWeeklyEarnings, maxWeeklyEarnings, totalOrders } = summary;

  // SVG dimensions
  const svgWidth = 560;
  const svgHeight = 160;
  const padLeft = 40;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 28;
  const plotWidth = svgWidth - padLeft - padRight;
  const plotHeight = svgHeight - padTop - padBottom;
  const slotWidth = plotWidth / 12;
  const barWidth = Math.min(22, slotWidth - 8);

  const activeWeek = activeWeekIndex !== null ? weeks[activeWeekIndex] : null;

  return (
    <Panel
      title="Earnings over time (12 weeks)"
      action={
        <div className="flex items-center gap-1.5 text-xs font-bold text-ink-muted">
          <TrendingUp className="h-4 w-4 text-accent" aria-hidden />
          <span>1% escrow fee deducted</span>
        </div>
      }
    >
      <div className="p-4 sm:p-5">
        {/* Quick summary stats */}
        <div className="mb-5 grid grid-cols-3 gap-2 sm:gap-3">
          <div className="rounded-xl border border-line bg-surface-2 p-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">12-wk total</span>
            <p className="tnum mt-0.5 text-base font-black text-ink sm:text-lg">
              {loading ? "…" : xlm(totalEarnings)}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-surface-2 p-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">Weekly avg</span>
            <p className="tnum mt-0.5 text-base font-black text-ink sm:text-lg">
              {loading ? "…" : xlm(averageWeeklyEarnings)}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-surface-2 p-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">Peak week</span>
            <p className="tnum mt-0.5 text-base font-black text-ink sm:text-lg">
              {loading ? "…" : xlm(maxWeeklyEarnings)}
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex h-44 items-center justify-center">
            <span className="lb-skeleton h-32 w-full rounded-2xl" />
          </div>
        ) : totalOrders === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface-2/50 px-4 py-10 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-3 text-ink-muted">
              <BarChart2 className="h-5 w-5" aria-hidden />
            </div>
            <p className="mt-3 text-sm font-bold text-ink">No sales released in the last 12 weeks</p>
            <p className="mt-1 max-w-sm text-xs text-ink-muted">
              When buyer orders complete and escrow payments are released to you, your weekly earnings trend will be charted here.
            </p>
          </div>
        ) : (
          <div className="relative">
            {/* Active bar tooltip / callout */}
            <div className="mb-2 flex h-6 items-center justify-between text-xs">
              {activeWeek ? (
                <div className="flex items-center gap-2">
                  <span className="font-bold text-ink">{activeWeek.label}</span>
                  <span className="tnum font-extrabold text-accent">{xlm(activeWeek.earnings)}</span>
                  <span className="text-ink-muted">({activeWeek.orderCount} {activeWeek.orderCount === 1 ? "order" : "orders"})</span>
                </div>
              ) : (
                <span className="text-ink-faint text-[11px]">Hover or tap a bar to inspect weekly details</span>
              )}
            </div>

            {/* Accessible SVG Bar Chart */}
            <div className="w-full overflow-hidden">
              <svg
                viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                className="w-full h-auto"
                role="img"
                aria-label={`Seller earnings chart across the last 12 weeks. Total earnings: ${totalEarnings.toFixed(2)} XLM across ${totalOrders} orders.`}
              >
                {/* Horizontal reference grid lines */}
                {[0, 0.5, 1].map((ratio) => {
                  const y = padTop + plotHeight * (1 - ratio);
                  const labelValue = maxWeeklyEarnings * ratio;
                  return (
                    <g key={ratio}>
                      <line
                        x1={padLeft}
                        y1={y}
                        x2={svgWidth - padRight}
                        y2={y}
                        stroke="var(--line, #E4E5EE)"
                        strokeDasharray={ratio > 0 ? "3 3" : undefined}
                        strokeWidth="1"
                        opacity={0.7}
                      />
                      <text
                        x={padLeft - 6}
                        y={y + 3}
                        textAnchor="end"
                        fontSize="9"
                        fontWeight="600"
                        fill="var(--ink-faint, #878A9C)"
                        className="tnum"
                      >
                        {labelValue >= 1000 ? `${(labelValue / 1000).toFixed(1)}k` : Math.round(labelValue)}
                      </text>
                    </g>
                  );
                })}

                {/* Bars */}
                {weeks.map((week, idx) => {
                  const x = padLeft + idx * slotWidth + (slotWidth - barWidth) / 2;
                  const barHeight = maxWeeklyEarnings > 0 ? (week.earnings / maxWeeklyEarnings) * plotHeight : 0;
                  const isHovered = activeWeekIndex === idx;

                  // Render at least a subtle 3px baseline pill for 0 earnings
                  const effectiveHeight = Math.max(barHeight, 3);
                  const effectiveY = padTop + plotHeight - effectiveHeight;

                  return (
                    <g
                      key={week.weekIndex}
                      onMouseEnter={() => setActiveWeekIndex(idx)}
                      onMouseLeave={() => setActiveWeekIndex(null)}
                      onFocus={() => setActiveWeekIndex(idx)}
                      onBlur={() => setActiveWeekIndex(null)}
                      tabIndex={0}
                      className="cursor-pointer outline-none focus-visible:opacity-80"
                      aria-label={`${week.label}: ${week.earnings.toFixed(2)} XLM from ${week.orderCount} orders`}
                    >
                      <title>{`${week.label}: ${week.earnings.toFixed(2)} XLM (${week.orderCount} orders)`}</title>
                      {/* Interactive hover hit area */}
                      <rect
                        x={padLeft + idx * slotWidth}
                        y={padTop}
                        width={slotWidth}
                        height={plotHeight}
                        fill="transparent"
                      />
                      {/* Visual Bar */}
                      <rect
                        x={x}
                        y={effectiveY}
                        width={barWidth}
                        height={effectiveHeight}
                        rx={3}
                        fill={
                          week.earnings > 0
                            ? isHovered
                              ? "var(--accent-hover, #C73A2E)"
                              : "var(--accent, #E0483B)"
                            : "var(--line, #E4E5EE)"
                        }
                        opacity={isHovered ? 1 : 0.9}
                        className="transition-all duration-150"
                      />
                      {/* X-axis week labels (every second week or key weeks to prevent clutter on small screens) */}
                      {idx % 2 === 0 && (
                        <text
                          x={x + barWidth / 2}
                          y={svgHeight - 8}
                          textAnchor="middle"
                          fontSize="9"
                          fontWeight={isHovered ? "700" : "600"}
                          fill={isHovered ? "var(--ink, #14151C)" : "var(--ink-muted, #545768)"}
                        >
                          {week.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
